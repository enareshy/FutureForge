// Prediction use-case registry.
//
// A use case is data, not code: it carries the problem type, the method that
// currently backs it, the ruleset/model version and the feature schema. The
// built-in deterministic assessments are registered on first use so every
// prediction can point at a versioned, inspectable use case (prompt §7.1/§7.3).
import { queryAll, queryOne, run } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import {
  BUILT_IN_USE_CASES,
  METHODS,
  METHOD_VALUES,
  PROBLEM_TYPES,
  USE_CASE_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SOURCE_MODULE,
} from "./constants.js";
import { useCaseNotFound, useCaseConflict, invalidPredictive, unsupportedMethod } from "./errors.js";

const USE_CASE_COLUMNS = ["name", "description", "method", "problem_type", "feature_schema_json", "min_data_volume", "ruleset_version", "status", "metadata_json"];

export function publicUseCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    method: row.method,
    method_label: row.method,
    problem_type: row.problem_type,
    feature_schema: parseObject(row.feature_schema_json, {}),
    min_data_volume: Number(row.min_data_volume || 0),
    ruleset_version: row.ruleset_version,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function enumOrThrow(value, allowed, label) {
  const normalized = normalizeUpper(value, { max: 40 });
  if (!allowed.includes(normalized)) throw invalidPredictive(`Invalid ${label}: ${normalized}`, { allowed: [...allowed] });
  return normalized;
}

function problemTypeOrThrow(value) {
  const normalized = normalizeText(value, { max: 40 }).toLowerCase();
  if (!PROBLEM_TYPES.includes(normalized)) throw invalidPredictive(`Invalid problem_type: ${normalized}`, { allowed: [...PROBLEM_TYPES] });
  return normalized;
}

function normalizeUseCaseInput(body = {}, current = {}) {
  const method = body.method !== undefined ? enumOrThrow(body.method, METHOD_VALUES, "method") : current.method ?? METHODS.RULE_BASED;
  if (!METHOD_VALUES.includes(method)) throw unsupportedMethod(`Unsupported method: ${method}`, { allowed: [...METHOD_VALUES] });
  const problemType = body.problem_type !== undefined ? problemTypeOrThrow(body.problem_type) : current.problem_type ?? "classification";
  const status = body.status !== undefined ? enumOrThrow(body.status, USE_CASE_STATUSES, "status") : current.status ?? "ACTIVE";
  const featureSchema = body.feature_schema !== undefined
    ? JSON.stringify(parseObject(body.feature_schema, {}))
    : body.feature_schema_json !== undefined
      ? JSON.stringify(parseObject(body.feature_schema_json, {}))
      : current.feature_schema_json ?? "{}";
  return {
    name: normalizeText(body.name ?? current.name ?? "", { max: 200 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    method,
    problem_type: problemType,
    feature_schema_json: featureSchema,
    min_data_volume: body.min_data_volume !== undefined ? Math.max(0, Number(body.min_data_volume) || 0) : Number(current.min_data_volume || 0),
    ruleset_version: normalizeText(body.ruleset_version ?? current.ruleset_version ?? "v1", { max: 60 }),
    status,
    metadata_json: body.metadata !== undefined ? JSON.stringify(parseObject(body.metadata, {})) : current.metadata_json ?? "{}",
  };
}

export function getUseCaseRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM pred_use_cases WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM pred_use_cases WHERE tenant_id = ? AND upper(code) = upper(?)", [Number(tenantId), String(ref)]);
}

export async function getUseCaseRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM pred_use_cases WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM pred_use_cases WHERE tenant_id = ? AND upper(code) = upper(?)", [Number(tenantId), String(ref)]);
}

export function requireUseCaseRow(db, tenantId, ref) {
  const row = getUseCaseRow(db, tenantId, ref);
  if (!row) throw useCaseNotFound(ref);
  return row;
}

export async function requireUseCaseRowAsync(db, tenantId, ref) {
  const row = await getUseCaseRowAsync(db, tenantId, ref);
  if (!row) throw useCaseNotFound(ref);
  return row;
}

export function getUseCase(db, tenantId, ref) {
  return publicUseCase(getUseCaseRow(db, tenantId, ref));
}

export async function getUseCaseAsync(db, tenantId, ref) {
  return publicUseCase(await getUseCaseRowAsync(db, tenantId, ref));
}

