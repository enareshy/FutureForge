// Search & Discovery query service. Normalises request shapes, runs the
// configured provider, applies permission filtering, ranks and highlights
// results, and records search history / audit.
import { writeAudit } from "../audit.js";
import { isPlatformAdmin } from "../tenants.js";
import { descendantOrganizationIds } from "../orgs.js";
import { HttpError } from "../../validation.js";
import {
  publicIndexedDocument,
  safeParse,
} from "./repository.js";
import {
  getSearchProvider,
  DEFAULT_PROVIDER,
} from "./provider.js";
import { filterAuthorizedDocuments, createDecisionCache } from "./authorization.js";
import { buildSearchSecurityPredicate } from "../security/row-security.js";
import { maskDocumentsByType } from "../security/index.js";
import { buildSecurityContext } from "../security/context.js";
import { listFieldRules } from "../security/repository.js";
import {
  searchableObjectTypeCodes,
  searchableObjectTypes,
} from "./registry.js";
import { getConfiguration } from "./config.js";
import {
  clampPage,
  clampPageSize,
  normalizeObjectTypes,
  normalizeTags,
  normalizeText,
  assertScope,
  assertSort,
  assertStrategy,
  tokenize,
  validateQueryText,
  FILTERABLE_COLUMNS,
  ATTRIBUTE_PREFIX,
} from "./validation.js";
import { computeFacetsFromDocuments } from "./canonical.js";
import {
  applyEffectivity,
  rankRows,
  registerRankingStrategy,
} from "./extensions.js";
import { recordSearchHistory } from "./history.js";

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeSorts(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry) => entry && typeof entry === "object" && entry.field)
    .map((entry) => ({
      field: String(entry.field),
      direction: String(entry.direction || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    }));
}

export function normalizeSearchQuery(input = {}, context = {}) {
  const config = context.config || {};
  const scope = assertScope(firstDefined(input.scope, config.default_scope), "tenant");
  const strategy = assertStrategy(input.strategy, "standard");
  const sort = assertSort(firstDefined(input.sort, config.default_sort), "relevance");
  const filters = Array.isArray(input.filters)
    ? input.filters
    : input.filters && typeof input.filters === "object"
      ? Object.entries(input.filters).map(([field, value]) => ({ field, operator: "eq", value }))
      : [];
  return {
    text: validateQueryText(firstDefined(input.text, input.q, input.query) ?? "", {
      min: 0,
      max: Number(config.max_query_length) || 400,
    }),
    scope,
    strategy,
    object_types: normalizeObjectTypes(firstDefined(input.object_types, input.objectTypes, input.types)),
    statuses: normalizeObjectTypes(firstDefined(input.statuses, input.status)),
    lifecycle_states: normalizeObjectTypes(
      firstDefined(input.lifecycle_states, input.lifecycleStates, input.lifecycle_state)
    ),
    tags: normalizeTags(firstDefined(input.tags, input.tag)),
    owner_id: firstDefined(input.owner_id, input.ownerId),
    organization_id: firstDefined(input.organization_id, input.organizationId),
    date_from: firstDefined(input.date_from, input.dateFrom),
    date_to: firstDefined(input.date_to, input.dateTo),
    filters,
    condition: input.condition && typeof input.condition === "object" ? input.condition : null,
    relationship: input.relationship && typeof input.relationship === "object" ? input.relationship : null,
    related_to: input.related_to ?? input.relatedTo ?? null,
    sort,
    sorts: normalizeSorts(input.sorts ?? input.sort_entries),
    highlight_terms: normalizeObjectTypes(input.highlight_terms),
    effectivity: input.effectivity && typeof input.effectivity === "object" ? input.effectivity : null,
    page: clampPage(firstDefined(input.page, 1)),
    page_size: clampPageSize(firstDefined(input.page_size, input.pageSize), Number(config.page_size) || 20),
    highlight: input.highlight === undefined ? config.highlight !== false : Boolean(input.highlight),
    include_facets: Boolean(firstDefined(input.include_facets, input.includeFacets, input.facets_requested)),
    facet_fields: normalizeObjectTypes(firstDefined(input.facet_fields, input.facetFields)),
    saved_search_id: firstDefined(input.saved_search_id, input.savedSearchId),
  };
}

