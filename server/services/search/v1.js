// Versioned Search API service (spec §48).
//
// The canonical, provider-independent public surface for the Enterprise Search
// Foundation. Controllers stay thin; every rule (validation, security
// filtering, indexing, facets, ranking, effectivity) lives in the modules
// below, so swapping the relational provider for OpenSearch/Elasticsearch/Solr
// never changes this contract.
import { run } from "../../db.js";
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";
import {
  PAGE_LIMITS,
  SEARCH_DATA_TYPES,
  SEARCH_EXTENDED_OPERATORS,
  SEARCH_OPERATORS,
  normalizeCanonicalQuery,
  operatorsForType,
  toCanonicalResult,
  toInternalQuery,
} from "./canonical.js";
import { parseSearchQuery, parseSearchText } from "./parser.js";
import {
  canonicalFieldCatalog,
  deleteFieldDefinition,
  internalFieldFor,
  listFieldDefinitions,
  upsertFieldDefinition,
  validateCanonicalQuery,
} from "./fields.js";
import {
  getObjectType,
  listObjectTypes,
  searchableObjectTypeCodes,
} from "./registry.js";
import { runSearch } from "./query.js";
import {
  applyIndexChange,
  indexingStatus,
  listIndexFailures,
  reindexObject,
  reindexOrganization,
  reindexTenant,
  reindexType,
  retryIndexFailures,
} from "./indexing.js";
import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  updateSavedSearch,
} from "./saved.js";
import { getSuggestions } from "./suggestions.js";
import {
  clearSearchHistory,
  deleteSearchHistoryEntry,
  listSearchHistory,
} from "./history.js";
import { searchHealth, searchMetrics } from "./metrics.js";
import {
  deleteExtractedText,
  listExtractedText,
  putExtractedText,
} from "./extracted-text.js";
import {
  EFFECTIVITY_CONTEXT_FIELDS,
  listEffectivityResolvers,
  listRankingStrategies,
  listSemanticSearchProviders,
} from "./extensions.js";

const MAX_BULK_QUERIES = 10;

function tenantOf(actor, options) {
  return Number(options?.tenantId ?? actor?.tenant_id ?? 0);
}

// Canonical (provider-independent) -> internal engine query. Field names are
// mapped to their physical index column (or attribute json path) here; no other
// module knows about either representation.
function remapFilters(filters) {
  return (filters || []).map((filter) => ({ ...filter, field: internalFieldFor(filter.field) }));
}

function remapCondition(node) {
  if (!node) return null;
  return {
    operator: node.operator,
    filters: remapFilters(node.filters),
    conditions: (node.conditions || []).map(remapCondition).filter(Boolean),
  };
}

export function canonicalToInternal(canonical) {
  const internal = toInternalQuery(canonical);
  internal.filters = remapFilters(internal.filters);
  internal.condition = remapCondition(internal.condition);
  internal.sorts = (internal.sorts || []).map((entry) => ({
    ...entry,
    field: internalFieldFor(entry.field),
  }));
  return internal;
}

// Parses free text (field:value, wildcards, phrases, AND/OR/NOT) on top of a
// canonical query unless the caller opts out.
export function buildCanonicalQuery(input, { parseText = true } = {}) {
  const canonical = normalizeCanonicalQuery(input);
  if (parseText && canonical.text) return parseSearchText(canonical.text, canonical);
  return canonical;
}

export function executeCanonical(db, canonical, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const availableTypes = searchableObjectTypeCodes(db, tenantId);
  validateCanonicalQuery(db, canonical, { tenantId, availableTypes });
  const internal = canonicalToInternal(canonical);
  const result = runSearch(db, internal, actor, { ...options, tenantId });
  return toCanonicalResult(result, canonical, { facets: result.facets });
}

// ── Query ───────────────────────────────────────────────────────────────────
export function searchObjects(db, input, actor, options = {}) {
  const canonical = buildCanonicalQuery(input, { parseText: options.parseText !== false });
  return executeCanonical(db, canonical, actor, options);
}

export function countObjects(db, input, actor, options = {}) {
  const canonical = buildCanonicalQuery(input, { parseText: options.parseText !== false });
  canonical.pageSize = 1;
  canonical.page = 0;
  const tenantId = tenantOf(actor, options);
  const availableTypes = searchableObjectTypeCodes(db, tenantId);
  validateCanonicalQuery(db, canonical, { tenantId, availableTypes });
  const internal = canonicalToInternal(canonical);
  const result = runSearch(db, internal, actor, { ...options, tenantId, recordHistory: false });
  return {
    total: result.total || 0,
    objectTypes: result.object_types || canonical.objectTypes,
    tookMs: result.took_ms ?? 0,
    query: canonical.text,
    disabled: result.disabled === true,
  };
}

export function bulkSearch(db, input = {}, actor, options = {}) {
  const queries = Array.isArray(input.queries) ? input.queries : [];
  if (!queries.length) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "At least one query is required");
  }
  if (queries.length > MAX_BULK_QUERIES) {
    throw new SearchError(
      SEARCH_ERROR_CODES.QUERY_TOO_COMPLEX,
      `A bulk search may contain at most ${MAX_BULK_QUERIES} queries`
    );
  }
  return {
    results: queries.map((entry) => searchObjects(db, entry, actor, options)),
  };
}

