// Row → public DTO mappers. These are the single place where the internal
// database shape is exposed, keeping JSON columns parsed and stable for the
// REST API, SDK consumers and tests.
import { parseArray, parseObject } from "./validation.js";

export function publicDomain(row, { breadcrumb = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    domain_ref: row.domain_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    parent_id: row.parent_id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    owner: {
      user_id: row.owner_user_id,
      group_id: row.owner_group_id,
      organization_id: row.owner_organization_id,
      role_id: row.owner_role_id,
      secondary_user_id: row.secondary_owner_user_id,
    },
    steward: { user_id: row.steward_user_id, group_id: row.steward_group_id },
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(breadcrumb ? { breadcrumb } : {}),
  };
}

export function publicOwnership(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    scope_type: row.scope_type,
    scope_ref: row.scope_ref,
    object_type: row.object_type,
    attribute_name: row.attribute_name,
    relationship: row.relationship,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    is_primary: Boolean(row.is_primary),
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicCatalogObject(row, attributes = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    name: row.name,
    description: row.description,
    source_adapter: row.source_adapter,
    event_trigger: Boolean(row.event_trigger),
    schedule: row.schedule,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(attributes ? { attributes: attributes.map(publicCatalogAttribute) } : {}),
  };
}

export function publicCatalogAttribute(row) {
  if (!row) return null;
  return {
    id: row.id,
    object_id: row.object_id,
    attribute_name: row.attribute_name,
    label: row.label,
    data_type: row.data_type,
    is_required: Boolean(row.is_required),
    reference_domain: row.reference_domain,
    enum_values: parseArray(row.enum_values_json, []),
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPolicy(row, { versions = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    policy_ref: row.policy_ref,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    code: row.code,
    name: row.name,
    description: row.description,
    object_type: row.object_type,
    severity: row.severity,
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    current_version: row.current_version,
    attributes: parseArray(row.attributes_json, []),
    rule_set: parseArray(row.rule_set_json, []),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(versions ? { versions } : {}),
  };
}

export function publicPolicyVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_id: row.policy_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function publicRule(row, { versions = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    policy_id: row.policy_id,
    code: row.code,
    name: row.name,
    description: row.description,
    object_type: row.object_type,
    attribute_name: row.attribute_name,
    rule_type: row.rule_type,
    dimension: row.dimension,
    expression: parseObject(row.expression_json, {}),
    severity: row.severity,
    weight: row.weight,
    threshold: parseObject(row.threshold_json, {}),
    execution_mode: row.execution_mode,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    status: row.status,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    current_version: row.current_version,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(versions ? { versions } : {}),
  };
}

export function publicRuleVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_id: row.rule_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function publicDimension(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    weight: row.weight,
    display_order: row.display_order,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    result_ref: row.result_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    object_id: row.object_id,
    object_name: row.object_name,
    overall_score: row.overall_score,
    quality_status: row.quality_status,
    dimensions: parseObject(row.dimensions_json, {}),
    evaluation_version: row.evaluation_version,
    rule_count: row.rule_count,
    violation_count: row.violation_count,
    is_current: Boolean(row.is_current),
    triggered_by: row.triggered_by,
    duration_ms: row.duration_ms,
    evaluated_at: row.evaluated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicViolation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    result_id: row.result_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    object_id: row.object_id,
    rule_id: row.rule_id,
    rule_code: row.rule_code,
    attribute_name: row.attribute_name,
    dimension: row.dimension,
    severity: row.severity,
    message: row.message,
    detected_value: row.detected_value,
    expected_value: row.expected_value,
    is_current: Boolean(row.is_current),
    created_at: row.created_at,
  };
}

export function publicException(row, { comments = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    exception_ref: row.exception_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    object_id: row.object_id,
    attribute_name: row.attribute_name,
    rule_id: row.rule_id,
    rule_code: row.rule_code,
    dimension: row.dimension,
    severity: row.severity,
    priority: row.priority,
    description: row.description,
    detected_value: row.detected_value,
    expected_value: row.expected_value,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    assignee: {
      user_id: row.assignee_user_id,
      group_id: row.assignee_group_id,
      organization_id: row.assignee_organization_id,
    },
    status: row.status,
    sla_hours: row.sla_hours,
    due_date: row.due_date,
    escalation_level: row.escalation_level,
    escalated_at: row.escalated_at,
    resolution: row.resolution,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    verified_by: row.verified_by,
    verified_at: row.verified_at,
    closed_by: row.closed_by,
    closed_at: row.closed_at,
    waived_by: row.waived_by,
    waived_at: row.waived_at,
    waiver_reason: row.waiver_reason,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(comments ? { comments: comments.map(publicExceptionComment) } : {}),
  };
}

export function publicExceptionComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    exception_id: row.exception_id,
    author_id: row.author_id,
    comment: row.comment,
    status_change: row.status_change,
    created_at: row.created_at,
  };
}

export function publicDuplicateRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    code: row.code,
    name: row.name,
    object_type: row.object_type,
    attributes: parseArray(row.attributes_json, []),
    strategy: row.strategy,
    threshold: row.threshold,
    normalization: parseObject(row.normalization_json, {}),
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDuplicateCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_ref: row.candidate_ref,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    object_id: row.object_id,
    matched_object_id: row.matched_object_id,
    matched_object_name: row.matched_object_name,
    match_rule_id: row.match_rule_id,
    strategy: row.strategy,
    score: row.score,
    match_type: row.match_type,
    status: row.status,
    resolution: row.resolution,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    detected_at: row.detected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRemediation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    exception_id: row.exception_id,
    object_type: row.object_type,
    object_id: row.object_id,
    action_type: row.action_type,
    attribute_name: row.attribute_name,
    before_value: row.before_value,
    after_value: row.after_value,
    status: row.status,
    message: row.message,
    requested_by: row.requested_by,
    executed_by: row.executed_by,
    executed_at: row.executed_at,
    created_at: row.created_at,
  };
}

export function publicQualityJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    mode: row.mode,
    scope: parseObject(row.scope_json, {}),
    status: row.status,
    job_ref: row.job_ref,
    stats: parseObject(row.stats_json, {}),
    submitted_by: row.submitted_by,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
