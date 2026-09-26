// Search integration for the Effectivity & Versioning Kernel. Revisions,
// baselines and snapshots become searchable through the platform Search
// framework via source resolvers; the indexer never reaches into versioning
// tables directly.
import { queryAll, queryOne } from "../../db.js";
import { registerSourceResolver } from "../search/sources.js";
import { registerObjectType, getObjectType } from "../search/registry.js";
import { applyIndexChange } from "../search/indexing.js";
import { safeParse } from "./validation.js";

function revisionResolver() {
  return {
    code: "versioning_revision",
    table: "versioning_revisions",
    resolve(db, revisionId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [Number(revisionId)]);
      if (!row) return null;
      if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
      const metadata = safeParse(row.revision_metadata_json, {});
      const searchableText = [
        row.revision_code,
        row.object_type,
        row.object_id,
        row.name,
        row.description,
        row.status,
        row.lifecycle_state,
        row.effective_from,
        row.effective_to,
      ]
        .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
        .join(" \n ")
        .toLowerCase();
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        objectType: "versioning_revision",
        objectId: String(row.id),
        objectUuid: row.revision_ref,
        code: row.revision_code,
        title: `${row.object_type} ${row.object_id} rev ${row.revision_code}`,
        subtitle: row.status,
        summary: `Revision ${row.revision_code} (${row.status})`,
        searchableText,
        status: row.status,
        lifecycleState: row.lifecycle_state,
        classification: "internal",
        tags: [row.object_type, row.status],
        attributes: {
          object_type: row.object_type,
          object_id: row.object_id,
          revision_code: row.revision_code,
          revision_sequence: row.revision_sequence,
          effective_from: row.effective_from,
          effective_to: row.effective_to,
          is_default: Boolean(row.is_default),
          ...metadata,
        },
        relationships: [],
        updated_at: row.updated_at,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        `SELECT id, tenant_id FROM versioning_revisions
         WHERE (? IS NULL OR tenant_id = ?) AND id > ? ORDER BY id LIMIT ?`,
        [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
      );
    },
  };
}

function baselineResolver() {
  return {
    code: "versioning_baseline",
    table: "versioning_baselines",
    resolve(db, baselineId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM versioning_baselines WHERE id = ?", [Number(baselineId)]);
      if (!row) return null;
      if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
      const searchableText = [row.code, row.name, row.description, row.status, row.owner_name]
        .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
        .join(" \n ")
        .toLowerCase();
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        objectType: "versioning_baseline",
        objectId: String(row.id),
        objectUuid: row.baseline_ref,
        code: row.code,
        title: row.name || row.code,
        subtitle: row.status,
        summary: `Baseline ${row.code} (${row.status})`,
        searchableText,
        status: row.status,
        lifecycleState: row.status,
        classification: "internal",
        tags: [row.status],
        attributes: {
          code: row.code,
          object_count: row.object_count,
          locked: Boolean(row.locked),
          frozen_at: row.frozen_at,
          context: safeParse(row.context_json, {}),
        },
        relationships: [],
        updated_at: row.updated_at,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        `SELECT id, tenant_id FROM versioning_baselines WHERE (? IS NULL OR tenant_id = ?) AND id > ? ORDER BY id LIMIT ?`,
        [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
      );
    },
  };
}

function snapshotResolver() {
  return {
    code: "versioning_snapshot",
    table: "versioning_snapshots",
    resolve(db, snapshotId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM versioning_snapshots WHERE id = ?", [Number(snapshotId)]);
      if (!row) return null;
      if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
      const searchableText = [row.code, row.name, row.description, row.status, row.content_hash]
        .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
        .join(" \n ")
        .toLowerCase();
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        objectType: "versioning_snapshot",
        objectId: String(row.id),
        objectUuid: row.snapshot_ref,
        code: row.code,
        title: row.name || row.code,
        subtitle: row.status,
        summary: `Snapshot ${row.code} (${row.status})`,
        searchableText,
        status: row.status,
        lifecycleState: row.status,
        classification: "internal",
        tags: [row.status],
        attributes: {
          code: row.code,
          object_count: row.object_count,
          content_hash: row.content_hash,
          context: safeParse(row.context_json, {}),
        },
        relationships: [],
        updated_at: row.created_at,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        `SELECT id, tenant_id FROM versioning_snapshots WHERE (? IS NULL OR tenant_id = ?) AND id > ? ORDER BY id LIMIT ?`,
        [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
      );
    },
  };
}

