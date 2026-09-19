// Foundation bootstrap for the Numbering Service. Idempotent on every boot:
// registers the standard object types, token catalogue and scope registry, the
// domain event types and the search resolver. Safe to call repeatedly.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { ensureDefaultTokens } from "./tokens.js";
import { ensureNumberingEventTypes } from "./events.js";
import { ensureNumberingSearchRegistration } from "./search.js";

export const DEFAULT_OBJECT_TYPES = [
  { code: "PART", name: "Part", module: "pdm" },
  { code: "PRODUCT", name: "Product", module: "pdm" },
  { code: "DOCUMENT", name: "Document", module: "documents" },
  { code: "BOM", name: "Bill of material", module: "bom" },
  { code: "DRAWING", name: "Drawing", module: "pdm" },
  { code: "SPECIFICATION", name: "Specification", module: "pdm" },
  { code: "CHANGE", name: "Change request", module: "change" },
  { code: "SUPPLIER", name: "Supplier", module: "master-data" },
  { code: "CUSTOMER", name: "Customer", module: "master-data" },
  { code: "MATERIAL", name: "Material", module: "master-data" },
  { code: "TOOL", name: "Tool", module: "manufacturing" },
  { code: "EQUIPMENT", name: "Equipment", module: "manufacturing" },
  { code: "WORK_INSTRUCTION", name: "Work instruction", module: "manufacturing" },
  { code: "QUALITY_CASE", name: "Quality case", module: "quality" },
];

export const DEFAULT_SCOPES = [
  { code: "global", name: "Global", scope_type: "global", description: "One shared counter across the tenant." },
  { code: "tenant", name: "Tenant", scope_type: "tenant", description: "One counter per tenant." },
  { code: "organization", name: "Organization", scope_type: "organization", description: "One counter per organization." },
  { code: "company", name: "Company", scope_type: "company", description: "One counter per company." },
  { code: "plant", name: "Plant", scope_type: "plant", description: "One counter per plant." },
  { code: "site", name: "Site", scope_type: "site", description: "One counter per site." },
  { code: "classification", name: "Classification", scope_type: "classification", description: "One counter per classification." },
  { code: "object_type", name: "Object type", scope_type: "object_type", description: "One counter per object type." },
  { code: "scheme", name: "Scheme", scope_type: "scheme", description: "One counter per numbering scheme (default)." },
  { code: "custom", name: "Custom", scope_type: "custom", description: "Custom combination of scope dimensions." },
];

export function ensureNumberingObjectTypes(db, { tenantId = null } = {}) {
  let created = 0;
  const ts = nowIso();
  for (const type of DEFAULT_OBJECT_TYPES) {
    const existing = queryOne(
      db,
      "SELECT id FROM numbering_object_types WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
      [type.code, tenantId]
    );
    if (existing) continue;
    run(
      db,
      `INSERT INTO numbering_object_types (code, name, description, module, classification, status, is_system, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'active', 1, ?, ?, ?)`,
      [type.code, type.name, type.description || "", type.module || "", tenantId, ts, ts]
    );
    created += 1;
  }
  return created;
}

export function ensureNumberingScopes(db) {
  let created = 0;
  const ts = nowIso();
  for (const scope of DEFAULT_SCOPES) {
    const existing = queryOne(db, "SELECT id FROM numbering_scopes WHERE code = ?", [scope.code]);
    if (existing) continue;
    run(
      db,
      `INSERT INTO numbering_scopes (code, name, description, scope_type, is_system, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
      [scope.code, scope.name, scope.description || "", scope.scope_type, ts, ts]
    );
    created += 1;
  }
  return created;
}

export function ensureNumberingFoundation(db) {
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let objectTypes = 0;
  for (const tenant of tenants) objectTypes += ensureNumberingObjectTypes(db, { tenantId: tenant.id });
  if (!tenants.length) objectTypes += ensureNumberingObjectTypes(db, { tenantId: null });
  const scopes = ensureNumberingScopes(db);
  const tokens = ensureDefaultTokens(db);
  let events = 0;
  let search = null;
  try {
    events = ensureNumberingEventTypes(db);
  } catch {
    events = 0;
  }
  try {
    search = ensureNumberingSearchRegistration(db);
  } catch {
    search = null;
  }
  return { object_types: objectTypes, scopes, tokens, event_types: events, search };
}

export function listObjectTypes(db, { tenantId, status } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM numbering_object_types ${where} ORDER BY code`, params);
  const dedup = new Map();
  for (const row of rows) dedup.set(row.code, row);
  return [...dedup.values()].map(publicObjectType);
}

export function publicObjectType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    module: row.module,
    classification: row.classification,
    status: row.status,
    is_system: Boolean(row.is_system),
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createObjectType(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new HttpError(400, "Object type code must be 2-64 uppercase letters, digits or underscore");
  }
  const existing = queryOne(
    db,
    "SELECT id FROM numbering_object_types WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [code, tenantId]
  );
  if (existing) throw new HttpError(409, `Object type ${code} already exists`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO numbering_object_types (code, name, description, module, classification, status, is_system, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      code,
      input.name || code,
      input.description || "",
      input.module || "",
      input.classification || "",
      input.status === "inactive" ? "inactive" : "active",
      tenantId,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM numbering_object_types WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "numbering.object_type.create",
    resourceType: "numbering_object_type",
    resourceId: row.id,
    details: { code },
    ip,
  });
  return publicObjectType(row);
}

export function setObjectTypeStatus(db, code, status, actor = null, ip = null) {
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "status must be active or inactive");
  const row = queryOne(db, "SELECT * FROM numbering_object_types WHERE code = ?", [String(code).toUpperCase()]);
  if (!row) throw new HttpError(404, "Numbering object type not found");
  run(db, "UPDATE numbering_object_types SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "numbering.object_type.status",
    resourceType: "numbering_object_type",
    resourceId: row.id,
    details: { code: row.code, status },
    ip,
  });
  return publicObjectType(queryOne(db, "SELECT * FROM numbering_object_types WHERE id = ?", [row.id]));
}
