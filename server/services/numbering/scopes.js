// Scope resolution for the Numbering Service.
//
// Given an allocation request, the resolver selects the single most specific
// active scheme. Resolution order (most important first): scheme code override,
// tenant, organization, plant, site, classification, object type, effective
// date, status, default flag and priority. Ties are refused as ambiguous.
import { queryAll, queryOne } from "../../db.js";
import { nowIso } from "../../db.js";
import { ambiguousScheme, invalidObjectType, noApplicableScheme, schemeInactive, schemeNotFound } from "./errors.js";

export function toSqlDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  return String(value).replace("T", " ").slice(0, 19);
}

export function isEffective(scheme, at = new Date()) {
  const now = toSqlDate(at);
  const from = scheme.effective_from ? toSqlDate(scheme.effective_from) : null;
  const to = scheme.effective_to ? toSqlDate(scheme.effective_to) : null;
  if (from && from > now) return false;
  if (to && to < now) return false;
  return true;
}

// Score a scheme against the request. Returns null when the scheme does not
// apply; otherwise a numeric specificity score (higher wins).
export function scopeScore(scheme, request) {
  let score = 0;
  const tenantId = request.tenantId ?? null;
  if (scheme.tenant_id !== null && scheme.tenant_id !== undefined) {
    if (tenantId === null || Number(scheme.tenant_id) !== Number(tenantId)) return null;
    score += 100;
  }
  if (scheme.organization_id !== null && scheme.organization_id !== undefined) {
    if (!request.organizationId || Number(scheme.organization_id) !== Number(request.organizationId)) return null;
    score += 10;
  }
  if (scheme.plant_id !== null && scheme.plant_id !== undefined) {
    if (!request.plantId || Number(scheme.plant_id) !== Number(request.plantId)) return null;
    score += 5;
  }
  if (scheme.site_id !== null && scheme.site_id !== undefined) {
    if (!request.siteId || Number(scheme.site_id) !== Number(request.siteId)) return null;
    score += 4;
  }
  if (scheme.classification) {
    if (!request.classification || String(scheme.classification) !== String(request.classification)) return null;
    score += 2;
  }
  return score;
}

function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (Number(a.scheme.priority) !== Number(b.scheme.priority)) return Number(a.scheme.priority) - Number(b.scheme.priority);
  if (Number(b.scheme.is_default) !== Number(a.scheme.is_default)) return Number(b.scheme.is_default) - Number(a.scheme.is_default);
  return Number(a.scheme.id) - Number(b.scheme.id);
}

export function getSchemeRow(db, ref) {
  if (ref === null || ref === undefined) return null;
  if (/^\d+$/.test(String(ref))) {
    return queryOne(db, "SELECT * FROM numbering_schemes WHERE id = ?", [Number(ref)]);
  }
  return queryOne(db, "SELECT * FROM numbering_schemes WHERE code = ?", [String(ref)]);
}

// Deterministic scheme resolution. `request.requireActive` defaults to true.
export function resolveApplicableScheme(db, request = {}) {
  const objectTypeCode = String(request.objectTypeCode || "").toUpperCase();
  if (!objectTypeCode) throw invalidObjectType(request.objectTypeCode);
  const objectType = queryOne(db, "SELECT * FROM numbering_object_types WHERE code = ?", [objectTypeCode]);
  if (!objectType || objectType.status !== "active") throw invalidObjectType(objectTypeCode);

  if (request.schemeCode || request.schemeId) {
    const scheme = request.schemeCode
      ? queryOne(db, "SELECT * FROM numbering_schemes WHERE code = ?", [String(request.schemeCode)])
      : getSchemeRow(db, request.schemeId);
    if (!scheme) throw schemeNotFound(request.schemeCode || request.schemeId);
    if (scheme.status !== "active") throw schemeInactive(scheme.code);
    if (scheme.object_type_code !== objectTypeCode) {
      throw noApplicableScheme({ reason: "object_type_mismatch", scheme: scheme.code, objectType: objectTypeCode });
    }
    if (!isEffective(scheme, request.now)) throw schemeInactive(`${scheme.code} (outside effective window)`);
    const score = scopeScore(scheme, request);
    if (score === null) throw noApplicableScheme({ reason: "scope_mismatch", scheme: scheme.code });
    return scheme;
  }

  const rows = queryAll(
    db,
    `SELECT * FROM numbering_schemes
     WHERE object_type_code = ? AND status = 'active'
       AND (tenant_id IS NULL OR tenant_id = ?)`,
    [objectTypeCode, request.tenantId ?? null]
  );
  const candidates = [];
  for (const scheme of rows) {
    if (!isEffective(scheme, request.now)) continue;
    const score = scopeScore(scheme, request);
    if (score === null) continue;
    candidates.push({ scheme, score });
  }
  if (!candidates.length) {
    throw noApplicableScheme({ objectType: objectTypeCode, tenantId: request.tenantId ?? null });
  }
  candidates.sort(compareCandidates);
  const [first, second] = candidates;
  if (second && second.score === first.score && Number(second.scheme.priority) === Number(first.scheme.priority)) {
    // A default scheme is allowed to break the tie explicitly.
    const firstDefault = Number(first.scheme.is_default) === 1;
    const secondDefault = Number(second.scheme.is_default) === 1;
    if (firstDefault === secondDefault) {
      throw ambiguousScheme({
        objectType: objectTypeCode,
        schemes: [first.scheme.code, second.scheme.code],
        score: first.score,
        priority: Number(first.scheme.priority),
      });
    }
  }
  return first.scheme;
}

// Deterministic sequence scope key. The same request always maps to the same
// counter row, which is what makes uniqueness guarantees hold across instances.
export function buildScopeKey(input = {}) {
  const scope = input.sequenceScope || "scheme";
  const parts = [];
  const push = (key, value) => {
    if (value !== undefined && value !== null && value !== "") parts.push(`${key}:${value}`);
  };
  switch (scope) {
    case "global":
      break;
    case "tenant":
      push("tenant", input.tenantId);
      break;
    case "organization":
    case "company":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      break;
    case "plant":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      push("plant", input.plantId);
      break;
    case "site":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      push("plant", input.plantId);
      push("site", input.siteId);
      break;
    case "classification":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      push("class", input.classification);
      break;
    case "object_type":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      push("type", input.objectTypeCode);
      break;
    case "custom":
      push("tenant", input.tenantId);
      push("org", input.organizationId);
      push("plant", input.plantId);
      push("site", input.siteId);
      push("class", input.classification);
      push("type", input.objectTypeCode);
      break;
    case "scheme":
    default:
      push("scheme", input.schemeId);
      break;
  }
  return parts.length ? parts.join("|") : "global";
}

// Period key drives sequence reset. Never resets unexpectedly: only a change in
// the computed period advances a reset-scoped counter.
export function buildPeriodKey(resetPolicy, at = new Date(), fiscalStartMonth = 4) {
  const date = at instanceof Date ? at : new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  switch (resetPolicy) {
    case "daily":
      return `${year}-${String(month).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    case "monthly":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "yearly":
      return String(year);
    case "fiscal_year": {
      const fy = month >= fiscalStartMonth ? year : year - 1;
      return `FY${fy}`;
    }
    case "never":
    default:
      return "";
  }
}

export function fiscalYearOf(at, fiscalStartMonth = 4) {
  const date = new Date(at);
  const month = date.getUTCMonth() + 1;
  return month >= fiscalStartMonth ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

export function listScopes(db) {
  return queryAll(db, "SELECT * FROM numbering_scopes ORDER BY code");
}

export function currentTimestamp() {
  return nowIso();
}
