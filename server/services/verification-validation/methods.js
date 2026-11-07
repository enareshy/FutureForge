// Verification / validation method registry.
//
// Methods are configuration data (never hard-coded): each declares whether it is
// a verification and/or validation method and its method type
// (TEST/INSPECTION/ANALYSIS/DEMONSTRATION/MEASUREMENT/SIMULATION). Global methods
// (tenant_id NULL) are seeded once; tenants may add their own.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { updateRow, updateRowAsync } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate } from "../data-lifecycle/validation.js";
import { DEFAULT_METHODS, METHOD_TYPES, VERIFICATION_KINDS, SOURCE_MODULE } from "./constants.js";
import { invalidVv, methodNotFound } from "./errors.js";

export function publicMethod(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    verification_kind: row.verification_kind,
    method_type: row.method_type,
    requires_evidence: Boolean(row.requires_evidence),
    sequence: Number(row.sequence || 0),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeMethodInput(body = {}, current = {}) {
  const verificationKind = normalizeUpper(body.verification_kind ?? body.verificationKind ?? current.verification_kind ?? "BOTH");
  if (!VERIFICATION_KINDS.includes(verificationKind) && verificationKind !== "BOTH") {
    throw invalidVv(`Invalid verification_kind: ${verificationKind}`, { allowed: [...VERIFICATION_KINDS, "BOTH"] });
  }
  const methodType = normalizeUpper(body.method_type ?? body.methodType ?? current.method_type ?? "TEST");
  if (!METHOD_TYPES.includes(methodType)) {
    throw invalidVv(`Invalid method_type: ${methodType}`, { allowed: [...METHOD_TYPES] });
  }
  return {
    code: normalizeUpper(body.code ?? current.code, { max: 64 }),
    name: normalizeText(body.name ?? current.name, { max: 200 }),
    description: normalizeText(body.description ?? current.description, { max: 2000 }),
    verification_kind: verificationKind,
    method_type: methodType,
    requires_evidence: body.requires_evidence ?? body.requiresEvidence ?? current.requires_evidence ?? 1,
    sequence: Number(body.sequence ?? current.sequence ?? 0),
    status: normalizeUpper(body.status ?? current.status ?? "ACTIVE"),
  };
}

export function methodFilters({ tenantId, status, verification_kind, q } = {}) {
  const clauses = ["(tenant_id IS NULL OR tenant_id = ?)"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (verification_kind) {
    const kind = normalizeUpper(verification_kind);
    clauses.push("(verification_kind = ? OR verification_kind = 'BOTH')");
    params.push(kind);
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listMethods(db, opts = {}) {
  const { where, params } = methodFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_methods ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_methods ${where} ORDER BY sequence, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicMethod), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listMethodsAsync(db, opts = {}) {
  const { where, params } = methodFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_methods ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_methods ${where} ORDER BY sequence, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicMethod), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getMethodRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM vv_methods WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?)", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM vv_methods WHERE (tenant_id IS NULL OR tenant_id = ?) AND lower(code) = lower(?) ORDER BY tenant_id NULLS LAST LIMIT 1", [Number(tenantId), String(ref)]);
}

export async function getMethodRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_methods WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?)", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_methods WHERE (tenant_id IS NULL OR tenant_id = ?) AND lower(code) = lower(?) ORDER BY tenant_id NULLS LAST LIMIT 1", [Number(tenantId), String(ref)]);
}

export function getMethod(db, tenantId, ref) {
  return publicMethod(getMethodRow(db, tenantId, ref));
}

export async function getMethodAsync(db, tenantId, ref) {
  return publicMethod(await getMethodRowAsync(db, tenantId, ref));
}

export function requireMethodRow(db, tenantId, ref) {
  const row = getMethodRow(db, tenantId, ref);
  if (!row) throw methodNotFound(ref);
  return row;
}

export async function requireMethodRowAsync(db, tenantId, ref) {
  const row = await getMethodRowAsync(db, tenantId, ref);
  if (!row) throw methodNotFound(ref);
  return row;
}

