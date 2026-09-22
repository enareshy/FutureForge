// Lookup resolution for mappings, transformations and validation rules.
//
// A lookup source is a named resolver (reference-data set, object query, or a
// static value map) registered by an integration. The engine caches results per
// run to keep large imports fast, and never queries inside a tight loop.
import { invalidLookup } from "../errors.js";
import { normalizeUpper } from "../validation.js";

const sources = new Map();

export function registerLookupSource(code, resolver, { description = "" } = {}) {
  if (!code || typeof resolver !== "function") throw invalidLookup("A lookup source requires a code and a resolver");
  sources.set(normalizeUpper(code), { code: normalizeUpper(code), description, resolver });
  return code;
}

export function unregisterLookupSource(code) {
  return sources.delete(normalizeUpper(code));
}

export function listLookupSources() {
  return [...sources.values()].map(({ code, description }) => ({ code, description }));
}

export function hasLookupSource(code) {
  return sources.has(normalizeUpper(code));
}

// Builds a per-run resolver with an internal cache. `lookup_definition` or
// `source` names the registered source; `map` short-circuits to a static map.
export function createLookupResolver({ staticMaps = {}, cacheSize = 5000 } = {}) {
  const cache = new Map();
  return function resolver(value, config = {}) {
    if (config.map && typeof config.map === "object") {
      const key = String(value);
      return Object.prototype.hasOwnProperty.call(config.map, key) ? config.map[key] : config.default ?? value;
    }
    const sourceCode = normalizeUpper(config.lookup_definition || config.lookupDefinition || config.source || "");
    const map = staticMaps[sourceCode];
    if (map && typeof map === "object") {
      const key = String(value);
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : config.default ?? value;
    }
    const source = sources.get(sourceCode);
    if (!source) {
      if (config.default !== undefined) return config.default;
      throw invalidLookup(`Lookup source "${sourceCode}" is not registered`, { source: sourceCode });
    }
    const cacheKey = `${sourceCode}:${value}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const resolved = source.resolver(value, config);
    const effective = resolved ?? config.default ?? value;
    if (cache.size >= cacheSize) cache.clear();
    cache.set(cacheKey, effective);
    return effective;
  };
}

// Convenience wrapper for a single resolution.
export function resolveLookup(value, config = {}) {
  return createLookupResolver()(value, config);
}

export function requiresLookupSource(config = {}) {
  return !(config.map && typeof config.map === "object");
}
