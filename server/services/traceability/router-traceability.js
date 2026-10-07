// REST router for the Generic Traceability Engine. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/traceability and /api/v1/traceability.
//
// The engine is an alternate projection of the Digital Thread, so every route
// is authorized against the existing `iam.thread.*` IAM resources — the API
// never introduces a second authorization system. All data routes run on the
// asynchronous PostgreSQL layer.
import { Links, Service, Constants } from "./index.js";

const R = Constants.TRACEABILITY_RESOURCES;

export function createTraceabilityRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const query = (req) => ({ tenantId: tenantOf(req), ...req.query });

  const canOverview = (a) => canAsync(R.overview, a);
  const canExplorer = (a) => canAsync(R.explorer, a);
  const canTraceability = (a) => canAsync(R.traceability, a);
  const canImpact = (a) => canAsync(R.impact, a);
  const canPaths = (a) => canAsync(R.paths, a);
  const canCompleteness = (a) => canAsync(R.completeness, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  // ── Meta & health ─────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) => res.json({ source_module: Constants.SOURCE_MODULE, resources: R, broken_link_reasons: Constants.BROKEN_LINK_REASONS }))
  );
  router.get("/health", authAsync, canOverview("read"), wrap(async (req, res) => res.json(await Service.healthAsync(db, tenantOf(req), req.actor))));

  // ── Configuration (reuses the Digital Thread configuration store) ─────────
  router.get("/config", authAsync, canAdmin("read"), wrap(async (req, res) => res.json(await Service.listConfigAsync(db, tenantOf(req)))));
  router.put("/config/:key", authAsync, canAdmin("update"), wrap(async (req, res) => res.json(await Service.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip))));
  router.patch("/config/:key", authAsync, canAdmin("update"), wrap(async (req, res) => res.json(await Service.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip))));

  // ── Trace links (typed edges in the Object & Relationship Framework) ──────
  router.get("/links", authAsync, canTraceability("read"), wrap(async (req, res) => res.json(await Links.listLinksAsync(db, query(req), tenantOf(req)))));
  router.post("/links", authAsync, canTraceability("create"), wrap(async (req, res) => res.status(201).json(await Links.createLinkAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip))));
  router.get("/links/:id", authAsync, canTraceability("read"), wrap(async (req, res) => res.json(await Links.getLinkAsync(db, req.params.id, tenantOf(req)))));
  router.put("/links/:id", authAsync, canTraceability("update"), wrap(async (req, res) => res.json(await Links.updateLinkAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip))));
  router.patch("/links/:id", authAsync, canTraceability("update"), wrap(async (req, res) => res.json(await Links.updateLinkAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip))));
  router.delete("/links/:id", authAsync, canTraceability("delete"), wrap(async (req, res) => res.json(await Links.deleteLinkAsync(db, req.params.id, { force: req.query.force === "true" }, req.actor, tenantOf(req), req.ip))));

  // ── Graph & path ──────────────────────────────────────────────────────────
  router.get("/graph", authAsync, canExplorer("read"), wrap(async (req, res) => res.json(await Service.graphAsync(db, tenantOf(req), req.query, req.actor))));
  router.get("/path", authAsync, canPaths("read"), wrap(async (req, res) => res.json(await Service.findPathsAsync(db, tenantOf(req), req.query, req.actor))));

  // ── Analysis read models ──────────────────────────────────────────────────
  router.post("/impact-analysis", authAsync, canImpact("execute"), wrap(async (req, res) => res.json(await Service.impactAsync(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/matrix", authAsync, canTraceability("read"), wrap(async (req, res) => res.json(await Service.matrixAsync(db, tenantOf(req), req.query, req.actor))));
  router.get("/coverage", authAsync, canCompleteness("read"), wrap(async (req, res) => res.json(await Service.coverageAsync(db, tenantOf(req), req.query, req.actor))));
  router.get("/orphans", authAsync, canCompleteness("read"), wrap(async (req, res) => res.json(await Service.orphansAsync(db, tenantOf(req), req.query, req.actor))));
  router.get("/broken-links", authAsync, canCompleteness("read"), wrap(async (req, res) => res.json(await Service.brokenLinksAsync(db, tenantOf(req), req.query, req.actor))));

  // ── Object-centric traversal (registered last: wildcard segments) ─────────
  router.get("/:objectType/:objectId/forward", authAsync, canExplorer("read"), wrap(async (req, res) => res.json(await Service.forwardAsync(db, tenantOf(req), { ...req.query, objectType: req.params.objectType, objectId: req.params.objectId }, req.actor))));
  router.get("/:objectType/:objectId/backward", authAsync, canExplorer("read"), wrap(async (req, res) => res.json(await Service.backwardAsync(db, tenantOf(req), { ...req.query, objectType: req.params.objectType, objectId: req.params.objectId }, req.actor))));
  router.get("/:objectType/:objectId/children", authAsync, canExplorer("read"), wrap(async (req, res) => res.json(await Service.childrenAsync(db, tenantOf(req), { ...req.query, objectType: req.params.objectType, objectId: req.params.objectId }, req.actor))));
  router.get("/:objectType/:objectId/parents", authAsync, canExplorer("read"), wrap(async (req, res) => res.json(await Service.parentsAsync(db, tenantOf(req), { ...req.query, objectType: req.params.objectType, objectId: req.params.objectId }, req.actor))));
  router.get("/:objectType/:objectId/links", authAsync, canTraceability("read"), wrap(async (req, res) => res.json(await Links.linksForObjectAsync(db, req.params.objectType, req.params.objectId, tenantOf(req), req.query))));

  return router;
}
