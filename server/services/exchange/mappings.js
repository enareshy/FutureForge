// Exchange Mapping profiles (§7).
//
// A mapping is a versioned, reusable, testable list of declarative rules. The
// actual rule evaluation is delegated to the Import & Export Framework mapping
// engine (Engines.applyMappings); this module owns identity, versioning,
// lifecycle, audit and document-level application.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { mappingRef } from "./identifiers.js";
import { EngineRef } from "./engine-ref.js";
import { DEFINITION_STATUSES, DIRECTIONS, MAPPING_SOURCE_KINDS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { publicMapping, publicMappingVersion, toJson, parseJson } from "./repository.js";
import { mappingNotFound, mappingConflict, invalidMapping, mappingImmutable } from "./errors.js";
import { normalizeUpper } from "../data-exchange/validation.js";

const { applyMappings, validateMappings } = EngineRef;

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function getMappingRow(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const raw = String(ref ?? "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = queryOne(db, "SELECT * FROM exchange_mappings WHERE id = ? AND tenant_id = ?", [Number(raw), tenant]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM exchange_mappings WHERE tenant_id = ? AND (mapping_ref = ? OR code = ? COLLATE NOCASE)", [tenant, raw, raw]);
}

export function requireMappingRow(db, tenantId, ref) {
  const row = getMappingRow(db, tenantId, ref);
  if (!row) throw mappingNotFound(ref);
  return row;
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) throw invalidMapping("Mapping rules must be an array");
  return rules.map((rule, index) => ({
    sequence: rule.sequence ?? (index + 1) * 10,
    source_field: rule.source_field || rule.sourceField || "",
    target_field: rule.target_field || rule.targetField || "",
    mapping_type: normalizeUpper(rule.mapping_type || rule.mappingType || "DIRECT"),
    data_type: rule.data_type || rule.dataType || "string",
    required: Boolean(rule.required),
    default_value: rule.default_value ?? rule.defaultValue ?? null,
    constant_value: rule.constant_value ?? rule.constantValue ?? null,
    expression: rule.expression || "",
    lookup: rule.lookup || {},
    condition: rule.condition || {},
    concat: rule.concat || [],
    split: rule.split || {},
    nested: rule.nested || {},
    transform: rule.transform || rule.transformations || [],
    status: rule.status || "active",
  }));
}

function normalizeMappingInput(body = {}, current = {}) {
  const code = normalizeUpper(body.code || current.code || "", { max: 120 });
  if (!code) throw invalidMapping("A mapping code is required");
  const direction = normalizeUpper(body.direction || current.direction || "IMPORT");
  if (!DIRECTIONS.includes(direction)) throw invalidMapping(`Unsupported direction: ${body.direction}`);
  const sourceKind = normalizeUpper(body.source_kind || body.sourceKind || current.source_kind || "STANDARD");
  if (!MAPPING_SOURCE_KINDS.includes(sourceKind)) throw invalidMapping(`Unsupported source_kind: ${sourceKind}`);
  const status = normalizeUpper(body.status || current.status || "DRAFT");
  if (!DEFINITION_STATUSES.includes(status)) throw invalidMapping(`Unsupported status: ${body.status}`);
  return {
    code,
    name: String(body.name || current.name || code).trim(),
    description: String(body.description ?? current.description ?? "").trim(),
    format_code: normalizeUpper(body.format_code || body.formatCode || current.format_code || "", { max: 80 }),
    direction,
    source_kind: sourceKind,
    source_object_type: String(body.source_object_type || body.sourceObjectType || current.source_object_type || "").trim(),
    target_object_type: String(body.target_object_type || body.targetObjectType || current.target_object_type || "").trim(),
    rules: body.rules !== undefined ? normalizeRules(body.rules) : parseJson(current.rules_json, []),
    status,
    metadata: body.metadata || parseJson(current.metadata_json, {}),
  };
}

