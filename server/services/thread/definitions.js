// Digital thread definitions.
//
// A definition is the configurable blueprint of a thread: which lifecycle
// domains exist, which semantic links connect them, the default direction and
// traversal bounds. Resolving a definition is the single source of the
// Requirement -> Service sequence; the engine never hard-codes it.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicDefinition, publicDefinitionDomain, publicDefinitionRelationship, parseJson } from "./repository.js";
import { builtinDomains, domainCatalog } from "./domains.js";
import { definitionRef } from "./identifiers.js";
import { recordChange } from "./history.js";
import { publishThreadEvent, threadEventCode } from "./events.js";
import { definitionConflict, definitionNotFound, invalidDefinition } from "./errors.js";
import { DEFAULT_DEFINITION_CODE, DIRECTIONS, THREAD_TYPES, TRACEABILITY_LINKS } from "./constants.js";
import { assertCode, assertEnum, clampDepth, normalizeList, normalizeStatus, normalizeText, normalizeThreadType, normalizeUpper } from "./validation.js";
import { bumpEpoch } from "./cache.js";

export function getDefinitionRow(db, tenantId, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return queryOne(db, "SELECT * FROM thread_definitions WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(text)]);
  return queryOne(db, "SELECT * FROM thread_definitions WHERE tenant_id = ? AND code = ?", [Number(tenantId), text]);
}

export function requireDefinitionRow(db, tenantId, ref) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return row;
}

export function definitionDomains(db, definitionId) {
  return queryAll(db, "SELECT * FROM thread_definition_domains WHERE definition_id = ? ORDER BY display_order, id", [Number(definitionId)]).map(publicDefinitionDomain);
}

export function definitionRelationships(db, definitionId) {
  return queryAll(db, "SELECT * FROM thread_definition_relationships WHERE definition_id = ? ORDER BY display_order, id", [Number(definitionId)]).map(publicDefinitionRelationship);
}

export function getDefinition(db, tenantId, ref) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return { ...publicDefinition(row), domains: definitionDomains(db, row.id), relationships: definitionRelationships(db, row.id) };
}

export function listDefinitions(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeStatus(query.status));
  }
  if (query.thread_type || query.threadType) {
    clauses.push("thread_type = ?");
    params.push(normalizeThreadType(query.thread_type || query.threadType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = queryAll(db, `SELECT * FROM thread_definitions ${where} ORDER BY display_order, code`, params);
  return { items: rows.map(publicDefinition), total: rows.length, source_module: "thread" };
}

// Resolves a definition by code/id for traversal. Falls back to the tenant's
// default definition, then to the built-in catalog, so a traversal always has a
// coherent domain/relationship vocabulary.
export function resolveDefinition(db, tenantId, { code = null, id = null } = {}) {
  let row = null;
  if (id != null) row = getDefinitionRow(db, tenantId, id);
  if (!row && code) row = getDefinitionRow(db, tenantId, code);
  if (!row) {
    row = queryOne(db, "SELECT * FROM thread_definitions WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY display_order, id LIMIT 1", [Number(tenantId)]);
  }
  if (!row) {
    return {
      code: code || DEFAULT_DEFINITION_CODE,
      name: "Product development",
      direction: "DOWNSTREAM",
      domains: builtinDomains(),
      relationships: builtinRelationships(),
      builtin: true,
    };
  }
  return {
    ...publicDefinition(row),
    domains: definitionDomains(db, row.id),
    relationships: definitionRelationships(db, row.id),
    builtin: false,
  };
}

export function builtinRelationships() {
  return TRACEABILITY_LINKS.map((entry, index) => ({
    relationship_type: entry.relationship_type,
    semantic: entry.code,
    source_domain: entry.source_domain,
    target_domain: entry.target_domain,
    is_required: false,
    display_order: (index + 1) * 10,
    metadata: {},
  }));
}

// Relationship type codes a traversal may follow. An empty definition uses the
// full built-in catalog; a scoped definition narrows to its declared links,
// which lets an administrator restrict a thread without touching code.
export function relationshipTypesForDefinition(definition) {
  if (!definition || definition.builtin) return TRACEABILITY_LINKS.map((entry) => entry.relationship_type);
  const types = (definition.relationships || []).map((entry) => entry.relationship_type).filter(Boolean);
  return types.length ? types : TRACEABILITY_LINKS.map((entry) => entry.relationship_type);
}

function normalizeDomainsInput(input, tenantId, definitionId) {
  const list = Array.isArray(input) ? input : [];
  return list.map((entry, index) => {
    const code = normalizeUpper(entry.domain_code || entry.code, { max: 60 });
    if (!code) throw invalidDefinition("Each definition domain needs a domain_code");
    return {
      tenant_id: Number(tenantId),
      definition_id: Number(definitionId),
      domain_code: code,
      label: normalizeText(entry.label, { max: 120 }) || code,
      description: normalizeText(entry.description, { max: 1000 }),
      object_types: normalizeList(entry.object_types || entry.objectTypes).map((type) => String(type).toLowerCase()),
      color: normalizeText(entry.color, { max: 20 }),
      icon: normalizeText(entry.icon, { max: 60 }),
      is_required: entry.is_required ? 1 : 0,
      display_order: Number.isFinite(Number(entry.display_order ?? entry.displayOrder)) ? Number(entry.display_order ?? entry.displayOrder) : (index + 1) * 10,
      metadata_json: JSON.stringify(entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}),
    };
  });
}

function normalizeRelationshipsInput(input, tenantId, definitionId) {
  const list = Array.isArray(input) ? input : [];
  return list.map((entry, index) => {
    const relationshipType = normalizeText(entry.relationship_type || entry.relationshipType, { max: 200 });
    if (!relationshipType) throw invalidDefinition("Each definition relationship needs a relationship_type");
    return {
      tenant_id: Number(tenantId),
      definition_id: Number(definitionId),
      relationship_type: relationshipType,
      semantic: normalizeUpper(entry.semantic, { max: 80 }) || "CUSTOM",
      source_domain: normalizeUpper(entry.source_domain || entry.sourceDomain, { max: 60 }),
      target_domain: normalizeUpper(entry.target_domain || entry.targetDomain, { max: 60 }),
      is_required: entry.is_required ? 1 : 0,
      display_order: Number.isFinite(Number(entry.display_order ?? entry.displayOrder)) ? Number(entry.display_order ?? entry.displayOrder) : (index + 1) * 10,
      metadata_json: JSON.stringify(entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}),
    };
  });
}

