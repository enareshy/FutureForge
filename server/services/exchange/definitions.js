// Exchange Definitions (§5).
//
// A versioned, auditable contract that binds a format/version to a direction,
// source/target object types, mapping, transformation, validation profile,
// security policy and scope. Published versions are immutable; editing a
// published definition creates a new working version.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { definitionRef } from "./identifiers.js";
import { DEFINITION_STATUSES, APPROVAL_STATUSES, DIRECTIONS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { publicDefinition, publicDefinitionVersion, toJson, parseJson } from "./repository.js";
import { definitionNotFound, definitionConflict, invalidDefinition } from "./errors.js";
import { getFormatRow } from "./formats.js";
import { normalizeUpper } from "../data-exchange/validation.js";

const STRING_FIELDS = ["name", "description", "format_version", "source_object_type", "target_object_type", "mapping_code", "transformation_code", "validation_profile_code", "site"];
const JSON_FIELDS = { source_schema_json: "source_schema", security_policy_json: "security_policy", scope_json: "scope", lifecycle_constraints_json: "lifecycle_constraints", metadata_json: "metadata" };

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function getDefinitionRow(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const raw = String(ref ?? "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ? AND tenant_id = ?", [Number(raw), tenant]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM exchange_definitions WHERE tenant_id = ? AND (definition_ref = ? OR code = ? COLLATE NOCASE)", [tenant, raw, raw]);
}

export function requireDefinitionRow(db, tenantId, ref) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return row;
}

function normalizeDefinitionInput(body = {}, current = {}) {
  const code = normalizeUpper(body.code || current.code || "", { max: 120 });
  if (!code) throw invalidDefinition("A definition code is required");
  const formatCode = normalizeUpper(body.format_code || body.formatCode || current.format_code || "", { max: 80 });
  if (!formatCode) throw invalidDefinition("An exchange definition requires a format_code");
  const direction = normalizeUpper(body.direction || current.direction || "IMPORT");
  if (!DIRECTIONS.includes(direction)) throw invalidDefinition(`Unsupported direction: ${body.direction}`);
  const status = normalizeUpper(body.status || current.status || "DRAFT");
  if (!DEFINITION_STATUSES.includes(status)) throw invalidDefinition(`Unsupported status: ${body.status}`);
  const approval = normalizeUpper(body.approval_status || body.approvalStatus || current.approval_status || "DRAFT");
  if (!APPROVAL_STATUSES.includes(approval)) throw invalidDefinition(`Unsupported approval status: ${body.approval_status}`);
  return {
    code,
    name: String(body.name || current.name || code).trim(),
    description: String(body.description ?? current.description ?? "").trim(),
    format_code: formatCode,
    format_version: String(body.format_version || body.formatVersion || current.format_version || "").trim(),
    direction,
    source_object_type: String(body.source_object_type || body.sourceObjectType || current.source_object_type || "").trim(),
    target_object_type: String(body.target_object_type || body.targetObjectType || current.target_object_type || "").trim(),
    source_schema: body.source_schema || body.sourceSchema || parseJson(current.source_schema_json, {}),
    mapping_code: String(body.mapping_code || body.mappingCode || current.mapping_code || "").trim(),
    transformation_code: String(body.transformation_code || body.transformationCode || current.transformation_code || "").trim(),
    validation_profile_code: String(body.validation_profile_code || body.validationProfileCode || current.validation_profile_code || "").trim(),
    security_policy: body.security_policy || body.securityPolicy || parseJson(current.security_policy_json, {}),
    scope: body.scope || parseJson(current.scope_json, {}),
    lifecycle_constraints: body.lifecycle_constraints || body.lifecycleConstraints || parseJson(current.lifecycle_constraints_json, {}),
    status,
    approval_status: approval,
    organization_id: body.organization_id ?? body.organizationId ?? current.organization_id ?? null,
    site: String(body.site ?? current.site ?? "").trim(),
    owner_user_id: body.owner_user_id ?? body.ownerUserId ?? current.owner_user_id ?? null,
    effective_from: body.effective_from || body.effectiveFrom || current.effective_from || null,
    effective_to: body.effective_to || body.effectiveTo || current.effective_to || null,
    metadata: body.metadata || parseJson(current.metadata_json, {}),
  };
}

function assertFormatExists(db, tenantId, formatCode) {
  const row = getFormatRow(db, tenantId, formatCode);
  if (!row) throw invalidDefinition(`Unknown exchange format: ${formatCode}`, { format_code: formatCode });
  return row;
}

function insertDefinitionVersion(db, tenantId, row, { status, approvalStatus, changeSummary, actor, publishedAt = null }) {
  const version = Number(row.version);
  const existing = queryOne(db, "SELECT id FROM exchange_definition_versions WHERE definition_id = ? AND version = ?", [row.id, version]);
  if (existing) return;
  run(
    db,
    `INSERT INTO exchange_definition_versions
       (definition_id, tenant_id, version, status, approval_status, snapshot_json, change_summary, published_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, tenantId, version, status, approvalStatus, toJson(publicDefinition(row), {}), changeSummary, publishedAt, actor?.id ?? null, nowIso()]
  );
}

export function createDefinition(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeDefinitionInput(body);
  assertFormatExists(db, tenant, input.format_code);
  const existing = queryOne(db, "SELECT id FROM exchange_definitions WHERE tenant_id = ? AND code = ?", [tenant, input.code]);
  if (existing) throw definitionConflict(input.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_definitions
       (definition_ref, tenant_id, organization_id, site, code, name, description, format_code, format_version, direction,
        source_object_type, target_object_type, source_schema_json, mapping_code, transformation_code, validation_profile_code,
        security_policy_json, scope_json, lifecycle_constraints_json, version, status, approval_status, owner_user_id,
        effective_from, effective_to, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      definitionRef(input.code), tenant, input.organization_id, input.site, input.code, input.name, input.description,
      input.format_code, input.format_version, input.direction, input.source_object_type, input.target_object_type,
      toJson(input.source_schema, {}), input.mapping_code, input.transformation_code, input.validation_profile_code,
      toJson(input.security_policy, {}), toJson(input.scope, {}), toJson(input.lifecycle_constraints, {}),
      input.status, input.approval_status, input.owner_user_id, input.effective_from, input.effective_to,
      toJson(input.metadata, {}), actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  insertDefinitionVersion(db, tenant, row, { status: row.status, approvalStatus: row.approval_status, changeSummary: "Initial version", actor });
  return publicDefinition(row);
}

export function updateDefinition(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  const published = Boolean(row.published_at);
  const input = normalizeDefinitionInput(body, row);
  assertFormatExists(db, tenant, input.format_code);
  if (published) {
    // Published versions are immutable: roll the working copy forward.
    insertDefinitionVersion(db, tenant, row, { status: row.status, approvalStatus: row.approval_status, changeSummary: body.change_summary || body.changeSummary || "Superseded", actor, publishedAt: row.published_at });
    run(
      db,
      `UPDATE exchange_definitions SET name=?, description=?, format_code=?, format_version=?, direction=?, source_object_type=?,
         target_object_type=?, source_schema_json=?, mapping_code=?, transformation_code=?, validation_profile_code=?,
         security_policy_json=?, scope_json=?, lifecycle_constraints_json=?, version=version+1, status='DRAFT', approval_status='DRAFT',
         owner_user_id=?, effective_from=?, effective_to=?, metadata_json=?, published_at=NULL, published_by=NULL, updated_by=?, updated_at=?
       WHERE id=? AND tenant_id=?`,
      [
        input.name, input.description, input.format_code, input.format_version, input.direction, input.source_object_type,
        input.target_object_type, toJson(input.source_schema, {}), input.mapping_code, input.transformation_code,
        input.validation_profile_code, toJson(input.security_policy, {}), toJson(input.scope, {}), toJson(input.lifecycle_constraints, {}),
        input.owner_user_id, input.effective_from, input.effective_to, toJson(input.metadata, {}), actor?.id ?? null, nowIso(), row.id, tenant,
      ]
    );
  } else {
    run(
      db,
      `UPDATE exchange_definitions SET name=?, description=?, format_code=?, format_version=?, direction=?, source_object_type=?,
         target_object_type=?, source_schema_json=?, mapping_code=?, transformation_code=?, validation_profile_code=?,
         security_policy_json=?, scope_json=?, lifecycle_constraints_json=?, status=?, approval_status=?, owner_user_id=?,
         effective_from=?, effective_to=?, metadata_json=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
      [
        input.name, input.description, input.format_code, input.format_version, input.direction, input.source_object_type,
        input.target_object_type, toJson(input.source_schema, {}), input.mapping_code, input.transformation_code,
        input.validation_profile_code, toJson(input.security_policy, {}), toJson(input.scope, {}), toJson(input.lifecycle_constraints, {}),
        input.status, input.approval_status, input.owner_user_id, input.effective_from, input.effective_to, toJson(input.metadata, {}),
        actor?.id ?? null, nowIso(), row.id, tenant,
      ]
    );
  }
  return publicDefinition(queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ?", [row.id]));
}

export function publishDefinition(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  const ts = nowIso();
  insertDefinitionVersion(db, tenant, row, { status: "ACTIVE", approvalStatus: "APPROVED", changeSummary: body.change_summary || body.changeSummary || "Published", actor, publishedAt: ts });
  run(
    db,
    "UPDATE exchange_definitions SET status='ACTIVE', approval_status='APPROVED', published_at=?, published_by=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?",
    [ts, actor?.id ?? null, actor?.id ?? null, ts, row.id, tenant]
  );
  return publicDefinition(queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ?", [row.id]));
}

export function setDefinitionStatus(db, tenantId, ref, status, actor = null) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  const next = normalizeUpper(status);
  if (!DEFINITION_STATUSES.includes(next)) throw invalidDefinition(`Unsupported status: ${status}`);
  run(db, "UPDATE exchange_definitions SET status=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [next, actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicDefinition(queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ?", [row.id]));
}

