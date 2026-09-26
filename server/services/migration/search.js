// Search & Discovery integration. Migration projects, packages and jobs are
// indexed as read-only search object types so operators can find an onboarding
// estate through the shared Enterprise Search instead of a bespoke listing UI.
// Indexing, querying, authorization and saved searches are all reused.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { tenantIds } from "../search/registry.js";
import { getObjectType } from "../security/repository.js";
import { registerObjectType as registerSecurityObjectType } from "../security/repository.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "migration_project",
    name: "Migration projects",
    description: "Legacy onboarding projects, their source system and status",
    source_module: "migration",
    source_table: "mig_projects",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "source_system", "status", "version"],
    facet_attributes: ["status", "source_system"],
    filter_attributes: ["status", "source_system"],
    permission_resource: "iam.migration.projects",
    display_order: 90,
  },
  {
    code: "migration_package",
    name: "Migration packages",
    description: "Dependency-aware units of migration work and their target object types",
    source_module: "migration",
    source_table: "mig_packages",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "source_object_type", "target_object_type", "status"],
    facet_attributes: ["status", "target_object_type", "source_object_type"],
    filter_attributes: ["status", "target_object_type", "source_object_type"],
    permission_resource: "iam.migration.packages",
    display_order: 91,
  },
  {
    code: "migration_job",
    name: "Migration jobs",
    description: "Migration execution runs, their mode, status and error summary",
    source_module: "migration",
    source_table: "mig_jobs",
    title_attribute: "job_ref",
    subtitle_attribute: "source_adapter",
    summary_attribute: "error_message",
    body_attributes: ["job_ref", "mode", "status", "source_adapter"],
    facet_attributes: ["status", "mode", "source_adapter"],
    filter_attributes: ["status", "mode", "source_adapter"],
    permission_resource: "iam.migration.execution",
    display_order: 92,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerMigrationSources() {
  registerSourceResolver("migration_project", {
    code: "migration_project",
    table: "mig_projects",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "migration_project",
        objectId: String(row.id),
        code: row.project_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.source_system, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.source_system, row.status].filter(Boolean),
        attributes: { code: row.code, source_system: row.source_system, status: row.status, version: row.version },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM mig_projects WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  registerSourceResolver("migration_package", {
    code: "migration_package",
    table: "mig_packages",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "migration_package",
        objectId: String(row.id),
        code: row.package_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.source_object_type, row.target_object_type, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.source_object_type, row.target_object_type, row.status].filter(Boolean),
        attributes: { code: row.code, source_object_type: row.source_object_type, target_object_type: row.target_object_type, status: row.status },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM mig_packages WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  registerSourceResolver("migration_job", {
    code: "migration_job",
    table: "mig_jobs",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "migration_job",
        objectId: String(row.id),
        code: row.job_ref,
        title: row.job_ref,
        subtitle: row.source_adapter || "",
        summary: row.error_message || "",
        searchableText: joinText([row.job_ref, row.mode, row.status, row.source_adapter, row.error_message]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.mode, row.status, row.source_adapter].filter(Boolean),
        attributes: { mode: row.mode, status: row.status, source_adapter: row.source_adapter },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM mig_jobs WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureMigrationSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(
          db,
          { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource },
          null,
          tenantId
        );
      }
    }
  }
  return { created };
}
