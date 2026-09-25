// Exchange Validation Framework (§9).
//
// Three levels are evaluated and merged:
//   FILE       - payload present, size limits, encoding, type/extension match
//   STANDARDS  - adapter + registered schema validation
//   ENTERPRISE - declarative rules (reusing the I&E validation-rule engine),
//                object-type/UOM/classification/lifecycle/relationship checks
//                resolved through injected platform checkers.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { validationProfileRef } from "./identifiers.js";
import { validationEngine } from "./engine-ref.js";
import { getAdapter } from "./adapters/index.js";
import { DEFINITION_STATUSES, VALIDATION_LEVELS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, MAX_PAYLOAD_BYTES } from "./constants.js";
import { publicValidationProfile, publicValidationRule, toJson, parseJson } from "./repository.js";
import { validationProfileNotFound, validationProfileConflict, invalidValidationProfile } from "./errors.js";
import { finding, summarizeValidation, mergeValidationResults } from "./validation-result.js";
import { byteLength } from "./parsing.js";
import { normalizeUpper } from "../data-exchange/validation.js";

const { evaluateRules, validateRule, registerValidation, validationTypes } = validationEngine();

let handlersRegistered = false;

// Extends the shared validation engine with enterprise checks. Registration is
// idempotent; the checks read external truth from ctx so the engine stays pure.
export function registerEnterpriseValidationHandlers() {
  if (handlersRegistered) return validationTypes();
  const wrap = (checker, label) => (value, config, ctx) => {
    if (value === null || value === undefined || value === "") return { passed: true };
    if (typeof ctx[checker] !== "function") return { passed: true };
    return ctx[checker](value, config) ? { passed: true } : { passed: false, message: config.message || `Unknown ${label}: ${value}` };
  };
  registerValidation("OBJECT_TYPE", wrap("typeChecker", "object type"));
  registerValidation("UOM", wrap("uomChecker", "unit of measure"));
  registerValidation("CLASSIFICATION", wrap("classificationChecker", "classification"));
  registerValidation("RELATIONSHIP_TYPE", wrap("relationshipTypeChecker", "relationship type"));
  registerValidation("LIFECYCLE", (value, config) => {
    if (value === null || value === undefined || value === "") return { passed: true };
    const allowed = config.allowed || config.values || [];
    return allowed.map(String).includes(String(value)) ? { passed: true } : { passed: false, message: config.message || `Lifecycle state must be one of: ${allowed.join(", ")}` };
  });
  handlersRegistered = true;
  return validationTypes();
}

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function getValidationProfileRow(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const raw = String(ref ?? "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = queryOne(db, "SELECT * FROM exchange_validation_profiles WHERE id = ? AND tenant_id = ?", [Number(raw), tenant]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM exchange_validation_profiles WHERE tenant_id = ? AND (profile_ref = ? OR code = ? COLLATE NOCASE)", [tenant, raw, raw]);
}

export function requireValidationProfileRow(db, tenantId, ref) {
  const row = getValidationProfileRow(db, tenantId, ref);
  if (!row) throw validationProfileNotFound(ref);
  return row;
}

function normalizeRule(body = {}, index = 0) {
  const level = normalizeUpper(body.level || "ENTERPRISE");
  return {
    sequence: body.sequence ?? (index + 1) * 10,
    level: VALIDATION_LEVELS.includes(level) ? level : "ENTERPRISE",
    target_field: body.target_field || body.targetField || "",
    rule_type: normalizeUpper(body.rule_type || body.ruleType || body.type || "REQUIRED"),
    config: body.config || body.config_json || {},
    severity: normalizeUpper(body.severity || "ERROR"),
    message: body.message || "",
    status: body.status || "active",
  };
}

