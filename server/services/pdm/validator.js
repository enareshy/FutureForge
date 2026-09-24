// PDM validation service.
//
// A single, data-driven rule engine validates items, revisions, datasets and
// whole tenants. Rules are persisted (customisable per tenant) and evaluated by
// `rule_type`, so adding a check never means editing several call sites. Each run
// persists a result header plus its issues for auditability and dashboards.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicValidationRule, publicValidationResult, publicValidationIssue } from "./repository.js";
import { validationRef, runRef } from "./refs.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { listRevisions } from "./revisions.js";
import { assertRuleType, assertRuleSeverity, assertValidationScope, normalizeText, normalizeUpper, paginate, parseObject } from "./validation.js";
import { ruleNotFound, invalidRule } from "./errors.js";
import {
  SOURCE_MODULE,
  DEFAULT_VALIDATION_RULES,
  DATASET_TYPES,
  CAD_ASSOCIATION_STATUSES,
} from "./constants.js";

// ── Rule registry ────────────────────────────────────────────────────────────

export function getValidationRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_validation_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_validation_rules WHERE tenant_id = ? AND code = ? COLLATE NOCASE", [Number(tenantId), String(ref)]);
}

export function listValidationRules(db, { tenantId, status = null, ruleType = null, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status, { max: 20 }));
  }
  if (ruleType) {
    clauses.push("rule_type = ?");
    params.push(assertRuleType(ruleType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_validation_rules ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_validation_rules ${where} ORDER BY sequence, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationRule), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function ensureDefaultValidationRules(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const rule of DEFAULT_VALIDATION_RULES) {
    if (queryOne(db, "SELECT id FROM pdm_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, rule.code])) continue;
    run(
      db,
      `INSERT INTO pdm_validation_rules (rule_ref, tenant_id, code, name, description, rule_type, severity, config_json, status, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'ACTIVE', ?, ?, ?)`,
      [validationRef(rule.code), tenant, rule.code, rule.code, rule.description || "", assertRuleType(rule.rule_type), assertRuleSeverity(rule.severity), Number(rule.sequence || 0), nowIso(), nowIso()]
    );
    created += 1;
  }
  return created;
}

export function createValidationRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeText(body.code, { max: 120 });
  if (!code) throw invalidRule("Validation rule code is required");
  if (queryOne(db, "SELECT id FROM pdm_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, code])) throw invalidRule(`Validation rule already exists: ${code}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_validation_rules (rule_ref, tenant_id, code, name, description, rule_type, severity, config_json, status, sequence, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      validationRef(code),
      tenant,
      code,
      normalizeText(body.name ?? code, { max: 300 }),
      normalizeText(body.description ?? "", { max: 4000 }),
      assertRuleType(body.rule_type ?? body.ruleType ?? "CUSTOM"),
      assertRuleSeverity(body.severity ?? "ERROR"),
      JSON.stringify(parseObject(body.config, {})),
      normalizeUpper(body.status ?? "ACTIVE", { max: 20 }),
      Number(body.sequence ?? 100),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_validation_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId: tenant, entityType: "VALIDATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "CREATED", status: row.status, after: publicValidationRule(row), actor, ip });
  return publicValidationRule(row);
}

export function updateValidationRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getValidationRuleRow(db, tenant, ref);
  if (!row) throw ruleNotFound(ref);
  const before = publicValidationRule(row);
  updateRow(
    db,
    "pdm_validation_rules",
    row.id,
    {
      name: normalizeText(body.name ?? row.name, { max: 300 }),
      description: normalizeText(body.description ?? row.description, { max: 4000 }),
      rule_type: body.rule_type || body.ruleType ? assertRuleType(body.rule_type ?? body.ruleType) : row.rule_type,
      severity: body.severity ? assertRuleSeverity(body.severity) : row.severity,
      config_json: body.config !== undefined ? JSON.stringify(parseObject(body.config, {})) : row.config_json,
      status: body.status ? normalizeUpper(body.status, { max: 20 }) : row.status,
      sequence: body.sequence !== undefined ? Number(body.sequence) : row.sequence,
      updated_by: actor?.id ?? null,
    },
    { columns: ["name", "description", "rule_type", "severity", "config_json", "status", "sequence", "updated_by"] }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_validation_rules WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "VALIDATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "UPDATED", status: updated.status, before, after: publicValidationRule(updated), actor, ip });
  return publicValidationRule(updated);
}

export function deleteValidationRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getValidationRuleRow(db, tenant, ref);
  if (!row) throw ruleNotFound(ref);
  run(db, "DELETE FROM pdm_validation_rules WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "VALIDATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "DELETED", status: row.status, before: publicValidationRule(row), actor, ip });
  return { deleted: true, id: row.id, rule_ref: row.rule_ref };
}

// ── Engine ───────────────────────────────────────────────────────────────────

// Every rule type is implemented as a pure function taking a context and
// returning an array of issues. No rule reads the DB directly, which keeps them
// trivially testable.
const RULE_HANDLERS = {
  MISSING_REVISION(ctx) {
    if (ctx.scope === "ITEM") {
      if (!ctx.item || ctx.revisions.length) return [];
      return [{ severity: "WARNING", message: `Item ${ctx.item.item_number} has no revisions`, field: "revisions" }];
    }
    if (ctx.scope === "TENANT") {
      const withRevisions = new Set((ctx.revisions || []).map((revision) => revision.item_id));
      return (ctx.items || [])
        .filter((item) => !withRevisions.has(item.id))
        .map((item) => ({ severity: "WARNING", message: `Item ${item.item_number} has no revisions`, field: "revisions", item_id: item.id, details: { item_ref: item.item_ref } }));
    }
    return [];
  },
  DUPLICATE_ITEM_NUMBER(ctx) {
    const rows = ctx.scope === "TENANT" ? ctx.items || [] : ctx.item ? ctx.peers || [] : [];
    if (!rows.length) return [];
    const seen = new Map();
    const issues = [];
    for (const item of rows) {
      if (!item || !item.item_number) continue;
      const key = String(item.item_number).toUpperCase();
      if (seen.has(key) && !issues.some((issue) => issue.details.key === key)) {
        issues.push({ severity: "ERROR", message: `Item number ${item.item_number} is duplicated`, field: "item_number", details: { key, duplicates: seen.get(key).concat(item.item_ref || item.id) } });
      }
      if (!seen.has(key)) seen.set(key, [item.item_ref || item.id]);
      else seen.get(key).push(item.item_ref || item.id);
    }
    return issues;
  },
  DUPLICATE_REVISION_NUMBER(ctx) {
    if (!ctx.revisions?.length) return [];
    const seen = new Map();
    const issues = [];
    for (const revision of ctx.revisions) {
      const key = `${revision.item_id}:${String(revision.revision_number).toUpperCase()}`;
      if (seen.has(key)) {
        issues.push({ severity: "ERROR", message: `Revision number ${revision.revision_number} is duplicated`, field: "revision_number", details: { key, revision_ref: revision.revision_ref } });
      } else {
        seen.set(key, revision);
      }
    }
    return issues;
  },
  INVALID_REVISION_SEQUENCE(ctx) {
    if (!ctx.revisions?.length) return [];
    return ctx.revisions
      .filter((revision) => !Number.isInteger(Number(revision.revision_sequence)) || Number(revision.revision_sequence) < 1)
      .map((revision) => ({ severity: "WARNING", message: `Revision ${revision.revision_number} has an invalid sequence`, field: "revision_sequence", details: { revision_ref: revision.revision_ref } }));
  },
  MISSING_DATASET_TYPE(ctx) {
    if (ctx.scope !== "DATASET" || !ctx.dataset) return [];
    return ctx.dataset.dataset_type ? [] : [{ severity: "ERROR", message: `Dataset ${ctx.dataset.dataset_number} has no type`, field: "dataset_type" }];
  },
  INVALID_DATASET_TYPE(ctx) {
    if (ctx.scope !== "DATASET" || !ctx.dataset) return [];
    return DATASET_TYPES.includes(ctx.dataset.dataset_type) ? [] : [{ severity: "WARNING", message: `Dataset ${ctx.dataset.dataset_number} has an unknown type ${ctx.dataset.dataset_type}`, field: "dataset_type" }];
  },
  ORPHAN_DATASET(ctx) {
    if (ctx.scope !== "DATASET" || !ctx.dataset) return [];
    if (ctx.dataset.revision_id || ctx.dataset.item_id || ctx.dataset.object_id) return [];
    return [{ severity: "WARNING", message: `Dataset ${ctx.dataset.dataset_number} is not linked to a revision or object`, field: "revision_id" }];
  },
  INVALID_CAD_ASSOCIATION(ctx) {
    const rows = ctx.scope === "TENANT" ? ctx.cad ?? [] : ctx.cad ?? [];
    return rows
      .filter((row) => (!row.source_object_id && !row.dataset_id) || !CAD_ASSOCIATION_STATUSES.includes(row.status))
      .map((row) => ({ severity: "ERROR", message: `CAD association ${row.association_ref || row.id} is incomplete`, field: "cad", details: { association_id: row.id } }));
  },
  MISSING_PRIMARY_CAD(ctx) {
    const rows = ctx.cad ?? [];
    const grouped = new Map();
    for (const row of rows) {
      if (!row.is_primary) continue;
      const key = `${row.source_revision_id}:${row.cad_type}`;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }
    const issues = [];
    for (const [key, count] of grouped.entries()) {
      if (count > 1) issues.push({ severity: "WARNING", message: `Multiple primary CAD associations for ${key}`, field: "is_primary", details: { key, count } });
    }
    return issues;
  },
  INVALID_EFFECTIVITY(ctx) {
    const issues = [];
    for (const row of ctx.revisions || []) {
      if (row.valid_from && row.valid_to && String(row.valid_from) > String(row.valid_to)) issues.push({ severity: "ERROR", message: `Revision ${row.revision_number} has an inverted effectivity window`, field: "valid_to", details: { revision_ref: row.revision_ref } });
    }
    for (const row of ctx.revisionRules || []) {
      const config = parseObject(row.config_json, {});
      if (config.valid_from && config.valid_to && String(config.valid_from) > String(config.valid_to)) issues.push({ severity: "ERROR", message: `Revision rule ${row.code} has an inverted effectivity window`, field: "config", details: { rule_ref: row.rule_ref } });
    }
    return issues;
  },
  INVALID_REVISION_RULE(ctx) {
    return (ctx.revisionRules || [])
      .filter((row) => !row.rule_type || !row.code)
      .map((row) => ({ severity: "ERROR", message: `Revision rule ${row.id} is malformed`, field: "rule_type" }));
  },
  INVALID_CONFIGURATION_RULE(ctx) {
    return (ctx.configurationRules || [])
      .filter((row) => {
        const config = parseObject(row.config_json, {});
        return !row.rule_type || (config.conditions !== undefined && !Array.isArray(config.conditions));
      })
      .map((row) => ({ severity: "ERROR", message: `Configuration rule ${row.code || row.id} is malformed`, field: "config" }));
  },
  MISSING_OWNER(ctx) {
    if (ctx.scope === "ITEM") {
      if (!ctx.item) return [];
      if (ctx.item.owner_user_id || ctx.item.owner_object_id) return [];
      return [{ severity: "WARNING", message: `Item ${ctx.item.item_number} has no accountable owner`, field: "owner_user_id" }];
    }
    if (ctx.scope === "TENANT") {
      return (ctx.items || [])
        .filter((item) => !item.owner_user_id && !item.owner_object_id)
        .map((item) => ({ severity: "WARNING", message: `Item ${item.item_number} has no accountable owner`, field: "owner_user_id", item_id: item.id, details: { item_ref: item.item_ref } }));
    }
    return [];
  },
  LIFECYCLE_INCOMPATIBILITY(ctx) {
    if (ctx.scope !== "ITEM" || !ctx.item) return [];
    const working = (ctx.revisions || []).filter((revision) => ["DRAFT", "IN_WORK"].includes(String(revision.status).toUpperCase()));
    if (String(ctx.item.status).toUpperCase() === "OBSOLETE" && working.length) {
      return [{ severity: "WARNING", message: `Obsolete item ${ctx.item.item_number} still has working revisions`, field: "status", details: { working_revisions: working.map((r) => r.revision_number) } }];
    }
    return [];
  },
  CUSTOM() {
    return [];
  },
};

function buildContext(db, tenantId, scope, target) {
  const base = { scope, target };
  if (scope === "ITEM") {
    const item = target;
    base.item = item;
    base.revisions = queryAll(db, "SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ? ORDER BY revision_sequence", [tenantId, item.id]);
    base.peers = queryAll(db, "SELECT id, item_number, item_ref FROM pdm_items WHERE tenant_id = ?", [tenantId]);
    base.cad = queryAll(db, "SELECT c.* FROM pdm_cad_associations c JOIN pdm_item_revisions r ON r.id = c.source_revision_id WHERE c.tenant_id = ? AND r.item_id = ?", [tenantId, item.id]);
  } else if (scope === "REVISION") {
    const revision = target;
    base.revision = revision;
    base.revisions = [revision];
    base.cad = queryAll(db, "SELECT * FROM pdm_cad_associations WHERE tenant_id = ? AND source_revision_id = ?", [tenantId, revision.id]);
  } else if (scope === "DATASET") {
    base.dataset = target;
  } else {
    base.items = queryAll(db, "SELECT id, item_number, item_ref, owner_user_id, owner_object_id FROM pdm_items WHERE tenant_id = ?", [tenantId]);
    base.revisionRules = queryAll(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ?", [tenantId]);
    base.configurationRules = queryAll(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ?", [tenantId]);
    base.revisions = queryAll(db, "SELECT * FROM pdm_item_revisions WHERE tenant_id = ?", [tenantId]);
    base.cad = queryAll(db, "SELECT * FROM pdm_cad_associations WHERE tenant_id = ?", [tenantId]);
  }
  return base;
}

export function runRulesForContext(db, tenantId, scope, target, { rules = null } = {}) {
  const ruleRows = rules || queryAll(db, "SELECT * FROM pdm_validation_rules WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY sequence, id", [Number(tenantId)]);
  const context = buildContext(db, Number(tenantId), scope, target);
  const issues = [];
  const executed = [];
  for (const rule of ruleRows) {
    const handler = RULE_HANDLERS[rule.rule_type] || RULE_HANDLERS.CUSTOM;
    const produced = handler(context, rule) || [];
    executed.push(rule.code);
    for (const issue of produced) {
      issues.push({
        rule_code: rule.code,
        configured_severity: rule.severity,
        severity: bumpSeverity(issue.severity, rule.severity),
        message: issue.message,
        field: issue.field || "",
        details: issue.details || {},
        item_id: issue.item_id ?? null,
        revision_id: issue.revision_id ?? null,
        dataset_id: issue.dataset_id ?? null,
        object_ref: issue.object_ref || "",
      });
    }
  }
  return { issues, executed, context };
}

function bumpSeverity(issueSeverity, configured) {
  const order = { PASS: 0, WARNING: 1, ERROR: 2 };
  const a = String(issueSeverity || "WARNING").toUpperCase();
  const b = String(configured || "WARNING").toUpperCase();
  return (order[a] ?? 1) >= (order[b] ?? 1) ? a : b;
}

function summarize(issues) {
  const error_count = issues.filter((issue) => issue.severity === "ERROR").length;
  const warning_count = issues.filter((issue) => issue.severity === "WARNING").length;
  return { error_count, warning_count, status: error_count ? "ERROR" : warning_count ? "WARNING" : "PASS" };
}

function persistResult(db, tenantId, { scope, target, issues, executed, durationMs, actor, organizationId }) {
  const summary = summarize(issues);
  const result = run(
    db,
    `INSERT INTO pdm_validation_results (result_ref, tenant_id, organization_id, item_id, revision_id, dataset_id, scope, status, rule_count, issue_count, error_count, warning_count, duration_ms, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runRef(),
      Number(tenantId),
      organizationId ?? null,
      target?.id ?? null,
      null,
      null,
      scope,
      summary.status,
      executed.length,
      issues.length,
      summary.error_count,
      summary.warning_count,
      Math.max(0, Math.round(durationMs)),
      actor?.id ?? null,
      nowIso(),
    ]
  );
  const resultId = Number(result.lastInsertRowid);
  for (const issue of issues) {
    run(
      db,
      `INSERT INTO pdm_validation_issues (tenant_id, result_id, item_id, revision_id, dataset_id, object_ref, rule_code, severity, message, field, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(tenantId), resultId, issue.item_id ?? target?.id ?? null, issue.revision_id ?? (scope === "REVISION" ? target?.id ?? null : null), issue.dataset_id ?? (scope === "DATASET" ? target?.id ?? null : null), issue.object_ref || "", issue.rule_code, issue.severity, issue.message, issue.field, JSON.stringify(issue.details || {}), nowIso()]
    );
  }
  return queryOne(db, "SELECT * FROM pdm_validation_results WHERE id = ?", [resultId]);
}

export function validateItem(db, tenantId, ref, { actor = null } = {}) {
  const item = requireItemForValidation(db, tenantId, ref);
  const started = Date.now();
  const { issues, executed } = runRulesForContext(db, Number(tenantId), "ITEM", item);
  const row = persistResult(db, tenantId, { scope: "ITEM", target: item, issues, executed, durationMs: Date.now() - started, actor, organizationId: item.organization_id });
  return publicValidationResult(row);
}

export function validateRevision(db, tenantId, ref, { actor = null, itemId = null } = {}) {
  const revision = requireRevisionForValidation(db, tenantId, ref, itemId);
  const started = Date.now();
  const { issues, executed } = runRulesForContext(db, Number(tenantId), "REVISION", revision);
  const row = persistResult(db, tenantId, { scope: "REVISION", target: revision, issues, executed, durationMs: Date.now() - started, actor, organizationId: null });
  return publicValidationResult(row);
}

export function validateDataset(db, tenantId, ref, { actor = null } = {}) {
  const dataset = requireDatasetForValidation(db, tenantId, ref);
  const started = Date.now();
  const { issues, executed } = runRulesForContext(db, Number(tenantId), "DATASET", dataset);
  const row = persistResult(db, tenantId, { scope: "DATASET", target: dataset, issues, executed, durationMs: Date.now() - started, actor, organizationId: null });
  return publicValidationResult(row);
}

export function validateTenant(db, tenantId, { actor = null, scope = "TENANT" } = {}) {
  const started = Date.now();
  const { issues, executed } = runRulesForContext(db, Number(tenantId), scope, null);
  const row = persistResult(db, tenantId, { scope, target: null, issues, executed, durationMs: Date.now() - started, actor, organizationId: null });
  publishPdmEvent(db, { eventType: pdmEventCode("VALIDATION_COMPLETED"), objectType: "pdm_validation_result", objectId: row.id, tenantId: Number(tenantId), payload: { scope, status: row.status, issue_count: row.issue_count } }, actor);
  return publicValidationResult(row);
}

export function listValidationResults(db, { tenantId, itemId, revisionId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (itemId != null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (revisionId != null) {
    clauses.push("revision_id = ?");
    params.push(Number(revisionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status, { max: 20 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_validation_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_validation_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationResult), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getValidationResult(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM pdm_validation_results WHERE tenant_id = ? AND (id = ? OR result_ref = ?)", [Number(tenantId), Number(ref) || -1, String(ref)]);
  if (!row) throw ruleNotFound(ref);
  const issues = queryAll(db, "SELECT * FROM pdm_validation_issues WHERE result_id = ? ORDER BY id", [row.id]).map(publicValidationIssue);
  return { ...publicValidationResult(row), issues };
}

function requireItemForValidation(db, tenantId, ref) {
  const id = Number(ref);
  const row = Number.isInteger(id) && String(id) === String(ref).trim()
    ? queryOne(db, "SELECT * FROM pdm_items WHERE tenant_id = ? AND id = ?", [Number(tenantId), id])
    : queryOne(db, "SELECT * FROM pdm_items WHERE tenant_id = ? AND (item_ref = ? OR item_number = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
  if (!row) throw ruleNotFound(`item ${ref}`);
  return row;
}

function requireRevisionForValidation(db, tenantId, ref, itemId) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (itemId != null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  clauses.push("(id = ? OR revision_ref = ?)");
  params.push(Number(ref) || -1, String(ref));
  const row = queryOne(db, `SELECT * FROM pdm_item_revisions WHERE ${clauses.join(" AND ")}`, params);
  if (!row) throw ruleNotFound(`revision ${ref}`);
  return row;
}

function requireDatasetForValidation(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM pdm_datasets WHERE tenant_id = ? AND (id = ? OR dataset_ref = ? OR dataset_number = ? COLLATE NOCASE)", [Number(tenantId), Number(ref) || -1, String(ref), String(ref)]);
  if (!row) throw ruleNotFound(`dataset ${ref}`);
  return row;
}

export { listRevisions };
