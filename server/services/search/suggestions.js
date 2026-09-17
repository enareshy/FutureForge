// Autocomplete and suggestions. Combines recent user queries, indexed titles,
// tags and object type names so the UI can assist as the user types.
import { queryAll } from "../../db.js";
import { getSearchProvider, DEFAULT_PROVIDER } from "./provider.js";
import { getConfiguration } from "./config.js";
import { searchableObjectTypes, searchableObjectTypeCodes } from "./registry.js";
import { normalizeSearchQuery, highlightText } from "./query.js";
import { listSearchHistory } from "./history.js";
import { normalizeText } from "./validation.js";

function collectTags(db, where, params, term, limit) {
  const rows = queryAll(
    db,
    `SELECT tags_json FROM search_index i WHERE ${where} ${term ? "AND lower(i.tags_json) LIKE ?" : ""} LIMIT 2000`,
    term ? [...params, `%${term}%`] : params
  );
  const counts = new Map();
  for (const row of rows) {
    let tags = [];
    try {
      tags = JSON.parse(row.tags_json || "[]");
    } catch {
      tags = [];
    }
    for (const tag of tags) {
      const key = String(tag);
      if (term && !normalizeText(key).includes(term)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ text: value, type: "tag", count }));
}

export function getSuggestions(db, input = {}, actor, options = {}) {
  const tenantId = Number(options.tenantId ?? actor?.tenant_id ?? 0);
  const config = getConfiguration(db, tenantId);
  const norm = normalizeSearchQuery(input, { config });
  const limit = Math.max(1, Math.min(Number(input.limit) || 10, 25));
  const term = normalizeText(norm.text);
  const availableTypes = searchableObjectTypeCodes(db, tenantId);
  const requestedTypes = norm.object_types.length
    ? norm.object_types.filter((code) => availableTypes.includes(code))
    : availableTypes;
  const suggestions = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.type}:${normalizeText(item.text)}`;
    if (seen.has(key) || !item.text) return;
    seen.add(key);
    suggestions.push(item);
  };

  for (const entry of listSearchHistory(db, {
    tenantId,
    actorId: actor?.id,
    limit,
    q: term,
  })) {
    push({ text: entry.query, type: "recent", count: undefined, executed_at: entry.executed_at });
  }

  for (const type of searchableObjectTypes(db, tenantId)) {
    if (term && !normalizeText(type.name).includes(term) && !normalizeText(type.code).includes(term)) continue;
    push({ text: type.name, type: "object_type", object_type: type.code, count: undefined });
  }

  if (requestedTypes.length) {
    const provider = getSearchProvider(options.provider || DEFAULT_PROVIDER);
    if (typeof provider.suggest === "function") {
      const rows = provider.suggest(db, norm, {
        allowedTypes: requestedTypes,
        tenantId,
        scope: "tenant",
        limit,
      });
      for (const row of rows) {
        push({ text: row.value, type: "title", object_type: row.object_type, count: row.count });
      }
    }
    const where = "i.tenant_id = ?";
    for (const tag of collectTags(db, where, [tenantId], term, limit)) push(tag);
  }

  const items = suggestions.slice(0, limit).map((item) => ({
    ...item,
    highlighted: term ? highlightText(item.text, [term]) : undefined,
  }));
  return { query: norm.text, suggestions: items };
}
