// Legal holds.
//
// A legal hold is a first-class record that suspends archive, purge and deletion
// for the objects it covers. Holds are scoped explicitly (object/object set) or
// by rule (object type, organization, plant, classification, business domain) so
// millions of ids are never materialised. Holds always override purge
// eligibility.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { legalHoldRef } from "./refs.js";
import { publicLegalHold } from "./repository.js";
import { invalidLegalHold, legalHoldConflict, legalHoldNotFound } from "./errors.js";
import {
  assertLegalHoldScope,
  assertTenantId,
  dateOnly,
  normalizeText,
  normalizeUpper,
  paginate,
  parseDate,
} from "./validation.js";
import { recordHistory } from "./history.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLegalHold } from "./notifications.js";

export { publicLegalHold };

export function getLegalHoldRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_legal_holds WHERE tenant_id = ? AND (hold_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    normalizeUpper(ref),
    String(ref),
  ]);
}

export function requireLegalHold(db, tenantId, ref) {
  const row = getLegalHoldRow(db, tenantId, ref);
  if (!row) throw legalHoldNotFound(ref);
  return row;
}

export function getLegalHold(db, tenantId, ref) {
  const row = requireLegalHold(db, tenantId, ref);
  return publicLegalHold(row, {
    objectIds: listHoldObjects(db, row.id),
    scopes: listHoldScopes(db, row.id),
  });
}

export function listHoldObjects(db, holdId) {
  return queryAll(db, "SELECT object_type, object_id FROM lc_legal_hold_objects WHERE hold_id = ? ORDER BY id", [Number(holdId)]).map((row) => ({
    object_type: row.object_type,
    object_id: String(row.object_id),
  }));
}

export function listHoldScopes(db, holdId) {
  return queryAll(db, "SELECT scope_type, scope_value FROM lc_legal_hold_scopes WHERE hold_id = ? ORDER BY id", [Number(holdId)]).map((row) => ({
    scope_type: row.scope_type,
    scope_value: row.scope_value,
  }));
}

