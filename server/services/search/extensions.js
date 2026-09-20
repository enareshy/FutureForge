// Search extension points (spec §37/§38/§61/§63).
//
// Provider-independent seams for capabilities that arrive after P0:
//   * ranking strategies  — how keyword results are ordered
//   * semantic providers  — future embedding / AI retrieval, fused with keyword
//   * effectivity          — applicability filtering through the shared kernel
//
// Nothing here fabricates embeddings or implements a second effectivity
// engine. The contracts are stable, so business modules never depend on a
// concrete engine.
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";

const rankingStrategies = new Map();
const semanticProviders = new Map();
const effectivityResolvers = new Map();

function assertName(name, label) {
  const key = String(name || "").trim();
  if (!key) throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `A ${label} name is required`);
  return key;
}

// ── Ranking ─────────────────────────────────────────────────────────────────
// A strategy receives (row, terms, context) and returns a numeric score. Higher
// scores rank first. Context exposes the object definition when available.
export function registerRankingStrategy(name, strategy, { replace = false } = {}) {
  const key = assertName(name, "ranking strategy");
  if (typeof strategy !== "function") {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "A ranking strategy must be a function");
  }
  if (rankingStrategies.has(key) && !replace) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `Ranking strategy "${key}" is already registered`);
  }
  rankingStrategies.set(key, strategy);
  return key;
}

export function getRankingStrategy(name) {
  return rankingStrategies.get(String(name)) || null;
}

export function listRankingStrategies() {
  return [...rankingStrategies.keys()];
}

export function rankRows(rows, terms, context = {}) {
  const strategy = getRankingStrategy(context.strategy || "text");
  if (!strategy) return rows;
  return [...rows]
    .map((row) => ({ row, score: Number(strategy(row, terms, context)) || 0 }))
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return String(b.row.updated_at || "").localeCompare(String(a.row.updated_at || ""));
    })
    .map((entry) => entry.row);
}

// ── Semantic / AI search ────────────────────────────────────────────────────
// The contract mirrors the spec's SemanticSearchProvider. Implementations are
// fused with keyword search by a future ranking phase; P0 only registers them.
export const SEMANTIC_PROVIDER_METHODS = ["search"];

export function assertSemanticSearchProvider(name, provider) {
  for (const method of SEMANTIC_PROVIDER_METHODS) {
    if (!provider || typeof provider[method] !== "function") {
      throw new SearchError(
        SEARCH_ERROR_CODES.INVALID_QUERY,
        `Semantic search provider "${name}" must implement ${method}(query)`
      );
    }
  }
  return provider;
}

export function registerSemanticSearchProvider(name, provider, { replace = false } = {}) {
  const key = assertName(name, "semantic provider");
  assertSemanticSearchProvider(key, provider);
  if (semanticProviders.has(key) && !replace) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `Semantic provider "${key}" is already registered`);
  }
  semanticProviders.set(key, provider);
  return key;
}

export function getSemanticSearchProvider(name) {
  return semanticProviders.get(String(name)) || null;
}

export function listSemanticSearchProviders() {
  return [...semanticProviders.keys()];
}

// ── Effectivity ─────────────────────────────────────────────────────────────
// A resolver receives (db, { tenantId, effectivity, rows, objectTypes, actor })
// and returns the applicable subset of rows. The shared Effectivity &
// Versioning Kernel should back a registered resolver; the default below is a
// conservative attribute-level applicability check that never hides documents
// which carry no effectivity attributes.
export function registerEffectivityResolver(name, resolver, { replace = false } = {}) {
  const key = assertName(name, "effectivity resolver");
  if (typeof resolver !== "function") {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "An effectivity resolver must be a function");
  }
  if (effectivityResolvers.has(key) && !replace) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `Effectivity resolver "${key}" is already registered`);
  }
  effectivityResolvers.set(key, resolver);
  return key;
}

export function getEffectivityResolver(name) {
  return effectivityResolvers.get(String(name)) || null;
}

export function listEffectivityResolvers() {
  return [...effectivityResolvers.keys()];
}

export const EFFECTIVITY_CONTEXT_FIELDS = [
  "asOfDate",
  "serialNumber",
  "plant",
  "unit",
  "model",
  "variant",
  "configuration",
  "revision",
];

function asOfTimestamp(effectivity) {
  const raw = effectivity?.asOfDate ?? effectivity?.as_of_date ?? effectivity?.asOf;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function withinWindow(attributes, asOf) {
  const from = attributes.effective_from ?? attributes.effectiveFrom;
  const to = attributes.effective_to ?? attributes.effectiveTo;
  const fromTs = from ? Date.parse(from) : null;
  const toTs = to ? Date.parse(to) : null;
  if (fromTs !== null && Number.isFinite(fromTs) && asOf < fromTs) return false;
  if (toTs !== null && Number.isFinite(toTs) && asOf > toTs) return false;
  return true;
}

function rowAttributes(row) {
  if (row.attributes && typeof row.attributes === "object") return row.attributes;
  const raw = row.attributes_json;
  if (!raw) return {};
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function defaultEffectivityResolver(db, { effectivity, rows }) {
  const asOf = asOfTimestamp(effectivity);
  const scoped = EFFECTIVITY_CONTEXT_FIELDS.filter(
    (field) => field !== "asOfDate" && effectivity[field] !== undefined
  );
  return rows.filter((row) => {
    const attributes = rowAttributes(row);
    const hasEffectivityAttributes =
      attributes.effective_from !== undefined ||
      attributes.effective_to !== undefined ||
      attributes.effectiveFrom !== undefined ||
      attributes.effectiveTo !== undefined;
    if (!hasEffectivityAttributes) return true;
    if (asOf === null) return true;
    if (!withinWindow(attributes, asOf)) return false;
    for (const field of scoped) {
      const expected = effectivity[field];
      const actual = attributes[field];
      if (actual === undefined || actual === null) continue;
      if (Array.isArray(actual)) {
        if (!actual.map(String).includes(String(expected))) return false;
      } else if (String(actual) !== String(expected)) {
        return false;
      }
    }
    return true;
  });
}

registerEffectivityResolver("default", defaultEffectivityResolver);

export function applyEffectivity(db, { tenantId, effectivity, rows, objectTypes = null, actor = null } = {}) {
  if (!effectivity || !rows?.length) return rows;
  const named = effectivity.resolver || effectivity.resolverName;
  const resolver = (named && getEffectivityResolver(named)) || getEffectivityResolver("default");
  if (!resolver) return rows;
  const filtered = resolver(db, { tenantId, effectivity, rows, objectTypes, actor });
  return Array.isArray(filtered) ? filtered : rows;
}
