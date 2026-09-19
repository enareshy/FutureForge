// Reference aliases: synonyms, abbreviations, external names and legacy names
// used for search and inbound integration. Aliases are governance-gated.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { aliasConflict, aliasNotFound, invalidItem, itemNotFound } from "./errors.js";
import { ALIAS_TYPES, normalizeText } from "./validation.js";
import { aliasRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";
import { getActiveGovernancePolicy } from "./governance.js";

export function publicAlias(row) {
  if (!row) return null;
  return {
    id: row.id,
    alias_ref: row.alias_ref,
    item_id: row.item_id,
    domain_id: row.domain_id,
    alias: row.alias,
    alias_type: row.alias_type,
    language: row.language,
    source: row.source,
    scope_key: row.scope_key,
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listAliases(db, { itemId, domainId, alias, aliasType, language, status, limit = 200 } = {}) {
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
  if (alias) {
    clauses.push("LOWER(alias) LIKE ?");
    params.push(`%${String(alias).toLowerCase()}%`);
  }
  if (aliasType) {
    clauses.push("alias_type = ?");
    params.push(String(aliasType));
  }
  if (language) {
    clauses.push("language = ?");
    params.push(String(language));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM reference_aliases ${where} ORDER BY alias LIMIT ?`, [...params, Math.min(1000, Number(limit) || 200)]);
  return { items: rows.map(publicAlias), total: rows.length };
}

export function getAliasRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_aliases WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_aliases WHERE alias_ref = ?", [String(ref)]) || null;
}

export function createAlias(db, item, input = {}, actor = null, tenantId = null, ip = null) {
  if (!item) throw itemNotFound(input.itemId ?? "unknown");
  const governance = getActiveGovernancePolicy(db, item.domain_id);
  if (governance.alias_enabled === false) throw invalidItem("Aliases are disabled for this domain by governance");
  const alias = normalizeText(input.alias);
  if (!alias) throw invalidItem("alias is required");
  const language = normalizeText(input.language).toLowerCase();
  const duplicate = queryOne(db, "SELECT id FROM reference_aliases WHERE item_id = ? AND language = ? AND alias = ?", [
    Number(item.id),
    language,
    alias,
  ]);
  if (duplicate) throw aliasConflict(alias, { item_id: item.id, language });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_aliases
      (alias_ref, item_id, domain_id, alias, alias_type, language, source, scope_key, status, effective_from, effective_to, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      aliasRef(item.id, `${alias}_${language}`),
      Number(item.id),
      Number(item.domain_id),
      alias,
      ALIAS_TYPES.includes(input.alias_type) ? input.alias_type : "synonym",
      language,
      normalizeText(input.source),
      normalizeText(input.scope_key, item.scope_key || "GLOBAL"),
      input.status === "inactive" ? "inactive" : "active",
      input.effective_from ?? null,
      input.effective_to ?? null,
      tenantId ?? item.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_aliases WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.alias.create",
    resourceType: "reference_alias",
    resourceId: row.id,
    details: { item_id: item.id, alias, language },
    ip,
  });
  emitItemEvent(db, "ReferenceAliasChanged", item, { action: "create", alias }, actor);
  return publicAlias(row);
}

export function updateAlias(db, ref, patch = {}, actor = null, ip = null) {
  const row = getAliasRow(db, ref);
  if (!row) throw aliasNotFound(ref);
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.alias !== undefined) set("alias", normalizeText(patch.alias));
  if (patch.alias_type !== undefined && ALIAS_TYPES.includes(patch.alias_type)) set("alias_type", patch.alias_type);
  if (patch.language !== undefined) set("language", normalizeText(patch.language).toLowerCase());
  if (patch.source !== undefined) set("source", normalizeText(patch.source));
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (patch.effective_from !== undefined) set("effective_from", patch.effective_from ?? null);
  if (patch.effective_to !== undefined) set("effective_to", patch.effective_to ?? null);
  if (!clauses.length) return publicAlias(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_aliases SET ${clauses.join(", ")} WHERE id = ?`, params);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.alias.update",
    resourceType: "reference_alias",
    resourceId: row.id,
    details: { item_id: row.item_id, alias: row.alias },
    ip,
  });
  if (item) emitItemEvent(db, "ReferenceAliasChanged", item, { action: "update", alias: row.alias }, actor);
  return publicAlias(queryOne(db, "SELECT * FROM reference_aliases WHERE id = ?", [row.id]));
}

export function deleteAlias(db, ref, actor = null, ip = null) {
  const row = getAliasRow(db, ref);
  if (!row) throw aliasNotFound(ref);
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  run(db, "DELETE FROM reference_aliases WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.alias.delete",
    resourceType: "reference_alias",
    resourceId: row.id,
    details: { item_id: row.item_id, alias: row.alias },
    ip,
  });
  if (item) emitItemEvent(db, "ReferenceAliasChanged", item, { action: "delete", alias: row.alias }, actor);
  return { deleted: true, id: row.id };
}

export function findItemsByAlias(db, domainId, alias, { statuses = ["active"], language = null } = {}) {
  const clauses = ["a.domain_id = ?", "LOWER(a.alias) = ?"];
  const params = [Number(domainId), String(alias).toLowerCase()];
  if (statuses && statuses.length) {
    clauses.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (language) {
    clauses.push("(a.language = ? OR a.language = '')");
    params.push(String(language));
  }
  const rows = queryAll(
    db,
    `SELECT i.*, a.alias AS matched_alias, a.alias_type AS matched_alias_type
     FROM reference_aliases a JOIN reference_data_items i ON i.id = a.item_id
     WHERE ${clauses.join(" AND ")} AND a.status = 'active'`,
    params
  );
  const dedup = new Map();
  for (const row of rows) dedup.set(row.id, row);
  return [...dedup.values()];
}