export function listLegalHolds(db, { tenantId, status, scopeType, objectType, organizationId, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(assertLegalHoldScope(scopeType));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (organizationId) {
    clauses.push("organization_id = ?");
    params.push(Number(organizationId));
  }
  const term = normalizeText(q, { max: 200 });
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR reason LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_legal_holds ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_legal_holds ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicLegalHold(row)), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createLegalHold(db, tenantId, input = {}, actor = null, ip = null) {
  const tid = assertTenantId(tenantId);
  const code = normalizeUpper(input.code || input.hold_code);
  if (!/^[A-Z][A-Z0-9_.-]{1,63}$/.test(code)) throw invalidLegalHold("A legal-hold code (2-64 uppercase characters) is required");
  if (queryOne(db, "SELECT id FROM lc_legal_holds WHERE tenant_id = ? AND code = ?", [Number(tid), code])) throw legalHoldConflict(code);
  const scopeType = assertLegalHoldScope(input.scope_type || input.scopeType || "OBJECT");
  const objectType = normalizeText(input.object_type || input.objectType, { max: 120 });
  const startDate = input.start_date || input.startDate || null;
  const endDate = input.end_date || input.endDate || null;
  if (startDate && endDate && parseDate(startDate) && parseDate(endDate) && parseDate(endDate).getTime() < parseDate(startDate).getTime()) {
    throw invalidLegalHold("end_date cannot precede start_date");
  }
  const objectIds = Array.isArray(input.object_ids || input.objectIds) ? input.object_ids || input.objectIds : [];
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];
  if (scopeType === "OBJECT" && !objectIds.length && !scopes.length && input.object_id === undefined) {
    throw invalidLegalHold("An OBJECT legal hold requires at least one object");
  }

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_legal_holds (hold_ref, tenant_id, code, name, reason, description, scope_type, object_type, organization_id, plant_id, classification, business_domain, status, start_date, end_date, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
    [
      legalHoldRef(code),
      tid,
      code,
      normalizeText(input.name) || code,
      normalizeText(input.reason),
      normalizeText(input.description),
      scopeType,
      objectType,
      input.organization_id ?? input.organizationId ?? null,
      input.plant_id ?? input.plantId ?? null,
      normalizeText(input.classification, { max: 120 }).toUpperCase(),
      normalizeText(input.business_domain || input.businessDomain, { max: 120 }).toUpperCase(),
      startDate,
      endDate,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const holdId = Number(result.lastInsertRowid);

  const targets = [...objectIds];
  if (input.object_id !== undefined && input.object_id !== null && String(input.object_id) !== "") {
    targets.push({ object_type: objectType || input.object_type, object_id: input.object_id });
  }
  for (const target of targets) {
    const holderType = normalizeText(target.object_type || objectType || input.object_type, { max: 120 });
    const holderId = target.object_id ?? target.objectId ?? target;
    if (!holderType || holderId === undefined || holderId === null) continue;
    run(
      db,
      "INSERT OR IGNORE INTO lc_legal_hold_objects (hold_id, tenant_id, object_type, object_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [holdId, tid, holderType, String(holderId), ts]
    );
    syncObjectHoldStatus(db, tid, holderType, holderId);
  }
  for (const scope of scopes) {
    const scopeValue = normalizeText(scope.scope_value ?? scope.scopeValue ?? scope.value, { max: 200 });
    run(
      db,
      "INSERT INTO lc_legal_hold_scopes (hold_id, tenant_id, scope_type, scope_value, created_at) VALUES (?, ?, ?, ?, ?)",
      [holdId, tid, assertLegalHoldScope(scope.scope_type || scope.scopeType), scopeValue, ts]
    );
  }

  const row = queryOne(db, "SELECT * FROM lc_legal_holds WHERE id = ?", [holdId]);
  writeAudit(db, {
    actor,
    action: "data_lifecycle.legal_hold.create",
    resourceType: "lc_legal_holds",
    resourceId: row.hold_ref,
    details: { code, scope_type: scopeType, object_type: objectType, objects: targets.length },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType: objectType || "LEGAL_HOLD",
    objectId: row.hold_ref,
    action: "LEGAL_HOLD_CREATED",
    reason: row.reason,
    details: { code, scope_type: scopeType },
    actor,
  });
  publishLifecycleEvent(db, { eventType: "LegalHoldCreated", tenantId: tid, objectType: "legal_hold", objectId: row.hold_ref, payload: { code, scope_type: scopeType } }, actor);
  notifyLegalHold(db, row, { actor });
  return publicLegalHold(row, { objectIds: listHoldObjects(db, holdId), scopes: listHoldScopes(db, holdId) });
}

function release(db, tid, ref, status, reason, actor, ip) {
  const row = requireLegalHold(db, tid, ref);
  if (row.status !== "ACTIVE") {
    return publicLegalHold(row, { objectIds: listHoldObjects(db, row.id), scopes: listHoldScopes(db, row.id) });
  }
  const ts = nowIso();
  run(db, "UPDATE lc_legal_holds SET status = ?, released_by = ?, released_at = ?, release_reason = ?, updated_at = ? WHERE id = ?", [
    status,
    actor?.id ?? null,
    ts,
    normalizeText(reason),
    ts,
    row.id,
  ]);
  const affected = listHoldObjects(db, row.id);
  for (const target of affected) {
    syncObjectHoldStatus(db, tid, target.object_type, target.object_id);
  }
  const updated = queryOne(db, "SELECT * FROM lc_legal_holds WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "data_lifecycle.legal_hold.release", resourceType: "lc_legal_holds", resourceId: row.hold_ref, details: { status, reason }, ip });
  recordHistory(db, {
    tenantId: tid,
    objectType: row.object_type || "LEGAL_HOLD",
    objectId: row.hold_ref,
    action: "LEGAL_HOLD_RELEASED",
    reason,
    details: { status },
    actor,
  });
  publishLifecycleEvent(db, { eventType: "LegalHoldReleased", tenantId: tid, objectType: "legal_hold", objectId: row.hold_ref, payload: { code: row.code, status } }, actor);
  notifyLegalHold(db, updated, { released: true, actor });
  return publicLegalHold(updated, { objectIds: listHoldObjects(db, row.id), scopes: listHoldScopes(db, row.id) });
}

export function releaseLegalHold(db, tenantId, ref, { reason = "", actor = null, ip = null } = {}) {
  return release(db, assertTenantId(tenantId), ref, "RELEASED", reason, actor, ip);
}

export function cancelLegalHold(db, tenantId, ref, { reason = "", actor = null, ip = null } = {}) {
  return release(db, assertTenantId(tenantId), ref, "CANCELLED", reason, actor, ip);
}

// Refresh the cached hold flag on the ledger row so list filters stay cheap.
export function syncObjectHoldStatus(db, tenantId, objectType, objectId) {
  const holds = activeHoldsForObject(db, { tenantId, objectType, objectId });
  const ledger = queryOne(db, "SELECT id FROM lc_object_lifecycle WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);
  if (!ledger) return null;
  run(db, "UPDATE lc_object_lifecycle SET legal_hold_status = ?, updated_at = ? WHERE id = ?", [
    holds.length ? "ACTIVE" : "NONE",
    nowIso(),
    ledger.id,
  ]);
  return holds.length ? "ACTIVE" : "NONE";
}

function holdMatches(hold, target, heldObjectIds, scopes) {
  const scopeType = hold.scope_type;
  const t = (v) => normalizeUpper(v);
  if (scopeType === "OBJECT" || scopeType === "OBJECT_SET") {
    if (heldObjectIds.has(hold.id)) return { reason: "object_in_hold" };
    return null;
  }
  if (scopeType === "OBJECT_TYPE") {
    if (t(hold.object_type) && t(hold.object_type) === t(target.objectType)) return { reason: "object_type_matches" };
    return null;
  }
  if (scopeType === "ORGANIZATION") {
    if (hold.organization_id && Number(hold.organization_id) === Number(target.organizationId ?? 0)) return { reason: "organization_matches" };
    return null;
  }
  if (scopeType === "PLANT") {
    if (hold.plant_id && Number(hold.plant_id) === Number(target.plantId ?? 0)) return { reason: "plant_matches" };
    return null;
  }
  if (scopeType === "CLASSIFICATION") {
    if (hold.classification && t(hold.classification) === t(target.classification)) return { reason: "classification_matches" };
    return null;
  }
  if (scopeType === "BUSINESS_DOMAIN") {
    if (hold.business_domain && t(hold.business_domain) === t(target.businessDomain)) return { reason: "business_domain_matches" };
    return null;
  }
  // Rule-based scopes supplement the hold's own columns.
  for (const scope of scopes) {
    if (Number(scope.hold_id) !== Number(hold.id)) continue;
    if (scope.scope_type === "OBJECT_TYPE" && t(scope.scope_value) === t(target.objectType)) return { reason: "scope_object_type" };
    if (scope.scope_type === "CLASSIFICATION" && t(scope.scope_value) === t(target.classification)) return { reason: "scope_classification" };
    if (scope.scope_type === "BUSINESS_DOMAIN" && t(scope.scope_value) === t(target.businessDomain)) return { reason: "scope_business_domain" };
  }
  return null;
}

// Returns the active holds covering an object, with an explanation per hold.
export function activeHoldsForObject(db, { tenantId, objectType, objectId = null, organizationId = null, plantId = null, classification = "", businessDomain = "" } = {}) {
  const tid = Number(tenantId);
  const holds = queryAll(db, "SELECT * FROM lc_legal_holds WHERE tenant_id = ? AND status = 'ACTIVE'", [tid]);
  if (!holds.length) return [];
  const heldObjectIds = new Set();
  if (objectType && objectId !== null && objectId !== undefined) {
    for (const row of queryAll(db, "SELECT hold_id FROM lc_legal_hold_objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
      tid,
      normalizeText(objectType, { max: 120 }),
      String(objectId),
    ])) {
      heldObjectIds.add(Number(row.hold_id));
    }
  }
  const scopes = queryAll(db, "SELECT * FROM lc_legal_hold_scopes WHERE tenant_id = ?", [tid]);
  const now = nowIso();
  const target = { objectType, organizationId, plantId, classification, businessDomain };
  const active = [];
  for (const hold of holds) {
    if (hold.start_date && parseDate(hold.start_date) && parseDate(hold.start_date).getTime() > parseDate(now).getTime()) continue;
    if (hold.end_date && parseDate(hold.end_date) && parseDate(hold.end_date).getTime() < parseDate(now).getTime()) continue;
    const match = holdMatches(hold, target, heldObjectIds, scopes);
    if (match) active.push({ ...publicLegalHold(hold), match_reason: match.reason });
  }
  return active;
}

// Maintenance: expire holds whose end_date has passed when auto-expiry is on.
export function expireLegalHolds(db, { tenantId = null, limit = 500 } = {}) {
  const today = dateOnly(nowIso());
  const clauses = ["status = 'ACTIVE'", "end_date IS NOT NULL", "end_date <> ''", "end_date < ?"];
  const params = [today];
  if (tenantId) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const rows = queryAll(db, `SELECT * FROM lc_legal_holds WHERE ${clauses.join(" AND ")} LIMIT ?`, [...params, Number(limit) || 500]);
  let expired = 0;
  for (const row of rows) {
    run(db, "UPDATE lc_legal_holds SET status = 'EXPIRED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    for (const target of listHoldObjects(db, row.id)) {
      syncObjectHoldStatus(db, row.tenant_id, target.object_type, target.object_id);
    }
    expired += 1;
  }
  return { expired };
}
