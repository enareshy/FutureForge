// Event Registry and Schema Registry.
//
// The registry is the authoritative catalogue of event types. New event types
// can be added at runtime without touching framework code; schema versions are
// stored per type so consumers can rely on a stable contract and breaking
// changes force a new version.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  assertEventTypeCode,
  assertEnum,
  EVENT_STATUSES,
  VERSION_STATUSES,
  normalizeCategory,
  normalizeEventStatus,
  normalizeVersionStatus,
  normalizeCompatibility,
  normalizeClassification,
  normalizeReplayPolicy,
  normalizeOrderingScope,
  normalizePriority,
  clampInt,
  toJson,
  safeParse,
  compareSchemas,
  validatePayloadAgainstSchema,
} from "./validation.js";
import { publicEventType, publicSchemaVersion } from "./repository.js";
import { auditEvent } from "./hooks.js";

// The platform's default domain catalogue. Business modules publish these
// without any manual catalogue maintenance; anything missing can be registered
// at runtime through the API.
export const SYSTEM_EVENT_TYPES = [
  { code: "ObjectCreated", category: "object", source_module: "objects", description: "A business object was created." },
  { code: "ObjectUpdated", category: "object", source_module: "objects", description: "A business object was updated." },
  { code: "ObjectDeleted", category: "object", source_module: "objects", description: "A business object was deleted." },
  { code: "RelationshipCreated", category: "object", source_module: "objects", description: "A relationship between objects was created." },
  { code: "RelationshipDeleted", category: "object", source_module: "objects", description: "A relationship between objects was removed." },
  { code: "ProductCreated", category: "product", source_module: "product-data", description: "A product master record was created." },
  { code: "ProductUpdated", category: "product", source_module: "product-data", description: "A product master record was updated." },
  { code: "ProductReleased", category: "product", source_module: "product-data", description: "A product revision was released.", ordering_scope: "object", ordering_required: true },
  { code: "ProductObsoleted", category: "product", source_module: "product-data", description: "A product was obsoleted." },
  { code: "ProductRevisionCreated", category: "product", source_module: "product-data", description: "A new product revision was created." },
  { code: "BOMCreated", category: "bom", source_module: "bom", description: "A bill of material was created." },
  { code: "BOMUpdated", category: "bom", source_module: "bom", description: "A bill of material was updated." },
  { code: "BOMReleased", category: "bom", source_module: "bom", description: "A bill of material was released.", ordering_scope: "object", ordering_required: true },
  { code: "DocumentCreated", category: "document", source_module: "files", description: "A document was created." },
  { code: "DocumentReleased", category: "document", source_module: "files", description: "A document version was released." },
  { code: "ChangeRequestCreated", category: "change", source_module: "change", description: "An engineering change request was created." },
  { code: "ChangeReleased", category: "change", source_module: "change", description: "An engineering change was released." },
  { code: "WorkflowStarted", category: "workflow", source_module: "workflow", description: "A workflow instance was started." },
  { code: "WorkflowCompleted", category: "workflow", source_module: "workflow", description: "A workflow instance completed." },
  { code: "WorkflowTaskAssigned", category: "workflow", source_module: "workflow", description: "A workflow task was assigned." },
  { code: "LifecycleStateChanged", category: "lifecycle", source_module: "lifecycle", description: "An object changed lifecycle state.", ordering_scope: "object", ordering_required: true },
  { code: "ItemStatusChanged", category: "lifecycle", source_module: "lifecycle", description: "An item status changed." },
  { code: "ManufacturingStructureUpdated", category: "manufacturing", source_module: "manufacturing", description: "A manufacturing structure was updated." },
  { code: "QualityIssueRaised", category: "quality", source_module: "quality", description: "A quality issue was raised." },
  { code: "ProjectCreated", category: "project", source_module: "projects", description: "A project was created." },
  { code: "UserCreated", category: "user", source_module: "iam", description: "A user account was created." },
  { code: "UserUpdated", category: "user", source_module: "iam", description: "A user account was updated." },
  { code: "SecurityAccessDenied", category: "security", source_module: "iam", description: "An access attempt was denied.", security_classification: "confidential", replay_policy: "denied" },
  { code: "SecurityPolicyChanged", category: "security", source_module: "iam", description: "A security policy, entitlement or rule changed.", security_classification: "confidential" },
  { code: "IntegrationExecutionCompleted", category: "integration", source_module: "integration", description: "An integration execution completed." },
  { code: "AnalyticsMetricRecorded", category: "analytics", source_module: "analytics", description: "An analytics metric was recorded." },
];

