// Requirement Types service. Types are data, never source code: administrators
// can add or extend types through the API without a code change. The seeded
// defaults (Business/Customer/System/... Requirement) are ordinary rows with
// is_system=1 so they can be inspected but not deleted.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { updateRow, updateRowAsync } from "./sql.js";
import { publicType } from "./repository.js";
import { typeRef } from "./refs.js";
import { normalizeText, normalizeTypeInput, paginate } from "./validation.js";
import { typeNotFound, typeConflict, invalidType } from "./errors.js";
import { DEFAULT_REQUIREMENT_TYPES, DEFAULT_TYPE_PARENTS, SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "category",
  "parent_code",
  "numbering_scheme",
  "lifecycle_code",
  "workflow_code",
  "required_fields_json",
  "allowed_relationships_json",
  "layout_json",
  "sequence",
  "status",
  "updated_by",
];

export function listTypes(db, { tenantId, status, category, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status, { max: 20 }).toUpperCase());
  }
  if (category) {
    clauses.push("category = ?");
    params.push(normalizeText(category, { max: 40 }).toUpperCase());
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_types ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirement_types ${where} ORDER BY sequence, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicType), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listTypesAsync(db, { tenantId, status, category, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status, { max: 20 }).toUpperCase());
  }
  if (category) {
    clauses.push("category = ?");
    params.push(normalizeText(category, { max: 40 }).toUpperCase());
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_types ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_types ${where} ORDER BY sequence, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicType), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getTypeRow(db, tenantId, code) {
  return queryOne(db, "SELECT * FROM requirement_types WHERE tenant_id = ? AND lower(code) = lower(?)", [Number(tenantId), String(code)]);
}

export async function getTypeRowAsync(db, tenantId, code) {
  return queryOneAsync(db, "SELECT * FROM requirement_types WHERE tenant_id = ? AND lower(code) = lower(?)", [Number(tenantId), String(code)]);
}

export function getType(db, tenantId, code) {
  return publicType(getTypeRow(db, tenantId, code));
}

export async function getTypeAsync(db, tenantId, code) {
  return publicType(await getTypeRowAsync(db, tenantId, code));
}

export function requireTypeRow(db, tenantId, code) {
  const row = getTypeRow(db, tenantId, code);
  if (!row) throw typeNotFound(code);
  return row;
}

export async function requireTypeRowAsync(db, tenantId, code) {
  const row = await getTypeRowAsync(db, tenantId, code);
  if (!row) throw typeNotFound(code);
  return row;
}

export function createType(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeTypeInput(body, {});
  if (getTypeRow(db, tenant, normalized.code)) throw typeConflict(normalized.code);
  if (normalized.parent_code && !getTypeRow(db, tenant, normalized.parent_code)) {
    throw invalidType(`Parent requirement type not found: ${normalized.parent_code}`, { parent_code: normalized.parent_code });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirement_types
       (tenant_id, type_ref, code, name, description, category, parent_code, numbering_scheme, lifecycle_code, workflow_code,
        required_fields_json, allowed_relationships_json, layout_json, sequence, status, is_system, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      tenant,
      typeRef(normalized.code),
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.category,
      normalized.parent_code,
      normalized.numbering_scheme,
      normalized.lifecycle_code,
      normalized.workflow_code,
      JSON.stringify(normalized.required_fields || []),
      JSON.stringify(normalized.allowed_relationships || []),
      JSON.stringify(normalized.layout || {}),
      normalized.sequence,
      normalized.status,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM requirement_types WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "requirements.type.create", resourceType: "requirement_type", resourceId: row.code, details: { code: row.code }, ip });
  return publicType(row);
}

export async function createTypeAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeTypeInput(body, {});
  if (await getTypeRowAsync(db, tenant, normalized.code)) throw typeConflict(normalized.code);
  if (normalized.parent_code && !(await getTypeRowAsync(db, tenant, normalized.parent_code))) {
    throw invalidType(`Parent requirement type not found: ${normalized.parent_code}`, { parent_code: normalized.parent_code });
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirement_types
       (tenant_id, type_ref, code, name, description, category, parent_code, numbering_scheme, lifecycle_code, workflow_code,
        required_fields_json, allowed_relationships_json, layout_json, sequence, status, is_system, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      tenant,
      typeRef(normalized.code),
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.category,
      normalized.parent_code,
      normalized.numbering_scheme,
      normalized.lifecycle_code,
      normalized.workflow_code,
      JSON.stringify(normalized.required_fields || []),
      JSON.stringify(normalized.allowed_relationships || []),
      JSON.stringify(normalized.layout || {}),
      normalized.sequence,
      normalized.status,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM requirement_types WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "requirements.type.create", resourceType: "requirement_type", resourceId: row.code, details: { code: row.code }, ip });
  return publicType(row);
}

