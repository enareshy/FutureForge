// Search & Discovery integration for the Requirements Manager domain.
//
// Requirements, their revisions and baselines are indexed as read-only search
// object types through the shared Enterprise Search, so requirement content is
// discoverable with the same facets, authorization, saved searches and ranking
// as every other module. Nothing here re-implements search: object types are
// registered in the shared registry and rows are resolved through shared source
// resolvers (mirrors server/services/pdm/search.js).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { registerObjectType, registerObjectTypeAsync, tenantIds, tenantIdsAsync } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import {
  getObjectType,
  getObjectTypeAsync,
  registerObjectType as registerSecurityObjectType,
  registerObjectTypeAsync as registerSecurityObjectTypeAsync,
} from "../security/repository.js";
import { REQUIREMENTS_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("requirement"),
    source_module: "requirements",
    source_table: "requirements",
    title_attribute: "title",
    subtitle_attribute: "requirement_number",
    summary_attribute: "description",
    body_attributes: ["requirement_number", "requirement_ref", "title", "name", "description", "requirement_type", "category", "source", "domain", "discipline", "status"],
    facet_attributes: ["status", "requirement_type", "category", "priority", "criticality", "domain"],
    filter_attributes: ["status", "requirement_type", "category", "priority", "criticality", "domain", "discipline", "source", "organization_id"],
    permission_resource: REQUIREMENTS_RESOURCES.items,
    display_order: 300,
  },
  {
    ...defFor("requirement_revision"),
    source_module: "requirements",
    source_table: "requirement_revisions",
    title_attribute: "title",
    subtitle_attribute: "revision",
    summary_attribute: "description",
    body_attributes: ["requirement_number", "revision", "revision_status", "title", "description", "change_reason", "change_ref"],
    facet_attributes: ["revision_status"],
    filter_attributes: ["revision_status", "requirement_id"],
    permission_resource: REQUIREMENTS_RESOURCES.items,
    display_order: 301,
  },
  {
    ...defFor("requirement_baseline"),
    source_module: "requirements",
    source_table: "requirement_baselines",
    title_attribute: "name",
    subtitle_attribute: "baseline_number",
    summary_attribute: "description",
    body_attributes: ["baseline_number", "baseline_ref", "name", "description", "baseline_version", "status"],
    facet_attributes: ["status"],
    filter_attributes: ["status"],
    permission_resource: REQUIREMENTS_RESOURCES.baselines,
    display_order: 302,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

function requirementDocument(row, tenantId) {
  if (!row) return null;
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "requirement",
    objectId: String(row.id),
    code: row.requirement_number,
    title: row.title || row.name || row.requirement_number,
    subtitle: row.requirement_number,
    summary: row.description || "",
    searchableText: joinText([row.requirement_number, row.requirement_ref, row.title, row.name, row.description, row.requirement_type, row.category, row.source, row.domain, row.discipline, row.status]),
    status: row.status,
    ownerId: row.owner_user_id ?? null,
    classification: "internal",
    tags: [row.requirement_type, row.category, row.domain, row.status].filter(Boolean),
    attributes: {
      requirement_number: row.requirement_number,
      requirement_type: row.requirement_type,
      category: row.category,
      priority: row.priority,
      criticality: row.criticality,
      domain: row.domain,
      discipline: row.discipline,
      source: row.source,
      status: row.status,
      organization_id: row.organization_id ?? null,
    },
    scoreWeight: 1,
  };
}

function revisionDocument(row, tenantId) {
  if (!row) return null;
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "requirement_revision",
    objectId: String(row.id),
    code: row.revision_ref || `${row.requirement_number}-${row.revision}`,
    title: row.title || `${row.requirement_number} ${row.revision}`,
    subtitle: row.revision,
    summary: row.description || "",
    searchableText: joinText([row.requirement_number, row.revision, row.revision_status, row.title, row.description, row.change_reason, row.change_ref]),
    status: row.revision_status,
    ownerId: row.created_by ?? null,
    classification: "internal",
    tags: [row.revision_status].filter(Boolean),
    attributes: { requirement_number: row.requirement_number, revision: row.revision, revision_status: row.revision_status, requirement_id: row.requirement_id },
    scoreWeight: 1,
  };
}

