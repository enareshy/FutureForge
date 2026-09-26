// Exchange Transformation profiles (§8).
//
// A transformation profile is a versioned list of declarative steps. Execution
// delegates to the Import & Export Framework transformation engine; this module
// owns identity, versioning, lifecycle, validation and record/document apply.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { transformationRef } from "./identifiers.js";
import { transformationEngine } from "./engine-ref.js";
import { DEFINITION_STATUSES, DIRECTIONS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { publicTransformation, publicTransformationVersion, toJson, parseJson } from "./repository.js";
import { transformationNotFound, transformationConflict, invalidTransformation, transformationImmutable } from "./errors.js";
import { normalizeUpper } from "../data-exchange/validation.js";

const { applyTransformations, transformationTypes } = transformationEngine();

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function getTransformationRow(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const raw = String(ref ?? "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = queryOne(db, "SELECT * FROM exchange_transformations WHERE id = ? AND tenant_id = ?", [Number(raw), tenant]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM exchange_transformations WHERE tenant_id = ? AND (transformation_ref = ? OR code = ? COLLATE NOCASE)", [tenant, raw, raw]);
}

export function requireTransformationRow(db, tenantId, ref) {
  const row = getTransformationRow(db, tenantId, ref);
  if (!row) throw transformationNotFound(ref);
  return row;
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) throw invalidTransformation("Transformation steps must be an array");
  return steps.map((step, index) => ({
    sequence: step.sequence ?? (index + 1) * 10,
    stage: normalizeUpper(step.stage || "FIELD"),
    target_field: step.target_field || step.targetField || "",
    transformation_type: normalizeUpper(step.transformation_type || step.transformationType || step.type || ""),
    config: step.config || step.config_json || {},
    status: step.status || "active",
  }));
}

function assertKnownSteps(steps) {
  const known = new Set(transformationTypes());
  const errors = [];
  for (const step of steps) {
    if (!step.transformation_type) errors.push({ code: "missing_type", message: "A transformation step requires transformation_type" });
    else if (!known.has(step.transformation_type)) errors.push({ code: "unknown_type", message: `Unknown transformation type: ${step.transformation_type}` });
  }
  if (errors.length) throw invalidTransformation("Invalid transformation steps", { errors, known_types: [...known] });
}

function normalizeTransformationInput(body = {}, current = {}) {
  const code = normalizeUpper(body.code || current.code || "", { max: 120 });
  if (!code) throw invalidTransformation("A transformation code is required");
  const direction = normalizeUpper(body.direction || current.direction || "IMPORT");
  if (!DIRECTIONS.includes(direction)) throw invalidTransformation(`Unsupported direction: ${body.direction}`);
  const status = normalizeUpper(body.status || current.status || "DRAFT");
  if (!DEFINITION_STATUSES.includes(status)) throw invalidTransformation(`Unsupported status: ${body.status}`);
  return {
    code,
    name: String(body.name || current.name || code).trim(),
    description: String(body.description ?? current.description ?? "").trim(),
    direction,
    stage: normalizeUpper(body.stage || current.stage || "FIELD"),
    steps: body.steps !== undefined ? normalizeSteps(body.steps) : parseJson(current.steps_json, []),
    status,
    metadata: body.metadata || parseJson(current.metadata_json, {}),
  };
}

function insertTransformationVersion(db, tenantId, row, { changeSummary, actor }) {
  const existing = queryOne(db, "SELECT id FROM exchange_transformation_versions WHERE transformation_id = ? AND version = ?", [row.id, row.version]);
  if (existing) return;
  run(
    db,
    `INSERT INTO exchange_transformation_versions (transformation_id, tenant_id, version, status, steps_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, tenantId, row.version, row.status, row.steps_json, changeSummary, actor?.id ?? null, nowIso()]
  );
}

export function createTransformation(db, tenantId, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const input = normalizeTransformationInput(body);
  assertKnownSteps(input.steps);
  const existing = queryOne(db, "SELECT id FROM exchange_transformations WHERE tenant_id = ? AND code = ?", [tenant, input.code]);
  if (existing) throw transformationConflict(input.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_transformations
       (transformation_ref, tenant_id, code, name, description, direction, stage, steps_json, version, status, immutable, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    [transformationRef(input.code), tenant, input.code, input.name, input.description, input.direction, input.stage, toJson(input.steps, []), input.status, toJson(input.metadata, {}), actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM exchange_transformations WHERE id = ?", [Number(result.lastInsertRowid)]);
  insertTransformationVersion(db, tenant, row, { changeSummary: "Initial version", actor });
  return publicTransformation(row);
}

export function updateTransformation(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireTransformationRow(db, tenant, ref);
  const wasImmutable = Boolean(row.immutable);
  if (wasImmutable) insertTransformationVersion(db, tenant, row, { changeSummary: body.change_summary || "Superseded", actor });
  const input = normalizeTransformationInput(body, row);
  assertKnownSteps(input.steps);
  run(
    db,
    `UPDATE exchange_transformations SET name=?, description=?, direction=?, stage=?, steps_json=?, status=?, metadata_json=?,
       version=version+${wasImmutable ? 1 : 0}, immutable=0, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
    [input.name, input.description, input.direction, input.stage, toJson(input.steps, []), input.status, toJson(input.metadata, {}), actor?.id ?? null, nowIso(), row.id, tenant]
  );
  const updated = queryOne(db, "SELECT * FROM exchange_transformations WHERE id = ?", [row.id]);
  if (wasImmutable) insertTransformationVersion(db, tenant, updated, { changeSummary: body.change_summary || "New version", actor });
  return publicTransformation(updated);
}

