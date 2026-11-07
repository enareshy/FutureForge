// Target resolution for Requirement -> Manufacturing allocations.
//
// Targets are never copied. Each allocation points at the artifact's own id and
// this module resolves it through the owning domain facade (PDM items/revisions,
// BOM revisions, Object operations/work centers, Classification characteristics,
// Content documents), returning a normalized descriptor used by the allocation
// service and the Digital Thread provider (mirrors requirement-pdm/targets.js).
import { Items, Revisions } from "../pdm/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions } from "../bom/index.js";
import { getObject, getObjectAsync } from "../objects.js";
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { TARGET_SOURCES, MANUFACTURING_NODE_TYPES, OPERATION_OBJECT_TYPE, WORK_CENTER_OBJECT_TYPE } from "./constants.js";
import { invalidTarget, targetNotFound } from "./errors.js";

const RELEASED_STATUSES = Object.freeze(["RELEASED", "ACTIVE"]);

function characteristicRow(db, tenantId, ref, { async: isAsync = false } = {}) {
  const sql =
    "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))";
  const params = [Number(tenantId), Number(ref) || -1, String(ref), String(ref)];
  return isAsync ? queryOneAsync(db, sql, params) : queryOne(db, sql, params);
}

function contentRow(db, tenantId, ref, { async: isAsync = false } = {}) {
  const sql = "SELECT * FROM content WHERE tenant_id = ? AND (id = ? OR content_id = ? OR content_key = ?)";
  const params = [Number(tenantId), Number(ref) || -1, String(ref), String(ref)];
  return isAsync ? queryOneAsync(db, sql, params) : queryOne(db, sql, params);
}

function manufacturingObjectRow(db, tenantId, targetType, ref, { async: isAsync = false } = {}) {
  try {
    const object = getObject(db, ref, tenantId);
    return object && String(object.type?.code || "").toLowerCase() === targetType ? object : null;
  } catch {
    return null;
  }
}

async function manufacturingObjectRowAsync(db, tenantId, targetType, ref) {
  try {
    const object = await getObjectAsync(db, ref, tenantId);
    return object && String(object.type?.code || "").toLowerCase() === targetType ? object : null;
  } catch {
    return null;
  }
}

function bomHeader(db, tenantId, row, { async: isAsync = false } = {}) {
  if (!row?.bom_id) return null;
  return isAsync ? BomDefinitions.getBomRowAsync(db, tenantId, row.bom_id) : BomDefinitions.getBomRow(db, tenantId, row.bom_id);
}

export function describeTarget(targetType, row, header = null) {
  if (!row) return null;
  const source = TARGET_SOURCES[targetType];
  const isObject = targetType === OPERATION_OBJECT_TYPE || targetType === WORK_CENTER_OBJECT_TYPE;
  if (isObject) {
    return {
      target_type: targetType,
      target_id: String(row.id),
      label: source?.label || targetType,
      ref: row.code || "",
      number: row.code || "",
      name: row.name || "",
      status: row.status || "",
      lifecycle_state: row.status || "",
      effectivity_from: null,
      effectivity_to: null,
      object_id: row.id,
      item_id: null,
      item_type: null,
      revision_number: null,
      bom_id: null,
      bom_type: null,
      configuration_context: "",
    };
  }
  return {
    target_type: targetType,
    target_id: String(row.id),
    label: source?.label || targetType,
    ref: row.item_ref || row.revision_ref || row.characteristic_ref || row.content_id || "",
    number: row.item_number || row.revision_number || row.code || row.content_key || "",
    name: row.name || row.description || row.file_name || "",
    status: row.status || "",
    lifecycle_state: row.lifecycle_state || row.status || "",
    effectivity_from: row.valid_from ?? null,
    effectivity_to: row.valid_to ?? null,
    object_id: row.object_id ?? null,
    item_id: row.item_id ?? null,
    item_type: row.item_type ?? null,
    revision_number: row.revision_number ?? null,
    bom_id: row.bom_id ?? null,
    bom_type: header?.bom_type ?? null,
    characteristic_ref: row.characteristic_ref ?? null,
    content_id: row.content_id ?? null,
    data_type: row.data_type ?? null,
    unit: row.unit ?? null,
    configuration_context: row.configuration_context ?? "",
  };
}

export function resolveTarget(db, tenantId, targetType, ref) {
  const type = String(targetType || "").toLowerCase();
  if (type === MANUFACTURING_NODE_TYPES.PRODUCT) {
    const row = Items.getItemRow(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.PRODUCT_REVISION) {
    const row = Revisions.getRevisionRow(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.EBOM || type === MANUFACTURING_NODE_TYPES.MBOM || type === MANUFACTURING_NODE_TYPES.BOP) {
    const row = BomRevisions.getRevisionRow(db, tenantId, ref);
    if (!row) return null;
    return describeTarget(type, row, bomHeader(db, tenantId, row));
  }
  if (type === OPERATION_OBJECT_TYPE || type === WORK_CENTER_OBJECT_TYPE) {
    const row = manufacturingObjectRow(db, tenantId, type, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.CHARACTERISTIC) {
    const row = characteristicRow(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.DOCUMENT) {
    const row = contentRow(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  return null;
}

export async function resolveTargetAsync(db, tenantId, targetType, ref) {
  const type = String(targetType || "").toLowerCase();
  if (type === MANUFACTURING_NODE_TYPES.PRODUCT) {
    const row = await Items.getItemRowAsync(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.PRODUCT_REVISION) {
    const row = await Revisions.getRevisionRowAsync(db, tenantId, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.EBOM || type === MANUFACTURING_NODE_TYPES.MBOM || type === MANUFACTURING_NODE_TYPES.BOP) {
    const row = await BomRevisions.getRevisionRowAsync(db, tenantId, ref);
    if (!row) return null;
    return describeTarget(type, row, await bomHeader(db, tenantId, row, { async: true }));
  }
  if (type === OPERATION_OBJECT_TYPE || type === WORK_CENTER_OBJECT_TYPE) {
    const row = await manufacturingObjectRowAsync(db, tenantId, type, ref);
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.CHARACTERISTIC) {
    const row = await characteristicRow(db, tenantId, ref, { async: true });
    return row ? describeTarget(type, row) : null;
  }
  if (type === MANUFACTURING_NODE_TYPES.DOCUMENT) {
    const row = await contentRow(db, tenantId, ref, { async: true });
    return row ? describeTarget(type, row) : null;
  }
  return null;
}

export function requireTarget(db, tenantId, targetType, ref) {
  const target = resolveTarget(db, tenantId, targetType, ref);
  if (!target) throw targetNotFound(targetType, ref);
  return target;
}

export async function requireTargetAsync(db, tenantId, targetType, ref) {
  const target = await resolveTargetAsync(db, tenantId, targetType, ref);
  if (!target) throw targetNotFound(targetType, ref);
  return target;
}

export function isReleased(target) {
  if (!target) return false;
  return (
    RELEASED_STATUSES.includes(String(target.status || "").toUpperCase()) ||
    RELEASED_STATUSES.includes(String(target.lifecycle_state || "").toUpperCase())
  );
}

export function assertKnownTargetType(targetType) {
  if (!TARGET_SOURCES[String(targetType || "").toLowerCase()]) {
    throw invalidTarget(`Unsupported manufacturing target type: ${targetType}`, { target_type: targetType });
  }
  return String(targetType).toLowerCase();
}
