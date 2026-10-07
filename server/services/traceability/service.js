// Generic Traceability Engine — traversal, coverage, orphan and health views.
//
// This module is deliberately a composition layer. It never owns persistence or
// traversal logic: forward/backward/path/impact/matrix delegate to the Digital
// Thread engine, and coverage/orphans/broken-links are read models over the
// shared Object & Relationship framework. Object types, relationship types,
// domains and rules are configuration-driven through the registry.
import { pagination } from "../../validation.js";
import * as objects from "../objects.js";
import { Constants, Domains, Definitions, Rules, Engine, Traceability, Impact, Paths, Security, Configuration } from "../thread/index.js";
import {
  coverageRowsForRule,
  coverageRowsForRuleAsync,
  brokenRelationshipRows,
  brokenRelationshipRowsAsync,
  brokenRelationshipCount,
  brokenRelationshipCountAsync,
} from "./repository.js";
import { invalidQuery } from "./errors.js";
import { OBSOLETE_STATUSES, MAX_COVERAGE_SOURCES, MAX_BROKEN_LINKS, MAX_ORPHANS, BROKEN_LINK_REASONS } from "./constants.js";

const READ_ACTION = "read";

function asArray(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeDirection(value, fallback = "DOWNSTREAM") {
  const direction = String(value || fallback).toUpperCase();
  return ["UPSTREAM", "DOWNSTREAM", "BOTH"].includes(direction) ? direction : fallback;
}

function normalizeBool(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// Normalizes query/body parameters into engine options. Accepts both camelCase
// and snake_case so the API is forgiving without duplicating the engine.
function traversalOptions(options = {}) {
  return {
    definitionCode: options.definitionCode || options.definition_code || undefined,
    maxDepth: options.maxDepth ?? options.max_depth ?? options.depth,
    maxNodes: options.maxNodes ?? options.max_nodes,
    relationshipTypes: asArray(options.relationshipTypes ?? options.relationship_types),
    includeInactive: normalizeBool(options.includeInactive ?? options.include_inactive),
    revision: options.revision || options.revision_rule,
    asOf: options.asOf || options.as_of || options.effectivity,
    configuration: options.configuration,
    variant: options.variant,
    organizationId: options.organizationId ?? options.organization_id,
    includeDomains: asArray(options.includeDomains ?? options.include_domains),
    excludeDomains: asArray(options.excludeDomains ?? options.exclude_domains),
  };
}

function requireObjectRef(objectType, objectId) {
  const type = String(objectType || "").trim();
  const id = String(objectId ?? "").trim();
  if (!type || !id) throw invalidQuery("objectType and objectId are required", { objectType, objectId });
  return { objectType: type, objectId: id };
}

// ── Forward / backward traversal ─────────────────────────────────────────────
function traverseSync(db, tenantId, actor, { objectType, objectId, direction, action = "TRAVERSAL", options = {} }) {
  const { objectType: type, objectId: id } = requireObjectRef(objectType, objectId);
  const { result, definition } = Engine.executeTraversal(
    db,
    tenantId,
    { ...traversalOptions(options), root: `${type}:${id}`, direction: normalizeDirection(direction) },
    actor,
    { action }
  );
  return Engine.publicGraph(result, definition);
}

async function traverseAsync(db, tenantId, actor, { objectType, objectId, direction, action = "TRAVERSAL", options = {} }) {
  const { objectType: type, objectId: id } = requireObjectRef(objectType, objectId);
  const { result, definition } = await Engine.executeTraversalAsync(
    db,
    tenantId,
    { ...traversalOptions(options), root: `${type}:${id}`, direction: normalizeDirection(direction) },
    actor,
    { action }
  );
  return Engine.publicGraph(result, definition);
}

export function forward(db, tenantId, params, actor) {
  return traverseSync(db, tenantId, actor, { ...params, direction: "DOWNSTREAM", options: params });
}
export function backward(db, tenantId, params, actor) {
  return traverseSync(db, tenantId, actor, { ...params, direction: "UPSTREAM", options: params });
}
export function children(db, tenantId, params, actor) {
  return traverseSync(db, tenantId, actor, { ...params, direction: "DOWNSTREAM", options: { ...params, maxDepth: 1 } });
}
export function parents(db, tenantId, params, actor) {
  return traverseSync(db, tenantId, actor, { ...params, direction: "UPSTREAM", options: { ...params, maxDepth: 1 } });
}
export function graph(db, tenantId, params, actor) {
  return traverseSync(db, tenantId, actor, { ...params, direction: params.direction || "DOWNSTREAM", action: "TRACEABILITY", options: { includeInactive: true, ...params } });
}

export function forwardAsync(db, tenantId, params, actor) {
  return traverseAsync(db, tenantId, actor, { ...params, direction: "DOWNSTREAM", options: params });
}
export function backwardAsync(db, tenantId, params, actor) {
  return traverseAsync(db, tenantId, actor, { ...params, direction: "UPSTREAM", options: params });
}
export function childrenAsync(db, tenantId, params, actor) {
  return traverseAsync(db, tenantId, actor, { ...params, direction: "DOWNSTREAM", options: { ...params, maxDepth: 1 } });
}
export function parentsAsync(db, tenantId, params, actor) {
  return traverseAsync(db, tenantId, actor, { ...params, direction: "UPSTREAM", options: { ...params, maxDepth: 1 } });
}
export function graphAsync(db, tenantId, params, actor) {
  return traverseAsync(db, tenantId, actor, { ...params, direction: params.direction || "DOWNSTREAM", action: "TRACEABILITY", options: { includeInactive: true, ...params } });
}

// ── Paths, impact and matrix (delegated to the Digital Thread) ───────────────
function refFrom(params, role) {
  const direct = params[role];
  if (direct && typeof direct === "object") return `${direct.objectType || direct.object_type}:${direct.objectId || direct.object_id}`;
  if (direct) return String(direct);
  const type = params[`${role}_type`] || params[`${role}Type`];
  const id = params[`${role}_id`] || params[`${role}Id`];
  return type && id ? `${type}:${id}` : null;
}

function pathOptions(params) {
  return {
    source: refFrom(params, "source"),
    target: refFrom(params, "target"),
    direction: normalizeDirection(params.direction),
    maxDepth: params.maxDepth ?? params.max_depth,
    relationshipTypes: asArray(params.relationshipTypes ?? params.relationship_types),
    includeInactive: normalizeBool(params.includeInactive ?? params.include_inactive),
    configuration: params.configuration,
  };
}

export function findPaths(db, tenantId, params, actor) {
  const options = pathOptions(params);
  if (!options.source || !options.target) throw invalidQuery("source and target are required");
  return Paths.findPaths(db, tenantId, options, actor);
}
export async function findPathsAsync(db, tenantId, params, actor) {
  const options = pathOptions(params);
  if (!options.source || !options.target) throw invalidQuery("source and target are required");
  return Paths.findPathsAsync(db, tenantId, options, actor);
}

export function impact(db, tenantId, params, actor) {
  const { objectType: type, objectId: id } = requireObjectRef(params.objectType || params.object_type, params.objectId || params.object_id);
  return Impact.impactAnalysis(db, tenantId, { ...traversalOptions(params), root: `${type}:${id}` }, actor);
}
export async function impactAsync(db, tenantId, params, actor) {
  const { objectType: type, objectId: id } = requireObjectRef(params.objectType || params.object_type, params.objectId || params.object_id);
  return Impact.impactAnalysisAsync(db, tenantId, { ...traversalOptions(params), root: `${type}:${id}` }, actor);
}

export function matrix(db, tenantId, params, actor) {
  const { objectType: type, objectId: id } = requireObjectRef(params.objectType || params.object_type, params.objectId || params.object_id);
  return Traceability.traceabilityMatrix(
    db,
    tenantId,
    { ...traversalOptions(params), root: `${type}:${id}`, direction: normalizeDirection(params.direction) },
    actor
  );
}
export async function matrixAsync(db, tenantId, params, actor) {
  const { objectType: type, objectId: id } = requireObjectRef(params.objectType || params.object_type, params.objectId || params.object_id);
  return Traceability.traceabilityMatrixAsync(
    db,
    tenantId,
    { ...traversalOptions(params), root: `${type}:${id}`, direction: normalizeDirection(params.direction) },
    actor
  );
}

// ── Coverage engine ──────────────────────────────────────────────────────────
function domainTypeMap(definition) {
  const map = new Map();
  for (const entry of Domains.domainCatalog(definition)) {
    map.set(entry.domain_code, entry.object_types.map((type) => String(type).toLowerCase()));
  }
  return map;
}

function selectRules(db, tenantId, definition) {
  return Rules.activeRules(db, tenantId, definition.code);
}

function summarize(rule, visible) {
  const expected = visible.length;
  const linked = visible.filter((row) => Number(row.link_count) > 0);
  const orphaned = visible.filter((row) => Number(row.link_count) === 0);
  const coverage = expected ? Math.round((linked.length / expected) * 1000) / 10 : 100;
  return { rule, expected, linked: linked.length, orphaned: orphaned.length, coverage, linked_rows: linked, orphan_rows: orphaned };
}

function aggregate(ruleSummaries) {
  const totals = ruleSummaries.reduce(
    (acc, entry) => {
      acc.expected += entry.expected;
      acc.linked += entry.linked;
      acc.orphaned += entry.orphaned;
      return acc;
    },
    { expected: 0, linked: 0, orphaned: 0 }
  );
  totals.coverage = totals.expected ? Math.round((totals.linked / totals.expected) * 1000) / 10 : 100;
  const byTarget = new Map();
  for (const entry of ruleSummaries) {
    const key = entry.rule.target_domain;
    if (!byTarget.has(key)) byTarget.set(key, { target_domain: key, expected: 0, linked: 0, orphaned: 0 });
    const bucket = byTarget.get(key);
    bucket.expected += entry.expected;
    bucket.linked += entry.linked;
    bucket.orphaned += entry.orphaned;
  }
  const targetDomains = [...byTarget.values()].map((bucket) => ({
    ...bucket,
    coverage: bucket.expected ? Math.round((bucket.linked / bucket.expected) * 1000) / 10 : 100,
  }));
  return { totals, targetDomains };
}

function ruleFilter(rules, options) {
  const source = options.sourceDomain || options.source_domain;
  const target = options.targetDomain || options.target_domain;
  return rules.filter((rule) => {
    if (source && rule.source_domain !== String(source).toUpperCase()) return false;
    if (target && rule.target_domain !== String(target).toUpperCase()) return false;
    return true;
  });
}

function evaluateCoverageSync(db, tenantId, options = {}, actor = null) {
  const definition = Definitions.resolveDefinition(db, tenantId, { code: options.definitionCode || options.definition_code });
  const types = domainTypeMap(definition);
  const rules = ruleFilter(selectRules(db, tenantId, definition), options);
  const authorizer = Security.createNodeAuthorizer(db, actor, { tenantId, organizationId: options.organizationId ?? null, ip: options.ip ?? null, action: READ_ACTION });
  const expectedMode = options.expectedMode === "ACTIVE" ? "ACTIVE" : "ALL";
  const ruleSummaries = [];
  for (const rule of rules) {
    const sourceTypes = types.get(rule.source_domain) || [];
    const targetTypes = types.get(rule.target_domain) || [];
    if (!sourceTypes.length) {
      ruleSummaries.push({ rule, expected: 0, linked: 0, orphaned: 0, coverage: 100, linked_rows: [], orphan_rows: [] });
      continue;
    }
    const rows = coverageRowsForRule(db, tenantId, {
      sourceTypes,
      targetTypes,
      relationshipType: rule.relationship_type || "",
      expectedMode,
      limit: MAX_COVERAGE_SOURCES,
    });
    const visible = rows.filter((row) => authorizer.allowsType(row.type_code, row.organization_id));
    ruleSummaries.push(summarize(rule, visible));
  }
  return { definition, ruleSummaries, ...aggregate(ruleSummaries) };
}

async function evaluateCoverageAsync(db, tenantId, options = {}, actor = null) {
  const definition = await Definitions.resolveDefinitionAsync(db, tenantId, { code: options.definitionCode || options.definition_code });
  const types = domainTypeMap(definition);
  const rules = ruleFilter(selectRules(db, tenantId, definition), options);
  const authorizer = await Security.createNodeAuthorizerAsync(db, actor, { tenantId, organizationId: options.organizationId ?? null, ip: options.ip ?? null, action: READ_ACTION });
  const expectedMode = options.expectedMode === "ACTIVE" ? "ACTIVE" : "ALL";
  const ruleSummaries = [];
  for (const rule of rules) {
    const sourceTypes = types.get(rule.source_domain) || [];
    const targetTypes = types.get(rule.target_domain) || [];
    if (!sourceTypes.length) {
      ruleSummaries.push({ rule, expected: 0, linked: 0, orphaned: 0, coverage: 100, linked_rows: [], orphan_rows: [] });
      continue;
    }
    const rows = await coverageRowsForRuleAsync(db, tenantId, {
      sourceTypes,
      targetTypes,
      relationshipType: rule.relationship_type || "",
      expectedMode,
      limit: MAX_COVERAGE_SOURCES,
    });
    const visible = [];
    for (const row of rows) {
      if (await authorizer.allowsTypeAsync(row.type_code, row.organization_id)) visible.push(row);
    }
    ruleSummaries.push(summarize(rule, visible));
  }
  return { definition, ruleSummaries, ...aggregate(ruleSummaries) };
}

function shapeCoverage(evaluation) {
  const { definition, ruleSummaries, totals, targetDomains } = evaluation;
  return {
    source_module: "traceability",
    definition: { code: definition.code, name: definition.name },
    overall_coverage: totals.coverage,
    expected: totals.expected,
    linked: totals.linked,
    orphaned: totals.orphaned,
    target_domains: targetDomains,
    rules: ruleSummaries.map((entry) => ({
      rule: {
        code: entry.rule.code,
        name: entry.rule.name,
        source_domain: entry.rule.source_domain,
        target_domain: entry.rule.target_domain,
        relationship_type: entry.rule.relationship_type || "",
        required: entry.rule.required,
        severity: entry.rule.severity,
      },
      expected: entry.expected,
      linked: entry.linked,
      orphaned: entry.orphaned,
      coverage: entry.coverage,
    })),
  };
}

export function coverage(db, tenantId, options, actor) {
  return shapeCoverage(evaluateCoverageSync(db, tenantId, options, actor));
}
export async function coverageAsync(db, tenantId, options, actor) {
  return shapeCoverage(await evaluateCoverageAsync(db, tenantId, options, actor));
}

// ── Orphan detection ─────────────────────────────────────────────────────────
function shapeOrphans(evaluation, options = {}) {
  const includeOptional = normalizeBool(options.includeOptional ?? options.include_optional, false);
  const items = [];
  for (const entry of evaluation.ruleSummaries) {
    if (!entry.rule.required && !includeOptional) continue;
    for (const row of entry.orphan_rows) {
      items.push({
        object: { id: row.id, code: row.code, name: row.name, type: row.type_code, status: row.status, organization_id: row.organization_id },
        rule: { code: entry.rule.code, name: entry.rule.name, required: entry.rule.required, severity: entry.rule.severity },
        source_domain: entry.rule.source_domain,
        expected_target_domain: entry.rule.target_domain,
        relationship_type: entry.rule.relationship_type || "",
      });
      if (items.length >= MAX_ORPHANS) break;
    }
    if (items.length >= MAX_ORPHANS) break;
  }
  return {
    source_module: "traceability",
    definition: { code: evaluation.definition.code, name: evaluation.definition.name },
    total: items.length,
    items,
    truncated: items.length >= MAX_ORPHANS,
  };
}

export function orphans(db, tenantId, options, actor) {
  return shapeOrphans(evaluateCoverageSync(db, tenantId, options, actor), options);
}
export async function orphansAsync(db, tenantId, options, actor) {
  return shapeOrphans(await evaluateCoverageAsync(db, tenantId, options, actor), options);
}

// ── Broken-link detection ────────────────────────────────────────────────────
function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function classifyBrokenRelationship(row) {
  const reasons = [];
  let severity = "WARNING";
  if (row.source_deleted) {
    reasons.push(BROKEN_LINK_REASONS.SOURCE_DELETED);
    severity = "ERROR";
  }
  if (row.target_deleted) {
    reasons.push(BROKEN_LINK_REASONS.TARGET_DELETED);
    severity = "ERROR";
  }
  if (OBSOLETE_STATUSES.includes(String(row.source_status).toLowerCase())) reasons.push(BROKEN_LINK_REASONS.SOURCE_OBSOLETE);
  if (OBSOLETE_STATUSES.includes(String(row.target_status).toLowerCase())) reasons.push(BROKEN_LINK_REASONS.TARGET_OBSOLETE);
  if (row.relationship_type_status && row.relationship_type_status !== "active") {
    reasons.push(BROKEN_LINK_REASONS.RELATIONSHIP_TYPE_INACTIVE);
    severity = "ERROR";
  }
  if (row.relationship_status && row.relationship_status !== "active") reasons.push(BROKEN_LINK_REASONS.RELATIONSHIP_INACTIVE);
  if (row.valid_to && row.valid_to < nowUtc()) reasons.push(BROKEN_LINK_REASONS.EFFECTIVITY_EXPIRED);
  return {
    relationship: {
      id: row.relationship_id,
      type: row.relationship_type,
      status: row.relationship_status,
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
    },
    source: { id: row.source_id, code: row.source_code, name: row.source_name, type: row.source_type, status: row.source_status, deleted: Boolean(row.source_deleted) },
    target: { id: row.target_id, code: row.target_code, name: row.target_name, type: row.target_type, status: row.target_status, deleted: Boolean(row.target_deleted) },
    reasons,
    severity,
  };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

function assembleBrokenLinks(relationshipItems, referenceItems, total) {
  const countsByReason = {};
  for (const item of relationshipItems) {
    for (const reason of item.reasons) countsByReason[reason] = (countsByReason[reason] || 0) + 1;
  }
  for (const item of referenceItems) countsByReason[item.reason] = (countsByReason[item.reason] || 0) + 1;
  return {
    source_module: "traceability",
    total,
    items: [...relationshipItems, ...referenceItems],
    counts_by_reason: countsByReason,
    counts_by_severity: { ...countBy(relationshipItems, "severity"), ...countBy(referenceItems, "severity") },
  };
}

function referenceOrphans(result) {
  const rows = Array.isArray(result) ? result : result?.items || [];
  return rows.map((row) => ({
    relationship: null,
    reference: { id: row.id, reference_type: row.reference_type, context: row.context || "" },
    source: { id: row.source_object_id, code: row.source_code || null },
    target: { id: row.target_object_id ?? null, code: null },
    reasons: [row.reason === "deleted_target" ? BROKEN_LINK_REASONS.REFERENCE_TARGET_DELETED : BROKEN_LINK_REASONS.REFERENCE_TARGET_MISSING],
    severity: "WARNING",
  }));
}

export function brokenLinks(db, tenantId, options = {}, actor = null) {
  const { pageSize, offset } = pagination({ ...options, pageSize: options.pageSize || options.page_size || MAX_BROKEN_LINKS });
  const limit = Math.min(Number(pageSize) || MAX_BROKEN_LINKS, MAX_BROKEN_LINKS);
  const authorizer = Security.createNodeAuthorizer(db, actor, { tenantId, organizationId: options.organizationId ?? null, ip: options.ip ?? null, action: READ_ACTION });
  const rows = brokenRelationshipRows(db, tenantId, { limit, offset: Number(offset) || 0 }).filter(
    (row) => authorizer.allowsType(row.source_type, null) && authorizer.allowsType(row.target_type, null)
  );
  const references = referenceOrphans(objects.orphanReferences(db, tenantId, {}));
  return assembleBrokenLinks(rows.map(classifyBrokenRelationship), references, brokenRelationshipCount(db, tenantId) + references.length);
}

export async function brokenLinksAsync(db, tenantId, options = {}, actor = null) {
  const { pageSize, offset } = pagination({ ...options, pageSize: options.pageSize || options.page_size || MAX_BROKEN_LINKS });
  const limit = Math.min(Number(pageSize) || MAX_BROKEN_LINKS, MAX_BROKEN_LINKS);
  const authorizer = await Security.createNodeAuthorizerAsync(db, actor, { tenantId, organizationId: options.organizationId ?? null, ip: options.ip ?? null, action: READ_ACTION });
  const rows = await brokenRelationshipRowsAsync(db, tenantId, { limit, offset: Number(offset) || 0 });
  const visible = [];
  for (const row of rows) {
    if ((await authorizer.allowsTypeAsync(row.source_type, null)) && (await authorizer.allowsTypeAsync(row.target_type, null))) visible.push(row);
  }
  const references = referenceOrphans(await objects.orphanReferencesAsync(db, tenantId, {}));
  const total = (await brokenRelationshipCountAsync(db, tenantId)) + references.length;
  return assembleBrokenLinks(visible.map(classifyBrokenRelationship), references, total);
}

// ── Health ───────────────────────────────────────────────────────────────────
export function health(db, tenantId, actor = null) {
  const coverageResult = coverage(db, tenantId, {}, actor);
  const orphanResult = orphans(db, tenantId, {}, actor);
  const broken = brokenLinks(db, tenantId, { pageSize: 1 }, actor);
  const brokenCount = Object.values(broken.counts_by_reason).reduce((sum, n) => sum + n, 0);
  const status = brokenCount > 0 || orphanResult.total > 0 ? "DEGRADED" : "OK";
  return {
    source_module: "traceability",
    status,
    overall_coverage: coverageResult.overall_coverage,
    expected: coverageResult.expected,
    linked: coverageResult.linked,
    orphaned: orphanResult.total,
    broken_links: brokenCount,
    rules: coverageResult.rules.length,
    checked_at: nowUtc(),
  };
}

export async function healthAsync(db, tenantId, actor = null) {
  const coverageResult = await coverageAsync(db, tenantId, {}, actor);
  const orphanResult = await orphansAsync(db, tenantId, {}, actor);
  const broken = await brokenLinksAsync(db, tenantId, { pageSize: 1 }, actor);
  const brokenCount = Object.values(broken.counts_by_reason).reduce((sum, n) => sum + n, 0);
  const status = brokenCount > 0 || orphanResult.total > 0 ? "DEGRADED" : "OK";
  return {
    source_module: "traceability",
    status,
    overall_coverage: coverageResult.overall_coverage,
    expected: coverageResult.expected,
    linked: coverageResult.linked,
    orphaned: orphanResult.total,
    broken_links: brokenCount,
    rules: coverageResult.rules.length,
    checked_at: nowUtc(),
  };
}

// ── Configuration (reuses the Digital Thread configuration store) ────────────
export function listConfig(db, tenantId) {
  return Configuration.listConfig(db, tenantId);
}
export function setConfig(db, tenantId, key, value, actor, ip) {
  return Configuration.setConfig(db, tenantId, key, value, actor, ip);
}
export function listConfigAsync(db, tenantId) {
  return Configuration.listConfigAsync(db, tenantId);
}
export function setConfigAsync(db, tenantId, key, value, actor, ip) {
  return Configuration.setConfigAsync(db, tenantId, key, value, actor, ip);
}

export { Constants, Domains, Definitions, Rules };
