// Catalog classifications and classification assignments.
//
// A catalog classification is a business/regulatory label (PII, Financial,
// Export Controlled...) that is optionally bound to one of the P0 Data Security
// model's security classifications. Assigning a classification to an entry
// records the label and, when the classification carries a security binding,
// updates the entry's effective security classification so search, dashboards
// and audits inherit it.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertCatalogStatus,
  assertClassificationCategory,
  assertSecurityClassification,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
} from "./validation.js";
import { classificationRef } from "./refs.js";
import { publicClassification, publicClassificationAssignment } from "./repository.js";
import { classificationNotFound, classificationConflict, invalidClassification } from "./errors.js";
import { requireEntry, syncEntry, commitEntryChange, getEntryRow } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicClassification, publicClassificationAssignment };

export function getClassificationRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_classifications WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_classifications WHERE id = ?", [numeric]);
  }
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  const text = String(ref);
  return (
    queryOne(db, `SELECT * FROM dc_classifications WHERE classification_ref = ?${scoped}`, [text, ...(tenantId ? [Number(tenantId)] : [])]) ||
    queryOne(db, `SELECT * FROM dc_classifications WHERE code = ?${scoped}`, [normalizeUpper(text), ...(tenantId ? [Number(tenantId)] : [])]) ||
    null
  );
}

export function requireClassification(db, ref, tenantId = null) {
  const row = getClassificationRow(db, ref, tenantId);
  if (!row) throw classificationNotFound(ref);
  return row;
}

export function listClassifications(db, { tenantId, category, securityClassification, status, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (category) {
    clauses.push("category = ?");
    params.push(assertClassificationCategory(normalizeLower(category)));
  }
  if (securityClassification) {
    clauses.push("security_classification = ?");
    params.push(assertSecurityClassification(normalizeLower(securityClassification)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status) === "inactive" ? "inactive" : "active");
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_classifications ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_classifications ${where} ORDER BY category, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicClassification), total, page: currentPage, page_size: limit };
}

export function createClassification(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(normalizeText(input.code));
  if (!code) throw invalidClassification("A classification code is required");
  const existing = queryOne(db, "SELECT id FROM dc_classifications WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  if (existing) throw classificationConflict(code);
  const category = assertClassificationCategory(normalizeLower(input.category || "business"));
  const securityClassification = assertSecurityClassification(normalizeLower(input.security_classification || "internal"));
  const ts = nowIso();
  const result = run(
    db,
    "INSERT INTO dc_classifications (classification_ref, tenant_id, code, name, category, security_classification, description, status, metadata_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      classificationRef(code),
      Number(tenantId),
      code,
      normalizeText(input.name) || code,
      category,
      securityClassification,
      normalizeText(input.description),
      normalizeLower(input.status || "active") === "inactive" ? "inactive" : "active",
      JSON.stringify(parseObject(input.metadata, {})),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_classifications WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_catalog.classification.create",
    resourceType: "dc_classification",
    resourceId: row.id,
    details: { code, category, security_classification: securityClassification },
    ip,
  });
  return publicClassification(row);
}

export function updateClassification(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireClassification(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.code);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.category !== undefined) assign("category", assertClassificationCategory(normalizeLower(patch.category)));
  if (patch.security_classification !== undefined) assign("security_classification", assertSecurityClassification(normalizeLower(patch.security_classification)));
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return publicClassification(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_classifications SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_classifications WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.classification.update",
    resourceType: "dc_classification",
    resourceId: row.id,
    details: { code: updated.code, fields: Object.keys(patch) },
    ip,
  });
  return publicClassification(updated);
}