function recencyScore(updatedAt) {
  const ts = Date.parse(updatedAt || "");
  if (!Number.isFinite(ts)) return 0;
  const days = (Date.now() - ts) / 86400000;
  if (days <= 0) return 5;
  return Math.max(0, 5 - Math.log10(days + 1) * 2);
}

export function scoreDocument(row, terms) {
  if (!terms.length) return recencyScore(row.updated_at);
  const title = normalizeText(row.title);
  const subtitle = normalizeText(row.subtitle);
  const code = normalizeText(row.code);
  const summary = normalizeText(row.summary);
  const body = normalizeText(row.searchable_text);
  const tags = safeParse(row.tags_json, []).map((tag) => normalizeText(tag));
  let score = 0;
  for (const term of terms) {
    if (title === term) score += 60;
    else if (title.startsWith(term)) score += 40;
    else if (title.includes(term)) score += 25;
    if (code === term) score += 30;
    else if (code.startsWith(term)) score += 18;
    else if (code.includes(term)) score += 10;
    if (subtitle.includes(term)) score += 8;
    if (summary.includes(term)) score += 6;
    if (tags.some((tag) => tag.includes(term))) score += 12;
    if (body) {
      const occurrences = body.split(term).length - 1;
      score += Math.min(occurrences, 5) * 2;
    }
  }
  const weight = Number(row.score_weight) || 1;
  return score * weight + recencyScore(row.updated_at);
}

// Default ranking strategies. Alternative strategies can be registered without
// touching this module or any business module.
registerRankingStrategy("text", (row, terms) => scoreDocument(row, terms), { replace: true });
registerRankingStrategy("recency", (row) => recencyScore(row.updated_at), { replace: true });

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function highlightText(value, terms) {
  if (value === undefined || value === null || value === "") return value;
  let output = escapeHtml(value);
  for (const term of terms) {
    if (!term) continue;
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`(${escapedTerm})`, "gi"), "<mark>$1</mark>");
  }
  return output;
}

function applyHighlights(doc, terms) {
  if (!terms.length) return doc;
  return {
    ...doc,
    highlights: {
      title: highlightText(doc.title, terms),
      subtitle: highlightText(doc.subtitle, terms),
      summary: highlightText(doc.summary, terms),
    },
  };
}

function resolveScope(db, actor, scope, organizationId, platformAdmin) {
  if (scope === "global" && !(platformAdmin ?? isPlatformAdmin(db, actor?.id))) {
    return { scope: "tenant", organizationIds: [] };
  }
  if (scope === "organization") {
    const orgId = organizationId ?? actor?.organization_id ?? null;
    if (!orgId) return { scope: "tenant", organizationIds: [] };
    return { scope, organizationIds: descendantOrganizationIds(db, Number(orgId)) };
  }
  return { scope, organizationIds: [] };
}

