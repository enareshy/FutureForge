// Business glossary: terms, definitions, synonyms, term relationships,
// term-to-asset mappings and the term lifecycle/approval workflow.
//
// Terms are business concepts, distinct from technical catalog objects. The
// service records the vocabulary and its approval state; the platform Workflow
// service drives any human approval steps and notifications.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertDefinitionType,
  assertSecurityClassification,
  assertSynonymType,
  assertTermApprovalStatus,
  assertTermRelationship,
  assertTermStatus,
  assertTermTargetType,
  assertTermTransition,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireName,
} from "./validation.js";
import { termRef } from "./refs.js";
import {
  publicBusinessTerm,
  publicTermDefinition,
  publicTermSynonym,
  publicTermRelation,
  publicTermMapping,
} from "./repository.js";
import {
  termNotFound,
  termConflict,
  invalidTerm,
  definitionNotFound,
  invalidDefinition,
  termApprovalRequired,
  mappingNotFound,
  invalidMapping,
} from "./errors.js";
import { registerEntry, syncEntry, commitEntryChange, getEntryRow, subjectTableFor } from "./entries.js";
import { getConfig } from "./configuration.js";
import { publishCatalogEvent } from "./events.js";
import { getDefinition, startInstance } from "../workflow.js";

export {
  publicBusinessTerm,
  publicTermDefinition,
  publicTermSynonym,
  publicTermRelation,
  publicTermMapping,
};

export const TERM_APPROVAL_WORKFLOW_CODE = "business-term-approval";

export function getTermRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [numeric]);
  }
  const text = String(ref);
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  const params = tenantId ? [text, Number(tenantId)] : [text];
  return (
    queryOne(db, `SELECT * FROM dc_business_terms WHERE term_ref = ?${scoped}`, params) ||
    queryOne(db, `SELECT * FROM dc_business_terms WHERE code = ?${scoped}`, [normalizeUpper(text), ...(tenantId ? [Number(tenantId)] : [])]) ||
    null
  );
}

export function findTermByCode(db, tenantId, code) {
  return queryOne(db, "SELECT * FROM dc_business_terms WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(code)]);
}

export function requireTerm(db, ref, tenantId = null) {
  const row = getTermRow(db, ref, tenantId);
  if (!row) throw termNotFound(ref);
  return row;
}

export function listTerms(db, { tenantId, domainId, status, approvalStatus, classification, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertTermStatus(normalizeLower(status)));
  }
  if (approvalStatus) {
    clauses.push("approval_status = ?");
    params.push(assertTermApprovalStatus(normalizeLower(approvalStatus)));
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(assertSecurityClassification(normalizeLower(classification)));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(definition) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_business_terms ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_business_terms ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicBusinessTerm(row)), total, page: currentPage, page_size: limit };
}

export function listTermDefinitions(db, termId) {
  return queryAll(db, "SELECT * FROM dc_term_definitions WHERE term_id = ? ORDER BY definition_type", [Number(termId)]).map(
    publicTermDefinition
  );
}

export function listTermSynonyms(db, termId) {
  return queryAll(db, "SELECT * FROM dc_term_synonyms WHERE term_id = ? ORDER BY synonym", [Number(termId)]).map(publicTermSynonym);
}

export function listTermRelations(db, termId) {
  return queryAll(db, "SELECT * FROM dc_term_relations WHERE term_id = ? ORDER BY relationship_type", [Number(termId)]).map(
    publicTermRelation
  );
}

export function listTermMappings(db, termId) {
  return queryAll(db, "SELECT * FROM dc_term_mappings WHERE term_id = ? ORDER BY target_type", [Number(termId)]).map(publicTermMapping);
}

export function getTerm(db, ref, { include = true, tenantId = null } = {}) {
  const row = requireTerm(db, ref, tenantId);
  if (!include) return publicBusinessTerm(row);
  return publicBusinessTerm(row, {
    definitions: listTermDefinitions(db, row.id),
    synonyms: listTermSynonyms(db, row.id),
    relations: listTermRelations(db, row.id),
    mappings: listTermMappings(db, row.id),
  });
}

