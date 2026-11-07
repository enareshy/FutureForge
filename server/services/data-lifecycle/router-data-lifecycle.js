// REST router for the centralized Data Lifecycle & Archival service. Built as a
// factory so it reuses the application's async auth, authorization and error
// middleware. Mounted at /api/lifecycle and /api/v1/lifecycle.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization (spec §32). The whole request
// path runs on the async `pg` layer so a slow query never stalls the process.
import {
  constants,
  Validation,
  Repository,
  States,
  Tiers,
  Policies,
  Objects,
  History,
  LegalHolds,
  Dependencies,
  Eligibility,
  Providers,
  Archive,
  Restore,
  Recovery,
  Purge,
  Configuration,
  CatalogIntegration,
  Metrics,
  Jobs,
  Foundation,
} from "./index.js";

const R = constants.LIFECYCLE_RESOURCES;

export function createDataLifecycleRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const guard = authAsync || auth;
  const gate = canAsync || can;

  const canOverview = (a) => gate(R.overview, a);
  const canStates = (a) => gate(R.states, a);
  const canPolicies = (a) => gate(R.policies, a);
  const canObjects = (a) => gate(R.objects, a);
  const canEligibility = (a) => gate(R.eligibility, a);
  const canArchive = (a) => gate(R.archive, a);
  const canRestore = (a) => gate(R.restore, a);
  const canRecovery = (a) => gate(R.recovery, a);
  const canPurge = (a) => gate(R.purge, a);
  const canLegalHolds = (a) => gate(R.legalHolds, a);
  const canDependencies = (a) => gate(R.dependencies, a);
  const canJobs = (a) => gate(R.jobs, a);
  const canMetrics = (a) => gate(R.metrics, a);
  const canAdmin = (a) => gate(R.admin, a);

  // ── Meta, health, metrics, providers ──────────────────────────────────────
  router.get(
    "/meta",
    guard,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        security_actions: constants.SECURITY_ACTIONS,
        capabilities: {
          lifecycle_states: constants.LIFECYCLE_STATES,
          data_tiers: constants.DATA_TIERS,
          retention_bases: constants.RETENTION_BASES,
          policy_scope_types: constants.POLICY_SCOPE_TYPES,
          policy_statuses: constants.POLICY_STATUSES,
          policy_actions: constants.POLICY_ACTIONS,
          legal_hold_statuses: constants.LEGAL_HOLD_STATUSES,
          legal_hold_scope_types: constants.LEGAL_HOLD_SCOPE_TYPES,
          eligibility_actions: constants.ELIGIBILITY_ACTIONS,
          eligibility_results: constants.ELIGIBILITY_RESULTS,
          dependency_results: constants.DEPENDENCY_RESULTS,
          restore_conflict_strategies: constants.RESTORE_CONFLICT_STRATEGIES,
          archive_provider_types: constants.ARCHIVE_PROVIDER_TYPES,
          job_types: constants.LIFECYCLE_JOB_TYPES.map((job) => job.code),
        },
      });
    })
  );

  router.get(
    "/health",
    guard,
    canMetrics("read"),
    wrap(async (req, res) => res.json({ ...(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })), ...(await Foundation.lifecycleHealthAsync(db, tenantOf(req))) }))
  );

  router.get(
    "/metrics",
    guard,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/providers",
    guard,
    canOverview("read"),
    wrap((_req, res) => res.json({ items: Providers.listArchiveProviders() }))
  );

  // ── States & transitions ──────────────────────────────────────────────────
  router.get(
    "/states",
    guard,
    canStates("read"),
    wrap(async (req, res) => res.json(await States.listStatesAsync(db, { tenantId: tenantOf(req), status: req.query.status, active: req.query.active })))
  );
  router.post(
    "/states",
    guard,
    canStates("create"),
    wrap(async (req, res) => res.status(201).json(await States.createStateAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/states/:code",
    guard,
    canStates("read"),
    wrap(async (req, res) => res.json(Repository.publicState(await States.requireStateAsync(db, tenantOf(req), req.params.code))))
  );
  const updateState = wrap(async (req, res) => res.json(await States.updateStateAsync(db, tenantOf(req), req.params.code, req.body || {}, req.actor, req.ip)));
  router.put("/states/:code", guard, canStates("update"), updateState);
  router.patch("/states/:code", guard, canStates("update"), updateState);
  router.get(
    "/states/:code/transitions",
    guard,
    canStates("read"),
    wrap(async (req, res) => res.json({ items: await States.allowedTransitionsAsync(db, tenantOf(req), req.params.code) }))
  );
  router.get(
    "/transitions",
    guard,
    canStates("read"),
    wrap(async (req, res) =>
      res.json({
        items: await States.listTransitionsAsync(db, {
          tenantId: tenantOf(req),
          fromState: req.query.from_state ?? req.query.fromState,
          toState: req.query.to_state ?? req.query.toState,
          status: req.query.status,
        }),
      })
    )
  );
  router.post(
    "/transitions",
    guard,
    canStates("create"),
    wrap(async (req, res) => res.status(201).json(await States.createTransitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/transitions/:id/status",
    guard,
    canStates("update"),
    wrap(async (req, res) => res.json(await States.setTransitionStatusAsync(db, tenantOf(req), req.params.id, req.body?.status, req.actor, req.ip)))
  );

  // ── Tiers ─────────────────────────────────────────────────────────────────
  router.get(
    "/tiers",
    guard,
    canStates("read"),
    wrap(async (req, res) => res.json(await Tiers.listTierPoliciesAsync(db, { tenantId: tenantOf(req) })))
  );
  router.put(
    "/tiers/:stateCode",
    guard,
    canStates("update"),
    wrap(async (req, res) => res.json(await Tiers.setTierPolicyAsync(db, tenantOf(req), req.params.stateCode, req.body?.data_tier ?? req.body?.dataTier, { description: req.body?.description, actor: req.actor, ip: req.ip })))
  );

  // ── Retention policies ────────────────────────────────────────────────────
  router.get(
    "/policies",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json(await Policies.listPoliciesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/policies",
    guard,
    canPolicies("create"),
    wrap(async (req, res) => res.status(201).json(await Policies.createPolicyAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/policies/resolve",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(await Policies.resolvePolicyAsync(db, { ...body, tenantId: tenantOf(req) }));
    })
  );
  router.get(
    "/policies/:ref/versions",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json({ items: await Policies.listPolicyVersionsAsync(db, tenantOf(req), req.params.ref) }))
  );
  router.get(
    "/policies/:ref",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json(await Policies.getPolicyAsync(db, tenantOf(req), req.params.ref)))
  );
  const updatePolicy = wrap(async (req, res) => res.json(await Policies.updatePolicyAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/policies/:ref", guard, canPolicies("update"), updatePolicy);
  router.patch("/policies/:ref", guard, canPolicies("update"), updatePolicy);
  router.post(
    "/policies/:ref/status",
    guard,
    canPolicies("update"),
    wrap(async (req, res) => res.json(await Policies.setPolicyStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Tracked objects (lifecycle ledger) ────────────────────────────────────
  router.get(
    "/objects",
    guard,
    canObjects("read"),
    wrap(async (req, res) => res.json(await Objects.listObjectLifecyclesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/objects",
    guard,
    canObjects("create"),
    wrap(async (req, res) => res.status(201).json(await Objects.registerObjectLifecycleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/objects/:objectType/:objectId/snapshot",
    guard,
    canObjects("read"),
    wrap(async (req, res) =>
      res.json(
        await CatalogIntegration.lifecycleSnapshotAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          domainId: req.query.domain_id ?? req.query.domainId,
          includeOwnership: req.query.include_ownership !== "false",
        })
      )
    )
  );
  router.get(
    "/objects/:objectType/:objectId/history",
    guard,
    canObjects("read"),
    wrap(async (req, res) =>
      res.json(
        await History.listHistoryAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          action: req.query.action,
          page: req.query.page,
          pageSize: req.query.page_size ?? req.query.pageSize,
        })
      )
    )
  );
  router.get(
    "/objects/:objectType/:objectId/dependencies",
    guard,
    canDependencies("read"),
    wrap(async (req, res) =>
      res.json({
        items: (
          await Dependencies.listDependenciesAsync(db, {
            tenantId: tenantOf(req),
            objectType: req.params.objectType,
            objectId: req.params.objectId,
            status: req.query.status,
            result: req.query.result,
          })
        ).items,
      })
    )
  );
  router.get(
    "/objects/:objectType/:objectId/eligibility",
    guard,
    canEligibility("read"),
    wrap(async (req, res) =>
      res.json(
        await Eligibility.evaluateEligibilityAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          action: req.query.action,
          force: req.query.force === "true",
        })
      )
    )
  );
  router.get(
    "/objects/:objectType/:objectId",
    guard,
    canObjects("read"),
    wrap(async (req, res) => res.json(await Objects.getObjectLifecycleAsync(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );
  router.post(
    "/objects/:objectType/:objectId/state",
    guard,
    canObjects("execute"),
    wrap(async (req, res) =>
      res.json(
        await Objects.changeStateAsync(db, tenantOf(req), req.params.objectType, req.params.objectId, req.body?.to_state ?? req.body?.state, {
          reason: req.body?.reason || "",
          actor: req.actor,
          ip: req.ip,
          force: Boolean(req.body?.force),
        })
      )
    )
  );
  router.post(
    "/objects/:objectType/:objectId/retention",
    guard,
    canObjects("execute"),
    wrap(async (req, res) =>
      res.json(
        await Objects.applyRetentionAsync(db, tenantOf(req), req.params.objectType, req.params.objectId, {
          anchor: req.body?.anchor ?? req.body?.anchor_date ?? null,
          basis: req.body?.basis ?? req.body?.retention_basis ?? null,
          actor: req.actor,
        })
      )
    )
  );
  router.post(
    "/objects/:objectType/:objectId/tier",
    guard,
    canObjects("execute"),
    wrap(async (req, res) => res.json(await Objects.setObjectTierAsync(db, tenantOf(req), req.params.objectType, req.params.objectId, req.body?.data_tier ?? req.body?.dataTier, { actor: req.actor, ip: req.ip })))
  );

  // ── Eligibility engine ────────────────────────────────────────────────────
  router.post(
    "/eligibility/check",
    guard,
    canEligibility("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await Eligibility.evaluateEligibilityAsync(db, {
          tenantId: tenantOf(req),
          objectType: body.object_type ?? body.objectType,
          objectId: body.object_id ?? body.objectId,
          action: body.action,
          force: Boolean(body.force),
        })
      );
    })
  );
  router.post(
    "/eligibility/batch",
    guard,
    canEligibility("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(await Eligibility.evaluateBatchAsync(db, { tenantId: tenantOf(req), objects: body.objects || [], action: body.action, force: Boolean(body.force) }));
    })
  );
  router.get(
    "/eligibility/due",
    guard,
    canEligibility("read"),
    wrap(async (req, res) => res.json(await Eligibility.listDueObjectsAsync(db, { tenantId: tenantOf(req), action: req.query.action, limit: req.query.limit })))
  );

  // ── Legal holds ───────────────────────────────────────────────────────────
  router.get(
    "/legal-holds",
    guard,
    canLegalHolds("read"),
    wrap(async (req, res) => res.json(await LegalHolds.listLegalHoldsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/legal-holds",
    guard,
    canLegalHolds("create"),
    wrap(async (req, res) => res.status(201).json(await LegalHolds.createLegalHoldAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/legal-holds/:ref",
    guard,
    canLegalHolds("read"),
    wrap(async (req, res) => res.json(await LegalHolds.getLegalHoldAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/legal-holds/:ref/release",
    guard,
    canLegalHolds("execute"),
    wrap(async (req, res) => res.json(await LegalHolds.releaseLegalHoldAsync(db, tenantOf(req), req.params.ref, { reason: req.body?.reason || "", actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/legal-holds/:ref/cancel",
    guard,
    canLegalHolds("execute"),
    wrap(async (req, res) => res.json(await LegalHolds.cancelLegalHoldAsync(db, tenantOf(req), req.params.ref, { reason: req.body?.reason || "", actor: req.actor, ip: req.ip })))
  );

  // ── Dependencies ──────────────────────────────────────────────────────────
  router.get(
    "/dependencies",
    guard,
    canDependencies("read"),
    wrap(async (req, res) => res.json(await Dependencies.listDependenciesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/dependencies",
    guard,
    canDependencies("create"),
    wrap(async (req, res) => res.status(201).json(await Dependencies.recordDependencyAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/dependencies/refresh",
    guard,
    canDependencies("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(await Dependencies.refreshDependenciesAsync(db, { tenantId: tenantOf(req), objectType: body.object_type ?? body.objectType, objectId: body.object_id ?? body.objectId, actor: req.actor }));
    })
  );
  router.post(
    "/dependencies/:id/resolve",
    guard,
    canDependencies("execute"),
    wrap(async (req, res) => res.json(await Dependencies.resolveDependencyAsync(db, tenantOf(req), req.params.id, req.actor, req.ip)))
  );

  // ── Archive & cold storage ────────────────────────────────────────────────
  router.get(
    "/archives",
    guard,
    canArchive("read"),
    wrap(async (req, res) => res.json(await Archive.listArchiveRecordsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/archives",
    guard,
    canArchive("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Archive.archiveObjectAsync(db, {
        tenantId: tenantOf(req),
        objectType: body.object_type ?? body.objectType,
        objectId: body.object_id ?? body.objectId,
        reason: body.reason || "",
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
        force: Boolean(body.force),
        providerCode: body.provider_code ?? body.providerCode ?? null,
        businessMetadata: body.business_metadata ?? body.businessMetadata ?? {},
      });
      res.status(201).json(result);
    })
  );
  router.get(
    "/archives/:ref",
    guard,
    canArchive("read"),
    wrap(async (req, res) => res.json(await Archive.getArchiveRecordAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/archives/:ref/verify",
    guard,
    canArchive("execute"),
    wrap(async (req, res) => res.json(await Archive.verifyArchiveIntegrityAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/objects/:objectType/:objectId/cold-storage",
    guard,
    canArchive("execute"),
    wrap(async (req, res) =>
      res.json(
        await Archive.moveToColdStorageAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          reason: req.body?.reason || "",
          actor: req.actor,
          ip: req.ip,
          force: Boolean(req.body?.force),
        })
      )
    )
  );
  router.post(
    "/objects/:objectType/:objectId/archive",
    guard,
    canArchive("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Archive.archiveObjectAsync(db, {
        tenantId: tenantOf(req),
        objectType: req.params.objectType,
        objectId: req.params.objectId,
        reason: body.reason || "",
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
        force: Boolean(body.force),
        providerCode: body.provider_code ?? body.providerCode ?? null,
        businessMetadata: body.business_metadata ?? body.businessMetadata ?? {},
      });
      res.status(201).json(result);
    })
  );

  // ── Restore ───────────────────────────────────────────────────────────────
  router.get(
    "/restores",
    guard,
    canRestore("read"),
    wrap(async (req, res) => res.json(await Restore.listRestoreRecordsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/restores",
    guard,
    canRestore("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(201).json(
        await Restore.requestRestoreAsync(db, {
          tenantId: tenantOf(req),
          archiveRef: body.archive_ref ?? body.archiveRef ?? null,
          objectType: body.object_type ?? body.objectType,
          objectId: body.object_id ?? body.objectId,
          targetState: body.target_state ?? body.targetState ?? null,
          conflictStrategy: body.conflict_strategy ?? body.conflictStrategy ?? "FAIL",
          actor: req.actor,
          ip: req.ip,
          idempotencyKey: idem(req),
        })
      );
    })
  );
  router.get(
    "/restores/:ref",
    guard,
    canRestore("read"),
    wrap(async (req, res) => res.json(await Restore.getRestoreRecordAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/restores/:ref/execute",
    guard,
    canRestore("execute"),
    wrap(async (req, res) => res.json(await Restore.executeRestoreAsync(db, { tenantId: tenantOf(req), restoreRef: req.params.ref, actor: req.actor, ip: req.ip, force: Boolean(req.body?.force) })))
  );
  router.post(
    "/objects/:objectType/:objectId/restore",
    guard,
    canRestore("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Restore.restoreObjectAsync(db, {
        tenantId: tenantOf(req),
        objectType: req.params.objectType,
        objectId: req.params.objectId,
        conflictStrategy: body.conflict_strategy ?? body.conflictStrategy ?? "FAIL",
        targetState: body.target_state ?? body.targetState ?? null,
        reason: body.reason || "",
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
        force: Boolean(body.force),
      });
      res.json(result);
    })
  );

  // ── Purge ─────────────────────────────────────────────────────────────────
  router.get(
    "/purges",
    guard,
    canPurge("read"),
    wrap(async (req, res) => res.json(await Purge.listPurgeRecordsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/purges/summary",
    guard,
    canPurge("read"),
    wrap(async (req, res) => res.json(await Purge.purgeSummaryAsync(db, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/purges/evaluate",
    guard,
    canPurge("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(await Purge.evaluatePurgeEligibilityAsync(db, { tenantId: tenantOf(req), objectType: body.object_type ?? body.objectType, objectId: body.object_id ?? body.objectId, force: Boolean(body.force) }));
    })
  );
  router.post(
    "/purges",
    guard,
    canPurge("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Purge.executePurgeAsync(db, {
        tenantId: tenantOf(req),
        objectType: body.object_type ?? body.objectType,
        objectId: body.object_id ?? body.objectId,
        reason: body.reason || "",
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
        force: Boolean(body.force),
      });
      res.status(201).json(result);
    })
  );
  router.get(
    "/purges/:ref",
    guard,
    canPurge("read"),
    wrap(async (req, res) => res.json(await Purge.getPurgeRecordAsync(db, tenantOf(req), req.params.ref)))
  );

  // ── Recovery ──────────────────────────────────────────────────────────────
  router.get(
    "/recoveries",
    guard,
    canRecovery("read"),
    wrap(async (req, res) => res.json(await Recovery.listRecoveryRecordsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/recoveries",
    guard,
    canRecovery("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(201).json(
        await Recovery.requestRecoveryAsync(db, {
          tenantId: tenantOf(req),
          providerCode: body.provider_code ?? body.providerCode ?? null,
          recoveryPointRef: body.recovery_point_ref ?? body.recoveryPointRef ?? "",
          scope: body.scope || "",
          objectType: body.object_type ?? body.objectType ?? "",
          objectId: body.object_id ?? body.objectId ?? null,
          details: body.details || {},
          actor: req.actor,
          ip: req.ip,
        })
      );
    })
  );
  router.get(
    "/recoveries/:ref",
    guard,
    canRecovery("read"),
    wrap(async (req, res) => res.json(await Recovery.getRecoveryRecordAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/recoveries/:ref/execute",
    guard,
    canRecovery("execute"),
    wrap(async (req, res) => res.json(await Recovery.executeRecoveryAsync(db, { tenantId: tenantOf(req), recoveryRef: req.params.ref, actor: req.actor, ip: req.ip })))
  );

  // ── History ───────────────────────────────────────────────────────────────
  router.get(
    "/history",
    guard,
    canObjects("read"),
    wrap(async (req, res) => res.json(await History.listHistoryAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );

  // ── Catalog integration ───────────────────────────────────────────────────
  router.get(
    "/catalog-types",
    guard,
    canOverview("read"),
    wrap(async (req, res) => res.json({ items: await CatalogIntegration.lifecycleAwareTypesAsync(db, { tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/snapshots",
    guard,
    canOverview("read"),
    wrap(async (req, res) => res.json(await CatalogIntegration.bulkLifecycleSnapshotsAsync(db, { tenantId: tenantOf(req), objects: req.body?.objects || [] })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/configuration",
    guard,
    canAdmin("read"),
    wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req))))
  );
  router.put(
    "/configuration/:key",
    guard,
    canAdmin("update"),
    wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.get(
    "/jobs",
    guard,
    canJobs("read"),
    wrap(async (req, res) => res.json(await Jobs.listLifecycleJobsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/jobs/evaluate",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(await Jobs.submitEvaluationJobAsync(db, { tenantId: tenantOf(req), actions: body.actions, limit: body.limit, apply: Boolean(body.apply), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/archive",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(await Jobs.submitArchiveJobAsync(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, force: Boolean(body.force), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/cold-storage",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(await Jobs.submitColdStorageJobAsync(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/restore",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(await Jobs.submitRestoreJobAsync(db, { tenantId: tenantOf(req), objects: body.objects || null, restoreRef: body.restore_ref ?? body.restoreRef ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/purge",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(await Jobs.submitPurgeJobAsync(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, force: Boolean(body.force), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/recovery",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(202).json(
        await Jobs.submitRecoveryJobAsync(db, {
          tenantId: tenantOf(req),
          objectType: body.object_type ?? body.objectType ?? "",
          objectId: body.object_id ?? body.objectId ?? null,
          recoveryPointRef: body.recovery_point_ref ?? body.recoveryPointRef ?? "",
          scope: body.scope || "",
          actor: req.actor,
          ip: req.ip,
          idempotencyKey: idem(req),
        })
      );
    })
  );
  router.post(
    "/jobs/maintenance",
    guard,
    canJobs("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip })))
  );
  router.get(
    "/jobs/:ref",
    guard,
    canJobs("read"),
    wrap(async (req, res) => {
      const job = await Jobs.getLifecycleJobAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Lifecycle job not found", details: { ref: req.params.ref } });
      res.json(job);
    })
  );

  return router;
}
