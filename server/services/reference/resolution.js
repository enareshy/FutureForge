// Resolution for Enterprise Reference Data Management. Business modules call
// `resolveValue` / `resolveBulk` instead of reading reference tables directly,
// so scope precedence, effective dating, language and cache invalidation are
// applied consistently everywhere.
import { queryAll, queryOne } from "../../db.js";
import { getCacheEpoch } from "./cache.js";
import { getActiveGovernancePolicy } from "./governance.js";
import { getDomainRow } from "./domains.js";
import { ambiguousResolution, conflict, invalidItem, resolutionNotFound } from "./errors.js";
import { buildScopeKey, isEffectiveAt, normalizeText, pagination, parseObject, scopeValueFor } from "./validation.js";
import { resolvePrecedencePolicy } from "./scope.js";

// In-process cache keyed by (epoch, tenant, request). Every governed mutation
// bumps the epoch, so stale entries are never returned.
const cache = new Map();
const CACHE_LIMIT = 2000;

function cacheKey(db, tenantId, input) {
  return `${getCacheEpoch(db)}::${tenantId ?? ""}::${JSON.stringify(input)}`;
}

export function invalidateResolutionCache() {
  cache.clear();
}

export function cacheStats() {
  return { size: cache.size };
}

export function candidateScopeKeys(precedence, context = {}) {
  const keys = [];
  for (const scopeType of precedence) {
    if (scopeType === "GLOBAL") {
      keys.push("GLOBAL");
      continue;
    }
    const value = scopeValueFor(scopeType, context);
    if (value === null || value === undefined || value === "") continue;
    keys.push(`${scopeType}:${value}`);
  }
  return keys;
}

function matchCodeClause(governance, code) {
  if (governance.code_case_sensitive === false) return { clause: "UPPER(i.code) = ?", param: String(code).toUpperCase() };
  return { clause: "i.code = ?", param: code };
}

function localize(db, itemId, language) {
  if (!language) return null;
  const row = queryOne(db, "SELECT * FROM reference_translations WHERE item_id = ? AND language = ?", [Number(itemId), String(language).toLowerCase()]);
  if (!row) return null;
  return { language: row.language, name: row.name, description: row.description, status: row.status };
}

function decorate(db, item, { context, language, precedence }) {
  const result = {
    id: item.id,
    item_ref: item.item_ref,
    domain_id: item.domain_id,
    domain_code: context.domain_code ?? null,
    code: item.code,
    name: item.name,
    description: item.description,
    status: item.status,
    scope_type: item.scope_type,
    scope_key: item.scope_key,
    effective_from: item.effective_from,
    effective_to: item.effective_to,
    version: item.current_version_number,
    sequence: item.sequence,
    is_default: Boolean(item.is_default),
    attributes: parseObject(item.attributes_json, {}),
    translated: localize(db, item.id, language),
    aliases: queryAll(db, "SELECT alias, alias_type, language FROM reference_aliases WHERE item_id = ? AND status = 'active'", [item.id]).map((a) => a.alias),
    codes: queryAll(db, "SELECT code, code_type, code_system, external_system FROM reference_codes WHERE item_id = ?", [item.id]),
  };
  if (precedence) result.scope_precedence = precedence;
  return result;
}

function queryCandidates(db, domainId, governance, code, scopeKeys, asOf) {
  const { clause, param } = matchCodeClause(governance, code);
  const placeholders = scopeKeys.map(() => "?").join(", ");
  const rows = queryAll(
    db,
    `SELECT i.* FROM reference_data_items i
     WHERE i.domain_id = ? AND i.status = 'active' AND ${clause} AND i.scope_key IN (${placeholders})`,
    [Number(domainId), param, ...scopeKeys]
  );
  return rows.filter((row) => isEffectiveAt(row.effective_from, row.effective_to, asOf));
}

