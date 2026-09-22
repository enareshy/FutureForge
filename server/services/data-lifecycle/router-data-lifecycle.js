// REST router for the centralized Data Lifecycle & Archival service. Built as a
// factory so it reuses the application's auth, authorization and error
// middleware. Mounted at /api/lifecycle and /api/v1/lifecycle.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization (spec §32).
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

export function createDataLifecycleRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => can(R.overview, a);
  const canStates = (a) => can(R.states, a);
  const canPolicies = (a) => can(R.policies, a);
  const canObjects = (a) => can(R.objects, a);
  const canEligibility = (a) => can(R.eligibility, a);
  const canArchive = (a) => can(R.archive, a);
  const canRestore = (a) => can(R.restore, a);
  const canRecovery = (a) => can(R.recovery, a);
  const canPurge = (a) => can(R.purge, a);
  const canLegalHolds = (a) => can(R.legalHolds, a);
  const canDependencies = (a) => can(R.dependencies, a);
  const canJobs = (a) => can(R.jobs, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  // ── Meta, health, metrics, providers ──────────────────────────────────────
  router.get(
    "/meta",
    auth,
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
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Metrics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.lifecycleHealth(db, tenantOf(req)) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/providers",
    auth,
    canOverview("read"),
    wrap((_req, res) => res.json({ items: Providers.listArchiveProviders() }))
  );

  // ── States & transitions ──────────────────────────────────────────────────
  router.get(
    "/states",
    auth,
    canStates("read"),
    wrap((req, res) => res.json(States.listStates(db, { tenantId: tenantOf(req), status: req.query.status, active: req.query.active })))
  );
  router.post(
    "/states",
    auth,
    canStates("create"),
    wrap((req, res) => res.status(201).json(States.createState(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/states/:code",
    auth,
    canStates("read"),
    wrap((req, res) => res.json(Repository.publicState(States.requireState(db, tenantOf(req), req.params.code))))
  );
  const updateState = wrap((req, res) => res.json(States.updateState(db, tenantOf(req), req.params.code, req.body || {}, req.actor, req.ip)));
  router.put("/states/:code", auth, canStates("update"), updateState);
  router.patch("/states/:code", auth, canStates("update"), updateState);
  router.get(
    "/states/:code/transitions",
    auth,
    canStates("read"),
    wrap((req, res) => res.json({ items: States.allowedTransitions(db, tenantOf(req), req.params.code) }))
  );
  router.get(
    "/transitions",
    auth,
    canStates("read"),
    wrap((req, res) =>
      res.json({
        items: States.listTransitions(db, {
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
    auth,
    canStates("create"),
    wrap((req, res) => res.status(201).json(States.createTransition(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/transitions/:id/status",
    auth,
    canStates("update"),
    wrap((req, res) => res.json(States.setTransitionStatus(db, tenantOf(req), req.params.id, req.body?.status, req.actor, req.ip)))
  );

  // ── Tiers ─────────────────────────────────────────────────────────────────
  router.get(
    "/tiers",
    auth,
    canStates("read"),
    wrap((req, res) => res.json(Tiers.listTierPolicies(db, { tenantId: tenantOf(req) })))
  );
  router.put(
    "/tiers/:stateCode",
    auth,
    canStates("update"),
    wrap((req, res) => res.json(Tiers.setTierPolicy(db, tenantOf(req), req.params.stateCode, req.body?.data_tier ?? req.body?.dataTier, { description: req.body?.description, actor: req.actor, ip: req.ip })))
  );

  // ── Retention policies ────────────────────────────────────────────────────
  router.get(
    "/policies",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json(Policies.listPolicies(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/policies",
    auth,
    canPolicies("create"),
    wrap((req, res) => res.status(201).json(Policies.createPolicy(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/policies/resolve",
    auth,
    canPolicies("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(Policies.resolvePolicy(db, { ...body, tenantId: tenantOf(req) }));
    })
  );
  router.get(
    "/policies/:ref/versions",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json({ items: Policies.listPolicyVersions(db, tenantOf(req), req.params.ref) }))
  );
  router.get(
    "/policies/:ref",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json(Policies.getPolicy(db, tenantOf(req), req.params.ref)))
  );
  const updatePolicy = wrap((req, res) => res.json(Policies.updatePolicy(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/policies/:ref", auth, canPolicies("update"), updatePolicy);
  router.patch("/policies/:ref", auth, canPolicies("update"), updatePolicy);
  router.post(
    "/policies/:ref/status",
    auth,
    canPolicies("update"),
    wrap((req, res) => res.json(Policies.setPolicyStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Tracked objects (lifecycle ledger) ────────────────────────────────────
  router.get(
    "/objects",
    auth,
    canObjects("read"),
    wrap((req, res) => res.json(Objects.listObjectLifecycles(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/objects",
    auth,
    canObjects("create"),
    wrap((req, res) => res.status(201).json(Objects.registerObjectLifecycle(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/objects/:objectType/:objectId/snapshot",
    auth,
    canObjects("read"),
    wrap((req, res) =>
      res.json(
        CatalogIntegration.lifecycleSnapshot(db, {
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
    auth,
    canObjects("read"),
    wrap((req, res) =>
      res.json(
        History.listHistory(db, {
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
    auth,
    canDependencies("read"),
    wrap((req, res) =>
      res.json({
        items: Dependencies.listDependencies(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          status: req.query.status,
          result: req.query.result,
        }).items,
      })
    )
  );
  router.get(
    "/objects/:objectType/:objectId/eligibility",
    auth,
    canEligibility("read"),
    wrap((req, res) =>
      res.json(
        Eligibility.evaluateEligibility(db, {
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
    auth,
    canObjects("read"),
    wrap((req, res) => res.json(Objects.getObjectLifecycle(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );
  router.post(
    "/objects/:objectType/:objectId/state",
    auth,
    canObjects("execute"),
    wrap((req, res) =>
      res.json(
        Objects.changeState(db, tenantOf(req), req.params.objectType, req.params.objectId, req.body?.to_state ?? req.body?.state, {
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
    auth,
    canObjects("execute"),
    wrap((req, res) =>
      res.json(
        Objects.applyRetention(db, tenantOf(req), req.params.objectType, req.params.objectId, {
          anchor: req.body?.anchor ?? req.body?.anchor_date ?? null,
          basis: req.body?.basis ?? req.body?.retention_basis ?? null,
          actor: req.actor,
        })
      )
    )
  );
  router.post(
    "/objects/:objectType/:objectId/tier",
    auth,
    canObjects("execute"),
    wrap((req, res) => res.json(Objects.setObjectTier(db, tenantOf(req), req.params.objectType, req.params.objectId, req.body?.data_tier ?? req.body?.dataTier, { actor: req.actor, ip: req.ip })))
  );

  // ── Eligibility engine ────────────────────────────────────────────────────
  router.post(
    "/eligibility/check",
    auth,
    canEligibility("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        Eligibility.evaluateEligibility(db, {
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
    auth,
    canEligibility("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(Eligibility.evaluateBatch(db, { tenantId: tenantOf(req), objects: body.objects || [], action: body.action, force: Boolean(body.force) }));
    })
  );
  router.get(
    "/eligibility/due",
    auth,
    canEligibility("read"),
    wrap((req, res) => res.json(Eligibility.listDueObjects(db, { tenantId: tenantOf(req), action: req.query.action, limit: req.query.limit })))
  );

  // ── Legal holds ───────────────────────────────────────────────────────────
  router.get(
    "/legal-holds",
    auth,
    canLegalHolds("read"),
    wrap((req, res) => res.json(LegalHolds.listLegalHolds(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/legal-holds",
    auth,
    canLegalHolds("create"),
    wrap((req, res) => res.status(201).json(LegalHolds.createLegalHold(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/legal-holds/:ref",
    auth,
    canLegalHolds("read"),
    wrap((req, res) => res.json(LegalHolds.getLegalHold(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/legal-holds/:ref/release",
    auth,
    canLegalHolds("execute"),
    wrap((req, res) => res.json(LegalHolds.releaseLegalHold(db, tenantOf(req), req.params.ref, { reason: req.body?.reason || "", actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/legal-holds/:ref/cancel",
    auth,
    canLegalHolds("execute"),
    wrap((req, res) => res.json(LegalHolds.cancelLegalHold(db, tenantOf(req), req.params.ref, { reason: req.body?.reason || "", actor: req.actor, ip: req.ip })))
  );

  // ── Dependencies ──────────────────────────────────────────────────────────
  router.get(
    "/dependencies",
    auth,
    canDependencies("read"),
    wrap((req, res) => res.json(Dependencies.listDependencies(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/dependencies",
    auth,
    canDependencies("create"),
    wrap((req, res) => res.status(201).json(Dependencies.recordDependency(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/dependencies/refresh",
    auth,
    canDependencies("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(Dependencies.refreshDependencies(db, { tenantId: tenantOf(req), objectType: body.object_type ?? body.objectType, objectId: body.object_id ?? body.objectId, actor: req.actor }));
    })
  );
  router.post(
    "/dependencies/:id/resolve",
    auth,
    canDependencies("execute"),
    wrap((req, res) => res.json(Dependencies.resolveDependency(db, tenantOf(req), req.params.id, req.actor, req.ip)))
  );

  // ── Archive & cold storage ────────────────────────────────────────────────
  router.get(
    "/archives",
    auth,
    canArchive("read"),
    wrap((req, res) => res.json(Archive.listArchiveRecords(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/archives",
    auth,
    canArchive("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Archive.archiveObject(db, {
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
    auth,
    canArchive("read"),
    wrap((req, res) => res.json(Archive.getArchiveRecord(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/archives/:ref/verify",
    auth,
    canArchive("execute"),
    wrap(async (req, res) => res.json(await Archive.verifyArchiveIntegrity(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/objects/:objectType/:objectId/cold-storage",
    auth,
    canArchive("execute"),
    wrap((req, res) =>
      res.json(
        Archive.moveToColdStorage(db, {
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
    auth,
    canArchive("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Archive.archiveObject(db, {
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
    auth,
    canRestore("read"),
    wrap((req, res) => res.json(Restore.listRestoreRecords(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/restores",
    auth,
    canRestore("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(201).json(
        Restore.requestRestore(db, {
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
    auth,
    canRestore("read"),
    wrap((req, res) => res.json(Restore.getRestoreRecord(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/restores/:ref/execute",
    auth,
    canRestore("execute"),
    wrap(async (req, res) => res.json(await Restore.executeRestore(db, { tenantId: tenantOf(req), restoreRef: req.params.ref, actor: req.actor, ip: req.ip, force: Boolean(req.body?.force) })))
  );
  router.post(
    "/objects/:objectType/:objectId/restore",
    auth,
    canRestore("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Restore.restoreObject(db, {
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
    auth,
    canPurge("read"),
    wrap((req, res) => res.json(Purge.listPurgeRecords(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/purges/summary",
    auth,
    canPurge("read"),
    wrap((req, res) => res.json(Purge.purgeSummary(db, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/purges/evaluate",
    auth,
    canPurge("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(Purge.evaluatePurgeEligibility(db, { tenantId: tenantOf(req), objectType: body.object_type ?? body.objectType, objectId: body.object_id ?? body.objectId, force: Boolean(body.force) }));
    })
  );
  router.post(
    "/purges",
    auth,
    canPurge("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Purge.executePurge(db, {
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
    auth,
    canPurge("read"),
    wrap((req, res) => res.json(Purge.getPurgeRecord(db, tenantOf(req), req.params.ref)))
  );

  // ── Recovery ──────────────────────────────────────────────────────────────
  router.get(
    "/recoveries",
    auth,
    canRecovery("read"),
    wrap((req, res) => res.json(Recovery.listRecoveryRecords(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/recoveries",
    auth,
    canRecovery("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(201).json(
        Recovery.requestRecovery(db, {
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
    auth,
    canRecovery("read"),
    wrap((req, res) => res.json(Recovery.getRecoveryRecord(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/recoveries/:ref/execute",
    auth,
    canRecovery("execute"),
    wrap(async (req, res) => res.json(await Recovery.executeRecovery(db, { tenantId: tenantOf(req), recoveryRef: req.params.ref, actor: req.actor, ip: req.ip })))
  );

  // ── History ───────────────────────────────────────────────────────────────
  router.get(
    "/history",
    auth,
    canObjects("read"),
    wrap((req, res) => res.json(History.listHistory(db, { ...req.query, tenantId: tenantOf(req) })))
  );

  // ── Catalog integration ───────────────────────────────────────────────────
  router.get(
    "/catalog-types",
    auth,
    canOverview("read"),
    wrap((req, res) => res.json({ items: CatalogIntegration.lifecycleAwareTypes(db, { tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/snapshots",
    auth,
    canOverview("read"),
    wrap((req, res) => res.json(CatalogIntegration.bulkLifecycleSnapshots(db, { tenantId: tenantOf(req), objects: req.body?.objects || [] })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/configuration",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req))))
  );
  router.put(
    "/configuration/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.get(
    "/jobs",
    auth,
    canJobs("read"),
    wrap((req, res) => res.json(Jobs.listLifecycleJobs(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/jobs/evaluate",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(Jobs.submitEvaluationJob(db, { tenantId: tenantOf(req), actions: body.actions, limit: body.limit, apply: Boolean(body.apply), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/archive",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(Jobs.submitArchiveJob(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, force: Boolean(body.force), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/cold-storage",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(Jobs.submitColdStorageJob(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/restore",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(Jobs.submitRestoreJob(db, { tenantId: tenantOf(req), objects: body.objects || null, restoreRef: body.restore_ref ?? body.restoreRef ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/purge",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(Jobs.submitPurgeJob(db, { tenantId: tenantOf(req), objects: body.objects || null, limit: body.limit, force: Boolean(body.force), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }));
    })
  );
  router.post(
    "/jobs/recovery",
    auth,
    canJobs("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(202).json(
        Jobs.submitRecoveryJob(db, {
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
    auth,
    canJobs("execute"),
    wrap((req, res) => res.status(202).json(Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip })))
  );
  router.get(
    "/jobs/:ref",
    auth,
    canJobs("read"),
    wrap((req, res) => {
      const job = Jobs.getLifecycleJob(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Lifecycle job not found", details: { ref: req.params.ref } });
      res.json(job);
    })
  );

  return router;
}