export function parseQuery(input = {}) {
  const { query, parsed } = parseSearchQuery(input);
  return {
    query,
    parsed,
    operators: SEARCH_OPERATORS,
    extendedOperators: SEARCH_EXTENDED_OPERATORS,
  };
}

// ── Objects / fields ────────────────────────────────────────────────────────
export function listSearchObjects(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  return {
    objects: listObjectTypes(db, { tenantId, includeDisabled: options.includeDisabled === true }),
    pageLimits: PAGE_LIMITS,
    operators: SEARCH_OPERATORS,
  };
}

export function getSearchObject(db, code, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const objectType = getObjectType(db, code, tenantId);
  const catalog = canonicalFieldCatalog(db, tenantId, { objectTypes: [objectType.code] });
  const fields = [...(catalog.get(objectType.code)?.values() || [])].map((def) => ({
    field: def.field,
    displayName: def.displayName,
    dataType: def.dataType,
    searchable: def.searchable,
    filterable: def.filterable,
    sortable: def.sortable,
    facetable: def.facetable,
    fullText: def.fullText,
    exactMatch: def.exactMatch,
    wildcard: def.wildcard,
    allowedOperators: operatorsForType(def.dataType),
  }));
  return { objectType, fields };
}

export function listFields(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const objectType = options.objectType ?? options.object_type ?? null;
  return {
    fields: listFieldDefinitions(db, { tenantId, objectType }),
    dataTypes: SEARCH_DATA_TYPES,
    operators: SEARCH_OPERATORS,
  };
}

export function createField(db, input, actor, options = {}) {
  return upsertFieldDefinition(db, input, actor, tenantOf(actor, options), options.ip);
}

export function removeField(db, objectType, field, actor, options = {}) {
  return deleteFieldDefinition(db, tenantOf(actor, options), objectType, field, actor, options.ip);
}

// ── Facets / suggestions ────────────────────────────────────────────────────
export function getObjectFacets(db, input, actor, options = {}) {
  const merged = {
    ...input,
    facets: input.facets ?? input.facet_fields ?? ["object_type", "status", "classification"],
  };
  const result = searchObjects(db, merged, actor, options);
  return { facets: result.facets, total: result.total };
}

export function getObjectSuggestions(db, input, actor, options = {}) {
  const result = getSuggestions(db, input, actor, { tenantId: tenantOf(actor, options) });
  const suggestions = Array.isArray(result) ? result : result.suggestions || result.items || [];
  return {
    suggestions,
    ranking: listRankingStrategies(),
    semanticProviders: listSemanticSearchProviders(),
  };
}

// ── Saved searches ──────────────────────────────────────────────────────────
export function listSaved(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  return {
    savedSearches: listSavedSearches(db, {
      tenantId,
      actorId: actor?.id,
      includeShared: options.includeShared !== false,
    }),
  };
}

export function getSaved(db, reference, actor, options = {}) {
  return getSavedSearch(db, reference, actor, tenantOf(actor, options));
}

export function createSaved(db, input, actor, options = {}) {
  const query = input.query ?? input;
  const canonical = buildCanonicalQuery(query, { parseText: false });
  return createSavedSearch(db, { ...input, query: canonical }, actor, tenantOf(actor, options), options.ip);
}

export function updateSaved(db, reference, patch, actor, options = {}) {
  const next = { ...patch };
  if (patch.query !== undefined) {
    next.query = buildCanonicalQuery(patch.query, { parseText: false });
  }
  return updateSavedSearch(db, reference, next, actor, tenantOf(actor, options), options.ip);
}

export function removeSaved(db, reference, actor, options = {}) {
  return deleteSavedSearch(db, reference, actor, tenantOf(actor, options), options.ip);
}

export function runSaved(db, reference, input = {}, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const saved = getSavedSearch(db, reference, actor, tenantId);
  const merged = {
    ...(saved.query || {}),
    ...input,
    savedSearchId: saved.id,
  };
  const result = searchObjects(db, merged, actor, options);
  run(db, "UPDATE search_saved_searches SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?", [
    saved.id,
  ]);
  return { savedSearch: saved, ...result };
}

// ── History ─────────────────────────────────────────────────────────────────
export function getHistory(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  return {
    history: listSearchHistory(db, {
      tenantId,
      actorId: actor?.id,
      limit: Number(options.limit) || 20,
      q: options.q || "",
    }),
  };
}

export function removeHistoryEntry(db, id, actor, options = {}) {
  return deleteSearchHistoryEntry(db, id, actor, tenantOf(actor, options));
}

export function clearHistory(db, actor, options = {}) {
  return clearSearchHistory(db, actor, tenantOf(actor, options), { all: options.all === true });
}

