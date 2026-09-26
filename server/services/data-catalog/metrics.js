// Operational metrics for the catalog and glossary estate. Every figure is
// tenant scoped so dashboards and searches can never leak across tenants.
import { queryAll, queryOne } from "../../db.js";
import { entryTypeCounts } from "./entries.js";
import { ownershipGaps } from "./ownership.js";

function count(db, table, tenantId, extraWhere = "", params = []) {
  const where = [`tenant_id = ?`, ...(extraWhere ? [extraWhere] : [])].join(" AND ");
  return Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, [Number(tenantId), ...params])?.c || 0);
}

export function metricsSnapshot(db, { tenantId } = {}) {
  const counters = {
    entries: count(db, "dc_entries", tenantId),
    entries_active: count(db, "dc_entries", tenantId, "status = 'active'"),
    domains: count(db, "dg_domains", tenantId),
    objects: count(db, "dc_catalog_objects", tenantId),
    attributes: count(db, "dc_catalog_attributes", tenantId),
    terms: count(db, "dc_business_terms", tenantId),
    terms_approved: count(db, "dc_business_terms", tenantId, "approval_status = 'approved'"),
    terms_in_review: count(db, "dc_business_terms", tenantId, "status = 'in_review'"),
    definitions: count(db, "dc_term_definitions", tenantId),
    synonyms: count(db, "dc_term_synonyms", tenantId, "status = 'active'"),
    term_relations: count(db, "dc_term_relations", tenantId, "status = 'active'"),
    term_mappings: count(db, "dc_term_mappings", tenantId),
    sources: count(db, "dc_sources", tenantId),
    source_mappings: count(db, "dc_source_mappings", tenantId),
    consumers: count(db, "dc_consumers", tenantId),
    consumer_mappings: count(db, "dc_consumer_mappings", tenantId, "status = 'active'"),
    lineage: count(db, "dc_lineage", tenantId, "status = 'active'"),
    classifications: count(db, "dc_classifications", tenantId),
    classification_assignments: count(db, "dc_classification_assignments", tenantId),
    ownership: count(db, "dc_ownership", tenantId, "relationship = 'owner' AND status = 'active'"),
    stewardship: count(db, "dc_ownership", tenantId, "relationship = 'steward' AND status = 'active'"),
    relationships: count(db, "dc_relationships", tenantId, "status = 'active'"),
    imports: count(db, "dc_import_runs", tenantId),
  };

  const termsWithoutDefinition = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM dc_business_terms t
        WHERE t.tenant_id = ? AND COALESCE(t.definition, '') = ''
          AND NOT EXISTS (SELECT 1 FROM dc_term_definitions d WHERE d.term_id = t.id)`,
      [Number(tenantId)]
    )?.c || 0
  );
  const staleTerms = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM dc_business_terms WHERE tenant_id = ? AND status = 'deprecated'`,
      [Number(tenantId)]
    )?.c || 0
  );

  return {
    counters,
    by_type: entryTypeCounts(db, tenantId),
    classification: classificationBreakdown(db, tenantId),
    governance: {
      terms_without_definition: termsWithoutDefinition,
      deprecated_terms: staleTerms,
      entries_without_owner: ownershipGaps(db, tenantId, { limit: 500 }).length,
    },
    generated_at: new Date().toISOString(),
  };
}

function classificationBreakdown(db, tenantId) {
  return queryAll(
    db,
    "SELECT classification, COUNT(*) AS c FROM dc_entries WHERE tenant_id = ? AND status <> 'retired' GROUP BY classification ORDER BY c DESC",
    [Number(tenantId)]
  ).map((row) => ({ classification: row.classification, count: Number(row.c) }));
}

export function healthCheck(db, { tenantId } = {}) {
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, status: ok ? "ok" : "degraded", detail });
  try {
    const terms = count(db, "dc_business_terms", tenantId);
    const definitions = count(db, "dc_term_definitions", tenantId);
    add("glossary", terms === 0 || definitions > 0, { terms, definitions });
    const objects = count(db, "dc_catalog_objects", tenantId);
    const orphanEntries = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM dc_entries e WHERE e.tenant_id = ?
           AND e.subject_id IS NOT NULL AND NOT (
             (e.entry_type = 'OBJECT' AND EXISTS (SELECT 1 FROM dc_catalog_objects o WHERE o.id = e.subject_id)) OR
             (e.entry_type = 'ATTRIBUTE' AND EXISTS (SELECT 1 FROM dc_catalog_attributes a WHERE a.id = e.subject_id)) OR
             (e.entry_type = 'BUSINESS_TERM' AND EXISTS (SELECT 1 FROM dc_business_terms t WHERE t.id = e.subject_id)) OR
             (e.entry_type = 'SOURCE' AND EXISTS (SELECT 1 FROM dc_sources s WHERE s.id = e.subject_id)) OR
             (e.entry_type = 'CONSUMER' AND EXISTS (SELECT 1 FROM dc_consumers c WHERE c.id = e.subject_id))
           )`,
        [Number(tenantId)]
      )?.c || 0
    );
    add("catalog", orphanEntries === 0, { objects, orphan_entries: orphanEntries });
    const sources = count(db, "dc_sources", tenantId);
    const credentialsLeak = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM dc_sources WHERE tenant_id = ? AND (
           LOWER(connection_reference) LIKE '%://%' OR LOWER(connection_reference) LIKE '%password=%'
         )`,
        [Number(tenantId)]
      )?.c || 0
    );
    add("sources", credentialsLeak === 0, { sources, connection_strings: credentialsLeak });
    return { status: checks.every((check) => check.status === "ok") ? "healthy" : "degraded", checks };
  } catch (error) {
    checks.push({ name: "database", status: "unhealthy", detail: error.message });
    return { status: "unhealthy", checks };
  }
}
