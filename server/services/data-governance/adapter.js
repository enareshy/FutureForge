// Data source adapters. The evaluation engine never reads another module's
// tables directly: an adapter resolves a governed object into a normalised
// payload and answers uniqueness/reference questions. Business modules register
// their own adapter; `platform.objects` is the built-in adapter over the Object
// & Relationship Framework.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { adapterNotFound } from "./errors.js";
import { getObject, getObjectAsync, listObjects, listObjectsAsync } from "../objects.js";
import { readAttribute } from "./validation.js";

const adapters = new Map();

export function registerAdapter(code, adapter) {
  const key = String(code || "").trim() || "platform.objects";
  if (typeof adapter?.load !== "function") throw new Error(`Adapter ${key} must implement load()`);
  adapters.set(key, { code: key, ...adapter });
  return adapters.get(key);
}

export function getAdapter(code) {
  return adapters.get(String(code || "platform.objects")) || null;
}

export function requireAdapter(code) {
  const adapter = getAdapter(code);
  if (!adapter) throw adapterNotFound(code);
  return adapter;
}

export function listAdapters() {
  return [...adapters.keys()];
}

function normalizeLoaded(objectType, objectId, source, extra = {}) {
  const attributes = source?.attributes || source?.data || {};
  return {
    object_type: String(objectType).toLowerCase(),
    object_id: String(objectId),
    object_name: source?.name || source?.code || "",
    code: source?.code || "",
    status: source?.status || "",
    organization_id: source?.organization_id ?? null,
    plant_id: source?.plant_id ?? null,
    domain_id: extra.domain_id ?? source?.domain_id ?? null,
    attributes,
    ...(extra.fields || {}),
  };
}

const objectsAdapter = {
  code: "platform.objects",
  load(db, { tenantId, objectType, objectId }) {
    let row;
    try {
      row = getObject(db, objectId, Number(tenantId));
    } catch {
      row = null;
    }
    if (!row) return null;
    const type = row.type?.code || objectType;
    if (objectType && String(type).toLowerCase() !== String(objectType).toLowerCase()) return null;
    return normalizeLoaded(type, row.id, row, { fields: { revision: row.revision } });
  },
  async loadAsync(db, { tenantId, objectType, objectId }) {
    let row;
    try {
      row = await getObjectAsync(db, objectId, Number(tenantId));
    } catch {
      row = null;
    }
    if (!row) return null;
    const type = row.type?.code || objectType;
    if (objectType && String(type).toLowerCase() !== String(objectType).toLowerCase()) return null;
    return normalizeLoaded(type, row.id, row, { fields: { revision: row.revision } });
  },
  list(db, { tenantId, objectType, limit = 500, offset = 0 }) {
    const result = listObjects(db, { type: objectType, page: Math.floor(offset / Math.max(1, limit)) + 1, pageSize: limit }, Number(tenantId));
    return (result.items || []).map((row) => normalizeLoaded(objectType, row.id, row));
  },
  async listAsync(db, { tenantId, objectType, limit = 500, offset = 0 }) {
    const result = await listObjectsAsync(db, { type: objectType, page: Math.floor(offset / Math.max(1, limit)) + 1, pageSize: limit }, Number(tenantId));
    return (result.items || []).map((row) => normalizeLoaded(objectType, row.id, row));
  },
  // Uniqueness over a governed attribute. Extracts the attribute from the
  // object data payload using the built-in JSONB operators.
  findDuplicates(db, { tenantId, objectType, attributeName, value, excludeObjectId, limit = 25 }) {
    if (!attributeName) return [];
    return queryAll(
      db,
      `SELECT o.id, o.name, o.code FROM objects o
       JOIN metadata_types t ON t.id = o.object_type_id
       WHERE o.tenant_id = ? AND t.code = ? AND o.deleted_at IS NULL
         AND o.id <> ?
         AND (o.data_json::jsonb ->> ?) = (?::text)
       LIMIT ?`,
      [Number(tenantId), String(objectType), Number(excludeObjectId) || -1, String(attributeName), String(value), Number(limit)]
    );
  },
  async findDuplicatesAsync(db, { tenantId, objectType, attributeName, value, excludeObjectId, limit = 25 }) {
    if (!attributeName) return [];
    return await queryAllAsync(
      db,
      `SELECT o.id, o.name, o.code FROM objects o
       JOIN metadata_types t ON t.id = o.object_type_id
       WHERE o.tenant_id = ? AND t.code = ? AND o.deleted_at IS NULL
         AND o.id <> ?
         AND (o.data_json::jsonb ->> ?) = (?::text)
       LIMIT ?`,
      [Number(tenantId), String(objectType), Number(excludeObjectId) || -1, String(attributeName), String(value), Number(limit)]
    );
  },
  count(db, { tenantId, objectType }) {
    const row = queryOne(
      db,
      `SELECT COUNT(*) AS c FROM objects o JOIN metadata_types t ON t.id = o.object_type_id
       WHERE o.tenant_id = ? AND t.code = ? AND o.deleted_at IS NULL`,
      [Number(tenantId), String(objectType)]
    );
    return Number(row?.c ?? 0);
  },
};

registerAdapter("platform.objects", objectsAdapter);

// Registers the default adapters. Idempotent; safe on every boot.
export function ensureDefaultAdapters() {
  if (!getAdapter("platform.objects")) registerAdapter("platform.objects", objectsAdapter);
  return { adapters: listAdapters().length };
}

// Convenience used by the engine to load an object via its catalogue adapter.
export function loadGovernedObject(db, { tenantId, objectType, objectId, adapterCode = "platform.objects" }) {
  const adapter = requireAdapter(adapterCode);
  return adapter.load(db, { tenantId, objectType, objectId });
}

export async function loadGovernedObjectAsync(db, { tenantId, objectType, objectId, adapterCode = "platform.objects" }) {
  const adapter = requireAdapter(adapterCode);
  return adapter.loadAsync
    ? await adapter.loadAsync(db, { tenantId, objectType, objectId })
    : adapter.load(db, { tenantId, objectType, objectId });
}

export function readByPath(payload, path) {
  return readAttribute(payload, path);
}

export { objectsAdapter };
