// First-class reference codes. An item has one canonical code (on the item
// row) plus any number of external / legacy / deprecated / replacement codes.
// Retired codes are retained so a governed code is never silently reused.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { codeConflict, codeNotFound, codeReuseNotAllowed, invalidItem, itemNotFound } from "./errors.js";
import { CODE_STATUSES, CODE_TYPES, normalizeText, normalizeUpper } from "./validation.js";
import { codeRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";
import { getActiveGovernancePolicy } from "./governance.js";

export function publicCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code_ref: row.code_ref,
    item_id: row.item_id,
    domain_id: row.domain_id,
    code: row.code,
    code_type: row.code_type,
    code_system: row.code_system,
    external_system: row.external_system,
    language: row.language,
    is_primary: Boolean(row.is_primary),
    case_sensitive: Boolean(row.case_sensitive),
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    replacement_item_id: row.replacement_item_id,
    description: row.description,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function normalizeCodeValue(value, { caseSensitive = true } = {}) {
  return caseSensitive ? normalizeText(value) : normalizeText(value).toLowerCase();
}

export function validateCodeValue(code, governance, { field = "code" } = {}) {
  const text = normalizeText(code);
  if (!text) throw invalidItem(`${field} is required`);
  if (governance?.code_pattern) {
    const flags = governance.code_case_sensitive ? "" : "i";
    const regex = new RegExp(governance.code_pattern, flags);
    if (!regex.test(text)) throw invalidItem(`${field} "${text}" does not match the domain code pattern`);
  }
  return text;
}

// Enforces the domain code-reuse policy against code history, including codes
// used by retired items. Always allows the same item to keep its own code.
export function assertCodeReusable(db, domainId, code, { exceptItemId = null, caseSensitive = true } = {}) {
  const governance = getActiveGovernancePolicy(db, domainId);
  if (governance.code_reuse_policy === "always_reuse") return;
  const compare = caseSensitive ? code : code.toLowerCase();
  const column = caseSensitive ? "UPPER(i.code)" : "LOWER(i.code)";
  const param = caseSensitive ? code.toUpperCase() : code.toLowerCase();
  const retired = queryAll(
    db,
    `SELECT i.id, i.code, i.status FROM reference_data_items i
     WHERE i.domain_id = ? AND ${column} = ?`,
    [Number(domainId), param]
  ).filter((row) => row.status === "retired" && Number(row.id) !== Number(exceptItemId ?? 0));
  if (retired.length && governance.code_reuse_policy === "never_reuse") {
    throw codeReuseNotAllowed(code, { domain_id: domainId });
  }
  return compare;
}

export function listCodes(db, { itemId, domainId, code, codeType, status, codeSystem, page, pageSize, limit } = {}) {
  const clauses = [];
  const params = [];
  if (itemId !== undefined && itemId !== null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (code) {
    clauses.push("code = ?");
    params.push(normalizeText(code));
  }
  if (codeType) {
    clauses.push("code_type = ?");
    params.push(String(codeType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (codeSystem) {
    clauses.push("(code_system = ? OR external_system = ?)");
    params.push(String(codeSystem), String(codeSystem));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageSizeNum = Math.min(500, Math.max(1, Number(pageSize || limit) || 200));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * pageSizeNum);
  const rows = queryAll(
    db,
    `SELECT * FROM reference_codes ${where} ORDER BY is_primary DESC, code_type, code LIMIT ? OFFSET ?`,
    [...params, pageSizeNum, offset]
  );
  return { items: rows.map(publicCode), total: Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_codes ${where}`, params)?.c ?? 0) };
}

export function getCodeRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_codes WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_codes WHERE code_ref = ?", [String(ref)]) || null;
}

export function createCode(db, item, input = {}, actor = null, tenantId = null, ip = null) {
  if (!item) throw itemNotFound(input.itemId ?? "unknown");
  const governance = getActiveGovernancePolicy(db, item.domain_id);
  const code = validateCodeValue(input.code, governance);
  const codeType = CODE_TYPES.includes(input.code_type) ? input.code_type : "external";
  const status = CODE_STATUSES.includes(input.status) ? input.status : "active";
  const duplicate = queryOne(db, "SELECT id FROM reference_codes WHERE item_id = ? AND code = ? AND code_type = ?", [
    Number(item.id),
    code,
    codeType,
  ]);
  if (duplicate) throw codeConflict(code, { item_id: item.id, code_type: codeType });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_codes
      (code_ref, item_id, domain_id, code, code_type, code_system, external_system, language, is_primary, case_sensitive,
       status, effective_from, effective_to, replacement_item_id, description, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      codeRef(item.id, `${code}_${codeType}`),
      Number(item.id),
      Number(item.domain_id),
      code,
      codeType,
      normalizeText(input.code_system),
      normalizeText(input.external_system),
      normalizeText(input.language),
      input.is_primary ? 1 : 0,
      input.case_sensitive === undefined ? (governance.code_case_sensitive ? 1 : 0) : input.case_sensitive ? 1 : 0,
      status,
      input.effective_from ?? null,
      input.effective_to ?? null,
      input.replacement_item_id ?? null,
      normalizeText(input.description),
      tenantId ?? item.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_codes WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.code.create",
    resourceType: "reference_code",
    resourceId: row.id,
    details: { item_id: item.id, code, code_type: codeType },
    ip,
  });
  emitItemEvent(db, "ReferenceCodeChanged", item, { action: "create", code, code_type: codeType }, actor);
  return publicCode(row);
}

export function updateCode(db, ref, patch = {}, actor = null, ip = null) {
  const row = getCodeRow(db, ref);
  if (!row) throw codeNotFound(ref);
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.code !== undefined) set("code", validateCodeValue(patch.code, getActiveGovernancePolicy(db, row.domain_id)));
  if (patch.code_type !== undefined && CODE_TYPES.includes(patch.code_type)) set("code_type", patch.code_type);
  if (patch.code_system !== undefined) set("code_system", normalizeText(patch.code_system));
  if (patch.external_system !== undefined) set("external_system", normalizeText(patch.external_system));
  if (patch.language !== undefined) set("language", normalizeText(patch.language));
  if (patch.status !== undefined && CODE_STATUSES.includes(patch.status)) set("status", patch.status);
  if (patch.effective_from !== undefined) set("effective_from", patch.effective_from ?? null);
  if (patch.effective_to !== undefined) set("effective_to", patch.effective_to ?? null);
  if (patch.replacement_item_id !== undefined) set("replacement_item_id", patch.replacement_item_id ?? null);
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (!clauses.length) return publicCode(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_codes SET ${clauses.join(", ")} WHERE id = ?`, params);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.code.update",
    resourceType: "reference_code",
    resourceId: row.id,
    details: { item_id: row.item_id, code: row.code },
    ip,
  });
  if (item) emitItemEvent(db, "ReferenceCodeChanged", item, { action: "update", code: row.code }, actor);
  return publicCode(queryOne(db, "SELECT * FROM reference_codes WHERE id = ?", [row.id]));
}

export function deleteCode(db, ref, actor = null, ip = null) {
  const row = getCodeRow(db, ref);
  if (!row) throw codeNotFound(ref);
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  run(db, "DELETE FROM reference_codes WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.code.delete",
    resourceType: "reference_code",
    resourceId: row.id,
    details: { item_id: row.item_id, code: row.code },
    ip,
  });
  if (item) emitItemEvent(db, "ReferenceCodeChanged", item, { action: "delete", code: row.code }, actor);
  return { deleted: true, id: row.id };
}

// Joins items through their code rows. Used by resolution and validation.
export function findItemsByCode(db, domainId, code, { statuses = ["active"], codeSystem = null } = {}) {
  const clauses = ["c.domain_id = ?"];
  const params = [Number(domainId)];
  const text = normalizeText(code);
  clauses.push("(c.code = ? OR UPPER(c.code) = ?)");
  params.push(text, normalizeUpper(code));
  if (statuses && statuses.length) {
    clauses.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (codeSystem) {
    clauses.push("(c.code_system = ? OR c.external_system = ?)");
    params.push(String(codeSystem), String(codeSystem));
  }
  const rows = queryAll(
    db,
    `SELECT i.*, c.code AS matched_code, c.code_type AS matched_code_type, c.code_system AS matched_code_system
     FROM reference_codes c JOIN reference_data_items i ON i.id = c.item_id
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  const dedup = new Map();
  for (const row of rows) dedup.set(row.id, row);
  return [...dedup.values()];
}
