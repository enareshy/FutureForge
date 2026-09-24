// PDM revision rule service.
//
// A revision rule decides which revision of an item is selected when resolving
// structures, where-used, visualization or downstream data. It is centralized so
// BOM, EBOM/MBOM, where-used and PDM screens never hard-code revision selection.
// Rule configuration is versioned and cached per tenant.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, bumpVersion } from "./sql.js";
import { publicRevisionRule, publicRuleVersion } from "./repository.js";
import { revisionRuleRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { requireItemRow } from "./items.js";
import { normalizeRevisionRuleInput, normalizeText, normalizeUpper, assertRuleStatus, paginate } from "./validation.js";
import { revisionRuleNotFound, revisionRuleConflict, invalidRevisionRule, invalidEffectivity } from "./errors.js";
import { SOURCE_MODULE, REVISION_STATUSES } from "./constants.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "rule_type",
  "status",
  "priority",
  "sequence",
  "is_default",
  "current_version_id",
  "version_number",
  "config_json",
  "metadata_json",
  "version",
  "updated_by",
];

export function getRevisionRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ? AND (rule_ref = ? OR code = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireRevisionRuleRow(db, tenantId, ref) {
  const row = getRevisionRuleRow(db, tenantId, ref);
  if (!row) throw revisionRuleNotFound(ref);
  return row;
}

export function getRevisionRule(db, tenantId, ref) {
  return publicRevisionRule(requireRevisionRuleRow(db, tenantId, ref));
}

export function listRevisionRules(db, { tenantId, status, ruleType, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertRuleStatus(status));
  }
  if (ruleType) {
    clauses.push("rule_type = ?");
    params.push(String(ruleType).toUpperCase());
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_revision_rules ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_revision_rules ${where} ORDER BY priority, sequence, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRevisionRule), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createRevisionRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRevisionRuleInput(body, {});
  if (queryOne(db, "SELECT id FROM pdm_revision_rules WHERE tenant_id = ? AND code = ?", [tenant, normalized.code])) throw revisionRuleConflict(normalized.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_revision_rules
       (rule_ref, tenant_id, organization_id, code, name, description, rule_type, status, priority, sequence, is_default,
        current_version_id, version_number, config_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, 1, ?, ?, ?, ?)`,
    [
      revisionRuleRef(normalized.code),
      tenant,
      normalized.organization_id,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.rule_type,
      normalized.status,
      normalized.priority,
      normalized.sequence,
      normalized.is_default ? 1 : 0,
      JSON.stringify(normalized.config || {}),
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  const version = run(
    db,
    "INSERT INTO pdm_revision_rule_versions (tenant_id, rule_id, version_number, rule_type, config_json, status, change_note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)",
    [tenant, row.id, row.rule_type, row.config_json, row.status, "Initial version", actor?.id ?? null, ts]
  );
  updateRow(db, "pdm_revision_rules", row.id, { current_version_id: Number(version.lastInsertRowid) }, { columns: ["current_version_id"] });
  const finalRow = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "CREATED", version: 1, status: row.status, after: publicRevisionRule(finalRow), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("REVISION_RULE_CREATED"), objectType: "pdm_revision_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref, rule_type: row.rule_type } }, actor);
  return publicRevisionRule(finalRow);
}

export function updateRevisionRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRevisionRuleRow(db, tenant, ref);
  const before = publicRevisionRule(row);
  const normalized = normalizeRevisionRuleInput(body, row);
  updateRow(
    db,
    "pdm_revision_rules",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      rule_type: normalized.rule_type,
      status: normalized.status,
      priority: normalized.priority,
      sequence: normalized.sequence,
      is_default: normalized.is_default ? 1 : 0,
      config_json: JSON.stringify(normalized.config || {}),
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRevisionRule(updated), actor, ip });
  return publicRevisionRule(updated);
}

export function activateRevisionRule(db, tenantId, ref, actor = null, ip = null) {
  return setRevisionRuleStatus(db, tenantId, ref, "ACTIVE", actor, ip);
}

export function setRevisionRuleStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRevisionRuleRow(db, tenant, ref);
  const next = assertRuleStatus(status);
  const before = publicRevisionRule(row);
  updateRow(db, "pdm_revision_rules", row.id, { status: next, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "STATUS_CHANGED", version: updated.version, status: next, before, after: publicRevisionRule(updated), actor, ip });
  if (next === "ACTIVE") {
    publishPdmEvent(db, { eventType: pdmEventCode("REVISION_RULE_ACTIVATED"), objectType: "pdm_revision_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref } }, actor);
  }
  return publicRevisionRule(updated);
}

// Publishes a new immutable rule version and points the rule at it.
export function publishRevisionRuleVersion(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRevisionRuleRow(db, tenant, ref);
  const config = body.config ? { ...body.config } : JSON.parse(row.config_json || "{}");
  const nextVersion = Number(row.version_number || 1) + 1;
  const ts = nowIso();
  const inserted = run(
    db,
    "INSERT INTO pdm_revision_rule_versions (tenant_id, rule_id, version_number, rule_type, config_json, status, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [tenant, row.id, nextVersion, body.rule_type ? String(body.rule_type).toUpperCase() : row.rule_type, JSON.stringify(config), body.status ? String(body.status).toUpperCase() : row.status, normalizeText(body.change_note ?? body.changeNote ?? "", { max: 1000 }), actor?.id ?? null, ts]
  );
  updateRow(
    db,
    "pdm_revision_rules",
    row.id,
    { current_version_id: Number(inserted.lastInsertRowid), version_number: nextVersion, config_json: JSON.stringify(config), rule_type: body.rule_type ? String(body.rule_type).toUpperCase() : row.rule_type, version: bumpVersion(row), updated_by: actor?.id ?? null },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "VERSION_PUBLISHED", version: updated.version, status: updated.status, after: publicRevisionRule(updated), actor, ip, details: { version_number: nextVersion } });
  publishPdmEvent(db, { eventType: pdmEventCode("REVISION_RULE_VERSION_PUBLISHED"), objectType: "pdm_revision_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref, version_number: nextVersion } }, actor);
  return publicRevisionRule(updated);
}

export function listRevisionRuleVersions(db, tenantId, ref) {
  const row = requireRevisionRuleRow(db, tenantId, ref);
  return queryAll(db, "SELECT * FROM pdm_revision_rule_versions WHERE rule_id = ? ORDER BY version_number DESC", [row.id]).map(publicRuleVersion);
}

export function deleteRevisionRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRevisionRuleRow(db, tenant, ref);
  const before = publicRevisionRule(row);
  run(db, "DELETE FROM pdm_revision_rule_versions WHERE rule_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_revision_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, rule_ref: row.rule_ref };
}

// ── Resolution ───────────────────────────────────────────────────────────────

// Resolves the revision of an item according to a rule and optional context
// (as_of date, lifecycle priority, variant/configuration, explicit revision).
export function resolveRevisionRule(db, tenantId, { itemId = null, itemRef = null, ruleId = null, ruleCode = null, rule = null, context = {} } = {}) {
  const tenant = Number(tenantId);
  const item = itemId != null ? requireItemRow(db, tenant, itemId) : itemRef ? requireItemRow(db, tenant, itemRef) : null;
  if (!item) throw invalidRevisionRule("An item_id or item_ref is required to resolve a revision rule");
  const ruleRow = rule
    ? rule
    : ruleId != null || ruleCode
      ? requireRevisionRuleRow(db, tenant, ruleId ?? ruleCode)
      : defaultRevisionRuleRow(db, tenant);
  if (!ruleRow) throw revisionRuleNotFound(ruleCode || ruleId || "default");
  const config = JSON.parse(ruleRow.config_json || "{}");
  const revisions = queryAll(db, "SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ? ORDER BY revision_sequence ASC", [tenant, item.id]);
  const filtered = filterByEffectivity(revisions, context);
  const selected = selectRevision(ruleRow.rule_type, filtered, { ...config, ...context });
  return {
    source_module: SOURCE_MODULE,
    rule: publicRevisionRule(ruleRow),
    item: { id: item.id, item_number: item.item_number, item_ref: item.item_ref },
    revision: selected ? { id: selected.id, revision_number: selected.revision_number, revision_ref: selected.revision_ref, status: selected.status, revision_sequence: selected.revision_sequence, valid_from: selected.valid_from, valid_to: selected.valid_to } : null,
    context: context || {},
    candidates: filtered.length,
  };
}

export function defaultRevisionRuleRow(db, tenantId) {
  const explicit = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND is_default = 1 ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId)]);
  if (explicit) return explicit;
  const preferred = normalizeUpper(getConfig(db, tenantId, "revision_rule_default") || "LATEST_RELEASED");
  const byType = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND rule_type = ? ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId), preferred]);
  if (byType) return byType;
  return queryOne(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId)]);
}

function selectRevision(ruleType, revisions, config) {
  const type = String(ruleType || "LATEST_RELEASED").toUpperCase();
  const notObsolete = revisions.filter((row) => String(row.status).toUpperCase() !== "OBSOLETE");
  switch (type) {
    case "LATEST_RELEASED": {
      const released = notObsolete.filter((row) => String(row.status).toUpperCase() === "RELEASED");
      return lastBy(released, (row) => row.revision_sequence) || lastBy(notObsolete, (row) => row.revision_sequence) || null;
    }
    case "LATEST_WORKING":
      return lastBy(notObsolete, (row) => row.revision_sequence) || null;
    case "HIGHEST_REVISION":
      return lastBy(revisions, (row) => row.revision_sequence) || null;
    case "RELEASED_AS_OF": {
      const asOf = config.as_of || config.date || new Date().toISOString();
      const released = notObsolete.filter((row) => String(row.status).toUpperCase() === "RELEASED");
      const eligible = released.filter((row) => (!row.valid_from || String(row.valid_from) <= String(asOf)) && (!row.valid_to || String(row.valid_to) >= String(asOf)));
      return lastBy(eligible, (row) => row.revision_sequence) || lastBy(released, (row) => row.revision_sequence) || null;
    }
    case "SPECIFIC_REVISION": {
      const wanted = normalizeText(config.revision_number || config.revision || "", { max: 60 });
      if (!wanted) return null;
      return revisions.find((row) => String(row.revision_number).toUpperCase() === wanted.toUpperCase()) || null;
    }
    case "BY_LIFECYCLE": {
      const state = String(config.lifecycle_state || config.status || "RELEASED").toUpperCase();
      const matches = revisions.filter((row) => String(row.status).toUpperCase() === state);
      return lastBy(matches, (row) => row.revision_sequence) || null;
    }
    case "CUSTOM":
    default:
      return lastBy(notObsolete, (row) => row.revision_sequence) || null;
  }
}

function lastBy(rows, keyFn) {
  let best = null;
  for (const row of rows) {
    if (!best || Number(keyFn(row) || 0) >= Number(keyFn(best) || 0)) best = row;
  }
  return best;
}

// Revision-aware effectivity filter: applies the date window and variant context
// carried by the revision's effectivity object. Kept intentionally simple and
// delegated to the shared Versioning/Effectivity kernel where an assignment
// exists; this fallback never invents effectivity semantics of its own.
export function filterByEffectivity(revisions, context = {}) {
  const asOf = context.as_of || context.asOf || null;
  const variantCode = context.variant_code || context.variantCode || null;
  let rows = revisions;
  if (variantCode) {
    const matched = rows.filter((row) => !row.variant_code || String(row.variant_code).toUpperCase() === String(variantCode).toUpperCase());
    if (matched.length) rows = matched;
  }
  if (asOf) {
    const matched = rows.filter((row) => {
      const effectivity = safeParse(row.effectivity_json);
      const from = effectivity.valid_from || row.valid_from;
      const to = effectivity.valid_to || row.valid_to;
      if (from && String(from) > String(asOf)) return false;
      if (to && String(to) < String(asOf)) return false;
      return true;
    });
    if (matched.length) rows = matched;
  }
  return rows;
}

function safeParse(value) {
  try {
    return JSON.parse(value || "{}") || {};
  } catch {
    return {};
  }
}

export { REVISION_STATUSES, invalidEffectivity };
