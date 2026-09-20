// Search indexing service. Builds denormalised documents from registered
// source resolvers, maintains the index and relationship projections, and
// drains the durable change queue with retry / dead-letter handling.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { HttpError } from "../../validation.js";
import {
  getSourceResolver,
  listSourceResolvers,
  registerBuiltinSources,
  registerSourceResolver,
} from "./sources.js";
import {
  publicIndexedDocument,
  publicIndexStatus,
  objectTypeRow,
} from "./repository.js";
import { extractedTextFor, purgeExtractedText } from "./extracted-text.js";
import { toSqlDateTime } from "./validation.js";

const BACKOFF_SECONDS = [15, 60, 300, 900, 3600];

function backoffIso(attempts) {
  const seconds = BACKOFF_SECONDS[Math.min(Math.max(attempts - 1, 0), BACKOFF_SECONDS.length - 1)];
  return toSqlDateTime(new Date(Date.now() + seconds * 1000));
}

export function buildDocument(db, objectType, objectId, context = {}) {
  const resolver = getSourceResolver(objectType);
  if (!resolver) return null;
  const doc = resolver.resolve(db, objectId, context);
  if (!doc) return null;
  const extracted = extractedTextFor(db, doc.tenantId, doc.objectType, doc.objectId);
  if (extracted) {
    doc.searchableText = [doc.searchableText || "", extracted].filter(Boolean).join(" \n ");
  }
  return doc;
}

