// BOM validation engine and rule administration.
//
// Rules are data (bom_validation_rules) so validation is configurable without a
// deploy. The engine evaluates one revision at a time, persists a result and its
// issues, and is safe to run from a job or synchronously over the API.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicValidationRule, publicValidationResult, publicValidationIssue } from "./repository.js";
import { ruleRef, validationRef } from "./refs.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { requireRevisionRow } from "./revisions.js";
import { linesForRevision, buildAdjacency } from "./structure.js";
import { normalizeEffectivity } from "./effectivity.js";
import { getUnit } from "./units.js";
import {
  assertRuleType,
  assertRuleSeverity,
  normalizeText,
  normalizeUpper,
  parseObject,
  toInt,
  paginate,
} from "./validation.js";
import { ruleNotFound, invalidRule, validationFailed } from "./errors.js";
import { DEFAULT_VALIDATION_RULES, SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = ["name", "description", "rule_type", "severity", "config_json", "status", "sequence", "updated_by"];

// ── Rule administration ──────────────────────────────────────────────────────

export function getRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_validation_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM bom_validation_rules WHERE tenant_id = ? AND (rule_ref = ? OR code = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireRuleRow(db, tenantId, ref) {
  const row = getRuleRow(db, tenantId, ref);
  if (!row) throw ruleNotFound(ref);
  return row;
}

export function listValidationRules(db, { tenantId, status, ruleType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (ruleType) {
    clauses.push("rule_type = ?");
    params.push(assertRuleType(ruleType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_validation_rules ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_validation_rules ${where} ORDER BY sequence, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationRule), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function ensureDefaultValidationRules(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const rule of DEFAULT_VALIDATION_RULES) {
    const existing = queryOne(db, "SELECT id FROM bom_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, rule.code]);
    if (existing) continue;
    run(
      db,
      `INSERT INTO bom_validation_rules (rule_ref, tenant_id, code, name, description, rule_type, severity, config_json, status, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [ruleRef(rule.code), tenant, rule.code, rule.name ?? rule.code, rule.description ?? "", rule.rule_type, rule.severity,
        JSON.stringify(rule.config_json || {}), toInt(rule.sequence, 0), nowIso(), nowIso()]
    );
    created += 1;
  }
  return created;
}

export function createValidationRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code ?? body.rule_code ?? "", { max: 120 });
  if (!code) throw invalidRule("code is required");
  if (queryOne(db, "SELECT id FROM bom_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, code])) {
    throw invalidRule(`Validation rule already exists: ${code}`);
  }
  const ruleType = assertRuleType(body.rule_type ?? body.ruleType ?? "CUSTOM");
  const severity = assertRuleSeverity(body.severity ?? "ERROR");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_validation_rules (rule_ref, tenant_id, code, name, description, rule_type, severity, config_json, status, sequence, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ruleRef(code), tenant, code, normalizeText(body.name ?? code, { max: 300 }), normalizeText(body.description ?? "", { max: 2000 }),
      ruleType, severity, JSON.stringify(parseObject(body.config ?? body.config_json, {})), normalizeUpper(body.status ?? "ACTIVE"),
      toInt(body.sequence, 100), actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM bom_validation_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId: tenant, entityType: "RULE", entityId: row.id, entityRef: row.rule_ref, action: "CREATED", status: row.status, after: publicValidationRule(row), actor, ip });
  return publicValidationRule(row);
}

export function updateValidationRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRuleRow(db, tenant, ref);
  const before = publicValidationRule(row);
  updateRow(
    db,
    "bom_validation_rules",
    row.id,
    {
      name: normalizeText(body.name ?? row.name, { max: 300 }),
      description: normalizeText(body.description ?? row.description, { max: 2000 }),
      rule_type: body.rule_type !== undefined || body.ruleType !== undefined ? assertRuleType(body.rule_type ?? body.ruleType) : row.rule_type,
      severity: body.severity !== undefined ? assertRuleSeverity(body.severity) : row.severity,
      config_json: JSON.stringify(parseObject(body.config ?? body.config_json ?? row.config_json, {})),
      status: body.status !== undefined ? normalizeUpper(body.status) : row.status,
      sequence: body.sequence !== undefined ? toInt(body.sequence, row.sequence) : row.sequence,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_validation_rules WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "RULE", entityId: row.id, entityRef: row.rule_ref, action: "UPDATED", status: updated.status, before, after: publicValidationRule(updated), actor, ip });
  return publicValidationRule(updated);
}

export function deleteValidationRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRuleRow(db, tenant, ref);
  const before = publicValidationRule(row);
  run(db, "DELETE FROM bom_validation_rules WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "RULE", entityId: row.id, entityRef: row.rule_ref, action: "DELETED", status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, code: row.code };
}

// ── Rule evaluation ──────────────────────────────────────────────────────────

function issue(rule, message, { line = null, field = "", details = {} } = {}) {
  return {
    rule_code: rule.code,
    rule_type: rule.rule_type,
    severity: rule.severity,
    message,
    field,
    line_id: line?.id ?? null,
    line_ref: line?.line_ref ?? "",
    details,
  };
}

function evaluateRule(rule, context) {
  const { lines, unitLookup } = context;
  const ruleConfig = parseObject(rule.config_json, {});
  const issues = [];
  switch (rule.rule_type) {
    case "MISSING_CHILD":
      for (const line of lines) {
        if (!line.child_object_id) issues.push(issue(rule, `Line ${line.line_ref} has no child object`, { line, field: "child_object_id" }));
      }
      break;
    case "MISSING_UOM":
      for (const line of lines) {
        if (!String(line.uom || "").trim()) issues.push(issue(rule, `Line ${line.line_ref} has no unit of measure`, { line, field: "uom" }));
      }
      break;
    case "INVALID_QUANTITY": {
      const min = Number.isFinite(Number(ruleConfig.min)) ? Number(ruleConfig.min) : 0;
      const exclusive = ruleConfig.exclusive !== false;
      for (const line of lines) {
        const q = Number(line.quantity);
        if (!Number.isFinite(q) || (exclusive ? q <= min : q < min)) {
          issues.push(issue(rule, `Line ${line.line_ref} has an invalid quantity (${line.quantity})`, { line, field: "quantity", details: { quantity: line.quantity, min } }));
        }
      }
      break;
    }
    case "INVALID_UOM":
      if (unitLookup) {
        for (const line of lines) {
          if (!line.uom) continue;
          if (!unitLookup(line.uom)) issues.push(issue(rule, `Line ${line.line_ref} uses an unknown unit "${line.uom}"`, { line, field: "uom", details: { uom: line.uom } }));
        }
      }
      break;
    case "DUPLICATE_LINE": {
      const seen = new Map();
      for (const line of lines) {
        const key = `${line.parent_object_id ?? ""}|${line.child_object_type}:${line.child_object_id}`;
        if (seen.has(key)) issues.push(issue(rule, `Duplicate child ${line.child_object_id} under the same parent`, { line, field: "child_object_id" }));
        else seen.set(key, line);
      }
      break;
    }
    case "DUPLICATE_FIND_NUMBER": {
      const seen = new Map();
      for (const line of lines) {
        if (!line.find_number) continue;
        const key = `${line.parent_object_id ?? ""}|${normalizeUpper(line.find_number)}`;
        if (seen.has(key)) issues.push(issue(rule, `Duplicate find number ${line.find_number} under the same parent`, { line, field: "find_number" }));
        else seen.set(key, line);
      }
      break;
    }
    case "INVALID_SEQUENCE":
      for (const line of lines) {
        if (!Number.isInteger(Number(line.sequence)) || Number(line.sequence) < 0) {
          issues.push(issue(rule, `Line ${line.line_ref} has an invalid sequence`, { line, field: "sequence", details: { sequence: line.sequence } }));
        }
      }
      break;
    case "CIRCULAR_STRUCTURE": {
      const circular = detectCycleFromLines(lines);
      if (circular) issues.push(issue(rule, `Circular structure detected involving ${circular}`, { field: "structure", details: { object_id: circular } }));
      break;
    }
    case "INVALID_SUBSTITUTE": {
      for (const sub of context.substitutes) {
        if (sub.substitute_object_id && sub.primary_object_id && sub.substitute_object_id === sub.primary_object_id) {
          issues.push(issue(rule, `Substitute equals primary part ${sub.substitute_object_id}`, { field: "substitute_object_id", details: { substitute_id: sub.id } }));
        }
      }
      break;
    }
    case "INVALID_EFFECTIVITY":
      for (const line of lines) {
        try {
          normalizeEffectivity(line.effectivity_json);
        } catch (error) {
          issues.push(issue(rule, `Line ${line.line_ref} has invalid effectivity: ${error.message}`, { line, field: "effectivity" }));
        }
      }
      break;
    case "INVALID_VARIANT":
      for (const line of lines) {
        if (line.variant_id != null && !line.variant_code) {
          issues.push(issue(rule, `Line ${line.line_ref} sets variant_id without variant_code`, { line, field: "variant_code" }));
        }
        if (line.variant_code && line.variant_id == null) {
          issues.push(issue(rule, `Line ${line.line_ref} sets variant_code without a recognized variant_id`, { line, field: "variant_id", details: { variant_code: line.variant_code } }));
        }
      }
      break;
    case "MISSING_MANDATORY_ATTRIBUTE": {
      const required = Array.isArray(ruleConfig.attributes) ? ruleConfig.attributes.map((a) => normalizeUpper(a)) : [];
      for (const line of lines) {
        const attributes = parseObject(line.attributes_json, {});
        const keys = Object.keys(attributes).map((k) => normalizeUpper(k));
        for (const key of required) {
          if (!keys.includes(key) || attributes[key] === "" || attributes[key] === null || attributes[key] === undefined) {
            const originalKey = Object.keys(attributes).find((k) => normalizeUpper(k) === key) || key;
            issues.push(issue(rule, `Line ${line.line_ref} is missing mandatory attribute ${originalKey}`, { line, field: "attributes", details: { attribute: originalKey } }));
          }
        }
      }
      break;
    }
    case "LIFECYCLE_INCOMPATIBILITY":
      // Verified through the shared lifecycle kernel when a child revision is
      // onboarded; no-op here rather than duplicating lifecycle semantics.
      break;
    case "UNAUTHORIZED_CHILD":
      // Evaluated by the caller with the request security context; see validateRevision.
      break;
    default:
      issues.push({ ...issue(rule, `Custom rule type ${rule.rule_type} is not automatically evaluable`, { field: "rule_type", details: { rule_type: rule.rule_type } }), severity: "WARNING" });
  }
  return issues;
}

function detectCycleFromLines(lines) {
  const { byParent, childIds } = buildAdjacency(lines);
  const roots = lines.filter((line) => {
    const parent = line.parent_object_id ? String(line.parent_object_id) : "";
    return !parent || !childIds.has(parent);
  });
  const visit = (line, seen) => {
    const key = line.child_object_id ? String(line.child_object_id) : null;
    if (!key) return null;
    if (seen.has(key)) return key;
    const next = new Set([...seen, key]);
    for (const child of byParent.get(key) || []) {
      const found = visit(child, next);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = visit(root, new Set());
    if (found) return found;
  }
  return null;
}

export function validateRevision(db, tenantId, revisionId, { scope = "REVISION", ruleCodes = null, includeInactive = true, persist = true, actor = null, ip = null, securityContext = null } = {}) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  const started = Date.now();
  const lines = linesForRevision(db, revision.id, { includeInactive });
  const substitutes = queryAll(db, "SELECT * FROM bom_substitutes WHERE bom_revision_id = ?", [revision.id]);

  let unitLookup = null;
  try {
    unitLookup = (code) => Boolean(getUnit(db, code));
  } catch {
    unitLookup = null;
  }

  let rules = queryAll(db, "SELECT * FROM bom_validation_rules WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY sequence, id", [tenant]);
  if (ruleCodes && ruleCodes.length) {
    const wanted = new Set(ruleCodes.map((code) => normalizeUpper(code)));
    rules = rules.filter((rule) => wanted.has(normalizeUpper(rule.code)) || wanted.has(normalizeUpper(rule.rule_type)));
  }

  const context = { lines, substitutes, unitLookup, securityContext };
  const issues = [];
  for (const rule of rules) {
    issues.push(...evaluateRule(rule, context));
  }

  // Authorization-aware checks run only when a security context is supplied.
  if (securityContext?.authorizeObject) {
    for (const line of lines) {
      if (!line.child_object_id) continue;
      try {
        context.securityContext.authorizeObject({ objectType: line.child_object_type, objectId: line.child_object_id, action: "read" });
      } catch {
        issues.push(issue({ code: "SECURITY_CHILD_ACCESS", rule_type: "UNAUTHORIZED_CHILD", severity: "ERROR" }, `Line ${line.line_ref} references a child the actor cannot read`, { line, field: "child_object_id" }));
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === "ERROR").length;
  const warningCount = issues.filter((i) => i.severity === "WARNING").length;
  const status = errorCount ? "ERROR" : warningCount ? "WARNING" : "PASS";
  const duration = Date.now() - started;

  if (!persist) {
    return { revision_id: revision.id, scope: normalizeUpper(scope), status, rule_count: rules.length, issue_count: issues.length, error_count: errorCount, warning_count: warningCount, duration_ms: duration, issues };
  }

  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO bom_validation_results
       (result_ref, tenant_id, organization_id, bom_id, revision_id, scope, status, rule_count, issue_count, error_count, warning_count, duration_ms, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [validationRef(), tenant, revision.organization_id, revision.bom_id, revision.id, normalizeUpper(scope), status, rules.length,
      issues.length, errorCount, warningCount, duration, actor?.id ?? null, ts]
  );
  const resultId = Number(insert.lastInsertRowid);
  for (const item of issues) {
    run(
      db,
      `INSERT INTO bom_validation_issues (tenant_id, result_id, revision_id, line_id, line_ref, rule_code, severity, message, field, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant, resultId, revision.id, item.line_id, item.line_ref, item.rule_code, item.severity, item.message, item.field, JSON.stringify(item.details || {}), ts]
    );
  }
  const row = queryOne(db, "SELECT * FROM bom_validation_results WHERE id = ?", [resultId]);
  recordChange(db, { tenantId: tenant, entityType: "VALIDATION", entityId: resultId, entityRef: row.result_ref, action: "VALIDATED", status, after: { status, issue_count: issues.length }, actor, ip, details: { revision_id: revision.id } });
  publishBomEvent(db, { eventType: bomEventCode("VALIDATION_COMPLETED"), objectType: "bom_validation", objectId: resultId, tenantId: tenant, organizationId: revision.organization_id, payload: { revision_id: revision.id, status, error_count: errorCount, warning_count: warningCount } }, actor);
  return { ...publicValidationResult(row), issues: issues.map((item) => ({ ...item, result_id: resultId })) };
}

export function assertRevisionValid(db, tenantId, revisionId, options = {}) {
  const result = validateRevision(db, tenantId, revisionId, { ...options, persist: false });
  if (result.status === "ERROR") throw validationFailed({ revision_id: revisionId, error_count: result.error_count, issues: result.issues.filter((i) => i.severity === "ERROR").slice(0, 50) });
  return result;
}

export function getValidationResult(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM bom_validation_results WHERE tenant_id = ? AND (id = ? OR result_ref = ?)", [Number(tenantId), Number(ref) || -1, String(ref)]);
  if (!row) return null;
  return publicValidationResult(row);
}

export function listValidationResults(db, { tenantId, revisionId, bomId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (revisionId != null) {
    clauses.push("revision_id = ?");
    params.push(Number(revisionId));
  }
  if (bomId != null) {
    clauses.push("bom_id = ?");
    params.push(Number(bomId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_validation_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_validation_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationResult), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function listValidationIssues(db, tenantId, resultId, { severity, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?", "result_id = ?"];
  const params = [Number(tenantId), Number(resultId)];
  if (severity) {
    clauses.push("severity = ?");
    params.push(normalizeUpper(severity));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 200, maxPageSize: 10000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_validation_issues ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_validation_issues ${where} ORDER BY id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationIssue), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