export const VERSIONING_SEARCH_SOURCES = {
  revision: revisionResolver(),
  baseline: baselineResolver(),
  snapshot: snapshotResolver(),
};

export const VERSIONING_SEARCH_REGISTRATIONS = [
  {
    code: "versioning_revision",
    name: "Revisions",
    description: "Object revisions with date and serial effectivity.",
    source_module: "versioning",
    source_table: "versioning_revisions",
    key_column: "id",
    title_attribute: "revision_code",
    subtitle_attribute: "object_type",
    summary_attribute: "status",
    body_attributes: ["object_id", "effective_from", "effective_to", "lifecycle_state"],
    facet_attributes: ["object_type", "status"],
    filter_attributes: ["object_type", "status", "organization_id", "plant_id"],
    relationship_types: [],
    permission_resource: "versioning.revision",
    permission_action: "read",
    sensitivity: "internal",
    status: "active",
  },
  {
    code: "versioning_baseline",
    name: "Baselines",
    description: "Frozen logical states of selected enterprise data.",
    source_module: "versioning",
    source_table: "versioning_baselines",
    key_column: "id",
    title_attribute: "name",
    subtitle_attribute: "status",
    summary_attribute: "code",
    body_attributes: ["code", "object_count", "frozen_at"],
    facet_attributes: ["status"],
    filter_attributes: ["status", "organization_id"],
    relationship_types: [],
    permission_resource: "versioning.baseline",
    permission_action: "read",
    sensitivity: "internal",
    status: "active",
  },
  {
    code: "versioning_snapshot",
    name: "Snapshots",
    description: "Immutable resolved state snapshots.",
    source_module: "versioning",
    source_table: "versioning_snapshots",
    key_column: "id",
    title_attribute: "name",
    subtitle_attribute: "status",
    summary_attribute: "code",
    body_attributes: ["code", "object_count", "content_hash"],
    facet_attributes: ["status"],
    filter_attributes: ["status", "organization_id"],
    relationship_types: [],
    permission_resource: "versioning.snapshot",
    permission_action: "read",
    sensitivity: "internal",
    status: "active",
  },
];

let registered = false;

export function registerVersioningSearchSources() {
  if (!registered) {
    for (const source of Object.values(VERSIONING_SEARCH_SOURCES)) {
      registerSourceResolver(source.code, source);
    }
    registered = true;
  }
  return Object.keys(VERSIONING_SEARCH_SOURCES);
}

export function ensureVersioningSearchRegistration(db) {
  registerVersioningSearchSources();
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let created = 0;
  for (const tenant of tenants) {
    for (const registration of VERSIONING_SEARCH_REGISTRATIONS) {
      try {
        getObjectType(db, registration.code, tenant.id);
      } catch {
        registerObjectType(db, registration, null, tenant.id, null);
        created += 1;
      }
    }
  }
  return { registered: Object.keys(VERSIONING_SEARCH_SOURCES), registrations: created };
}

export function reindexRevision(db, revision) {
  if (!revision) return null;
  try {
    return applyIndexChange(db, {
      tenantId: revision.tenant_id,
      objectType: "versioning_revision",
      objectId: revision.id,
      operation: "upsert",
      reason: "versioning.revision",
    });
  } catch {
    return null;
  }
}

export function reindexBaseline(db, baseline) {
  if (!baseline) return null;
  try {
    return applyIndexChange(db, {
      tenantId: baseline.tenant_id,
      objectType: "versioning_baseline",
      objectId: baseline.id,
      operation: "upsert",
      reason: "versioning.baseline",
    });
  } catch {
    return null;
  }
}

export function reindexSnapshot(db, snapshot) {
  if (!snapshot) return null;
  try {
    return applyIndexChange(db, {
      tenantId: snapshot.tenant_id,
      objectType: "versioning_snapshot",
      objectId: snapshot.id,
      operation: "upsert",
      reason: "versioning.snapshot",
    });
  } catch {
    return null;
  }
}
