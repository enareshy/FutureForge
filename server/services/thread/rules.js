// Traceability rules.
//
// A rule declares that objects in a source domain must be traceable to objects
// in a target domain (optionally via a specific relationship type). Rules are
// pure configuration: the completeness service evaluates them against a
// traversal, so adding or tightening a rule never requires code.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicTraceabilityRule } from "./repository.js";
import { ruleRef } from "./identifiers.js";
import { recordChange } from "./history.js";
import { ruleConflict, ruleNotFound, invalidRule } from "./errors.js";
import { DOMAIN_CODES, SEVERITIES } from "./constants.js";
import { assertEnum, normalizeStatus, normalizeText, normalizeUpper, normalizeBool } from "./validation.js";
import { bumpEpoch } from "./cache.js";

const RULE_STATUSES = ["ACTIVE", "INACTIVE"];

export function getRuleRow(db, tenantId, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return queryOne(db, "SELECT * FROM thread_traceability_rules WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(text)]);
  return queryOne(db, "SELECT * FROM thread_traceability_rules WHERE tenant_id = ? AND code = ?", [Number(tenantId), text.toUpperCase()]);
}

export function requireRuleRow(db, tenantId, ref) {
  const row = getRuleRow(db, tenantId, ref);
  if (!row) throw ruleNotFound(ref);
  return row;
}

export function getRule(db, tenantId, ref) {
  return publicTraceabilityRule(requireRuleRow(db, tenantId, ref));
}

export function listRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeStatus(query.status, "ACTIVE"));
  }
  if (query.definition_code || query.definitionCode) {
    clauses.push("(definition_code = '' OR definition_code = ?)");
    params.push(normalizeUpper(query.definition_code || query.definitionCode, { max: 64 }));
  }
  if (query.source_domain || query.sourceDomain) {
    clauses.push("source_domain = ?");
    params.push(normalizeUpper(query.source_domain || query.sourceDomain, { max: 60 }));
  }
  if (query.target_domain || query.targetDomain) {
    clauses.push("target_domain = ?");
    params.push(normalizeUpper(query.target_domain || query.targetDomain, { max: 60 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = queryAll(db, `SELECT * FROM thread_traceability_rules ${where} ORDER BY display_order, code`, params);
  return { items: rows.map(publicTraceabilityRule), total: rows.length, source_module: "thread" };
}

export function activeRules(db, tenantId, definitionCode = "") {
  const rows = queryAll(
    db,
    "SELECT * FROM thread_traceability_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND (definition_code = '' OR definition_code = ?) ORDER BY display_order, code",
    [Number(tenantId), String(definitionCode || "")]
  );
  return rows.map(publicTraceabilityRule);
}

function validateRuleBody(body = {}) {
  const sourceDomain = normalizeUpper(body.source_domain || body.sourceDomain, { max: 60 });
  const targetDomain = normalizeUpper(body.target_domain || body.targetDomain, { max: 60 });
  if (!sourceDomain) throw invalidRule("source_domain is required");
  if (!targetDomain) throw invalidRule("target_domain is required");
  if (DOMAIN_CODES.length && !DOMAIN_CODES.includes(sourceDomain) && body.allow_custom !== true) {
    // Custom domains are allowed when the definition declares them; the rule
    // still validates syntactically so typos are caught early.
    if (!/^[A-Z][A-Z0-9_-]{0,59}$/.test(sourceDomain)) throw invalidRule(`Invalid source_domain: ${sourceDomain}`);
  }
  const severity = normalizeUpper(body.severity, { max: 20, fallback: "ERROR" });
  assertEnum(severity, SEVERITIES, "severity");
  const name = normalizeText(body.name, { max: 200 });
  if (!name) throw invalidRule("A rule name is required");
  const code = normalizeUpper(body.code, { max: 80 });
  if (!code) throw invalidRule("A rule code is required");
  return {
    code,
    name,
    description: normalizeText(body.description, { max: 2000 }),
    definitionCode: normalizeUpper(body.definition_code || body.definitionCode, { max: 64 }),
    sourceDomain,
    targetDomain,
    relationshipType: normalizeText(body.relationship_type || body.relationshipType, { max: 200 }),
    required: normalizeBool(body.required, true),
    severity,
    status: normalizeStatus(body.status, "ACTIVE"),
    displayOrder: Number.isFinite(Number(body.display_order ?? body.displayOrder)) ? Number(body.display_order ?? body.displayOrder) : 100,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  };
}

export function createRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = validateRuleBody(body);
  if (getRuleRow(db, tenant, normalized.code)) throw ruleConflict(normalized.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO thread_traceability_rules
       (rule_ref, tenant_id, definition_code, code, name, description, source_domain, target_domain, relationship_type, required, severity, status, display_order, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ruleRef(normalized.code),
      tenant,
      normalized.definitionCode,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.sourceDomain,
      normalized.targetDomain,
      normalized.relationshipType,
      normalized.required ? 1 : 0,
      normalized.severity,
      normalized.status,
      normalized.displayOrder,
      JSON.stringify(normalized.metadata),
      ts,
      ts,
    ]
  );
  bumpEpoch(tenant);
  writeAudit(db, { actor, action: "thread.rule.create", resourceType: "thread_traceability_rule", resourceId: result.lastInsertRowid, details: { code: normalized.code }, ip });
  const rule = getRule(db, tenant, result.lastInsertRowid);
  recordChange(db, { tenantId: tenant, entityType: "RULE", entityId: rule.id, entityRef: rule.code, action: "CREATED", status: rule.status, after: rule, summary: `Rule ${rule.code} created`, actor, ip });
  return rule;
}

export function updateRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRuleRow(db, tenant, ref);
  const before = publicTraceabilityRule(row);
  const merged = validateRuleBody({
    code: row.code,
    name: body.name ?? row.name,
    description: body.description ?? row.description,
    definition_code: body.definition_code ?? body.definitionCode ?? row.definition_code,
    source_domain: body.source_domain ?? body.sourceDomain ?? row.source_domain,
    target_domain: body.target_domain ?? body.targetDomain ?? row.target_domain,
    relationship_type: body.relationship_type ?? body.relationshipType ?? row.relationship_type,
    required: body.required ?? row.required === 1,
    severity: body.severity ?? row.severity,
    status: body.status ?? row.status,
    display_order: body.display_order ?? body.displayOrder ?? row.display_order,
    metadata: body.metadata ?? (row.metadata_json ? JSON.parse(row.metadata_json) : {}),
  });
  run(
    db,
    `UPDATE thread_traceability_rules SET definition_code = ?, name = ?, description = ?, source_domain = ?, target_domain = ?,
       relationship_type = ?, required = ?, severity = ?, status = ?, display_order = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.definitionCode,
      merged.name,
      merged.description,
      merged.sourceDomain,
      merged.targetDomain,
      merged.relationshipType,
      merged.required ? 1 : 0,
      merged.severity,
      merged.status,
      merged.displayOrder,
      JSON.stringify(merged.metadata),
      nowIso(),
      row.id,
    ]
  );
  bumpEpoch(tenant);
  writeAudit(db, { actor, action: "thread.rule.update", resourceType: "thread_traceability_rule", resourceId: row.id, ip });
  const after = getRule(db, tenant, row.id);
  recordChange(db, { tenantId: tenant, entityType: "RULE", entityId: row.id, entityRef: row.code, action: "UPDATED", status: after.status, before, after, summary: `Rule ${row.code} updated`, actor, ip });
  return after;
}

export function setRuleStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRuleRow(db, tenant, ref);
  const normalized = normalizeStatus(status, row.status);
  if (!RULE_STATUSES.includes(normalized)) throw invalidRule(`status must be one of: ${RULE_STATUSES.join(", ")}`);
  run(db, "UPDATE thread_traceability_rules SET status = ?, updated_at = ? WHERE id = ?", [normalized, nowIso(), row.id]);
  bumpEpoch(tenant);
  writeAudit(db, { actor, action: "thread.rule.status", resourceType: "thread_traceability_rule", resourceId: row.id, details: { status: normalized }, ip });
  return getRule(db, tenant, row.id);
}

export function deleteRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRuleRow(db, tenant, ref);
  run(db, "DELETE FROM thread_traceability_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  writeAudit(db, { actor, action: "thread.rule.delete", resourceType: "thread_traceability_rule", resourceId: row.id, ip });
  return { deleted: true, id: row.id, code: row.code };
}

export function ruleSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT status, severity, COUNT(*) AS c FROM thread_traceability_rules WHERE tenant_id = ? GROUP BY status, severity", [Number(tenantId)]);
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + Number(row.c);
  return { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), by_status: byStatus };
}

export function ensureDefaultRules(db, tenantId) {
  const tenant = Number(tenantId);
  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM thread_traceability_rules WHERE tenant_id = ?", [tenant]);
  if (Number(existing?.c || 0) > 0) return { created: 0 };
  let created = 0;
  const defaults = [
    { code: "REQ-TO-SYSTEM", name: "Requirement satisfies system", source_domain: "REQUIREMENT", target_domain: "SYSTEM", relationship_type: "", required: true, severity: "ERROR" },
    { code: "SYSTEM-TO-DESIGN", name: "System realized by design", source_domain: "SYSTEM", target_domain: "DESIGN", relationship_type: "", required: true, severity: "ERROR" },
    { code: "DESIGN-TO-PART", name: "Design implemented by part", source_domain: "DESIGN", target_domain: "PART", relationship_type: "", required: true, severity: "ERROR" },
    { code: "PART-TO-EBOM", name: "Part used in EBOM", source_domain: "PART", target_domain: "EBOM", relationship_type: "", required: false, severity: "WARNING" },
    { code: "EBOM-TO-MBOM", name: "EBOM transformed to MBOM", source_domain: "EBOM", target_domain: "MBOM", relationship_type: "", required: false, severity: "WARNING" },
    { code: "MBOM-TO-BOP", name: "MBOM realized as BOP", source_domain: "MBOM", target_domain: "BOP", relationship_type: "", required: false, severity: "WARNING" },
    { code: "PRODUCT-TO-SERVICE", name: "Product supported by service", source_domain: "PRODUCT", target_domain: "SERVICE", relationship_type: "", required: false, severity: "INFO" },
  ];
  for (const entry of defaults) {
    createRule(db, tenant, entry, null, null);
    created += 1;
  }
  return { created };
}
