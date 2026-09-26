// Search query parser. Turns user-facing query syntax into the canonical
// SearchQuery model. The parser never emits provider-specific syntax; it only
// produces the abstract model, which the provider adapter later compiles.
//
// Supported syntax:
//   brake housing                 keyword terms (implicit AND)
//   "brake housing"               exact phrase
//   status:RELEASED               attribute filter (exact)
//   name:Brake*                   wildcard attribute filter
//   code:"PART-001"               quoted exact value
//   brake AND housing             boolean AND
//   brake OR clutch               boolean OR
//   brake NOT prototype           boolean NOT
//   (brake OR clutch) AND steel   grouped boolean expression
import {
  normalizeCanonicalQuery,
  normalizeOperator,
  emptyCanonicalQuery,
} from "./canonical.js";
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";
import { tokenize, normalizeText } from "./validation.js";

const FIELD_ALIASES = {
  type: "object_type_code",
  objecttype: "object_type",
  object_type: "object_type",
  owner: "owner_name",
  organization: "organization_id",
  org: "organization_id",
  plant: "site_id",
  site: "site_id",
  lifecycle: "lifecycle_state",
  externalref: "external_reference",
  external_reference: "external_reference",
  revision: "source_revision",
  version: "revisions",
};

const HAS_WILDCARD = /[*?]/;

function canonicalFieldName(raw) {
  const key = String(raw).trim();
  if (!key) return key;
  return FIELD_ALIASES[key.toLowerCase()] || key;
}

function scan(text) {
  const tokens = [];
  let i = 0;
  const length = text.length;
  const isBoundary = (ch) => ch === undefined || /\s|\(|\)/.test(ch);
  while (i < length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    let negate = false;
    if (ch === "-" && !isBoundary(text[i + 1]) && text[i + 1] !== "-") {
      negate = true;
      i += 1;
    }
    let value = "";
    let field = null;
    let phrase = false;
    // Read an optional field: prefix.
    const start = i;
    let j = i;
    while (j < length && !isBoundary(text[j]) && text[j] !== ":") j += 1;
    if (text[j] === ":") {
      field = text.slice(start, j);
      i = j + 1;
    }
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      i += 1;
      const valueStart = i;
      while (i < length && text[i] !== quote) i += 1;
      value = text.slice(valueStart, i);
      phrase = true;
      if (i < length) i += 1;
    } else {
      const valueStart = i;
      while (i < length && !isBoundary(text[i])) i += 1;
      value = text.slice(valueStart, i);
    }
    if (!value && field === null) {
      i = Math.max(i, start + 1);
      continue;
    }
    const upper = value.toUpperCase();
    if (field === null && !phrase && (upper === "AND" || upper === "OR" || upper === "NOT")) {
      tokens.push({ type: upper });
      continue;
    }
    tokens.push({ type: "term", field, value, phrase, negate });
  }
  return tokens;
}

function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let node = parseAnd();
    while (peek()?.type === "OR") {
      next();
      node = { kind: "or", children: [node, parseAnd()] };
    }
    return node;
  }

  function parseAnd() {
    let node = parseUnary();
    while (true) {
      const token = peek();
      if (!token || token.type === ")" || token.type === "OR") break;
      if (token.type === "AND") next();
      node = { kind: "and", children: [node, parseUnary()] };
    }
    return node;
  }

  function parseUnary() {
    const token = peek();
    if (token?.type === "NOT") {
      next();
      return { kind: "not", child: parseUnary() };
    }
    if (token?.type === "term" && token.negate) {
      next();
      return { kind: "not", child: { kind: "term", ...token, negate: false } };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = next();
    if (!token) {
      throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Unexpected end of query");
    }
    if (token.type === "(") {
      const node = parseOr();
      if (peek()?.type !== ")") {
        throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Unbalanced parenthesis in query");
      }
      next();
      return node;
    }
    if (token.type === ")") {
      throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Unbalanced parenthesis in query");
    }
    if (token.type !== "term") {
      throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `Unexpected token "${token.type}"`);
    }
    return { kind: "term", ...token };
  }

  const ast = parseOr();
  if (pos < tokens.length) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Unexpected trailing tokens in query");
  }
  return ast;
}