// ── Indexing ────────────────────────────────────────────────────────────────
export function indexDocuments(db, input = {}, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const documents = Array.isArray(input.documents)
    ? input.documents
    : input.objectType || input.object_type
      ? [input]
      : [];
  if (!documents.length) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "At least one document is required");
  }
  const results = documents.map((entry) => {
    const objectType = entry.objectType ?? entry.object_type;
    const objectId = entry.objectId ?? entry.object_id;
    const operation = entry.operation === "delete" ? "delete" : "upsert";
    if (!objectType || objectId === undefined || objectId === null) {
      throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Each document needs objectType and objectId");
    }
    try {
      const doc = applyIndexChange(db, {
        tenantId: entry.tenantId ?? entry.tenant_id ?? tenantId,
        objectType,
        objectId,
        operation,
        reason: entry.reason || "api",
        actor,
        ip: options.ip,
        audit: true,
      });
      return { objectType, objectId: String(objectId), operation, status: "indexed", document: doc };
    } catch (err) {
      return { objectType, objectId: String(objectId), operation, status: "failed", error: err.message };
    }
  });
  return { results, indexed: results.filter((r) => r.status === "indexed").length, failed: results.filter((r) => r.status === "failed").length };
}

export function rebuildIndex(db, input = {}, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const scope = String(input.scope || input.mode || "").toLowerCase();
  const objectType = input.objectType ?? input.object_type ?? null;
  const organizationId = input.organizationId ?? input.organization_id ?? null;
  if (scope === "object" || (objectType && (input.objectId ?? input.object_id))) {
    const objectId = input.objectId ?? input.object_id;
    return {
      scope: "object",
      result: reindexObject(db, { tenantId, objectType, objectId }, actor, options.ip),
    };
  }
  if (scope === "type" || scope === "object_type" || objectType) {
    return {
      scope: "object_type",
      result: reindexType(db, { tenantId, objectType, limit: input.limit }, actor, options.ip),
    };
  }
  if (scope === "organization" || organizationId) {
    return {
      scope: "organization",
      result: reindexOrganization(
        db,
        { tenantId, organizationId, limit: input.limit },
        actor,
        options.ip
      ),
    };
  }
  return {
    scope: "full",
    result: reindexTenant(db, { tenantId, limit: input.limit }, actor, options.ip),
  };
}

export function getIndexStatus(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  return {
    status: indexingStatus(db, { tenantId }),
    failures: listIndexFailures(db, { tenantId, limit: Number(options.limit) || 50 }),
  };
}

export function retryFailedIndexing(db, actor, options = {}) {
  return retryIndexFailures(
    db,
    { tenantId: tenantOf(actor, options), includeDeadLetter: options.includeDeadLetter === true },
    actor,
    options.ip
  );
}

// ── Extracted text (content integration contract, §35/§36) ──────────────────
export function putObjectExtractedText(db, input, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  const saved = putExtractedText(db, input, actor, tenantId, options.ip);
  const objectType = saved.objectType;
  const objectId = saved.objectId;
  let reindexed = null;
  try {
    reindexed = applyIndexChange(db, {
      tenantId,
      objectType,
      objectId,
      operation: "upsert",
      reason: "extracted_text",
    });
  } catch {
    reindexed = null;
  }
  return { extractedText: saved, reindexed: Boolean(reindexed) };
}

export function getObjectExtractedText(db, actor, options = {}) {
  return {
    items: listExtractedText(db, {
      tenantId: tenantOf(actor, options),
      objectType: options.objectType ?? options.object_type ?? null,
      objectId: options.objectId ?? options.object_id ?? null,
      limit: Number(options.limit) || 100,
    }),
  };
}

export function removeObjectExtractedText(db, input, actor, options = {}) {
  const saved = deleteExtractedText(
    db,
    {
      tenantId: tenantOf(actor, options),
      objectType: input.objectType ?? input.object_type,
      objectId: input.objectId ?? input.object_id,
      contentId: input.contentId ?? input.content_id ?? null,
    },
    actor,
    options.ip
  );
  try {
    applyIndexChange(db, {
      tenantId: tenantOf(actor, options),
      objectType: saved.object_type,
      objectId: saved.object_id,
      operation: "upsert",
      reason: "extracted_text_removed",
    });
  } catch {
    /* index catches up on the next maintenance pass */
  }
  return saved;
}

// ── Observability ───────────────────────────────────────────────────────────
export function getMetrics(db, actor, options = {}) {
  return searchMetrics(db, { tenantId: tenantOf(actor, options), sinceDays: options.sinceDays });
}

export function getHealth(db) {
  return searchHealth(db);
}

export function getMeta(db, actor, options = {}) {
  const tenantId = tenantOf(actor, options);
  return {
    operators: SEARCH_OPERATORS,
    extendedOperators: SEARCH_EXTENDED_OPERATORS,
    dataTypes: SEARCH_DATA_TYPES,
    effectivityContextFields: EFFECTIVITY_CONTEXT_FIELDS,
    rankingStrategies: listRankingStrategies(),
    semanticProviders: listSemanticSearchProviders(),
    effectivityResolvers: listEffectivityResolvers(),
    pageLimits: PAGE_LIMITS,
    objectTypes: searchableObjectTypeCodes(db, tenantId),
  };
}
