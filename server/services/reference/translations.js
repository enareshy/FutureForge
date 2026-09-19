// Reference translations: localized names and descriptions. Translation is
// governance-gated so domains that are English-only do not pay the cost.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidItem, itemNotFound, translationConflict, translationNotFound } from "./errors.js";
import { normalizeLanguage, normalizeText, TRANSLATION_STATUSES } from "./validation.js";
import { translationRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";
import { getActiveGovernancePolicy } from "./governance.js";

export function publicTranslation(row) {
  if (!row) return null;
  return {
    id: row.id,
    translation_ref: row.translation_ref,
    item_id: row.item_id,
    domain_id: row.domain_id,
    language: row.language,
    name: row.name,
    description: row.description,
    status: row.status,
    source: row.source,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTranslations(db, { itemId, domainId, language, status, limit = 200 } = {}) {
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
  if (language) {
    clauses.push("language = ?");
    params.push(String(language).toLowerCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM reference_translations ${where} ORDER BY language LIMIT ?`, [...params, Math.min(1000, Number(limit) || 200)]);
  return { items: rows.map(publicTranslation), total: rows.length };
}

export function getTranslationRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_translations WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_translations WHERE translation_ref = ?", [String(ref)]) || null;
}

export function upsertTranslation(db, item, input = {}, actor = null, tenantId = null, ip = null) {
  if (!item) throw itemNotFound(input.itemId ?? "unknown");
  const governance = getActiveGovernancePolicy(db, item.domain_id);
  const language = normalizeLanguage(input.language, governance.default_language || "en");
  const existing = queryOne(db, "SELECT * FROM reference_translations WHERE item_id = ? AND language = ?", [Number(item.id), language]);
  const name = normalizeText(input.name, language === governance.default_language ? item.name : item.code);
  const description = normalizeText(input.description);
  const status = TRANSLATION_STATUSES.includes(input.status) ? input.status : "active";
  const source = normalizeText(input.source);
  const ts = nowIso();
  if (existing) {
    run(db, "UPDATE reference_translations SET name = ?, description = ?, status = ?, source = ?, updated_at = ? WHERE id = ?", [
      name,
      description,
      status,
      source,
      ts,
      existing.id,
    ]);
  } else {
    run(
      db,
      `INSERT INTO reference_translations
        (translation_ref, item_id, domain_id, language, name, description, status, source, tenant_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        translationRef(item.id, language),
        Number(item.id),
        Number(item.domain_id),
        language,
        name,
        description,
        status,
        source,
        tenantId ?? item.tenant_id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
  }
  bumpCacheEpoch(db);
  const row = queryOne(db, "SELECT * FROM reference_translations WHERE item_id = ? AND language = ?", [Number(item.id), language]);
  writeAudit(db, {
    actor,
    action: existing ? "reference.translation.update" : "reference.translation.create",
    resourceType: "reference_translation",
    resourceId: row.id,
    details: { item_id: item.id, language },
    ip,
  });
  emitItemEvent(db, "ReferenceTranslationChanged", item, { action: existing ? "update" : "create", language }, actor);
  return publicTranslation(row);
}

export function deleteTranslation(db, ref, actor = null, ip = null) {
  const row = getTranslationRow(db, ref);
  if (!row) throw translationNotFound(ref);
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  run(db, "DELETE FROM reference_translations WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.translation.delete",
    resourceType: "reference_translation",
    resourceId: row.id,
    details: { item_id: row.item_id, language: row.language },
    ip,
  });
  if (item) emitItemEvent(db, "ReferenceTranslationChanged", item, { action: "delete", language: row.language }, actor);
  return { deleted: true, id: row.id };
}

export function findItemsByTranslation(db, domainId, name, { statuses = ["active"], language = null } = {}) {
  const clauses = ["t.domain_id = ?", "LOWER(t.name) = ?"];
  const params = [Number(domainId), String(name).toLowerCase()];
  if (statuses && statuses.length) {
    clauses.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (language) {
    clauses.push("t.language = ?");
    params.push(String(language));
  }
  const rows = queryAll(
    db,
    `SELECT i.*, t.language AS matched_language, t.name AS matched_name
     FROM reference_translations t JOIN reference_data_items i ON i.id = t.item_id
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  const dedup = new Map();
  for (const row of rows) dedup.set(row.id, row);
  return [...dedup.values()];
}

export { translationConflict };