export function createMethod(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeMethodInput(body);
  if (!input.code) throw invalidVv("code is required");
  if (!input.name) throw invalidVv("name is required");
  if (queryOne(db, "SELECT id FROM vv_methods WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, input.code])) {
    throw invalidVv(`Method already exists: ${input.code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO vv_methods
       (tenant_id, code, name, description, verification_kind, method_type, requires_evidence, sequence, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, input.code, input.name, input.description, input.verification_kind, input.method_type, input.requires_evidence ? 1 : 0, input.sequence, input.status, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM vv_methods WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.method.create", resourceType: "vv_method", resourceId: row.code, details: { method_type: row.method_type }, ip });
  return publicMethod(row);
}

export async function createMethodAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeMethodInput(body);
  if (!input.code) throw invalidVv("code is required");
  if (!input.name) throw invalidVv("name is required");
  if (await queryOneAsync(db, "SELECT id FROM vv_methods WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, input.code])) {
    throw invalidVv(`Method already exists: ${input.code}`);
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO vv_methods
       (tenant_id, code, name, description, verification_kind, method_type, requires_evidence, sequence, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, input.code, input.name, input.description, input.verification_kind, input.method_type, input.requires_evidence ? 1 : 0, input.sequence, input.status, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_methods WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.method.create", resourceType: "vv_method", resourceId: row.code, details: { method_type: row.method_type }, ip });
  return publicMethod(row);
}

export function updateMethod(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireMethodRow(db, tenantId, ref);
  if (row.tenant_id == null) throw invalidVv("Global methods are managed by the platform");
  const input = normalizeMethodInput(body, row);
  updateRow(db, "vv_methods", row.id, { ...input, code: row.code, updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "verification-validation.method.update", resourceType: "vv_method", resourceId: row.code, details: {}, ip });
  return publicMethod(queryOne(db, "SELECT * FROM vv_methods WHERE id = ?", [row.id]));
}

export async function updateMethodAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = await requireMethodRowAsync(db, tenantId, ref);
  if (row.tenant_id == null) throw invalidVv("Global methods are managed by the platform");
  const input = normalizeMethodInput(body, row);
  await updateRowAsync(db, "vv_methods", row.id, { ...input, code: row.code, updated_by: actor?.id ?? null });
  await writeAuditAsync(db, { actor, action: "verification-validation.method.update", resourceType: "vv_method", resourceId: row.code, details: {}, ip });
  return publicMethod(await queryOneAsync(db, "SELECT * FROM vv_methods WHERE id = ?", [row.id]));
}

// Seed the default global methods (tenant_id NULL). Idempotent.
export function ensureVvMethods(db) {
  let created = 0;
  const ts = nowIso();
  for (const method of DEFAULT_METHODS) {
    if (queryOne(db, "SELECT id FROM vv_methods WHERE tenant_id IS NULL AND code = ?", [method.code])) continue;
    run(
      db,
      `INSERT INTO vv_methods
         (tenant_id, code, name, description, verification_kind, method_type, requires_evidence, sequence, status, version, created_at, updated_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
      [method.code, method.name, method.description, method.verification_kind, method.method_type, method.requires_evidence ? 1 : 0, method.sequence, ts, ts]
    );
    created += 1;
  }
  return { created };
}

export async function ensureVvMethodsAsync(db) {
  let created = 0;
  const ts = nowIso();
  for (const method of DEFAULT_METHODS) {
    if (await queryOneAsync(db, "SELECT id FROM vv_methods WHERE tenant_id IS NULL AND code = ?", [method.code])) continue;
    await runAsync(
      db,
      `INSERT INTO vv_methods
         (tenant_id, code, name, description, verification_kind, method_type, requires_evidence, sequence, status, version, created_at, updated_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
      [method.code, method.name, method.description, method.verification_kind, method.method_type, method.requires_evidence ? 1 : 0, method.sequence, ts, ts]
    );
    created += 1;
  }
  return { created };
}
