// Unified catalog entry registry.
//
// Every catalog asset (domain, object, attribute, business term, source,
// consumer) owns one row in dc_entries. Type-specific tables hold the detail;
// the registry makes the unified catalog list, classification, ownership,
// lineage and search possible without joining every detail table. Registering
// or updating an entry is the only supported way to change registry state.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertCatalogStatus,
  assertEntryType,
  assertSecurityClassification,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
} from "./validation.js";
import { entryRef } from "./refs.js";
import { publicEntry, publicMetadataVersion } from "./repository.js";
import { entryNotFound, entryConflict, invalidEntry } from "./errors.js";
import { publishCatalogEvent } from "./events.js";

export { publicEntry };

const SUBJECT_TABLES = Object.freeze({
  DOMAIN: "dg_domains",
  OBJECT: "dc_catalog_objects",
  ATTRIBUTE: "dc_catalog_attributes",
  BUSINESS_TERM: "dc_business_terms",
  SOURCE: "dc_sources",
  CONSUMER: "dc_consumers",
  CLASSIFICATION: "dc_classifications",
  LINEAGE: "dc_lineage",
});

export function subjectTableFor(entryType) {
  return SUBJECT_TABLES[entryType] || "";
}

export function getEntryRow(db, ref, { tenantId = null, entryType = null } = {}) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = tenantId
      ? queryOne(db, "SELECT * FROM dc_entries WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  const text = String(ref);
  const clauses = ["entry_ref = ?"];
  const params = [text];
  if (tenantId) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const byRef = queryOne(db, `SELECT * FROM dc_entries WHERE ${clauses.join(" AND ")}`, params);
  if (byRef) return byRef;
  if (entryType) {
    const code = normalizeUpper(text);
    const scoped = tenantId ? " AND tenant_id = ?" : "";
    const scopeParams = tenantId ? [Number(tenantId)] : [];
    return queryOne(db, `SELECT * FROM dc_entries WHERE entry_type = ? AND code = ?${scoped}`, [
      assertEntryType(String(entryType)),
      code,
      ...scopeParams,
    ]);
  }
  return null;
}

export function requireEntry(db, ref, options = {}) {
  const row = getEntryRow(db, ref, options);
  if (!row) throw entryNotFound(ref);
  return row;
}

export function getEntry(db, ref, options = {}) {
  return publicEntry(requireEntry(db, ref, options));
}

export function findEntryBySubject(db, tenantId, subjectTable, subjectId) {
  return queryOne(db, "SELECT * FROM dc_entries WHERE tenant_id = ? AND subject_table = ? AND subject_id = ?", [
    Number(tenantId),
    String(subjectTable),
    Number(subjectId),
  ]);
}

export function findEntryByCode(db, tenantId, entryType, code) {
  return queryOne(db, "SELECT * FROM dc_entries WHERE tenant_id = ? AND entry_type = ? AND code = ?", [
    Number(tenantId),
    assertEntryType(String(entryType)),
    normalizeUpper(code),
  ]);
}