function filterForTerm(term) {
  const field = term.field ? canonicalFieldName(term.field) : "_text";
  const raw = String(term.value ?? "");
  if (HAS_WILDCARD.test(raw)) {
    return { field, operator: "WILDCARD", value: raw };
  }
  if (term.phrase) {
    return { field, operator: field === "_text" ? "CONTAINS" : "EQ", value: raw };
  }
  return { field, operator: field === "_text" ? "CONTAINS" : "EQ", value: raw };
}

function hasBoolean(node) {
  if (!node) return false;
  if (node.kind === "or" || node.kind === "not") return true;
  if (node.kind === "and") return node.children.some(hasBoolean);
  return false;
}

function flattenAnd(node, sink = []) {
  if (node.kind === "and") {
    node.children.forEach((child) => flattenAnd(child, sink));
  } else {
    sink.push(node);
  }
  return sink;
}

function conditionForNode(node) {
  if (node.kind === "and") {
    return groupFor("and", node.children);
  }
  if (node.kind === "or") {
    return groupFor("or", node.children);
  }
  if (node.kind === "not") {
    const child = conditionForNode(node.child);
    return {
      operator: "not",
      filters: child?.filters || [],
      conditions: child?.conditions || [],
    };
  }
  return { operator: "and", filters: [filterForTerm(node)], conditions: [] };
}

function groupFor(operator, children) {
  const filters = [];
  const conditions = [];
  for (const child of children) {
    if (child.kind === "term") filters.push(filterForTerm(child));
    else conditions.push(conditionForNode(child));
  }
  return { operator, filters, conditions };
}

// Parses query text into a canonical query. `base` contributes the non-text
// parts (object types, facets, sort, pagination) so a parsed query can be
// composed with caller constraints.
export function parseSearchText(text, base = {}) {
  const source = String(text ?? "").trim();
  const canonical = normalizeCanonicalQuery({ ...base, text: "" });
  if (!source) return canonical;

  const tokens = scan(source);
  if (!tokens.length) return canonical;
  const ast = parseTokens(tokens);

  if (!hasBoolean(ast)) {
    const leaves = flattenAnd(ast);
    const terms = [];
    const filters = [];
    for (const leaf of leaves) {
      const filter = filterForTerm(leaf);
      if (filter.field === "_text") {
        terms.push(String(filter.value));
      } else {
        filters.push(filter);
      }
    }
    return {
      ...canonical,
      text: terms.join(" "),
      filters: [...canonical.filters, ...filters],
    };
  }

  return {
    ...canonical,
    text: "",
    condition: conditionForNode(ast),
  };
}

// Public entry point for POST /search/parse and internal callers. Accepts a
// raw string or an object containing `text` plus constraint fields.
export function parseSearchQuery(input = {}) {
  if (typeof input === "string") {
    const query = parseSearchText(input, {});
    return { query, parsed: describeQuery(query, input) };
  }
  const base = { ...input };
  const rawText = base.text ?? base.q ?? base.query ?? "";
  const query = parseSearchText(rawText, base);
  return { query, parsed: describeQuery(query, rawText) };
}

function describeQuery(query, source) {
  const attributes = [...query.filters, ...conditionFilters(query.condition)].map((filter) => ({
    field: filter.field,
    operator: normalizeOperator(filter.operator),
    value: filter.value,
  }));
  return {
    source: String(source ?? ""),
    boolean: Boolean(query.condition),
    terms: tokenize(query.text),
    attributes: attributes.filter((filter) => filter.field !== "_text"),
  };
}

function conditionFilters(node, sink = []) {
  if (!node) return sink;
  sink.push(...node.filters);
  node.conditions.forEach((child) => conditionFilters(child, sink));
  return sink;
}

// Translates a canonical sort/filter field alias without touching the model.
export { canonicalFieldName };
