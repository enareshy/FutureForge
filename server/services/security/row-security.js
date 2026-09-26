// Row level security. Produces a SQL predicate the data layer appends so
// unauthorized rows never leave the database (and therefore never influence
// counts, facets or pagination).
import { descendantOrganizationIds } from "../orgs.js";
import { DECISION_REASONS, DEFAULT_ENFORCEMENT } from "./constants.js";
import { evaluateCondition } from "./conditions.js";
import { buildEvaluationContext, effectiveEnforcement } from "./engine.js";
import { subjectMatches } from "./context.js";
import { evaluateFields } from "./engine.js";
import {
  getObjectType,
  listClassificationRules,
  listEntitlements,
  listFieldRules,
  listOrganizationRules,
  listPlantRules,
  listPolicies,
} from "./repository.js";

function withinValidity(row, time) {
  if (!row || (row.status && row.status !== "active")) return false;
  const from = row.valid_from ?? null;
  const to = row.valid_to ?? null;
  if (from && String(from) > time) return false;
  if (to && String(to) < time) return false;
  return true;
}

function subjectOnlyContext(context, resourceType, action) {
  return buildEvaluationContext(context, { type: resourceType }, action, {});
}

function conditionPasses(row, evalContext) {
  if (!row.condition) return true;
  return evaluateCondition(row.condition, evalContext);
}

function pushIn(clauses, params, column, values, negate) {
  if (!values.length) return;
  const placeholders = values.map(() => "?").join(", ");
  clauses.push(`${column} ${negate ? "NOT IN" : "IN"} (${placeholders})`);
  params.push(...values);
}

