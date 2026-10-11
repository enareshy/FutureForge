// Audit read view for the Verification & Validation (V&V) Engine.
//
// V&V writes audit entries through the shared `services/audit` capture on every
// definition/execution/result/evidence/waiver/status operation; there is no
// separate audit store. This module only provides a module-scoped read built on
// the platform audit query layer (mirrors the /api/audit-logs listing) so the
// workspace can show the V&V trail without re-implementing audit storage.
import { listEvents, listEventsAsync } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";

// V&V audit actions are all namespaced `verification-validation.*`, so a default
// free-text filter of the module name scopes the listing to this engine. A
// caller-supplied query (or an exact action) narrows it further.
function scopedFilters(filters = {}) {
  const q = filters.q !== undefined && filters.q !== null && String(filters.q).trim() !== "" ? filters.q : SOURCE_MODULE;
  return {
    action: filters.action,
    objectType: filters.resourceType ?? filters.resource_type,
    objectId: filters.resourceId ?? filters.resource_id,
    actorUsername: filters.actorUsername ?? filters.actor_username,
    from: filters.from,
    to: filters.to,
    status: filters.status,
    q,
    sort: filters.sort,
    order: filters.order,
    page: filters.page,
    pageSize: filters.pageSize ?? filters.page_size,
  };
}

export function listVvAudit(db, scope = {}, filters = {}) {
  return listEvents(db, scopedFilters(filters), scope);
}

export async function listVvAuditAsync(db, scope = {}, filters = {}) {
  return listEventsAsync(db, scopedFilters(filters), scope);
}
