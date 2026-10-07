// REST router for the Deployment & Edition framework. Built as a factory so it
// reuses the application's auth, authorization and error middleware.
// Mounted at /api/deployment and /api/v1/deployment (mirrors
// server/services/change/router-change.js).
//
// `/capabilities` is intentionally open to any authenticated caller: the web
// console resolves it once after login so the UI can reflect the deployment
// posture. Reading or changing the profile/entitlements remains an explicit
// administrative permission.
//
// Every route that touches the database runs on the asynchronous pg layer
// (authAsync/canAsync + *Async service twins). Only `/meta` (pure vocabulary)
// and `/foundation/ensure` (idempotent bootstrap, by convention) stay on the
// synchronous layer.
import { Constants, Features, Foundation, History, Profile } from "./index.js";

const R = Constants.DEPLOYMENT_RESOURCES;

export function createDeploymentRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const canProfileAsync = (action) => canAsync(R.profile, action);
  const canFeaturesAsync = (action) => canAsync(R.features, action);
  const canHistoryAsync = (action) => canAsync(R.history, action);

  // ── Meta, capabilities, health ─────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    wrap((_req, res) =>
      res.json({
        source_module: Constants.SOURCE_MODULE,
        vocabulary: {
          modes: Constants.DEPLOYMENT_MODES,
          editions: Constants.EDITIONS,
          tenant_strategies: Constants.TENANT_STRATEGIES,
        },
        resources: R,
      })
    )
  );

  router.get(
    "/capabilities",
    authAsync,
    wrap(async (_req, res) => res.json(await Features.resolveCapabilitiesAsync(db)))
  );

  router.get(
    "/health",
    authAsync,
    canProfileAsync("read"),
    wrap(async (_req, res) => res.json(await Foundation.deploymentHealthAsync(db)))
  );

  // ── Profile ────────────────────────────────────────────────────────────────
  router.get(
    "/profile",
    authAsync,
    canProfileAsync("read"),
    wrap(async (_req, res) => res.json({ profile: Profile.publicProfile(await Profile.getProfileAsync(db)) }))
  );

  router.put(
    "/profile",
    authAsync,
    canProfileAsync("update"),
    wrap(async (req, res) => res.json({ profile: await Profile.updateProfileAsync(db, req.body || {}, req.actor, req.ip) }))
  );

  // ── Feature entitlements ───────────────────────────────────────────────────
  router.get(
    "/features",
    authAsync,
    canFeaturesAsync("read"),
    wrap(async (_req, res) => {
      const capabilities = await Features.resolveCapabilitiesAsync(db);
      res.json({ items: capabilities.catalog, summary: capabilities.summary });
    })
  );

  router.get(
    "/features/summary",
    authAsync,
    canFeaturesAsync("read"),
    wrap(async (_req, res) => res.json(await Features.featureSummaryAsync(db)))
  );

  router.get(
    "/features/:code",
    authAsync,
    canFeaturesAsync("read"),
    wrap(async (req, res) => {
      const row = await Features.featureRowAsync(db, req.params.code);
      if (!row) return res.status(404).json({ error: `Unknown feature '${req.params.code}'` });
      const profile = await Profile.getProfileAsync(db);
      res.json({ ...Features.publicFeature(row), ...Features.evaluateFeature(profile, row) });
    })
  );

  router.put(
    "/features/:code",
    authAsync,
    canFeaturesAsync("update"),
    wrap(async (req, res) => res.json(await Features.setFeatureAsync(db, req.params.code, req.body || {}, req.actor, req.ip)))
  );

  // ── History & bootstrap ────────────────────────────────────────────────────
  router.get(
    "/history",
    authAsync,
    canHistoryAsync("read"),
    wrap(async (req, res) => res.json(await History.listDeploymentHistoryAsync(db, req.query)))
  );

  router.post(
    "/foundation/ensure",
    authAsync,
    canProfileAsync("execute"),
    wrap(async (_req, res) => res.json(await Foundation.ensureDeploymentFoundationAsync(db)))
  );

  return router;
}
