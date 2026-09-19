// EffectivityResolver — the deterministic as-of resolution engine.
//
// Orchestrates ContextValidator -> CandidateSelector -> ConflictDetector /
// ResolutionRuleEngine -> version selection, records every resolution in
// versioning_resolution_results for audit and metrics, and exposes the stable
// `resolve` / `resolveBulk` SDK used by BOM, PDM and Manufacturing.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import {
  publicRevision,
  publicVersion,
  contextCacheKey,
  safeParse,
  normalizeText,
} from "./validation.js";
import { resultRef } from "./refs.js";
import { ContextValidator } from "./resolution/context.js";
import { buildCandidates, loadCandidateDataset } from "./resolution/candidates.js";
import { ResolutionRuleEngine } from "./resolution/rule-engine.js";
import { ConflictDetector } from "./resolution/conflicts.js";
import { resolvePolicy } from "./policies.js";
import { defaultVersionForRevision } from "./versions.js";

function fallbackRevisionFor(db, objectType, objectId, revisions) {
  const pool = revisions.filter((r) => String(r.object_id) === String(objectId));
  const preferred = pool.find((r) => r.is_default && r.status !== "archived") ?? null;
  if (preferred) return preferred;
  const active = pool.filter((r) => r.status === "active");
  if (active.length === 1) return active[0];
  return null;
}

function defaultPolicy() {
  return null;
}

function selectVersion(db, winner, context) {
  const revision = winner.revision;
  if (!revision) return null;
  if (winner.versionId) {
    const explicit = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ? AND revision_id = ?", [
      Number(winner.versionId),
      revision.id,
    ]);
    if (explicit) return explicit;
  }
  if (context.versionId) {
    const explicit = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ? AND revision_id = ?", [
      Number(context.versionId),
      revision.id,
    ]);
    if (explicit) return explicit;
  }
  return defaultVersionForRevision(db, revision.id);
}

function buildResult({ objectType, objectId, context, policy, decision, version, durationMs, cacheKey }) {
  const revision = decision.winner?.revision ?? null;
  const revisionId = revision ? revision.revision_ref : null;
  const versionId = version ? version.version_ref : null;
  const matchedDate = decision.winner?.reasons?.find((r) => r.dimension === "date" && !r.intrinsic);
  const effectiveFrom = matchedDate?.from ?? revision?.effective_from ?? null;
  const effectiveTo = matchedDate?.to ?? revision?.effective_to ?? null;
  const status = decision.status;
  let message = "";
  if (status === "RESOLVED") message = `Resolved to revision ${revision?.revision_code ?? "?"}`;
  else if (status === "AMBIGUOUS") message = "Multiple revisions matched and no rule could select one";
  else if (status === "CONFLICT") message = "Conflicting effectivity assignments match the context";
  else if (status === "INVALID_CONTEXT") message = "The supplied effectivity context is invalid";
  else message = "No revision is effective for the supplied context";
  return {
    objectType,
    objectId,
    revisionId,
    versionId,
    revisionCode: revision?.revision_code ?? null,
    versionNumber: version?.version_number ?? null,
    effectiveFrom,
    effectiveTo,
    resolutionReason: decision.reason ?? "NO_APPLICABLE_REVISION",
    resolutionStatus: status,
    code: decision.reason ?? "NO_APPLICABLE_REVISION",
    dimension: decision.dimension ?? null,
    policy: policy?.code ?? "builtin_default",
    message,
    candidates: decision.scored ?? [],
    conflicts: decision.conflicts ?? [],
    durationMs,
    cacheKey,
    revision: revision ? publicRevision(revision) : null,
    version: version ? publicVersion(version) : null,
  };
}