export function setClassificationStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireClassification(db, ref, tenantId);
  const next = normalizeLower(status) === "inactive" ? "inactive" : "active";
  run(db, "UPDATE dc_classifications SET status = ?, updated_at = ? WHERE id = ?", [next, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.classification.status",
    resourceType: "dc_classification",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicClassification(queryOne(db, "SELECT * FROM dc_classifications WHERE id = ?", [row.id]));
}

export function listClassificationAssignments(db, { tenantId, entryId, classificationCode, securityClassification } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (entryId !== undefined && entryId !== null && entryId !== "") {
    clauses.push("entry_id = ?");
    params.push(Number(entryId));
  }
  if (classificationCode) {
    clauses.push("classification_code = ?");
    params.push(normalizeUpper(classificationCode));
  }
  if (securityClassification) {
    clauses.push("security_classification = ?");
    params.push(assertSecurityClassification(normalizeLower(securityClassification)));
  }
  return queryAll(
    db,
    `SELECT * FROM dc_classification_assignments WHERE ${clauses.join(" AND ")} ORDER BY classification_code`,
    params
  ).map(publicClassificationAssignment);
}

export function assignClassification(db, entryRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const entry = requireEntry(db, entryRefValue, { tenantId });
  const classification = requireClassification(db, input.classification_id ?? input.classification_code ?? input.classification, entry.tenant_id);
  const securityClassification = assertSecurityClassification(
    normalizeLower(input.security_classification || classification.security_classification)
  );
  const ts = nowIso();
  const existing = queryOne(db, "SELECT * FROM dc_classification_assignments WHERE tenant_id = ? AND entry_id = ? AND classification_code = ?", [
    entry.tenant_id,
    entry.id,
    classification.code,
  ]);
  let assignmentId;
  if (existing) {
    run(
      db,
      "UPDATE dc_classification_assignments SET classification_id = ?, security_classification = ?, assigned_by = ?, assigned_at = ? WHERE id = ?",
      [classification.id, securityClassification, actor?.id ?? null, ts, existing.id]
    );
    assignmentId = existing.id;
  } else {
    const result = run(
      db,
      "INSERT INTO dc_classification_assignments (tenant_id, entry_id, classification_id, classification_code, security_classification, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [entry.tenant_id, entry.id, classification.id, classification.code, securityClassification, actor?.id ?? null, ts]
    );
    assignmentId = Number(result.lastInsertRowid);
  }
  // The entry carries the strongest (highest-ranked) bound classification so
  // security-aware consumers see a single effective value.
  const assignments = listClassificationAssignments(db, { tenantId: entry.tenant_id, entryId: entry.id });
  const effective = highestSecurityClassification(assignments.map((item) => item.security_classification), entry.classification);
  syncEntry(db, entry.id, { classification: effective }, actor);
  commitEntryChange(db, entry.id, { change_summary: `classification assigned: ${classification.code}` }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.classification.assign",
    resourceType: "dc_classification_assignment",
    resourceId: assignmentId,
    details: { entry_id: entry.id, classification_code: classification.code, security_classification: securityClassification },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogClassificationChanged",
    tenantId: entry.tenant_id,
    objectType: "data_catalog_entry",
    objectId: entry.id,
    payload: { entry_id: entry.id, classification_code: classification.code, security_classification: securityClassification, action: "assigned" },
  }, actor);
  return publicClassificationAssignment(queryOne(db, "SELECT * FROM dc_classification_assignments WHERE id = ?", [assignmentId]));
}

export function removeClassificationAssignment(db, entryRefValue, classificationCode, actor = null, tenantId = null, ip = null) {
  const entry = requireEntry(db, entryRefValue, { tenantId });
  const code = normalizeUpper(classificationCode);
  const row = queryOne(db, "SELECT * FROM dc_classification_assignments WHERE tenant_id = ? AND entry_id = ? AND classification_code = ?", [
    entry.tenant_id,
    entry.id,
    code,
  ]);
  if (!row) throw classificationNotFound(`${entry.entry_ref}:${code}`);
  run(db, "DELETE FROM dc_classification_assignments WHERE id = ?", [row.id]);
  const assignments = listClassificationAssignments(db, { tenantId: entry.tenant_id, entryId: entry.id });
  const effective = highestSecurityClassification(assignments.map((item) => item.security_classification), "internal");
  syncEntry(db, entry.id, { classification: effective }, actor);
  commitEntryChange(db, entry.id, { change_summary: `classification removed: ${code}` }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.classification.unassign",
    resourceType: "dc_classification_assignment",
    resourceId: row.id,
    details: { entry_id: entry.id, classification_code: code },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogClassificationChanged",
    tenantId: entry.tenant_id,
    objectType: "data_catalog_entry",
    objectId: entry.id,
    payload: { entry_id: entry.id, classification_code: code, action: "removed" },
  }, actor);
  return { deleted: true, id: row.id };
}

const SECURITY_RANK = Object.freeze({ public: 0, internal: 1, confidential: 2, restricted: 3 });

function highestSecurityClassification(values, fallback) {
  let best = SECURITY_RANK[fallback] !== undefined ? fallback : "internal";
  for (const value of values) {
    if (SECURITY_RANK[value] !== undefined && SECURITY_RANK[value] > SECURITY_RANK[best]) best = value;
  }
  return best;
}

export function classificationsForEntry(db, entryId, tenantId) {
  return listClassificationAssignments(db, { tenantId, entryId });
}

export function entriesForClassification(db, tenantId, classificationCode) {
  const code = normalizeUpper(classificationCode);
  const rows = queryAll(
    db,
    `SELECT e.* FROM dc_classification_assignments a JOIN dc_entries e ON e.id = a.entry_id
      WHERE a.tenant_id = ? AND a.classification_code = ? ORDER BY e.entry_type, e.code`,
    [Number(tenantId), code]
  );
  return rows;
}

export { classificationConflict, invalidClassification, getEntryRow };