function baselineDocument(row, tenantId) {
  if (!row) return null;
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "requirement_baseline",
    objectId: String(row.id),
    code: row.baseline_number,
    title: row.name || row.baseline_number,
    subtitle: row.baseline_number,
    summary: row.description || "",
    searchableText: joinText([row.baseline_number, row.baseline_ref, row.name, row.description, row.baseline_version, row.status]),
    status: row.status,
    ownerId: row.owner_user_id ?? null,
    classification: "internal",
    tags: [row.status].filter(Boolean),
    attributes: { baseline_number: row.baseline_number, baseline_version: row.baseline_version, status: row.status },
    scoreWeight: 1,
  };
}

const REQ_COLUMNS =
  "id, tenant_id, organization_id, requirement_number, requirement_ref, title, name, description, requirement_type, category, source, domain, discipline, priority, criticality, status, owner_user_id";

export function registerRequirementSources() {
  registerSourceResolver("requirement", {
    code: "requirement",
    table: "requirements",
    resolve(db, objectId, { tenantId } = {}) {
      return requirementDocument(queryOne(db, `SELECT ${REQ_COLUMNS} FROM requirements WHERE id = ?`, [Number(objectId)]), tenantId);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM requirements WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
    async resolveAsync(db, objectId, { tenantId } = {}) {
      return requirementDocument(await queryOneAsync(db, `SELECT ${REQ_COLUMNS} FROM requirements WHERE id = ?`, [Number(objectId)]), tenantId);
    },
    async listIdsAsync(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAllAsync(db, "SELECT id, tenant_id FROM requirements WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("requirement_revision", {
    code: "requirement_revision",
    table: "requirement_revisions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(
        db,
        "SELECT id, tenant_id, organization_id, requirement_id, requirement_number, revision, revision_ref, revision_status, title, description, change_reason, change_ref, created_by FROM requirement_revisions WHERE id = ?",
        [Number(objectId)]
      );
      return revisionDocument(row, tenantId);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM requirement_revisions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
    async resolveAsync(db, objectId, { tenantId } = {}) {
      const row = await queryOneAsync(
        db,
        "SELECT id, tenant_id, organization_id, requirement_id, requirement_number, revision, revision_ref, revision_status, title, description, change_reason, change_ref, created_by FROM requirement_revisions WHERE id = ?",
        [Number(objectId)]
      );
      return revisionDocument(row, tenantId);
    },
    async listIdsAsync(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAllAsync(db, "SELECT id, tenant_id FROM requirement_revisions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("requirement_baseline", {
    code: "requirement_baseline",
    table: "requirement_baselines",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(
        db,
        "SELECT id, tenant_id, organization_id, baseline_number, baseline_ref, name, description, baseline_version, status, owner_user_id FROM requirement_baselines WHERE id = ?",
        [Number(objectId)]
      );
      return baselineDocument(row, tenantId);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM requirement_baselines WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
    async resolveAsync(db, objectId, { tenantId } = {}) {
      const row = await queryOneAsync(
        db,
        "SELECT id, tenant_id, organization_id, baseline_number, baseline_ref, name, description, baseline_version, status, owner_user_id FROM requirement_baselines WHERE id = ?",
        [Number(objectId)]
      );
      return baselineDocument(row, tenantId);
    },
    async listIdsAsync(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAllAsync(db, "SELECT id, tenant_id FROM requirement_baselines WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureRequirementsSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}

export async function ensureRequirementsSearchAsync(db) {
  let created = 0;
  for (const tenantId of await tenantIdsAsync(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = await queryOneAsync(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        await registerObjectTypeAsync(db, def, null, tenantId, null);
        created += 1;
      }
      if (!(await getObjectTypeAsync(db, tenantId, def.code))) {
        await registerSecurityObjectTypeAsync(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}