function replaceChildren(db, tenantId, definitionId, body) {
  if (body.domains !== undefined) {
    run(db, "DELETE FROM thread_definition_domains WHERE definition_id = ?", [Number(definitionId)]);
    for (const domain of normalizeDomainsInput(body.domains, tenantId, definitionId)) {
      run(
        db,
        `INSERT INTO thread_definition_domains
           (definition_id, tenant_id, domain_code, label, description, object_types_json, color, icon, is_required, display_order, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          definitionId,
          domain.tenant_id,
          domain.domain_code,
          domain.label,
          domain.description,
          JSON.stringify(domain.object_types),
          domain.color,
          domain.icon,
          domain.is_required,
          domain.display_order,
          domain.metadata_json,
          nowIso(),
          nowIso(),
        ]
      );
    }
  }
  if (body.relationships !== undefined) {
    run(db, "DELETE FROM thread_definition_relationships WHERE definition_id = ?", [Number(definitionId)]);
    for (const relationship of normalizeRelationshipsInput(body.relationships, tenantId, definitionId)) {
      run(
        db,
        `INSERT INTO thread_definition_relationships
           (definition_id, tenant_id, relationship_type, semantic, source_domain, target_domain, is_required, display_order, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          definitionId,
          relationship.tenant_id,
          relationship.relationship_type,
          relationship.semantic,
          relationship.source_domain,
          relationship.target_domain,
          relationship.is_required,
          relationship.display_order,
          relationship.metadata_json,
          nowIso(),
          nowIso(),
        ]
      );
    }
  }
}

export function createDefinition(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code, { max: 64 });
  assertCode(code.toLowerCase(), "code");
  const name = normalizeText(body.name, { max: 200 });
  if (!name) throw invalidDefinition("A definition name is required");
  if (getDefinitionRow(db, tenant, code)) throw definitionConflict(code);
  const threadType = normalizeThreadType(body.thread_type || body.threadType);
  if (!THREAD_TYPES.includes(threadType)) throw assertEnum(threadType, THREAD_TYPES, "thread_type");
  const direction = normalizeUpper(body.direction, { max: 20, fallback: "DOWNSTREAM" });
  if (!DIRECTIONS.includes(direction)) throw assertEnum(direction, DIRECTIONS, "direction");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO thread_definitions
       (definition_ref, tenant_id, organization_id, code, name, description, thread_type, root_object_type, direction, max_depth,
        revision_rule_code, configuration_rule_code, definition_json, metadata_json, version, status, display_order, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      definitionRef(code),
      tenant,
      body.organization_id != null ? Number(body.organization_id) : null,
      code,
      name,
      normalizeText(body.description, { max: 2000 }),
      threadType,
      normalizeText(body.root_object_type || body.rootObjectType, { max: 120 }),
      direction,
      clampDepth(body.max_depth ?? body.maxDepth, 25),
      normalizeText(body.revision_rule_code || body.revisionRuleCode, { max: 120 }),
      normalizeText(body.configuration_rule_code || body.configurationRuleCode, { max: 120 }),
      JSON.stringify(body.definition && typeof body.definition === "object" ? body.definition : {}),
      JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      normalizeStatus(body.status, "ACTIVE"),
      Number.isFinite(Number(body.display_order ?? body.displayOrder)) ? Number(body.display_order ?? body.displayOrder) : 100,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  replaceChildren(db, tenant, id, body);
  bumpEpoch(tenant);
  const created = getDefinition(db, tenant, id);
  recordChange(db, { tenantId: tenant, entityType: "DEFINITION", entityId: id, entityRef: code, action: "CREATED", version: 1, status: created.status, after: created, summary: `Definition ${code} created`, actor, ip });
  publishThreadEvent(db, { eventType: threadEventCode("DEFINITION_CREATED"), objectType: "thread_definition", objectId: id, tenantId: tenant, payload: { code } }, actor);
  return created;
}