export function createTerm(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(requireName(input.code, "Term code"));
  const existing = findTermByCode(db, tenantId, code);
  if (existing) throw termConflict(code);
  const name = normalizeText(input.name) || code;
  const status = assertTermStatus(normalizeLower(input.status || "draft"));
  const classification = assertSecurityClassification(normalizeLower(input.classification || "internal"));
  const approvalStatus = status === "approved" || status === "active" ? "approved" : "pending";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_business_terms
      (term_ref, tenant_id, code, name, preferred_name, definition, description, domain_id, status, approval_status,
       owner_user_id, owner_group_id, steward_user_id, steward_group_id, classification, version, metadata_json,
       created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      termRef(code),
      Number(tenantId),
      code,
      name,
      normalizeText(input.preferred_name) || name,
      normalizeText(input.definition),
      normalizeText(input.description),
      input.domain_id ? Number(input.domain_id) : null,
      status,
      approvalStatus,
      input.owner_user_id ?? null,
      input.owner_group_id ?? null,
      input.steward_user_id ?? null,
      input.steward_group_id ?? null,
      classification,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [Number(result.lastInsertRowid)]);
  const entry = registerEntry(
    db,
    {
      entry_type: "BUSINESS_TERM",
      code,
      name,
      display_name: row.preferred_name,
      description: row.definition || row.description,
      domain_id: row.domain_id,
      classification,
      owner_user_id: row.owner_user_id,
      steward_user_id: row.steward_user_id,
      subject_table: subjectTableFor("BUSINESS_TERM"),
      subject_id: row.id,
      metadata: parseObject(row.metadata_json, {}),
    },
    actor,
    tenantId
  );
  run(db, "UPDATE dc_business_terms SET entry_id = ? WHERE id = ?", [entry.id, row.id]);
  if (input.definition) upsertDefinition(db, row.id, { definition_type: "BUSINESS", definition: input.definition }, actor, tenantId);
  if (Array.isArray(input.synonyms)) {
    for (const synonym of input.synonyms) addSynonym(db, row.id, synonym, actor, tenantId);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.term.create",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { code, entry_id: entry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermCreated",
    tenantId: Number(tenantId),
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code, name, entry_id: entry.id, entry_ref: entry.entry_ref },
  }, actor);
  return getTerm(db, row.id, { tenantId });
}

export function updateTerm(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireTerm(db, ref, tenantId);
  if (["retired"].includes(row.status) && !patch.allow_retired) {
    throw invalidTerm("A retired term cannot be modified; reactivate it first", { status: row.status });
  }
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.code !== undefined) {
    const code = normalizeUpper(requireName(patch.code, "Term code"));
    const clash = queryOne(db, "SELECT id FROM dc_business_terms WHERE tenant_id = ? AND code = ? AND id <> ?", [row.tenant_id, code, row.id]);
    if (clash) throw termConflict(code);
    assign("code", code);
  }
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.code);
  if (patch.preferred_name !== undefined) assign("preferred_name", normalizeText(patch.preferred_name) || row.name);
  if (patch.definition !== undefined) assign("definition", normalizeText(patch.definition));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.classification !== undefined) assign("classification", assertSecurityClassification(normalizeLower(patch.classification)));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.owner_group_id !== undefined) assign("owner_group_id", patch.owner_group_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (patch.steward_group_id !== undefined) assign("steward_group_id", patch.steward_group_id ?? null);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return getTerm(db, row.id, { tenantId });

  const nextVersion = Number(row.version || 1) + 1;
  assign("version", nextVersion);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_business_terms SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);

  if (patch.definition !== undefined) {
    upsertDefinition(db, row.id, { definition_type: "BUSINESS", definition: patch.definition }, actor, tenantId);
  }
  if (row.entry_id) {
    syncEntry(
      db,
      row.entry_id,
      {
        name: updated.name,
        display_name: updated.preferred_name,
        description: updated.definition || updated.description,
        domain_id: updated.domain_id,
        classification: updated.classification,
        owner_user_id: updated.owner_user_id,
        steward_user_id: updated.steward_user_id,
        metadata: parseObject(updated.metadata_json, {}),
      },
      actor
    );
    commitEntryChange(db, row.entry_id, { change_summary: `term updated: ${Object.keys(patch).join(", ")}` }, actor);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.term.update",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { code: updated.code, fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermUpdated",
    tenantId: row.tenant_id,
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code: updated.code, fields: Object.keys(patch) },
  }, actor);
  return publicBusinessTerm(updated);
}

