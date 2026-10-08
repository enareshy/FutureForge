// Target resolution for Requirement -> PDM allocations.
//
// Targets are never copied. Each allocation points at the artifact's own id and
// this module resolves it through the owning domain facade (PDM items,
// revisions, datasets, BOM revisions), returning a normalized descriptor used by
// the allocation service, compatibility checks and the Digital Thread provider.
import { Items, Revisions, Datasets } from "../pdm/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions } from "../bom/index.js";
import { TARGET_SOURCES, PDM_NODE_TYPES } from "./constants.js";
import { invalidTarget, targetNotFound } from "./errors.js";

const RELEASED_STATUSES = Object.freeze(["RELEASED"]);

function rowFor(db, tenantId, targetType, ref, { async: isAsync = false } = {}) {
  if (!isAsync) {
    if (targetType === PDM_NODE_TYPES.ITEM) return Items.getItemRow(db, tenantId, ref);
    if (targetType === PDM_NODE_TYPES.REVISION) return Revisions.getRevisionRow(db, tenantId, ref);
    if (targetType === PDM_NODE_TYPES.DATASET) return Datasets.getDatasetRow(db, tenantId, ref);
    if (targetType === PDM_NODE_TYPES.BOM_REVISION) return BomRevisions.getRevisionRow(db, tenantId, ref);
    return null;
  }
  if (targetType === PDM_NODE_TYPES.ITEM) return Items.getItemRowAsync(db, tenantId, ref);
  if (targetType === PDM_NODE_TYPES.REVISION) return Revisions.getRevisionRowAsync(db, tenantId, ref);
  if (targetType === PDM_NODE_TYPES.DATASET) return Datasets.getDatasetRowAsync(db, tenantId, ref);
  if (targetType === PDM_NODE_TYPES.BOM_REVISION) return BomRevisions.getRevisionRowAsync(db, tenantId, ref);
  return null;
}

function headerForBom(db, tenantId, row, { async: isAsync = false } = {}) {
  if (!row?.bom_id) return null;
  return isAsync ? BomDefinitions.getBomRowAsync(db, tenantId, row.bom_id) : BomDefinitions.getBomRow(db, tenantId, row.bom_id);
}

export function describeTarget(targetType, row, header = null) {
  if (!row) return null;
  const source = TARGET_SOURCES[targetType];
  return {
    target_type: targetType,
    target_id: String(row.id),
    label: source?.label || targetType,
    ref: row.item_ref || row.revision_ref || row.dataset_ref || "",
    number: row.item_number || row.revision_number || row.dataset_number || "",
    name: row.name || row.description || "",
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
    configuration_context: row.configuration_context ?? "",
  };
}

export function resolveTarget(db, tenantId, targetType, ref) {
  const row = rowFor(db, tenantId, targetType, ref);
  if (!row) return null;
  const header = targetType === PDM_NODE_TYPES.BOM_REVISION ? headerForBom(db, tenantId, row) : null;
  return describeTarget(targetType, row, header);
}

export async function resolveTargetAsync(db, tenantId, targetType, ref) {
  const row = await rowFor(db, tenantId, targetType, ref, { async: true });
  if (!row) return null;
  const header = targetType === PDM_NODE_TYPES.BOM_REVISION ? await headerForBom(db, tenantId, row, { async: true }) : null;
  return describeTarget(targetType, row, header);
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
  return RELEASED_STATUSES.includes(String(target.status || "").toUpperCase()) || RELEASED_STATUSES.includes(String(target.lifecycle_state || "").toUpperCase());
}

export function assertKnownTargetType(targetType) {
  if (!TARGET_SOURCES[targetType]) throw invalidTarget(`Unsupported PDM target type: ${targetType}`, { target_type: targetType });
  return targetType;
}