// Registers a registry row for a type-specific asset. Callers pass the owning
// subject table/id when known; the entry ref is generated once and never
// changes so lineage, audit and external references stay stable.
export function registerEntry(
  db,
  input = {},
  actor = null,
  tenantId = null,
  ip = null,
  { publish = false } = {}
) {
  const entryType = assertEntryType(normalizeUpper(input.entry_type || input.type));
  const code = normalizeUpper(input.code);
  if (!code) throw invalidEntry("An entry code is required", { entry_type: entryType });
  const existing = findEntryByCode(db, tenantId, entryType, code);
  if (existing) return publicEntry(existing);

  const status = assertCatalogStatus(normalizeText(input.status).toLowerCase() || "active");
  const classification = assertSecurityClassification(normalizeText(input.classification).toLowerCase() || "internal");
  const ts = nowIso();
  const ref = normalizeText(input.entry_ref) || entryRef(entryType, code);
  const result = run(
    db,
    `INSERT INTO dc_entries
      (entry_ref, tenant_id, organization_id, entry_type, subject_table, subject_id, domain_id, source_id,
       code, name, display_name, description, classification, owner_user_id, owner_group_id,
       steward_user_id, steward_group_id, version, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      ref,
      Number(tenantId),
      input.organization_id ?? null,
      entryType,
      normalizeText(input.subject_table) || subjectTableFor(entryType),
      input.subject_id ?? null,
      input.domain_id ? Number(input.domain_id) : null,
      input.source_id ? Number(input.source_id) : null,
      code,
      normalizeText(input.name) || code,
      normalizeText(input.display_name),
      normalizeText(input.description),
      classification,
      input.owner_user_id ?? null,
      input.owner_group_id ?? null,
      input.steward_user_id ?? null,
      input.steward_group_id ?? null,
      status,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [Number(result.lastInsertRowid)]);
  appendMetadataVersion(db, row, { change_summary: "entry created" }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.entry.register",
    resourceType: "dc_entry",
    resourceId: row.id,
    details: { entry_type: entryType, code },
    ip,
  });
  if (publish) {
    publishCatalogEvent(db, {
      eventType: "CatalogObjectCreated",
      tenantId: Number(tenantId),
      objectType: "data_catalog_entry",
      objectId: row.id,
      payload: { id: row.id, entry_type: entryType, code, entry_ref: row.entry_ref },
    }, actor);
  }
  return publicEntry(row);
}

export function linkEntrySubject(db, entryId, { subjectTable, subjectId } = {}) {
  const row = queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [Number(entryId)]);
  if (!row) throw entryNotFound(entryId);
  run(db, "UPDATE dc_entries SET subject_table = ?, subject_id = ?, updated_at = ? WHERE id = ?", [
    subjectTable ? String(subjectTable) : row.subject_table,
    subjectId ?? row.subject_id,
    nowIso(),
    row.id,
  ]);
  return queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [row.id]);
}

// Denormalized fields (name, description, classification, ownership, status)
// are mirrored onto the registry whenever the owning asset changes so the
// unified catalog list stays a single-table read.
export function syncEntry(db, entryId, patch = {}, actor = null) {
  const row = queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [Number(entryId)]);
  if (!row) throw entryNotFound(entryId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.code);
  if (patch.display_name !== undefined) assign("display_name", normalizeText(patch.display_name));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.source_id !== undefined) assign("source_id", patch.source_id === null ? null : Number(patch.source_id));
  if (patch.classification !== undefined) {
    assign("classification", assertSecurityClassification(normalizeText(patch.classification).toLowerCase() || "internal"));
  }
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.owner_group_id !== undefined) assign("owner_group_id", patch.owner_group_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (patch.steward_group_id !== undefined) assign("steward_group_id", patch.steward_group_id ?? null);
  if (patch.status !== undefined) assign("status", assertCatalogStatus(normalizeText(patch.status).toLowerCase() || row.status));
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return row;
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_entries SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [row.id]);
}

// Bumps the entry version and appends an immutable snapshot. Called on every
// governance-significant mutation so audit can reconstruct any prior state.
export function appendMetadataVersion(db, entryRow, { change_summary = "" } = {}, actor = null) {
  const nextVersion = Number(entryRow.version || 1);
  const snapshot = {
    entry_ref: entryRow.entry_ref,
    entry_type: entryRow.entry_type,
    code: entryRow.code,
    name: entryRow.name,
    display_name: entryRow.display_name,
    description: entryRow.description,
    classification: entryRow.classification,
    domain_id: entryRow.domain_id,
    status: entryRow.status,
    metadata: parseObject(entryRow.metadata_json, {}),
  };
  const existing = queryOne(db, "SELECT id FROM dc_metadata_versions WHERE entry_id = ? AND version = ?", [entryRow.id, nextVersion]);
  if (!existing) {
    run(
      db,
      "INSERT INTO dc_metadata_versions (tenant_id, entry_id, version, snapshot_json, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [entryRow.tenant_id, entryRow.id, nextVersion, JSON.stringify(snapshot), normalizeText(change_summary, { max: 500 }), actor?.id ?? null, nowIso()]
    );
  }
  return nextVersion;
}

export function commitEntryChange(db, entryId, { change_summary = "", patch = {} } = {}, actor = null) {
  let row = queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [Number(entryId)]);
  if (!row) throw entryNotFound(entryId);
  if (Object.keys(patch).length) row = syncEntry(db, row.id, patch, actor);
  const nextVersion = Number(row.version || 1) + 1;
  run(db, "UPDATE dc_entries SET version = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    nextVersion,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  const updated = queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [row.id]);
  appendMetadataVersion(db, updated, { change_summary }, actor);
  return publicEntry(updated);
}

export function listMetadataVersions(db, entryRefValue, { tenantId = null } = {}) {
  const entry = requireEntry(db, entryRefValue, { tenantId });
  return queryAll(db, "SELECT * FROM dc_metadata_versions WHERE entry_id = ? ORDER BY version DESC", [entry.id]).map(
    publicMetadataVersion
  );
}

export function setEntryStatus(db, entryRefValue, status, actor = null, ip = null) {
  const row = requireEntry(db, entryRefValue);
  const next = assertCatalogStatus(normalizeText(status).toLowerCase() || row.status);
  run(db, "UPDATE dc_entries SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.entry.status",
    resourceType: "dc_entry",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicEntry(queryOne(db, "SELECT * FROM dc_entries WHERE id = ?", [row.id]));
}

export function listEntries(
  db,
  { tenantId, entryType, status, domainId, sourceId, classification, q, page, pageSize, ownerUserId, stewardUserId } = {}
) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (entryType) {
    clauses.push("entry_type = ?");
    params.push(assertEntryType(normalizeUpper(entryType)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (sourceId) {
    clauses.push("source_id = ?");
    params.push(Number(sourceId));
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(assertSecurityClassification(normalizeText(classification).toLowerCase()));
  }
  if (ownerUserId) {
    clauses.push("owner_user_id = ?");
    params.push(Number(ownerUserId));
  }
  if (stewardUserId) {
    clauses.push("steward_user_id = ?");
    params.push(Number(stewardUserId));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(display_name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_entries ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dc_entries ${where} ORDER BY entry_type, code LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map(publicEntry), total, page: currentPage, page_size: limit };
}

export function countEntries(db, { tenantId, entryType = null, status = null } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (entryType) {
    clauses.push("entry_type = ?");
    params.push(assertEntryType(normalizeUpper(entryType)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  return Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_entries WHERE ${clauses.join(" AND ")}`, params)?.c ?? 0);
}

export function entryTypeCounts(db, tenantId) {
  return queryAll(db, "SELECT entry_type, status, COUNT(*) AS c FROM dc_entries WHERE tenant_id = ? GROUP BY entry_type, status", [
    Number(tenantId),
  ]).map((row) => ({ entry_type: row.entry_type, status: row.status, count: Number(row.c) }));
}

export { entryConflict, invalidEntry };