function insertRules(db, tenantId, profileId, rules) {
  rules.forEach((raw, index) => {
    const rule = normalizeRule(raw, index);
    run(
      db,
      `INSERT INTO exchange_validation_rules (profile_id, tenant_id, sequence, level, target_field, rule_type, config_json, severity, message, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [profileId, tenantId, rule.sequence, rule.level, rule.target_field, rule.rule_type, toJson(rule.config, {}), rule.severity, rule.message, rule.status, nowIso(), nowIso()]
    );
  });
}

export function createValidationProfile(db, tenantId, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code || "", { max: 120 });
  if (!code) throw invalidValidationProfile("A validation profile code is required");
  const status = normalizeUpper(body.status || "DRAFT");
  if (!DEFINITION_STATUSES.includes(status)) throw invalidValidationProfile(`Unsupported status: ${status}`);
  const existing = queryOne(db, "SELECT id FROM exchange_validation_profiles WHERE tenant_id = ? AND code = ?", [tenant, code]);
  if (existing) throw validationProfileConflict(code);
  const levels = Array.isArray(body.levels) ? body.levels.map((entry) => normalizeUpper(entry)).filter((entry) => VALIDATION_LEVELS.includes(entry)) : [...VALIDATION_LEVELS];
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_validation_profiles
       (profile_ref, tenant_id, code, name, description, format_code, direction, target_object_type, levels_json, version, status, immutable, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    [
      validationProfileRef(code), tenant, code, String(body.name || code).trim(), String(body.description || "").trim(),
      normalizeUpper(body.format_code || body.formatCode || "", { max: 80 }),
      normalizeUpper(body.direction || "IMPORT"),
      String(body.target_object_type || body.targetObjectType || "").trim(),
      toJson(levels, []), status, toJson(body.metadata || {}, {}), actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const profileRow = queryOne(db, "SELECT * FROM exchange_validation_profiles WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (Array.isArray(body.rules) && body.rules.length) insertRules(db, tenant, profileRow.id, body.rules);
  return getValidationProfile(db, tenant, profileRow.id);
}

export function updateValidationProfile(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireValidationProfileRow(db, tenant, ref);
  const levels = body.levels ? body.levels.map((entry) => normalizeUpper(entry)).filter((entry) => VALIDATION_LEVELS.includes(entry)) : parseJson(row.levels_json, []);
  run(
    db,
    `UPDATE exchange_validation_profiles SET name=?, description=?, format_code=?, direction=?, target_object_type=?, levels_json=?, status=?, metadata_json=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
    [
      String(body.name || row.name), String(body.description ?? row.description), normalizeUpper(body.format_code || body.formatCode || row.format_code || ""),
      normalizeUpper(body.direction || row.direction), String(body.target_object_type || body.targetObjectType || row.target_object_type || ""),
      toJson(levels, []), normalizeUpper(body.status || row.status), toJson(body.metadata || parseJson(row.metadata_json, {}), {}), actor?.id ?? null, nowIso(), row.id, tenant,
    ]
  );
  return getValidationProfile(db, tenant, row.id);
}

export function addValidationRule(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireValidationProfileRow(db, tenant, ref);
  const rule = normalizeRule(body);
  const check = validateRule(rule);
  if (!check.valid) throw invalidValidationProfile("Invalid validation rule", { errors: check.errors });
  const max = Number(queryOne(db, "SELECT COALESCE(MAX(sequence),0) AS s FROM exchange_validation_rules WHERE profile_id = ?", [row.id])?.s || 0);
  run(
    db,
    `INSERT INTO exchange_validation_rules (profile_id, tenant_id, sequence, level, target_field, rule_type, config_json, severity, message, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, tenant, body.sequence ?? max + 10, rule.level, rule.target_field, rule.rule_type, toJson(rule.config, {}), rule.severity, rule.message, rule.status, nowIso(), nowIso()]
  );
  return getValidationProfile(db, tenant, row.id);
}

export function deleteValidationRule(db, tenantId, ref, ruleId) {
  const row = requireValidationProfileRow(db, tenant, ref);
  run(db, "DELETE FROM exchange_validation_rules WHERE id = ? AND profile_id = ? AND tenant_id = ?", [Number(ruleId), row.id, Number(tenantId)]);
  return getValidationProfile(db, tenantId, row.id);
}

export function setValidationProfileStatus(db, tenantId, ref, status, actor = null) {
  const tenant = Number(tenantId);
  const row = requireValidationProfileRow(db, tenant, ref);
  const next = normalizeUpper(status);
  if (!DEFINITION_STATUSES.includes(next)) throw invalidValidationProfile(`Unsupported status: ${status}`);
  run(db, "UPDATE exchange_validation_profiles SET status=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [next, actor?.id ?? null, nowIso(), row.id, tenant]);
  return getValidationProfile(db, tenant, ref);
}

export function deleteValidationProfile(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireValidationProfileRow(db, tenant, ref);
  run(db, "DELETE FROM exchange_validation_profiles WHERE id = ? AND tenant_id = ?", [row.id, tenant]);
  return { deleted: true, ref: row.profile_ref };
}

export function listValidationProfiles(db, tenantId, query = {}) {
  const tenant = Number(tenantId);
  const { page, pageSize, offset } = pageArgs(query);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(query.status));
  }
  if (query.q) {
    clauses.push("(code LIKE ? OR name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_validation_profiles WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_validation_profiles WHERE ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicValidationProfile), total, page, pageSize };
}

export function getValidationProfile(db, tenantId, ref) {
  const row = requireValidationProfileRow(db, tenantId, ref);
  const output = publicValidationProfile(row);
  output.rules = queryAll(db, "SELECT * FROM exchange_validation_rules WHERE profile_id = ? ORDER BY sequence ASC", [row.id]).map(publicValidationRule);
  return output;
}

export function resolveValidationProfile(db, tenantId, code) {
  if (!code) return null;
  const row = getValidationProfileRow(db, tenantId, code);
  return row ? getValidationProfile(db, tenantId, row.id) : null;
}

function fileLevelFindings({ payload, fileName, mimeType, format, bytesLimit, maxBytes }) {
  const findings = [];
  const size = byteLength(payload);
  if (size === 0) findings.push(finding({ level: "FILE", severity: "ERROR", code: "empty_file", message: "The payload is empty" }));
  const limit = Number(bytesLimit || maxBytes || MAX_PAYLOAD_BYTES);
  if (size > limit) findings.push(finding({ level: "FILE", severity: "ERROR", code: "file_too_large", message: `Payload of ${size} bytes exceeds the ${limit} byte limit` }));
  if (fileName && format && Array.isArray(format.extensions) && format.extensions.length) {
    const matched = format.extensions.some((extension) => String(fileName).toLowerCase().endsWith(String(extension).toLowerCase()));
    if (!matched) findings.push(finding({ level: "FILE", severity: "WARNING", code: "extension_mismatch", message: `File name ${fileName} does not match format ${format.code}` }));
  }
  if (mimeType && format && Array.isArray(format.mime_types) && format.mime_types.length) {
    const matched = format.mime_types.some((entry) => String(entry).toLowerCase() === String(mimeType).toLowerCase());
    if (!matched) findings.push(finding({ level: "FILE", severity: "WARNING", code: "mime_mismatch", message: `MIME type ${mimeType} does not match format ${format.code}` }));
  }
  return findings;
}

function standardsLevelFindings({ adapter, payload, schema, maxBytes }) {
  if (!adapter || !payload) return [];
  try {
    const result = adapter.validate(payload, { schema, limit: maxBytes });
    return (result.findings || []).map((entry) => ({ ...entry, level: "STANDARDS" }));
  } catch (error) {
    return [finding({ level: "STANDARDS", severity: "ERROR", code: error.code || "standards_validation_error", message: error.message })];
  }
}

function enterpriseLevelFindings({ rules, records, ctx }) {
  const findings = [];
  for (const record of records) {
    const result = evaluateRules(rules, record, ctx);
    for (const entry of result.results) {
      if (entry.passed) continue;
      findings.push(
        finding({
          level: "ENTERPRISE",
          severity: entry.severity,
          code: `enterprise_${String(entry.rule || "rule").toLowerCase()}`,
          message: entry.message || `${entry.rule} failed`,
          attribute: entry.field,
          targetObject: record.object_type || record.code || record.external_id || "",
          rule: entry.rule,
          value: entry.value,
        })
      );
    }
  }
  return findings;
}

// Runs the three validation levels and returns a merged, structured result.
export function runValidation(db, tenantId, {
  definition = null,
  profile = null,
  format = null,
  adapter = null,
  payload = null,
  fileName = "",
  mimeType = "",
  records = null,
  levels = null,
  maxBytes = null,
  context = {},
} = {}) {
  registerEnterpriseValidationHandlers();
  const activeLevels = levels && levels.length ? levels.map((entry) => normalizeUpper(entry)) : profile?.levels || VALIDATION_LEVELS;
  const findings = [];
  if (activeLevels.includes("FILE")) findings.push(...fileLevelFindings({ payload, fileName, mimeType, format, bytesLimit: context.max_payload_bytes, maxBytes }));
  if (activeLevels.includes("STANDARDS")) {
    const adapterInstance = adapter ? (typeof adapter === "string" ? getAdapter(adapter) : adapter) : definition?.format_code ? getAdapter(getAdapterCode(db, tenantId, definition.format_code)) : null;
    findings.push(...standardsLevelFindings({ adapter: adapterInstance, payload, schema: format?.schema || null, maxBytes }));
  }
  if (activeLevels.includes("ENTERPRISE") && profile) {
    const rules = profile.rules || [];
    const list = Array.isArray(records) ? records : records ? [records] : [];
    findings.push(...enterpriseLevelFindings({ rules, records: list, ctx: { ...context } }));
  }
  return { ...mergeValidationResults({ findings }), levels_evaluated: activeLevels };
}

function getAdapterCode(db, tenantId, formatCode) {
  const row = queryOne(db, "SELECT adapter_code FROM exchange_formats WHERE tenant_id = ? AND code = ? COLLATE NOCASE", [Number(tenantId), normalizeUpper(formatCode)]);
  return row?.adapter_code || null;
}
