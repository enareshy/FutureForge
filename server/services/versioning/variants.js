// VariantService — generic variant model (variant, option, rule) plus
// applicability evaluation. Product-specific rules are stored as structured
// expressions, never baked into the kernel.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { writeAudit } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import {
  publicVariant,
  publicVariantOption,
  publicVariantRule,
  normalizeText,
  safeParse,
  VARIANT_RULE_TYPES,
} from "./validation.js";
import { variantRef } from "./refs.js";
import { variantNotFound, invalidEffectivity } from "./errors.js";

function optionsFor(db, variantId) {
  return queryAll(db, "SELECT * FROM versioning_variant_options WHERE variant_id = ? ORDER BY sequence, id", [variantId]);
}

function rulesFor(db, variantId) {
  return queryAll(db, "SELECT * FROM versioning_variant_rules WHERE variant_id = ? ORDER BY id", [variantId]);
}

export function getVariantRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_variants WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_variants WHERE variant_ref = ? OR code = ?", [String(ref), String(ref)]);
}

export function getVariant(db, ref) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  return publicVariant(row, { options: optionsFor(db, row.id), rules: rulesFor(db, row.id) });
}

export function listVariants(db, { objectType, status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_variants WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(db, `SELECT * FROM versioning_variants WHERE ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return {
    items: rows.map((row) => publicVariant(row, { options: optionsFor(db, row.id), rules: rulesFor(db, row.id) })),
    total,
    page: Number(page) || 1,
    page_size: limit,
  };
}

export function createVariant(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  const name = normalizeText(input.name, code);
  if (!code) throw invalidEffectivity("Variant code is required");
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_variants WHERE code = ? AND (tenant_id IS NULL OR ? IS NULL OR tenant_id = ?)",
      [code, tenantId, tenantId]
    );
    if (existing) throw invalidEffectivity(`Variant ${code} already exists`);
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_variants
        (variant_ref, code, name, description, parent_id, object_type, status, is_default, attributes_json, tenant_id, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        variantRef(code),
        code,
        name,
        normalizeText(input.description),
        input.parentId ?? input.parent_id ?? null,
        normalizeText(input.objectType ?? input.object_type),
        input.status === "inactive" ? "inactive" : "active",
        input.isDefault === true || input.is_default === true ? 1 : 0,
        JSON.stringify(input.attributes ?? safeParse(input.attributes_json, {})),
        input.tenantId ?? input.tenant_id ?? tenantId,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    const options = Array.isArray(input.options) ? input.options : [];
    for (const option of options) upsertOption(db, id, option, actor);
    const rules = Array.isArray(input.rules) ? input.rules : [];
    for (const rule of rules) addRule(db, id, rule, actor);
    const row = queryOne(db, "SELECT * FROM versioning_variants WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.variant.create",
      resourceType: "versioning_variant",
      resourceId: id,
      details: { code, options: options.length },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "VariantCreated",
        source_module: "versioning",
        source_object_type: "versioning_variant",
        source_object_id: id,
        tenant_id: row.tenant_id,
        payload: { variant_id: id, code, name },
      },
      actor
    );
    return publicVariant(row, { options: optionsFor(db, id), rules: rulesFor(db, id) });
  });
}

export function updateVariant(db, ref, patch = {}, actor = null, ip = null) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (patch.parentId !== undefined || patch.parent_id !== undefined) set("parent_id", patch.parentId ?? patch.parent_id ?? null);
  if (patch.attributes !== undefined) set("attributes_json", JSON.stringify(patch.attributes ?? {}));
  if (patch.isDefault !== undefined || patch.is_default !== undefined) {
    set("is_default", patch.isDefault === true || patch.is_default === true ? 1 : 0);
  }
  if (fields.length) {
    set("updated_by", actor?.id ?? null);
    set("version", Number(row.version) + 1);
    set("updated_at", nowIso());
    run(db, `UPDATE versioning_variants SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
  }
  const updated = queryOne(db, "SELECT * FROM versioning_variants WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.variant.update",
    resourceType: "versioning_variant",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "VariantChanged",
      source_module: "versioning",
      source_object_type: "versioning_variant",
      source_object_id: row.id,
      tenant_id: updated.tenant_id,
      payload: { variant_id: row.id, code: updated.code },
    },
    actor
  );
  return publicVariant(updated, { options: optionsFor(db, row.id), rules: rulesFor(db, row.id) });
}