export function resolveValue(db, input = {}, options = {}) {
  const resolvedKey = cacheKey(db, options.tenantId ?? input.tenant_id ?? null, {
    domainId: input.domainId ?? input.domain_id ?? input.domainCode ?? input.domain_code,
    code: input.code ?? input.valueCode ?? input.value_code,
    itemRef: input.itemRef ?? input.item_ref ?? input.itemId ?? input.item_id,
    alias: input.alias,
    name: input.name,
    asOf: input.asOf ?? input.as_of,
    language: input.language,
    context: { ...(input.context || {}), ...(options.context || {}) },
  });
  const cached = cache.get(resolvedKey);
  if (cached) return cached;
  const domain = getDomainRow(db, input.domainId ?? input.domain_id ?? input.domainCode ?? input.domain_code);
  if (!domain) throw invalidItem(`Unknown reference domain: ${input.domainId ?? input.domainCode ?? input.domain_code}`);
  const governance = getActiveGovernancePolicy(db, domain.id);
  const scopePolicy = resolvePrecedencePolicy(db, options.tenantId ?? input.tenant_id ?? null);
  const context = { ...(input.context || {}), ...(options.context || {}) };
  if (options.tenantId !== undefined && context.tenantId === undefined) context.tenantId = options.tenantId;
  const precedence = scopePolicy.precedence || [];
  const scopeKeys = candidateScopeKeys(precedence, context);
  if (!scopeKeys.includes("GLOBAL")) scopeKeys.push("GLOBAL");
  const language = normalizeText(input.language, "").toLowerCase() || null;
  const asOf = input.asOf ?? input.as_of ?? null;

  let candidates = [];
  let resolution = "code";
  const explicitCode = input.code ?? input.valueCode ?? input.value_code;
  if (explicitCode) {
    candidates = queryCandidates(db, domain.id, governance, normalizeText(explicitCode), scopeKeys, asOf);
  } else if (input.itemRef ?? input.item_ref ?? input.itemId ?? input.item_id) {
    const ref = input.itemRef ?? input.item_ref ?? input.itemId ?? input.item_id;
    const row = queryOne(
      db,
      `SELECT * FROM reference_data_items WHERE domain_id = ? AND (item_ref = ? OR id = ?)`,
      [Number(domain.id), String(ref), Number(ref) || 0]
    );
    if (row) candidates = [row].filter((r) => isEffectiveAt(r.effective_from, r.effective_to, asOf));
    resolution = "ref";
  } else if (input.alias) {
    resolution = "alias";
    const rows = queryAll(
      db,
      `SELECT i.* FROM reference_aliases a JOIN reference_data_items i ON i.id = a.item_id
       WHERE a.domain_id = ? AND a.status = 'active' AND LOWER(a.alias) = ? AND i.status = 'active'`,
      [Number(domain.id), String(input.alias).toLowerCase()]
    );
    candidates = rows.filter((row) => isEffectiveAt(row.effective_from, row.effective_to, asOf));
  } else if (input.name) {
    resolution = "name";
    const rows = queryAll(
      db,
      `SELECT * FROM reference_data_items WHERE domain_id = ? AND status = 'active' AND (LOWER(name) = ? OR LOWER(code) = ?)`,
      [Number(domain.id), String(input.name).toLowerCase(), String(input.name).toLowerCase()]
    );
    candidates = rows.filter((row) => isEffectiveAt(row.effective_from, row.effective_to, asOf));
  } else {
    const rows = queryAll(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND status = 'active' AND is_default = 1", [Number(domain.id)]);
    candidates = rows.filter((row) => isEffectiveAt(row.effective_from, row.effective_to, asOf));
  }

  const scored = candidates
    .map((row) => ({ row, order: scopeKeys.indexOf(row.scope_key) }))
    .filter((entry) => entry.order >= 0)
    .sort((a, b) => a.order - b.order || Number(b.row.current_version_number) - Number(a.row.current_version_number));

  if (!scored.length) {
    if (options.silent) return null;
    throw resolutionNotFound({ domain: domain.code, code: explicitCode ?? input.alias ?? input.name ?? null, scope_keys: scopeKeys, as_of: asOf });
  }
  const bestOrder = scored[0].order;
  const tied = scored.filter((entry) => entry.order === bestOrder);
  if (tied.length > 1) {
    if (scopePolicy.conflict_strategy === "highest_precedence") {
      tied.sort((a, b) => Number(b.row.current_version_number) - Number(a.row.current_version_number));
    } else if (scopePolicy.conflict_strategy === "latest_version") {
      tied.sort((a, b) => Number(b.row.current_version_number) - Number(a.row.current_version_number));
    } else {
      throw ambiguousResolution({
        domain: domain.code,
        scope_key: tied[0].row.scope_key,
        candidates: tied.map((entry) => entry.row.item_ref),
      });
    }
  }
  const chosen = tied[0].row;
  const result = {
    resolution_status: "RESOLVED",
    resolution,
    domain: { id: domain.id, code: domain.code, name: domain.name },
    value: decorate(db, chosen, { context: { ...context, domain_code: domain.code }, language, precedence: bestOrder }),
    scope_precedence: bestOrder,
    as_of: asOf,
    resolved_at: new Date().toISOString(),
  };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(resolvedKey, result);
  return result;
}

export function lookupValue(db, input = {}, options = {}) {
  return resolveValue(db, input, { ...options, silent: true });
}

export function resolveBulk(db, input = {}, options = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const results = [];
  for (const item of items) {
    try {
      results.push({ input: item, ...resolveValue(db, { ...item, domainId: item.domainId ?? input.domainId, context: item.context ?? input.context }, options) });
    } catch (error) {
      results.push({ input: item, resolution_status: error.code === "REFERENCE_VALUE_NOT_FOUND" ? "NOT_FOUND" : "ERROR", error: error.message, code: error.code ?? null });
    }
  }
  return { items: results, total: results.length };
}

export function validateValue(db, input = {}, options = {}) {
  const domain = getDomainRow(db, input.domainId ?? input.domainId ?? input.domainCode ?? input.domain_code);
  if (!domain) return { valid: false, reason: "DOMAIN_NOT_FOUND" };
  const value = String(input.code ?? input.value ?? "").trim();
  if (!value) return { valid: false, reason: "MISSING_VALUE" };
  const result = lookupValue(db, { ...input, code: value }, options);
  if (!result) return { valid: false, reason: "NOT_FOUND", domain: domain.code, value };
  const codes = result.value.codes.map((c) => c.code);
  return { valid: true, domain: domain.code, value, item_ref: result.value.item_ref, matched_scope: result.value.scope_key, codes };
}

export function listValues(db, input = {}, options = {}) {
  const domain = getDomainRow(db, input.domainId ?? input.domain_code ?? input.domainCode);
  if (!domain) throw invalidItem(`Unknown reference domain: ${input.domainId ?? input.domainCode}`);
  const asOf = input.asOf ?? input.as_of ?? null;
  const language = normalizeText(input.language, "").toLowerCase() || null;
  const context = { ...(input.context || {}), ...(options.context || {}) };
  if (options.tenantId !== undefined && options.tenantId !== null && context.tenantId === undefined) context.tenantId = options.tenantId;
  const scopePolicy = resolvePrecedencePolicy(db, options.tenantId ?? null);
  const scopeKeys = candidateScopeKeys(scopePolicy.precedence || [], context);
  const rows = queryAll(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND status = 'active' ORDER BY sequence, code", [Number(domain.id)]).filter(
    (row) =>
      (!scopeKeys.length || scopeKeys.includes(row.scope_key) || row.scope_key === "GLOBAL") &&
      isEffectiveAt(row.effective_from, row.effective_to, asOf)
  );
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    items.push(decorate(db, row, { context: { ...context, domain_code: domain.code }, language, precedence: scopeKeys.indexOf(row.scope_key) }));
  }
  return { domain: { id: domain.id, code: domain.code, name: domain.name }, items, total: items.length, as_of: asOf };
}