function insertMappingVersion(db, tenantId, row, { changeSummary, actor }) {
  const existing = queryOne(db, "SELECT id FROM exchange_mapping_versions WHERE mapping_id = ? AND version = ?", [row.id, row.version]);
  if (existing) return;
  run(
    db,
    `INSERT INTO exchange_mapping_versions (mapping_id, tenant_id, version, status, rules_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, tenantId, row.version, row.status, parseJson(row.rules_json, []) ? toJson(parseJson(row.rules_json, []), []) : "[]", changeSummary, actor?.id ?? null, nowIso()]
  );
}

export function createMapping(db, tenantId, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const input = normalizeMappingInput(body);
  const check = validateMappings(input.rules, {});
  if (!check.valid) throw invalidMapping("Invalid mapping rules", { errors: check.errors });
  const existing = queryOne(db, "SELECT id FROM exchange_mappings WHERE tenant_id = ? AND code = ?", [tenant, input.code]);
  if (existing) throw mappingConflict(input.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_mappings
       (mapping_ref, tenant_id, code, name, description, format_code, direction, source_kind, source_object_type, target_object_type,
        rules_json, version, status, immutable, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    [
      mappingRef(input.code), tenant, input.code, input.name, input.description, input.format_code, input.direction, input.source_kind,
      input.source_object_type, input.target_object_type, toJson(input.rules, []), input.status, toJson(input.metadata, {}),
      actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM exchange_mappings WHERE id = ?", [Number(result.lastInsertRowid)]);
  insertMappingVersion(db, tenant, row, { changeSummary: "Initial version", actor });
  return publicMapping(row);
}

export function updateMapping(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireMappingRow(db, tenant, ref);
  if (row.immutable) {
    // Published mappings are immutable: roll forward a new working version.
    insertMappingVersion(db, tenant, row, { changeSummary: body.change_summary || "Superseded", actor });
    run(db, "UPDATE exchange_mappings SET immutable=0 WHERE id=?", [row.id]);
  }
  const input = normalizeMappingInput(body, row);
  const check = validateMappings(input.rules, {});
  if (!check.valid) throw invalidMapping("Invalid mapping rules", { errors: check.errors });
  const rollForward = Boolean(row.immutable);
  run(
    db,
    `UPDATE exchange_mappings SET name=?, description=?, format_code=?, direction=?, source_kind=?, source_object_type=?, target_object_type=?,
       rules_json=?, status=?, metadata_json=?, version=version+${rollForward ? 1 : 0}, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
    [
      input.name, input.description, input.format_code, input.direction, input.source_kind, input.source_object_type,
      input.target_object_type, toJson(input.rules, []), input.status, toJson(input.metadata, {}), actor?.id ?? null, nowIso(), row.id, tenant,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM exchange_mappings WHERE id = ?", [row.id]);
  if (rollForward) insertMappingVersion(db, tenant, updated, { changeSummary: body.change_summary || "New version", actor });
  return publicMapping(updated);
}

export function publishMapping(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireMappingRow(db, tenant, ref);
  insertMappingVersion(db, tenant, row, { changeSummary: body.change_summary || "Published", actor });
  run(db, "UPDATE exchange_mappings SET status='ACTIVE', immutable=1, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicMapping(queryOne(db, "SELECT * FROM exchange_mappings WHERE id = ?", [row.id]));
}

export function setMappingStatus(db, tenantId, ref, status, actor = null) {
  const tenant = Number(tenantId);
  const row = requireMappingRow(db, tenant, ref);
  const next = normalizeUpper(status);
  if (!DEFINITION_STATUSES.includes(next)) throw invalidMapping(`Unsupported status: ${status}`);
  run(db, "UPDATE exchange_mappings SET status=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [next, actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicMapping(queryOne(db, "SELECT * FROM exchange_mappings WHERE id = ?", [row.id]));
}

export function deleteMapping(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireMappingRow(db, tenant, ref);
  if (row.immutable) throw mappingImmutable(row.code, row.version);
  run(db, "DELETE FROM exchange_mappings WHERE id = ? AND tenant_id = ?", [row.id, tenant]);
  return { deleted: true, ref: row.mapping_ref };
}

export function listMappings(db, tenantId, query = {}) {
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_mappings WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_mappings WHERE ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicMapping), total, page, pageSize };
}

export function getMapping(db, tenantId, ref) {
  const row = requireMappingRow(db, tenantId, ref);
  const output = publicMapping(row);
  output.versions = listMappingVersions(db, tenantId, row.id).items;
  return output;
}

export function listMappingVersions(db, tenantId, ref) {
  const row = requireMappingRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM exchange_mapping_versions WHERE mapping_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicMappingVersion), total: rows.length };
}

export function validateMapping(db, tenantId, ref, { sourceFields = null, targetFields = null } = {}) {
  const row = requireMappingRow(db, tenantId, ref);
  const rules = parseJson(row.rules_json, []);
  const result = validateMappings(rules, { sourceFields, targetFields });
  return { mapping: publicMapping(row), ...result };
}

// Applies a mapping's rules to a single record.
export function applyMappingRecord(db, tenantId, ref, record, ctx = {}) {
  const row = requireMappingRow(db, tenantId, ref);
  const rules = parseJson(row.rules_json, []);
  return { mapping: publicMapping(row), ...applyMappings(rules, record, ctx) };
}

// Applies a mapping to every object in a canonical document. Rules target the
// enterprise record shape; `object_type` is preserved from the source when the
// mapping does not override it.
export function applyMappingToDocument(db, tenantId, ref, document, ctx = {}) {
  const row = ref ? requireMappingRow(db, tenantId, ref) : null;
  const rules = row ? parseJson(row.rules_json, []) : [];
  const records = [];
  const errors = [];
  const warnings = [];
  for (const object of document.objects || []) {
    if (!rules.length) {
      records.push({ ...object, code: object.external_id, data: { ...(object.attributes || {}) } });
      continue;
    }
    const result = applyMappings(rules, object, ctx);
    errors.push(...result.errors.map((entry) => ({ ...entry, object: object.external_id })));
    warnings.push(...result.warnings.map((entry) => ({ ...entry, object: object.external_id })));
    records.push({ object_type: object.object_type, external_id: object.external_id, ...result.target });
  }
  return { mapping: row ? publicMapping(row) : null, records, errors, warnings };
}

export function resolveMapping(db, tenantId, code) {
  if (!code) return null;
  const row = getMappingRow(db, tenantId, code);
  return row ? publicMapping(row) : null;
}
