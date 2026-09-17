import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import { HttpError } from "../../validation.js";
import { storageConfig } from "./config.js";

// Storage provider abstraction. Providers return opaque keys; absolute paths
// never leave this module. The local provider is the default; object-store
// providers can implement the same surface (putStream/getStream/stat/delete/
// move) without touching the Document module.

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

export function assertStorageKey(key, label = "storage key") {
  const value = String(key || "");
  if (!KEY_RE.test(value) || value.includes("..") || value.startsWith("/")) {
    throw new HttpError(500, `Invalid ${label}`);
  }
  return value;
}

export function buildObjectKey({ tenantId = 0, now = new Date() } = {}) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `objects/${Number(tenantId) || 0}/${yyyy}/${mm}/${randomUUID()}`;
}

export function buildStagingKey(uploadId) {
  return `staging/${assertStorageKey(String(uploadId), "upload id")}`;
}

export function buildPreviewKey(objectKey, rendition = "preview") {
  return `${assertStorageKey(objectKey)}.${assertStorageKey(rendition, "rendition")}`;
}

async function hashStream(readable) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { checksum: hash.digest("hex"), size };
}

export class LocalStorageProvider {
  constructor({ root, bucket = "helix-files" } = {}) {
    if (!root) throw new Error("LocalStorageProvider requires a root directory");
    this.kind = "local";
    this.bucket = bucket;
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  resolvePath(key) {
    const safe = assertStorageKey(key);
    const full = resolve(this.root, normalize(safe));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new HttpError(500, "Invalid storage key");
    }
    return full;
  }