function startTermApprovalWorkflow(db, term, actor, ip) {
  const workflowCode = normalizeText(parseObject(term.metadata_json, {}).workflow_code, { max: 120 }) || TERM_APPROVAL_WORKFLOW_CODE;
  try {
    // The platform Workflow service drives human approval. This is best-effort:
    // if no matching definition is published the term still enters review and
    // can be approved through the REST endpoint.
    getDefinition(db, workflowCode, term.tenant_id);
    const instance = startInstance(
      db,
      {
        workflow_code: workflowCode,
        title: `Business term approval: ${term.name}`,
        context: { term_id: term.id, term_ref: term.term_ref, code: term.code },
      },
      actor,
      term.tenant_id,
      ip
    );
    return instance?.id ?? null;
  } catch {
    return null;
  }
}

export function submitTerm(db, ref, { comment = "" } = {}, actor = null, tenantId = null, ip = null) {
  const row = requireTerm(db, ref, tenantId);
  if (row.status !== "draft" && row.status !== "in_review") {
    throw invalidTerm(`Only a draft term can be submitted for review (current: ${row.status})`, { status: row.status });
  }
  const requireDefinition = getConfig(db, row.tenant_id, "require_definition_for_approval");
  const definitions = listTermDefinitions(db, row.id);
  if (requireDefinition && !row.definition && !definitions.length) {
    throw termApprovalRequired({ term_id: row.id, code: row.code });
  }
  const next = assertTermTransition(row.status, "in_review");
  const ts = nowIso();
  const workflowInstanceId = startTermApprovalWorkflow(db, row, actor, ip);
  run(
    db,
    "UPDATE dc_business_terms SET status = ?, approval_status = 'in_review', submitted_at = ?, workflow_instance_id = COALESCE(?, workflow_instance_id), version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
    [next, ts, workflowInstanceId, actor?.id ?? null, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);
  if (row.entry_id) {
    syncEntry(db, row.entry_id, { status: "draft" }, actor);
    commitEntryChange(db, row.entry_id, { change_summary: "term submitted for review" }, actor);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.term.submit",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { code: row.code, workflow_instance_id: workflowInstanceId, comment: normalizeText(comment, { max: 500 }) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermSubmitted",
    tenantId: row.tenant_id,
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code: row.code, workflow_instance_id: workflowInstanceId },
  }, actor);
  return publicBusinessTerm(updated);
}

export function approveTerm(db, ref, { comment = "" } = {}, actor = null, tenantId = null, ip = null) {
  const row = requireTerm(db, ref, tenantId);
  if (!["in_review", "draft"].includes(row.status)) {
    throw invalidTerm(`Only a term in review can be approved (current: ${row.status})`, { status: row.status });
  }
  const next = assertTermTransition(row.status, "approved");
  const ts = nowIso();
  run(
    db,
    "UPDATE dc_business_terms SET status = ?, approval_status = 'approved', approved_at = ?, approved_by = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
    [next, ts, actor?.id ?? null, actor?.id ?? null, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);
  if (row.entry_id) {
    syncEntry(db, row.entry_id, { status: "active" }, actor);
    commitEntryChange(db, row.entry_id, { change_summary: "term approved" }, actor);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.term.approve",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { code: row.code, comment: normalizeText(comment, { max: 500 }) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermApproved",
    tenantId: row.tenant_id,
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code: row.code, approved_by: actor?.id ?? null },
  }, actor);
  return publicBusinessTerm(updated);
}