// ── Event types ─────────────────────────────────────────────────────────────
export function listEventTypes(db, { tenantId, category, status, sourceModule, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (sourceModule) {
    clauses.push("source_module = ?");
    params.push(sourceModule);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_registry ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_registry ${where} ORDER BY category, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicEventType(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getEventTypeRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_registry WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getEventType(db, refValue) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  const versions = listVersions(db, row.code);
  const subscribers = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE event_type_code = ?", [row.code]).c;
  return publicEventType(row, { versions, subscriberCount: subscribers });
}

export function createEventType(db, input = {}, actor = null, tenantId = null) {
  assertEventTypeCode(input.code);
  const existing = getEventTypeRow(db, input.code);
  if (existing) return publicEventType(existing);
  const version = clampInt(input.version, 1, 100000, 1);
  const schema = input.schema && typeof input.schema === "object" ? input.schema : {};
  const example = input.example && typeof input.example === "object" ? input.example : {};
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_registry
      (code, name, description, category, source_module, version, security_classification, retention_days, replay_policy,
       ordering_required, ordering_scope, default_priority, status, enabled, system, schema_json, example_json, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.code,
      input.name || input.code,
      input.description || "",
      normalizeCategory(input.category),
      input.source_module || "",
      version,
      normalizeClassification(input.security_classification),
      clampInt(input.retention_days, 1, 3650, 90),
      normalizeReplayPolicy(input.replay_policy),
      input.ordering_required ? 1 : 0,
      normalizeOrderingScope(input.ordering_scope),
      normalizePriority(input.default_priority),
      normalizeEventStatus(input.status),
      input.enabled === false ? 0 : 1,
      input.system ? 1 : 0,
      toJson(schema, {}),
      toJson(example, {}),
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const typeId = Number(result.lastInsertRowid);
  run(
    db,
    `INSERT INTO event_schemas (event_type_id, version, status, compatibility, schema_json, example_json, notes, created_by, created_at, updated_at)
     VALUES (?, ?, 'active', 'backward', ?, ?, '', ?, ?, ?)`,
    [typeId, version, toJson(schema, {}), toJson(example, {}), actor?.id ?? null, ts, ts]
  );
  auditEvent(db, { actor, action: "event.type.create", resourceType: "event_registry", resourceId: typeId, details: { code: input.code, version } });
  return publicEventType(queryOne(db, "SELECT * FROM event_registry WHERE id = ?", [typeId]));
}

export function updateEventType(db, refValue, input = {}, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  if (input.status !== undefined) assertEnum(input.status, EVENT_STATUSES, "status");
  run(
    db,
    `UPDATE event_registry SET name=?, description=?, category=?, source_module=?, security_classification=?, retention_days=?,
       replay_policy=?, ordering_required=?, ordering_scope=?, default_priority=?, status=?, enabled=?, example_json=?, updated_at=?
     WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.category !== undefined ? normalizeCategory(input.category) : row.category,
      input.source_module !== undefined ? input.source_module : row.source_module,
      input.security_classification !== undefined ? normalizeClassification(input.security_classification) : row.security_classification,
      input.retention_days !== undefined ? clampInt(input.retention_days, 1, 3650, row.retention_days) : row.retention_days,
      input.replay_policy !== undefined ? normalizeReplayPolicy(input.replay_policy) : row.replay_policy,
      input.ordering_required !== undefined ? (input.ordering_required ? 1 : 0) : row.ordering_required,
      input.ordering_scope !== undefined ? normalizeOrderingScope(input.ordering_scope) : row.ordering_scope,
      input.default_priority !== undefined ? normalizePriority(input.default_priority) : row.default_priority,
      input.status !== undefined ? normalizeEventStatus(input.status) : row.status,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : row.enabled,
      input.example !== undefined ? toJson(input.example, {}) : row.example_json,
      nowIso(),
      row.id,
    ]
  );
  auditEvent(db, { actor, action: "event.type.update", resourceType: "event_registry", resourceId: row.id, details: { code: row.code } });
  return publicEventType(queryOne(db, "SELECT * FROM event_registry WHERE id = ?", [row.id]));
}

export function deleteEventType(db, refValue, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  if (row.system) throw new HttpError(409, "System event types cannot be deleted");
  const inUse = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE event_type_code = ?", [row.code]).c;
  if (inUse) throw new HttpError(409, "Event type is referenced by subscriptions");
  run(db, "DELETE FROM event_registry WHERE id = ?", [row.id]);
  run(db, "DELETE FROM event_schemas WHERE event_type_id = ?", [row.id]);
  auditEvent(db, { actor, action: "event.type.delete", resourceType: "event_registry", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

export function ensureDefaultEventTypes(db) {
  let created = 0;
  let repaired = 0;
  for (const entry of SYSTEM_EVENT_TYPES) {
    const existing = getEventTypeRow(db, entry.code);
    if (!existing) {
      createEventType(db, { ...entry, system: true }, null, null);
      created += 1;
      continue;
    }
    // A domain module may have auto-registered a catalogue code before the
    // foundation was installed. The catalogue is authoritative, so repair the
    // row (system flag + declared metadata) rather than leaving it ad-hoc.
    if (Number(existing.system) !== 1) {
      run(
        db,
        `UPDATE event_registry SET name = ?, description = ?, category = ?, source_module = ?, security_classification = ?,
           retention_days = ?, replay_policy = ?, ordering_required = ?, ordering_scope = ?, default_priority = ?,
           status = 'active', enabled = 1, system = 1, updated_at = ?
         WHERE id = ?`,
        [
          entry.name || entry.code,
          entry.description || "",
          normalizeCategory(entry.category),
          entry.source_module || "",
          normalizeClassification(entry.security_classification),
          clampInt(entry.retention_days, 1, 3650, 90),
          normalizeReplayPolicy(entry.replay_policy),
          entry.ordering_required ? 1 : 0,
          normalizeOrderingScope(entry.ordering_scope),
          normalizePriority(entry.default_priority),
          nowIso(),
          existing.id,
        ]
      );
      repaired += 1;
    }
  }
  return { created, repaired, total: SYSTEM_EVENT_TYPES.length };
}

// ── Schema / version registry ───────────────────────────────────────────────
export function listVersions(db, refValue) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  const rows = queryAll(db, "SELECT * FROM event_schemas WHERE event_type_id = ? ORDER BY version DESC", [row.id]);
  return rows.map(publicSchemaVersion);
}

export function getVersionRow(db, eventTypeId, version) {
  return queryOne(db, "SELECT * FROM event_schemas WHERE event_type_id = ? AND version = ?", [Number(eventTypeId), Number(version)]);
}

// Adds a schema version. A breaking change (per compareSchemas) is allowed but
// flagged; the caller can pass `compatibility` to record the decision. The
// type's current version is advanced when the new version is higher.
export function addVersion(db, refValue, input = {}, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  const version = clampInt(input.version, 1, 100000, Number(row.version) + 1);
  if (getVersionRow(db, row.id, version)) throw new HttpError(409, `Version ${version} already exists`);
  const latest = queryOne(db, "SELECT * FROM event_schemas WHERE event_type_id = ? ORDER BY version DESC LIMIT 1", [row.id]);
  const schema = input.schema && typeof input.schema === "object" ? input.schema : safeParse(row.schema_json, {});
  const example = input.example && typeof input.example === "object" ? input.example : {};
  const comparison = latest ? compareSchemas(safeParse(latest.schema_json, {}), schema) : { compatible: true, compatibility: "backward", changes: [] };
  const compatibility = input.compatibility ? normalizeCompatibility(input.compatibility) : comparison.compatibility;
  assertEnum(compatibility, ["none", "backward", "forward", "full"], "compatibility");
  const status = normalizeVersionStatus(input.status || "active");
  const ts = nowIso();
  if (status === "active") {
    run(db, "UPDATE event_schemas SET status = 'deprecated', updated_at = ? WHERE event_type_id = ? AND status = 'active'", [ts, row.id]);
  }
  const result = run(
    db,
    `INSERT INTO event_schemas (event_type_id, version, status, compatibility, schema_json, example_json, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, version, status, compatibility, toJson(schema, {}), toJson(example, {}), input.notes || "", actor?.id ?? null, ts, ts]
  );
  if (version >= Number(row.version)) {
    run(db, "UPDATE event_registry SET version = ?, schema_json = ?, example_json = ?, updated_at = ? WHERE id = ?", [
      version,
      toJson(schema, {}),
      toJson(example, {}),
      ts,
      row.id,
    ]);
  }
  auditEvent(db, { actor, action: "event.schema.version", resourceType: "event_registry", resourceId: row.id, details: { code: row.code, version, compatibility } });
  return { version: publicSchemaVersion(queryOne(db, "SELECT * FROM event_schemas WHERE id = ?", [Number(result.lastInsertRowid)])), comparison };
}

export function setVersionStatus(db, refValue, version, status, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  assertEnum(status, VERSION_STATUSES, "status");
  const target = getVersionRow(db, row.id, version);
  if (!target) throw new HttpError(404, "Schema version not found");
  run(db, "UPDATE event_schemas SET status = ?, updated_at = ? WHERE id = ?", [normalizeVersionStatus(status), nowIso(), target.id]);
  auditEvent(db, { actor, action: "event.schema.status", resourceType: "event_registry", resourceId: row.id, details: { code: row.code, version, status } });
  return publicSchemaVersion(queryOne(db, "SELECT * FROM event_schemas WHERE id = ?", [target.id]));
}

// Checks a candidate payload/schema for compatibility with the registered type.
export function checkCompatibility(db, refValue, input = {}) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  const current = safeParse(row.schema_json, {});
  const candidate = input.schema && typeof input.schema === "object" ? input.schema : current;
  const comparison = compareSchemas(current, candidate);
  const errors = input.payload !== undefined ? validatePayloadAgainstSchema(input.payload, candidate) : [];
  return { event_type_code: row.code, current_version: row.version, ...comparison, payload_valid: errors.length === 0, payload_errors: errors };
}

// Resolves the effective schema for a concrete event. When a version is given
// and unknown the caller decides whether to fall back; `strict` rejects it.
export function resolveSchema(db, eventTypeCode, version, { strict = false } = {}) {
  const row = getEventTypeRow(db, eventTypeCode);
  if (!row) throw new HttpError(404, `Unknown event type ${eventTypeCode}`);
  const requested = version === undefined || version === null ? Number(row.version) : Number(version);
  const schemaRow = getVersionRow(db, row.id, requested);
  if (!schemaRow) {
    if (strict && requested !== Number(row.version)) throw new HttpError(400, `Unsupported version ${requested} for ${row.code}`);
    return { type: row, schema: safeParse(row.schema_json, {}), version: Number(row.version), resolved: false };
  }
  if (schemaRow.status === "retired" && strict) throw new HttpError(400, `Event version ${row.code}.v${requested} is retired`);
  return { type: row, schema: safeParse(schemaRow.schema_json, {}), version: requested, resolved: true, versionStatus: schemaRow.status };
}