function replaceRelationships(db, doc) {
  run(db, "DELETE FROM search_relationships WHERE tenant_id = ? AND source_type = ? AND source_id = ?", [
    Number(doc.tenantId),
    String(doc.objectType),
    String(doc.objectId),
  ]);
  for (const rel of doc.relationships || []) {
    if (rel.target_id === undefined || rel.target_id === null || rel.target_id === "") continue;
    run(
      db,
      `INSERT OR REPLACE INTO search_relationships
         (tenant_id, source_type, source_id, target_type, target_id, relationship_type, direction, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(doc.tenantId),
        String(doc.objectType),
        String(doc.objectId),
        String(rel.target_type || "object"),
        String(rel.target_id),
        String(rel.type || ""),
        rel.direction === "in" ? "in" : "out",
        String(rel.title || rel.type_name || "").slice(0, 300),
        nowIso(),
        nowIso(),
      ]
    );
  }
}

export function upsertIndexRow(db, doc) {
  const ts = nowIso();
  run(
    db,
    `INSERT INTO search_index
       (tenant_id, organization_id, site_id, object_type, object_id, object_uuid, code, title, subtitle,
        summary, searchable_text, external_reference, status, lifecycle_state, owner_id, owner_name, classification,
        tags_json, attributes_json, relationships_json, revisions, source_revision, score_weight,
        indexed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
       organization_id = excluded.organization_id,
       site_id = excluded.site_id,
       object_uuid = excluded.object_uuid,
       code = excluded.code,
       title = excluded.title,
       subtitle = excluded.subtitle,
       summary = excluded.summary,
       searchable_text = excluded.searchable_text,
       external_reference = excluded.external_reference,
       status = excluded.status,
       lifecycle_state = excluded.lifecycle_state,
       owner_id = excluded.owner_id,
       owner_name = excluded.owner_name,
       classification = excluded.classification,
       tags_json = excluded.tags_json,
       attributes_json = excluded.attributes_json,
       relationships_json = excluded.relationships_json,
       revisions = excluded.revisions,
       source_revision = excluded.source_revision,
       score_weight = excluded.score_weight,
       indexed_at = excluded.indexed_at,
       updated_at = excluded.updated_at`,
    [
      Number(doc.tenantId),
      doc.organizationId ?? null,
      doc.siteId ?? null,
      String(doc.objectType),
      String(doc.objectId),
      doc.objectUuid ?? null,
      doc.code || "",
      doc.title || "",
      doc.subtitle || "",
      doc.summary || "",
      doc.searchableText || "",
      doc.externalReference || "",
      doc.status || "active",
      doc.lifecycleState || "",
      doc.ownerId ?? null,
      doc.ownerName || "",
      doc.classification || "internal",
      JSON.stringify(doc.tags || []),
      JSON.stringify(doc.attributes || {}),
      JSON.stringify(doc.relationships || []),
      doc.revisions ?? "",
      doc.sourceRevision ?? null,
      Number(doc.scoreWeight ?? 1),
      ts,
      ts,
      ts,
    ]
  );
  replaceRelationships(db, doc);
  return doc;
}

export function deleteIndexRow(db, tenantId, objectType, objectId) {
  run(db, "DELETE FROM search_index WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    String(objectType),
    String(objectId),
  ]);
  run(db, "DELETE FROM search_relationships WHERE tenant_id = ? AND source_type = ? AND source_id = ?", [
    Number(tenantId),
    String(objectType),
    String(objectId),
  ]);
  purgeExtractedText(db, tenantId, objectType, objectId);
}

// Applies a single change. Returns a public document or null when the source
// row no longer exists (which also removes it from the index).
export function applyIndexChange(db, { tenantId, objectType, objectId, operation = "upsert", reason = "", actor = null, ip = null, audit = false } = {}) {
  const tenant = Number(tenantId);
  const type = String(objectType);
  const id = String(objectId);
  const registration = objectTypeRow(db, type, tenant);
  if (!registration || registration.status !== "active") {
    return { skipped: true, reason: "unregistered_object_type", objectType: type, objectId: id };
  }
  if (operation === "delete") {
    deleteIndexRow(db, tenant, type, id);
  } else {
    const doc = buildDocument(db, type, id, { tenantId: tenant });
    if (!doc) {
      deleteIndexRow(db, tenant, type, id);
    } else {
      upsertIndexRow(db, doc);
    }
  }
  run(
    db,
    `UPDATE search_index_status
       SET status = 'succeeded', attempts = attempts + 1, last_error = NULL,
           indexed_at = ?, locked_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND object_type = ? AND object_id = ?`,
    [nowIso(), nowIso(), tenant, type, id]
  );
  if (audit) {
    writeAudit(db, {
      actor,
      action: "search.index.object",
      resourceType: "search_index",
      resourceId: `${type}:${id}`,
      details: { object_type: type, object_id: id, operation, reason },
      ip,
    });
  }
  return { indexed: true, objectType: type, objectId: id, operation, document: publicIndexedDocument(indexRow(db, tenant, type, id)) };
}

export function indexRow(db, tenantId, objectType, objectId) {
  return queryOne(db, "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    String(objectType),
    String(objectId),
  ]);
}

export function indexObject(db, { tenantId, objectType, objectId, reason = "manual" }, actor, ip) {
  return applyIndexChange(db, { tenantId, objectType, objectId, operation: "upsert", reason, actor, ip, audit: true });
}

export function removeFromIndex(db, { tenantId, objectType, objectId, reason = "manual" }, actor, ip) {
  return applyIndexChange(db, { tenantId, objectType, objectId, operation: "delete", reason, actor, ip, audit: true });
}

// Drains pending/failed queue rows. Safe to call repeatedly; rows are clamped
// to a processing state and transitioned atomically per object.
export function drainIndexQueue(db, { limit = 50, tenantId = null, maxAttempts = 5 } = {}) {
  const params = [];
  let where = "status IN ('pending', 'failed') AND available_at <= ?";
  params.push(nowIso());
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const rows = queryAll(
    db,
    `SELECT * FROM search_index_status WHERE ${where} ORDER BY available_at, id LIMIT ?`,
    [...params, Number(limit)]
  );
  const summary = { processed: rows.length, succeeded: 0, failed: 0, dead_lettered: 0, skipped: 0 };
  for (const row of rows) {
    run(
      db,
      "UPDATE search_index_status SET status = 'processing', locked_at = ?, updated_at = ? WHERE id = ?",
      [nowIso(), nowIso(), row.id]
    );
    try {
      const result = applyIndexChange(db, {
        tenantId: row.tenant_id,
        objectType: row.object_type,
        objectId: row.object_id,
        operation: row.operation,
      });
      if (result?.skipped) {
        summary.skipped += 1;
        continue;
      }
      summary.succeeded += 1;
    } catch (err) {
      const attempts = Number(row.attempts) + 1;
      const dead = attempts >= Number(row.max_attempts || maxAttempts);
      run(
        db,
        `UPDATE search_index_status
           SET status = ?, attempts = ?, last_error = ?, available_at = ?, locked_at = NULL, updated_at = ?
         WHERE id = ?`,
        [
          dead ? "dead_letter" : "failed",
          attempts,
          String(err.message || err).slice(0, 1000),
          backoffIso(attempts),
          nowIso(),
          row.id,
        ]
      );
      if (dead) summary.dead_lettered += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}

export function indexingStatus(db, { tenantId } = {}) {
  const tenantClause = tenantId ? "WHERE tenant_id = ?" : "";
  const params = tenantId ? [Number(tenantId)] : [];
  const queue = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM search_index_status ${tenantClause} GROUP BY status`,
    params
  );
  const documents = queryAll(
    db,
    `SELECT object_type, COUNT(*) AS count FROM search_index ${tenantClause} GROUP BY object_type`,
    params
  );
  const lastIndexed = queryOne(
    db,
    `SELECT MAX(indexed_at) AS last_indexed_at FROM search_index ${tenantClause}`,
    params
  );
  const queueMap = Object.fromEntries(queue.map((row) => [row.status, row.count]));
  return {
    documents_total: documents.reduce((sum, row) => sum + row.count, 0),
    documents_by_type: documents,
    queue: {
      pending: queueMap.pending || 0,
      processing: queueMap.processing || 0,
      succeeded: queueMap.succeeded || 0,
      failed: queueMap.failed || 0,
      dead_letter: queueMap.dead_letter || 0,
    },
    last_indexed_at: lastIndexed?.last_indexed_at || null,
  };
}

export function listIndexFailures(db, { tenantId = null, limit = 50 } = {}) {
  const params = [];
  let where = "status IN ('failed', 'dead_letter')";
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const rows = queryAll(
    db,
    `SELECT * FROM search_index_status WHERE ${where} ORDER BY updated_at DESC LIMIT ?`,
    [...params, Number(limit)]
  );
  return rows.map(publicIndexStatus);
}

export function retryIndexFailures(db, { tenantId = null, includeDeadLetter = false } = {}, actor, ip) {
  const params = [];
  const statuses = includeDeadLetter ? "('failed', 'dead_letter')" : "('failed')";
  let where = `status IN ${statuses}`;
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(
    db,
    `UPDATE search_index_status
       SET status = 'pending', attempts = 0, last_error = NULL, available_at = ?, updated_at = ?
     WHERE ${where}`,
    [nowIso(), nowIso(), ...params]
  );
  writeAudit(db, {
    actor,
    action: "search.index.retry",
    resourceType: "search_index",
    resourceId: "queue",
    details: { tenant_id: tenantId, include_dead_letter: includeDeadLetter, count: result.changes },
    ip,
  });
  return { requeued: result.changes };
}

function reindexEntries(db, entries, { tenantId, reason, actor, ip } = {}) {
  const summary = { indexed: 0, removed: 0, failed: 0 };
  for (const entry of entries) {
    try {
      const result = applyIndexChange(db, {
        tenantId: entry.tenant_id ?? tenantId,
        objectType: entry.object_type,
        objectId: entry.object_id,
        operation: "upsert",
        reason,
      });
      if (result?.skipped) continue;
      summary.indexed += 1;
    } catch {
      summary.failed += 1;
    }
  }
  writeAudit(db, {
    actor,
    action: "search.index.reindex",
    resourceType: "search_index",
    resourceId: reason,
    details: { tenant_id: tenantId, ...summary },
    ip,
  });
  return summary;
}

export function reindexObject(db, { tenantId, objectType, objectId }, actor, ip) {
  const result = applyIndexChange(db, {
    tenantId,
    objectType,
    objectId,
    operation: "upsert",
    reason: "object",
    actor,
    ip,
    audit: true,
  });
  return result;
}

// Enumerates every source row for a registered type and indexes it. Capped to
// keep API requests bounded; larger rebuilds should run through the job engine.
export function reindexType(db, { tenantId, objectType, limit = 5000 }, actor, ip) {
  const resolver = getSourceResolver(objectType);
  if (!resolver) return { indexed: 0, removed: 0, failed: 0, unsupported: true };
  const summary = { indexed: 0, removed: 0, failed: 0 };
  let afterId = 0;
  while (summary.indexed + summary.failed < limit) {
    const batchSize = Math.min(200, limit - summary.indexed - summary.failed);
    const ids = resolver.listIds(db, { tenantId, afterId, limit: batchSize });
    if (!ids.length) break;
    for (const row of ids) {
      afterId = Math.max(afterId, Number(row.id));
      try {
        applyIndexChange(db, {
          tenantId: row.tenant_id ?? tenantId,
          objectType,
          objectId: row.id,
          operation: "upsert",
          reason: "reindex",
        });
        summary.indexed += 1;
      } catch {
        summary.failed += 1;
      }
    }
    if (ids.length < batchSize) break;
  }
  writeAudit(db, {
    actor,
    action: "search.index.reindex_type",
    resourceType: "search_index",
    resourceId: objectType,
    details: { tenant_id: tenantId, ...summary },
    ip,
  });
  return summary;
}

export function reindexTenant(db, { tenantId, limit = 10000 }, actor, ip) {
  const summary = { indexed: 0, removed: 0, failed: 0, types: [] };
  for (const code of listSourceResolvers()) {
    if (!objectTypeRow(db, code, tenantId)) continue;
    const remaining = limit - summary.indexed - summary.failed;
    if (remaining <= 0) break;
    const result = reindexType(db, { tenantId, objectType: code, limit: remaining }, actor, ip);
    summary.indexed += result.indexed;
    summary.failed += result.failed;
    summary.types.push({ object_type: code, ...result });
  }
  return summary;
}

// Reindexes only the objects belonging to one organization. Enumerates source
// rows per type, resolves each document and indexes it when its
// organizationId matches. Root-tenant documents without an organization are
// intentionally skipped.
export function reindexOrganization(db, { tenantId, organizationId, limit = 10000 }, actor, ip) {
  if (!organizationId) {
    throw new HttpError(400, "organizationId is required");
  }
  const org = Number(organizationId);
  const summary = { indexed: 0, skipped: 0, failed: 0, types: [] };
  for (const code of listSourceResolvers()) {
    if (!objectTypeRow(db, code, tenantId)) continue;
    const resolver = getSourceResolver(code);
    const remaining = limit - summary.indexed - summary.failed;
    if (remaining <= 0) break;
    let afterId = 0;
    const typeSummary = { object_type: code, indexed: 0, skipped: 0, failed: 0 };
    while (typeSummary.indexed + typeSummary.skipped + typeSummary.failed < remaining) {
      const batchSize = Math.min(200, remaining - typeSummary.indexed - typeSummary.skipped - typeSummary.failed);
      const ids = resolver.listIds(db, { tenantId, afterId, limit: batchSize });
      if (!ids.length) break;
      for (const row of ids) {
        afterId = Math.max(afterId, Number(row.id));
        const doc = buildDocument(db, code, row.id, { tenantId });
        if (!doc) continue;
        if (Number(doc.organizationId) !== org) {
          typeSummary.skipped += 1;
          summary.skipped += 1;
          continue;
        }
        try {
          upsertIndexRow(db, doc);
          typeSummary.indexed += 1;
          summary.indexed += 1;
        } catch {
          typeSummary.failed += 1;
          summary.failed += 1;
        }
      }
      if (ids.length < batchSize) break;
    }
    summary.types.push(typeSummary);
  }
  writeAudit(db, {
    actor,
    action: "search.index.reindex_organization",
    resourceType: "search_index",
    resourceId: String(org),
    details: { tenant_id: tenantId, organization_id: org, ...summary },
    ip,
  });
  return summary;
}

export function pruneIndex(db, { tenantId } = {}, actor, ip) {
  const before = queryOne(
    db,
    "SELECT COUNT(*) AS count FROM search_index WHERE tenant_id = ?",
    [Number(tenantId)]
  ).count;
  const resolvers = listSourceResolvers();
  let checked = 0;
  let removed = 0;
  const rows = queryAll(db, "SELECT id, object_type, object_id FROM search_index WHERE tenant_id = ?", [
    Number(tenantId),
  ]);
  for (const row of rows) {
    if (!resolvers.includes(row.object_type)) {
      deleteIndexRow(db, tenantId, row.object_type, row.object_id);
      removed += 1;
      continue;
    }
    const doc = buildDocument(db, row.object_type, row.object_id, { tenantId });
    checked += 1;
    if (!doc) {
      deleteIndexRow(db, tenantId, row.object_type, row.object_id);
      removed += 1;
    }
  }
  writeAudit(db, {
    actor,
    action: "search.index.prune",
    resourceType: "search_index",
    resourceId: "prune",
    details: { tenant_id: tenantId, checked, removed, before },
    ip,
  });
  return { checked, removed, before };
}

export { registerBuiltinSources, listSourceResolvers, registerSourceResolver, getSourceResolver };