export function publishTransformation(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireTransformationRow(db, tenant, ref);
  insertTransformationVersion(db, tenant, row, { changeSummary: body.change_summary || "Published", actor });
  run(db, "UPDATE exchange_transformations SET status='ACTIVE', immutable=1, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicTransformation(queryOne(db, "SELECT * FROM exchange_transformations WHERE id = ?", [row.id]));
}

export function setTransformationStatus(db, tenantId, ref, status, actor = null) {
  const tenant = Number(tenantId);
  const row = requireTransformationRow(db, tenant, ref);
  const next = normalizeUpper(status);
  if (!DEFINITION_STATUSES.includes(next)) throw invalidTransformation(`Unsupported status: ${status}`);
  run(db, "UPDATE exchange_transformations SET status=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [next, actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicTransformation(queryOne(db, "SELECT * FROM exchange_transformations WHERE id = ?", [row.id]));
}

export function deleteTransformation(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireTransformationRow(db, tenant, ref);
  if (row.immutable) throw transformationImmutable(row.code, row.version);
  run(db, "DELETE FROM exchange_transformations WHERE id = ? AND tenant_id = ?", [row.id, tenant]);
  return { deleted: true, ref: row.transformation_ref };
}

export function listTransformations(db, tenantId, query = {}) {
  const tenant = Number(tenantId);
  const { page, pageSize, offset } = pageArgs(query);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(query.status));
  }
  if (query.direction) {
    clauses.push("(direction = ? OR direction = 'BOTH')");
    params.push(normalizeUpper(query.direction));
  }
  if (query.q) {
    clauses.push("(code LIKE ? OR name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_transformations WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_transformations WHERE ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicTransformation), total, page, pageSize };
}

export function getTransformation(db, tenantId, ref) {
  const row = requireTransformationRow(db, tenantId, ref);
  const output = publicTransformation(row);
  output.versions = listTransformationVersions(db, tenantId, row.id).items;
  return output;
}

export function listTransformationVersions(db, tenantId, ref) {
  const row = requireTransformationRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM exchange_transformation_versions WHERE transformation_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicTransformationVersion), total: rows.length };
}

export function validateTransformation(db, tenantId, ref) {
  const row = requireTransformationRow(db, tenantId, ref);
  const steps = parseJson(row.steps_json, []);
  const known = new Set(transformationTypes());
  const errors = [];
  for (const step of steps) {
    if (!known.has(step.transformation_type)) errors.push({ code: "unknown_type", message: `Unknown transformation type: ${step.transformation_type}`, step: step.sequence });
  }
  return { transformation: publicTransformation(row), valid: errors.length === 0, errors, known_types: [...known] };
}

export function resolveTransformation(db, tenantId, code) {
  if (!code) return null;
  const row = getTransformationRow(db, tenantId, code);
  return row ? publicTransformation(row) : null;
}

// Applies profile steps to a single record (FIELD and RECORD stages).
export function applyTransformationProfile(db, tenantId, ref, record, ctx = {}) {
  const row = ref ? requireTransformationRow(db, tenantId, ref) : null;
  if (!row) return { transformation: null, target: record, errors: [], warnings: [] };
  const steps = parseJson(row.steps_json, []).filter((step) => step.status !== "inactive");
  if (row.stage === "FIELD" || steps.every((step) => normalizeUpper(step.stage) === "FIELD")) {
    const target = { ...record };
    const errors = [];
    for (const step of steps) {
      if (normalizeUpper(step.stage) !== "FIELD" || !step.target_field) continue;
      try {
        const field = step.target_field;
        const current = step.target_field.split(".").reduce((value, key) => (value == null ? undefined : value[key]), target);
        const next = applyTransformations([{ transformation_type: step.transformation_type, config: step.config }], current, { record: target, context: ctx.context });
        setDeep(target, field, next);
      } catch (error) {
        errors.push({ code: error.code || "transformation_error", field: step.target_field, message: error.message });
      }
    }
    return { transformation: publicTransformation(row), target, errors, warnings: [] };
  }
  return { transformation: publicTransformation(row), target: record, errors: [], warnings: [] };
}

function setDeep(object, path, value) {
  const segments = String(path).split(".");
  let cursor = object;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (cursor[segments[index]] === null || typeof cursor[segments[index]] !== "object") cursor[segments[index]] = {};
    cursor = cursor[segments[index]];
  }
  cursor[segments[segments.length - 1]] = value;
  return object;
}
