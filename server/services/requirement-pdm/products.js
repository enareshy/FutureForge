// Requirement -> Product / Lifecycle projection.
//
// A product is never copied: a product is a PDM item whose `item_type` is
// PRODUCT, and a product revision is a PDM item revision. This module is a
// read-only projection that answers two questions using the target artifacts'
// own data plus the existing Lifecycle Management framework:
//
//   * Which products does a requirement realize, and at what realization stage?
//   * Which requirements does a product realize (reverse trace)?
//
// The realization stage is derived from the lifecycle's controlled `category`
// vocabulary (never from hard-coded state codes); when a product is not onboarded
// to a generic lifecycle assignment we fall back to translating its PDM status
// into the same categories. No lifecycle state machine is re-implemented here.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { Requirements } from "../requirements/index.js";
import { objectLifecycle, objectLifecycleAsync } from "../lifecycle.js";
import { listRequirementAllocations, listRequirementAllocationsAsync } from "./allocations.js";
import { resolveTarget, resolveTargetAsync } from "./targets.js";
import {
  ALLOCATION_CODES,
  PRODUCT_ITEM_TYPE,
  REALIZATION_STAGES,
  LIFECYCLE_CATEGORY_TO_STAGE,
  PDM_STATUS_CATEGORY,
} from "./constants.js";
import { invalidTarget } from "./errors.js";

const STAGE_RANK = Object.freeze(Object.fromEntries(REALIZATION_STAGES.map((stage, index) => [stage, index])));

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function upper(value) {
  return String(value || "").toUpperCase();
}

// Translate a product's status into a Lifecycle Management category. The generic
// lifecycle's own category wins when present; otherwise the PDM status is mapped
// through PDM_STATUS_CATEGORY.
export function categoryFor(status, frameworkCategory) {
  if (frameworkCategory) return String(frameworkCategory).toLowerCase();
  return PDM_STATUS_CATEGORY[upper(status)] || "draft";
}

export function stageFromCategory(category) {
  return LIFECYCLE_CATEGORY_TO_STAGE[String(category || "").toLowerCase()] || "IN_DEVELOPMENT";
}

// Compose the final stage from the lifecycle category plus the integration's own
// signals (implementation edges and revision supersession). Promotion is
// monotonic so a product can never be reported as earlier than its lifecycle.
export function deriveRealizationStage({ category, implementation = false, superseded = false } = {}) {
  let stage = stageFromCategory(category);
  if (implementation && STAGE_RANK[stage] < STAGE_RANK.IMPLEMENTED) stage = "IMPLEMENTED";
  if (superseded && stage !== "OBSOLETE") stage = "SUPERSEDED";
  return stage;
}

function snapshotRow(row) {
  if (!row) return null;
  return {
    managed: Boolean(row.state_code),
    definition_code: row.definition_code || "",
    version: row.version ?? null,
    state_code: row.state_code || "",
    state_name: row.state_name || "",
    category: row.state_category || "",
    status_code: row.status_code || "",
    is_terminal: row.is_terminal === 1 || row.is_terminal === true,
  };
}

