// Relationship migration.
//
// Relationships are migrated only after both endpoints exist, using the
// identifier map to translate legacy ids into target objects. Missing endpoints
// are recorded as exceptions rather than silently dropped, so operators can
// repair and retry (spec §19, §20).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { createRelationship } from "../objects.js";
import { SOURCE_MODULE } from "./constants.js";
import { relationshipFailed, invalidDependency } from "./errors.js";
import { publicRelationshipMapping } from "./repository.js";
import { normalizeText, paginate, assertRelationshipStatus } from "./validation.js";
import { resolveIdentifier } from "./identifier-mapping.js";

function recordRelationship(db, input = {}) {
  const result = run(
    db,
    `INSERT INTO mig_relationship_mappings (tenant_id, project_id, package_id, job_id, relationship_type, source_relationship_id,
       source_parent_id, source_child_id, target_parent_id, target_child_id, target_relationship_id, status, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      input.projectId != null ? Number(input.projectId) : null,
      input.packageId != null ? Number(input.packageId) : null,
      input.jobId != null ? Number(input.jobId) : null,
      normalizeText(input.relationshipType, { max: 120 }),
      normalizeText(input.sourceRelationshipId, { max: 300 }),
      normalizeText(input.sourceParentId, { max: 300 }),
      normalizeText(input.sourceChildId, { max: 300 }),
      normalizeText(input.targetParentId, { max: 300 }),
      normalizeText(input.targetChildId, { max: 300 }),
      normalizeText(input.targetRelationshipId, { max: 300 }),
      assertRelationshipStatus(input.status || "MAPPED"),
      JSON.stringify(input.details || {}),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

// Migrates one relationship. `sourceSystem` scopes the identifier lookup. When
// `dryRun` is true everything is resolved and validated but nothing is written.
export function migrateRelationship(db, tenantId, input = {}, actor = null, ip = null, { dryRun = false } = {}) {
  const tenant = Number(tenantId);
  const sourceSystem = normalizeText(input.source_system ?? input.sourceSystem, { max: 200 });
  const parentSourceType = normalizeText(input.parent_source_type ?? input.parentSourceType, { max: 120 });
  const childSourceType = normalizeText(input.child_source_type ?? input.childSourceType, { max: 120 });
  const parentSourceId = normalizeText(input.source_parent_id ?? input.sourceParentId, { max: 300 });
  const childSourceId = normalizeText(input.source_child_id ?? input.sourceChildId, { max: 300 });
  const relationshipType = normalizeText(input.relationship_type ?? input.relationshipType, { max: 120 });
  if (!relationshipType) throw invalidDependency("A relationship_type is required");
  if (!parentSourceId || !childSourceId) throw relationshipFailed("Both source_parent_id and source_child_id are required");

  const parent = resolveIdentifier(db, tenant, { sourceSystem, sourceObjectType: parentSourceType, sourceObjectId: parentSourceId });
  const child = resolveIdentifier(db, tenant, { sourceSystem, sourceObjectType: childSourceType, sourceObjectId: childSourceId });
  const missing = [];
  if (!parent?.target_object_id) missing.push({ endpoint: "parent", source_object_id: parentSourceId });
  if (!child?.target_object_id) missing.push({ endpoint: "child", source_object_id: childSourceId });

  const base = {
    tenantId: tenant,
    projectId: input.project_id ?? input.projectId,
    packageId: input.package_id ?? input.packageId,
    jobId: input.job_id ?? input.jobId,
    relationshipType,
    sourceRelationshipId: input.source_relationship_id ?? input.sourceRelationshipId,
    sourceParentId: parentSourceId,
    sourceChildId: childSourceId,
    targetParentId: parent?.target_object_id || "",
    targetChildId: child?.target_object_id || "",
  };

  if (missing.length) {
    if (!dryRun) recordRelationship(db, { ...base, status: "MISSING", details: { missing } });
    return { status: "MISSING", missing, relationship: null };
  }

  if (dryRun) {
    return {
      status: "MAPPED",
      missing: [],
      relationship: { source_parent_id: parent.target_object_id, source_child_id: child.target_object_id, relationship_type: relationshipType },
    };
  }

  try {
    const created = createRelationship(
      db,
      { relationship_type: relationshipType, source_object_id: parent.target_object_id, target_object_id: child.target_object_id, attributes: input.attributes || {} },
      actor,
      tenant,
      ip
    );
    const id = recordRelationship(db, { ...base, targetRelationshipId: created.id, status: "MAPPED", details: { relationship_id: created.id } });
    writeAudit(db, {
      actor,
      action: "migration.relationship.create",
      resourceType: "mig_relationship_mappings",
      resourceId: String(id),
      details: { relationship_type: relationshipType, target_relationship_id: created.id },
      ip,
    });
    return { status: "MAPPED", missing: [], relationship: created };
  } catch (error) {
    const id = recordRelationship(db, { ...base, status: "FAILED", details: { error: error.message, code: error.code || null } });
    writeAudit(db, {
      actor,
      action: "migration.relationship.fail",
      resourceType: "mig_relationship_mappings",
      resourceId: String(id),
      status: "FAILED",
      errorMessage: error.message,
      details: { relationship_type: relationshipType },
      ip,
    });
    return { status: "FAILED", missing: [], error: { message: error.message, code: error.code || null } };
  }
}

export function bulkMigrateRelationships(db, tenantId, relationships = [], actor = null, ip = null, { dryRun = false } = {}) {
  const list = Array.isArray(relationships) ? relationships : [];
  const counters = { total: list.length, mapped: 0, missing: 0, failed: 0 };
  const results = [];
  for (const relationship of list.slice(0, 100000)) {
    const result = migrateRelationship(db, tenantId, relationship, actor, ip, { dryRun });
    if (result.status === "MAPPED") counters.mapped += 1;
    else if (result.status === "MISSING") counters.missing += 1;
    else counters.failed += 1;
    if (results.length < 200) results.push({ status: result.status, missing: result.missing || [] });
  }
  return { counters, results };
}

export function listRelationshipMappings(db, { tenantId, jobId, packageId, projectId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (packageId != null) {
    clauses.push("package_id = ?");
    params.push(Number(packageId));
  }
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertRelationshipStatus(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_relationship_mappings ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_relationship_mappings ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationshipMapping), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function retryMissingRelationships(db, tenantId, { jobId = null, actor = null, ip = null } = {}) {
  const clauses = ["tenant_id = ?", "status IN ('MISSING','FAILED')"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  const rows = queryAll(db, `SELECT * FROM mig_relationship_mappings WHERE ${clauses.join(" AND ")} LIMIT 5000`, params);
  const relationships = rows.map((row) => ({
    relationship_type: row.relationship_type,
    source_parent_id: row.source_parent_id,
    source_child_id: row.source_child_id,
  }));
  return bulkMigrateRelationships(db, tenantId, relationships, actor, ip);
}
