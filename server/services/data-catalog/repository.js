// Row -> public DTO mappers. This is the single place where the internal
// database shape becomes the public REST/SDK shape, keeping JSON columns parsed
// and stable for clients, tests and the frontend.
import { parseArray, parseObject } from "./validation.js";

export function publicEntry(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    entry_ref: row.entry_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    entry_type: row.entry_type,
    subject_table: row.subject_table,
    subject_id: row.subject_id,
    domain_id: row.domain_id,
    source_id: row.source_id,
    code: row.code,
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    classification: row.classification,
    owner: { user_id: row.owner_user_id, group_id: row.owner_group_id },
    steward: { user_id: row.steward_user_id, group_id: row.steward_group_id },
    version: row.version,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicMetadataVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    version: row.version,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function publicCatalogObject(row, { attributes = null, entry = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    object_ref: row.object_ref,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    domain_id: row.domain_id,
    object_type: row.object_type,
    display_name: row.display_name,
    name: row.display_name || row.object_type,
    description: row.description,
    target_object_type: row.target_object_type,
    source_id: row.source_id,
    classification: row.classification,
    status: row.status,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    version: row.version,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(entry ? { entry } : {}),
    ...(attributes ? { attributes: attributes.map(publicCatalogAttribute) } : {}),
  };
}

export function publicCatalogAttribute(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    attribute_ref: row.attribute_ref,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    object_id: row.object_id,
    attribute_name: row.attribute_name,
    name: row.attribute_name,
    display_name: row.display_name,
    description: row.description,
    data_type: row.data_type,
    mandatory: Boolean(row.mandatory),
    is_required: Boolean(row.mandatory),
    business_definition: row.business_definition,
    domain_id: row.domain_id,
    source_id: row.source_id,
    classification: row.classification,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    status: row.status,
    version: row.version,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicBusinessTerm(row, { definitions = null, synonyms = null, relations = null, mappings = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    term_ref: row.term_ref,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    code: row.code,
    name: row.name,
    preferred_name: row.preferred_name,
    definition: row.definition,
    description: row.description,
    domain_id: row.domain_id,
    status: row.status,
    approval_status: row.approval_status,
    owner: { user_id: row.owner_user_id, group_id: row.owner_group_id },
    steward: { user_id: row.steward_user_id, group_id: row.steward_group_id },
    classification: row.classification,
    version: row.version,
    workflow_instance_id: row.workflow_instance_id,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(definitions ? { definitions: definitions.map(publicTermDefinition) } : {}),
    ...(synonyms ? { synonyms: synonyms.map(publicTermSynonym) } : {}),
    ...(relations ? { relations: relations.map(publicTermRelation) } : {}),
    ...(mappings ? { mappings: mappings.map(publicTermMapping) } : {}),
  };
}

export function publicTermDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    term_id: row.term_id,
    definition_type: row.definition_type,
    definition: row.definition,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTermSynonym(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    term_id: row.term_id,
    synonym: row.synonym,
    synonym_type: row.synonym_type,
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicTermRelation(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    term_id: row.term_id,
    related_term_id: row.related_term_id,
    relationship_type: row.relationship_type,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    ...(extra || {}),
  };
}

export function publicTermMapping(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    term_id: row.term_id,
    target_type: row.target_type,
    target_id: row.target_id,
    target_ref: row.target_ref,
    created_by: row.created_by,
    created_at: row.created_at,
    ...(extra || {}),
  };
}

export function publicRelationshipType(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    source_entry_type: row.source_entry_type,
    target_entry_type: row.target_entry_type,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRelationship(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    relationship_type_id: row.relationship_type_id,
    relationship_type: row.relationship_code || null,
    from_entry_id: row.from_entry_id,
    to_entry_id: row.to_entry_id,
    attributes: parseObject(row.attributes_json, {}),
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    ...(extra || {}),
  };
}

export function publicSource(row, { mappings = null, entry = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    source_ref: row.source_ref,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    code: row.code,
    name: row.name,
    source_type: row.source_type,
    description: row.description,
    system: row.system,
    connection_reference: row.connection_reference,
    owner_user_id: row.owner_user_id,
    classification: row.classification,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(entry ? { entry } : {}),
    ...(mappings ? { mappings: mappings.map(publicSourceMapping) } : {}),
  };
}

export function publicSourceMapping(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    source_id: row.source_id,
    source_object_type: row.source_object_type,
    source_object_ref: row.source_object_ref,
    target_entry_id: row.target_entry_id,
    mapping_type: row.mapping_type,
    transformation_reference: row.transformation_reference,
    owner_user_id: row.owner_user_id,
    status: row.status,
    effective_date: row.effective_date,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicConsumer(row, { mappings = null, entry = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    consumer_ref: row.consumer_ref,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    code: row.code,
    name: row.name,
    consumer_type: row.consumer_type,
    description: row.description,
    owner_user_id: row.owner_user_id,
    purpose: row.purpose,
    frequency: row.frequency,
    classification: row.classification,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(entry ? { entry } : {}),
    ...(mappings ? { mappings: mappings.map(publicConsumerMapping) } : {}),
  };
}

export function publicConsumerMapping(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    consumer_id: row.consumer_id,
    object_id: row.object_id,
    attribute_id: row.attribute_id,
    purpose: row.purpose,
    frequency: row.frequency,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicLineage(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    from_type: row.from_type,
    from_id: row.from_id,
    from_ref: row.from_ref,
    to_type: row.to_type,
    to_id: row.to_id,
    to_ref: row.to_ref,
    relationship_type: row.relationship_type,
    transformation_reference: row.transformation_reference,
    job_ref: row.job_ref,
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicClassification(row) {
  if (!row) return null;
  return {
    id: row.id,
    classification_ref: row.classification_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    category: row.category,
    security_classification: row.security_classification,
    description: row.description,
    status: row.status,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicClassificationAssignment(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    classification_id: row.classification_id,
    classification_code: row.classification_code,
    security_classification: row.security_classification,
    assigned_by: row.assigned_by,
    assigned_at: row.assigned_at,
    ...(extra || {}),
  };
}

export function publicOwnership(row, extra = null) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entry_id: row.entry_id,
    relationship: row.relationship,
    ownership_kind: row.ownership_kind,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    is_primary: Boolean(row.is_primary),
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(extra || {}),
  };
}

export function publicImportRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    resource_type: row.resource_type,
    format: row.format,
    status: row.status,
    dry_run: Boolean(row.dry_run),
    stats: parseObject(row.stats_json, {}),
    errors: parseArray(row.errors_json, []),
    transfer_ref: row.transfer_ref,
    job_ref: row.job_ref,
    created_by: row.created_by,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}