export function updateType(db, tenantId, code, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTypeRow(db, tenant, code);
  const normalized = normalizeTypeInput({ ...body, code: row.code }, row);
  if (normalized.parent_code && normalized.parent_code === row.code) {
    throw invalidType("A requirement type cannot be its own parent", { code: row.code });
  }
  updateRow(
    db,
    "requirement_types",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      category: normalized.category,
      parent_code: normalized.parent_code,
      numbering_scheme: normalized.numbering_scheme,
      lifecycle_code: normalized.lifecycle_code,
      workflow_code: normalized.workflow_code,
      required_fields_json: JSON.stringify(normalized.required_fields || []),
      allowed_relationships_json: JSON.stringify(normalized.allowed_relationships || []),
      layout_json: JSON.stringify(normalized.layout || {}),
      sequence: normalized.sequence,
      status: normalized.status,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM requirement_types WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "requirements.type.update", resourceType: "requirement_type", resourceId: row.code, details: { code: row.code }, ip });
  return publicType(updated);
}

export async function updateTypeAsync(db, tenantId, code, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireTypeRowAsync(db, tenant, code);
  const normalized = normalizeTypeInput({ ...body, code: row.code }, row);
  if (normalized.parent_code && normalized.parent_code === row.code) {
    throw invalidType("A requirement type cannot be its own parent", { code: row.code });
  }
  await updateRowAsync(
    db,
    "requirement_types",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      category: normalized.category,
      parent_code: normalized.parent_code,
      numbering_scheme: normalized.numbering_scheme,
      lifecycle_code: normalized.lifecycle_code,
      workflow_code: normalized.workflow_code,
      required_fields_json: JSON.stringify(normalized.required_fields || []),
      allowed_relationships_json: JSON.stringify(normalized.allowed_relationships || []),
      layout_json: JSON.stringify(normalized.layout || {}),
      sequence: normalized.sequence,
      status: normalized.status,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = await queryOneAsync(db, "SELECT * FROM requirement_types WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "requirements.type.update", resourceType: "requirement_type", resourceId: row.code, details: { code: row.code }, ip });
  return publicType(updated);
}

export function setTypeStatus(db, tenantId, code, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTypeRow(db, tenant, code);
  const next = normalizeText(status, { max: 20 }).toUpperCase();
  if (!["ACTIVE", "INACTIVE"].includes(next)) throw invalidType("status must be ACTIVE or INACTIVE", { status });
  updateRow(db, "requirement_types", row.id, { status: next, updated_by: actor?.id ?? null }, { columns: ["status", "updated_by"] });
  writeAudit(db, { actor, action: "requirements.type.status", resourceType: "requirement_type", resourceId: row.code, details: { status: next }, ip });
  return publicType(queryOne(db, "SELECT * FROM requirement_types WHERE id = ?", [row.id]));
}

export async function setTypeStatusAsync(db, tenantId, code, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireTypeRowAsync(db, tenant, code);
  const next = normalizeText(status, { max: 20 }).toUpperCase();
  if (!["ACTIVE", "INACTIVE"].includes(next)) throw invalidType("status must be ACTIVE or INACTIVE", { status });
  await updateRowAsync(db, "requirement_types", row.id, { status: next, updated_by: actor?.id ?? null }, { columns: ["status", "updated_by"] });
  await writeAuditAsync(db, { actor, action: "requirements.type.status", resourceType: "requirement_type", resourceId: row.code, details: { status: next }, ip });
  return publicType(await queryOneAsync(db, "SELECT * FROM requirement_types WHERE id = ?", [row.id]));
}

// Seed the default, configurable requirement types for a tenant. Idempotent.
function seedDefaultTypes(db, tenant) {
  let created = 0;
  const ts = nowIso();
  for (const def of DEFAULT_REQUIREMENT_TYPES) {
    if (getTypeRow(db, tenant, def.code)) continue;
    run(
      db,
      `INSERT INTO requirement_types
         (tenant_id, type_ref, code, name, description, category, parent_code, required_fields_json, allowed_relationships_json,
          layout_json, sequence, status, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'ACTIVE', 1, ?, ?)`,
      [
        tenant,
        typeRef(def.code),
        def.code,
        def.name,
        `${def.name} — seeded configurable requirement type.`,
        def.category,
        DEFAULT_TYPE_PARENTS[def.code] || null,
        JSON.stringify(["title", "requirement_type", "owner_user_id"]),
        JSON.stringify([]),
        def.sequence,
        ts,
        ts,
      ]
    );
    created += 1;
  }
  return created;
}

async function seedDefaultTypesAsync(db, tenant) {
  let created = 0;
  const ts = nowIso();
  for (const def of DEFAULT_REQUIREMENT_TYPES) {
    if (await getTypeRowAsync(db, tenant, def.code)) continue;
    await runAsync(
      db,
      `INSERT INTO requirement_types
         (tenant_id, type_ref, code, name, description, category, parent_code, required_fields_json, allowed_relationships_json,
          layout_json, sequence, status, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'ACTIVE', 1, ?, ?)`,
      [
        tenant,
        typeRef(def.code),
        def.code,
        def.name,
        `${def.name} — seeded configurable requirement type.`,
        def.category,
        DEFAULT_TYPE_PARENTS[def.code] || null,
        JSON.stringify(["title", "requirement_type", "owner_user_id"]),
        JSON.stringify([]),
        def.sequence,
        ts,
        ts,
      ]
    );
    created += 1;
  }
  return created;
}

export function ensureRequirementTypes(db, tenantId) {
  return { created: seedDefaultTypes(db, Number(tenantId)) };
}

export async function ensureRequirementTypesAsync(db, tenantId) {
  return { created: await seedDefaultTypesAsync(db, Number(tenantId)) };
}