function useCaseFilters({ tenantId, status, method, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (method) {
    clauses.push("method = ?");
    params.push(normalizeUpper(method));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ? OR description ILIKE ?)");
    params.push(like, like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listUseCases(db, opts = {}) {
  const { where, params } = useCaseFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pred_use_cases ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pred_use_cases ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicUseCase), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listUseCasesAsync(db, opts = {}) {
  const { where, params } = useCaseFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM pred_use_cases ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM pred_use_cases ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicUseCase), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function createUseCase(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code, { max: 64 });
  if (!code) throw invalidPredictive("code is required");
  if (getUseCaseRow(db, tenant, code)) throw useCaseConflict({ code });
  const input = normalizeUseCaseInput(body);
  const result = run(
    db,
    `INSERT INTO pred_use_cases
       (tenant_id, code, name, description, method, problem_type, feature_schema_json, min_data_volume, ruleset_version, status, metadata_json, version, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [tenant, code, input.name || code, input.description, input.method, input.problem_type, input.feature_schema_json, input.min_data_volume, input.ruleset_version, input.status, input.metadata_json, actor?.id ?? null, actor?.id ?? null]
  );
  const row = queryOne(db, "SELECT * FROM pred_use_cases WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "predictive.use-case.create", resourceType: "pred_use_case", resourceId: row.code, details: { method: row.method }, ip });
  return publicUseCase(row);
}

export async function createUseCaseAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code, { max: 64 });
  if (!code) throw invalidPredictive("code is required");
  if (await getUseCaseRowAsync(db, tenant, code)) throw useCaseConflict({ code });
  const input = normalizeUseCaseInput(body);
  const result = await runAsync(
    db,
    `INSERT INTO pred_use_cases
       (tenant_id, code, name, description, method, problem_type, feature_schema_json, min_data_volume, ruleset_version, status, metadata_json, version, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [tenant, code, input.name || code, input.description, input.method, input.problem_type, input.feature_schema_json, input.min_data_volume, input.ruleset_version, input.status, input.metadata_json, actor?.id ?? null, actor?.id ?? null]
  );
  const row = await queryOneAsync(db, "SELECT * FROM pred_use_cases WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "predictive.use-case.create", resourceType: "pred_use_case", resourceId: row.code, details: { method: row.method }, ip });
  return publicUseCase(row);
}

export function updateUseCase(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireUseCaseRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, useCaseConflict);
  const input = normalizeUseCaseInput(body, row);
  updateRow(db, "pred_use_cases", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: [...USE_CASE_COLUMNS, "version", "updated_by"] });
  const updated = queryOne(db, "SELECT * FROM pred_use_cases WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "predictive.use-case.update", resourceType: "pred_use_case", resourceId: updated.code, details: { status: updated.status, method: updated.method }, ip });
  return publicUseCase(updated);
}

export async function updateUseCaseAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireUseCaseRowAsync(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, useCaseConflict);
  const input = normalizeUseCaseInput(body, row);
  await updateRowAsync(db, "pred_use_cases", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: [...USE_CASE_COLUMNS, "version", "updated_by"] });
  const updated = await queryOneAsync(db, "SELECT * FROM pred_use_cases WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "predictive.use-case.update", resourceType: "pred_use_case", resourceId: updated.code, details: { status: updated.status, method: updated.method }, ip });
  return publicUseCase(updated);
}

// Registers the built-in deterministic use cases for a tenant. Idempotent: an
// existing code is left untouched so operator edits are preserved.
export function ensureBuiltInUseCases(db, tenantId, actor = null) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const entry of BUILT_IN_USE_CASES) {
    if (getUseCaseRow(db, tenant, entry.code)) continue;
    createUseCase(
      db,
      tenant,
      {
        code: entry.code,
        name: entry.name,
        description: entry.description,
        method: entry.method,
        problem_type: entry.problem_type,
        ruleset_version: entry.ruleset_version,
        feature_schema_json: entry.feature_schema_json,
        min_data_volume: entry.min_data_volume,
      },
      actor
    );
    created += 1;
  }
  return { created };
}

export async function ensureBuiltInUseCasesAsync(db, tenantId, actor = null) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const entry of BUILT_IN_USE_CASES) {
    if (await getUseCaseRowAsync(db, tenant, entry.code)) continue;
    await createUseCaseAsync(
      db,
      tenant,
      {
        code: entry.code,
        name: entry.name,
        description: entry.description,
        method: entry.method,
        problem_type: entry.problem_type,
        ruleset_version: entry.ruleset_version,
        feature_schema_json: entry.feature_schema_json,
        min_data_volume: entry.min_data_volume,
      },
      actor
    );
    created += 1;
  }
  return { created };
}

// Global (cross-tenant) built-in catalog, used by the /meta vocabulary route.
export function builtInCatalog() {
  return BUILT_IN_USE_CASES.map((entry) => ({
    code: entry.code,
    name: entry.name,
    description: entry.description,
    method: entry.method,
    problem_type: entry.problem_type,
    ruleset_version: entry.ruleset_version,
    min_data_volume: entry.min_data_volume,
  }));
}
