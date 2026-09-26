import { randomUUID } from "node:crypto";
import {
  getStorageProvider,
  assertStorageKey,
} from "../file-storage/provider.js";
import { signDownload, signedDownloadPath, verifyDownloadToken } from "../file-storage/signing.js";
import { storageConfig } from "../file-storage/config.js";
import { Errors } from "./errors.js";

// Provider-independent content storage facade (spec §4). The application layer
// talks only to this interface; the underlying physical provider (local disk,
// memory, S3-compatible, Azure Blob, GCS, enterprise NAS) is swappable without
// touching business code. Bytes are streamed, never buffered by default.

export class ContentStorageProvider {
  constructor(provider, { bucket = "" } = {}) {
    this.provider = provider;
    this.kind = provider.kind || "local";
    this.bucket = bucket || provider.bucket || "";
  }

  info() {
    return { provider: this.kind, bucket: this.bucket, ...(this.provider.info ? this.provider.info() : {}) };
  }

  async upload({ key, stream, buffer, contentType = null } = {}) {
    assertStorageKey(key, "content storage key");
    try {
      if (stream) return await this.provider.putStream(key, stream, { contentType });
      if (buffer !== undefined && buffer !== null) return await this.provider.putBuffer(key, buffer, { contentType });
    } catch (err) {
      throw Errors.storage(err.message);
    }
    throw Errors.storage("upload requires a stream or buffer");
  }

  async append({ key, buffer } = {}) {
    assertStorageKey(key, "content storage key");
    if (!this.provider.appendBuffer) throw Errors.storage("provider does not support append uploads");
    return this.provider.appendBuffer(key, buffer);
  }

  async download(key, range = {}) {
    assertStorageKey(key, "content storage key");
    return this.provider.getStream(key, range);
  }

  async read(key, options = {}) {
    assertStorageKey(key, "content storage key");
    return this.provider.readBuffer(key, options);
  }

  async getMetadata(key) {
    assertStorageKey(key, "content storage key");
    return this.provider.stat(key);
  }

  async exists(key) {
    assertStorageKey(key, "content storage key");
    return this.provider.exists(key);
  }

  async checksum(key) {
    assertStorageKey(key, "content storage key");
    return this.provider.checksum(key);
  }

  async delete(key) {
    assertStorageKey(key, "content storage key");
    try {
      return await this.provider.delete(key);
    } catch (err) {
      throw Errors.storage(err.message);
    }
  }

  // Providers with native server-side copy override this. The portable fallback
  // streams through a bounded buffer; object-store adapters should implement
  // `copy` directly to avoid moving bytes through the application process.
  async copy(fromKey, toKey) {
    if (this.provider.copy) return this.provider.copy(fromKey, toKey);
    const buffer = await this.provider.readBuffer(fromKey);
    return this.provider.putBuffer(toKey, buffer);
  }

  async move(fromKey, toKey) {
    assertStorageKey(fromKey, "content storage key");
    assertStorageKey(toKey, "content storage key");
    try {
      return await this.provider.move(fromKey, toKey);
    } catch (err) {
      throw Errors.storage(err.message);
    }
  }

  generateAccessUrl({ key, filename = "", mimeType = "application/octet-stream", disposition = "attachment", tenantId = null, versionId = null, expiresIn = null } = {}) {
    const ttl = Number(expiresIn || storageConfig().signedUrlTtlSeconds);
    const token = signDownload({ key, bucket: this.bucket, filename, mimeType, disposition, tenantId, versionId, expiresIn: ttl });
    return { url: signedDownloadPath(token), token, expiresIn: Math.max(30, ttl) };
  }
}

let cachedProvider = null;
let cachedKey = "";

export function resolveContentStorage(overrides = {}) {
  const config = storageConfig(overrides);
  const cacheKey = `${config.provider}:${config.root}:${config.bucket}`;
  if (!cachedProvider || cachedKey !== cacheKey) {
    cachedProvider = new ContentStorageProvider(getStorageProvider(overrides), { bucket: config.bucket });
    cachedKey = cacheKey;
  }
  return cachedProvider;
}

export function resetContentStorage() {
  cachedProvider = null;
  cachedKey = "";
}

export { verifyDownloadToken, signedDownloadPath, storageConfig };

// Tenant-safe storage keys (spec §23/§48). The user never sees these keys; they
// are generated server-side and never derived from a user-supplied filename.
export function buildContentStorageKey({ tenantId = 0, objectType = "object", objectId = "none", contentId = "pending", now = new Date() } = {}) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const tenant = Number(tenantId) || 0;
  const objType = assertStorageKey(String(objectType || "object").toLowerCase().replace(/[^a-z0-9_]/g, "_"), "object type");
  const objId = String(objectId || "none").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "none";
  const cid = String(contentId || randomUUID());
  return `tenant/${tenant}/object/${objType}/${objId}/content/${cid}/${yyyy}/${mm}/${randomUUID()}`;
}

export function buildContentStagingKey(uploadKey) {
  return `staging/content/${assertStorageKey(String(uploadKey), "upload id")}`;
}

export function buildRenditionStorageKey(contentStorageKey, renditionType) {
  const safeType = String(renditionType || "rendition").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `${assertStorageKey(contentStorageKey)}.rendition.${safeType}.${randomUUID()}`;
}
