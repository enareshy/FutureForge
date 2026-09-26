// Pattern engine and token registry for the Numbering Service.
//
// A pattern is plain text with `{TOKEN}` placeholders. Tokens resolve through
// the `numbering_tokens` registry so new tokens can be added by administrators
// without changing the engine. `{SEQ}` is special: its value is supplied by the
// sequence engine.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { NumberingError, NUMBERING_ERROR_CODES, invalidPattern } from "./errors.js";
import { validateTokenCode } from "./validation.js";

// Built-in resolvers. Each receives the resolution context and returns a string.
export const SYSTEM_RESOLVERS = {
  sequence: (ctx) => (ctx.sequence === undefined || ctx.sequence === null ? null : String(ctx.sequence)),
  year4: (ctx) => String(ctx.now.getUTCFullYear()),
  year2: (ctx) => String(ctx.now.getUTCFullYear()).slice(-2),
  month: (ctx) => String(ctx.now.getUTCMonth() + 1).padStart(2, "0"),
  day: (ctx) => String(ctx.now.getUTCDate()).padStart(2, "0"),
  week: (ctx) => {
    const d = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, "0");
  },
  org: (ctx) => ctx.organizationCode ?? "",
  plant: (ctx) => ctx.plantCode ?? "",
  site: (ctx) => ctx.siteCode ?? "",
  site_or_plant: (ctx) => ctx.siteCode ?? ctx.plantCode ?? "",
  classification: (ctx) => ctx.classification ?? "",
  object_type: (ctx) => ctx.objectType ?? "",
  user: (ctx) => ctx.username ?? "",
  fiscal_year: (ctx) => String(ctx.fiscalYear ?? ctx.now.getUTCFullYear()),
};

export const SYSTEM_TOKENS = [
  { code: "SEQ", name: "Sequence", resolver: "sequence", example: "000001", description: "Padded sequence value from the allocation engine." },
  { code: "YYYY", name: "Year (4-digit)", resolver: "year4", example: "2026", description: "Four digit calendar year." },
  { code: "YY", name: "Year (2-digit)", resolver: "year2", example: "26", description: "Two digit calendar year." },
  { code: "MM", name: "Month", resolver: "month", example: "09", description: "Two digit month." },
  { code: "DD", name: "Day", resolver: "day", example: "19", description: "Two digit day of month." },
  { code: "WW", name: "ISO week", resolver: "week", example: "38", description: "Two digit ISO week." },
  { code: "ORG", name: "Organization", resolver: "org", example: "ACME", description: "Resolved organization code." },
  { code: "PLANT", name: "Plant", resolver: "plant", example: "HYD", description: "Resolved plant code." },
  { code: "SITE", name: "Site", resolver: "site", example: "HYD1", description: "Resolved site code." },
  { code: "CLASS", name: "Classification", resolver: "classification", example: "ELECTRICAL", description: "Resolved classification code." },
  { code: "TYPE", name: "Object type", resolver: "object_type", example: "PART", description: "Numbering object type code." },
  { code: "USER", name: "User", resolver: "user", example: "j.patel", description: "Requesting user name where permitted." },
  { code: "FY", name: "Fiscal year", resolver: "fiscal_year", example: "2026", description: "Fiscal year derived from the reset policy." },
];

const TOKEN_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

export function parsePattern(pattern) {
  if (pattern === undefined || pattern === null || String(pattern).trim() === "") {
    return { valid: false, errors: ["pattern is required"], segments: [], tokens: [] };
  }
  const text = String(pattern);
  const segments = [];
  const tokens = [];
  const errors = [];
  let buffer = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      if (text[i + 1] === "{") {
        buffer += "{";
        i += 2;
        continue;
      }
      const end = text.indexOf("}", i + 1);
      if (end === -1) {
        errors.push(`Unterminated token starting at position ${i}`);
        break;
      }
      if (buffer) {
        segments.push({ type: "text", value: buffer });
        buffer = "";
      }
      const raw = text.slice(i + 1, end).trim();
      if (!raw) {
        errors.push("Empty token placeholder");
      } else if (!TOKEN_RE.test(raw)) {
        errors.push(`Invalid token "${raw}"`);
      } else {
        segments.push({ type: "token", code: raw });
        tokens.push(raw);
      }
      i = end + 1;
      continue;
    }
    if (ch === "}") {
      if (text[i + 1] === "}") {
        buffer += "}";
        i += 2;
        continue;
      }
      errors.push(`Unexpected "}" at position ${i}; use "}}" for a literal brace`);
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  if (buffer) segments.push({ type: "text", value: buffer });
  return { valid: errors.length === 0, errors, segments, tokens };
}