function upsertOption(db, variantId, option, actor) {
  const code = normalizeText(option.code);
  if (!code) throw invalidEffectivity("Variant option code is required");
  const existing = queryOne(db, "SELECT * FROM versioning_variant_options WHERE variant_id = ? AND code = ?", [variantId, code]);
  const ts = nowIso();
  if (existing) {
    run(
      db,
      `UPDATE versioning_variant_options SET name = ?, description = ?, sequence = ?, attributes_json = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        normalizeText(option.name, code),
        normalizeText(option.description),
        option.sequence === undefined ? existing.sequence : Number(option.sequence),
        JSON.stringify(option.attributes ?? safeParse(existing.attributes_json, {})),
        option.status === "inactive" ? "inactive" : "active",
        ts,
        existing.id,
      ]
    );
    return existing.id;
  }
  const result = run(
    db,
    `INSERT INTO versioning_variant_options (variant_id, code, name, description, sequence, attributes_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      variantId,
      code,
      normalizeText(option.name, code),
      normalizeText(option.description),
      option.sequence === undefined ? 0 : Number(option.sequence),
      JSON.stringify(option.attributes ?? {}),
      option.status === "inactive" ? "inactive" : "active",
      ts,
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function addOption(db, ref, option = {}, actor = null, ip = null) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  const id = upsertOption(db, row.id, option, actor);
  writeAudit(db, {
    actor,
    action: "versioning.variant.option.upsert",
    resourceType: "versioning_variant_option",
    resourceId: id,
    details: { variant: row.code, option: option.code },
    ip,
  });
  return publicVariantOption(queryOne(db, "SELECT * FROM versioning_variant_options WHERE id = ?", [id]));
}

export function addRule(db, ref, rule = {}, actor = null, ip = null) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  const code = normalizeText(rule.code);
  if (!code) throw invalidEffectivity("Variant rule code is required");
  const ruleType = normalizeText(rule.ruleType ?? rule.rule_type, "applicability");
  if (!VARIANT_RULE_TYPES.includes(ruleType)) {
    throw invalidEffectivity(`ruleType must be one of: ${VARIANT_RULE_TYPES.join(", ")}`);
  }
  const existing = queryOne(db, "SELECT id FROM versioning_variant_rules WHERE variant_id = ? AND code = ?", [row.id, code]);
  const ts = nowIso();
  if (existing) {
    run(
      db,
      "UPDATE versioning_variant_rules SET name = ?, rule_type = ?, expression_json = ?, status = ?, updated_at = ? WHERE id = ?",
      [
        normalizeText(rule.name, code),
        ruleType,
        JSON.stringify(rule.expression ?? {}),
        rule.status === "inactive" ? "inactive" : "active",
        ts,
        existing.id,
      ]
    );
    writeAudit(db, {
      actor,
      action: "versioning.variant.rule.update",
      resourceType: "versioning_variant_rule",
      resourceId: existing.id,
      details: { variant: row.code, rule: code },
      ip,
    });
    return publicVariantRule(queryOne(db, "SELECT * FROM versioning_variant_rules WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    `INSERT INTO versioning_variant_rules (variant_id, code, name, rule_type, expression_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      code,
      normalizeText(rule.name, code),
      ruleType,
      JSON.stringify(rule.expression ?? {}),
      rule.status === "inactive" ? "inactive" : "active",
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "versioning.variant.rule.create",
    resourceType: "versioning_variant_rule",
    resourceId: id,
    details: { variant: row.code, rule: code },
    ip,
  });
  return publicVariantRule(queryOne(db, "SELECT * FROM versioning_variant_rules WHERE id = ?", [id]));
}

// Evaluate whether a variant (and optionally an option selection) applies for a
// configuration context. Supports rule types inclusion / exclusion / constraint /
// applicability with equality and set membership expressions.
export function evaluateVariant(db, ref, context = {}) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  const rules = rulesFor(db, row.id);
  const selection = context.options ?? context.selection ?? context.optionCodes ?? [];
  const selected = new Set(Array.isArray(selection) ? selection.map(String) : []);
  const results = [];
  let applicable = true;
  for (const rule of rules.filter((r) => r.status === "active")) {
    const expression = safeParse(rule.expression_json, {});
    const evaluation = evaluateExpression(expression, { ...context, selected: [...selected] });
    let effect = evaluation;
    if (rule.rule_type === "inclusion") effect = evaluation ? true : false;
    if (rule.rule_type === "exclusion") effect = evaluation ? false : true;
    if (rule.rule_type === "constraint") effect = evaluation;
    results.push({ rule: rule.code, type: rule.rule_type, expected: expression, matched: evaluation, applies: effect });
    if (!effect) applicable = false;
  }
  return { variant: publicVariant(row, { options: optionsFor(db, row.id), rules }), applicable, results };
}

function evaluateExpression(expression, facts) {
  if (!expression || typeof expression !== "object") return true;
  const { dimension, operator = "equals", value, values } = expression;
  if (!dimension) return true;
  const actual = facts[dimension] ?? facts[String(dimension).replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  if (operator === "in") {
    const list = Array.isArray(values) ? values : Array.isArray(value) ? value : [];
    return list.map(String).includes(String(actual));
  }
  if (operator === "not_in") {
    const list = Array.isArray(values) ? values : Array.isArray(value) ? value : [];
    return !list.map(String).includes(String(actual));
  }
  if (operator === "not_equals") return String(actual) !== String(value);
  if (operator === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (actual === undefined || actual === null) return false;
  return String(actual) === String(value);
}

export function variantHistory(db, ref, { limit = 100 } = {}) {
  const row = getVariantRow(db, ref);
  if (!row) throw variantNotFound(ref);
  const rows = queryAll(
    db,
    `SELECT id, action, actor_id, actor_username AS actor_name, created_at, details FROM audit_logs
     WHERE resource_type LIKE 'versioning_variant%' AND resource_id = ? ORDER BY created_at DESC LIMIT ?`,
    [String(row.id), Number(limit)]
  ).map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    actor_name: entry.actor_name,
    at: entry.created_at,
    details: safeParse(entry.details, {}),
  }));
  return { variant: publicVariant(row, { options: optionsFor(db, row.id), rules: rulesFor(db, row.id) }), entries: rows };
}
