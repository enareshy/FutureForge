// Row -> DTO mapping for the Digital Thread domain.
//
// All SQL parsing stays in the domain services; this file only shapes database
// rows into stable public objects, so the API never leaks internal columns.
import { SOURCE_MODULE } from "./constants.js";

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return value === 1 || value === true;
}

export function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name,
    description: row.description || "",
    thread_type: row.thread_type,
    root_object_type: row.root_object_type || "",
    direction: row.direction,
    max_depth: row.max_depth,
    revision_rule_code: row.revision_rule_code || "",
    configuration_rule_code: row.configuration_rule_code || "",
    definition: parseJson(row.definition_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    version: row.version,
    status: row.status,
    display_order: row.display_order,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicDefinitionDomain(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    domain_code: row.domain_code,
    label: row.label || row.domain_code,
    description: row.description || "",
    object_types: parseJson(row.object_types_json, []),
    color: row.color || "",
    icon: row.icon || "",
    is_required: bool(row.is_required),
    display_order: row.display_order,
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function publicDefinitionRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    relationship_type: row.relationship_type,
    semantic: row.semantic,
    source_domain: row.source_domain || "",
    target_domain: row.target_domain || "",
    is_required: bool(row.is_required),
    display_order: row.display_order,
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function publicTraceabilityRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref,
    tenant_id: row.tenant_id,
    definition_code: row.definition_code || "",
    code: row.code,
    name: row.name,
    description: row.description || "",
    source_domain: row.source_domain,
    target_domain: row.target_domain,
    relationship_type: row.relationship_type || "",
    required: bool(row.required),
    severity: row.severity,
    status: row.status,
    display_order: row.display_order,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_ref: row.snapshot_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    thread_id: row.thread_id || "",
    name: row.name || "",
    description: row.description || "",
    definition_code: row.definition_code || "",
    root_object_type: row.root_object_type || "",
    root_object_id: row.root_object_id || "",
    root_revision: row.root_revision || "",
    direction: row.direction,
    query_context: parseJson(row.query_context_json, {}),
    revision_context: parseJson(row.revision_context_json, {}),
    effectivity_context: parseJson(row.effectivity_context_json, {}),
    configuration_context: parseJson(row.configuration_context_json, {}),
    status: row.status,
    immutable: bool(row.immutable),
    node_count: row.node_count,
    edge_count: row.edge_count,
    truncated: bool(row.truncated),
    consistency: row.consistency,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicSnapshotNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    node_ref: row.node_ref,
    source_object_type: row.source_object_type,
    source_object_id: row.source_object_id,
    source_object_revision_id: row.source_object_revision_id || "",
    domain: row.domain || "",
    display_name: row.display_name || "",
    number: row.number || "",
    revision: row.revision || "",
    lifecycle_state: row.lifecycle_state || "",
    organization_id: row.organization_id ?? null,
    site: row.site || "",
    node_type: row.node_type || "",
    depth: row.depth,
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function publicSnapshotEdge(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    edge_ref: row.edge_ref || "",
    source_node_ref: row.source_node_ref,
    target_node_ref: row.target_node_ref,
    relationship_type: row.relationship_type || "",
    relationship_id: row.relationship_id || "",
    relationship_direction: row.relationship_direction || "OUT",
    source_revision: row.source_revision || "",
    target_revision: row.target_revision || "",
    effectivity: parseJson(row.effectivity_json, {}),
    configuration: parseJson(row.configuration_json, {}),
    lifecycle_context: row.lifecycle_context || "",
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function publicBaseline(row) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_ref: row.baseline_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    snapshot_id: row.snapshot_id ?? null,
    name: row.name,
    description: row.description || "",
    definition_code: row.definition_code || "",
    query_context: parseJson(row.query_context_json, {}),
    status: row.status,
    immutable: bool(row.immutable),
    member_count: row.member_count,
    created_by: row.created_by ?? null,
    released_by: row.released_by ?? null,
    released_at: row.released_at || null,
    frozen_at: row.frozen_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicBaselineMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_id: row.baseline_id,
    node_ref: row.node_ref,
    domain: row.domain || "",
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id || "",
    revision: row.revision || "",
    lifecycle_state: row.lifecycle_state || "",
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function publicQueryHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    action: row.action,
    request: parseJson(row.request_json, {}),
    result_summary: parseJson(row.result_summary_json, {}),
    duration_ms: row.duration_ms,
    node_count: row.node_count,
    edge_count: row.edge_count,
    truncated: bool(row.truncated),
    actor_user_id: row.actor_user_id ?? null,
    actor_username: row.actor_username || "",
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_ref: row.entity_ref || "",
    action: row.action,
    version: row.version,
    status: row.status || "",
    before: parseJson(row.before_json, {}),
    after: parseJson(row.after_json, {}),
    summary: row.summary || "",
    actor_user_id: row.actor_user_id ?? null,
    actor_username: row.actor_username || "",
    correlation_id: row.correlation_id || "",
    details: parseJson(row.details_json, {}),
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicProjection(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    projection_key: row.projection_key,
    object_type: row.object_type,
    object_id: row.object_id,
    status: row.status,
    node: parseJson(row.node_json, {}),
    last_event_type: row.last_event_type || "",
    last_event_at: row.last_event_at || null,
    updated_at: row.updated_at,
  };
}

export function publicProjectionState(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    projection_key: row.projection_key,
    consistency: row.consistency,
    last_event_type: row.last_event_type || "",
    last_event_at: row.last_event_at || null,
    processed_count: row.processed_count,
    failed_count: row.failed_count,
    lag_ms: row.lag_ms,
    error: row.error || "",
    updated_at: row.updated_at,
  };
}

export { parseJson, bool };