export function formatSequence(value, padding) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const width = Number.isFinite(Number(padding)) && Number(padding) > 0 ? Number(padding) : 0;
  return String(n).padStart(width, "0");
}

// Renders a pattern from pre-resolved token values. Throws a NumberingError if a
// token referenced by the pattern has no resolver.
export function renderPatternWithValues(pattern, values = {}) {
  const parsed = parsePattern(pattern);
  if (!parsed.valid) throw invalidPattern(`Invalid pattern: ${parsed.errors.join("; ")}`);
  let output = "";
  for (const segment of parsed.segments) {
    if (segment.type === "text") {
      output += segment.value;
      continue;
    }
    if (!(segment.code in values)) {
      throw invalidPattern(`Token {${segment.code}} has no resolver`, { token: segment.code });
    }
    const value = values[segment.code];
    output += value === undefined || value === null ? "" : String(value);
  }
  return output;
}

export function resolveTokenValues(db, context = {}) {
  const tokens = listTokens(db, { activeOnly: true });
  const values = {};
  for (const token of tokens) {
    const resolver = SYSTEM_RESOLVERS[token.resolver];
    if (!resolver) continue;
    const value = resolver(context);
    if (value !== null && value !== undefined && value !== "") values[token.code] = value;
    else values[token.code] = "";
  }
  return values;
}

export function listTokens(db, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM numbering_tokens WHERE status = 'active' ORDER BY code"
    : "SELECT * FROM numbering_tokens ORDER BY code";
  return queryAll(db, sql);
}

export function getToken(db, code) {
  return queryOne(db, "SELECT * FROM numbering_tokens WHERE code = ?", [String(code).toUpperCase()]);
}

export function createToken(db, input = {}) {
  const code = String(input.code || "").toUpperCase();
  validateTokenCode(code);
  if (SYSTEM_RESOLVERS[input.resolver] === undefined) {
    throw new HttpError(400, `Unknown token resolver: ${input.resolver}`);
  }
  if (getToken(db, code)) throw new HttpError(409, `Token ${code} already exists`);
  const ts = nowIso();
  run(
    db,
    `INSERT INTO numbering_tokens (code, name, description, resolver, example, requires_permission, status, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      code,
      input.name || code,
      input.description || "",
      input.resolver,
      input.example || "",
      input.requires_permission || "",
      input.status || "active",
      ts,
      ts,
    ]
  );
  return getToken(db, code);
}

// Validates that every token used by a pattern is registered and resolvable.
export function checkPatternTokens(db, pattern) {
  const parsed = parsePattern(pattern);
  if (!parsed.valid) return { valid: false, errors: parsed.errors, unknownTokens: [] };
  const known = new Set(listTokens(db, { activeOnly: true }).map((t) => t.code));
  const unknownTokens = parsed.tokens.filter((code) => !known.has(code));
  return {
    valid: unknownTokens.length === 0,
    errors: unknownTokens.map((code) => `Unknown token {${code}}`),
    unknownTokens,
    tokens: parsed.tokens,
  };
}

export function ensureDefaultTokens(db) {
  const ts = nowIso();
  let created = 0;
  for (const token of SYSTEM_TOKENS) {
    const existing = getToken(db, token.code);
    if (existing) continue;
    run(
      db,
      `INSERT INTO numbering_tokens (code, name, description, resolver, example, requires_permission, status, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 'active', 1, ?, ?)`,
      [token.code, token.name, token.description, token.resolver, token.example, ts, ts]
    );
    created += 1;
  }
  return created;
}

export { NumberingError, NUMBERING_ERROR_CODES };
