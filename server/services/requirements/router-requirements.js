// REST router for the Requirements Manager domain. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/requirements and /api/v1/requirements (mirrors
// server/services/change/router-change.js).
//
// Every route is entirely one data-access layer: data routes and bootstrap use
// `authAsync`/`canAsync` + `*Async` service twins, while the pure-vocabulary
// `/meta` route stays on the sync `auth`/`can` path.
import { Constants, Validation, Requirements, Types, Relationships, Baselines, ValidationRules, Configuration, Foundation, Seed } from "./index.js";

const R = Constants.REQUIREMENTS_RESOURCES;

export function createRequirementsRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canItemsAsync = (a) => canAsync(R.items, a);
  const canTypesAsync = (a) => canAsync(R.types, a);
  const canRelationshipsAsync = (a) => canAsync(R.relationships, a);
  const canHierarchyAsync = (a) => canAsync(R.hierarchy, a);
  const canBaselinesAsync = (a) => canAsync(R.baselines, a);
  const canReviewsAsync = (a) => canAsync(R.reviews, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) => res.json({ source_module: Constants.SOURCE_MODULE, vocabulary: Validation.vocabulary(), resources: R }))
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.requirementsHealthAsync(db, tenantOf(req)))));

  // ── Configuration ───────────────────────────────────────────────────────
  router.get("/config", authAsync, canAdminAsync("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    authAsync,
    canAdminAsync("update"),
    wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureRequirementsFoundationAsync(db))));
  router.post("/seed", authAsync, canAdminAsync("execute"), wrap(async (req, res) => res.json(await Seed.seedRequirementsAsync(db, tenantOf(req)))));

  // ── Requirement types ───────────────────────────────────────────────────
  router.get("/types", authAsync, canTypesAsync("read"), wrap(async (req, res) => res.json(await Types.listTypesAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/types", authAsync, canTypesAsync("create"), wrap(async (req, res) => res.status(201).json(await Types.createTypeAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/types/:code", authAsync, canTypesAsync("read"), wrap(async (req, res) => res.json(await Types.getTypeAsync(db, tenantOf(req), req.params.code))));
  router.put("/types/:code", authAsync, canTypesAsync("update"), wrap(async (req, res) => res.json(await Types.updateTypeAsync(db, tenantOf(req), req.params.code, req.body, req.actor, req.ip))));
  router.post("/types/:code/status", authAsync, canTypesAsync("update"), wrap(async (req, res) => res.json(await Types.setTypeStatusAsync(db, tenantOf(req), req.params.code, req.body?.status, req.actor, req.ip))));

  // ── Requirements ────────────────────────────────────────────────────────
  router.get("/requirements", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Requirements.listRequirementsAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/requirements", authAsync, canItemsAsync("create"), wrap(async (req, res) => res.status(201).json(await Requirements.createRequirementAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/requirements/:ref", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Requirements.getRequirementAsync(db, tenantOf(req), req.params.ref))));
  router.put("/requirements/:ref", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Requirements.updateRequirementAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.delete("/requirements/:ref", authAsync, canItemsAsync("delete"), wrap(async (req, res) => res.json(await Requirements.deleteRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // Lifecycle transitions
  router.post("/requirements/:ref/transition", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Requirements.transitionRequirementAsync(db, tenantOf(req), req.params.ref, req.body?.status, { reason: req.body?.reason, actor: req.actor, ip: req.ip }))));
  router.post("/requirements/:ref/submit", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Requirements.submitRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip, req.body?.reason))));
  router.post("/requirements/:ref/approve", authAsync, canReviewsAsync("execute"), wrap(async (req, res) => res.json(await Requirements.approveRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip, req.body?.reason))));
  router.post("/requirements/:ref/reject", authAsync, canReviewsAsync("execute"), wrap(async (req, res) => res.json(await Requirements.rejectRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip, req.body?.reason))));
  router.post("/requirements/:ref/release", authAsync, canItemsAsync("execute"), wrap(async (req, res) => res.json(await Requirements.releaseRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip, req.body?.reason))));
  router.post("/requirements/:ref/obsolete", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Requirements.obsoleteRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip, req.body?.reason))));
  router.post("/requirements/:ref/verification", authAsync, canReviewsAsync("update"), wrap(async (req, res) => res.json(await Requirements.setVerificationStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));

  // Revisions
  router.post("/requirements/:ref/revise", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.status(201).json(await Requirements.reviseRequirementAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.get("/requirements/:ref/revisions", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Requirements.listRevisionsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/revisions/compare", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Requirements.compareRevisionsAsync(db, tenantOf(req), req.params.ref, req.query.from, req.query.to))));
  router.get("/requirements/:ref/history", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Requirements.listRequirementHistoryAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/children", authAsync, canHierarchyAsync("read"), wrap(async (req, res) => res.json(await Requirements.listChildrenAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/relationships", authAsync, canRelationshipsAsync("read"), wrap(async (req, res) => res.json(await Relationships.relationshipsForRequirementAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/validate", authAsync, canReviewsAsync("read"), wrap(async (req, res) => res.json(await ValidationRules.validateRequirementAsync(db, tenantOf(req), req.params.ref))));

  // ── Relationships & hierarchy ───────────────────────────────────────────
  router.get("/relationships", authAsync, canRelationshipsAsync("read"), wrap(async (req, res) => res.json(await Relationships.listRelationshipsAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/relationships", authAsync, canRelationshipsAsync("create"), wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/relationships/:ref", authAsync, canRelationshipsAsync("read"), wrap(async (req, res) => res.json(await Relationships.getRelationshipAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/relationships/:ref", authAsync, canRelationshipsAsync("delete"), wrap(async (req, res) => res.json(await Relationships.deleteRelationshipAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/hierarchy/:ref", authAsync, canHierarchyAsync("read"), wrap(async (req, res) => res.json(await Relationships.traverseAsync(db, tenantOf(req), req.params.ref, { maxDepth: req.query.maxDepth }))));

  // ── Baselines ───────────────────────────────────────────────────────────
  router.get("/baselines", authAsync, canBaselinesAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselinesAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/baselines", authAsync, canBaselinesAsync("create"), wrap(async (req, res) => res.status(201).json(await Baselines.createBaselineAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/baselines/:ref", authAsync, canBaselinesAsync("read"), wrap(async (req, res) => res.json(await Baselines.getBaselineAsync(db, tenantOf(req), req.params.ref))));
  router.get("/baselines/:ref/members", authAsync, canBaselinesAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselineMembersAsync(db, tenantOf(req), req.params.ref))));
  router.post("/baselines/:ref/members", authAsync, canBaselinesAsync("update"), wrap(async (req, res) => res.status(201).json(await Baselines.addBaselineMemberAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.delete("/baselines/:ref/members/:memberRef", authAsync, canBaselinesAsync("update"), wrap(async (req, res) => res.json(await Baselines.removeBaselineMemberAsync(db, tenantOf(req), req.params.ref, req.params.memberRef, req.actor, req.ip))));
  router.post("/baselines/:ref/release", authAsync, canBaselinesAsync("execute"), wrap(async (req, res) => res.json(await Baselines.releaseBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/baselines/:ref/compare", authAsync, canBaselinesAsync("read"), wrap(async (req, res) => res.json(await Baselines.compareBaselineAsync(db, tenantOf(req), req.params.ref))));

  // ── Validation rules & reviews ──────────────────────────────────────────
  router.get("/validation-rules", authAsync, canReviewsAsync("read"), wrap(async (req, res) => res.json(await ValidationRules.listValidationRulesAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/validation-rules", authAsync, canReviewsAsync("create"), wrap(async (req, res) => res.status(201).json(await ValidationRules.createValidationRuleAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/validation-rules/:ref", authAsync, canReviewsAsync("read"), wrap(async (req, res) => res.json(await ValidationRules.getValidationRuleAsync(db, tenantOf(req), req.params.ref))));
  router.put("/validation-rules/:ref", authAsync, canReviewsAsync("update"), wrap(async (req, res) => res.json(await ValidationRules.updateValidationRuleAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.delete("/validation-rules/:ref", authAsync, canReviewsAsync("delete"), wrap(async (req, res) => res.json(await ValidationRules.deleteValidationRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/validation/run", authAsync, canReviewsAsync("execute"), wrap(async (req, res) => res.json(await ValidationRules.runValidationAsync(db, tenantOf(req), req.body || {}))));

  return router;
}
