// Quality issue / inspection / corrective-action service (Stage 9).
//
// These records are additive projections onto authoritative engineering,
// manufacturing and product data. Every write is tenant-scoped, references a
// resolved authoritative subject where relevant, is audited and emits a domain
// event. Derived quality data never grants access to source data it could not
// already read (prompt §3.3): listings filter by tenant and every subject is
// resolved through the owning module.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import {
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  parseArray,
  toIntOrNull,
  toNumber,
} from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishManufacturingQualityEvent, publishManufacturingQualityEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import {
  resolveObjectSubject,
  resolveObjectSubjectAsync,
  resolveBomRevisionSubject,
  resolveBomRevisionSubjectAsync,
} from "./subjects.js";
import {
  SOURCE_MODULE,
  ISSUE_TYPES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_DISPOSITIONS,
  ACTIVE_ISSUE_STATUSES,
  CLOSED_ISSUE_STATUSES,
  INSPECTION_TYPES,
  INSPECTION_STATUSES,
  TERMINAL_INSPECTION_STATUSES,
  ACTION_TYPES,
  ACTION_STATUSES,
  OPEN_ACTION_STATUSES,
  ACTION_EFFECTIVENESS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./constants.js";
import {
  issueNotFound,
  issueConflict,
  inspectionNotFound,
  inspectionConflict,
  actionNotFound,
  actionConflict,
  invalidMq,
  invalidTransition,
} from "./errors.js";
import { shortId, issueRef, inspectionRef, actionRef } from "./refs.js";

const ISSUE_COLUMNS = [
  "title",
  "description",
  "issue_type",
  "severity",
  "status",
  "disposition",
  "product_object_id",
  "product_revision",
  "component_object_id",
  "operation_object_id",
  "bom_revision_id",
  "supplier_object_id",
  "detected_at",
  "detected_by",
  "source_ref",
  "metadata_json",
  "organization_id",
  "plant_id",
];

const INSPECTION_COLUMNS = [
  "title",
  "inspection_type",
  "requirement_text",
  "status",
  "product_object_id",
  "product_revision",
  "operation_object_id",
  "component_object_id",
  "characteristic_ref",
  "quality_issue_id",
  "performed_by",
  "performed_at",
  "sample_size",
  "passed_count",
  "failed_count",
  "result_json",
  "metadata_json",
  "organization_id",
];

const ACTION_COLUMNS = [
  "title",
  "description",
  "action_type",
  "status",
  "root_cause",
  "owner_user_id",
  "due_at",
  "implemented_at",
  "verified_at",
  "verified_by",
  "effectiveness",
  "evidence_json",
  "metadata_json",
  "organization_id",
];

// ── Public projections ───────────────────────────────────────────────────────

export function publicIssue(row) {
  if (!row) return null;
  return {
    id: row.id,
    issue_ref: row.issue_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    code: row.code,
    title: row.title,
    description: row.description,
    issue_type: row.issue_type,
    severity: row.severity,
    status: row.status,
    disposition: row.disposition || "",
    product_object_id: row.product_object_id ?? null,
    product_revision: row.product_revision || "",
    component_object_id: row.component_object_id ?? null,
    operation_object_id: row.operation_object_id ?? null,
    bom_revision_id: row.bom_revision_id ?? null,
    supplier_object_id: row.supplier_object_id ?? null,
    detected_at: row.detected_at || null,
    detected_by: row.detected_by ?? null,
    source_ref: row.source_ref || "",
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicInspection(row) {
  if (!row) return null;
  return {
    id: row.id,
    inspection_ref: row.inspection_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    title: row.title,
    inspection_type: row.inspection_type,
    requirement_text: row.requirement_text,
    status: row.status,
    product_object_id: row.product_object_id ?? null,
    product_revision: row.product_revision || "",
    operation_object_id: row.operation_object_id ?? null,
    component_object_id: row.component_object_id ?? null,
    characteristic_ref: row.characteristic_ref || "",
    quality_issue_id: row.quality_issue_id ?? null,
    performed_by: row.performed_by ?? null,
    performed_at: row.performed_at || null,
    sample_size: row.sample_size ?? null,
    passed_count: row.passed_count ?? null,
    failed_count: row.failed_count ?? null,
    result: parseObject(row.result_json, {}),
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    action_ref: row.action_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    quality_issue_id: row.quality_issue_id,
    code: row.code,
    title: row.title,
    description: row.description,
    action_type: row.action_type,
    status: row.status,
    root_cause: row.root_cause,
    owner_user_id: row.owner_user_id ?? null,
    due_at: row.due_at || null,
    implemented_at: row.implemented_at || null,
    verified_at: row.verified_at || null,
    verified_by: row.verified_by ?? null,
    effectiveness: row.effectiveness || "",
    evidence: parseArray(row.evidence_json, []),
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Normalizers ──────────────────────────────────────────────────────────────

function enumOrThrow(value, allowed, label, { allowEmpty = false } = {}) {
  const normalized = normalizeUpper(value, { max: 40 });
  if (allowEmpty && normalized === "") return "";
  if (!allowed.includes(normalized)) {
    throw invalidMq(`Invalid ${label}: ${normalized}`, { allowed: [...allowed] });
  }
  return normalized;
}

function resolveIssueSubjectIds(db, tenant, body, current = {}) {
  const pick = (key, resolver) => {
    const raw = body[key];
    if (raw === undefined) return current[key] ?? null;
    if (raw === null || raw === "") return null;
    return resolver(raw);
  };
  const product = pick("product_object_id", (raw) => resolveObjectSubject(db, tenant, raw, "PRODUCT_REVISION").id);
  const component = pick("component_object_id", (raw) => resolveObjectSubject(db, tenant, raw, "component").id);
  const operation = pick("operation_object_id", (raw) => resolveObjectSubject(db, tenant, raw, "OPERATION").id);
  const supplier = pick("supplier_object_id", (raw) => resolveObjectSubject(db, tenant, raw, "SUPPLIER").id);
  const bom = pick("bom_revision_id", (raw) => resolveBomRevisionSubject(db, tenant, raw).id);
  return { product, component, operation, supplier, bom };
}

async function resolveIssueSubjectIdsAsync(db, tenant, body, current = {}) {
  const pick = async (key, resolver) => {
    const raw = body[key];
    if (raw === undefined) return current[key] ?? null;
    if (raw === null || raw === "") return null;
    return resolver(raw);
  };
  const product = await pick("product_object_id", async (raw) => (await resolveObjectSubjectAsync(db, tenant, raw, "PRODUCT_REVISION")).id);
  const component = await pick("component_object_id", async (raw) => (await resolveObjectSubjectAsync(db, tenant, raw, "component")).id);
  const operation = await pick("operation_object_id", async (raw) => (await resolveObjectSubjectAsync(db, tenant, raw, "OPERATION")).id);
  const supplier = await pick("supplier_object_id", async (raw) => (await resolveObjectSubjectAsync(db, tenant, raw, "SUPPLIER")).id);
  const bom = await pick("bom_revision_id", async (raw) => (await resolveBomRevisionSubjectAsync(db, tenant, raw)).id);
  return { product, component, operation, supplier, bom };
}

function normalizeIssueInput(db, tenant, body = {}, current = {}) {
  const status = body.status !== undefined ? enumOrThrow(body.status, ISSUE_STATUSES, "status") : current.status || "OPEN";
  const disposition =
    body.disposition !== undefined ? enumOrThrow(body.disposition, ISSUE_DISPOSITIONS, "disposition", { allowEmpty: true }) : current.disposition || "";
  if (CLOSED_ISSUE_STATUSES.includes(status) && !disposition) {
    throw invalidMq("A resolved/closed issue requires a disposition", { status });
  }
  const subjects = resolveIssueSubjectIds(db, tenant, body, {
    product_object_id: current.product_object_id,
    component_object_id: current.component_object_id,
    operation_object_id: current.operation_object_id,
    supplier_object_id: current.supplier_object_id,
    bom_revision_id: current.bom_revision_id,
  });
  return {
    title: normalizeText(body.title ?? current.title, { max: 300 }),
    description: normalizeText(body.description ?? current.description, { max: 8000 }),
    issue_type: body.issue_type !== undefined ? enumOrThrow(body.issue_type, ISSUE_TYPES, "issue_type") : current.issue_type || "NONCONFORMANCE",
    severity: body.severity !== undefined ? enumOrThrow(body.severity, ISSUE_SEVERITIES, "severity") : current.severity || "MEDIUM",
    status,
    disposition,
    product_object_id: subjects.product,
    product_revision: normalizeText(body.product_revision ?? current.product_revision, { max: 60 }),
    component_object_id: subjects.component,
    operation_object_id: subjects.operation,
    bom_revision_id: subjects.bom,
    supplier_object_id: subjects.supplier,
    detected_at: body.detected_at !== undefined ? normalizeText(body.detected_at, { max: 40 }) || null : current.detected_at ?? null,
    detected_by: body.detected_by !== undefined ? toIntOrNull(body.detected_by) : current.detected_by ?? null,
    source_ref: normalizeText(body.source_ref ?? current.source_ref, { max: 300 }),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : parseObject(current.metadata_json, {})),
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
    plant_id: body.plant_id !== undefined ? toIntOrNull(body.plant_id) : current.plant_id ?? null,
  };
}

async function normalizeIssueInputAsync(db, tenant, body = {}, current = {}) {
  const status = body.status !== undefined ? enumOrThrow(body.status, ISSUE_STATUSES, "status") : current.status || "OPEN";
  const disposition =
    body.disposition !== undefined ? enumOrThrow(body.disposition, ISSUE_DISPOSITIONS, "disposition", { allowEmpty: true }) : current.disposition || "";
  if (CLOSED_ISSUE_STATUSES.includes(status) && !disposition) {
    throw invalidMq("A resolved/closed issue requires a disposition", { status });
  }
  const subjects = await resolveIssueSubjectIdsAsync(db, tenant, body, {
    product_object_id: current.product_object_id,
    component_object_id: current.component_object_id,
    operation_object_id: current.operation_object_id,
    supplier_object_id: current.supplier_object_id,
    bom_revision_id: current.bom_revision_id,
  });
  return {
    title: normalizeText(body.title ?? current.title, { max: 300 }),
    description: normalizeText(body.description ?? current.description, { max: 8000 }),
    issue_type: body.issue_type !== undefined ? enumOrThrow(body.issue_type, ISSUE_TYPES, "issue_type") : current.issue_type || "NONCONFORMANCE",
    severity: body.severity !== undefined ? enumOrThrow(body.severity, ISSUE_SEVERITIES, "severity") : current.severity || "MEDIUM",
    status,
    disposition,
    product_object_id: subjects.product,
    product_revision: normalizeText(body.product_revision ?? current.product_revision, { max: 60 }),
    component_object_id: subjects.component,
    operation_object_id: subjects.operation,
    bom_revision_id: subjects.bom,
    supplier_object_id: subjects.supplier,
    detected_at: body.detected_at !== undefined ? normalizeText(body.detected_at, { max: 40 }) || null : current.detected_at ?? null,
    detected_by: body.detected_by !== undefined ? toIntOrNull(body.detected_by) : current.detected_by ?? null,
    source_ref: normalizeText(body.source_ref ?? current.source_ref, { max: 300 }),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : parseObject(current.metadata_json, {})),
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
    plant_id: body.plant_id !== undefined ? toIntOrNull(body.plant_id) : current.plant_id ?? null,
  };
}

// ── Quality issues ───────────────────────────────────────────────────────────

function issueFilters({ tenantId, status, severity, issue_type, product_object_id, operation_object_id, supplier_object_id, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(normalizeUpper(severity));
  }
  if (issue_type) {
    clauses.push("issue_type = ?");
    params.push(normalizeUpper(issue_type));
  }
  if (product_object_id) {
    clauses.push("product_object_id = ?");
    params.push(Number(product_object_id));
  }
  if (operation_object_id) {
    clauses.push("operation_object_id = ?");
    params.push(Number(operation_object_id));
  }
  if (supplier_object_id) {
    clauses.push("supplier_object_id = ?");
    params.push(Number(supplier_object_id));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR title ILIKE ? OR description ILIKE ?)");
    params.push(like, like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listQualityIssues(db, opts = {}) {
  const { where, params } = issueFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_issues ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM quality_issues ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicIssue), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listQualityIssuesAsync(db, opts = {}) {
  const { where, params } = issueFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_issues ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM quality_issues ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicIssue), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getIssueRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM quality_issues WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM quality_issues WHERE tenant_id = ? AND (issue_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getIssueRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM quality_issues WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM quality_issues WHERE tenant_id = ? AND (issue_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function requireIssueRow(db, tenantId, ref) {
  const row = getIssueRow(db, tenantId, ref);
  if (!row) throw issueNotFound(ref);
  return row;
}

export async function requireIssueRowAsync(db, tenantId, ref) {
  const row = await getIssueRowAsync(db, tenantId, ref);
  if (!row) throw issueNotFound(ref);
  return row;
}

export function getQualityIssue(db, tenantId, ref) {
  return publicIssue(getIssueRow(db, tenantId, ref));
}

export async function getQualityIssueAsync(db, tenantId, ref) {
  return publicIssue(await getIssueRowAsync(db, tenantId, ref));
}

export function createQualityIssue(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeIssueInput(db, tenant, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || issueRef(shortId());
  if (queryOne(db, "SELECT id FROM quality_issues WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw issueConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO quality_issues
       (issue_ref, tenant_id, organization_id, plant_id, code, title, description, issue_type, severity, status, disposition,
        product_object_id, product_revision, component_object_id, operation_object_id, bom_revision_id, supplier_object_id,
        detected_at, detected_by, source_ref, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      issueRef(providedCode),
      tenant,
      input.organization_id,
      input.plant_id,
      providedCode,
      input.title,
      input.description,
      input.issue_type,
      input.severity,
      input.status,
      input.disposition,
      input.product_object_id,
      input.product_revision,
      input.component_object_id,
      input.operation_object_id,
      input.bom_revision_id,
      input.supplier_object_id,
      input.detected_at,
      input.detected_by,
      input.source_ref,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM quality_issues WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "manufacturing-quality.issue.create", resourceType: "quality_issue", resourceId: row.issue_ref, details: { code: row.code, severity: row.severity }, ip });
  publishManufacturingQualityEvent(
    db,
    { eventType: "QualityIssueCreated", objectType: "quality_issue", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { issue_ref: row.issue_ref, code: row.code, severity: row.severity, status: row.status } },
    actor
  );
  return publicIssue(row);
}

export async function createQualityIssueAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = await normalizeIssueInputAsync(db, tenant, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || issueRef(shortId());
  if (await queryOneAsync(db, "SELECT id FROM quality_issues WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw issueConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO quality_issues
       (issue_ref, tenant_id, organization_id, plant_id, code, title, description, issue_type, severity, status, disposition,
        product_object_id, product_revision, component_object_id, operation_object_id, bom_revision_id, supplier_object_id,
        detected_at, detected_by, source_ref, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      issueRef(providedCode),
      tenant,
      input.organization_id,
      input.plant_id,
      providedCode,
      input.title,
      input.description,
      input.issue_type,
      input.severity,
      input.status,
      input.disposition,
      input.product_object_id,
      input.product_revision,
      input.component_object_id,
      input.operation_object_id,
      input.bom_revision_id,
      input.supplier_object_id,
      input.detected_at,
      input.detected_by,
      input.source_ref,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM quality_issues WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.issue.create", resourceType: "quality_issue", resourceId: row.issue_ref, details: { code: row.code, severity: row.severity }, ip });
  await publishManufacturingQualityEventAsync(
    db,
    { eventType: "QualityIssueCreated", objectType: "quality_issue", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { issue_ref: row.issue_ref, code: row.code, severity: row.severity, status: row.status } },
    actor
  );
  return publicIssue(row);
}

export function updateQualityIssue(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireIssueRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, issueConflict);
  const input = normalizeIssueInput(db, tenant, body, row);
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  updateRow(db, "quality_issues", row.id, patch, { columns: [...ISSUE_COLUMNS, "version", "updated_by"] });
  const updated = queryOne(db, "SELECT * FROM quality_issues WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "manufacturing-quality.issue.update", resourceType: "quality_issue", resourceId: updated.issue_ref, details: { code: updated.code }, ip });
  if (updated.status !== row.status || updated.disposition !== row.disposition) {
    publishManufacturingQualityEvent(
      db,
      { eventType: "QualityIssueStatusChanged", objectType: "quality_issue", objectId: String(updated.id), tenantId: tenant, organizationId: updated.organization_id, payload: { issue_ref: updated.issue_ref, from: row.status, to: updated.status } },
      actor
    );
  }
  return publicIssue(updated);
}

export async function updateQualityIssueAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireIssueRowAsync(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, issueConflict);
  const input = await normalizeIssueInputAsync(db, tenant, body, row);
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  await updateRowAsync(db, "quality_issues", row.id, patch, { columns: [...ISSUE_COLUMNS, "version", "updated_by"] });
  const updated = await queryOneAsync(db, "SELECT * FROM quality_issues WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.issue.update", resourceType: "quality_issue", resourceId: updated.issue_ref, details: { code: updated.code }, ip });
  if (updated.status !== row.status || updated.disposition !== row.disposition) {
    await publishManufacturingQualityEventAsync(
      db,
      { eventType: "QualityIssueStatusChanged", objectType: "quality_issue", objectId: String(updated.id), tenantId: tenant, organizationId: updated.organization_id, payload: { issue_ref: updated.issue_ref, from: row.status, to: updated.status } },
      actor
    );
  }
  return publicIssue(updated);
}

// ── Inspections ──────────────────────────────────────────────────────────────

function inspectionFilters({ tenantId, status, inspection_type, product_object_id, operation_object_id, quality_issue_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (inspection_type) {
    clauses.push("inspection_type = ?");
    params.push(normalizeUpper(inspection_type));
  }
  if (product_object_id) {
    clauses.push("product_object_id = ?");
    params.push(Number(product_object_id));
  }
  if (operation_object_id) {
    clauses.push("operation_object_id = ?");
    params.push(Number(operation_object_id));
  }
  if (quality_issue_id) {
    clauses.push("quality_issue_id = ?");
    params.push(Number(quality_issue_id));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listInspections(db, opts = {}) {
  const { where, params } = inspectionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_inspections ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM quality_inspections ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicInspection), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listInspectionsAsync(db, opts = {}) {
  const { where, params } = inspectionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_inspections ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM quality_inspections ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicInspection), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getInspectionRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM quality_inspections WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM quality_inspections WHERE tenant_id = ? AND (inspection_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getInspectionRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM quality_inspections WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM quality_inspections WHERE tenant_id = ? AND (inspection_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function requireInspectionRow(db, tenantId, ref) {
  const row = getInspectionRow(db, tenantId, ref);
  if (!row) throw inspectionNotFound(ref);
  return row;
}

export async function requireInspectionRowAsync(db, tenantId, ref) {
  const row = await getInspectionRowAsync(db, tenantId, ref);
  if (!row) throw inspectionNotFound(ref);
  return row;
}

function normalizeInspectionInput(db, tenant, body = {}, current = {}) {
  const status = body.status !== undefined ? enumOrThrow(body.status, INSPECTION_STATUSES, "status") : current.status || "PLANNED";
  const product = body.product_object_id !== undefined
    ? (body.product_object_id === null || body.product_object_id === "" ? null : resolveObjectSubject(db, tenant, body.product_object_id, "PRODUCT_REVISION").id)
    : current.product_object_id ?? null;
  const operation = body.operation_object_id !== undefined
    ? (body.operation_object_id === null || body.operation_object_id === "" ? null : resolveObjectSubject(db, tenant, body.operation_object_id, "OPERATION").id)
    : current.operation_object_id ?? null;
  const component = body.component_object_id !== undefined
    ? (body.component_object_id === null || body.component_object_id === "" ? null : resolveObjectSubject(db, tenant, body.component_object_id, "component").id)
    : current.component_object_id ?? null;
  const qualityIssueId = body.quality_issue_id !== undefined ? toIntOrNull(body.quality_issue_id) : current.quality_issue_id ?? null;
  if (qualityIssueId !== null) requireIssueRow(db, tenant, qualityIssueId);
  const sampleSize = body.sample_size !== undefined ? toIntOrNull(body.sample_size) : current.sample_size ?? null;
  const passed = body.passed_count !== undefined ? toIntOrNull(body.passed_count) : current.passed_count ?? null;
  const failed = body.failed_count !== undefined ? toIntOrNull(body.failed_count) : current.failed_count ?? null;
  if (sampleSize !== null && passed !== null && failed !== null && passed + failed > sampleSize) {
    throw invalidMq("passed_count + failed_count cannot exceed sample_size", { sample_size: sampleSize, passed_count: passed, failed_count: failed });
  }
  return {
    title: normalizeText(body.title ?? current.title, { max: 300 }),
    inspection_type: body.inspection_type !== undefined ? enumOrThrow(body.inspection_type, INSPECTION_TYPES, "inspection_type") : current.inspection_type || "INCOMING",
    requirement_text: normalizeText(body.requirement_text ?? current.requirement_text, { max: 4000 }),
    status,
    product_object_id: product,
    product_revision: normalizeText(body.product_revision ?? current.product_revision, { max: 60 }),
    operation_object_id: operation,
    component_object_id: component,
    characteristic_ref: normalizeText(body.characteristic_ref ?? current.characteristic_ref, { max: 120 }),
    quality_issue_id: qualityIssueId,
    performed_by: body.performed_by !== undefined ? toIntOrNull(body.performed_by) : current.performed_by ?? null,
    performed_at: body.performed_at !== undefined ? normalizeText(body.performed_at, { max: 40 }) || null : current.performed_at ?? null,
    sample_size: sampleSize,
    passed_count: passed,
    failed_count: failed,
    result_json: JSON.stringify(body.result !== undefined ? parseObject(body.result, {}) : parseObject(current.result_json, {})),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : parseObject(current.metadata_json, {})),
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
  };
}

async function normalizeInspectionInputAsync(db, tenant, body = {}, current = {}) {
  const status = body.status !== undefined ? enumOrThrow(body.status, INSPECTION_STATUSES, "status") : current.status || "PLANNED";
  const resolveOne = async (raw, label, fallback) => {
    if (raw === undefined) return fallback;
    if (raw === null || raw === "") return null;
    return (await resolveObjectSubjectAsync(db, tenant, raw, label)).id;
  };
  const product = await resolveOne(body.product_object_id, "PRODUCT_REVISION", current.product_object_id ?? null);
  const operation = await resolveOne(body.operation_object_id, "OPERATION", current.operation_object_id ?? null);
  const component = await resolveOne(body.component_object_id, "component", current.component_object_id ?? null);
  const qualityIssueId = body.quality_issue_id !== undefined ? toIntOrNull(body.quality_issue_id) : current.quality_issue_id ?? null;
  if (qualityIssueId !== null) await requireIssueRowAsync(db, tenant, qualityIssueId);
  const sampleSize = body.sample_size !== undefined ? toIntOrNull(body.sample_size) : current.sample_size ?? null;
  const passed = body.passed_count !== undefined ? toIntOrNull(body.passed_count) : current.passed_count ?? null;
  const failed = body.failed_count !== undefined ? toIntOrNull(body.failed_count) : current.failed_count ?? null;
  if (sampleSize !== null && passed !== null && failed !== null && passed + failed > sampleSize) {
    throw invalidMq("passed_count + failed_count cannot exceed sample_size", { sample_size: sampleSize, passed_count: passed, failed_count: failed });
  }
  return {
    title: normalizeText(body.title ?? current.title, { max: 300 }),
    inspection_type: body.inspection_type !== undefined ? enumOrThrow(body.inspection_type, INSPECTION_TYPES, "inspection_type") : current.inspection_type || "INCOMING",
    requirement_text: normalizeText(body.requirement_text ?? current.requirement_text, { max: 4000 }),
    status,
    product_object_id: product,
    product_revision: normalizeText(body.product_revision ?? current.product_revision, { max: 60 }),
    operation_object_id: operation,
    component_object_id: component,
    characteristic_ref: normalizeText(body.characteristic_ref ?? current.characteristic_ref, { max: 120 }),
    quality_issue_id: qualityIssueId,
    performed_by: body.performed_by !== undefined ? toIntOrNull(body.performed_by) : current.performed_by ?? null,
    performed_at: body.performed_at !== undefined ? normalizeText(body.performed_at, { max: 40 }) || null : current.performed_at ?? null,
    sample_size: sampleSize,
    passed_count: passed,
    failed_count: failed,
    result_json: JSON.stringify(body.result !== undefined ? parseObject(body.result, {}) : parseObject(current.result_json, {})),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : parseObject(current.metadata_json, {})),
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
  };
}

export function createInspection(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeInspectionInput(db, tenant, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || inspectionRef(shortId());
  if (queryOne(db, "SELECT id FROM quality_inspections WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw inspectionConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO quality_inspections
       (inspection_ref, tenant_id, organization_id, code, title, inspection_type, requirement_text, status,
        product_object_id, product_revision, operation_object_id, component_object_id, characteristic_ref, quality_issue_id,
        performed_by, performed_at, sample_size, passed_count, failed_count, result_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      inspectionRef(providedCode),
      tenant,
      input.organization_id,
      providedCode,
      input.title,
      input.inspection_type,
      input.requirement_text,
      input.status,
      input.product_object_id,
      input.product_revision,
      input.operation_object_id,
      input.component_object_id,
      input.characteristic_ref,
      input.quality_issue_id,
      input.performed_by,
      input.performed_at,
      input.sample_size,
      input.passed_count,
      input.failed_count,
      input.result_json,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM quality_inspections WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "manufacturing-quality.inspection.create", resourceType: "quality_inspection", resourceId: row.inspection_ref, details: { code: row.code }, ip });
  if (TERMINAL_INSPECTION_STATUSES.includes(row.status)) {
    publishManufacturingQualityEvent(
      db,
      { eventType: "QualityInspectionRecorded", objectType: "quality_inspection", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { inspection_ref: row.inspection_ref, status: row.status } },
      actor
    );
  }
  return publicInspection(row);
}

export async function createInspectionAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = await normalizeInspectionInputAsync(db, tenant, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || inspectionRef(shortId());
  if (await queryOneAsync(db, "SELECT id FROM quality_inspections WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw inspectionConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO quality_inspections
       (inspection_ref, tenant_id, organization_id, code, title, inspection_type, requirement_text, status,
        product_object_id, product_revision, operation_object_id, component_object_id, characteristic_ref, quality_issue_id,
        performed_by, performed_at, sample_size, passed_count, failed_count, result_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      inspectionRef(providedCode),
      tenant,
      input.organization_id,
      providedCode,
      input.title,
      input.inspection_type,
      input.requirement_text,
      input.status,
      input.product_object_id,
      input.product_revision,
      input.operation_object_id,
      input.component_object_id,
      input.characteristic_ref,
      input.quality_issue_id,
      input.performed_by,
      input.performed_at,
      input.sample_size,
      input.passed_count,
      input.failed_count,
      input.result_json,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM quality_inspections WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.inspection.create", resourceType: "quality_inspection", resourceId: row.inspection_ref, details: { code: row.code }, ip });
  if (TERMINAL_INSPECTION_STATUSES.includes(row.status)) {
    await publishManufacturingQualityEventAsync(
      db,
      { eventType: "QualityInspectionRecorded", objectType: "quality_inspection", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { inspection_ref: row.inspection_ref, status: row.status } },
      actor
    );
  }
  return publicInspection(row);
}

// ── Corrective actions ───────────────────────────────────────────────────────

function actionFilters({ tenantId, status, quality_issue_id, action_type } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (action_type) {
    clauses.push("action_type = ?");
    params.push(normalizeUpper(action_type));
  }
  if (quality_issue_id) {
    clauses.push("quality_issue_id = ?");
    params.push(Number(quality_issue_id));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listCorrectiveActions(db, opts = {}) {
  const { where, params } = actionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_corrective_actions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM quality_corrective_actions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicAction), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listCorrectiveActionsAsync(db, opts = {}) {
  const { where, params } = actionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_corrective_actions ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM quality_corrective_actions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicAction), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getActionRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM quality_corrective_actions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM quality_corrective_actions WHERE tenant_id = ? AND (action_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getActionRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM quality_corrective_actions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM quality_corrective_actions WHERE tenant_id = ? AND (action_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function requireActionRow(db, tenantId, ref) {
  const row = getActionRow(db, tenantId, ref);
  if (!row) throw actionNotFound(ref);
  return row;
}

export async function requireActionRowAsync(db, tenantId, ref) {
  const row = await getActionRowAsync(db, tenantId, ref);
  if (!row) throw actionNotFound(ref);
  return row;
}

function normalizeActionInput(db, tenant, issueRow, body = {}, current = {}) {
  const actionType = body.action_type !== undefined ? enumOrThrow(body.action_type, ACTION_TYPES, "action_type") : current.action_type || "CORRECTIVE";
  const status = body.status !== undefined ? enumOrThrow(body.status, ACTION_STATUSES, "status") : current.status || "OPEN";
  const effectiveness = body.effectiveness !== undefined ? enumOrThrow(body.effectiveness, ACTION_EFFECTIVENESS, "effectiveness", { allowEmpty: true }) : current.effectiveness || "";
  if (status === "VERIFIED" && effectiveness !== "EFFECTIVE" && effectiveness !== "NOT_EFFECTIVE") {
    throw invalidTransition("A verified action requires an effectiveness of EFFECTIVE or NOT_EFFECTIVE", { status, effectiveness });
  }
  return {
    quality_issue_id: issueRow.id,
    title: normalizeText(body.title ?? current.title, { max: 300 }),
    description: normalizeText(body.description ?? current.description, { max: 8000 }),
    action_type: actionType,
    status,
    root_cause: normalizeText(body.root_cause ?? current.root_cause, { max: 8000 }),
    owner_user_id: body.owner_user_id !== undefined ? toIntOrNull(body.owner_user_id) : current.owner_user_id ?? null,
    due_at: body.due_at !== undefined ? normalizeText(body.due_at, { max: 40 }) || null : current.due_at ?? null,
    implemented_at: body.implemented_at !== undefined ? normalizeText(body.implemented_at, { max: 40 }) || null : current.implemented_at ?? null,
    verified_at: body.verified_at !== undefined ? normalizeText(body.verified_at, { max: 40 }) || null : current.verified_at ?? null,
    verified_by: body.verified_by !== undefined ? toIntOrNull(body.verified_by) : current.verified_by ?? null,
    effectiveness,
    evidence_json: JSON.stringify(body.evidence !== undefined ? parseArray(body.evidence, []) : parseArray(current.evidence_json, [])),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : parseObject(current.metadata_json, {})),
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
  };
}

export function createCorrectiveAction(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const issueRow = requireIssueRow(db, tenant, body.quality_issue_id ?? body.quality_issue_ref ?? body.issue_ref);
  const input = normalizeActionInput(db, tenant, issueRow, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || actionRef(shortId());
  if (queryOne(db, "SELECT id FROM quality_corrective_actions WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw actionConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO quality_corrective_actions
       (action_ref, tenant_id, organization_id, quality_issue_id, code, title, description, action_type, status, root_cause,
        owner_user_id, due_at, implemented_at, verified_at, verified_by, effectiveness, evidence_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      actionRef(providedCode),
      tenant,
      input.organization_id,
      issueRow.id,
      providedCode,
      input.title,
      input.description,
      input.action_type,
      input.status,
      input.root_cause,
      input.owner_user_id,
      input.due_at,
      input.implemented_at,
      input.verified_at,
      input.verified_by,
      input.effectiveness,
      input.evidence_json,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM quality_corrective_actions WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "manufacturing-quality.corrective-action.create", resourceType: "quality_corrective_action", resourceId: row.action_ref, details: { code: row.code, issue_ref: issueRow.issue_ref }, ip });
  publishManufacturingQualityEvent(
    db,
    { eventType: "CorrectiveActionChanged", objectType: "quality_corrective_action", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { action_ref: row.action_ref, status: row.status, issue_ref: issueRow.issue_ref } },
    actor
  );
  return publicAction(row);
}

export async function createCorrectiveActionAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const issueRow = await requireIssueRowAsync(db, tenant, body.quality_issue_id ?? body.quality_issue_ref ?? body.issue_ref);
  const input = normalizeActionInput(db, tenant, issueRow, body);
  if (!input.title) throw invalidMq("title is required");
  const providedCode = normalizeText(body.code, { max: 64 }) || actionRef(shortId());
  if (await queryOneAsync(db, "SELECT id FROM quality_corrective_actions WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, providedCode])) {
    throw actionConflict({ code: providedCode });
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO quality_corrective_actions
       (action_ref, tenant_id, organization_id, quality_issue_id, code, title, description, action_type, status, root_cause,
        owner_user_id, due_at, implemented_at, verified_at, verified_by, effectiveness, evidence_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      actionRef(providedCode),
      tenant,
      input.organization_id,
      issueRow.id,
      providedCode,
      input.title,
      input.description,
      input.action_type,
      input.status,
      input.root_cause,
      input.owner_user_id,
      input.due_at,
      input.implemented_at,
      input.verified_at,
      input.verified_by,
      input.effectiveness,
      input.evidence_json,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM quality_corrective_actions WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.corrective-action.create", resourceType: "quality_corrective_action", resourceId: row.action_ref, details: { code: row.code, issue_ref: issueRow.issue_ref }, ip });
  await publishManufacturingQualityEventAsync(
    db,
    { eventType: "CorrectiveActionChanged", objectType: "quality_corrective_action", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { action_ref: row.action_ref, status: row.status, issue_ref: issueRow.issue_ref } },
    actor
  );
  return publicAction(row);
}

export function updateCorrectiveAction(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireActionRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, actionConflict);
  const issueRow = requireIssueRow(db, tenant, row.quality_issue_id);
  const input = normalizeActionInput(db, tenant, issueRow, body, row);
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  updateRow(db, "quality_corrective_actions", row.id, patch, { columns: [...ACTION_COLUMNS, "version", "updated_by"] });
  const updated = queryOne(db, "SELECT * FROM quality_corrective_actions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "manufacturing-quality.corrective-action.update", resourceType: "quality_corrective_action", resourceId: updated.action_ref, details: { code: updated.code }, ip });
  if (updated.status !== row.status) {
    publishManufacturingQualityEvent(
      db,
      { eventType: "CorrectiveActionChanged", objectType: "quality_corrective_action", objectId: String(updated.id), tenantId: tenant, organizationId: updated.organization_id, payload: { action_ref: updated.action_ref, from: row.status, to: updated.status } },
      actor
    );
  }
  return publicAction(updated);
}

export async function updateCorrectiveActionAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireActionRowAsync(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, actionConflict);
  const issueRow = await requireIssueRowAsync(db, tenant, row.quality_issue_id);
  const input = normalizeActionInput(db, tenant, issueRow, body, row);
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  await updateRowAsync(db, "quality_corrective_actions", row.id, patch, { columns: [...ACTION_COLUMNS, "version", "updated_by"] });
  const updated = await queryOneAsync(db, "SELECT * FROM quality_corrective_actions WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.corrective-action.update", resourceType: "quality_corrective_action", resourceId: updated.action_ref, details: { code: updated.code }, ip });
  if (updated.status !== row.status) {
    await publishManufacturingQualityEventAsync(
      db,
      { eventType: "CorrectiveActionChanged", objectType: "quality_corrective_action", objectId: String(updated.id), tenantId: tenant, organizationId: updated.organization_id, payload: { action_ref: updated.action_ref, from: row.status, to: updated.status } },
      actor
    );
  }
  return publicAction(updated);
}

// ── Deterministic quality intelligence ───────────────────────────────────────
//
// These are pure rule-based assessments over authorised records. They never
// fabricate data: when the inputs needed for a determination are absent they
// report the gap explicitly (prompt §6.3).

function summariseIssues(issues) {
  const bySeverity = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const byStatus = {};
  const byType = {};
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
    byType[issue.issue_type] = (byType[issue.issue_type] || 0) + 1;
  }
  return { total: issues.length, by_severity: bySeverity, by_status: byStatus, by_type: byType };
}

export function productQualitySummary(db, tenantId, productObjectId, opts = {}) {
  const tenant = Number(tenantId);
  const productRow = resolveObjectSubject(db, tenant, productObjectId, "PRODUCT_REVISION");
  const issues = queryAll(db, "SELECT * FROM quality_issues WHERE tenant_id = ? AND product_object_id = ? ORDER BY id DESC LIMIT ?", [tenant, productRow.id, Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE)]);
  const inspections = queryAll(db, "SELECT * FROM quality_inspections WHERE tenant_id = ? AND product_object_id = ? ORDER BY id DESC LIMIT ?", [tenant, productRow.id, Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE)]);
  const openCritical = issues.filter((issue) => issue.severity === "CRITICAL" && ACTIVE_ISSUE_STATUSES.includes(issue.status));
  const openHigh = issues.filter((issue) => issue.severity === "HIGH" && ACTIVE_ISSUE_STATUSES.includes(issue.status));
  const failedInspections = inspections.filter((row) => row.status === "FAILED");
  const missingInspection = inspections.length === 0;
  return {
    source_module: SOURCE_MODULE,
    product_object_id: productRow.id,
    product_code: productRow.code,
    issue_summary: summariseIssues(issues),
    inspection_summary: { total: inspections.length, passed: inspections.filter((r) => r.status === "PASSED").length, failed: failedInspections.length, missing: missingInspection },
    open_critical_issues: openCritical.map(publicIssue),
    open_high_issues: openHigh.map(publicIssue),
    findings: {
      missing_inspection: missingInspection,
      has_open_critical: openCritical.length > 0,
      has_failed_inspection: failedInspections.length > 0,
    },
    limitations: missingInspection ? ["No inspections are recorded for this product; quality completeness cannot be assessed."] : [],
  };
}

export async function productQualitySummaryAsync(db, tenantId, productObjectId, opts = {}) {
  const tenant = Number(tenantId);
  const productRow = await resolveObjectSubjectAsync(db, tenant, productObjectId, "PRODUCT_REVISION");
  const limit = Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE);
  const issues = await queryAllAsync(db, "SELECT * FROM quality_issues WHERE tenant_id = ? AND product_object_id = ? ORDER BY id DESC LIMIT ?", [tenant, productRow.id, limit]);
  const inspections = await queryAllAsync(db, "SELECT * FROM quality_inspections WHERE tenant_id = ? AND product_object_id = ? ORDER BY id DESC LIMIT ?", [tenant, productRow.id, limit]);
  const openCritical = issues.filter((issue) => issue.severity === "CRITICAL" && ACTIVE_ISSUE_STATUSES.includes(issue.status));
  const openHigh = issues.filter((issue) => issue.severity === "HIGH" && ACTIVE_ISSUE_STATUSES.includes(issue.status));
  const failedInspections = inspections.filter((row) => row.status === "FAILED");
  const missingInspection = inspections.length === 0;
  return {
    source_module: SOURCE_MODULE,
    product_object_id: productRow.id,
    product_code: productRow.code,
    issue_summary: summariseIssues(issues),
    inspection_summary: { total: inspections.length, passed: inspections.filter((r) => r.status === "PASSED").length, failed: failedInspections.length, missing: missingInspection },
    open_critical_issues: openCritical.map(publicIssue),
    open_high_issues: openHigh.map(publicIssue),
    findings: { missing_inspection: missingInspection, has_open_critical: openCritical.length > 0, has_failed_inspection: failedInspections.length > 0 },
    limitations: missingInspection ? ["No inspections are recorded for this product; quality completeness cannot be assessed."] : [],
  };
}

// Detect recurring issues within a rolling window using deterministic grouping
// on (product, component, operation, issue_type). Only observable repetition is
// reported; no causality is inferred (prompt §6.3).
export function detectRecurrence(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const windowDays = Number(opts.windowDays ?? getConfig(db, tenant, "recurrence_window_days")) || 90;
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const rows = queryAll(
    db,
    `SELECT product_object_id, component_object_id, operation_object_id, issue_type, severity, COUNT(*) AS occurrences
       FROM quality_issues
      WHERE tenant_id = ? AND created_at >= ?
      GROUP BY product_object_id, component_object_id, operation_object_id, issue_type, severity
     HAVING COUNT(*) > 1
      ORDER BY occurrences DESC
      LIMIT ?`,
    [tenant, cutoff, Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE)]
  );
  return {
    source_module: SOURCE_MODULE,
    window_days: windowDays,
    patterns: rows.map((row) => ({
      product_object_id: row.product_object_id ?? null,
      component_object_id: row.component_object_id ?? null,
      operation_object_id: row.operation_object_id ?? null,
      issue_type: row.issue_type,
      severity: row.severity,
      occurrences: Number(row.occurrences),
    })),
    limitations: ["Recurrence is based on observed record counts within the window; it does not establish causation."],
  };
}

export async function detectRecurrenceAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const windowDays = Number(opts.windowDays ?? (await getConfigAsync(db, tenant, "recurrence_window_days"))) || 90;
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await queryAllAsync(
    db,
    `SELECT product_object_id, component_object_id, operation_object_id, issue_type, severity, COUNT(*) AS occurrences
       FROM quality_issues
      WHERE tenant_id = ? AND created_at >= ?
      GROUP BY product_object_id, component_object_id, operation_object_id, issue_type, severity
     HAVING COUNT(*) > 1
      ORDER BY occurrences DESC
      LIMIT ?`,
    [tenant, cutoff, Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE)]
  );
  return {
    source_module: SOURCE_MODULE,
    window_days: windowDays,
    patterns: rows.map((row) => ({
      product_object_id: row.product_object_id ?? null,
      component_object_id: row.component_object_id ?? null,
      operation_object_id: row.operation_object_id ?? null,
      issue_type: row.issue_type,
      severity: row.severity,
      occurrences: Number(row.occurrences),
    })),
    limitations: ["Recurrence is based on observed record counts within the window; it does not establish causation."],
  };
}

// Detect quality issues that reference operations but have no inspection, and
// issues without any corrective action. Reported as explicit gaps.
export function detectQualityGaps(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const limit = Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE);
  const issuesWithoutInspection = queryAll(
    db,
    `SELECT i.* FROM quality_issues i
      WHERE i.tenant_id = ? AND i.operation_object_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM quality_inspections q WHERE q.tenant_id = i.tenant_id AND q.quality_issue_id = i.id)
      ORDER BY i.id DESC LIMIT ?`,
    [tenant, limit]
  );
  const issuesWithoutAction = queryAll(
    db,
    `SELECT i.* FROM quality_issues i
      WHERE i.tenant_id = ? AND i.status IN ('OPEN','INVESTIGATING','CONTAINED')
        AND NOT EXISTS (SELECT 1 FROM quality_corrective_actions a WHERE a.tenant_id = i.tenant_id AND a.quality_issue_id = i.id)
      ORDER BY i.id DESC LIMIT ?`,
    [tenant, limit]
  );
  return {
    source_module: SOURCE_MODULE,
    issues_without_inspection: issuesWithoutInspection.map(publicIssue),
    issues_without_corrective_action: issuesWithoutAction.map(publicIssue),
    counts: { issues_without_inspection: issuesWithoutInspection.length, issues_without_corrective_action: issuesWithoutAction.length },
  };
}

export async function detectQualityGapsAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const limit = Math.min(MAX_PAGE_SIZE, Number(opts.limit) || DEFAULT_PAGE_SIZE);
  const issuesWithoutInspection = await queryAllAsync(
    db,
    `SELECT i.* FROM quality_issues i
      WHERE i.tenant_id = ? AND i.operation_object_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM quality_inspections q WHERE q.tenant_id = i.tenant_id AND q.quality_issue_id = i.id)
      ORDER BY i.id DESC LIMIT ?`,
    [tenant, limit]
  );
  const issuesWithoutAction = await queryAllAsync(
    db,
    `SELECT i.* FROM quality_issues i
      WHERE i.tenant_id = ? AND i.status IN ('OPEN','INVESTIGATING','CONTAINED')
        AND NOT EXISTS (SELECT 1 FROM quality_corrective_actions a WHERE a.tenant_id = i.tenant_id AND a.quality_issue_id = i.id)
      ORDER BY i.id DESC LIMIT ?`,
    [tenant, limit]
  );
  return {
    source_module: SOURCE_MODULE,
    issues_without_inspection: issuesWithoutInspection.map(publicIssue),
    issues_without_corrective_action: issuesWithoutAction.map(publicIssue),
    counts: { issues_without_inspection: issuesWithoutInspection.length, issues_without_corrective_action: issuesWithoutAction.length },
  };
}

export function issueMetrics(db, tenantId) {
  const tenant = Number(tenantId);
  const byStatus = queryAll(db, "SELECT status, COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? GROUP BY status", [tenant]);
  const bySeverity = queryAll(db, "SELECT severity, COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? GROUP BY severity", [tenant]);
  const openActions = queryOne(db, "SELECT COUNT(*) AS c FROM quality_corrective_actions WHERE tenant_id = ? AND status IN ('OPEN','IN_PROGRESS')", [tenant]);
  const failedInspections = queryOne(db, "SELECT COUNT(*) AS c FROM quality_inspections WHERE tenant_id = ? AND status = 'FAILED'", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    issues_by_status: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.c)])),
    issues_by_severity: Object.fromEntries(bySeverity.map((row) => [row.severity, Number(row.c)])),
    open_corrective_actions: Number(openActions?.c || 0),
    failed_inspections: Number(failedInspections?.c || 0),
  };
}

export async function issueMetricsAsync(db, tenantId) {
  const tenant = Number(tenantId);
  const byStatus = await queryAllAsync(db, "SELECT status, COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? GROUP BY status", [tenant]);
  const bySeverity = await queryAllAsync(db, "SELECT severity, COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? GROUP BY severity", [tenant]);
  const openActions = await queryOneAsync(db, "SELECT COUNT(*) AS c FROM quality_corrective_actions WHERE tenant_id = ? AND status IN ('OPEN','IN_PROGRESS')", [tenant]);
  const failedInspections = await queryOneAsync(db, "SELECT COUNT(*) AS c FROM quality_inspections WHERE tenant_id = ? AND status = 'FAILED'", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    issues_by_status: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.c)])),
    issues_by_severity: Object.fromEntries(bySeverity.map((row) => [row.severity, Number(row.c)])),
    open_corrective_actions: Number(openActions?.c || 0),
    failed_inspections: Number(failedInspections?.c || 0),
  };
}