export function runSearch(db, input, actor, options = {}) {
  const started = Date.now();
  const tenantId = Number(options.tenantId ?? actor?.tenant_id ?? 0);
  const config = getConfiguration(db, tenantId);
  const norm = normalizeSearchQuery(input, { config });
  if (options.strategy) norm.strategy = assertStrategy(options.strategy, norm.strategy);
  if (!config.enabled) {
    return {
      items: [],
      total: 0,
      page: norm.page,
      page_size: norm.page_size,
      pages: 0,
      took_ms: 0,
      strategy: norm.strategy,
      scope: norm.scope,
      query: norm.text,
      disabled: true,
    };
  }
  if (norm.text && norm.text.length < Number(config.min_query_length || 0)) {
    throw new HttpError(400, `Search query must be at least ${config.min_query_length} characters`);
  }

  const platformAdmin = isPlatformAdmin(db, actor?.id);
  const scopeInfo = resolveScope(db, actor, norm.scope, norm.organization_id, platformAdmin);
  norm.scope = scopeInfo.scope;

  const availableTypes = searchableObjectTypeCodes(db, tenantId);
  const allowedTypes = norm.object_types.length
    ? norm.object_types.filter((code) => availableTypes.includes(code))
    : availableTypes;

  const provider = getSearchProvider(options.provider || DEFAULT_PROVIDER);
  const terms = norm.highlight_terms.length ? norm.highlight_terms : tokenize(norm.text);
  const decisionCache = createDecisionCache();

  // Centralized row level security predicate. When an object type opts into
  // entitlement/policy enforcement (or has explicit rules) the predicate is
  // pushed to the data layer so unauthorized rows are never fetched.
  const securityContext = buildSecurityContext(db, actor, {
    tenantId,
    organizationId: norm.organization_id ?? actor?.organization_id,
    correlationId: options.correlationId,
    ip: options.ip,
  });
  const securityPredicate = allowedTypes.length
    ? buildSearchSecurityPredicate(db, securityContext, allowedTypes, options.action || "read")
    : { enforced: false, sql: null, params: [] };

  let rows = [];
  let providerTotal = 0;
  if (allowedTypes.length) {
    const result = provider.search(db, norm, {
      allowedTypes,
      tenantId,
      scope: norm.scope,
      organizationIds: scopeInfo.organizationIds,
      maxResults: Number(config.max_results) || 500,
      securityPredicate: securityPredicate.enforced ? securityPredicate : null,
    });
    rows = result.rows;
    providerTotal = result.total;
  }

  let authorized = rows;
  if (norm.scope !== "global" || !platformAdmin) {
    authorized = filterAuthorizedDocuments(db, actor, rows, {
      tenantId,
      action: options.action,
      cache: decisionCache,
      platformAdmin,
    });
  }

  // Effectivity-aware applicability is applied after authorisation so counts,
  // facets and highlights only ever reflect applicable + authorized objects.
  if (norm.effectivity) {
    authorized = applyEffectivity(db, {
      tenantId,
      effectivity: norm.effectivity,
      rows: authorized,
      objectTypes: allowedTypes,
      actor,
    });
  }

  if (norm.sort === "relevance" && !norm.sorts.length) {
    authorized = rankRows(authorized, terms, { strategy: config.ranking_strategy || "text" });
  }

  const maxResults = Number(config.max_results) || 500;
  const total = rows.length < maxResults ? authorized.length : Math.min(providerTotal, maxResults);
  const offset = (norm.page - 1) * norm.page_size;
  const pageRows = authorized.slice(offset, offset + norm.page_size);
  let items = pageRows.map((row) => {
    const doc = publicIndexedDocument(row);
    return norm.highlight ? applyHighlights(doc, terms) : doc;
  });

  // Field level security & masking run server-side on the DTOs so protected
  // fields never leave the platform, including through search results.
  items = maskDocumentsByType(db, actor, items, {
    action: options.action || "read",
    options: { tenantId, context: securityContext },
  });

  let facets = null;
  if (norm.include_facets) {
    const blockedFields = blockedFacetFields(db, tenantId, allowedTypes);
    facets = getFacetsForQuery(db, norm, authorized, {
      allowedTypes,
      tenantId,
      scope: norm.scope,
      organizationIds: scopeInfo.organizationIds,
      requested: norm.facet_fields,
      blockedFields,
    });
  }

  const took = Date.now() - started;
  if (options.recordHistory !== false && norm.text) {
    try {
      recordSearchHistory(db, {
        query: norm.text,
        strategy: norm.strategy,
        scope: norm.scope,
        filters: { filters: norm.filters, condition: norm.condition, object_types: norm.object_types },
        resultCount: total,
        durationMs: took,
        savedSearchId: norm.saved_search_id,
      }, actor, tenantId);
    } catch {
      /* history must never fail the search */
    }
  }

  return {
    items,
    total,
    page: norm.page,
    page_size: norm.page_size,
    pages: Math.max(1, Math.ceil(total / norm.page_size)),
    took_ms: took,
    strategy: norm.strategy,
    scope: norm.scope,
    query: norm.text,
    object_types: allowedTypes,
    sort: norm.sort,
    facets,
  };
}