export function deleteDefinition(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  if (row.published_at) {
    run(db, "UPDATE exchange_definitions SET status='OBSOLETE', updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [null, nowIso(), row.id, tenant]);
    return { deleted: false, obsoleted: true, ref: row.definition_ref };
  }
  run(db, "DELETE FROM exchange_definitions WHERE id = ? AND tenant_id = ?", [row.id, tenant]);
  return { deleted: true, ref: row.definition_ref };
}

export function listDefinitions(db, tenantId, query = {}) {
  const tenant = Number(tenantId);
  const { page, pageSize, offset } = pageArgs(query);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(query.status));
  }
  if (query.direction) {
    clauses.push("(direction = ? OR direction = 'BOTH')");
    params.push(normalizeUpper(query.direction));
  }
  if (query.format_code) {
    clauses.push("format_code = ?");
    params.push(normalizeUpper(query.format_code));
  }
  if (query.q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_definitions WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_definitions WHERE ${where} ORDER BY code ASC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicDefinition), total, page, pageSize };
}

export function getDefinition(db, tenantId, ref) {
  const row = requireDefinitionRow(db, tenantId, ref);
  const output = publicDefinition(row);
  output.versions = listDefinitionVersions(db, tenantId, row.id).items;
  return output;
}

export function listDefinitionVersions(db, tenantId, ref) {
  const row = requireDefinitionRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM exchange_definition_versions WHERE definition_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicDefinitionVersion), total: rows.length };
}