export function updateDefinition(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  const before = getDefinition(db, tenant, row.id);
  const version = Number(row.version || 1) + 1;
  const direction = body.direction !== undefined ? normalizeUpper(body.direction, { max: 20, fallback: row.direction }) : row.direction;
  if (!DIRECTIONS.includes(direction)) throw assertEnum(direction, DIRECTIONS, "direction");
  const threadType = body.thread_type !== undefined || body.threadType !== undefined ? normalizeThreadType(body.thread_type || body.threadType, row.thread_type) : row.thread_type;
  run(
    db,
    `UPDATE thread_definitions SET
       name = ?, description = ?, thread_type = ?, root_object_type = ?, direction = ?, max_depth = ?,
       revision_rule_code = ?, configuration_rule_code = ?, definition_json = ?, metadata_json = ?,
       version = ?, status = ?, display_order = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      body.name !== undefined ? normalizeText(body.name, { max: 200 }) || row.name : row.name,
      body.description !== undefined ? normalizeText(body.description, { max: 2000 }) : row.description,
      threadType,
      body.root_object_type !== undefined || body.rootObjectType !== undefined ? normalizeText(body.root_object_type || body.rootObjectType, { max: 120 }) : row.root_object_type,
      direction,
      body.max_depth !== undefined || body.maxDepth !== undefined ? clampDepth(body.max_depth ?? body.maxDepth, row.max_depth) : row.max_depth,
      body.revision_rule_code !== undefined || body.revisionRuleCode !== undefined ? normalizeText(body.revision_rule_code || body.revisionRuleCode, { max: 120 }) : row.revision_rule_code,
      body.configuration_rule_code !== undefined || body.configurationRuleCode !== undefined ? normalizeText(body.configuration_rule_code || body.configurationRuleCode, { max: 120 }) : row.configuration_rule_code,
      body.definition !== undefined ? JSON.stringify(body.definition && typeof body.definition === "object" ? body.definition : {}) : row.definition_json,
      body.metadata !== undefined ? JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}) : row.metadata_json,
      version,
      body.status !== undefined ? normalizeStatus(body.status, row.status) : row.status,
      body.display_order !== undefined || body.displayOrder !== undefined ? Number(body.display_order ?? body.displayOrder) : row.display_order,
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  replaceChildren(db, tenant, row.id, body);
  bumpEpoch(tenant);
  const after = getDefinition(db, tenant, row.id);
  recordChange(db, { tenantId: tenant, entityType: "DEFINITION", entityId: row.id, entityRef: row.code, action: "UPDATED", version, status: after.status, before, after, summary: `Definition ${row.code} updated`, actor, ip });
  publishThreadEvent(db, { eventType: threadEventCode("DEFINITION_UPDATED"), objectType: "thread_definition", objectId: row.id, tenantId: tenant, payload: { code: row.code, version } }, actor);
  return after;
}

export function setDefinitionStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDefinitionRow(db, tenant, ref);
  const normalized = normalizeStatus(status, row.status);
  run(db, "UPDATE thread_definitions SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [normalized, actor?.id ?? null, nowIso(), row.id]);
  bumpEpoch(tenant);
  const after = getDefinition(db, tenant, row.id);
  recordChange(db, { tenantId: tenant, entityType: "DEFINITION", entityId: row.id, entityRef: row.code, action: "STATUS_CHANGED", version: row.version, status: normalized, after, summary: `Definition ${row.code} ${normalized}`, actor, ip });
  if (normalized === "ACTIVE") {
    publishThreadEvent(db, { eventType: threadEventCode("DEFINITION_ACTIVATED"), objectType: "thread_definition", objectId: row.id, tenantId: tenant, payload: { code: row.code } }, actor);
  }
  return after;
}

export function deleteDefinition(db, tenantId, ref, actor = null, ip = null) {
  return setDefinitionStatus(db, tenantId, ref, "ARCHIVED", actor, ip);
}

export function definitionSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT status, COUNT(*) AS c FROM thread_definitions WHERE tenant_id = ? GROUP BY status", [Number(tenantId)]);
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.c)]));
  return { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), by_status: byStatus };
}

export function ensureDefaultDefinitions(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  if (!getDefinitionRow(db, tenant, DEFAULT_DEFINITION_CODE)) {
    createDefinition(
      db,
      tenant,
      {
        code: DEFAULT_DEFINITION_CODE,
        name: "Product development",
        description: "Requirement to service digital thread across engineering, manufacturing, quality and service.",
        thread_type: "PRODUCT_DEVELOPMENT",
        root_object_type: "requirement",
        direction: "DOWNSTREAM",
        max_depth: 25,
        status: "ACTIVE",
        display_order: 10,
        definition: { catalog: true },
        domains: builtinDomains(),
        relationships: builtinRelationships(),
      },
      null,
      null
    );
    created += 1;
  }
  return { created };
}

export { domainCatalog, parseJson };
