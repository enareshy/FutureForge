// Idempotent bootstrap for the security model. Registers every search object
// type with the centralized engine (default enforcement: tenant isolation) so
// administrators can immediately layer entitlements and policies on top.
import { queryAll, run } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { getObjectType, registerObjectType } from "./repository.js";
import { DEFAULT_ENFORCEMENT, OBJECT_ENFORCEMENT_MODES } from "./constants.js";

function normalizeEnforcement(value) {
  return OBJECT_ENFORCEMENT_MODES.includes(value) ? value : DEFAULT_ENFORCEMENT;
}

export function ensureSecurityFoundation(db) {
  let created = 0;
  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  for (const tenantId of tenants) {
    const types = queryAll(
      db,
      `SELECT DISTINCT code AS object_type, permission_resource, security_policy
       FROM search_object_types WHERE tenant_id = ?`,
      [Number(tenantId)]
    );
    for (const type of types) {
      if (getObjectType(db, tenantId, type.object_type)) continue;
      registerObjectType(
        db,
        {
          object_type: type.object_type,
          enforcement: normalizeEnforcement(type.security_policy),
          permission_resource: type.permission_resource || "",
        },
        null,
        tenantId
      );
      created += 1;
    }
    run(
      db,
      `INSERT OR IGNORE INTO security_cache_epoch (tenant_id, scope, epoch) VALUES (?, 'all', 0)`,
      [Number(tenantId)]
    );
  }
  return { created, tenants: tenants.length };
}
