// REST router for the Change Management domain. Built as a factory so it
// reuses the application's auth, authorization and error middleware.
// Mounted at /api/change and /api/v1/change (mirrors server/services/pdm/router-pdm.js).
//
// Every route is entirely one data-access layer (per the async migration
// rule): data routes use `authAsync`/`canAsync` + `*Async` service twins,
// while pure-vocabulary (`/meta`), bootstrap (`/foundation/ensure`, `/seed`)
// and `POST /orders/:ref/decide` (still-sync Workflow binding trigger) stay on
// the sync `auth`/`can` + sync service.
import { Constants, Validation, Requests, Orders, Notices, AffectedItems, Relationships, Configuration, Foundation, Seed } from "./index.js";

const R = Constants.CHANGE_RESOURCES;

export function createChangeRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverview = (a) => can(R.overview, a);
  const canRequests = (a) => can(R.requests, a);
  const canOrders = (a) => can(R.orders, a);
  const canNotices = (a) => can(R.notices, a);
  const canAffectedItems = (a) => can(R.affectedItems, a);
  const canCcb = (a) => can(R.ccb, a);
  const canAdmin = (a) => can(R.admin, a);

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canRequestsAsync = (a) => canAsync(R.requests, a);
  const canOrdersAsync = (a) => canAsync(R.orders, a);
  const canNoticesAsync = (a) => canAsync(R.notices, a);
  const canAffectedItemsAsync = (a) => canAsync(R.affectedItems, a);
  const canCcbAsync = (a) => canAsync(R.ccb, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    canOverview("read"),
    wrap((_req, res) => res.json({ source_module: Constants.SOURCE_MODULE, vocabulary: Validation.vocabulary(), resources: R }))
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.changeHealthAsync(db, tenantOf(req)))));

  // ── Configuration ───────────────────────────────────────────────────────
  router.get("/config", authAsync, canAdminAsync("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    authAsync,
    canAdminAsync("update"),
    wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureChangeFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedChange(db, tenantOf(req)))));

  // ── Change Requests (ECR) ───────────────────────────────────────────────
  router.get("/requests", authAsync, canRequestsAsync("read"), wrap(async (req, res) => res.json(await Requests.listRequestsAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/requests", authAsync, canRequestsAsync("create"), wrap(async (req, res) => res.status(201).json(await Requests.createRequestAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/requests/:ref", authAsync, canRequestsAsync("read"), wrap(async (req, res) => res.json(await Requests.getRequestAsync(db, tenantOf(req), req.params.ref))));
  router.put("/requests/:ref", authAsync, canRequestsAsync("update"), wrap(async (req, res) => res.json(await Requests.updateRequestAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.post("/requests/:ref/submit", authAsync, canRequestsAsync("update"), wrap(async (req, res) => res.json(await Requests.submitRequestAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/requests/:ref/withdraw", authAsync, canRequestsAsync("update"), wrap(async (req, res) => res.json(await Requests.withdrawRequestAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post(
    "/requests/:ref/screen",
    authAsync,
    canCcbAsync("execute"),
    wrap(async (req, res) => res.json(await Requests.screenRequestAsync(db, tenantOf(req), req.params.ref, req.body?.decision, req.body?.notes, req.actor, req.ip)))
  );
  router.post(
    "/requests/:ref/promote",
    authAsync,
    canCcbAsync("execute"),
    wrap(async (req, res) => res.status(201).json(await Requests.promoteRequestAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.get("/requests/:ref/history", authAsync, canRequestsAsync("read"), wrap(async (req, res) => res.json(await Requests.listRequestHistoryAsync(db, tenantOf(req), req.params.ref))));

  // ── Change Orders (ECO) ─────────────────────────────────────────────────
  router.get("/orders", authAsync, canOrdersAsync("read"), wrap(async (req, res) => res.json(await Orders.listOrdersAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/orders", authAsync, canOrdersAsync("create"), wrap(async (req, res) => res.status(201).json(await Orders.createOrderAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/orders/:ref", authAsync, canOrdersAsync("read"), wrap(async (req, res) => res.json(await Orders.getOrderAsync(db, tenantOf(req), req.params.ref))));
  router.put("/orders/:ref", authAsync, canOrdersAsync("update"), wrap(async (req, res) => res.json(await Orders.updateOrderAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip))));
  router.post("/orders/:ref/submit", authAsync, canOrdersAsync("update"), wrap(async (req, res) => res.json(await Orders.submitOrderAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  // Sync: `decideOrder` fires the sync Workflow binding trigger.
  router.post(
    "/orders/:ref/decide",
    auth,
    canCcb("execute"),
    wrap((req, res) => res.json(Orders.decideOrder(db, tenantOf(req), req.params.ref, req.body?.decision, req.actor, req.ip)))
  );
  router.post("/orders/:ref/release", authAsync, canOrdersAsync("execute"), wrap(async (req, res) => res.json(await Orders.releaseOrderAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/orders/:ref/cancel", authAsync, canOrdersAsync("update"), wrap(async (req, res) => res.json(await Orders.cancelOrderAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/orders/:ref/history", authAsync, canOrdersAsync("read"), wrap(async (req, res) => res.json(await Orders.listOrderHistoryAsync(db, tenantOf(req), req.params.ref))));

  // ── Affected items & impact analysis ────────────────────────────────────
  router.get("/orders/:ref/affected-items", authAsync, canAffectedItemsAsync("read"), wrap(async (req, res) => res.json(await AffectedItems.listAffectedItemsAsync(db, tenantOf(req), req.params.ref))));
  router.post(
    "/orders/:ref/affected-items",
    authAsync,
    canAffectedItemsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await AffectedItems.addAffectedItemAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.delete(
    "/orders/:ref/affected-items/:itemRef",
    authAsync,
    canAffectedItemsAsync("delete"),
    wrap(async (req, res) => res.json(await AffectedItems.removeAffectedItemAsync(db, tenantOf(req), req.params.ref, req.params.itemRef, req.actor, req.ip)))
  );
  router.get(
    "/impact",
    authAsync,
    canAffectedItemsAsync("read"),
    wrap(async (req, res) => res.json(await AffectedItems.listImpactAsync(db, tenantOf(req), { objectType: req.query.objectType || req.query.object_type, objectId: req.query.objectId || req.query.object_id, maxDepth: req.query.maxDepth })))
  );

  // ── Change Notices (ECN) ────────────────────────────────────────────────
  router.get("/notices", authAsync, canNoticesAsync("read"), wrap(async (req, res) => res.json(await Notices.listNoticesAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/notices", authAsync, canNoticesAsync("create"), wrap(async (req, res) => res.status(201).json(await Notices.createNoticeAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/notices/:ref", authAsync, canNoticesAsync("read"), wrap(async (req, res) => res.json(await Notices.getNoticeAsync(db, tenantOf(req), req.params.ref))));
  router.post("/notices/:ref/issue", authAsync, canNoticesAsync("update"), wrap(async (req, res) => res.json(await Notices.issueNoticeAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/notices/:ref/acknowledge", authAsync, canNoticesAsync("update"), wrap(async (req, res) => res.json(await Notices.acknowledgeNoticeAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/notices/:ref/history", authAsync, canNoticesAsync("read"), wrap(async (req, res) => res.json(await Notices.listNoticeHistoryAsync(db, tenantOf(req), req.params.ref))));

  // ── Relationships ────────────────────────────────────────────────────────
  router.get("/relationships", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Relationships.listRelationshipsAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.post("/relationships", authAsync, canAdminAsync("create"), wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipAsync(db, tenantOf(req), req.body, req.actor, req.ip))));
  router.get("/relationships/:ref", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Relationships.getRelationshipAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/relationships/:ref", authAsync, canAdminAsync("delete"), wrap(async (req, res) => res.json(await Relationships.deleteRelationshipAsync(db, tenantOf(req), req.params.ref))));

  return router;
}