// Batch-resolve the generic lifecycle state for many mirrored objects at once so
// a requirement with several products never triggers an N+1 lookup.
export function productLifecycleSnapshot(db, tenantId, objectIds = []) {
  const ids = [...new Set(objectIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = queryAll(
    db,
    `SELECT o.id AS object_id, s.code AS state_code, s.name AS state_name, s.category AS state_category,
            s.is_terminal AS is_terminal, st.code AS status_code, d.code AS definition_code, v.version AS version
       FROM objects o
       LEFT JOIN lifecycle_states s ON s.id = o.lifecycle_state_id
       LEFT JOIN lifecycle_statuses st ON st.id = s.status_id
       LEFT JOIN lifecycle_versions v ON v.id = o.lifecycle_version_id
       LEFT JOIN lifecycle_definitions d ON d.id = v.definition_id
      WHERE o.tenant_id = ? AND o.id IN (${placeholders(ids)})`,
    [Number(tenantId), ...ids]
  );
  return new Map(rows.map((row) => [Number(row.object_id), snapshotRow(row)]));
}

export async function productLifecycleSnapshotAsync(db, tenantId, objectIds = []) {
  const ids = [...new Set(objectIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await queryAllAsync(
    db,
    `SELECT o.id AS object_id, s.code AS state_code, s.name AS state_name, s.category AS state_category,
            s.is_terminal AS is_terminal, st.code AS status_code, d.code AS definition_code, v.version AS version
       FROM objects o
       LEFT JOIN lifecycle_states s ON s.id = o.lifecycle_state_id
       LEFT JOIN lifecycle_statuses st ON st.id = s.status_id
       LEFT JOIN lifecycle_versions v ON v.id = o.lifecycle_version_id
       LEFT JOIN lifecycle_definitions d ON d.id = v.definition_id
      WHERE o.tenant_id = ? AND o.id IN (${placeholders(ids)})`,
    [Number(tenantId), ...ids]
  );
  return new Map(rows.map((row) => [Number(row.object_id), snapshotRow(row)]));
}

function itemTypeMap(db, tenantId, itemIds, isAsync = false) {
  const ids = [...new Set(itemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return isAsync ? Promise.resolve(new Map()) : new Map();
  const sql = `SELECT id, item_type FROM pdm_items WHERE tenant_id = ? AND id IN (${placeholders(ids)})`;
  const params = [Number(tenantId), ...ids];
  if (isAsync) return queryAllAsync(db, sql, params).then((rows) => new Map(rows.map((row) => [Number(row.id), row.item_type])));
  return new Map(queryAll(db, sql, params).map((row) => [Number(row.id), row.item_type]));
}

// Latest revision id per item, used for supersession detection.
function latestRevisionIds(db, tenantId, itemIds, isAsync = false) {
  const ids = [...new Set(itemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return isAsync ? Promise.resolve(new Set()) : new Set();
  const sql = `SELECT r.id AS revision_id
                 FROM pdm_item_revisions r
                 JOIN (SELECT item_id, MAX(revision_sequence) AS seq
                         FROM pdm_item_revisions WHERE tenant_id = ? AND item_id IN (${placeholders(ids)})
                        GROUP BY item_id) m
                   ON m.item_id = r.item_id AND m.seq = r.revision_sequence
                WHERE r.tenant_id = ?`;
  const params = [Number(tenantId), ...ids, Number(tenantId)];
  if (isAsync) return queryAllAsync(db, sql, params).then((rows) => new Set(rows.map((row) => Number(row.revision_id))));
  return new Set(queryAll(db, sql, params).map((row) => Number(row.revision_id)));
}

function productDescriptor(target, snapshot, { stage } = {}) {
  const lifecycle = snapshot || { managed: false, definition_code: "", version: null, state_code: "", state_name: "", category: "", status_code: "", is_terminal: false };
  const category = categoryFor(target.status, lifecycle.category);
  return {
    target_type: target.target_type,
    target_id: target.target_id,
    object_id: target.object_id ?? null,
    ref: target.ref,
    number: target.number,
    name: target.name,
    item_id: target.item_id ?? null,
    item_type: target.item_type ?? null,
    revision_number: target.revision_number ?? null,
    status: target.status,
    lifecycle_state: target.lifecycle_state,
    lifecycle: { ...lifecycle, category: category || lifecycle.category },
    realization_stage: stage || deriveRealizationStage({ category }),
    is_released: category === "released",
  };
}

function buildItemTargets(db, tenant, allocations, itemIds, isAsync = false) {
  const map = new Map();
  for (const item of allocations) {
    if (item.target_type === "pdm_item" && item.target?.item_type === PRODUCT_ITEM_TYPE) {
      map.set(String(item.target.target_id), item.target);
    }
  }
  const missing = [...new Set(itemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && !map.has(String(id))))];
  if (!missing.length) return isAsync ? Promise.resolve(map) : map;
  if (!isAsync) {
    for (const id of missing) {
      const target = resolveTarget(db, tenant, "pdm_item", id);
      if (target?.item_type === PRODUCT_ITEM_TYPE) map.set(String(id), target);
    }
    return map;
  }
  return (async () => {
    for (const id of missing) {
      const target = await resolveTargetAsync(db, tenant, "pdm_item", id);
      if (target?.item_type === PRODUCT_ITEM_TYPE) map.set(String(id), target);
    }
    return map;
  })();
}

function projectProducts(requirement, allocations, snapshots, { itemTypes, itemTargets, latestRevisionIds: latest }) {
  const active = allocations.filter((item) => item.status === "ACTIVE" && item.target);
  const products = new Map();
  const revisionsByProduct = new Map();

  const ensureProduct = (itemId) => {
    const key = String(itemId);
    if (!products.has(key)) {
      const target = itemTargets.get(key) || null;
      if (!target) return null;
      const snapshot = snapshots.get(Number(target.object_id)) || null;
      products.set(key, { target, implementation: false, superseded: false, snapshot });
    }
    return products.get(key);
  };

  for (const item of active) {
    const target = item.target;
    if (item.target_type === "pdm_item" && target.item_type === PRODUCT_ITEM_TYPE) {
      ensureProduct(target.target_id);
    } else if (item.target_type === "pdm_revision" && itemTypes.get(Number(target.item_id)) === PRODUCT_ITEM_TYPE) {
      const entry = ensureProduct(target.item_id);
      if (!entry) continue;
      if (item.relationship_type === "IMPLEMENTED_BY" || item.relationship_type === "REALIZED_BY") entry.implementation = true;
      if (latest.size && !latest.has(Number(target.target_id))) entry.superseded = true;
      const key = String(target.item_id);
      if (!revisionsByProduct.has(key)) revisionsByProduct.set(key, []);
      revisionsByProduct.get(key).push({
        allocation_ref: item.allocation_ref,
        relationship_type: item.relationship_type,
        target_id: target.target_id,
        revision_number: target.revision_number,
        status: target.status,
        lifecycle_state: target.lifecycle_state,
        is_latest: latest.has(Number(target.target_id)),
        effectivity_from: item.effectivity_from,
        effectivity_to: item.effectivity_to,
        configuration_context: item.configuration_context,
      });
    }
  }

  const items = [...products.entries()].map(([key, entry]) => {
    const category = categoryFor(entry.target.status, entry.snapshot?.category);
    const stage = deriveRealizationStage({ category, implementation: entry.implementation, superseded: entry.superseded });
    return {
      ...productDescriptor({ ...entry.target, item_type: entry.target.item_type || PRODUCT_ITEM_TYPE }, entry.snapshot, { stage }),
      implementation: entry.implementation,
      superseded: entry.superseded,
      revisions: revisionsByProduct.get(key) || [],
    };
  });

  const countsByStage = Object.fromEntries(REALIZATION_STAGES.map((stage) => [stage, 0]));
  for (const product of items) countsByStage[product.realization_stage] = (countsByStage[product.realization_stage] || 0) + 1;
  const stage = items.reduce((best, product) => (STAGE_RANK[product.realization_stage] > STAGE_RANK[best] ? product.realization_stage : best), "PLANNED");

  return {
    requirement: {
      id: requirement.id,
      requirement_ref: requirement.requirement_ref,
      requirement_number: requirement.requirement_number,
      object_id: requirement.object_id ?? null,
      status: requirement.status || "",
    },
    products: items,
    product_count: items.length,
    realization: {
      stage: items.length ? stage : "PLANNED",
      counts_by_stage: countsByStage,
      released_count: items.filter((product) => product.is_released).length,
      superseded_count: items.filter((product) => product.superseded).length,
      implemented: items.some((product) => product.implementation),
    },
    source_module: "requirement-pdm",
  };
}

export function listRequirementProducts(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const allocations = listRequirementAllocations(db, tenant, requirementRef, { withTargets: true, status: options.status }).items;
  const productItemIds = allocations
    .filter((item) => item.target_type === "pdm_item" && item.target?.item_type === PRODUCT_ITEM_TYPE)
    .map((item) => Number(item.target.target_id));
  const revisionItemIds = allocations
    .filter((item) => item.target_type === "pdm_revision" && item.target?.item_id)
    .map((item) => Number(item.target.item_id));
  const objectIds = allocations.map((item) => item.target?.object_id).filter(Boolean);
  const snapshots = productLifecycleSnapshot(db, tenant, objectIds);
  const itemTypes = itemTypeMap(db, tenant, [...productItemIds, ...revisionItemIds]);
  const itemTargets = buildItemTargets(db, tenant, allocations, [...productItemIds, ...revisionItemIds]);
  const latest = latestRevisionIds(db, tenant, [...productItemIds, ...revisionItemIds]);
  return projectProducts(requirement, allocations, snapshots, { itemTypes, itemTargets, latestRevisionIds: latest });
}

export async function listRequirementProductsAsync(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const allocations = (await listRequirementAllocationsAsync(db, tenant, requirementRef, { withTargets: true, status: options.status })).items;
  const productItemIds = allocations
    .filter((item) => item.target_type === "pdm_item" && item.target?.item_type === PRODUCT_ITEM_TYPE)
    .map((item) => Number(item.target.target_id));
  const revisionItemIds = allocations
    .filter((item) => item.target_type === "pdm_revision" && item.target?.item_id)
    .map((item) => Number(item.target.item_id));
  const objectIds = allocations.map((item) => item.target?.object_id).filter(Boolean);
  const snapshots = await productLifecycleSnapshotAsync(db, tenant, objectIds);
  const itemTypes = await itemTypeMap(db, tenant, [...productItemIds, ...revisionItemIds], true);
  const itemTargets = await buildItemTargets(db, tenant, allocations, [...productItemIds, ...revisionItemIds], true);
  const latest = await latestRevisionIds(db, tenant, [...productItemIds, ...revisionItemIds], true);
  return projectProducts(requirement, allocations, snapshots, { itemTypes, itemTargets, latestRevisionIds: latest });
}

// Detail view: the full framework lifecycle (definition, state, transitions,
// pending release) for a single product, plus the derived realization stage.
export function productLifecycle(db, tenantId, productRef) {
  const tenant = Number(tenantId);
  const target = resolveTarget(db, tenant, "pdm_item", productRef);
  if (!target) throw invalidTarget(`PDM item not found: ${productRef}`, { target_type: "pdm_item", target_id: productRef });
  if (target.item_type !== PRODUCT_ITEM_TYPE) {
    throw invalidTarget(`PDM item ${target.number} is not a product`, { target_type: "pdm_item", target_id: target.target_id, item_type: target.item_type });
  }
  const lifecycle = target.object_id ? objectLifecycle(db, target.object_id, tenant) : null;
  const category = categoryFor(target.status, lifecycle?.state?.category);
  return {
    product: {
      target_id: target.target_id,
      object_id: target.object_id ?? null,
      ref: target.ref,
      number: target.number,
      name: target.name,
      item_type: target.item_type,
      status: target.status,
      lifecycle_state: target.lifecycle_state,
    },
    lifecycle,
    lifecycle_category: category,
    realization_stage: deriveRealizationStage({ category }),
    is_released: category === "released",
    source_module: "requirement-pdm",
  };
}

export async function productLifecycleAsync(db, tenantId, productRef) {
  const tenant = Number(tenantId);
  const target = await resolveTargetAsync(db, tenant, "pdm_item", productRef);
  if (!target) throw invalidTarget(`PDM item not found: ${productRef}`, { target_type: "pdm_item", target_id: productRef });
  if (target.item_type !== PRODUCT_ITEM_TYPE) {
    throw invalidTarget(`PDM item ${target.number} is not a product`, { target_type: "pdm_item", target_id: target.target_id, item_type: target.item_type });
  }
  const lifecycle = target.object_id ? await objectLifecycleAsync(db, target.object_id, tenant) : null;
  const category = categoryFor(target.status, lifecycle?.state?.category);
  return {
    product: {
      target_id: target.target_id,
      object_id: target.object_id ?? null,
      ref: target.ref,
      number: target.number,
      name: target.name,
      item_type: target.item_type,
      status: target.status,
      lifecycle_state: target.lifecycle_state,
    },
    lifecycle,
    lifecycle_category: category,
    realization_stage: deriveRealizationStage({ category }),
    is_released: category === "released",
    source_module: "requirement-pdm",
  };
}

// Reverse navigation: every requirement allocated to a product (its item or one
// of its revisions), resolved through the existing allocation edges.
function requirementMap(db, tenant, ids, isAsync = false) {
  const unique = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id)))];
  if (!unique.length) return isAsync ? Promise.resolve(new Map()) : new Map();
  const sql = `SELECT id, requirement_ref, requirement_number, status, object_id FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(unique)})`;
  const params = [Number(tenant), ...unique];
  if (isAsync) return queryAllAsync(db, sql, params).then((rows) => new Map(rows.map((row) => [Number(row.id), row])));
  return new Map(queryAll(db, sql, params).map((row) => [Number(row.id), row]));
}

export function listProductRequirements(db, tenantId, productRef, options = {}) {
  const tenant = Number(tenantId);
  const target = resolveTarget(db, tenant, "pdm_item", productRef);
  if (!target) throw invalidTarget(`PDM item not found: ${productRef}`, { target_type: "pdm_item", target_id: productRef });
  if (target.item_type !== PRODUCT_ITEM_TYPE) {
    throw invalidTarget(`PDM item ${target.number} is not a product`, { target_type: "pdm_item", target_id: target.target_id, item_type: target.item_type });
  }
  let rows = queryAll(
    db,
    `SELECT rr.* FROM requirement_relationships rr
      WHERE rr.tenant_id = ? AND rr.source_type = 'requirement'
        AND rr.relationship_type IN (${placeholders(ALLOCATION_CODES)})
        AND ((rr.target_type = 'pdm_item' AND rr.target_id = ?) OR
             (rr.target_type = 'pdm_revision' AND rr.target_id IN (SELECT CAST(id AS TEXT) FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ?)))
      ORDER BY rr.id DESC`,
    [tenant, ...ALLOCATION_CODES, String(target.target_id), tenant, target.target_id]
  );
  if (options.status) rows = rows.filter((row) => row.status === String(options.status).toUpperCase());
  const reqs = requirementMap(db, tenant, rows.map((row) => row.source_id));
  const items = rows.map((row) => {
    const requirement = reqs.get(Number(row.source_id)) || null;
    return {
      allocation_ref: row.relationship_ref || "",
      relationship_type: row.relationship_type,
      status: row.status,
      requirement_id: requirement?.id ?? Number(row.source_id),
      requirement_ref: requirement?.requirement_ref ?? "",
      requirement_number: requirement?.requirement_number ?? "",
      requirement_status: requirement?.status ?? "",
      effectivity_from: row.effectivity_from ?? null,
      effectivity_to: row.effectivity_to ?? null,
    };
  });
  return { product: { target_id: target.target_id, ref: target.ref, number: target.number, name: target.name, item_type: target.item_type }, items, total: items.length, source_module: "requirement-pdm" };
}

export async function listProductRequirementsAsync(db, tenantId, productRef, options = {}) {
  const tenant = Number(tenantId);
  const target = await resolveTargetAsync(db, tenant, "pdm_item", productRef);
  if (!target) throw invalidTarget(`PDM item not found: ${productRef}`, { target_type: "pdm_item", target_id: productRef });
  if (target.item_type !== PRODUCT_ITEM_TYPE) {
    throw invalidTarget(`PDM item ${target.number} is not a product`, { target_type: "pdm_item", target_id: target.target_id, item_type: target.item_type });
  }
  let rows = await queryAllAsync(
    db,
    `SELECT rr.* FROM requirement_relationships rr
      WHERE rr.tenant_id = ? AND rr.source_type = 'requirement'
        AND rr.relationship_type IN (${placeholders(ALLOCATION_CODES)})
        AND ((rr.target_type = 'pdm_item' AND rr.target_id = ?) OR
             (rr.target_type = 'pdm_revision' AND rr.target_id IN (SELECT CAST(id AS TEXT) FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ?)))
      ORDER BY rr.id DESC`,
    [tenant, ...ALLOCATION_CODES, String(target.target_id), tenant, target.target_id]
  );
  if (options.status) rows = rows.filter((row) => row.status === String(options.status).toUpperCase());
  const reqs = await requirementMap(db, tenant, rows.map((row) => row.source_id), true);
  const items = rows.map((row) => {
    const requirement = reqs.get(Number(row.source_id)) || null;
    return {
      allocation_ref: row.relationship_ref || "",
      relationship_type: row.relationship_type,
      status: row.status,
      requirement_id: requirement?.id ?? Number(row.source_id),
      requirement_ref: requirement?.requirement_ref ?? "",
      requirement_number: requirement?.requirement_number ?? "",
      requirement_status: requirement?.status ?? "",
      effectivity_from: row.effectivity_from ?? null,
      effectivity_to: row.effectivity_to ?? null,
    };
  });
  return { product: { target_id: target.target_id, ref: target.ref, number: target.number, name: target.name, item_type: target.item_type }, items, total: items.length, source_module: "requirement-pdm" };
}