export function rejectTerm(db, ref, { comment = "" } = {}, actor = null, tenantId = null, ip = null) {
  const row = requireTerm(db, ref, tenantId);
  if (row.status !== "in_review") {
    throw invalidTerm(`Only a term in review can be rejected (current: ${row.status})`, { status: row.status });
  }
  const ts = nowIso();
  run(
    db,
    "UPDATE dc_business_terms SET status = 'draft', approval_status = 'rejected', version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
    [actor?.id ?? null, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);
  if (row.entry_id) commitEntryChange(db, row.entry_id, { change_summary: "term rejected" }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.term.reject",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { code: row.code, comment: normalizeText(comment, { max: 500 }) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermUpdated",
    tenantId: row.tenant_id,
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code: row.code, approval_status: "rejected" },
  }, actor);
  return publicBusinessTerm(updated);
}

export function setTermStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireTerm(db, ref, tenantId);
  const next = assertTermStatus(normalizeLower(status));
  assertTermTransition(row.status, next);
  const ts = nowIso();
  const approvalStatus =
    next === "approved" || next === "active" ? "approved" : next === "retired" ? row.approval_status : row.approval_status;
  const activates = next === "approved" || next === "active";
  run(
    db,
    `UPDATE dc_business_terms SET status = ?, approval_status = ?, approved_at = CASE WHEN ? THEN COALESCE(approved_at, ?) ELSE approved_at END,
      approved_by = CASE WHEN ? THEN COALESCE(approved_by, ?) ELSE approved_by END, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
    [next, approvalStatus, activates ? 1 : 0, ts, activates ? 1 : 0, actor?.id ?? null, actor?.id ?? null, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);
  if (row.entry_id) {
    syncEntry(db, row.entry_id, { status: next === "active" || next === "approved" ? "active" : next === "retired" ? "retired" : next === "deprecated" ? "deprecated" : "draft" }, actor);
    commitEntryChange(db, row.entry_id, { change_summary: `term status: ${next}` }, actor);
  }
  const eventType =
    next === "retired" ? "BusinessTermRetired" : next === "deprecated" ? "BusinessTermDeprecated" : next === "approved" || next === "active" ? "BusinessTermApproved" : "BusinessTermUpdated";
  writeAudit(db, {
    actor,
    action: "data_catalog.term.status",
    resourceType: "dc_business_term",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  publishCatalogEvent(db, {
    eventType,
    tenantId: row.tenant_id,
    objectType: "business_term",
    objectId: row.id,
    payload: { id: row.id, code: row.code, status: next },
  }, actor);
  return publicBusinessTerm(updated);
}

export function upsertDefinition(db, termRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const definitionType = assertDefinitionType(normalizeUpper(input.definition_type || input.type || "BUSINESS"));
  const definition = normalizeText(input.definition);
  if (!definition) throw invalidDefinition("A definition text is required");
  const existing = queryOne(db, "SELECT * FROM dc_term_definitions WHERE term_id = ? AND definition_type = ?", [term.id, definitionType]);
  const ts = nowIso();
  let id;
  if (existing) {
    run(db, "UPDATE dc_term_definitions SET definition = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      definition,
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
    id = existing.id;
  } else {
    const result = run(
      db,
      "INSERT INTO dc_term_definitions (tenant_id, term_id, definition_type, definition, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [term.tenant_id, term.id, definitionType, definition, actor?.id ?? null, actor?.id ?? null, ts, ts]
    );
    id = Number(result.lastInsertRowid);
  }
  if (definitionType === "BUSINESS") {
    run(db, "UPDATE dc_business_terms SET definition = ?, updated_at = ? WHERE id = ?", [definition, ts, term.id]);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.term.definition",
    resourceType: "dc_term_definition",
    resourceId: id,
    details: { term_id: term.id, definition_type: definitionType },
    ip,
  });
  return publicTermDefinition(queryOne(db, "SELECT * FROM dc_term_definitions WHERE id = ?", [id]));
}

export function deleteDefinition(db, termRefValue, definitionType, actor = null, tenantId = null, ip = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const type = assertDefinitionType(normalizeUpper(definitionType));
  const row = queryOne(db, "SELECT * FROM dc_term_definitions WHERE term_id = ? AND definition_type = ?", [term.id, type]);
  if (!row) throw definitionNotFound(`${term.code}.${type}`);
  run(db, "DELETE FROM dc_term_definitions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "data_catalog.term.definition.remove", resourceType: "dc_term_definition", resourceId: row.id, details: { term_id: term.id, type }, ip });
  return { deleted: true, id: row.id };
}

export function addSynonym(db, termRefValue, input = {}, actor = null, tenantId = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const synonym = normalizeText(typeof input === "string" ? input : input.synonym);
  if (!synonym) throw invalidTerm("A synonym text is required");
  const synonymType = assertSynonymType(normalizeUpper(typeof input === "string" ? "SYNONYM" : input.synonym_type || "SYNONYM"));
  const existing = queryOne(db, "SELECT * FROM dc_term_synonyms WHERE term_id = ? AND synonym = ?", [term.id, synonym]);
  if (existing) {
    run(db, "UPDATE dc_term_synonyms SET synonym_type = ?, status = 'active' WHERE id = ?", [synonymType, existing.id]);
    return publicTermSynonym(queryOne(db, "SELECT * FROM dc_term_synonyms WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    "INSERT INTO dc_term_synonyms (tenant_id, term_id, synonym, synonym_type, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    [term.tenant_id, term.id, synonym, synonymType, nowIso()]
  );
  return publicTermSynonym(queryOne(db, "SELECT * FROM dc_term_synonyms WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function removeSynonym(db, termRefValue, synonym, actor = null, tenantId = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const row = queryOne(db, "SELECT * FROM dc_term_synonyms WHERE term_id = ? AND synonym = ?", [term.id, normalizeText(synonym)]);
  if (!row) throw termNotFound(`${term.code}:${synonym}`);
  run(db, "UPDATE dc_term_synonyms SET status = 'inactive' WHERE id = ?", [row.id]);
  return publicTermSynonym(queryOne(db, "SELECT * FROM dc_term_synonyms WHERE id = ?", [row.id]));
}

export function addRelation(db, termRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const related = requireTerm(db, input.related_term_id ?? input.related_term ?? input.related_term_ref, tenantId);
  if (Number(related.id) === Number(term.id)) throw invalidTerm("A term cannot relate to itself");
  const relationshipType = assertTermRelationship(normalizeUpper(input.relationship_type || "RELATED_TO"));
  const existing = queryOne(db, "SELECT * FROM dc_term_relations WHERE term_id = ? AND related_term_id = ? AND relationship_type = ?", [
    term.id,
    related.id,
    relationshipType,
  ]);
  if (existing) {
    run(db, "UPDATE dc_term_relations SET status = 'active' WHERE id = ?", [existing.id]);
    return publicTermRelation(queryOne(db, "SELECT * FROM dc_term_relations WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    "INSERT INTO dc_term_relations (tenant_id, term_id, related_term_id, relationship_type, status, created_by, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    [term.tenant_id, term.id, related.id, relationshipType, actor?.id ?? null, nowIso()]
  );
  publishCatalogEvent(db, {
    eventType: "BusinessTermUpdated",
    tenantId: term.tenant_id,
    objectType: "business_term",
    objectId: term.id,
    payload: { id: term.id, relation: relationshipType, related_term_id: related.id },
  }, actor);
  return publicTermRelation(queryOne(db, "SELECT * FROM dc_term_relations WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function removeRelation(db, relationId, actor = null, tenantId = null) {
  const row = tenantId
    ? queryOne(db, "SELECT * FROM dc_term_relations WHERE id = ? AND tenant_id = ?", [Number(relationId), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_term_relations WHERE id = ?", [Number(relationId)]);
  if (!row) throw termNotFound(relationId);
  run(db, "UPDATE dc_term_relations SET status = 'inactive' WHERE id = ?", [row.id]);
  return publicTermRelation(queryOne(db, "SELECT * FROM dc_term_relations WHERE id = ?", [row.id]));
}

export function addMapping(db, termRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const term = typeof termRefValue === "object" ? termRefValue : requireTerm(db, termRefValue, tenantId);
  const targetType = assertTermTargetType(normalizeUpper(input.target_type || "OBJECT"));
  const targetEntry = resolveMappingTarget(db, term.tenant_id, targetType, input.target_id ?? input.target_ref);
  if (!targetEntry) throw invalidMapping(`Unknown ${targetType} mapping target`, { target_type: targetType, target_id: input.target_id ?? null });
  const existing = queryOne(db, "SELECT * FROM dc_term_mappings WHERE term_id = ? AND target_type = ? AND target_id = ?", [
    term.id,
    targetType,
    targetEntry.id,
  ]);
  if (existing) return publicTermMapping(existing);
  const result = run(
    db,
    "INSERT INTO dc_term_mappings (tenant_id, term_id, target_type, target_id, target_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [term.tenant_id, term.id, targetType, targetEntry.id, targetEntry.entry_ref, actor?.id ?? null, nowIso()]
  );
  writeAudit(db, {
    actor,
    action: "data_catalog.term.map",
    resourceType: "dc_term_mapping",
    resourceId: Number(result.lastInsertRowid),
    details: { term_id: term.id, target_type: targetType, target_id: targetEntry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "BusinessTermUpdated",
    tenantId: term.tenant_id,
    objectType: "business_term",
    objectId: term.id,
    payload: { id: term.id, mapped_target_type: targetType, mapped_target_id: targetEntry.id },
  }, actor);
  return publicTermMapping(queryOne(db, "SELECT * FROM dc_term_mappings WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function removeMapping(db, mappingId, actor = null, tenantId = null) {
  const row = tenantId
    ? queryOne(db, "SELECT * FROM dc_term_mappings WHERE id = ? AND tenant_id = ?", [Number(mappingId), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_term_mappings WHERE id = ?", [Number(mappingId)]);
  if (!row) throw mappingNotFound(mappingId);
  run(db, "DELETE FROM dc_term_mappings WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}

function resolveMappingTarget(db, tenantId, targetType, target) {
  if (target === null || target === undefined || target === "") return null;
  const numeric = Number(target);
  let entry = null;
  if (Number.isInteger(numeric) && String(numeric) === String(target).trim()) {
    entry = getEntryRow(db, numeric, { tenantId, entryType: targetType });
  }
  if (!entry) entry = getEntryRow(db, target, { tenantId, entryType: targetType });
  return entry;
}

// Reverse lookup: which terms are mapped to a given asset.
export function termsForTarget(db, tenantId, targetType, targetId) {
  const rows = queryAll(
    db,
    `SELECT t.* FROM dc_term_mappings m JOIN dc_business_terms t ON t.id = m.term_id
      WHERE m.tenant_id = ? AND m.target_type = ? AND m.target_id = ? ORDER BY t.code`,
    [Number(tenantId), assertTermTargetType(normalizeUpper(targetType)), Number(targetId)]
  );
  return rows.map((row) => publicBusinessTerm(row));
}

// Glossary export shape used by import/export jobs and the UI.
export function glossarySnapshot(db, tenantId) {
  const terms = queryAll(db, "SELECT * FROM dc_business_terms WHERE tenant_id = ? ORDER BY code", [Number(tenantId)]);
  return terms.map((term) =>
    publicBusinessTerm(term, {
      definitions: listTermDefinitions(db, term.id),
      synonyms: listTermSynonyms(db, term.id),
      relations: listTermRelations(db, term.id),
      mappings: listTermMappings(db, term.id),
    })
  );
}
