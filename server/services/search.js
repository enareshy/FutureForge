// Search & Discovery Framework (public facade).
//
// A shared platform service that centralises search across business objects,
// documents, attributes, relationships and enterprise records. Business
// modules register searchable object types and emit change notifications; this
// module owns indexing, query execution, facets, suggestions, saved searches,
// history, permission-aware filtering and export.
//
// The framework is deliberately provider-based: the default relational provider
// compiles queries to SQLite, and an alternative engine can be registered
// without changing callers.

export * as SearchRegistryService from "./search/registry.js";
export * as SearchIndexingService from "./search/indexing.js";
export * as SearchQueryService from "./search/query.js";
export * as SearchSavedService from "./search/saved.js";
export * as SearchHistoryService from "./search/history.js";
export * as SearchSuggestionService from "./search/suggestions.js";
export * as SearchExportService from "./search/exports.js";
export * as SearchConfigurationService from "./search/config.js";
export * as SearchProviderService from "./search/provider.js";
export * as SearchMetricsService from "./search/metrics.js";
// Enterprise Search Foundation (canonical, provider-independent layer).
export * as SearchCanonical from "./search/canonical.js";
export * as SearchParser from "./search/parser.js";
export * as SearchFields from "./search/fields.js";
export * as SearchErrors from "./search/errors.js";
export * as SearchExtensions from "./search/extensions.js";
export * as SearchExtractedText from "./search/extracted-text.js";
export * as SearchV1 from "./search/v1.js";
export {
  searchObjects,
  countObjects,
  bulkSearch,
  parseQuery,
  listSearchObjects,
  getSearchObject,
  listFields,
  createField,
  removeField,
  getObjectFacets,
  getObjectSuggestions,
  listSaved,
  getSaved,
  createSaved,
  updateSaved,
  removeSaved,
  runSaved,
  getHistory,
  removeHistoryEntry,
  clearHistory,
  indexDocuments,
  rebuildIndex,
  getIndexStatus,
  retryFailedIndexing,
  putObjectExtractedText,
  getObjectExtractedText,
  removeObjectExtractedText,
  getMetrics,
  getHealth,
  getMeta,
} from "./search/v1.js";
export {
  SEARCH_ERROR_CODES,
  SearchError,
} from "./search/errors.js";
export {
  SEARCH_OPERATORS,
  SEARCH_EXTENDED_OPERATORS,
  SEARCH_DATA_TYPES,
  normalizeCanonicalQuery,
  toInternalQuery,
  toCanonicalResult,
} from "./search/canonical.js";
export {
  parseSearchText,
  parseSearchQuery,
} from "./search/parser.js";
export {
  listFieldDefinitions,
  upsertFieldDefinition,
  deleteFieldDefinition,
  canonicalFieldCatalog,
  validateCanonicalQuery,
} from "./search/fields.js";
export {
  registerRankingStrategy,
  getRankingStrategy,
  listRankingStrategies,
  registerSemanticSearchProvider,
  getSemanticSearchProvider,
  listSemanticSearchProviders,
  registerEffectivityResolver,
  getEffectivityResolver,
  listEffectivityResolvers,
  applyEffectivity,
} from "./search/extensions.js";
export {
  putExtractedText,
  listExtractedText,
  extractedTextFor,
  deleteExtractedText,
} from "./search/extracted-text.js";
export { reindexOrganization } from "./search/indexing.js";

export {
  vocabulary,
  SEARCH_SCOPES,
  SEARCH_STRATEGIES,
  SEARCH_SORTS,
  FILTER_OPERATORS,
  CONDITION_OPERATORS,
  FACET_FIELDS,
  FILTERABLE_COLUMNS,
} from "./search/validation.js";

export {
  publicObjectType,
  publicIndexedDocument,
  publicSavedSearch,
  publicHistoryEntry,
  publicExport,
  publicIndexStatus,
  publicConfiguration,
} from "./search/repository.js";

export {
  listObjectTypes,
  getObjectType,
  registerObjectType,
  updateObjectType,
  setObjectTypeStatus,
  deleteObjectType,
  initializeSearch,
  ensureDefaultRegistrations,
  searchableObjectTypes,
  searchableObjectTypeCodes,
  refreshState,
} from "./search/registry.js";

export {
  buildDocument,
  upsertIndexRow,
  deleteIndexRow,
  applyIndexChange,
  indexObject,
  removeFromIndex,
  drainIndexQueue,
  indexingStatus,
  listIndexFailures,
  retryIndexFailures,
  reindexObject,
  reindexType,
  reindexTenant,
  pruneIndex,
  registerBuiltinSources,
  listSourceResolvers,
  registerSourceResolver,
  getSourceResolver,
} from "./search/indexing.js";

export {
  search,
  advancedSearch,
  fullTextSearch,
  searchByType,
  searchByAttributes,
  searchByRelationship,
  getFacets,
  normalizeSearchQuery,
  scoreDocument,
  highlightText,
} from "./search/query.js";

export {
  listSavedSearches,
  getSavedSearch,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
  runSavedSearch,
} from "./search/saved.js";

export {
  recordSearchHistory,
  listSearchHistory,
  deleteSearchHistoryEntry,
  clearSearchHistory,
  pruneSearchHistory,
} from "./search/history.js";

export { getSuggestions } from "./search/suggestions.js";

export {
  requestExport,
  runExport,
  listExports,
  getExport,
  expireExports,
  toCsv,
} from "./search/exports.js";

export {
  ensureConfiguration,
  getConfiguration,
  updateConfiguration,
} from "./search/config.js";

export {
  registerSearchProvider,
  getSearchProvider,
  listSearchProviders,
  DEFAULT_PROVIDER,
} from "./search/provider.js";

export { searchMetrics, searchHealth } from "./search/metrics.js";

export { registerSearchHandlers, runSearchMaintenance } from "./search/jobs.js";

export {
  emitObjectIndexChange,
  emitObjectChanged,
  emitFileChanged,
} from "./search/hooks.js";