// Cross-domain value search used by the reference data console and by consumer
// modules that need a user-friendly "find a code" experience. Matches on code,
// name, description, aliases, alternate codes and translations.
export function searchValues(db, input = {}, options = {}) {
  const text = normalizeText(input.text ?? input.q ?? input.query, "");
  const requestedDomain = input.domainId ?? input.domain_code ?? input.domainCode ?? null;
  const domain = requestedDomain ? getDomainRow(db, requestedDomain) : null;
  if (requestedDomain && !domain) throw invalidItem(`Unknown reference domain: ${requestedDomain}`);
  const asOf = input.asOf ?? input.as_of ?? null;
  const language = normalizeText(input.language, "").toLowerCase() || null;
  const status = normalizeText(input.status, "active") || "active";
  const context = { ...(input.context || {}), ...(options.context || {}) };
  if (options.tenantId !== undefined && options.tenantId !== null && context.tenantId === undefined) context.tenantId = options.tenantId;
  const scopePolicy = resolvePrecedencePolicy(db, options.tenantId ?? null);
  const scopeKeys = candidateScopeKeys(scopePolicy.precedence || [], context);
  const rows = queryAll(db, "SELECT * FROM reference_data_items WHERE status = ? ORDER BY domain_id, sequence, code", [status]);
  const { page, pageSize, offset } = pagination(input, { defaultPageSize: 25 });
  const needle = text.toLowerCase();
  const matched = [];
  const seen = new Set();
  for (const row of rows) {
    if (domain && Number(row.domain_id) !== Number(domain.id)) continue;
    if (scopeKeys.length && !scopeKeys.includes(row.scope_key) && row.scope_key !== "GLOBAL") continue;
    if (!isEffectiveAt(row.effective_from, row.effective_to, asOf)) continue;
    const dedupeKey = `${row.domain_id}::${row.code}`;
    if (seen.has(dedupeKey)) continue;
    const domainRow = queryOne(db, "SELECT code, name FROM reference_domains WHERE id = ?", [row.domain_id]);
    const decorated = decorate(db, row, {
      context: { ...context, domain_code: domainRow?.code ?? null },
      language,
      precedence: scopeKeys.indexOf(row.scope_key),
    });
    if (needle) {
      const haystack = [
        decorated.code,
        decorated.name,
        decorated.description,
        domainRow?.code,
        domainRow?.name,
        decorated.translated?.name,
        ...(decorated.aliases || []),
        ...((decorated.codes || []).map((c) => c.code)),
      ]
        .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    seen.add(dedupeKey);
    matched.push(decorated);
  }
  return {
    text,
    domain: domain ? { id: domain.id, code: domain.code, name: domain.name } : null,
    items: matched.slice(offset, offset + pageSize),
    total: matched.length,
    page,
    page_size: pageSize,
    as_of: asOf,
  };
}

export { conflict };