// Returns { enforced, sql, params, enforcement } where sql is a fragment over
// the search_index alias `i`.
export function buildRowSecurityFilter(db, context, resourceType, action = "read") {
  const tenantId = Number(context?.tenantId ?? 0);
  const enforcement = effectiveEnforcement(db, tenantId, resourceType);
  const evalContext = subjectOnlyContext(context, resourceType, action);
  const time = evalContext.request.time;

  const policies = listPolicies(db, tenantId, { status: "active" }).filter(
    (row) =>
      withinValidity(row, time) &&
      (!row.resource_type || row.resource_type === resourceType) &&
      (!row.action || row.action === action) &&
      subjectMatches(context, row.subject_type, row.subject_id) &&
      conditionPasses(row, evalContext)
  );
  const entitlements = listEntitlements(db, tenantId, { status: "active" }).filter(
    (row) =>
      (!row.resource_type || row.resource_type === resourceType) &&
      (!row.action || row.action === action) &&
      subjectMatches(context, row.subject_type, row.subject_id) &&
      conditionPasses(row, evalContext)
  );
  const classificationRules = listClassificationRules(db, tenantId).filter(
    (row) =>
      withinValidity(row, time) &&
      (!row.resource_type || row.resource_type === resourceType) &&
      (!row.action || row.action === action) &&
      subjectMatches(context, row.subject_type, row.subject_id) &&
      conditionPasses(row, evalContext)
  );
  const orgRules = listOrganizationRules(db, tenantId).filter(
    (row) =>
      withinValidity(row, time) &&
      (!row.resource_type || row.resource_type === resourceType) &&
      (!row.action || row.action === action) &&
      subjectMatches(context, row.subject_type, row.subject_id) &&
      conditionPasses(row, evalContext)
  );
  const plantRules = listPlantRules(db, tenantId).filter(
    (row) =>
      withinValidity(row, time) &&
      (!row.resource_type || row.resource_type === resourceType) &&
      (!row.action || row.action === action) &&
      subjectMatches(context, row.subject_type, row.subject_id) &&
      conditionPasses(row, evalContext)
  );

  const hasRules =
    policies.length + entitlements.length + classificationRules.length + orgRules.length + plantRules.length > 0;
  if (enforcement === DEFAULT_ENFORCEMENT && !hasRules) {
    return { enforced: false, sql: null, params: [], enforcement, reason: null };
  }

  const clauses = [];
  const params = [];
  const denyReasons = [];

  // Explicit object entitlements.
  const objectDeny = entitlements
    .filter((row) => row.scope === "object" && row.effect === "deny" && row.resource_id)
    .map((row) => String(row.resource_id));
  const objectAllow = entitlements
    .filter((row) => row.scope === "object" && row.effect === "allow" && row.resource_id)
    .map((row) => String(row.resource_id));
  if (objectDeny.length) {
    pushIn(clauses, params, "i.object_id", objectDeny, true);
    denyReasons.push(DECISION_REASONS.OBJECT_DENIED);
  }
  if (objectAllow.length) {
    clauses.push(`(i.object_id IN (${objectAllow.map(() => "?").join(", ")}) OR i.object_id IS NULL)`);
    params.push(...objectAllow);
  }

  // Classification.
  const classificationDeny = classificationRules
    .filter((row) => row.effect === "deny")
    .map((row) => row.classification);
  if (classificationDeny.length) {
    pushIn(clauses, params, "i.classification", [...new Set(classificationDeny)], true);
    denyReasons.push(DECISION_REASONS.CLASSIFICATION_DENIED);
  }

  // Organization scoping.
  const orgDeny = [];
  const orgAllow = new Set();
  for (const rule of orgRules) {
    if (rule.effect === "deny") {
      orgDeny.push(Number(rule.organization_id));
    } else {
      orgAllow.add(Number(rule.organization_id));
      if (rule.include_descendants || rule.scope_mode === "self_and_descendants" || rule.scope_mode === "include_descendants") {
        for (const id of descendantOrganizationIds(db, Number(rule.organization_id))) orgAllow.add(Number(id));
      }
    }
  }
  if (orgDeny.length) {
    clauses.push(`(i.organization_id IS NULL OR i.organization_id NOT IN (${orgDeny.map(() => "?").join(", ")}))`);
    params.push(...orgDeny);
    denyReasons.push(DECISION_REASONS.ORGANIZATION_DENIED);
  }
  const orgAllowList = [...orgAllow];
  if (orgAllowList.length) {
    clauses.push(`(i.organization_id IS NULL OR i.organization_id IN (${orgAllowList.map(() => "?").join(", ")}))`);
    params.push(...orgAllowList);
  }

  // Plant scoping (site_id stores the plant/site).
  const plantDeny = [];
  const plantAllow = new Set();
  for (const rule of plantRules) {
    if (rule.effect === "deny") {
      plantDeny.push(Number(rule.plant_id));
    } else {
      plantAllow.add(Number(rule.plant_id));
      if (rule.include_descendants) {
        for (const id of descendantOrganizationIds(db, Number(rule.plant_id))) plantAllow.add(Number(id));
      }
    }
  }
  if (plantDeny.length) {
    clauses.push(`(i.site_id IS NULL OR i.site_id NOT IN (${plantDeny.map(() => "?").join(", ")}))`);
    params.push(...plantDeny);
    denyReasons.push(DECISION_REASONS.PLANT_DENIED);
  }
  const plantAllowList = [...plantAllow];
  if (plantAllowList.length) {
    clauses.push(`(i.site_id IS NULL OR i.site_id IN (${plantAllowList.map(() => "?").join(", ")}))`);
    params.push(...plantAllowList);
  }

  // Strict policy enforcement requires at least one explicit allow.
  const explicitAllow =
    policies.some((row) => row.effect === "allow") ||
    entitlements.some((row) => row.effect === "allow") ||
    classificationRules.some((row) => row.effect === "allow") ||
    orgRules.some((row) => row.effect === "allow") ||
    plantRules.some((row) => row.effect === "allow");

  if (enforcement === "policy" && !explicitAllow) {
    clauses.push("0 = 1");
    denyReasons.push(DECISION_REASONS.POLICY_DENIED);
  }

  if (!clauses.length) {
    return { enforced: enforcement !== DEFAULT_ENFORCEMENT, sql: null, params: [], enforcement, reason: denyReasons[0] || null };
  }
  return {
    enforced: true,
    sql: clauses.join(" AND "),
    params,
    enforcement,
    reason: denyReasons[0] || null,
  };
}

// Builds a combined predicate for a set of object types. Types with no
// constraints are grouped so the clause stays index friendly.
export function buildSearchSecurityPredicate(db, context, objectTypes, action = "read") {
  const pieces = [];
  const params = [];
  const free = [];
  let enforced = false;
  for (const objectType of objectTypes) {
    const filter = buildRowSecurityFilter(db, context, objectType, action);
    if (!filter.enforced || !filter.sql) {
      free.push(objectType);
      continue;
    }
    enforced = true;
    pieces.push(`(i.object_type = ? AND ${filter.sql})`);
    params.push(String(objectType), ...filter.params);
  }
  if (!enforced) {
    return { enforced: false, sql: null, params: [], objectTypes };
  }
  if (free.length) {
    pieces.push(`i.object_type IN (${free.map(() => "?").join(", ")})`);
    params.push(...free);
  }
  return { enforced: true, sql: `(${pieces.join(" OR ")})`, params, objectTypes };
}

export { evaluateFields, getObjectType, listFieldRules };