export function getDefinitionVersion(db, tenantId, ref, version) {
  const row = requireDefinitionRow(db, tenantId, ref);
  const versionRow = queryOne(db, "SELECT * FROM exchange_definition_versions WHERE definition_id = ? AND version = ?", [row.id, Number(version)]);
  if (!versionRow) throw definitionNotFound(`${ref}@${version}`);
  return publicDefinitionVersion(versionRow);
}

// Resolves the definition to use for an operation when the caller did not name
// one: explicit code first, then the most specific active match.
export function resolveDefinition(db, tenantId, { code = null, formatCode = null, direction = null, targetObjectType = null } = {}) {
  if (code) {
    const row = getDefinitionRow(db, tenantId, code);
    if (row) return publicDefinition(row);
  }
  const clauses = ["tenant_id = ?", "status = 'ACTIVE'"];
  const params = [Number(tenantId)];
  if (formatCode) {
    clauses.push("format_code = ?");
    params.push(normalizeUpper(formatCode));
  }
  if (direction) {
    clauses.push("(direction = ? OR direction = 'BOTH')");
    params.push(normalizeUpper(direction));
  }
  if (targetObjectType) {
    clauses.push("(target_object_type = ? OR target_object_type = '')");
    params.push(String(targetObjectType));
  }
  const row = queryOne(db, `SELECT * FROM exchange_definitions WHERE ${clauses.join(" AND ")} ORDER BY published_at IS NULL ASC, version DESC LIMIT 1`, params);
  if (!row) throw definitionNotFound(code || `${formatCode || "*"}/${direction || "*"}`);
  return publicDefinition(row);
}

export function definitionSummary(db, tenantId) {
  const tenant = Number(tenantId);
  const rows = queryAll(db, "SELECT direction, status, COUNT(*) AS c FROM exchange_definitions WHERE tenant_id = ? GROUP BY direction, status", [tenant]);
  const byDirection = {};
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byDirection[row.direction] = (byDirection[row.direction] || 0) + Number(row.c);
    byStatus[row.status] = (byStatus[row.status] || 0) + Number(row.c);
    total += Number(row.c);
  }
  return { total, by_direction: byDirection, by_status: byStatus };
}