function recordResolution(db, result, { actor, tenantId, requestId, correlationId }) {
  try {
    run(
      db,
      `INSERT INTO versioning_resolution_results
        (result_ref, object_type, object_id, policy_code, context_hash, context_json, status, revision_id, version_id,
         resolution_reason, candidate_scores_json, message, duration_ms, resolved_by, tenant_id, request_id, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resultRef(),
        result.objectType,
        result.objectId,
        result.policy,
        result.cacheKey ?? "",
        JSON.stringify(result.context ?? {}),
        result.resolutionStatus,
        result.revision?.id ?? null,
        result.version?.id ?? null,
        result.resolutionReason,
        JSON.stringify(result.candidates ?? []),
        result.message,
        result.durationMs,
        actor?.id ?? null,
        tenantId ?? null,
        requestId ?? null,
        correlationId ?? null,
        nowIso(),
      ]
    );
  } catch {
    // Resolution must never fail because bookkeeping failed.
  }
}

function resolveOne(db, { objectType, objectId, rawContext, policyRow, actor, tenantId, requestId, correlationId, dataset, record = true }) {
  const started = Date.now();
  const contextResult = ContextValidator.validate(db, rawContext);
  if (!contextResult.valid) {
    const result = buildResult({
      objectType,
      objectId,
      context: {},
      policy: policyRow,
      decision: { status: "INVALID_CONTEXT", winner: null, reason: "INVALID_EFFECTIVITY_CONTEXT", scored: [], conflicts: [] },
      version: null,
      durationMs: Date.now() - started,
      cacheKey: null,
    });
    result.context = rawContext;
    result.errors = contextResult.errors;
    result.message = contextResult.errors.join("; ");
    if (record) recordResolution(db, result, { actor, tenantId, requestId, correlationId });
    return result;
  }

  const context = contextResult.context;
  const effectiveTenant = tenantId ?? context.tenantId ?? null;
  const data = dataset ?? loadCandidateDataset(db, { objectType, objectIds: [objectId], tenantId: effectiveTenant });
  const built = buildCandidates(db, { objectType, objectId, context, dataset: data });
  const revisions = data.revisions;

  const noDiscriminators = ContextValidator.isEmpty(context);
  const emptyFallback = noDiscriminators || built.candidates.length === 0
    ? fallbackRevisionFor(db, objectType, objectId, revisions)
    : null;
  const fallback = policyRow.fallback_to_default ? emptyFallback : built.candidates.length === 0 ? emptyFallback : null;

  const decision = ResolutionRuleEngine.evaluate(built.candidates, {
    policy: policyRow,
    fallbackRevision: fallback,
  });

  if (decision.status === "RESOLVED" && decision.winner) {
    const recheck = ConflictDetector.detect([decision.winner], { allowOverlap: Boolean(policyRow.allow_overlap) });
    if (recheck.conflicting) {
      decision.status = "CONFLICT";
      decision.reason = "EFFECTIVITY_CONFLICT";
      decision.conflicts = recheck.conflicts;
      decision.winner = null;
    }
  }

  const version = decision.status === "RESOLVED" ? selectVersion(db, decision.winner, context) : null;
  const result = buildResult({
    objectType,
    objectId,
    context,
    policy: policyRow,
    decision,
    version,
    durationMs: Date.now() - started,
    cacheKey: contextCacheKey(objectType, objectId, context, policyRow.code),
  });
  result.context = context;
  if (record) recordResolution(db, result, { actor, tenantId: effectiveTenant, requestId, correlationId });
  return result;
}

export const EffectivityResolver = {
  resolve(db, input = {}, options = {}) {
    const objectType = normalizeText(input.objectType ?? input.object_type);
    const objectId = normalizeText(input.objectId ?? input.object_id);
    if (!objectType || !objectId) {
      return buildResult({
        objectType,
        objectId,
        context: {},
        policy: resolvePolicy(db, input.policy ?? input.policyCode),
        decision: { status: "INVALID_CONTEXT", winner: null, reason: "INVALID_EFFECTIVITY_CONTEXT", scored: [], conflicts: [] },
        version: null,
        durationMs: 0,
        cacheKey: null,
      });
    }
    const policyRow = resolvePolicy(db, input.policy ?? input.policyCode ?? options.policy);
    return resolveOne(db, {
      objectType,
      objectId,
      rawContext: input.context ?? input.effectivityContext ?? {},
      policyRow,
      actor: options.actor ?? null,
      tenantId: options.tenantId ?? null,
      requestId: options.requestId ?? null,
      correlationId: options.correlationId ?? null,
      record: options.record !== false,
    });
  },

  resolveBulk(db, input = {}, options = {}) {
    const context = input.context ?? input.effectivityContext ?? {};
    const policyRow = resolvePolicy(db, input.policy ?? input.policyCode ?? options.policy);
    const objects = Array.isArray(input.objects) ? input.objects : [];
    const grouped = new Map();
    const normalized = objects.map((entry) => {
      const objectType = normalizeText(entry.objectType ?? entry.object_type);
      const objectId = normalizeText(entry.objectId ?? entry.object_id ?? entry.id);
      return { objectType, objectId, entry };
    });
    for (const item of normalized) {
      if (!item.objectType || !item.objectId) continue;
      if (!grouped.has(item.objectType)) grouped.set(item.objectType, new Set());
      grouped.get(item.objectType).add(item.objectId);
    }
    const contextResult = ContextValidator.validate(db, context);
    const effectiveTenant = options.tenantId ?? contextResult.context?.tenantId ?? null;
    const datasets = new Map();
    const started = Date.now();
    for (const [objectType, idSet] of grouped.entries()) {
      datasets.set(objectType, loadCandidateDataset(db, { objectType, objectIds: [...idSet], tenantId: effectiveTenant }));
    }
    const results = normalized.map((item) => {
      if (!item.objectType || !item.objectId) {
        return { objectType: item.objectType, objectId: item.objectId, resolutionStatus: "INVALID_CONTEXT", resolutionReason: "MISSING_OBJECT", message: "objectType and objectId are required" };
      }
      const perItemContext = item.entry.context ? { ...context, ...item.entry.context } : context;
      return resolveOne(db, {
        objectType: item.objectType,
        objectId: item.objectId,
        rawContext: perItemContext,
        policyRow,
        actor: options.actor ?? null,
        tenantId: options.tenantId ?? null,
        requestId: options.requestId ?? null,
        correlationId: options.correlationId ?? null,
        dataset: datasets.get(item.objectType),
        record: options.record !== false,
      });
    });
    return {
      results,
      count: results.length,
      resolved: results.filter((r) => r.resolutionStatus === "RESOLVED").length,
      duration_ms: Date.now() - started,
      policy: policyRow.code,
    };
  },
};

export { resolveOne };
