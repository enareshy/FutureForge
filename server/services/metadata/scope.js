import { HttpError } from "../../validation.js";
import * as tenants from "../tenants.js";

// Global (system) metadata is stored with tenant_id = NULL and is readable by
// every tenant, but only platform administrators may mutate it. Tenant-local
// metadata is visible only inside its tenant. These helpers keep that rule in
// one place so every metadata service behaves consistently.

export function isPlatformAdmin(db, actor) {
  return tenants.isPlatformAdmin(db, actor?.id);
}

export function homeTenantId(db, actor) {
  return tenants.homeTenantId(db, actor);
}

// Resolves the tenant whose metadata a read should include. Global rows are
// always included alongside the caller's tenant.
export function readTenant(db, actor, query = {}, reqTenantId = null) {
  const requested = query?.tenantId ?? query?.tenant_id;
  if (requested === undefined || requested === null || requested === "" || requested === "auto") {
    return reqTenantId ? Number(reqTenantId) : null;
  }
  if (requested === "global" || requested === "system" || requested === 0 || requested === "0") {
    if (!isPlatformAdmin(db, actor)) throw new HttpError(403, "Cannot read global metadata");
    return null;
  }
  if (!isPlatformAdmin(db, actor)) throw new HttpError(403, "Cannot target another tenant");
  return Number(requested);
}

// Resolves the tenant an artifact should be written to. `undefined` falls back
// to the active request tenant. Explicit null/0/"system" means global and
// requires platform administration.
export function writeTenant(db, actor, body = {}, reqTenantId = null) {
  let requested = body?.tenantId ?? body?.tenant_id;
  if (requested === undefined && body?.scope !== undefined) {
    requested = body.scope === "system" || body.scope === "global" ? null : reqTenantId;
  }
  if (requested === undefined) return reqTenantId ? Number(reqTenantId) : null;
  if (requested === null || requested === "" || requested === 0 || requested === "0" || requested === "system" || requested === "global") {
    if (!isPlatformAdmin(db, actor)) {
      throw new HttpError(403, "Only platform administrators can manage global metadata");
    }
    return null;
  }
  if (!isPlatformAdmin(db, actor)) {
    const home = homeTenantId(db, actor);
    if (!home || Number(home) !== Number(requested)) {
      throw new HttpError(403, "Cannot write metadata for another tenant");
    }
  }
  return Number(requested);
}

// SQL predicate matching global rows plus the caller's tenant.
export function tenantClause(alias, tenantId) {
  const prefix = alias ? `${alias}.` : "";
  if (tenantId) {
    return { sql: `(${prefix}tenant_id IS NULL OR ${prefix}tenant_id = ?)`, params: [Number(tenantId)] };
  }
  return { sql: `${prefix}tenant_id IS NULL`, params: [] };
}

// A row is readable when it is global or owned by the caller's tenant.
export function assertReadable(row, tenantId, message = "Metadata not found") {
  if (!row) throw new HttpError(404, message);
  if (row.tenant_id === null || row.tenant_id === undefined) return row;
  if (tenantId && Number(row.tenant_id) === Number(tenantId)) return row;
  throw new HttpError(404, message);
}

// A row is mutable by the caller's tenant; global rows require platform admin.
export function assertMutable(db, row, tenantId, actor, message = "Metadata not found") {
  if (!row) throw new HttpError(404, message);
  if (row.tenant_id === null || row.tenant_id === undefined) {
    if (!isPlatformAdmin(db, actor)) {
      throw new HttpError(403, "Only platform administrators can modify global metadata");
    }
    return row;
  }
  if (isPlatformAdmin(db, actor)) return row;
  if (tenantId && Number(row.tenant_id) === Number(tenantId)) return row;
  throw new HttpError(404, message);
}

export function isGlobal(row) {
  return row?.tenant_id === null || row?.tenant_id === undefined;
}
