// REST router for the Deployment & Edition framework. Built as a factory so it
// reuses the application's auth, authorization and error middleware.
// Mounted at /api/deployment and /api/v1/deployment (mirrors
// server/services/change/router-change.js).
//
// `/capabilities` is intentionally open to any authenticated caller: the web
// console resolves it once after login so the UI can reflect the deployment
// posture. Reading or changing the profile/entitlements remains an explicit
// administrative permission.
import { Constants, Features, Foundation, History, Profile } from "./index.js";

const R = Constants.DEPLOYMENT_RESOURCES;

export function createDeploymentRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const canProfile = (action) => can(R.profile, action);
  const canFeatures = (action) => can(R.features, action);
  const canHistory = (action) => can(R.history, action);

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
    auth,
    wrap((_req, res) => res.json(Features.resolveCapabilities(db)))
  );

  router.get(
    "/health",
    auth,
    canProfile("read"),
    wrap((_req, res) => res.json(Foundation.deploymentHealth(db)))
  );

  // ── Profile ────────────────────────────────────────────────────────────────
  router.get(
    "/profile",
    auth,
    canProfile("read"),
    wrap((_req, res) => res.json({ profile: Profile.publicProfile(Profile.getProfile(db)) }))
  );

  router.put(
    "/profile",
    auth,
    canProfile("update"),
    wrap((req, res) => res.json({ profile: Profile.updateProfile(db, req.body || {}, req.actor, req.ip) }))
  );

  // ── Feature entitlements ───────────────────────────────────────────────────
  router.get(
    "/features",
    auth,
    canFeatures("read"),
    wrap((_req, res) => {
      const capabilities = Features.resolveCapabilities(db);
      res.json({ items: capabilities.catalog, summary: capabilities.summary });
    })
  );

  router.get(
    "/features/summary",
    auth,
    canFeatures("read"),
    wrap((_req, res) => res.json(Features.featureSummary(db)))
  );

  router.get(
    "/features/:code",
    auth,
    canFeatures("read"),
    wrap((req, res) => {
      const row = Features.featureRow(db, req.params.code);
      if (!row) return res.status(404).json({ error: `Unknown feature '${req.params.code}'` });
      const profile = Profile.getProfile(db);
      res.json({ ...Features.publicFeature(row), ...Features.evaluateFeature(profile, row) });
    })
  );

  router.put(
    "/features/:code",
    auth,
    canFeatures("update"),
    wrap((req, res) => res.json(Features.setFeature(db, req.params.code, req.body || {}, req.actor, req.ip)))
  );

  // ── History & bootstrap ────────────────────────────────────────────────────
  router.get(
    "/history",
    auth,
    canHistory("read"),
    wrap((req, res) => res.json(History.listDeploymentHistory(db, req.query)))
  );

  router.post(
    "/foundation/ensure",
    auth,
    canProfile("execute"),
    wrap((_req, res) => res.json(Foundation.ensureDeploymentFoundation(db)))
  );

  return router;
}
