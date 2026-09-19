// Immutable version history for reference data items. A snapshot captures the
// item plus its codes, aliases, translations, hierarchy edges and cross-domain
// relationships so a governed value can be reconstructed exactly as it was.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { versionNotFound } from "./errors.js";
import { json, normalizeText, parseObject } from "./validation.js";
import { versionRef } from "./refs.js";
import { emitItemEvent } from "./events.js";

export function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    version_ref: row.version_ref,
    item_id: row.item_id,
    domain_id: row.domain_id,
    version_number: row.version_number,
    status: row.status,
    change_summary: row.change_summary,
    snapshot: parseObject(row.snapshot_json, {}),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    versioning_revision_id: row.versioning_revision_id,
    owner_label: row.owner_label,
    steward_label: row.steward_label,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function itemSnapshot(db, item) {
  if (!item) return {};
  return {
    item: {
      id: item.id,
      item_ref: item.item_ref,
      domain_id: item.domain_id,
      code: item.code,
      name: item.name,
      description: item.description,
      status: item.status,
      scope_type: item.scope_type,
      scope_key: item.scope_key,
      is_global: Boolean(item.is_global),
      effective_from: item.effective_from,
      effective_to: item.effective_to,
      sequence: item.sequence,
      is_default: Boolean(item.is_default),
      attributes: parseObject(item.attributes_json, {}),
      metadata: parseObject(item.metadata_json, {}),
    },
    codes: queryAll(db, "SELECT code, code_type, code_system, external_system, language, status FROM reference_codes WHERE item_id = ?", [Number(item.id)]),
    aliases: queryAll(db, "SELECT alias, alias_type, language, source, status FROM reference_aliases WHERE item_id = ?", [Number(item.id)]),
    translations: queryAll(db, "SELECT language, name, description, status FROM reference_translations WHERE item_id = ?", [Number(item.id)]),
    hierarchy: {
      parent_id: item.parent_id ?? null,
      children: queryAll(db, "SELECT child_id, relationship_type, sequence FROM reference_hierarchy WHERE parent_id = ?", [Number(item.id)]),
    },
    relationships: queryAll(
      db,
      "SELECT source_item_id, target_item_id, relationship_type, status FROM reference_relationships WHERE source_item_id = ? OR target_item_id = ?",
      [Number(item.id), Number(item.id)]
    ),
  };
}

export function recordVersion(db, item, { changeSummary = "", versionNumber = null, status = null, effectiveFrom, effectiveTo, versioningRevisionId = null, actor = null } = {}) {
  if (!item) return null;
  const number = Number(versionNumber ?? item.current_version_number ?? 1);
  const snapshot = itemSnapshot(db, item);
  const existing = queryOne(db, "SELECT * FROM reference_data_versions WHERE item_id = ? AND version_number = ?", [Number(item.id), number]);
  const ts = nowIso();
  if (existing) {
    run(db, "UPDATE reference_data_versions SET snapshot_json = ?, change_summary = ?, status = ? WHERE id = ?", [
      JSON.stringify(snapshot),
      changeSummary || existing.change_summary,
      status || existing.status,
      existing.id,
    ]);
    return publicVersion(queryOne(db, "SELECT * FROM reference_data_versions WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    `INSERT INTO reference_data_versions
      (version_ref, item_id, domain_id, version_number, status, change_summary, snapshot_json, effective_from, effective_to, versioning_revision_id, owner_label, steward_label, tenant_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionRef(item.id, number),
      Number(item.id),
      Number(item.domain_id),
      number,
      status || item.status || "draft",
      normalizeText(changeSummary),
      JSON.stringify(snapshot),
      effectiveFrom ?? item.effective_from ?? null,
      effectiveTo ?? item.effective_to ?? null,
      versioningRevisionId ?? item.versioning_revision_id ?? null,
      item.owner_label ?? "",
      item.steward_label ?? "",
      item.tenant_id ?? null,
      actor?.id ?? null,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_data_versions WHERE id = ?", [Number(result.lastInsertRowid)]);
  emitItemEvent(db, "ReferenceItemVersionCreated", item, { version_number: number, change_summary: normalizeText(changeSummary) }, actor);
  return publicVersion(row);
}

export function listVersions(db, itemId, { limit = 100 } = {}) {
  const rows = queryAll(
    db,
    "SELECT * FROM reference_data_versions WHERE item_id = ? ORDER BY version_number DESC LIMIT ?",
    [Number(itemId), Math.min(500, Number(limit) || 100)]
  );
  return { items: rows.map(publicVersion), total: rows.length };
}

export function getVersionRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_data_versions WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_data_versions WHERE version_ref = ?", [String(ref)]) || null;
}

export function getVersion(db, ref) {
  const row = getVersionRow(db, ref);
  if (!row) throw versionNotFound(ref);
  return publicVersion(row);
}

export function compareVersions(db, refA, refB) {
  const a = getVersion(db, refA);
  const b = getVersion(db, refB);
  const aItem = a.snapshot?.item ?? {};
  const bItem = b.snapshot?.item ?? {};
  const fields = ["code", "name", "description", "status", "scope_key", "effective_from", "effective_to", "sequence", "is_default"];
  const changes = [];
  for (const field of fields) {
    if (JSON.stringify(aItem[field] ?? null) !== JSON.stringify(bItem[field] ?? null)) {
      changes.push({ field, from: aItem[field] ?? null, to: bItem[field] ?? null });
    }
  }
  const collection = (key, idAttr) => {
    const toMap = (list) => {
      const map = new Map();
      for (const row of list || []) {
        const key2 = row[idAttr] ?? row.language ?? row.alias ?? row.code;
        map.set(key2, row);
      }
      return map;
    };
    return { from: toMap(a.snapshot?.[key]), to: toMap(b.snapshot?.[key]) };
  };
  const diffs = [];
  for (const [key, idAttr] of [["codes", "code"], ["aliases", "alias"], ["translations", "language"]]) {
    const { from, to } = collection(key, idAttr);
    const keys = new Set([...from.keys(), ...to.keys()]);
    for (const k of keys) {
      if (JSON.stringify(from.get(k) ?? null) !== JSON.stringify(to.get(k) ?? null)) {
        diffs.push({ collection: key, key: k, from: from.get(k) ?? null, to: to.get(k) ?? null });
      }
    }
  }
  return { from: a.version_number, to: b.version_number, changes, collection_changes: diffs };
}

export { json };
