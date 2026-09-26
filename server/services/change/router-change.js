// REST router for the Change Management domain. Built as a factory so it
// reuses the application's auth, authorization and error middleware.
// Mounted at /api/change and /api/v1/change (mirrors server/services/pdm/router-pdm.js).
import { Constants, Validation, Requests, Orders, Notices, AffectedItems, Relationships, Configuration, Foundation, Seed } from "./index.js";

const R = Constants.CHANGE_RESOURCES;

export function createChangeRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverview = (a) => can(R.overview, a);
  const canRequests = (a) => can(R.requests, a);
  const canOrders = (a) => can(R.orders, a);
  const canNotices = (a) => can(R.notices, a);
  const canAffectedItems = (a) => can(R.affectedItems, a);
  const canCcb = (a) => can(R.ccb, a);
  const canAdmin = (a) => can(R.admin, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    canOverview("read"),
    wrap((_req, res) => res.json({ source_module: Constants.SOURCE_MODULE, vocabulary: Validation.vocabulary(), resources: R }))
  );
  router.get("/health", auth, canOverview("read"), wrap((req, res) => res.json(Foundation.changeHealth(db, tenantOf(req)))));

  // ── Configuration ───────────────────────────────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureChangeFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedChange(db, tenantOf(req)))));

  // ── Change Requests (ECR) ───────────────────────────────────────────────
  router.get("/requests", auth, canRequests("read"), wrap((req, res) => res.json(Requests.listRequests(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/requests", auth, canRequests("create"), wrap((req, res) => res.status(201).json(Requests.createRequest(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/requests/:ref", auth, canRequests("read"), wrap((req, res) => res.json(Requests.getRequest(db, tenantOf(req), req.params.ref))));
  router.put("/requests/:ref", auth, canRequests("update"), wrap((req, res) => res.json(Requests.updateRequest(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.post("/requests/:ref/submit", auth, canRequests("update"), wrap((req, res) => res.json(Requests.submitRequest(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/requests/:ref/withdraw", auth, canRequests("update"), wrap((req, res) => res.json(Requests.withdrawRequest(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post(
    "/requests/:ref/screen",
    auth,
    canCcb("execute"),
    wrap((req, res) => res.json(Requests.screenRequest(db, tenantOf(req), req.params.ref, req.body?.decision, req.body?.notes, req.actor, req.ip)))
  );
  router.post(
    "/requests/:ref/promote",
    auth,
    canCcb("execute"),
    wrap((req, res) => res.status(201).json(Requests.promoteRequest(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.get("/requests/:ref/history", auth, canRequests("read"), wrap((req, res) => res.json(Requests.listRequestHistory(db, tenantOf(req), req.params.ref))));

  // ── Change Orders (ECO) ─────────────────────────────────────────────────
  router.get("/orders", auth, canOrders("read"), wrap((req, res) => res.json(Orders.listOrders(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/orders", auth, canOrders("create"), wrap((req, res) => res.status(201).json(Orders.createOrder(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/orders/:ref", auth, canOrders("read"), wrap((req, res) => res.json(Orders.getOrder(db, tenantOf(req), req.params.ref))));
  router.put("/orders/:ref", auth, canOrders("update"), wrap((req, res) => res.json(Orders.updateOrder(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.post("/orders/:ref/submit", auth, canOrders("update"), wrap((req, res) => res.json(Orders.submitOrder(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post(
    "/orders/:ref/decide",
    auth,
    canCcb("execute"),
    wrap((req, res) => res.json(Orders.decideOrder(db, tenantOf(req), req.params.ref, req.body?.decision, req.actor, req.ip)))
  );
  router.post("/orders/:ref/release", auth, canOrders("execute"), wrap((req, res) => res.json(Orders.releaseOrder(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/orders/:ref/cancel", auth, canOrders("update"), wrap((req, res) => res.json(Orders.cancelOrder(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/orders/:ref/history", auth, canOrders("read"), wrap((req, res) => res.json(Orders.listOrderHistory(db, tenantOf(req), req.params.ref))));

  // ── Affected items & impact analysis ────────────────────────────────────
  router.get("/orders/:ref/affected-items", auth, canAffectedItems("read"), wrap((req, res) => res.json(AffectedItems.listAffectedItems(db, tenantOf(req), req.params.ref))));
  router.post(
    "/orders/:ref/affected-items",
    auth,
    canAffectedItems("create"),
    wrap((req, res) => res.status(201).json(AffectedItems.addAffectedItem(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.delete(
    "/orders/:ref/affected-items/:itemRef",
    auth,
    canAffectedItems("delete"),
    wrap((req, res) => res.json(AffectedItems.removeAffectedItem(db, tenantOf(req), req.params.ref, req.params.itemRef, req.actor, req.ip)))
  );
  router.get(
    "/impact",
    auth,
    canAffectedItems("read"),
    wrap((req, res) => res.json(AffectedItems.listImpact(db, tenantOf(req), { objectType: req.query.objectType || req.query.object_type, objectId: req.query.objectId || req.query.object_id, maxDepth: req.query.maxDepth })))
  );

  // ── Change Notices (ECN) ────────────────────────────────────────────────
  router.get("/notices", auth, canNotices("read"), wrap((req, res) => res.json(Notices.listNotices(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/notices", auth, canNotices("create"), wrap((req, res) => res.status(201).json(Notices.createNotice(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/notices/:ref", auth, canNotices("read"), wrap((req, res) => res.json(Notices.getNotice(db, tenantOf(req), req.params.ref))));
  router.post("/notices/:ref/issue", auth, canNotices("update"), wrap((req, res) => res.json(Notices.issueNotice(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/notices/:ref/acknowledge", auth, canNotices("update"), wrap((req, res) => res.json(Notices.acknowledgeNotice(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/notices/:ref/history", auth, canNotices("read"), wrap((req, res) => res.json(Notices.listNoticeHistory(db, tenantOf(req), req.params.ref))));

  // ── Relationships ────────────────────────────────────────────────────────
  router.get("/relationships", auth, canOverview("read"), wrap((req, res) => res.json(Relationships.listRelationships(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/relationships", auth, canAdmin("create"), wrap((req, res) => res.status(201).json(Relationships.createRelationship(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/relationships/:ref", auth, canOverview("read"), wrap((req, res) => res.json(Relationships.getRelationship(db, tenantOf(req), req.params.ref))));
  router.delete("/relationships/:ref", auth, canAdmin("delete"), wrap((req, res) => res.json(Relationships.deleteRelationship(db, tenantOf(req), req.params.ref))));

  return router;
}