  async putStream(key, readable) {
    const full = this.resolvePath(key);
    mkdirSync(dirname(full), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const sink = createWriteStream(full);
    const counted = (async function* () {
      for await (const chunk of readable) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    })();
    await pipeline(counted, sink);
    return { key, size, checksum: hash.digest("hex"), provider: this.kind, bucket: this.bucket };
  }

  async putBuffer(key, buffer) {
    const full = this.resolvePath(key);
    mkdirSync(dirname(full), { recursive: true });
    await pipeline(
      (async function* () {
        yield buffer;
      })(),
      createWriteStream(full)
    );
    return {
      key,
      size: buffer.length,
      checksum: createHash("sha256").update(buffer).digest("hex"),
      provider: this.kind,
      bucket: this.bucket,
    };
  }

  async appendBuffer(key, buffer) {
    const full = this.resolvePath(key);
    mkdirSync(dirname(full), { recursive: true });
    const existing = existsSync(full) ? statSync(full).size : 0;
    const hash = createHash("sha256");
    if (existing) {
      const prior = createReadStream(full);
      for await (const chunk of prior) hash.update(chunk);
    }
    hash.update(buffer);
    await pipeline(
      (async function* () {
        yield buffer;
      })(),
      createWriteStream(full, { flags: "a" })
    );
    return { key, size: existing + buffer.length, checksum: hash.digest("hex") };
  }

  getStream(key, range = {}) {
    const full = this.resolvePath(key);
    if (!existsSync(full)) throw new HttpError(404, "Stored object not found");
    const options = {};
    if (range.start !== undefined) options.start = range.start;
    if (range.end !== undefined) options.end = range.end;
    return createReadStream(full, options);
  }

  async readBuffer(key, { maxBytes = 0 } = {}) {
    const full = this.resolvePath(key);
    if (!existsSync(full)) throw new HttpError(404, "Stored object not found");
    const size = statSync(full).size;
    if (maxBytes && size > maxBytes) {
      const stream = createReadStream(full, { start: 0, end: maxBytes - 1 });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    const chunks = [];
    for await (const chunk of createReadStream(full)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async stat(key) {
    const full = this.resolvePath(key);
    if (!existsSync(full)) return null;
    const info = statSync(full);
    return { key, size: info.size, modifiedAt: info.mtime.toISOString(), provider: this.kind, bucket: this.bucket };
  }

  async exists(key) {
    return existsSync(this.resolvePath(key));
  }

  async move(fromKey, toKey) {
    const from = this.resolvePath(fromKey);
    const to = this.resolvePath(toKey);
    if (!existsSync(from)) throw new HttpError(404, "Staged object not found");
    mkdirSync(dirname(to), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
    return this.stat(toKey);
  }

  async delete(key) {
    const full = this.resolvePath(key);
    if (existsSync(full)) rmSync(full, { force: true });
    return { key, deleted: true };
  }

  async deletePrefix(prefix) {
    const safe = assertStorageKey(prefix);
    const target = this.resolvePath(`${safe.replace(/\/+$/, "")}/x`);
    const dir = dirname(target);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return { prefix: safe, deleted: true };
  }

  async checksum(key) {
    const stream = this.getStream(key);
    return hashStream(stream);
  }

  info() {
    return { provider: this.kind, bucket: this.bucket, root: this.root };
  }
}

export class MemoryStorageProvider {
  constructor({ bucket = "helix-files" } = {}) {
    this.kind = "memory";
    this.bucket = bucket;
    this.objects = new Map();
  }

  async putStream(key, readable) {
    assertStorageKey(key);
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of readable) {
      size += chunk.length;
      hash.update(chunk);
      chunks.push(chunk);
    }
    const checksum = hash.digest("hex");
    this.objects.set(key, { buffer: Buffer.concat(chunks), checksum });
    return { key, size, checksum, provider: this.kind, bucket: this.bucket };
  }

  async putBuffer(key, buffer) {
    assertStorageKey(key);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    this.objects.set(key, { buffer, checksum });
    return { key, size: buffer.length, checksum, provider: this.kind, bucket: this.bucket };
  }

  async appendBuffer(key, buffer) {
    assertStorageKey(key);
    const existing = this.objects.get(key);
    const next = existing ? Buffer.concat([existing.buffer, buffer]) : buffer;
    return this.putBuffer(key, next);
  }

  getStream(key, range = {}) {
    const entry = this.objects.get(key);
    if (!entry) throw new HttpError(404, "Stored object not found");
    const buffer = range.start !== undefined
      ? entry.buffer.subarray(range.start, range.end !== undefined ? range.end + 1 : undefined)
      : entry.buffer;
    return Readable.from([buffer]);
  }

  async readBuffer(key) {
    const entry = this.objects.get(key);
    if (!entry) throw new HttpError(404, "Stored object not found");
    return entry.buffer;
  }

  async stat(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { key, size: entry.buffer.length, checksum: entry.checksum, provider: this.kind, bucket: this.bucket };
  }

  async exists(key) {
    return this.objects.has(key);
  }

  async move(fromKey, toKey) {
    const entry = this.objects.get(fromKey);
    if (!entry) throw new HttpError(404, "Staged object not found");
    this.objects.set(toKey, entry);
    this.objects.delete(fromKey);
    return this.stat(toKey);
  }

  async delete(key) {
    this.objects.delete(key);
    return { key, deleted: true };
  }

  async deletePrefix(prefix) {
    for (const key of [...this.objects.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.objects.delete(key);
    }
    return { prefix, deleted: true };
  }

  async checksum(key) {
    const entry = this.objects.get(key);
    if (!entry) throw new HttpError(404, "Stored object not found");
    return { checksum: entry.checksum, size: entry.buffer.length };
  }

  info() {
    return { provider: this.kind, bucket: this.bucket };
  }
}

const providerCache = new Map();

export function createStorageProvider(options = {}) {
  const config = storageConfig(options);
  if (config.provider === "memory") return new MemoryStorageProvider({ bucket: config.bucket });
  return new LocalStorageProvider({ root: config.root, bucket: config.bucket });
}

export function getStorageProvider(options = {}) {
  const config = storageConfig(options);
  const cacheKey = `${config.provider}:${config.root}:${config.bucket}`;
  if (!providerCache.has(cacheKey)) {
    providerCache.set(cacheKey, createStorageProvider(options));
  }
  return providerCache.get(cacheKey);
}

export function resetStorageProviders() {
  providerCache.clear();
}
