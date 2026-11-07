// Requirement -> PLM document projection.
//
// Documents are never copied: the integration reuses the platform's Content /
// Document Management objects (`content` + `content_associations`) and only
// resolves which objects a requirement reaches, then reads the content already
// associated with them. This mirrors `content/associations.js#listObjectContent`
// (same tables, same "active association" semantics) but batches the lookup so a
// requirement with many PLM objects never triggers an N+1 read.
//
// Reachable document sources:
//
//   Requirement -> Product / revision / dataset
//   Requirement -> EBOM / MBOM / BOP revision
//   Requirement -> Change request -> change order -> change notice
//
// No document object, version, lifecycle, access-control or retention logic is
// re-implemented here.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { Requirements } from "../requirements/index.js";
import { DOWNLOADABLE_STATUSES } from "../content/constants.js";
import { listRequirementAllocations, listRequirementAllocationsAsync } from "./allocations.js";
import { listRequirementChanges, listRequirementChangesAsync } from "./changes.js";
import { CHANGE_NODE_TYPES, PDM_NODE_TYPES, PLM_DOCUMENT_CATEGORIES, REQUIREMENT_SOURCE_TYPE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";
import { paginate } from "./validation.js";

const CATEGORY_REQUIREMENT = "REQUIREMENT";
const CATEGORY_PRODUCT = "PRODUCT";
const CATEGORY_STRUCTURE = "STRUCTURE";
const CATEGORY_CHANGE = "CHANGE";
const CATEGORY_RANK = Object.freeze(Object.fromEntries(PLM_DOCUMENT_CATEGORIES.map((category, index) => [category, index])));
const CHANGE_TYPES = new Set(Object.values(CHANGE_NODE_TYPES));

// Reuse the content service's canonical availability vocabulary instead of
// inventing an access model: a document is only projected when its content is in
// a downloadable state and has not been quarantined as infected.
const DOWNLOADABLE_SQL = DOWNLOADABLE_STATUSES.map((status) => `'${status}'`).join(", ");

const TARGET_SELECT = `SELECT a.id AS association_id, a.association_ref, a.object_type AS target_object_type,
       a.object_id AS target_object_id, a.object_name, a.content_role, a.is_primary, a.sequence,
       a.status AS association_status, a.effective_from, a.effective_to,
       c.id AS content_id, c.content_key, c.file_name, c.mime_type, c.file_size,
       c.status AS content_status, c.security_status, c.version_count, c.security_classification
  FROM content_associations a
  JOIN content c ON c.id = a.content_id
 WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status = 'active' AND c.deleted_at IS NULL
   AND c.status IN (${DOWNLOADABLE_SQL}) AND (c.security_status IS NULL OR c.security_status <> 'infected')`;

// Classifies a resolved object node into the document source category.
export function documentCategoryFor(nodeType) {
  const type = String(nodeType || "").toLowerCase();
  if (type === REQUIREMENT_SOURCE_TYPE) return CATEGORY_REQUIREMENT;
  if (CHANGE_TYPES.has(type)) return CATEGORY_CHANGE;
  if (type === PDM_NODE_TYPES.BOM_REVISION) return CATEGORY_STRUCTURE;
  return CATEGORY_PRODUCT;
}

function categoryRank(category) {
  return CATEGORY_RANK[category] ?? PLM_DOCUMENT_CATEGORIES.length;
}

function nodeKey(type, id) {
  return `${type}\u0000${String(id)}`;
}

// Builds the deduplicated set of objects reachable from a requirement. Each node
// carries the identity a document association would use plus display metadata.
function requirementTargets(requirement, allocations, changes, { orders = [], notices = [] } = {}) {
  const targets = new Map();
  const add = (category, objectType, objectId, meta = {}) => {
    if (objectId === null || objectId === undefined || String(objectId).trim() === "") return;
    const key = nodeKey(objectType, objectId);
    if (targets.has(key)) return;
    targets.set(key, { category, object_type: objectType, object_id: String(objectId), ...meta });
  };

  add(CATEGORY_REQUIREMENT, REQUIREMENT_SOURCE_TYPE, requirement.id, {
    label: requirement.title || "",
    ref: requirement.requirement_ref || "",
    number: requirement.requirement_number || "",
  });

  for (const item of allocations) {
    if (!item.target) continue;
    if (item.status && item.status !== "ACTIVE") continue;
    const target = item.target;
    add(documentCategoryFor(item.target_type), item.target_type, target.object_id ?? target.target_id, {
      label: target.name || "",
      ref: target.ref || "",
      number: target.number || "",
      item_id: target.item_id ?? null,
      revision_number: target.revision_number ?? null,
      status: target.status || "",
    });
  }

  for (const link of changes) {
    add(documentCategoryFor(link.change_type), link.change_type, link.change_id, {
      label: link.change?.title || "",
      ref: link.change?.ref || "",
      number: link.change?.number || "",
      status: link.change?.status || "",
    });
  }
  for (const order of orders) {
    add(CATEGORY_CHANGE, CHANGE_NODE_TYPES.ORDER, order.id, {
      label: order.title || "",
      ref: order.order_ref || "",
      number: order.order_number || "",
      status: order.status || "",
    });
  }
  for (const notice of notices) {
    add(CATEGORY_CHANGE, CHANGE_NODE_TYPES.NOTICE, notice.id, {
      label: notice.title || "",
      ref: notice.notice_ref || "",
      number: notice.notice_number || "",
      status: notice.status || "",
    });
  }

  return [...targets.values()].sort((a, b) => {
    const rank = categoryRank(a.category) - categoryRank(b.category);
    if (rank !== 0) return rank;
    return String(a.number || a.object_id).localeCompare(String(b.number || b.object_id));
  });
}

function targetParameters(targets) {
  const params = [];
  const clauses = [];
  for (const target of targets) {
    clauses.push("(a.object_type = ? AND a.object_id = ?)");
    params.push(target.object_type, target.object_id);
  }
  return { clause: clauses.length ? ` AND (${clauses.join(" OR ")})` : "", params };
}

function decorate(row, target) {
  return {
    association_ref: row.association_ref || "",
    content_id: row.content_id,
    content_key: row.content_key || "",
    file_name: row.file_name || "",
    mime_type: row.mime_type || "",
    file_size: row.file_size ?? null,
    document_role: row.content_role || "",
    is_primary: row.is_primary === 1 || row.is_primary === true,
    sequence: row.sequence ?? 0,
    status: row.content_status || "",
    security_status: row.security_status || "",
    security_classification: row.security_classification || "",
    version_count: row.version_count ?? 0,
    effective_from: row.effective_from ?? null,
    effective_to: row.effective_to ?? null,
    source: {
      category: target.category,
      object_type: target.object_type,
      object_id: target.object_id,
      label: target.label || "",
      ref: target.ref || "",
      number: target.number || "",
    },
  };
}

function shape(requirement, targets, rows, options = {}) {
  const byKey = new Map(targets.map((target) => [nodeKey(target.object_type, target.object_id), target]));
  let documents = rows
    .map((row) => {
      const target = byKey.get(nodeKey(row.target_object_type, row.target_object_id));
      return target ? decorate(row, target) : null;
    })
    .filter(Boolean);

  if (options.category) {
    const wanted = new Set(String(options.category).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
    if (wanted.size) documents = documents.filter((doc) => wanted.has(doc.source.category));
  }

  documents.sort((a, b) => {
    const rank = categoryRank(a.source.category) - categoryRank(b.source.category);
    if (rank !== 0) return rank;
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return Number(a.content_id) - Number(b.content_id);
  });

  const byCategory = Object.fromEntries(PLM_DOCUMENT_CATEGORIES.map((category) => [category, []]));
  for (const document of documents) byCategory[document.source.category].push(document);

  const { limit, offset, page } = paginate({ page: options.page, pageSize: options.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const paged = documents.slice(offset, offset + limit);

  return {
    requirement: {
      id: requirement.id,
      requirement_ref: requirement.requirement_ref || "",
      requirement_number: requirement.requirement_number || "",
      object_id: requirement.object_id ?? null,
      status: requirement.status || "",
    },
    sources: targets,
    documents: paged,
    by_category: byCategory,
    total: documents.length,
    page,
    page_size: limit,
    source_count: targets.length,
    source_module: "requirement-pdm",
  };
}

function changeTrees(db, tenant, changes) {
  const requestIds = [...new Set(changes.filter((link) => link.change_type === CHANGE_NODE_TYPES.REQUEST).map((link) => Number(link.change_id)).filter((id) => Number.isInteger(id)))];
  if (!requestIds.length) return { orders: [], notices: [] };
  const marks = requestIds.map(() => "?").join(", ");
  const orders = queryAll(db, `SELECT id, order_ref, order_number, title, status, change_request_id FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks})`, [Number(tenant), ...requestIds]);
  const orderIds = orders.map((order) => Number(order.id)).filter((id) => Number.isInteger(id));
  let notices = [];
  if (orderIds.length) {
    const orderMarks = orderIds.map(() => "?").join(", ");
    notices = queryAll(db, `SELECT id, notice_ref, notice_number, title, status, change_order_id FROM change_notices WHERE tenant_id = ? AND change_order_id IN (${orderMarks})`, [Number(tenant), ...orderIds]);
  }
  return { orders, notices };
}

async function changeTreesAsync(db, tenant, changes) {
  const requestIds = [...new Set(changes.filter((link) => link.change_type === CHANGE_NODE_TYPES.REQUEST).map((link) => Number(link.change_id)).filter((id) => Number.isInteger(id)))];
  if (!requestIds.length) return { orders: [], notices: [] };
  const marks = requestIds.map(() => "?").join(", ");
  const orders = await queryAllAsync(db, `SELECT id, order_ref, order_number, title, status, change_request_id FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks})`, [Number(tenant), ...requestIds]);
  const orderIds = orders.map((order) => Number(order.id)).filter((id) => Number.isInteger(id));
  let notices = [];
  if (orderIds.length) {
    const orderMarks = orderIds.map(() => "?").join(", ");
    notices = await queryAllAsync(db, `SELECT id, notice_ref, notice_number, title, status, change_order_id FROM change_notices WHERE tenant_id = ? AND change_order_id IN (${orderMarks})`, [Number(tenant), ...orderIds]);
  }
  return { orders, notices };
}

export function requirementDocuments(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const allocations = listRequirementAllocations(db, tenant, requirementRef, { withTargets: true, status: "ACTIVE" }).items;
  const changes = listRequirementChanges(db, tenant, requirement.id, { pageSize: MAX_PAGE_SIZE }).items;
  const { orders, notices } = changeTrees(db, tenant, changes);
  const targets = requirementTargets(requirement, allocations, changes, { orders, notices });
  if (!targets.length) return shape(requirement, [], [], options);
  const { clause, params } = targetParameters(targets);
  const rows = queryAll(db, `${TARGET_SELECT}${clause} ORDER BY a.is_primary DESC, a.sequence ASC, a.id ASC`, [tenant, ...params]);
  return shape(requirement, targets, rows, options);
}

export async function requirementDocumentsAsync(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const allocations = (await listRequirementAllocationsAsync(db, tenant, requirementRef, { withTargets: true, status: "ACTIVE" })).items;
  const changes = (await listRequirementChangesAsync(db, tenant, requirement.id, { pageSize: MAX_PAGE_SIZE })).items;
  const { orders, notices } = await changeTreesAsync(db, tenant, changes);
  const targets = requirementTargets(requirement, allocations, changes, { orders, notices });
  if (!targets.length) return shape(requirement, [], [], options);
  const { clause, params } = targetParameters(targets);
  const rows = await queryAllAsync(db, `${TARGET_SELECT}${clause} ORDER BY a.is_primary DESC, a.sequence ASC, a.id ASC`, [tenant, ...params]);
  return shape(requirement, targets, rows, options);
}