function resolveFacetFields(db, tenantId, requested, blockedFields = new Set()) {
  const registrations = searchableObjectTypes(db, tenantId);
  const configured = new Set();
  for (const reg of registrations) {
    for (const field of reg.facet_attributes || []) configured.add(field);
    for (const field of reg.filter_attributes || []) configured.add(field);
  }
  const available = [
    "object_type",
    "status",
    "lifecycle_state",
    "classification",
    "tags",
    ...configured,
  ].filter((field) => !blockedFields.has(field));
  if (requested?.length) return requested.filter((field) => available.includes(field));
  return ["object_type", "status", "classification", "tags"].filter((field) => !blockedFields.has(field));
}

// Any field with a deny/hide rule must never appear in facets, because facet
// counts would otherwise disclose protected values.
function blockedFacetFields(db, tenantId, objectTypes) {
  const blocked = new Set();
  for (const objectType of objectTypes) {
    for (const rule of listFieldRules(db, tenantId, { object_type: objectType })) {
      if (rule.status === "active" && (rule.effect === "deny" || rule.effect === "hide")) {
        blocked.add(rule.field_name);
        blocked.add(String(rule.field_name).split(".").pop());
      }
    }
  }
  return blocked;
}

// Facets are computed from the already authorisation-filtered document set so
// that counts can never reveal objects the caller cannot read.
function getFacetsForQuery(db, norm, authorizedRows, context) {
  const fields = resolveFacetFields(db, context.tenantId, context.requested, context.blockedFields);
  return computeFacetsFromDocuments(authorizedRows, fields);
}

export function search(db, input, actor, options = {}) {
  return runSearch(db, input, actor, options);
}

export function advancedSearch(db, input, actor, options = {}) {
  return runSearch(db, input, actor, { ...options, strategy: "advanced" });
}

export function fullTextSearch(db, input, actor, options = {}) {
  return runSearch(db, { ...input, condition: null, filters: [], ...input }, actor, {
    ...options,
    strategy: "full_text",
  });
}

export function searchByType(db, objectType, input, actor, options = {}) {
  return runSearch(db, { ...input, object_types: [objectType] }, actor, { ...options, strategy: "type" });
}

export function searchByAttributes(db, attributes, input, actor, options = {}) {
  const filters = Object.entries(attributes || {}).map(([name, value]) => {
    const field =
      name.startsWith(ATTRIBUTE_PREFIX) || FILTERABLE_COLUMNS.includes(name)
        ? name
        : `${ATTRIBUTE_PREFIX}${name}`;
    return {
      field,
      operator: value === null ? "not_exists" : "eq",
      value,
    };
  });
  return runSearch(db, { ...input, filters: [...(input.filters || []), ...filters] }, actor, {
    ...options,
    strategy: "attribute",
  });
}

export function searchByRelationship(db, relatedTo, input, actor, options = {}) {
  return runSearch(db, { ...input, related_to: relatedTo }, actor, {
    ...options,
    strategy: "relationship",
  });
}

export function getFacets(db, input, actor, options = {}) {
  const tenantId = Number(options.tenantId ?? actor?.tenant_id ?? 0);
  const config = getConfiguration(db, tenantId);
  const norm = normalizeSearchQuery({ ...input, include_facets: true }, { config });
  const result = runSearch(db, { ...norm, include_facets: true }, actor, {
    ...options,
    recordHistory: false,
  });
  return { facets: result.facets || [] };
}

export function auditSearch(db, actor, details, ip) {
  writeAudit(db, {
    actor,
    action: "search.query",
    resourceType: "search",
    resourceId: details?.query || "query",
    details,
    ip,
  });
}
