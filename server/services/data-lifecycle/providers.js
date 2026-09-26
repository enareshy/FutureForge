// Archive storage provider abstraction.
//
// The lifecycle service packages an object's metadata into an archive manifest
// and asks a provider to store it. The default `database` provider keeps the
// payload in `lc_archive_blobs` and is intended for development and small
// deployments. The `file-storage` provider delegates physical storage to the
// shared File Storage & Processing service, so business modules never talk to a
// bucket, path or credential. Additional providers (object storage, cloud
// archive, on-premise, network, external) can register the same interface.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { buildObjectKey, getStorageProvider, putObject, deleteObject, checksumObject } from "../file-storage.js";
import { providerNotFound } from "./errors.js";
import { normalizeText } from "./validation.js";
import { slug } from "./refs.js";

const providers = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function registerArchiveProvider(code, provider) {
  providers.set(normalizeText(code).toLowerCase(), provider);
  return provider;
}

export function listArchiveProviders() {
  return [...providers.values()].map((provider) => ({ code: provider.code, type: provider.type, description: provider.description || "" }));
}

export function getArchiveProvider(code) {
  const key = normalizeText(code || "database").toLowerCase();
  const provider = providers.get(key);
  if (!provider) throw providerNotFound(key);
  return provider;
}

// ── Built-in database provider ───────────────────────────────────────────────

const databaseProvider = {
  code: "database",
  type: "DATABASE",
  description: "Database-backed archive payload store for development and small deployments.",
  async store(db, { tenantId, key, payload }) {
    const content = typeof payload === "string" ? payload : JSON.stringify(payload);
    const checksum = sha256(content);
    const storageUri = `lc-archive://${Number(tenantId)}/${key}`;
    run(db, "INSERT OR REPLACE INTO lc_archive_blobs (tenant_id, storage_uri, checksum, size_bytes, content, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      storageUri,
      checksum,
      Buffer.byteLength(content),
      content,
      nowIso(),
    ]);
    return { storage_uri: storageUri, checksum, size_bytes: Buffer.byteLength(content), provider: "database" };
  },
  async retrieve(db, { storageUri }) {
    const row = queryOne(db, "SELECT content FROM lc_archive_blobs WHERE storage_uri = ?", [String(storageUri)]);
    return row ? row.content : null;
  },
  async remove(db, { storageUri }) {
    run(db, "DELETE FROM lc_archive_blobs WHERE storage_uri = ?", [String(storageUri)]);
    return { deleted: true };
  },
  async exists(db, { storageUri }) {
    return Boolean(queryOne(db, "SELECT 1 AS x FROM lc_archive_blobs WHERE storage_uri = ?", [String(storageUri)]));
  },
};

// ── File Storage provider ────────────────────────────────────────────────────

const fileStorageProvider = {
  code: "file-storage",
  type: "OBJECT_STORAGE",
  description: "Delegates physical archive storage to the File Storage & Processing service.",
  async store(db, { tenantId, key, payload }) {
    const content = typeof payload === "string" ? payload : JSON.stringify(payload);
    const provider = getStorageProvider();
    const storageKey = `lifecycle/${buildObjectKey({ tenantId })}/${slug(key) || "manifest"}`;
    const result = await putObject(provider, storageKey, Readable.from([Buffer.from(content)]));
    return { storage_uri: `file-storage://${result.key}`, checksum: result.checksum, size_bytes: result.size, provider: provider.kind };
  },
  async retrieve(db, { storageUri }) {
    const key = String(storageUri).replace(/^file-storage:\/\//, "");
    const provider = getStorageProvider();
    const buffer = await provider.readBuffer(key);
    return buffer.toString("utf8");
  },
  async remove(db, { storageUri }) {
    const key = String(storageUri).replace(/^file-storage:\/\//, "");
    const provider = getStorageProvider();
    await deleteObject(provider, key);
    return { deleted: true };
  },
  async exists(db, { storageUri }) {
    try {
      const key = String(storageUri).replace(/^file-storage:\/\//, "");
      const provider = getStorageProvider();
      return await provider.exists(key);
    } catch {
      return false;
    }
  },
};

registerArchiveProvider("database", databaseProvider);
registerArchiveProvider("file-storage", fileStorageProvider);

// Which provider a tenant should use. Stored as tenant configuration so an
// administrator can switch without a deployment; defaults to the database.
export function resolveProviderCode(db, tenantId) {
  const row = queryOne(db, "SELECT value_json FROM lc_configuration WHERE tenant_id = ? AND key = 'archive_provider'", [Number(tenantId)]);
  if (!row) return "database";
  try {
    const value = JSON.parse(row.value_json);
    return normalizeText(value) || "database";
  } catch {
    return "database";
  }
}

export function providerInfo() {
  return listArchiveProviders();
}

export { databaseProvider, fileStorageProvider };
