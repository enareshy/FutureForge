// Permission-aware search. Object types declare the IAM resource + action that
// governs read access; the search layer re-evaluates that decision per result
// so an index entry never leaks data the caller cannot otherwise read.
import { checkPermission } from "../authorization.js";
import { objectTypeRow } from "./repository.js";
import { isPlatformAdmin } from "../tenants.js";

function decisionCache() {
  return new Map();
}

function cachedDecision(db, actor, resource, action, organizationId, cache) {
  const key = `${resource}|${action}|${organizationId}`;
  if (cache.has(key)) return cache.get(key);
  const decision = checkPermission(db, actor, resource, action, { organizationId });
  const allowed = Boolean(decision?.allowed);
  cache.set(key, allowed);
  return allowed;
}

export function authorizeObjectType(db, actor, objectType, options = {}) {
  const { tenantId, action = null, cache = decisionCache() } = options;
  const row = objectTypeRow(db, objectType, tenantId);
  if (!row) return false;
  if (!row.permission_resource) return true;
  const platformAdmin = options.platformAdmin ?? isPlatformAdmin(db, actor?.id);
  if (platformAdmin) return true;
  const organizationId = options.organizationId ?? actor?.organization_id ?? 0;
  return cachedDecision(
    db,
    actor,
    row.permission_resource,
    action || row.permission_action || "read",
    organizationId,
    cache
  );
}

export function filterAuthorizedDocuments(db, actor, documents, options = {}) {
  const { tenantId, action = null, cache = decisionCache() } = options;
  const platformAdmin = options.platformAdmin ?? isPlatformAdmin(db, actor?.id);
  if (platformAdmin) return documents;
  const typeDecisions = new Map();
  const result = [];
  for (const doc of documents) {
    if (!typeDecisions.has(doc.object_type)) {
      typeDecisions.set(
        doc.object_type,
        authorizeObjectType(db, actor, doc.object_type, {
          tenantId: doc.tenant_id ?? tenantId,
          action,
          cache,
          platformAdmin,
          organizationId: doc.organization_id ?? actor?.organization_id ?? 0,
        })
      );
    }
    if (typeDecisions.get(doc.object_type)) result.push(doc);
  }
  return result;
}

export function createDecisionCache() {
  return decisionCache();
}
