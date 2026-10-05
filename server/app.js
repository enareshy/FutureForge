import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { HttpError, pagination } from "./validation.js";
import { queryOne } from "./db.js";
import { queryOneAsync } from "./db-async.js";
import * as users from "./services/users.js";
import * as groups from "./services/groups.js";
import * as roles from "./services/roles.js";
import * as orgs from "./services/orgs.js";
import * as policy from "./services/policy.js";
import * as audit from "./services/audit.js";
import * as notifications from "./services/notifications.js";
import * as delivery from "./services/delivery.js";
import * as jobs from "./services/jobs.js";
import * as jobExecution from "./services/job-execution.js";
import * as catalog from "./services/catalog.js";
import * as grants from "./services/grants.js";
import * as authorization from "./services/authorization.js";
import * as hierarchy from "./services/hierarchy.js";
import * as authentication from "./services/authentication.js";
import * as sessions from "./services/sessions.js";
import * as providers from "./services/providers.js";
import * as mfa from "./services/mfa.js";
import * as tenants from "./services/tenants.js";
import * as config from "./services/config.js";
import * as metadata from "./services/metadata.js";
import * as objects from "./services/objects.js";
import * as lifecycle from "./services/lifecycle.js";
import * as workflow from "./services/workflow.js";
import * as files from "./services/files.js";
import * as search from "./services/search.js";
import * as security from "./services/security/admin.js";
import { ensureSecurityFoundation } from "./services/security/foundation.js";
import * as integration from "./services/integration.js";
import * as events from "./services/events.js";
import * as numbering from "./services/numbering.js";
import * as versioning from "./services/versioning.js";
import { createVersioningRouter } from "./services/versioning/router.js";
import * as reference from "./services/reference.js";
import { createReferenceRouter } from "./services/reference/router.js";
import * as content from "./services/content.js";
import { createContentRouter } from "./services/content/router.js";
import * as dataGovernance from "./services/data-governance/index.js";
import { createDataGovernanceRouter } from "./services/data-governance/router-data-governance.js";
import { createDataQualityRouter } from "./services/data-governance/router-data-quality.js";
import * as dataCatalog from "./services/data-catalog/index.js";
import { createDataCatalogRouter } from "./services/data-catalog/router-data-catalog.js";
import { createGlossaryRouter } from "./services/data-catalog/router-glossary.js";
import * as dataLifecycle from "./services/data-lifecycle/index.js";
import { createDataLifecycleRouter } from "./services/data-lifecycle/router-data-lifecycle.js";
import * as dataExchange from "./services/data-exchange/index.js";
import { createDataExchangeRouter } from "./services/data-exchange/router-data-exchange.js";
import * as migration from "./services/migration/index.js";
import { createMigrationRouter } from "./services/migration/router-migration.js";
import * as classification from "./services/classification/index.js";
import { createClassificationRouter } from "./services/classification/router-classification.js";
import * as bom from "./services/bom/index.js";
import { createBomRouter } from "./services/bom/router-bom.js";
import * as pdm from "./services/pdm/index.js";
import { createPdmRouter } from "./services/pdm/router-pdm.js";
import * as change from "./services/change/index.js";
import { createChangeRouter } from "./services/change/router-change.js";
import * as deployment from "./services/deployment/index.js";
import { createDeploymentRouter } from "./services/deployment/router-deployment.js";
import * as thread from "./services/thread/index.js";
import { createThreadRouter } from "./services/thread/router-thread.js";
import * as exchange from "./services/exchange/index.js";
import { createExchangeRouter } from "./services/exchange/router-exchange.js";
import * as reporting from "./services/reporting/index.js";
import { createReportingRouter } from "./services/reporting/router-reporting.js";
import * as observability from "./services/observability/index.js";
import { createObservabilityRouter } from "./services/observability/router-observability.js";
import { getStorageProvider, verifyDownloadToken, storageConfig, signDownload, signedDownloadPath } from "./services/file-storage.js";
import {
  readTenant as metaReadTenant,
  readTenantAsync as metaReadTenantAsync,
  writeTenant as metaWriteTenant,
  writeTenantAsync as metaWriteTenantAsync,
} from "./services/metadata/scope.js";
import { writeAudit, writeAuditAsync } from "./services/audit.js";
import { effectiveAccess, effectiveAccessAsync } from "./services/access.js";
import { requirePermission, requirePermissionAsync, requireFeature } from "./middleware.js";
import { runWithRequestContext } from "./request-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
}

// Cross-origin callers (the Vite dev server, or a future separate client
// deployment) must be explicitly allow-listed. The single-port production
// deploy (npm start, web/dist served from this same app) never needs CORS
// at all since every request is same-origin.
function corsOrigins() {
  const configured = String(process.env.HELIX_CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

function requestMeta(req) {
  return { ip: clientIp(req), userAgent: req.headers["user-agent"] || "" };
}

// Express `trust proxy`. The app is normally reached through a local reverse
// proxy (the Vite dev proxy, or the single-port production front end), which
// sets X-Forwarded-For; without this, express-rate-limit rejects the header and
// req.ip is the proxy address. The default trusts only loopback/private proxies
// so a directly exposed client can never spoof its address. Override with
// HELIX_TRUST_PROXY (a hop count, `true`, or an Express trust-proxy value such
// as `loopback` or a CIDR list) when running behind additional infrastructure.
function trustProxySetting() {
  const raw = String(process.env.HELIX_TRUST_PROXY ?? "").trim();
  if (!raw) return "loopback";
  if (/^(true|yes)$/i.test(raw)) return true;
  if (/^(false|no)$/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function requireAuth(db) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-session-token"];
    if (!token) return next(new HttpError(401, "Authentication required"));
    const session = sessions.getSessionByToken(db, token);
    if (!session) return next(new HttpError(401, "Invalid session"));
    const user = queryOne(
      db,
      `SELECT id, username, email, employee_id, display_name, status, organization_id, tenant_id
       FROM users WHERE id = ?`,
      [session.user_id]
    );
    if (!user || user.status !== "active") return next(new HttpError(403, "Account is not active"));
    req.actor = user;
    req.sessionToken = token;
    req.sessionRow = session;
    try {
      req.tenantId = resolveRequestTenant(db, req);
    } catch (err) {
      return next(err);
    }
    next();
  };
}

function resolveRequestTenant(db, req) {
  const override = req.headers["x-tenant-id"] || req.query?.tenantId;
  const sessionTenant = req.sessionRow?.tenant_id || req.actor?.tenant_id || null;
  if (override !== undefined && override !== null && override !== "") {
    if (!tenants.isPlatformAdmin(db, req.actor.id)) {
      throw new HttpError(403, "Cannot override tenant context");
    }
    const tenant = tenants.getTenant(db, override);
    if (Number(tenant.id) !== Number(sessionTenant)) {
      writeAudit(db, {
        actor: req.actor,
        action: "tenant.context.switch",
        resourceType: "tenant",
        resourceId: tenant.id,
        details: { code: tenant.code, via: "header", previous: sessionTenant },
        ip: clientIp(req),
      });
    }
    return tenant.id;
  }
  return sessionTenant || null;
}

// Async counterpart of `requireAuth` used by asynchronous route groups. The
// session lookup, user load and (only when a tenant override is present) the
// platform-admin check all run without blocking the event loop.
function requireAuthAsync(db) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-session-token"];
      if (!token) return next(new HttpError(401, "Authentication required"));
      const session = await sessions.getSessionByTokenAsync(db, token);
      if (!session) return next(new HttpError(401, "Invalid session"));
      const user = await queryOneAsync(
        db,
        `SELECT id, username, email, employee_id, display_name, status, organization_id, tenant_id
         FROM users WHERE id = ?`,
        [session.user_id]
      );
      if (!user || user.status !== "active") return next(new HttpError(403, "Account is not active"));
      req.actor = user;
      req.sessionToken = token;
      req.sessionRow = session;
      req.tenantId = await resolveRequestTenantAsync(db, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function resolveRequestTenantAsync(db, req) {
  const override = req.headers["x-tenant-id"] || req.query?.tenantId;
  const sessionTenant = req.sessionRow?.tenant_id || req.actor?.tenant_id || null;
  if (override !== undefined && override !== null && override !== "") {
    if (!(await tenants.isPlatformAdminAsync(db, req.actor.id))) {
      throw new HttpError(403, "Cannot override tenant context");
    }
    const tenant = await tenants.getTenantAsync(db, override);
    if (Number(tenant.id) !== Number(sessionTenant)) {
      writeAudit(db, {
        actor: req.actor,
        action: "tenant.context.switch",
        resourceType: "tenant",
        resourceId: tenant.id,
        details: { code: tenant.code, via: "header", previous: sessionTenant },
        ip: clientIp(req),
      });
    }
    return tenant.id;
  }
  return sessionTenant || null;
}

function tenantFilter(req) {
  return { tenantId: req.tenantId || -1 };
}

function scopedOrg(db, req, id) {
  return orgs.getOrganization(db, id, tenantFilter(req));
}

async function scopedOrgAsync(db, req, id) {
  return orgs.getOrganizationAsync(db, id, tenantFilter(req));
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  // Everything downstream runs inside this request's memoization context, so
  // repeated authorization/access resolution is computed once per request.
  app.use((_req, _res, next) => runWithRequestContext(() => next()));
  app.set("trust proxy", trustProxySetting());
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins(),
      allowedHeaders: ["Content-Type", "Authorization", "X-Session-Token", "X-Tenant-Id"],
    })
  );

  // Instantiated per-app (not module-level) so every createApp(db) call —
  // including each test file's own instance — gets independent counters.
  //
  // Note: login/MFA/SSO/reset already have brute-force protection at the
  // application layer (assertRateLimit in services/ratelimit.js — default
  // 10 attempts/60s per ip+action+principal, admin-configurable). This
  // limiter is deliberately generic instead of duplicating that: it caps
  // overall API throughput per IP as a blunt abuse/DoS backstop across
  // every route, which nothing previously covered.
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api", apiLimiter);

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf && buf.length ? buf.toString("utf8") : "";
      },
    })
  );
  app.use(express.urlencoded({ extended: false }));
  providers.ensureDefaultProviders(db);
  config.ensureDefinitions(db);
  tenants.stampTenantIds(db);
  try {
    numbering.ensureNumberingFoundation(db);
  } catch {
    /* numbering foundation is idempotent and must never block application boot */
  }
  try {
    versioning.ensureVersioningFoundation(db);
  } catch {
    /* versioning foundation is idempotent and must never block application boot */
  }
  try {
    reference.ensureReferenceFoundation(db);
  } catch {
    /* reference data foundation is idempotent and must never block application boot */
  }
  try {
    content.ensureContentFoundation(db);
  } catch {
    /* content foundation is idempotent and must never block application boot */
  }
  try {
    ensureSecurityFoundation(db);
  } catch {
    /* security foundation is idempotent and must never block application boot */
  }
  try {
    dataGovernance.ensureDataGovernanceFoundation(db);
  } catch {
    /* data governance foundation is idempotent and must never block application boot */
  }
  try {
    dataCatalog.ensureDataCatalogFoundation(db);
  } catch {
    /* data catalog foundation is idempotent and must never block application boot */
  }
  try {
    dataLifecycle.ensureDataLifecycleFoundation(db);
  } catch {
    /* data lifecycle foundation is idempotent and must never block application boot */
  }
  try {
    dataExchange.ensureDataExchangeFoundation(db);
  } catch {
    /* data exchange foundation is idempotent and must never block application boot */
  }
  try {
    migration.ensureMigrationFoundation(db);
  } catch {
    /* migration foundation is idempotent and must never block application boot */
  }
  try {
    classification.ensureClassificationFoundation(db);
  } catch {
    /* classification foundation is idempotent and must never block application boot */
  }
  try {
    bom.ensureBomFoundation(db);
  } catch {
    /* BOM engine foundation is idempotent and must never block application boot */
  }
  try {
    pdm.ensurePdmFoundation(db);
  } catch {
    /* PDM domain foundation is idempotent and must never block application boot */
  }
  try {
    change.ensureChangeFoundation(db);
  } catch {
    /* Change Management foundation is idempotent and must never block application boot */
  }
  try {
    thread.ensureThreadFoundation(db);
  } catch {
    /* Digital Thread foundation is idempotent and must never block application boot */
  }
  try {
    exchange.ensureExchangeFoundation(db);
  } catch {
    /* Standards & Exchange foundation is idempotent and must never block application boot */
  }
  try {
    reporting.ensureReportingFoundation(db);
  } catch {
    /* Reporting & Analytics foundation is idempotent and must never block application boot */
  }
  try {
    observability.ensureObservabilityFoundation(db);
  } catch {
    /* Data Observability foundation is idempotent and must never block application boot */
  }
  try {
    deployment.ensureDeploymentFoundation(db);
  } catch {
    /* Deployment & Edition foundation is idempotent and must never block application boot */
  }
  // Audit & History Framework: propagate a request/correlation id on every
  // request and capture failed access attempts automatically.
  app.use(audit.auditContext());
  app.use(audit.captureApiFailures(db));

  // Optional audit-to-notifications bridge. Off by default so deployments opt
  // in explicitly; enable with AUDIT_NOTIFY_EVENTS=true.
  if (/^(1|true|yes)$/i.test(String(process.env.AUDIT_NOTIFY_EVENTS || ""))) {
    audit.createNotificationBridge(db);
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "helix-iam" });
  });

  const auth = requireAuth(db);
  const can = (resource, action) => requirePermission(db, resource, action);
  // Asynchronous pipeline for migrated route groups. A route uses either the
  // synchronous guards (`auth`/`can`) or the async ones (`authAsync`/`canAsync`),
  // never both, so its whole request path stays on one data layer.
  const authAsync = requireAuthAsync(db);
  const canAsync = (resource, action) => requirePermissionAsync(db, resource, action);

  async function handleLoginAsync(req, res) {
    res.json(await authentication.loginAsync(db, req.body || {}, requestMeta(req)));
  }

  app.post("/api/auth/login", wrap(handleLoginAsync));
  app.post("/api/authentication/login", wrap(handleLoginAsync));

  app.get(
    "/api/auth/me",
    authAsync,
    wrap(async (req, res) => {
      const currentTenant = req.tenantId
        ? tenants.publicTenant(await tenants.getTenantAsync(db, req.tenantId))
        : null;
      const capabilities = await deployment.Features.resolveCapabilitiesAsync(db);
      res.json({
        user: req.actor,
        access: await effectiveAccessAsync(db, req.actor.id),
        session: sessions.publicSession(req.sessionRow),
        mfa: await mfa.mfaStatusAsync(db, req.actor.id),
        tenant: currentTenant,
        tenants: (await tenants.switchableTenantsAsync(db, req.actor)).map(tenants.publicTenant),
        deployment: {
          mode: capabilities.mode,
          edition: capabilities.edition,
          features: capabilities.features,
          summary: capabilities.summary,
        },
      });
    })
  );

  async function handleLogoutAsync(req, res) {
    res.json(await sessions.logoutTokenAsync(db, req.sessionToken, req.actor, clientIp(req)));
  }

  app.post("/api/auth/logout", authAsync, wrap(handleLogoutAsync));
  app.post("/api/authentication/logout", authAsync, wrap(handleLogoutAsync));

  app.get(
    "/api/authentication/providers",
    wrap(async (_req, res) => {
      res.json({ items: await providers.listProvidersAsync(db, { enabledOnly: true }) });
    })
  );

  app.get(
    "/api/authentication/providers/admin",
    authAsync,
    canAsync("iam.authentication", "read"),
    wrap(async (_req, res) => {
      res.json({ items: await providers.listProvidersAsync(db) });
    })
  );

  app.get(
    "/api/authentication/settings",
    authAsync,
    canAsync("iam.authentication", "read"),
    wrap(async (_req, res) => {
      res.json(await authentication.authSettingsAsync(db));
    })
  );

  app.put(
    "/api/authentication/settings",
    authAsync,
    canAsync("iam.authentication", "update"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const values = body.values || {
        "auth.mfa_required": body.mfaRequired,
        "auth.jit_provision": body.jitProvision,
        "auth.rate_limit_max": body.rateLimitMax,
        "auth.rate_limit_window_seconds": body.rateLimitWindowSeconds,
        "auth.reset_token_minutes": body.resetTokenMinutes,
        "auth.revoke_sessions_on_reset": body.revokeSessionsOnReset,
        "identity.session_hours": body.sessionHours,
      };
      const patch = {};
      for (const [k, v] of Object.entries(values)) {
        if (v !== undefined) patch[k] = v;
      }
      await hierarchy.updateSettingsAsync(db, { values: patch }, req.actor, clientIp(req));
      res.json(await authentication.authSettingsAsync(db));
    })
  );

  app.post(
    "/api/authentication/providers",
    authAsync,
    canAsync("iam.authentication", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await providers.createProviderAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/authentication/providers/:id",
    authAsync,
    canAsync("iam.authentication", "update"),
    wrap(async (req, res) => {
      res.json(await providers.updateProviderAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/authentication/password-reset/request",
    wrap(async (req, res) => {
      await authentication.requestPasswordResetAsync(db, req.body || {}, requestMeta(req));
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/authentication/password-reset/complete",
    wrap(async (req, res) => {
      res.json(await authentication.completePasswordResetAsync(db, req.body || {}, requestMeta(req)));
    })
  );

  app.get(
    "/api/sessions",
    authAsync,
    wrap(async (req, res) => {
      res.json({ items: await sessions.listMySessionsAsync(db, req.actor.id) });
    })
  );

  app.delete(
    "/api/sessions/:id",
    authAsync,
    wrap(async (req, res) => {
      res.json(
        await sessions.revokeSessionAsync(db, req.params.id, req.actor, clientIp(req), { ownerId: req.actor.id })
      );
    })
  );

  app.post(
    "/api/sessions/revoke-all",
    authAsync,
    wrap(async (req, res) => {
      res.json(
        await sessions.revokeAllSessionsAsync(db, req.actor.id, req.actor, clientIp(req), {
          exceptToken: req.sessionToken,
        })
      );
    })
  );

  app.get(
    "/api/sessions/admin",
    authAsync,
    canAsync("iam.sessions", "read"),
    wrap(async (req, res) => {
      res.json(await sessions.listSessionsAsync(db, req.query));
    })
  );

  app.delete(
    "/api/sessions/admin/:id",
    authAsync,
    canAsync("iam.sessions", "delete"),
    wrap(async (req, res) => {
      res.json(await sessions.revokeSessionAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/mfa/status",
    authAsync,
    wrap(async (req, res) => {
      res.json(await mfa.mfaStatusAsync(db, req.actor.id));
    })
  );

  app.post(
    "/api/mfa/totp/enroll",
    authAsync,
    wrap(async (req, res) => {
      res.json(await mfa.enrollTotpAsync(db, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/totp/verify",
    authAsync,
    wrap(async (req, res) => {
      res.json(await mfa.verifyTotpEnrollmentAsync(db, req.actor, req.body?.code, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/totp/disable",
    authAsync,
    wrap(async (req, res) => {
      res.json(await mfa.disableTotpAsync(db, req.actor, req.body || {}, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/recovery/regenerate",
    authAsync,
    wrap(async (req, res) => {
      res.json(await mfa.regenerateRecoveryAsync(db, req.actor, req.body?.code, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/challenge/verify",
    wrap(async (req, res) => {
      res.json(await authentication.completeMfaAsync(db, req.body || {}, requestMeta(req)));
    })
  );

  app.post(
    "/api/mfa/admin/:userId/reset",
    authAsync,
    canAsync("iam.users", "execute"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.userId);
      res.json(await mfa.adminResetMfaAsync(db, req.params.userId, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/sso/providers",
    wrap(async (_req, res) => {
      const items = await providers.listProvidersAsync(db, { enabledOnly: true });
      res.json({ items: items.filter((p) => p.type !== "password") });
    })
  );

  app.post(
    "/api/sso/:code/start",
    wrap(async (req, res) => {
      res.json(await authentication.startSsoAsync(db, req.params.code, req.body || {}, requestMeta(req)));
    })
  );

  async function handleSsoCallback(req, res) {
    const body = { ...(req.query || {}), ...(req.body || {}) };
    res.json(await authentication.completeSsoAsync(db, req.params.code, body, requestMeta(req)));
  }

  app.post("/api/sso/:code/callback", wrap(handleSsoCallback));
  app.get("/api/sso/:code/callback", wrap(handleSsoCallback));

  app.get(
    "/api/sso/:code/metadata",
    wrap(async (req, res) => {
      res.json(await authentication.ssoMetadataAsync(db, req.params.code));
    })
  );

  app.get(
    "/api/tenants",
    authAsync,
    canAsync("iam.tenants", "read"),
    wrap(async (req, res) => {
      res.json(await tenants.listTenantsAsync(db, req.query));
    })
  );

  app.post(
    "/api/tenants",
    authAsync,
    canAsync("iam.tenants", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await tenants.createTenantAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/tenants/:id",
    authAsync,
    canAsync("iam.tenants", "read"),
    wrap(async (req, res) => {
      res.json(await tenants.getTenantAsync(db, req.params.id));
    })
  );

  app.put(
    "/api/tenants/:id",
    authAsync,
    canAsync("iam.tenants", "update"),
    wrap(async (req, res) => {
      res.json(await tenants.updateTenantAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/activate",
    authAsync,
    canAsync("iam.tenants", "update"),
    wrap(async (req, res) => {
      res.json(await tenants.setTenantStatusAsync(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/deactivate",
    authAsync,
    canAsync("iam.tenants", "update"),
    wrap(async (req, res) => {
      res.json(await tenants.setTenantStatusAsync(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/tenants/:id",
    authAsync,
    canAsync("iam.tenants", "delete"),
    wrap(async (req, res) => {
      res.json(await tenants.deleteTenantAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/select",
    authAsync,
    wrap(async (req, res) => {
      res.json(await tenants.selectTenantAsync(db, req.sessionToken, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/tenants/:id/context",
    authAsync,
    canAsync("iam.tenants", "read"),
    wrap(async (req, res) => {
      res.json(await tenants.tenantContextAsync(db, req.params.id));
    })
  );

  app.get(
    "/api/tenants/:id/config",
    authAsync,
    canAsync("iam.config", "read"),
    wrap(async (req, res) => {
      await tenants.getTenantAsync(db, req.params.id);
      res.json({
        scope: "tenant",
        scope_id: Number(req.params.id),
        items: await config.listScopeValuesAsync(db, "tenant", req.params.id),
        effective: await config.resolveAllAsync(db, { tenantId: req.params.id }),
      });
    })
  );

  app.put(
    "/api/tenants/:id/config",
    authAsync,
    canAsync("iam.config", "update"),
    wrap(async (req, res) => {
      await tenants.getTenantAsync(db, req.params.id);
      res.json(
        await config.putValuesAsync(
          db,
          { scope: "tenant", scopeId: req.params.id, values: req.body?.values || req.body || {} },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  app.get(
    "/api/config",
    authAsync,
    canAsync("iam.config", "read"),
    wrap(async (req, res) => {
      const organizationId = req.query.organizationId;
      if (organizationId) await scopedOrgAsync(db, req, organizationId);
      res.json(
        await config.catalogAndEffectiveAsync(db, {
          tenantId: req.tenantId,
          organizationId,
        })
      );
    })
  );

  app.put(
    "/api/config",
    authAsync,
    canAsync("iam.config", "update"),
    wrap(async (req, res) => {
      const scope = req.body?.scope;
      const scopeId = req.body?.scopeId ?? req.body?.scope_id;
      if (scope === "tenant") await tenants.getTenantAsync(db, scopeId);
      if (scope === "organization") await scopedOrgAsync(db, req, scopeId);
      res.json(
        await config.putValuesAsync(
          db,
          { scope, scopeId, values: req.body?.values || {} },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  // -------------------------------------------------------------------------
  // Configuration & Metadata Management
  // Global (system) metadata is stored with tenant_id = NULL and requires the
  // platform administrator; tenant metadata is isolated to the caller tenant.
  // -------------------------------------------------------------------------

  const canMeta = (action) => can("iam.metadata", action);
  const canMetaAsync = (action) => canAsync("iam.metadata", action);
  const metaRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);
  const metaReadAsync = (req, source) => metaReadTenantAsync(db, req.actor, source || req.query, req.tenantId);
  const metaWrite = (req, body) => metaWriteTenant(db, req.actor, body ?? req.body, req.tenantId);
  const metaWriteAsync = (req, body) => metaWriteTenantAsync(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/metadata/types",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.listTypesAsync(db, req.query, await metaReadAsync(req)));
    })
  );

  app.get(
    "/api/metadata/types/tree",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await metadata.typeTreeAsync(db, await metaReadAsync(req)) });
    })
  );

  app.post(
    "/api/metadata/types",
    authAsync,
    canMetaAsync("create"),
    wrap(async (req, res) => {
      const tenantId = await metaWriteAsync(req, req.body);
      res.status(201).json(await metadata.createTypeAsync(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/types/:id",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.getTypeAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/types/:id",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      const tenantId = await metaReadAsync(req);
      res.json(await metadata.updateTypeAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.delete(
    "/api/metadata/types/:id",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      res.json(await metadata.deleteTypeAsync(db, req.params.id, req.actor, clientIp(req), await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/types/:id/status",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.setTypeStatusAsync(
          db,
          req.params.id,
          req.body?.status,
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/types/:id/resolve",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.resolveTypeAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.get(
    "/api/metadata/types/:id/contract",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await metadata.attributeContractAsync(db, req.params.id, await metaReadAsync(req)) });
    })
  );

  app.post(
    "/api/metadata/types/:id/attributes",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(
        await metadata.addTypeAttributeAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.put(
    "/api/metadata/types/:id/attributes/:attributeId",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateTypeAttributeAsync(
          db,
          req.params.id,
          req.params.attributeId,
          req.body || {},
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.delete(
    "/api/metadata/types/:id/attributes/:attributeId",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.removeTypeAttributeAsync(
          db,
          req.params.id,
          req.params.attributeId,
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/attributes",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.listAttributesAsync(db, req.query, await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/attributes",
    authAsync,
    canMetaAsync("create"),
    wrap(async (req, res) => {
      const tenantId = await metaWriteAsync(req, req.body);
      res.status(201).json(await metadata.createAttributeAsync(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/attributes/:id",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.getAttributeAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/attributes/:id",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateAttributeAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/metadata/attributes/:id",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      const attribute = await metadata.getAttributeAsync(db, req.params.id, await metaReadAsync(req));
      // Attributes are retained when referenced so records keep their contract.
      res.json(
        await metadata.setAttributeStatusAsync(db, attribute.id, "inactive", req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.post(
    "/api/metadata/attributes/:id/status",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.setAttributeStatusAsync(
          db,
          req.params.id,
          req.body?.status,
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/lovs",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.listLovsAsync(db, req.query, await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/lovs",
    authAsync,
    canMetaAsync("create"),
    wrap(async (req, res) => {
      const tenantId = await metaWriteAsync(req, req.body);
      res.status(201).json(await metadata.createLovAsync(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/lovs/:id",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.getLovAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/lovs/:id",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateLovAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/metadata/lovs/:id",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      res.json(await metadata.deleteLovAsync(db, req.params.id, req.actor, clientIp(req), await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/lovs/:id/status",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.setLovStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.get(
    "/api/metadata/lovs/:id/values",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const lov = await metadata.getLovAsync(db, req.params.id, await metaReadAsync(req));
      res.json({ items: await metadata.listValuesAsync(db, lov.id) });
    })
  );

  app.post(
    "/api/metadata/lovs/:id/values",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await metadata.addValueAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/lovs/:id/values/:valueId",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateValueAsync(
          db,
          req.params.id,
          req.params.valueId,
          req.body || {},
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.delete(
    "/api/metadata/lovs/:id/values/:valueId",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.removeValueAsync(
          db,
          req.params.id,
          req.params.valueId,
          req.actor,
          clientIp(req),
          await metaReadAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/lovs/:id/cascade",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json({
        items: await metadata.cascadeOptionsAsync(
          db,
          req.params.id,
          req.query.parentValueId ?? req.query.parent_value_id,
          await metaReadAsync(req)
        ),
      });
    })
  );

  app.get(
    "/api/metadata/lovs/:id/usage",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await metadata.listUsageAsync(db, req.params.id) });
    })
  );

  app.get(
    "/api/metadata/forms",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.listFormsAsync(db, req.query, await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/forms",
    authAsync,
    canMetaAsync("create"),
    wrap(async (req, res) => {
      const tenantId = await metaWriteAsync(req, req.body);
      res.status(201).json(await metadata.createFormAsync(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/forms/:id",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.getFormAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/forms/:id",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateFormAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/metadata/forms/:id",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      res.json(await metadata.deleteFormAsync(db, req.params.id, req.actor, clientIp(req), await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/forms/:id/status",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.setFormStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.put(
    "/api/metadata/forms/:id/layout",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.replaceLayoutAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.get(
    "/api/metadata/forms/:id/versions",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await metadata.formVersionsAsync(db, req.params.id) });
    })
  );

  app.get(
    "/api/metadata/forms/:id/render",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.renderFormAsync(db, req.params.id, await metaReadAsync(req), { mode: req.query.mode }));
    })
  );

  app.post(
    "/api/metadata/forms/:id/render",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const tenantId = await metaReadAsync(req);
      res.json(
        await metadata.renderFormAsync(db, req.params.id, tenantId, {
          mode: req.body?.mode,
          values: req.body?.values || {},
          context: req.body?.context || {},
        })
      );
    })
  );

  app.get(
    "/api/metadata/rules",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.listRulesAsync(db, req.query, await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/rules",
    authAsync,
    canMetaAsync("create"),
    wrap(async (req, res) => {
      const tenantId = await metaWriteAsync(req, req.body);
      res.status(201).json(await metadata.createRuleAsync(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/rules/:id",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      res.json(await metadata.getRuleAsync(db, req.params.id, await metaReadAsync(req)));
    })
  );

  app.put(
    "/api/metadata/rules/:id",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.updateRuleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/metadata/rules/:id",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      res.json(await metadata.deleteRuleAsync(db, req.params.id, req.actor, clientIp(req), await metaReadAsync(req)));
    })
  );

  app.post(
    "/api/metadata/rules/:id/status",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await metadata.setRuleStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await metaReadAsync(req))
      );
    })
  );

  app.post(
    "/api/metadata/rules/:id/test",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const rule = await metadata.getRuleAsync(db, req.params.id, await metaReadAsync(req));
      res.json(metadata.testRule(db, rule, req.body?.context || {}));
    })
  );

  app.post(
    "/api/metadata/validate",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const tenantId = await metaReadAsync(req, { ...req.query, ...(req.body || {}) });
      res.json(await metadata.validateRecordAsync(db, req.body || {}, tenantId));
    })
  );

  app.get(
    "/api/metadata/configurations",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const scope = req.query.scope || "system";
      const scopeId = req.query.scopeId ?? req.query.scope_id;
      if (scope === "organization" && scopeId) await scopedOrgAsync(db, req, scopeId);
      res.json({
        items: await metadata.listConfigurationsAsync(db, { scope, scopeId, artifactType: req.query.artifactType }),
      });
    })
  );

  app.get(
    "/api/metadata/configurations/effective",
    authAsync,
    canMetaAsync("read"),
    wrap(async (req, res) => {
      const organizationId = req.query.organizationId;
      if (organizationId) await scopedOrgAsync(db, req, organizationId);
      res.json({
        items: await metadata.effectiveCatalogAsync(db, {
          artifactType: req.query.artifactType,
          tenantId: req.tenantId,
          organizationId,
        }),
      });
    })
  );

  app.post(
    "/api/metadata/configurations",
    authAsync,
    canMetaAsync("update"),
    wrap(async (req, res) => {
      const scope = req.body?.scope || "system";
      const scopeId = req.body?.scopeId ?? req.body?.scope_id;
      if (scope === "tenant") await tenants.getTenantAsync(db, scopeId);
      if (scope === "organization") await scopedOrgAsync(db, req, scopeId);
      res.json(await metadata.setConfigurationAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/metadata/configurations",
    authAsync,
    canMetaAsync("delete"),
    wrap(async (req, res) => {
      res.json(
        await metadata.deleteConfigurationAsync(
          db,
          {
            scope: req.query.scope || "system",
            scopeId: req.query.scopeId ?? req.query.scope_id,
            artifactType: req.query.artifactType,
            artifactId: req.query.artifactId,
          },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  // -------------------------------------------------------------------------
  // Object & Relationship Framework
  // Business objects are metadata-typed instances; relationships, references
  // and dependencies are tenant-isolated. Object IAM sub-resources gate each
  // concern independently.
  // -------------------------------------------------------------------------

  const canObjects = (action) => can("iam.objects", action);
  const canObjectsAsync = (action) => canAsync("iam.objects", action);
  const canRelationships = (action) => can("iam.objects.relationships", action);
  const canReferences = (action) => can("iam.objects.references", action);
  const canDependencies = (action) => can("iam.objects.dependencies", action);
  const canRelationshipsAsync = (action) => canAsync("iam.objects.relationships", action);
  const canReferencesAsync = (action) => canAsync("iam.objects.references", action);
  const canDependenciesAsync = (action) => canAsync("iam.objects.dependencies", action);
  const relTypeRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);
  const relTypeReadAsync = (req, source) => metaReadTenantAsync(db, req.actor, source || req.query, req.tenantId);

  app.get(
    "/api/object-types",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.objectTypesAsync(db, req.tenantId));
    })
  );

  app.get(
    "/api/object-types/:id/form",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(
        await metadata.renderTypeAsync(db, req.params.id, req.tenantId, {
          mode: req.query.mode || "create",
        })
      );
    })
  );

  app.get(
    "/api/objects/summary",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.objectSummaryAsync(db, req.tenantId));
    })
  );

  app.get(
    "/api/objects",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.listObjectsAsync(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/objects",
    authAsync,
    canObjectsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await objects.createObjectAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/bulk",
    authAsync,
    canObjectsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await objects.bulkCreateObjectsAsync(db, req.body?.items || [], req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.patch(
    "/api/objects/bulk",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.bulkMutateObjectsAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.getObjectAsync(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/objects/:id",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.updateObjectAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/objects/:id",
    authAsync,
    canObjectsAsync("delete"),
    wrap(async (req, res) => {
      const force = req.query.force === "true" || req.query.force === true;
      res.json(
        await objects.softDeleteObjectAsync(db, req.params.id, { force, summary: req.query.summary }, req.actor, req.tenantId, clientIp(req))
      );
    })
  );

  app.post(
    "/api/objects/:id/restore",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.restoreObjectAsync(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/status",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.setObjectStatusAsync(db, req.params.id, req.body?.status, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/checkout",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.checkoutObjectAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/checkin",
    authAsync,
    canObjectsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.checkinObjectAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id/locks",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.objectLocksAsync(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/versions",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.listObjectVersionsAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/versions/:revision",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.getObjectVersionAsync(db, req.params.id, req.params.revision, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/relationships",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.relationshipsForObjectAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/tree",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.traverseAsync(db, req.params.id, req.query, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/graph",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.graphAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/dependencies",
    authAsync,
    canDependenciesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.directDependenciesAsync(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/safe-delete",
    authAsync,
    canDependenciesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.safeDeleteReportAsync(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/relationship-types",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.listRelationshipTypesAsync(db, req.query, await relTypeReadAsync(req)));
    })
  );

  app.post(
    "/api/relationship-types",
    authAsync,
    canRelationshipsAsync("create"),
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await objects.createRelationshipTypeAsync(db, req.body || {}, req.actor, clientIp(req), req.tenantId, req.query));
    })
  );

  app.get(
    "/api/relationship-types/:id",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.getRelationshipTypeAsync(db, req.params.id, await relTypeReadAsync(req)));
    })
  );

  app.put(
    "/api/relationship-types/:id",
    authAsync,
    canRelationshipsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await objects.updateRelationshipTypeAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId)
      );
    })
  );

  app.post(
    "/api/relationship-types/:id/status",
    authAsync,
    canRelationshipsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await objects.setRelationshipTypeStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId)
      );
    })
  );

  app.delete(
    "/api/relationship-types/:id",
    authAsync,
    canRelationshipsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await objects.deleteRelationshipTypeAsync(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/relationships",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.listRelationshipsAsync(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/relationships/validate",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.validateRelationshipAsync(db, req.body || {}, req.tenantId));
    })
  );

  app.post(
    "/api/relationships",
    authAsync,
    canRelationshipsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await objects.createRelationshipAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/relationships/:id",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.getRelationshipAsync(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/relationships/:id",
    authAsync,
    canRelationshipsAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.updateRelationshipAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/relationships/:id/validate",
    authAsync,
    canRelationshipsAsync("read"),
    wrap(async (req, res) => {
      const existing = await objects.getRelationshipAsync(db, req.params.id, req.tenantId);
      res.json(
        await objects.validateRelationshipAsync(
          db,
          {
            ...(req.body || {}),
            type: existing.relationship_type_id,
            source: existing.source.id,
            target: existing.target.id,
          },
          req.tenantId
        )
      );
    })
  );

  app.delete(
    "/api/relationships/:id",
    authAsync,
    canRelationshipsAsync("delete"),
    wrap(async (req, res) => {
      const force = req.query.force === "true" || req.query.force === true;
      res.json(await objects.deleteRelationshipAsync(db, req.params.id, { force }, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/references/orphans",
    authAsync,
    canReferencesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.orphanReferencesAsync(db, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/references",
    authAsync,
    canReferencesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.listReferencesAsync(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/references",
    authAsync,
    canReferencesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await objects.createReferenceAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/references/:id",
    authAsync,
    canReferencesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.getReferenceAsync(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/references/:id",
    authAsync,
    canReferencesAsync("update"),
    wrap(async (req, res) => {
      res.json(await objects.updateReferenceAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/references/:id",
    authAsync,
    canReferencesAsync("delete"),
    wrap(async (req, res) => {
      res.json(await objects.deleteReferenceAsync(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/dependencies/cycles",
    authAsync,
    canDependenciesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.detectCyclesAsync(db, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/dependencies/impact",
    authAsync,
    canDependenciesAsync("read"),
    wrap(async (req, res) => {
      const objectId = req.query.objectId ?? req.query.object_id ?? req.query.id;
      if (!objectId) throw new HttpError(400, "objectId is required");
      res.json(await objects.impactOfAsync(db, objectId, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/dependencies/:objectId",
    authAsync,
    canDependenciesAsync("read"),
    wrap(async (req, res) => {
      res.json(await objects.directDependenciesAsync(db, req.params.objectId, req.tenantId));
    })
  );

  // -------------------------------------------------------------------------
  // Lifecycle Management
  // Configurable statuses, lifecycle state machines, transition rules and the
  // release/approval engine. Configuration is global-or-tenant metadata gated by
  // iam.lifecycle.* sub-resources; object transitions re-use the object IAM.
  // -------------------------------------------------------------------------

  // Async twins for the migrated lifecycle routes.
  const canLifecycleStatusesAsync = (action) => canAsync("iam.lifecycle.statuses", action);
  const canLifecycleDefinitionsAsync = (action) => canAsync("iam.lifecycle.definitions", action);
  const canLifecycleTransitionsAsync = (action) => canAsync("iam.lifecycle.transitions", action);
  const canReleaseRulesAsync = (action) => canAsync("iam.lifecycle.release-rules", action);
  const canApprovalsAsync = (action) => canAsync("iam.lifecycle.approvals", action);
  const canLifecycleAsync = (action) => canAsync("iam.lifecycle", action);
  const lifecycleReadAsync = (req, source) => metaReadTenantAsync(db, req.actor, source || req.query, req.tenantId);
  const lifecycleWriteAsync = (req, body) => metaWriteTenantAsync(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/statuses",
    authAsync,
    canLifecycleStatusesAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listStatusesAsync(db, req.query, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/statuses",
    authAsync,
    canLifecycleStatusesAsync("create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(201).json(await lifecycle.createStatusAsync(db, body, req.actor, clientIp(req), await lifecycleWriteAsync(req, body)));
    })
  );

  app.get(
    "/api/statuses/:id",
    authAsync,
    canLifecycleStatusesAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.getStatusAsync(db, req.params.id, await lifecycleReadAsync(req)));
    })
  );

  app.put(
    "/api/statuses/:id",
    authAsync,
    canLifecycleStatusesAsync("update"),
    wrap(async (req, res) => {
      res.json(await lifecycle.updateStatusAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/statuses/:id/status",
    authAsync,
    canLifecycleStatusesAsync("update"),
    wrap(async (req, res) => {
      res.json(await lifecycle.setStatusStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.delete(
    "/api/statuses/:id",
    authAsync,
    canLifecycleStatusesAsync("delete"),
    wrap(async (req, res) => {
      res.json(await lifecycle.deleteStatusAsync(db, req.params.id, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.get(
    "/api/lifecycle-definitions",
    authAsync,
    canLifecycleDefinitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listDefinitionsAsync(db, req.query, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/lifecycle-definitions",
    authAsync,
    canLifecycleDefinitionsAsync("create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(201).json(await lifecycle.createDefinitionAsync(db, body, req.actor, clientIp(req), await lifecycleWriteAsync(req, body)));
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id",
    authAsync,
    canLifecycleDefinitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.getDefinitionAsync(db, req.params.id, await lifecycleReadAsync(req)));
    })
  );

  app.put(
    "/api/lifecycle-definitions/:id",
    authAsync,
    canLifecycleDefinitionsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.updateDefinitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req))
      );
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/status",
    authAsync,
    canLifecycleDefinitionsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.setDefinitionStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await lifecycleReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/lifecycle-definitions/:id",
    authAsync,
    canLifecycleDefinitionsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await lifecycle.deleteDefinitionAsync(db, req.params.id, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id/versions",
    authAsync,
    canLifecycleDefinitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listVersionsAsync(db, req.params.id, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/versions",
    authAsync,
    canLifecycleDefinitionsAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(
        await lifecycle.createVersionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req))
      );
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id/validate",
    authAsync,
    canLifecycleDefinitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.validateDefinitionAsync(db, req.params.id, await lifecycleReadAsync(req), { version: req.query.version })
      );
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/publish",
    authAsync,
    canLifecycleDefinitionsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.publishDefinitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req))
      );
    })
  );

  app.get(
    "/api/lifecycle-states",
    authAsync,
    canLifecycleTransitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listStatesAsync(db, req.query, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/lifecycle-states",
    authAsync,
    canLifecycleTransitionsAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(await lifecycle.createStateAsync(db, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.put(
    "/api/lifecycle-states/:id",
    authAsync,
    canLifecycleTransitionsAsync("update"),
    wrap(async (req, res) => {
      res.json(await lifecycle.updateStateAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.delete(
    "/api/lifecycle-states/:id",
    authAsync,
    canLifecycleTransitionsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await lifecycle.deleteStateAsync(db, req.params.id, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.get(
    "/api/lifecycle-transitions",
    authAsync,
    canLifecycleTransitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listTransitionsAsync(db, req.query, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/lifecycle-transitions",
    authAsync,
    canLifecycleTransitionsAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(await lifecycle.createTransitionAsync(db, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.put(
    "/api/lifecycle-transitions/:id",
    authAsync,
    canLifecycleTransitionsAsync("update"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.updateTransitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await lifecycleReadAsync(req))
      );
    })
  );

  app.delete(
    "/api/lifecycle-transitions/:id",
    authAsync,
    canLifecycleTransitionsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await lifecycle.deleteTransitionAsync(db, req.params.id, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  app.get(
    "/api/lifecycle-assignments",
    authAsync,
    canLifecycleDefinitionsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.listAssignmentsAsync(db, req.query, await lifecycleReadAsync(req)));
    })
  );

  app.post(
    "/api/lifecycle-assignments",
    authAsync,
    canLifecycleDefinitionsAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(await lifecycle.createAssignmentAsync(db, req.body || {}, req.actor, clientIp(req), await lifecycleWriteAsync(req)));
    })
  );

  app.delete(
    "/api/lifecycle-assignments/:id",
    authAsync,
    canLifecycleDefinitionsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await lifecycle.deleteAssignmentAsync(db, req.params.id, req.actor, clientIp(req), await lifecycleReadAsync(req)));
    })
  );

  const ruleRoutes = (base, kind, gate, readAsync, writeAsync) => {
    app.get(
      base,
      authAsync,
      gate("read"),
      wrap(async (req, res) => {
        res.json(await lifecycle.listRulesAsync(db, { ...req.query, kind }, await readAsync(req)));
      })
    );
    app.get(
      `${base}/:id`,
      authAsync,
      gate("read"),
      wrap(async (req, res) => {
        res.json(await lifecycle.getRuleAsync(db, req.params.id, await readAsync(req)));
      })
    );
    app.post(
      base,
      authAsync,
      gate("create"),
      wrap(async (req, res) => {
        const body = { ...(req.body || {}), kind };
        res.status(201).json(await lifecycle.createRuleAsync(db, body, req.actor, clientIp(req), await writeAsync(req, body)));
      })
    );
    app.put(
      `${base}/:id`,
      authAsync,
      gate("update"),
      wrap(async (req, res) => {
        res.json(await lifecycle.updateRuleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await readAsync(req)));
      })
    );
    app.delete(
      `${base}/:id`,
      authAsync,
      gate("delete"),
      wrap(async (req, res) => {
        res.json(await lifecycle.deleteRuleAsync(db, req.params.id, req.actor, clientIp(req), await readAsync(req)));
      })
    );
  };
  ruleRoutes("/api/release-rules", "release", canReleaseRulesAsync, lifecycleReadAsync, lifecycleWriteAsync);
  ruleRoutes("/api/approval-rules", "approval", canReleaseRulesAsync, lifecycleReadAsync, lifecycleWriteAsync);

  app.get(
    "/api/objects/:id/lifecycle",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.objectLifecycleAsync(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/transitions",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: (await lifecycle.objectLifecycleAsync(db, req.params.id, req.tenantId)).transitions });
    })
  );

  app.post(
    "/api/objects/:id/transitions",
    authAsync,
    canLifecycleAsync("execute"),
    wrap(async (req, res) => {
      res.json(await lifecycle.transitionObjectAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id/status-history",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.statusHistoryAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/objects/:id/release",
    authAsync,
    canReleaseRulesAsync("execute"),
    wrap(async (req, res) => {
      res.status(201).json(await lifecycle.requestObjectReleaseAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id/releases",
    authAsync,
    canObjectsAsync("read"),
    wrap(async (req, res) => {
      res.json(await lifecycle.objectReleasesAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/objects/:id/approvals/:approvalId",
    authAsync,
    canApprovalsAsync("execute"),
    wrap(async (req, res) => {
      res.json(
        await lifecycle.decideApprovalAsync(db, req.params.id, req.params.approvalId, req.body || {}, req.actor, req.tenantId, clientIp(req))
      );
    })
  );

  // Workflow & Process Engine: templates, designer, runtime instances, tasks,
  // approvals and configuration (routing, escalation, notifications, bindings,
  // delegations). Gated by iam.workflow.*; instances are tenant-scoped.
  const canWorkflowConfig = (action) => can("iam.workflow.config", action);
  // Async twins for the migrated workflow routes.
  const canWorkflowTemplatesAsync = (action) => canAsync("iam.workflow.templates", action);
  const canWorkflowDesignerAsync = (action) => canAsync("iam.workflow.designer", action);
  const canWorkflowInstancesAsync = (action) => canAsync("iam.workflow.instances", action);
  const canWorkflowTasksAsync = (action) => canAsync("iam.workflow.tasks", action);
  const canWorkflowApprovalsAsync = (action) => canAsync("iam.workflow.approvals", action);
  const canWorkflowConfigAsync = (action) => canAsync("iam.workflow.config", action);
  const canWorkflowAsync = (action) => canAsync("iam.workflow", action);
  const wfReadAsync = (req, source) => metaReadTenantAsync(db, req.actor, source || req.query, req.tenantId);
  const wfWriteAsync = (req, body) => metaWriteTenantAsync(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/workflow-templates",
    authAsync,
    canWorkflowTemplatesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listDefinitionsAsync(db, req.query, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates",
    authAsync,
    canWorkflowTemplatesAsync("create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.status(201).json(await workflow.createDefinitionAsync(db, body, req.actor, clientIp(req), await wfWriteAsync(req, body)));
    })
  );

  app.get(
    "/api/workflow-templates/:id",
    authAsync,
    canWorkflowTemplatesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.getDefinitionAsync(db, req.params.id, await wfReadAsync(req)));
    })
  );

  const updateWorkflowTemplate = wrap(async (req, res) => {
    res.json(await workflow.updateDefinitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
  });
  app.put("/api/workflow-templates/:id", authAsync, canWorkflowTemplatesAsync("update"), updateWorkflowTemplate);
  app.patch("/api/workflow-templates/:id", authAsync, canWorkflowTemplatesAsync("update"), updateWorkflowTemplate);

  app.post(
    "/api/workflow-templates/:id/status",
    authAsync,
    canWorkflowTemplatesAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.setDefinitionStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id",
    authAsync,
    canWorkflowTemplatesAsync("delete"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteDefinitionAsync(db, req.params.id, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.get(
    "/api/workflow-templates/:id/versions",
    authAsync,
    canWorkflowTemplatesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listVersionsAsync(db, req.params.id, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/versions",
    authAsync,
    canWorkflowTemplatesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createVersionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.get(
    "/api/workflow-templates/:id/versions/:version",
    authAsync,
    canWorkflowTemplatesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.getVersionAsync(db, req.params.id, req.params.version, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/validate",
    authAsync,
    canWorkflowTemplatesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.validateDefinitionAsync(db, req.params.id, await wfReadAsync(req), { version: req.body?.version ?? req.query.version }));
    })
  );

  app.post(
    "/api/workflow-templates/:id/publish",
    authAsync,
    canWorkflowTemplatesAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.publishDefinitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/clone",
    authAsync,
    canWorkflowTemplatesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.cloneDefinitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  // --- Designer -----------------------------------------------------------
  app.get(
    "/api/workflow-templates/:id/designer",
    authAsync,
    canWorkflowDesignerAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.designerContextAsync(db, req.params.id, await wfReadAsync(req), req.query));
    })
  );

  app.put(
    "/api/workflow-templates/:id/designer",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.saveDesignerGraphAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/nodes",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.addNodeAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-templates/:id/designer/nodes/:nodeId",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.patchNodeAsync(db, req.params.id, req.params.nodeId, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id/designer/nodes/:nodeId",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.removeNodeAsync(db, req.params.id, req.params.nodeId, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/transitions",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.addTransitionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-templates/:id/designer/transitions/:transitionId",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.patchTransitionAsync(db, req.params.id, req.params.transitionId, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id/designer/transitions/:transitionId",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.removeTransitionAsync(db, req.params.id, req.params.transitionId, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/auto-layout",
    authAsync,
    canWorkflowDesignerAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.applyAutoLayoutAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/validate",
    authAsync,
    canWorkflowDesignerAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.validateDesignerGraphAsync(db, req.params.id, req.body || {}, await wfReadAsync(req)));
    })
  );

  // --- Instances ----------------------------------------------------------
  app.get(
    "/api/workflow-instances",
    authAsync,
    canWorkflowInstancesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listInstancesAsync(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/workflow-instances",
    authAsync,
    canWorkflowInstancesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.startInstanceAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/workflow-instances/:id",
    authAsync,
    canWorkflowInstancesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.getInstanceAsync(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/workflow-instances/:id/nodes",
    authAsync,
    canWorkflowInstancesAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await workflow.instanceNodesAsync(db, req.params.id, req.tenantId) });
    })
  );

  app.get(
    "/api/workflow-instances/:id/history",
    authAsync,
    canWorkflowInstancesAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.instanceHistoryAsync(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/workflow-instances/:id/cancel",
    authAsync,
    canWorkflowInstancesAsync("execute"),
    wrap(async (req, res) => {
      res.json(
        await workflow.cancelInstanceAsync(db, req.params.id, {
          reason: req.body?.reason || req.body?.comments || "",
          actor: req.actor,
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/workflow-instances/:id/pause",
    authAsync,
    canWorkflowInstancesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.pauseInstanceAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/workflow-instances/:id/resume",
    authAsync,
    canWorkflowInstancesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.resumeInstanceAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/workflow-instances/:id/retry",
    authAsync,
    canWorkflowInstancesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.retryInstanceAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  // --- Tasks --------------------------------------------------------------
  app.get(
    "/api/tasks",
    authAsync,
    canWorkflowTasksAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listTasksAsync(db, req.query, req.tenantId, req.actor, { scope: req.query.scope || "mine" }));
    })
  );

  app.get(
    "/api/tasks/:id",
    authAsync,
    canWorkflowTasksAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.getTaskAsync(db, req.params.id, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/tasks/:id/complete",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.completeTaskAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/assign",
    authAsync,
    canWorkflowTasksAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.assignTaskAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/claim",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.claimTaskAsync(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/delegate",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.delegateTaskAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/status",
    authAsync,
    canWorkflowTasksAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.updateTaskStatusAsync(db, req.params.id, req.body?.status, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/tasks/:id/comments",
    authAsync,
    canWorkflowTasksAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await workflow.listCommentsAsync(db, req.params.id, req.tenantId) });
    })
  );

  app.post(
    "/api/tasks/:id/comments",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.addCommentAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.get(
    "/api/tasks/:id/attachments",
    authAsync,
    canWorkflowTasksAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await workflow.listAttachmentsAsync(db, req.params.id, req.tenantId) });
    })
  );

  app.post(
    "/api/tasks/:id/attachments",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.addAttachmentAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.post(
    "/api/tasks/:id/subtasks",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.addSubtaskAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.patch(
    "/api/tasks/:id/subtasks/:subtaskId",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.updateSubtaskAsync(db, req.params.id, req.params.subtaskId, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.delete(
    "/api/tasks/:id/subtasks/:subtaskId",
    authAsync,
    canWorkflowTasksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteSubtaskAsync(db, req.params.id, req.params.subtaskId, req.actor, req.tenantId));
    })
  );

  // --- Approvals ----------------------------------------------------------
  app.get(
    "/api/workflow-approvals",
    authAsync,
    canWorkflowApprovalsAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listApprovalsAsync(db, req.query, req.tenantId, req.actor, { scope: req.query.scope || "mine" }));
    })
  );

  app.get(
    "/api/workflow-approvals/:id",
    authAsync,
    canWorkflowApprovalsAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.getApprovalAsync(db, req.params.id, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/workflow-approvals/:id/decision",
    authAsync,
    canWorkflowApprovalsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.decideApprovalAsync(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  const approvalDecision = (decision) =>
    wrap(async (req, res) => {
      res.json(
        await workflow.decideApprovalAsync(db, req.params.id, { ...(req.body || {}), decision }, req.actor, req.tenantId, clientIp(req))
      );
    });
  app.post("/api/workflow-approvals/:id/approve", authAsync, canWorkflowApprovalsAsync("execute"), approvalDecision("approve"));
  app.post("/api/workflow-approvals/:id/reject", authAsync, canWorkflowApprovalsAsync("execute"), approvalDecision("reject"));
  app.post(
    "/api/workflow-approvals/:id/request-changes",
    authAsync,
    canWorkflowApprovalsAsync("execute"),
    approvalDecision("request_changes")
  );

  // --- Routing rules ------------------------------------------------------
  app.get(
    "/api/workflow-routing-rules",
    authAsync,
    canWorkflowConfigAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listRoutingRulesAsync(db, req.query, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-routing-rules",
    authAsync,
    canWorkflowConfigAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createRoutingRuleAsync(db, req.body || {}, req.actor, clientIp(req), await wfWriteAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-routing-rules/:id",
    authAsync,
    canWorkflowConfigAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.updateRoutingRuleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-routing-rules/:id",
    authAsync,
    canWorkflowConfigAsync("delete"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteRoutingRuleAsync(db, req.params.id, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  // --- Escalation ---------------------------------------------------------
  app.get(
    "/api/workflow-escalation-rules",
    authAsync,
    canWorkflowConfigAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listEscalationRulesAsync(db, req.query, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-escalation-rules",
    authAsync,
    canWorkflowConfigAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createEscalationRuleAsync(db, req.body || {}, req.actor, clientIp(req), await wfWriteAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-escalation-rules/:id",
    authAsync,
    canWorkflowConfigAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.updateEscalationRuleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-escalation-rules/:id",
    authAsync,
    canWorkflowConfigAsync("delete"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteEscalationRuleAsync(db, req.params.id, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-escalations/sweep",
    auth,
    canWorkflowConfig("execute"),
    wrap((req, res) => {
      res.json(workflow.sweepEscalations(db, { tenantId: req.tenantId }));
    })
  );

  // --- Notifications ------------------------------------------------------
  app.get(
    "/api/workflow-notifications",
    authAsync,
    canWorkflowAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listNotificationsAsync(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/workflow-notifications/:id/read",
    authAsync,
    canWorkflowAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.markNotificationReadAsync(db, req.params.id, req.tenantId, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/workflow-notification-templates",
    authAsync,
    canWorkflowConfigAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listTemplatesAsync(db, req.query, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-notification-templates",
    authAsync,
    canWorkflowConfigAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createTemplateAsync(db, req.body || {}, req.actor, clientIp(req), await wfWriteAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-notification-templates/:id",
    authAsync,
    canWorkflowConfigAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.updateTemplateAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-notification-templates/:id",
    authAsync,
    canWorkflowConfigAsync("delete"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteTemplateAsync(db, req.params.id, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  // --- Bindings -----------------------------------------------------------
  app.get(
    "/api/workflow-bindings",
    authAsync,
    canWorkflowConfigAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listBindingsAsync(db, req.query, await wfReadAsync(req)));
    })
  );

  app.post(
    "/api/workflow-bindings",
    authAsync,
    canWorkflowConfigAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createBindingAsync(db, req.body || {}, req.actor, clientIp(req), await wfWriteAsync(req)));
    })
  );

  app.patch(
    "/api/workflow-bindings/:id",
    authAsync,
    canWorkflowConfigAsync("update"),
    wrap(async (req, res) => {
      res.json(await workflow.updateBindingAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  app.delete(
    "/api/workflow-bindings/:id",
    authAsync,
    canWorkflowConfigAsync("delete"),
    wrap(async (req, res) => {
      res.json(await workflow.deleteBindingAsync(db, req.params.id, req.actor, clientIp(req), await wfReadAsync(req)));
    })
  );

  // --- Delegations --------------------------------------------------------
  app.get(
    "/api/workflow-delegations",
    authAsync,
    canWorkflowAsync("read"),
    wrap(async (req, res) => {
      res.json(await workflow.listDelegationsAsync(db, req.query, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/workflow-delegations",
    authAsync,
    canWorkflowAsync("execute"),
    wrap(async (req, res) => {
      res.status(201).json(await workflow.createDelegationAsync(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/workflow-delegations/:id",
    authAsync,
    canWorkflowAsync("execute"),
    wrap(async (req, res) => {
      res.json(await workflow.revokeDelegationAsync(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      res.json(await orgs.listOrganizationsAsync(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.get(
    "/api/organizations/tree",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      res.json(await orgs.organizationTreeAsync(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/organizations",
    authAsync,
    canAsync("iam.organizations", "create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.parent_id) await scopedOrgAsync(db, req, body.parent_id);
      const org = await orgs.createOrganizationAsync(db, body, req.actor, clientIp(req));
      res.status(201).json(org);
    })
  );

  app.get(
    "/api/organizations/:id",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.organizationDetailAsync(db, req.params.id));
    })
  );

  app.put(
    "/api/organizations/:id",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.updateOrganizationAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/organizations/:id",
    authAsync,
    canAsync("iam.organizations", "delete"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.deleteOrganizationAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/organizations/:id/activate",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.setOrganizationStatusAsync(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/organizations/:id/deactivate",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.setOrganizationStatusAsync(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations/:id/sites",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json({ items: await orgs.listSitesAsync(db, req.params.id) });
    })
  );

  app.get(
    "/api/organizations/:id/config",
    authAsync,
    canAsync("iam.config", "read"),
    wrap(async (req, res) => {
      const org = await scopedOrgAsync(db, req, req.params.id);
      res.json({
        scope: "organization",
        scope_id: Number(req.params.id),
        items: await config.listScopeValuesAsync(db, "organization", req.params.id),
        effective: await config.resolveAllAsync(db, {
          tenantId: org.tenant_id || req.tenantId,
          organizationId: req.params.id,
        }),
      });
    })
  );

  app.put(
    "/api/organizations/:id/config",
    authAsync,
    canAsync("iam.config", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(
        await config.putValuesAsync(
          db,
          { scope: "organization", scopeId: req.params.id, values: req.body?.values || req.body || {} },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  app.post(
    "/api/organizations/:id/sites",
    authAsync,
    canAsync("iam.organizations", "create"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      const site = await orgs.createOrganizationAsync(
        db,
        { ...(req.body || {}), kind: "site", parent_id: Number(req.params.id) },
        req.actor,
        clientIp(req)
      );
      res.status(201).json(site);
    })
  );

  app.post(
    "/api/organizations/:id/move",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      if (req.body?.parent_id) await scopedOrgAsync(db, req, req.body.parent_id);
      res.json(await orgs.moveOrganizationAsync(db, req.params.id, req.body?.parent_id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations/:id/members",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json({ items: await orgs.listMembersAsync(db, req.params.id) });
    })
  );

  app.post(
    "/api/organizations/:id/members",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      const { userId, isPrimary } = req.body || {};
      await scopedOrgAsync(db, req, req.params.id);
      if (!userId) throw new HttpError(400, "userId is required");
      await users.getUserAsync(db, userId, tenantFilter(req));
      res.status(201).json({
        items: await orgs.addMemberAsync(db, req.params.id, userId, isPrimary, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/organizations/:id/members/:userId",
    authAsync,
    canAsync("iam.organizations", "update"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json({
        items: await orgs.removeMemberAsync(db, req.params.id, req.params.userId, req.actor, clientIp(req)),
      });
    })
  );

  app.get(
    "/api/organizations/:id/context",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (req, res) => {
      await scopedOrgAsync(db, req, req.params.id);
      res.json(await orgs.organizationContextAsync(db, req.params.id));
    })
  );

  app.get(
    "/api/hierarchy",
    authAsync,
    canAsync("iam.organizations", "read"),
    wrap(async (_req, res) => {
      res.json(await hierarchy.getHierarchyAsync(db));
    })
  );

  app.get(
    "/api/platform/hierarchy",
    authAsync,
    canAsync("iam.platform", "read"),
    wrap(async (_req, res) => {
      res.json(await hierarchy.getHierarchyAsync(db, { includeInactive: true }));
    })
  );

  app.put(
    "/api/platform/hierarchy",
    authAsync,
    canAsync("iam.platform", "update"),
    wrap(async (req, res) => {
      res.json(await hierarchy.replaceHierarchyAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/platform/settings",
    authAsync,
    canAsync("iam.platform", "read"),
    wrap(async (_req, res) => {
      res.json(await hierarchy.getSettingsAsync(db));
    })
  );

  app.put(
    "/api/platform/settings",
    authAsync,
    canAsync("iam.platform", "update"),
    wrap(async (req, res) => {
      res.json(await hierarchy.updateSettingsAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  for (const [prefix, kind] of Object.entries(orgs.typedCollections(db))) {
    app.get(
      `/api/${prefix}`,
      authAsync,
      canAsync("iam.organizations", "read"),
      wrap(async (req, res) => {
        res.json(await orgs.listOrganizationsAsync(db, { ...req.query, kind, ...tenantFilter(req) }));
      })
    );
    app.post(
      `/api/${prefix}`,
      authAsync,
      canAsync("iam.organizations", "create"),
      wrap(async (req, res) => {
        if (req.body?.parent_id) await scopedOrgAsync(db, req, req.body.parent_id);
        const org = await orgs.createOrganizationAsync(
          db,
          { ...(req.body || {}), kind },
          req.actor,
          clientIp(req)
        );
        res.status(201).json(org);
      })
    );
    app.get(
      `/api/${prefix}/:id`,
      authAsync,
      canAsync("iam.organizations", "read"),
      wrap(async (req, res) => {
        await orgs.getOrganizationOfKindAsync(db, req.params.id, kind);
        await scopedOrgAsync(db, req, req.params.id);
        res.json(await orgs.organizationDetailAsync(db, req.params.id));
      })
    );
    app.put(
      `/api/${prefix}/:id`,
      authAsync,
      canAsync("iam.organizations", "update"),
      wrap(async (req, res) => {
        await orgs.getOrganizationOfKindAsync(db, req.params.id, kind);
        await scopedOrgAsync(db, req, req.params.id);
        res.json(
          await orgs.updateOrganizationAsync(db, req.params.id, { ...(req.body || {}), kind }, req.actor, clientIp(req))
        );
      })
    );
    app.delete(
      `/api/${prefix}/:id`,
      authAsync,
      canAsync("iam.organizations", "delete"),
      wrap(async (req, res) => {
        await orgs.getOrganizationOfKindAsync(db, req.params.id, kind);
        await scopedOrgAsync(db, req, req.params.id);
        res.json(await orgs.deleteOrganizationAsync(db, req.params.id, req.actor, clientIp(req)));
      })
    );
  }

  app.get(
    "/api/users",
    authAsync,
    canAsync("iam.users", "read"),
    wrap(async (req, res) => {
      res.json(await users.listUsersAsync(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/users",
    authAsync,
    canAsync("iam.users", "create"),
    wrap(async (req, res) => {
      const user = await users.createUserAsync(
        db,
        { ...(req.body || {}), contextTenantId: req.tenantId },
        req.actor,
        clientIp(req)
      );
      res.status(201).json(user);
    })
  );

  app.get(
    "/api/users/:id",
    authAsync,
    canAsync("iam.users", "read"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      const { user, groups: memberships, roles: assigned, organizations } =
        await users.userMembershipsAsync(db, req.params.id);
      res.json({
        ...user,
        groups: memberships,
        roles: assigned,
        organizations,
        access: await effectiveAccessAsync(db, req.params.id),
      });
    })
  );

  app.put(
    "/api/users/:id",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json(await users.updateUserAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/activate",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json(await users.setUserStatusAsync(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/deactivate",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json(await users.setUserStatusAsync(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/lock",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json(await users.setUserStatusAsync(db, req.params.id, "locked", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/unlock",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json(await users.setUserStatusAsync(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/reset-password",
    authAsync,
    canAsync("iam.users", "execute"),
    wrap(async (req, res) => {
      const { password } = req.body || {};
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      if (!password) throw new HttpError(400, "password is required");
      res.json(await users.resetPasswordAsync(db, req.params.id, password, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/groups",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      const { groupId } = req.body || {};
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      if (!groupId) throw new HttpError(400, "groupId is required");
      await groups.getGroupAsync(db, groupId, tenantFilter(req));
      res.json({ members: await groups.addGroupMemberAsync(db, groupId, req.params.id, req.actor, clientIp(req)) });
    })
  );

  app.delete(
    "/api/users/:id/groups/:groupId",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      await groups.getGroupAsync(db, req.params.groupId, tenantFilter(req));
      res.json({
        members: await groups.removeGroupMemberAsync(db, req.params.groupId, req.params.id, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/users/:id/roles",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      const { roleId, organizationId } = req.body || {};
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      if (!roleId) throw new HttpError(400, "roleId is required");
      if (organizationId) await scopedOrgAsync(db, req, organizationId);
      res.json({
        roles: await roles.assignUserRoleAsync(db, req.params.id, roleId, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/users/:id/roles/:roleId",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json({
        roles: await roles.unassignUserRoleAsync(
          db,
          req.params.id,
          req.params.roleId,
          req.query.organizationId,
          req.actor,
          clientIp(req)
        ),
      });
    })
  );

  app.get(
    "/api/users/:id/organizations",
    authAsync,
    canAsync("iam.users", "read"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      res.json({ items: await orgs.listUserOrganizationsAsync(db, req.params.id) });
    })
  );

  app.post(
    "/api/users/:id/organizations",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      const { organizationId, isPrimary } = req.body || {};
      if (!organizationId) throw new HttpError(400, "organizationId is required");
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      await scopedOrgAsync(db, req, organizationId);
      await orgs.addMemberAsync(db, organizationId, req.params.id, isPrimary, req.actor, clientIp(req));
      res.status(201).json({ items: await orgs.listUserOrganizationsAsync(db, req.params.id) });
    })
  );

  app.delete(
    "/api/users/:id/organizations/:orgId",
    authAsync,
    canAsync("iam.users", "update"),
    wrap(async (req, res) => {
      await users.getUserAsync(db, req.params.id, tenantFilter(req));
      await scopedOrgAsync(db, req, req.params.orgId);
      await orgs.removeMemberAsync(db, req.params.orgId, req.params.id, req.actor, clientIp(req));
      res.json({ items: await orgs.listUserOrganizationsAsync(db, req.params.id) });
    })
  );

  app.get(
    "/api/groups",
    authAsync,
    canAsync("iam.groups", "read"),
    wrap(async (req, res) => {
      res.json(await groups.listGroupsAsync(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/groups",
    authAsync,
    canAsync("iam.groups", "create"),
    wrap(async (req, res) => {
      if (req.body?.organization_id) await scopedOrgAsync(db, req, req.body.organization_id);
      const group = await groups.createGroupAsync(
        db,
        { ...(req.body || {}), tenant_id: req.tenantId },
        req.actor,
        clientIp(req)
      );
      res.status(201).json(group);
    })
  );

  app.get(
    "/api/groups/:id",
    authAsync,
    canAsync("iam.groups", "read"),
    wrap(async (req, res) => {
      const group = await groups.getGroupAsync(db, req.params.id, tenantFilter(req));
      const [members, roles_, ancestors] = await Promise.all([
        groups.listGroupMembersAsync(db, req.params.id),
        roles.listGroupRolesAsync(db, req.params.id),
        groups.ancestorGroupsAsync(db, req.params.id),
      ]);
      res.json({ ...group, members, roles: roles_, ancestors: ancestors.slice(1) });
    })
  );

  app.put(
    "/api/groups/:id",
    authAsync,
    canAsync("iam.groups", "update"),
    wrap(async (req, res) => {
      await groups.getGroupAsync(db, req.params.id, tenantFilter(req));
      if (req.body?.organization_id) await scopedOrgAsync(db, req, req.body.organization_id);
      res.json(await groups.updateGroupAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/groups/:id",
    authAsync,
    canAsync("iam.groups", "delete"),
    wrap(async (req, res) => {
      await groups.getGroupAsync(db, req.params.id, tenantFilter(req));
      res.json(await groups.deleteGroupAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/groups/:id/members",
    authAsync,
    canAsync("iam.groups", "read"),
    wrap(async (req, res) => {
      await groups.getGroupAsync(db, req.params.id, tenantFilter(req));
      res.json({ items: await groups.listGroupMembersAsync(db, req.params.id) });
    })
  );

  app.post(
    "/api/groups/:id/members",
    authAsync,
    canAsync("iam.groups", "update"),
    wrap(async (req, res) => {
      const { userId } = req.body || {};
      await groups.getGroupAsync(db, req.params.id, tenantFilter(req));
      if (!userId) throw new HttpError(400, "userId is required");
      await users.getUserAsync(db, userId, tenantFilter(req));
      res.json({ items: await groups.addGroupMemberAsync(db, req.params.id, userId, req.actor, clientIp(req)) });
    })
  );

  app.delete(
    "/api/groups/:id/members/:userId",
    authAsync,
    canAsync("iam.groups", "update"),
    wrap(async (req, res) => {
      res.json({
        items: await groups.removeGroupMemberAsync(db, req.params.id, req.params.userId, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/groups/:id/roles",
    authAsync,
    canAsync("iam.groups", "update"),
    wrap(async (req, res) => {
      const { roleId, organizationId } = req.body || {};
      if (!roleId) throw new HttpError(400, "roleId is required");
      res.json({
        roles: await roles.assignGroupRoleAsync(db, req.params.id, roleId, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/groups/:id/roles/:roleId",
    authAsync,
    canAsync("iam.groups", "update"),
    wrap(async (req, res) => {
      res.json({
        roles: await roles.unassignGroupRoleAsync(
          db,
          req.params.id,
          req.params.roleId,
          req.query.organizationId,
          req.actor,
          clientIp(req)
        ),
      });
    })
  );

  app.get(
    "/api/roles",
    authAsync,
    canAsync("iam.roles", "read"),
    wrap(async (req, res) => {
      res.json(await roles.listRolesAsync(db, req.query));
    })
  );

  app.post(
    "/api/roles",
    authAsync,
    canAsync("iam.roles", "create"),
    wrap(async (req, res) => {
      const role = await roles.createRoleAsync(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(role);
    })
  );

  app.get(
    "/api/roles/:id",
    authAsync,
    canAsync("iam.roles", "read"),
    wrap(async (req, res) => {
      const role = await roles.getRoleAsync(db, req.params.id);
      const [ancestors, assignments, permissions] = await Promise.all([
        roles.ancestorRolesAsync(db, req.params.id),
        roles.roleAssignmentsAsync(db, req.params.id),
        grants.listRolePermissionsAsync(db, req.params.id),
      ]);
      res.json({ ...role, ancestors: ancestors.slice(1), assignments, permissions });
    })
  );

  app.put(
    "/api/roles/:id",
    authAsync,
    canAsync("iam.roles", "update"),
    wrap(async (req, res) => {
      res.json(await roles.updateRoleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/roles/:id",
    authAsync,
    canAsync("iam.roles", "delete"),
    wrap(async (req, res) => {
      res.json(await roles.deleteRoleAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/roles/:id/users",
    authAsync,
    canAsync("iam.roles", "update"),
    wrap(async (req, res) => {
      const { userId, organizationId } = req.body || {};
      if (!userId) throw new HttpError(400, "userId is required");
      res.json({
        roles: await roles.assignUserRoleAsync(db, userId, req.params.id, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/roles/:id/groups",
    authAsync,
    canAsync("iam.roles", "update"),
    wrap(async (req, res) => {
      const { groupId, organizationId } = req.body || {};
      if (!groupId) throw new HttpError(400, "groupId is required");
      res.json({
        roles: await roles.assignGroupRoleAsync(db, groupId, req.params.id, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.get(
    "/api/password-policy",
    authAsync,
    canAsync("iam.policy", "read"),
    wrap(async (_req, res) => {
      res.json(await policy.getPolicyAsync(db));
    })
  );

  app.put(
    "/api/password-policy",
    authAsync,
    canAsync("iam.policy", "update"),
    wrap(async (req, res) => {
      const next = await policy.updatePolicyAsync(db, req.body || {});
      await writeAuditAsync(db, {
        actor: req.actor,
        action: "policy.update",
        resourceType: "password_policy",
        resourceId: 1,
        details: next,
        ip: clientIp(req),
      });
      res.json(next);
    })
  );

  app.get(
    "/api/audit-logs",
    authAsync,
    canAsync("iam.audit", "read"),
    wrap(async (req, res) => {
      const page = pagination(req.query);
      res.json(
        await audit.listAuditLogsAsync(db, {
          ...page,
          action: req.query.action,
          resourceType: req.query.resourceType,
          q: req.query.q,
          scope: await auditScopeAsync(req),
        })
      );
    })
  );

  // ── Audit & History Framework ────────────────────────────────────────────
  function auditScope(req) {
    return {
      tenantId: req.tenantId || -1,
      scopeAll: tenants.isPlatformAdmin(db, req.actor.id),
    };
  }

  async function auditScopeAsync(req) {
    return {
      tenantId: req.tenantId || -1,
      scopeAll: await tenants.isPlatformAdminAsync(db, req.actor.id),
    };
  }

  function eventFilters(req) {
    return {
      page: req.query.page,
      pageSize: req.query.pageSize,
      sort: req.query.sort,
      order: req.query.order,
      objectType: req.query.objectType || req.query.resourceType,
      objectId: req.query.objectId,
      actorId: req.query.actorId,
      actorUsername: req.query.actorUsername,
      actorType: req.query.actorType,
      action: req.query.action,
      category: req.query.category,
      eventType: req.query.eventType,
      source: req.query.source,
      status: req.query.status,
      securityClassification: req.query.securityClassification,
      retentionCategory: req.query.retentionCategory,
      sessionId: req.query.sessionId,
      objectRevision: req.query.objectRevision,
      relatedResourceType: req.query.relatedResourceType || req.query.relatedObjectType,
      relatedResourceId: req.query.relatedResourceId || req.query.relatedObjectId,
      changedAttribute: req.query.changedAttribute || req.query.attribute,
      hasChanges: req.query.hasChanges,
      failureCategory: req.query.failureCategory,
      organizationId: req.query.organizationId,
      correlationId: req.query.correlationId,
      parentEventId: req.query.parentEventId,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
      tenantId: req.query.tenantId,
    };
  }

  // Enforces per-object audit visibility from the effective policy before
  // returning history. The route permission gates the feature; this gate
  // decides whether this particular caller may read this object's history.
  function assertHistoryVisible(req, objectType) {
    if (tenants.isPlatformAdmin(db, req.actor.id)) return;
    const { policy } = audit.resolvePolicy(db, req.tenantId, objectType);
    if (policy.visibility === "admin") {
      const check = authorization.checkPermission(db, req.actor.id, "iam.audit.events", "read");
      if (!check.allowed) throw new HttpError(403, "Audit history for this object requires administrator access");
      return;
    }
    if (policy.visibility === "manager") {
      const check = authorization.checkPermission(db, req.actor.id, "iam.objects.instances", "read");
      if (!check.allowed) throw new HttpError(403, "You do not have manager access to this object's history");
      return;
    }
    // "user" visibility: any caller holding the object-history permission may
    // read this object's timeline; rows remain tenant-scoped by the query.
  }

  async function assertHistoryVisibleAsync(req, objectType) {
    if (await tenants.isPlatformAdminAsync(db, req.actor.id)) return;
    const { policy } = await audit.resolvePolicyAsync(db, req.tenantId, objectType);
    if (policy.visibility === "admin") {
      const check = await authorization.checkPermissionAsync(db, req.actor.id, "iam.audit.events", "read");
      if (!check.allowed) throw new HttpError(403, "Audit history for this object requires administrator access");
      return;
    }
    if (policy.visibility === "manager") {
      const check = await authorization.checkPermissionAsync(db, req.actor.id, "iam.objects.instances", "read");
      if (!check.allowed) throw new HttpError(403, "You do not have manager access to this object's history");
      return;
    }
  }

  app.get(
    "/api/audit/events",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.listEventsAsync(db, eventFilters(req), await auditScopeAsync(req)));
    })
  );

  app.get(
    "/api/audit/summary",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.auditSummaryAsync(db, eventFilters(req), await auditScopeAsync(req)));
    })
  );

  app.get(
    "/api/audit/facets",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.eventFacetsAsync(db, eventFilters(req), await auditScopeAsync(req)));
    })
  );

  app.get(
    "/api/audit/events/:id",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.getEventAsync(db, req.params.id, await auditScopeAsync(req)));
    })
  );

  app.post(
    "/api/audit/events",
    auth,
    can("iam.audit.events", "create"),
    wrap((req, res) => {
      const body = req.body || {};
      const result = audit.capture(
        db,
        audit.auditFromRequest(req, {
          action: body.action,
          event_type: body.event_type,
          object_type: body.objectType || body.object_type,
          object_id: body.objectId || body.object_id,
          object_name: body.objectName || body.object_name,
          status: body.status,
          source: body.source || "api",
          reason: body.reason,
          details: body.details,
          before: body.before,
          after: body.after,
          related: body.related,
          parent_event_id: body.parentEventId || body.parent_event_id,
          correlation_id: body.correlationId || body.correlation_id,
          organization_id: body.organizationId || body.organization_id,
          error_message: body.errorMessage || body.error_message,
        })
      );
      if (!result) throw new HttpError(400, "Audit event was rejected by policy or validation");
      res.status(201).json(audit.getEvent(db, result.id, auditScope(req)));
    })
  );

  app.get(
    "/api/audit/objects/:objectType/:objectId/history",
    authAsync,
    canAsync("iam.audit.history", "read"),
    wrap(async (req, res) => {
      await assertHistoryVisibleAsync(req, req.params.objectType);
      res.json(
        await audit.objectHistoryAsync(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId },
          eventFilters(req),
          await auditScopeAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/users/:userId/activity",
    authAsync,
    canAsync("iam.audit.history", "read"),
    wrap(async (req, res) => {
      res.json(await audit.userActivityAsync(db, req.params.userId, eventFilters(req), await auditScopeAsync(req)));
    })
  );

  app.post(
    "/api/audit/export",
    auth,
    can("iam.audit.export", "execute"),
    audit.auditRoute(db, {
      action: "audit.export",
      objectType: "audit_event",
      objectId: (req) => req.body?.format || "csv",
      reasonFrom: (req) => (req.body?.reason ? String(req.body.reason) : null),
    }),
    wrap((req, res) => {
      const body = req.body || {};
      const result = audit.exportEvents(db, {
        filters: { ...eventFilters(req), ...(body.filters || {}), q: body.q ?? req.query.q },
        scope: auditScope(req),
        format: body.format || "csv",
        limit: body.limit,
      });
      res.setHeader("Content-Type", result.content_type);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.setHeader("X-Audit-Export-Count", String(result.count));
      res.send(result.content);
    })
  );

  app.get(
    "/api/audit/policies",
    authAsync,
    canAsync("iam.audit.policies", "read"),
    wrap(async (req, res) => {
      const includeSystem = req.query.includeSystem !== "false";
      res.json(
        await audit.listPoliciesAsync(db, {
          tenantId: (await tenants.isPlatformAdminAsync(db, req.actor.id)) && req.query.all === "true" ? null : req.tenantId,
          objectType: req.query.objectType,
          status: req.query.status,
          includeSystem,
        })
      );
    })
  );

  app.get(
    "/api/audit/policies/:id",
    authAsync,
    canAsync("iam.audit.policies", "read"),
    wrap(async (req, res) => {
      res.json(await audit.getPolicyAsync(db, req.params.id, (await tenants.isPlatformAdminAsync(db, req.actor.id)) ? null : req.tenantId));
    })
  );

  app.post(
    "/api/audit/policies",
    auth,
    can("iam.audit.policies", "create"),
    audit.auditRoute(db, {
      action: "audit.policy.create",
      objectType: "audit_policy",
      objectId: (req) => req.body?.object_type,
      objectName: (req) => req.body?.name,
      reasonFrom: () => null,
    }),
    wrap((req, res) => {
      const body = req.body || {};
      const isPlatform = tenants.isPlatformAdmin(db, req.actor.id);
      const tenantId = isPlatform && (body.tenant_id === null || body.tenantId === null)
        ? null
        : body.tenant_id ?? body.tenantId ?? req.tenantId;
      res.status(201).json(audit.createPolicy(db, { ...body, tenant_id: tenantId }, req.actor, tenantId));
    })
  );

  app.put(
    "/api/audit/policies/:id",
    auth,
    can("iam.audit.policies", "update"),
    audit.auditRoute(db, {
      action: "audit.policy.update",
      objectType: "audit_policy",
      objectId: (req) => req.params.id,
      reasonFrom: () => null,
    }),
    wrap((req, res) => {
      res.json(
        audit.updatePolicy(
          db,
          req.params.id,
          req.body || {},
          tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId
        )
      );
    })
  );

  app.delete(
    "/api/audit/policies/:id",
    auth,
    can("iam.audit.policies", "delete"),
    audit.auditRoute(db, {
      action: "audit.policy.delete",
      objectType: "audit_policy",
      objectId: (req) => req.params.id,
      reasonFrom: () => null,
    }),
    wrap((req, res) => {
      res.json(
        audit.deletePolicy(db, req.params.id, tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId)
      );
    })
  );

  app.get(
    "/api/audit/retention/runs",
    authAsync,
    canAsync("iam.audit.retention", "read"),
    wrap(async (req, res) => {
      const page = pagination(req.query);
      res.json(await audit.listRetentionRunsAsync(db, { ...page, tenantId: req.tenantId }));
    })
  );

  app.post(
    "/api/audit/retention/run",
    auth,
    can("iam.audit.retention", "execute"),
    audit.auditRoute(db, {
      action: "audit.retention.run",
      objectType: "audit_retention",
      reasonFrom: () => null,
    }),
    wrap((req, res) => {
      const body = req.body || {};
      const isPlatform = tenants.isPlatformAdmin(db, req.actor.id);
      res.json(
        audit.runRetention(db, {
          tenantId: isPlatform && body.tenantId !== undefined ? body.tenantId : req.tenantId,
          policyId: body.policyId,
          actor: req.actor,
          dryRun: !!body.dryRun,
        })
      );
    })
  );

  // ── Audit framework extensions: batch ingest, specialised history, exports,
  // action types, saved filters and dedicated retention policies ─────────────

  app.post(
    "/api/audit/events/batch",
    auth,
    can("iam.audit.events", "create"),
    wrap((req, res) => {
      const body = req.body || {};
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) throw new HttpError(400, "events must be a non-empty array");
      if (events.length > 500) throw new HttpError(400, "A batch may contain at most 500 events");
      const ids = audit.recordBatch(
        db,
        events.map((event) =>
          audit.auditFromRequest(req, {
            action: event.action,
            event_type: event.event_type || event.eventType,
            category: event.category,
            object_type: event.objectType || event.object_type,
            object_id: event.objectId || event.object_id,
            object_name: event.objectName || event.object_name,
            status: event.status,
            source: event.source || "api",
            actor_type: event.actorType || event.actor_type,
            security_classification: event.securityClassification || event.security_classification,
            retention_category: event.retentionCategory || event.retention_category,
            session_id: event.sessionId || event.session_id,
            object_revision: event.objectRevision || event.object_revision,
            related_resource_type: event.relatedResourceType || event.related_resource_type,
            related_resource_id: event.relatedResourceId || event.related_resource_id,
            reason: event.reason,
            details: event.details,
            before: event.before,
            after: event.after,
            related: event.related,
          })
        )
      );
      res.status(201).json({ captured: ids.length, ids });
    })
  );

  const historyViews = {
    security: "securityActivity",
    workflows: "workflowAudit",
    lifecycle: "lifecycleAudit",
    configuration: "configurationAudit",
    approvals: "approvalAudit",
    documents: "documentAudit",
    integrations: "integrationAudit",
    "background-jobs": "backgroundJobAudit",
  };
  for (const [path, fn] of Object.entries(historyViews)) {
    app.get(
      `/api/audit/${path}`,
      authAsync,
      canAsync("iam.audit.events", "read"),
      wrap(async (req, res) => {
        res.json(await audit[`${fn}Async`](db, eventFilters(req), await auditScopeAsync(req)));
      })
    );
  }

  app.get(
    "/api/audit/metrics",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.auditMetricsAsync(db, eventFilters(req), await auditScopeAsync(req)));
    })
  );

  app.get(
    "/api/audit/attributes/:objectType/:objectId/history",
    authAsync,
    canAsync("iam.audit.history", "read"),
    wrap(async (req, res) => {
      await assertHistoryVisibleAsync(req, req.params.objectType);
      const attribute = req.query.attribute || req.query.changedAttribute;
      if (!attribute) throw new HttpError(400, "attribute query parameter is required");
      res.json(
        await audit.attributeHistoryAsync(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId, attribute },
          eventFilters(req),
          await auditScopeAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/relationships/:objectType/:objectId/history",
    authAsync,
    canAsync("iam.audit.history", "read"),
    wrap(async (req, res) => {
      await assertHistoryVisibleAsync(req, req.params.objectType);
      res.json(
        await audit.relationshipHistoryAsync(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId },
          eventFilters(req),
          await auditScopeAsync(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/exports",
    authAsync,
    canAsync("iam.audit.export", "read"),
    wrap(async (req, res) => {
      const page = pagination(req.query);
      res.json(
        await audit.listAuditExportsAsync(db, {
          tenantId: req.tenantId,
          actorId: req.query.mine === "true" ? req.actor.id : null,
          status: req.query.status,
          limit: page.pageSize,
        })
      );
    })
  );

  app.post(
    "/api/audit/exports",
    auth,
    can("iam.audit.export", "execute"),
    wrap((req, res) => {
      const body = req.body || {};
      const isPlatform = tenants.isPlatformAdmin(db, req.actor.id);
      const tenantId = isPlatform && (body.tenant_id === null || body.tenantId === null)
        ? null
        : body.tenant_id ?? body.tenantId ?? req.tenantId;
      res.status(202).json(
        audit.requestAuditExport(
          db,
          {
            ...body,
            filters: { ...eventFilters(req), ...(body.filters || {}) },
            tenant_id: tenantId,
          },
          req.actor,
          tenantId,
          clientIp(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/exports/:id",
    authAsync,
    canAsync("iam.audit.export", "read"),
    wrap(async (req, res) => {
      res.json(await audit.getAuditExportAsync(db, req.params.id, { tenantId: req.tenantId }));
    })
  );

  app.get(
    "/api/audit/exports/:id/download",
    authAsync,
    canAsync("iam.audit.export", "read"),
    wrap(async (req, res) => {
      const result = await audit.getAuditExportAsync(db, req.params.id, { tenantId: req.tenantId, includeContent: true });
      await audit.markAuditExportDownloadedAsync(db, result.id);
      res.setHeader("Content-Type", result.content_type);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    })
  );

  app.post(
    "/api/audit/policies/validate",
    auth,
    can("iam.audit.policies", "read"),
    wrap((req, res) => {
      res.json(audit.validatePolicy(db, req.body || {}));
    })
  );

  app.get(
    "/api/audit/action-types",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(
        await audit.listActionTypesAsync(db, {
          category: req.query.category,
          active: req.query.active,
          mandatory: req.query.mandatory,
          q: req.query.q,
        })
      );
    })
  );

  app.get(
    "/api/audit/action-types/:code",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(await audit.getActionTypeAsync(db, req.params.code));
    })
  );

  app.post(
    "/api/audit/action-types",
    auth,
    can("iam.audit.policies", "create"),
    wrap((req, res) => {
      res.status(201).json(audit.createActionType(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/audit/action-types/:code",
    auth,
    can("iam.audit.policies", "update"),
    wrap((req, res) => {
      res.json(audit.updateActionType(db, req.params.code, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/audit/action-types/:code",
    auth,
    can("iam.audit.policies", "delete"),
    wrap((req, res) => {
      res.json(audit.deleteActionType(db, req.params.code, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/audit/filters",
    authAsync,
    canAsync("iam.audit.events", "read"),
    wrap(async (req, res) => {
      res.json(
        await audit.listSavedFiltersAsync(db, {
          tenantId: req.tenantId,
          ownerId: req.actor.id,
          scope: req.query.scope,
        })
      );
    })
  );

  app.post(
    "/api/audit/filters",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.status(201).json(audit.createSavedFilter(db, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.put(
    "/api/audit/filters/:id",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.updateSavedFilter(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.delete(
    "/api/audit/filters/:id",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.deleteSavedFilter(db, req.params.id, req.actor, req.tenantId));
    })
  );

  app.get(
    "/api/audit/retention/policies",
    authAsync,
    canAsync("iam.audit.retention", "read"),
    wrap(async (req, res) => {
      res.json(
        await audit.listRetentionPoliciesAsync(db, {
          tenantId: (await tenants.isPlatformAdminAsync(db, req.actor.id)) && req.query.all === "true" ? null : req.tenantId,
          status: req.query.status,
          category: req.query.category,
          objectType: req.query.objectType,
          includeSystem: req.query.includeSystem !== "false",
        })
      );
    })
  );

  app.get(
    "/api/audit/retention/policies/:id",
    authAsync,
    canAsync("iam.audit.retention", "read"),
    wrap(async (req, res) => {
      res.json(
        await audit.getRetentionPolicyAsync(
          db,
          req.params.id,
          (await tenants.isPlatformAdminAsync(db, req.actor.id)) ? null : req.tenantId
        )
      );
    })
  );

  app.post(
    "/api/audit/retention/policies",
    auth,
    can("iam.audit.retention", "create"),
    wrap((req, res) => {
      const body = req.body || {};
      const isPlatform = tenants.isPlatformAdmin(db, req.actor.id);
      const tenantId = isPlatform && (body.tenant_id === null || body.tenantId === null)
        ? null
        : body.tenant_id ?? body.tenantId ?? req.tenantId;
      res.status(201).json(audit.createRetentionPolicy(db, { ...body, tenant_id: tenantId }, req.actor, tenantId));
    })
  );

  app.put(
    "/api/audit/retention/policies/:id",
    auth,
    can("iam.audit.retention", "update"),
    wrap((req, res) => {
      res.json(
        audit.updateRetentionPolicy(
          db,
          req.params.id,
          req.body || {},
          req.actor,
          tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId
        )
      );
    })
  );

  app.delete(
    "/api/audit/retention/policies/:id",
    auth,
    can("iam.audit.retention", "delete"),
    wrap((req, res) => {
      res.json(
        audit.deleteRetentionPolicy(
          db,
          req.params.id,
          req.actor,
          tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId
        )
      );
    })
  );

  app.post(
    "/api/audit/retention/execute",
    auth,
    can("iam.audit.retention", "execute"),
    wrap((req, res) => {
      const body = req.body || {};
      const isPlatform = tenants.isPlatformAdmin(db, req.actor.id);
      res.json(
        audit.executeRetentionPolicies(db, {
          tenantId: isPlatform && body.tenantId !== undefined ? body.tenantId : req.tenantId,
          policyId: body.policyId,
          actor: req.actor,
          dryRun: !!body.dryRun,
        })
      );
    })
  );

  app.get(
    "/api/iam/principals/:userId/access",
    auth,
    can("iam.users", "read"),
    wrap((req, res) => {
      res.json(effectiveAccess(db, req.params.userId));
    })
  );

  app.get(
    "/api/applications",
    authAsync,
    canAsync("iam.permissions", "read"),
    wrap(async (_req, res) => {
      res.json({ items: await catalog.listApplicationsAsync(db) });
    })
  );

  app.post(
    "/api/applications",
    authAsync,
    canAsync("iam.permissions", "create"),
    wrap(async (req, res) => {
      const appItem = await catalog.createApplicationAsync(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(appItem);
    })
  );

  app.get(
    "/api/resources",
    authAsync,
    canAsync("iam.permissions", "read"),
    wrap(async (req, res) => {
      res.json({ items: await catalog.listResourcesAsync(db, req.query) });
    })
  );

  app.post(
    "/api/resources",
    authAsync,
    canAsync("iam.permissions", "create"),
    wrap(async (req, res) => {
      const resource = await catalog.createResourceAsync(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(resource);
    })
  );

  app.put(
    "/api/resources/:id",
    authAsync,
    canAsync("iam.permissions", "update"),
    wrap(async (req, res) => {
      res.json(await catalog.updateResourceAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/permissions",
    authAsync,
    canAsync("iam.permissions", "read"),
    wrap(async (req, res) => {
      res.json(await catalog.listPermissionsAsync(db, req.query));
    })
  );

  app.get(
    "/api/permissions/matrix",
    auth,
    can("iam.permissions", "read"),
    wrap((req, res) => {
      res.json(authorization.permissionMatrix(db, req.query));
    })
  );

  app.post(
    "/api/permissions",
    authAsync,
    canAsync("iam.permissions", "create"),
    wrap(async (req, res) => {
      const permission = await catalog.createPermissionAsync(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(permission);
    })
  );

  app.delete(
    "/api/permissions/:id",
    authAsync,
    canAsync("iam.permissions", "delete"),
    wrap(async (req, res) => {
      res.json(await catalog.deletePermissionAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/roles/:id/permissions",
    authAsync,
    canAsync("iam.permissions", "read"),
    wrap(async (req, res) => {
      res.json({ items: await grants.listRolePermissionsAsync(db, req.params.id) });
    })
  );

  app.put(
    "/api/roles/:id/permissions",
    authAsync,
    canAsync("iam.permissions", "update"),
    wrap(async (req, res) => {
      const items = await grants.replaceRolePermissionMatrixAsync(
        db,
        req.params.id,
        req.body?.grants || [],
        req.actor,
        clientIp(req)
      );
      res.json({ items });
    })
  );

  app.post(
    "/api/roles/:id/permissions",
    authAsync,
    canAsync("iam.permissions", "update"),
    wrap(async (req, res) => {
      res.status(201).json({
        items: await grants.grantRolePermissionAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/roles/:id/permissions/:permissionId",
    authAsync,
    canAsync("iam.permissions", "update"),
    wrap(async (req, res) => {
      res.json({
        items: await grants.revokeRolePermissionAsync(
          db,
          req.params.id,
          req.params.permissionId,
          req.query.organizationId,
          req.actor,
          clientIp(req)
        ),
      });
    })
  );

  app.post(
    "/api/authorization/check",
    auth,
    wrap((req, res) => {
      const { userId, user, resource, action, context, organizationId } = req.body || {};
      const subject = userId || user;
      if (!subject || !resource || !action) {
        throw new HttpError(400, "userId, resource and action are required");
      }
      const ctx = { ...(context || {}), organizationId: organizationId ?? context?.organizationId };
      const result = authorization.checkPermissionAudited(
        db,
        subject,
        resource,
        action,
        ctx,
        req.actor,
        clientIp(req)
      );
      res.json(result);
    })
  );

  app.get(
    "/api/authorization/effective/:userId",
    auth,
    wrap((req, res) => {
      res.json(
        authorization.effectivePermissions(db, req.params.userId, {
          organizationId: req.query.organizationId,
        })
      );
    })
  );

  // ── Notification & Communication Framework ───────────────────────────────
  // Self-service inbox routes are always scoped to the authenticated user.
  // Administrative routes use the request tenant (or all tenants for platform
  // admins when ?all=true).
  function notificationSelfTenant(req) {
    return req.tenantId || -1;
  }

  async function notificationAdminScopeAsync(req) {
    if ((await tenants.isPlatformAdminAsync(db, req.actor.id)) && req.query.all === "true") return null;
    return req.tenantId || -1;
  }

  app.get(
    "/api/notifications/unread-count",
    authAsync,
    canAsync("iam.notifications.inbox", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.unreadCountAsync(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notifications/meta",
    authAsync,
    canAsync("iam.notifications.inbox", "read"),
    wrap((_req, res) => {
      res.json({
        channels: notifications.CHANNELS,
        channel_labels: notifications.CHANNEL_LABELS,
        priorities: notifications.PRIORITIES,
        statuses: notifications.NOTIFICATION_STATUSES,
        frequencies: notifications.FREQUENCIES,
        provider_types: notifications.PROVIDER_TYPES,
        recipient_types: notifications.RECIPIENT_TYPES,
        template_roots: notifications.TEMPLATE_ROOTS,
        sample_context: notifications.sampleContext(),
      });
    })
  );

  app.get(
    "/api/notifications",
    authAsync,
    canAsync("iam.notifications.inbox", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listInboxAsync(db, req.actor.id, notificationSelfTenant(req), req.query));
    })
  );

  app.post(
    "/api/notifications/mark-all-read",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.markAllReadAsync(db, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/notifications/archive-all-read",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.archiveAllReadAsync(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notifications/:id",
    authAsync,
    canAsync("iam.notifications.inbox", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.getNotificationAsync(db, req.params.id, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.put(
    "/api/notifications/:id/read",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.markReadAsync(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notifications/:id/unread",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.markUnreadAsync(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notifications/:id/archive",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.archiveNotificationAsync(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/notifications/:id",
    authAsync,
    canAsync("iam.notifications.inbox", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.deleteNotificationAsync(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  // ── Preferences (self-service) ───────────────────────────────────────────
  app.get(
    "/api/notification-preferences",
    authAsync,
    canAsync("iam.notifications.preferences", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.getPreferencesAsync(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.put(
    "/api/notification-preferences",
    authAsync,
    canAsync("iam.notifications.preferences", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.updatePreferencesAsync(db, req.actor.id, req.body || {}, req.actor, clientIp(req), notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notification-preferences/mandatory",
    authAsync,
    canAsync("iam.notifications.preferences", "read"),
    wrap(async (req, res) => {
      res.json({ items: await notifications.mandatoryEventsAsync(db, notificationSelfTenant(req)) });
    })
  );

  // ── Templates ────────────────────────────────────────────────────────────
  app.get(
    "/api/notification-templates/variables",
    auth,
    can("iam.notifications.templates", "read"),
    wrap((_req, res) => {
      res.json({ roots: notifications.TEMPLATE_ROOTS, sample_context: notifications.sampleContext() });
    })
  );

  app.get(
    "/api/notification-templates",
    authAsync,
    canAsync("iam.notifications.templates", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listTemplatesAsync(db, req.query, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-templates",
    authAsync,
    canAsync("iam.notifications.templates", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await notifications.createTemplateAsync(db, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/notification-templates/:id",
    authAsync,
    canAsync("iam.notifications.templates", "read"),
    wrap(async (req, res) => {
      const row = await notifications.findTemplateAsync(db, { id: req.params.id }, notificationSelfTenant(req));
      res.json(notifications.publicTemplate(row));
    })
  );

  app.get(
    "/api/notification-templates/:id/versions",
    authAsync,
    canAsync("iam.notifications.templates", "read"),
    wrap(async (req, res) => {
      res.json({ items: await notifications.listTemplateVersionsAsync(db, req.params.id, notificationSelfTenant(req)) });
    })
  );

  app.put(
    "/api/notification-templates/:id",
    authAsync,
    canAsync("iam.notifications.templates", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.updateTemplateAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.put(
    "/api/notification-templates/:id/status",
    authAsync,
    canAsync("iam.notifications.templates", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.setTemplateStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.post(
    "/api/notification-templates/:id/preview",
    authAsync,
    canAsync("iam.notifications.templates", "execute"),
    wrap(async (req, res) => {
      res.json(await notifications.previewTemplateAsync(db, req.params.id, req.body?.context || {}, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-templates/:id/test-send",
    authAsync,
    canAsync("iam.notifications.templates", "execute"),
    wrap(async (req, res) => {
      res.status(201).json(await notifications.testSendTemplateAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), notificationSelfTenant(req)));
    })
  );

  app.delete(
    "/api/notification-templates/:id",
    authAsync,
    canAsync("iam.notifications.templates", "delete"),
    wrap(async (req, res) => {
      res.json(await notifications.deleteTemplateAsync(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  // ── Rules ────────────────────────────────────────────────────────────────
  app.get(
    "/api/notification-rules",
    authAsync,
    canAsync("iam.notifications.rules", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listRulesAsync(db, req.query, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-rules",
    authAsync,
    canAsync("iam.notifications.rules", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await notifications.createRuleAsync(db, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/notification-rules/:id",
    authAsync,
    canAsync("iam.notifications.rules", "read"),
    wrap(async (req, res) => {
      const row = await notifications.getRuleRowAsync(db, req.params.id);
      if (!row) throw new HttpError(404, "Notification rule not found");
      res.json(notifications.publicRule(row));
    })
  );

  app.put(
    "/api/notification-rules/:id",
    authAsync,
    canAsync("iam.notifications.rules", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.updateRuleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.put(
    "/api/notification-rules/:id/status",
    authAsync,
    canAsync("iam.notifications.rules", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.setRuleStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.post(
    "/api/notification-rules/:id/simulate",
    authAsync,
    canAsync("iam.notifications.rules", "execute"),
    wrap(async (req, res) => {
      res.json(await notifications.simulateRuleAsync(db, req.params.id, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.delete(
    "/api/notification-rules/:id",
    authAsync,
    canAsync("iam.notifications.rules", "delete"),
    wrap(async (req, res) => {
      res.json(await notifications.deleteRuleAsync(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  // ── Providers ────────────────────────────────────────────────────────────
  app.get(
    "/api/notification-providers",
    authAsync,
    canAsync("iam.notifications.providers", "read"),
    wrap(async (req, res) => {
      res.json({ items: await notifications.listProvidersAsync(db, { channel: req.query.channel }) });
    })
  );

  app.post(
    "/api/notification-providers",
    authAsync,
    canAsync("iam.notifications.providers", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await notifications.createProviderAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notification-providers/:id",
    authAsync,
    canAsync("iam.notifications.providers", "update"),
    wrap(async (req, res) => {
      res.json(await notifications.updateProviderAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/notification-providers/:id/test",
    authAsync,
    canAsync("iam.notifications.providers", "execute"),
    wrap(async (req, res) => {
      res.json(await notifications.testProviderAsync(db, req.params.id, { recipient: req.body?.recipient }));
    })
  );

  app.delete(
    "/api/notification-providers/:id",
    authAsync,
    canAsync("iam.notifications.providers", "delete"),
    wrap(async (req, res) => {
      res.json(await notifications.deleteProviderAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  // ── History, delivery queue, reminders ───────────────────────────────────
  app.get(
    "/api/notification-history",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listHistoryAsync(db, req.query, await notificationAdminScopeAsync(req)));
    })
  );

  app.get(
    "/api/notification-events",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listEventsAsync(db, req.query, await notificationAdminScopeAsync(req)));
    })
  );

  app.post(
    "/api/notification-events/publish",
    authAsync,
    canAsync("iam.notifications.history", "execute"),
    wrap(async (req, res) => {
      res.status(201).json(await notifications.publishAsync(db, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/notification-events/:id",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.getEventAsync(db, req.params.id, await notificationAdminScopeAsync(req)));
    })
  );

  app.get(
    "/api/notification-deliveries/stats",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.deliveryStatsAsync(db, await notificationAdminScopeAsync(req)));
    })
  );

  app.get(
    "/api/notification-deliveries",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listDeliveriesAsync(db, req.query, await notificationAdminScopeAsync(req)));
    })
  );

  app.post(
    "/api/notification-deliveries/process",
    auth,
    can("iam.notifications.history", "execute"),
    wrap((req, res) => {
      res.json(notifications.processQueue(db, { limit: req.body?.limit }));
    })
  );

  app.post(
    "/api/notification-deliveries/:id/retry",
    authAsync,
    canAsync("iam.notifications.history", "execute"),
    wrap(async (req, res) => {
      res.json(await notifications.retryDeliveryAsync(db, req.params.id, await notificationAdminScopeAsync(req)));
    })
  );

  app.get(
    "/api/notification-reminders",
    authAsync,
    canAsync("iam.notifications.history", "read"),
    wrap(async (req, res) => {
      res.json(await notifications.listRemindersAsync(db, req.query, await notificationAdminScopeAsync(req)));
    })
  );

  app.post(
    "/api/notification-reminders/sweep",
    auth,
    can("iam.notifications.history", "execute"),
    wrap((req, res) => {
      res.json(notifications.sweepReminders(db, { tenantId: req.tenantId, limit: req.body?.limit, actor: req.actor, ip: clientIp(req) }));
    })
  );

  // ── Communication & Delivery Services ────────────────────────────────────
  // Provider configuration, delivery requests, queue processing, reminders,
  // escalations and operational monitoring. All administrative routes are
  // tenant-scoped; platform admins may request ?all=true.
  function deliveryScope(req) {
    if (tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true") return null;
    return req.tenantId || -1;
  }

  function deliveryQuery(req) {
    const scope = deliveryScope(req);
    return scope === null ? { ...req.query } : { ...req.query, tenantId: scope };
  }

  app.get(
    "/api/delivery/meta",
    authAsync,
    canAsync("iam.delivery.providers", "read"),
    wrap((_req, res) => {
      res.json({
        statuses: delivery.DELIVERY_STATUSES,
        status_labels: delivery.DELIVERY_STATUS_LABELS,
        reminder_statuses: delivery.REMINDER_STATUSES,
        reminder_kinds: delivery.REMINDER_KINDS,
        escalation_statuses: delivery.ESCALATION_STATUSES,
        alert_severities: delivery.ALERT_SEVERITIES,
        channels: delivery.CHANNELS,
        priorities: delivery.PRIORITIES,
        provider_types: delivery.PROVIDER_TYPES,
        transport_types: delivery.transportTypes(),
        escalation_recipient_types: delivery.ESCALATION_RECIPIENT_TYPES,
      });
    })
  );

  app.get(
    "/api/delivery/requests",
    authAsync,
    canAsync("iam.delivery.requests", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.listRequestsAsync(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/requests",
    authAsync,
    canAsync("iam.delivery.requests", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await delivery.submitRequestAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/requests/:id",
    authAsync,
    canAsync("iam.delivery.requests", "read"),
    wrap(async (req, res) => {
      const request = await delivery.getRequestAsync(db, req.params.id, deliveryScope(req));
      request.attempts = await delivery.listAttemptsAsync(db, request.id);
      res.json(request);
    })
  );

  app.get(
    "/api/delivery/requests/:id/attempts",
    authAsync,
    canAsync("iam.delivery.requests", "read"),
    wrap(async (req, res) => {
      const request = await delivery.getRequestAsync(db, req.params.id, deliveryScope(req));
      res.json({ items: await delivery.listAttemptsAsync(db, request.id) });
    })
  );

  app.post(
    "/api/delivery/requests/:id/cancel",
    authAsync,
    canAsync("iam.delivery.requests", "execute"),
    wrap(async (req, res) => {
      res.json(await delivery.cancelRequestAsync(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/requests/:id/retry",
    authAsync,
    canAsync("iam.delivery.requests", "execute"),
    wrap(async (req, res) => {
      res.json(await delivery.retryRequestAsync(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/process",
    auth,
    can("iam.delivery.requests", "execute"),
    wrap((req, res) => {
      res.json(delivery.processDue(db, { limit: req.body?.limit, tenantId: deliveryScope(req) }));
    })
  );

  // Providers
  app.get(
    "/api/delivery/providers",
    authAsync,
    canAsync("iam.delivery.providers", "read"),
    wrap(async (req, res) => {
      res.json({ items: await delivery.listDeliveryProvidersAsync(db, deliveryQuery(req)) });
    })
  );

  app.post(
    "/api/delivery/providers",
    authAsync,
    canAsync("iam.delivery.providers", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await delivery.createDeliveryProviderAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/delivery/providers/:id",
    authAsync,
    canAsync("iam.delivery.providers", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.getDeliveryProviderAsync(db, req.params.id));
    })
  );

  app.put(
    "/api/delivery/providers/:id",
    authAsync,
    canAsync("iam.delivery.providers", "update"),
    wrap(async (req, res) => {
      res.json(await delivery.updateDeliveryProviderAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/delivery/providers/:id/status",
    authAsync,
    canAsync("iam.delivery.providers", "update"),
    wrap(async (req, res) => {
      res.json(await delivery.setDeliveryProviderStatusAsync(db, req.params.id, req.body?.status, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/delivery/providers/:id/test",
    authAsync,
    canAsync("iam.delivery.providers", "execute"),
    wrap(async (req, res) => {
      res.json(await delivery.testDeliveryProviderAsync(db, req.params.id, { recipient: req.body?.recipient }));
    })
  );

  app.delete(
    "/api/delivery/providers/:id",
    authAsync,
    canAsync("iam.delivery.providers", "delete"),
    wrap(async (req, res) => {
      res.json(await delivery.deleteDeliveryProviderAsync(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/delivery/provider-failures",
    authAsync,
    canAsync("iam.delivery.providers", "read"),
    wrap(async (req, res) => {
      const [items, summary] = await Promise.all([
        delivery.listProviderFailuresAsync(db, req.query, deliveryScope(req)),
        delivery.providerFailureSummaryAsync(db, deliveryScope(req)),
      ]);
      res.json({ items, summary });
    })
  );

  app.get(
    "/api/delivery/provider-health",
    authAsync,
    canAsync("iam.delivery.providers", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.providerHealthAsync(db, deliveryScope(req)));
    })
  );

  // Reminders
  app.get(
    "/api/delivery/reminders",
    authAsync,
    canAsync("iam.delivery.reminders", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.listRemindersAsync(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/reminders",
    authAsync,
    canAsync("iam.delivery.reminders", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await delivery.scheduleReminderAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/reminders/:id",
    authAsync,
    canAsync("iam.delivery.reminders", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.getReminderAsync(db, req.params.id, deliveryScope(req)));
    })
  );

  app.put(
    "/api/delivery/reminders/:id",
    authAsync,
    canAsync("iam.delivery.reminders", "update"),
    wrap(async (req, res) => {
      res.json(await delivery.updateReminderAsync(db, req.params.id, req.body || {}, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/reminders/:id/cancel",
    authAsync,
    canAsync("iam.delivery.reminders", "execute"),
    wrap(async (req, res) => {
      res.json(await delivery.cancelReminderAsync(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/reminders/sweep",
    auth,
    can("iam.delivery.reminders", "execute"),
    wrap((req, res) => {
      res.json(delivery.sweepReminders(db, { tenantId: req.tenantId, limit: req.body?.limit, actor: req.actor, ip: clientIp(req) }));
    })
  );

  // Escalations
  app.get(
    "/api/delivery/escalations",
    authAsync,
    canAsync("iam.delivery.reminders", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.listEscalationsAsync(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/escalations",
    authAsync,
    canAsync("iam.delivery.reminders", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await delivery.scheduleEscalationAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/escalations/:id",
    authAsync,
    canAsync("iam.delivery.reminders", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.getEscalationAsync(db, req.params.id, deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/escalations/:id/cancel",
    authAsync,
    canAsync("iam.delivery.reminders", "execute"),
    wrap(async (req, res) => {
      res.json(await delivery.cancelEscalationAsync(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/escalations/sweep",
    auth,
    can("iam.delivery.reminders", "execute"),
    wrap((req, res) => {
      res.json(delivery.sweepEscalations(db, { tenantId: req.tenantId, limit: req.body?.limit, actor: req.actor, ip: clientIp(req) }));
    })
  );

  // Monitoring, alerts and run history
  app.get(
    "/api/delivery/metrics",
    authAsync,
    canAsync("iam.delivery.monitoring", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.deliveryMetricsAsync(db, { tenantId: deliveryScope(req), from: req.query.from, to: req.query.to }));
    })
  );

  app.get(
    "/api/delivery/stats",
    authAsync,
    canAsync("iam.delivery.monitoring", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.deliveryStatsAsync(db, deliveryScope(req)));
    })
  );

  app.get(
    "/api/delivery/timeseries",
    authAsync,
    canAsync("iam.delivery.monitoring", "read"),
    wrap(async (req, res) => {
      res.json({ items: await delivery.deliveryTimeseriesAsync(db, { tenantId: deliveryScope(req), from: req.query.from, to: req.query.to }) });
    })
  );

  app.get(
    "/api/delivery/alerts",
    authAsync,
    canAsync("iam.delivery.monitoring", "read"),
    wrap(async (req, res) => {
      res.json(await delivery.listAlertsAsync(db, req.query, deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/alerts/:id/acknowledge",
    authAsync,
    canAsync("iam.delivery.monitoring", "update"),
    wrap(async (req, res) => {
      res.json(await delivery.acknowledgeAlertAsync(db, req.params.id, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/runs",
    authAsync,
    canAsync("iam.delivery.monitoring", "read"),
    wrap(async (req, res) => {
      res.json({
        items: await delivery.listRunsAsync(db, {
          kind: req.query.kind,
          reminderId: req.query.reminderId,
          escalationId: req.query.escalationId,
          limit: req.query.limit,
        }),
      });
    })
  );

  // ── Background job management ─────────────────────────────────────────────
  // Centralized registry, submission, monitoring, control and tracking for
  // asynchronous jobs. Business modules submit work and receive a Job ID; the
  // Job Scheduling & Execution Engine reports progress/outcomes back here.
  // Every route is tenant-scoped; platform admins may request ?all=true.
  async function jobScopeAsync(req) {
    if (req.query.all === "true" && (await tenants.isPlatformAdminAsync(db, req.actor.id))) return null;
    return req.tenantId || -1;
  }

  app.get(
    "/api/jobs/meta",
    auth,
    can("iam.jobs.list", "read"),
    wrap((_req, res) => {
      res.json({
        statuses: jobs.JOB_STATUSES,
        status_labels: jobs.JOB_STATUS_LABELS,
        terminal_statuses: jobs.TERMINAL_STATUSES,
        transitions: jobs.JOB_TRANSITIONS,
        priorities: jobs.PRIORITIES,
        submitted_as: jobs.SUBMITTED_AS,
        artifact_kinds: jobs.ARTIFACT_KINDS,
        default_queue: jobs.DEFAULT_QUEUE,
      });
    })
  );

  app.get(
    "/api/job-types",
    authAsync,
    canAsync("iam.jobs.types", "read"),
    wrap(async (req, res) => {
      res.json(await jobs.listJobTypesAsync(db, req.query));
    })
  );

  app.get(
    "/api/job-types/:code",
    authAsync,
    canAsync("iam.jobs.types", "read"),
    wrap(async (req, res) => {
      res.json(await jobs.getJobTypeAsync(db, req.params.code));
    })
  );

  app.post(
    "/api/job-types",
    authAsync,
    canAsync("iam.jobs.types", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await jobs.createJobTypeAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.patch(
    "/api/job-types/:code",
    authAsync,
    canAsync("iam.jobs.types", "update"),
    wrap(async (req, res) => {
      res.json(await jobs.updateJobTypeAsync(db, req.params.code, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/job-types/:code/status",
    authAsync,
    canAsync("iam.jobs.types", "update"),
    wrap(async (req, res) => {
      res.json(await jobs.setJobTypeStatusAsync(db, req.params.code, req.body?.active !== false, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/job-metrics",
    authAsync,
    canAsync("iam.jobs.monitoring", "read"),
    wrap(async (req, res) => {
      res.json(await jobs.jobMetricsAsync(db, await jobScopeAsync(req)));
    })
  );

  app.get(
    "/api/job-metrics/timeseries",
    authAsync,
    canAsync("iam.jobs.monitoring", "read"),
    wrap(async (req, res) => {
      const scope = await jobScopeAsync(req);
      res.json({ items: await jobs.jobTimeseriesAsync(db, scope, { days: req.query.days }) });
    })
  );

  app.get(
    "/api/jobs",
    authAsync,
    canAsync("iam.jobs.list", "read"),
    wrap(async (req, res) => {
      const scope = await jobScopeAsync(req);
      const query = scope === null ? { ...req.query } : { ...req.query, tenantId: scope };
      res.json(await jobs.listJobsAsync(db, query, scope));
    })
  );

  app.post(
    "/api/jobs",
    authAsync,
    canAsync("iam.jobs.list", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await jobs.submitJobAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id",
    authAsync,
    canAsync("iam.jobs.details", "read"),
    wrap(async (req, res) => {
      const scope = await jobScopeAsync(req);
      const job = await jobs.getJobAsync(db, req.params.id, scope);
      job.dependencies_state = await jobs.dependencyStateAsync(db, job.id, scope);
      res.json(job);
    })
  );

  app.get(
    "/api/jobs/:id/status",
    authAsync,
    canAsync("iam.jobs.details", "read"),
    wrap(async (req, res) => {
      res.json(await jobs.getStatusAsync(db, req.params.id, await jobScopeAsync(req)));
    })
  );

  app.get(
    "/api/jobs/:id/history",
    authAsync,
    canAsync("iam.jobs.details", "read"),
    wrap(async (req, res) => {
      const job = await jobs.getJobAsync(db, req.params.id, await jobScopeAsync(req));
      res.json(await jobs.listHistoryAsync(db, job.id, req.query));
    })
  );

  app.get(
    "/api/jobs/:id/dependencies",
    authAsync,
    canAsync("iam.jobs.details", "read"),
    wrap(async (req, res) => {
      res.json(await jobs.listDependenciesAsync(db, req.params.id, await jobScopeAsync(req)));
    })
  );

  app.post(
    "/api/jobs/:id/dependencies",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      const job = await jobs.getJobAsync(db, req.params.id, await jobScopeAsync(req));
      const dependencies = req.body?.dependencies || req.body?.depends_on || [];
      res.status(201).json({ items: await jobs.addDependenciesAsync(db, job.id, dependencies, { actor: req.actor, ip: clientIp(req) }) });
    })
  );

  app.delete(
    "/api/jobs/:id/dependencies/:dependsOnId",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      const job = await jobs.getJobAsync(db, req.params.id, await jobScopeAsync(req));
      res.json(await jobs.removeDependencyAsync(db, job.id, req.params.dependsOnId, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/progress",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      res.json(await jobs.updateProgressAsync(db, req.params.id, req.body || {}, { tenantId: await jobScopeAsync(req), actor: req.actor }));
    })
  );

  app.post(
    "/api/jobs/:id/cancel",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      res.json(await jobs.cancelJobAsync(db, req.params.id, { tenantId: await jobScopeAsync(req), reason: req.body?.reason, actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/retry",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      res.json(await jobs.retryJobAsync(db, req.params.id, { tenantId: await jobScopeAsync(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/pause",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      res.json(await jobs.pauseJobAsync(db, req.params.id, { tenantId: await jobScopeAsync(req), reason: req.body?.reason, actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/resume",
    authAsync,
    canAsync("iam.jobs.control", "execute"),
    wrap(async (req, res) => {
      res.json(await jobs.resumeJobAsync(db, req.params.id, { tenantId: await jobScopeAsync(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id/result",
    authAsync,
    canAsync("iam.jobs.results", "read"),
    wrap(async (req, res) => {
      const job = await jobs.getJobRowAsync(db, req.params.id, await jobScopeAsync(req));
      res.json(await jobs.resultPayloadAsync(db, job));
    })
  );

  app.post(
    "/api/jobs/:id/result",
    authAsync,
    canAsync("iam.jobs.results", "create"),
    wrap(async (req, res) => {
      const job = await jobs.getJobRowAsync(db, req.params.id, await jobScopeAsync(req));
      res.json(await jobs.setJobResultAsync(db, job, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id/artifacts",
    authAsync,
    canAsync("iam.jobs.results", "read"),
    wrap(async (req, res) => {
      const job = await jobs.getJobAsync(db, req.params.id, await jobScopeAsync(req));
      res.json({ items: await jobs.listArtifactsAsync(db, job.id) });
    })
  );

  app.post(
    "/api/jobs/:id/artifacts",
    authAsync,
    canAsync("iam.jobs.results", "create"),
    wrap(async (req, res) => {
      const job = await jobs.getJobAsync(db, req.params.id, await jobScopeAsync(req));
      res.status(201).json(await jobs.addArtifactAsync(db, job.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/jobs/:id/children",
    authAsync,
    canAsync("iam.jobs.details", "read"),
    wrap(async (req, res) => {
      res.json({ items: await jobs.listChildrenAsync(db, req.params.id, await jobScopeAsync(req)) });
    })
  );

  // ── Job Scheduling & Execution Engine ─────────────────────────────────────
  // Queue administration, schedule administration and execution observability.
  // The engine owns execution; these routes expose configuration and control.
  function execScope(req) {
    if (tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true") return null;
    return req.tenantId || -1;
  }

  async function execScopeAsync(req) {
    if (req.query.all === "true" && (await tenants.isPlatformAdminAsync(db, req.actor.id))) return null;
    return req.tenantId || -1;
  }

  app.get(
    "/api/job-queues/meta",
    auth,
    can("iam.jobs.queues", "read"),
    wrap((_req, res) => {
      res.json({
        logical_queues: jobExecution.LOGICAL_QUEUES,
        retry_strategies: jobExecution.RETRY_STRATEGIES,
        schedule_types: jobExecution.SCHEDULE_TYPES,
        schedule_statuses: jobExecution.SCHEDULE_STATUSES,
        failure_policies: jobExecution.FAILURE_POLICIES,
        concurrency_policies: jobExecution.CONCURRENCY_POLICIES,
        catchup_policies: jobExecution.CATCHUP_POLICIES,
        worker_statuses: jobExecution.WORKER_STATUSES,
        dead_letter_statuses: jobExecution.DEAD_LETTER_STATUSES,
        error_categories: jobExecution.ERROR_CATEGORIES,
        priorities: jobs.PRIORITIES,
        handlers: jobExecution.listHandlers(),
      });
    })
  );

  app.get(
    "/api/job-queues",
    authAsync,
    canAsync("iam.jobs.queues", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.listQueuesAsync(db, req.query, await execScopeAsync(req)));
    })
  );

  app.post(
    "/api/job-queues",
    authAsync,
    canAsync("iam.jobs.queues", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await jobExecution.createQueueAsync(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/job-queues/:id/health",
    authAsync,
    canAsync("iam.jobs.queues", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.queueHealthAsync(db, req.params.id));
    })
  );

  app.get(
    "/api/job-queues/:id",
    authAsync,
    canAsync("iam.jobs.queues", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.getQueueAsync(db, req.params.id));
    })
  );

  const updateQueueHandler = async (req, res) => {
    res.json(await jobExecution.updateQueueAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
  };
  app.put("/api/job-queues/:id", authAsync, canAsync("iam.jobs.queues", "update"), wrap(updateQueueHandler));
  app.patch("/api/job-queues/:id", authAsync, canAsync("iam.jobs.queues", "update"), wrap(updateQueueHandler));

  app.post(
    "/api/job-queues/:id/status",
    authAsync,
    canAsync("iam.jobs.queues", "update"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.paused !== undefined) {
        res.json(await jobExecution.setQueuePausedAsync(db, req.params.id, body.paused !== false, req.actor, clientIp(req)));
      } else {
        res.json(await jobExecution.setQueueEnabledAsync(db, req.params.id, body.enabled !== false, req.actor, clientIp(req)));
      }
    })
  );

  // ── Schedules ──
  app.get(
    "/api/schedules",
    authAsync,
    canAsync("iam.jobs.schedules", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.listSchedulesAsync(db, req.query, await execScopeAsync(req)));
    })
  );

  app.post(
    "/api/schedules",
    authAsync,
    canAsync("iam.jobs.schedules", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await jobExecution.createScheduleAsync(db, { ...(req.body || {}), tenant_id: req.tenantId }, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/schedules/:id",
    authAsync,
    canAsync("iam.jobs.schedules", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.getScheduleAsync(db, req.params.id, await execScopeAsync(req)));
    })
  );

  const updateScheduleHandler = async (req, res) => {
    res.json(await jobExecution.updateScheduleAsync(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
  };
  app.put("/api/schedules/:id", authAsync, canAsync("iam.jobs.schedules", "update"), wrap(updateScheduleHandler));
  app.patch("/api/schedules/:id", authAsync, canAsync("iam.jobs.schedules", "update"), wrap(updateScheduleHandler));

  app.post(
    "/api/schedules/:id/enable",
    authAsync,
    canAsync("iam.jobs.schedules", "update"),
    wrap(async (req, res) => {
      res.json(await jobExecution.setScheduleEnabledAsync(db, req.params.id, true, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/disable",
    authAsync,
    canAsync("iam.jobs.schedules", "update"),
    wrap(async (req, res) => {
      res.json(await jobExecution.setScheduleEnabledAsync(db, req.params.id, false, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/pause",
    authAsync,
    canAsync("iam.jobs.schedules", "update"),
    wrap(async (req, res) => {
      res.json(await jobExecution.setScheduleStatusAsync(db, req.params.id, "paused", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/resume",
    authAsync,
    canAsync("iam.jobs.schedules", "update"),
    wrap(async (req, res) => {
      res.json(await jobExecution.setScheduleStatusAsync(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/run-now",
    authAsync,
    canAsync("iam.jobs.schedules", "execute"),
    wrap(async (req, res) => {
      res.status(202).json(await jobExecution.runScheduleNowAsync(db, req.params.id, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/schedules/:id/runs",
    authAsync,
    canAsync("iam.jobs.schedules", "read"),
    wrap(async (req, res) => {
      res.json(await jobExecution.listScheduleRunsAsync(db, req.params.id, req.query));
    })
  );

  // ── Execution observability & control ──
  app.get(
    "/api/job-execution/status",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((_req, res) => {
      res.json(jobExecution.engineStatus(db));
    })
  );

  app.get(
    "/api/job-execution/metrics",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((req, res) => {
      res.json(jobExecution.executionMetrics(db, execScope(req)));
    })
  );

  app.get(
    "/api/job-execution/workers",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((req, res) => {
      res.json(jobExecution.listWorkers(db, req.query));
    })
  );

  app.get(
    "/api/job-execution/handlers",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((_req, res) => {
      res.json({ items: jobExecution.listHandlers() });
    })
  );

  app.get(
    "/api/job-execution/dead-letter",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((req, res) => {
      res.json(jobExecution.listDeadLetters(db, req.query, execScope(req)));
    })
  );

  app.post(
    "/api/job-execution/dead-letter/:id/retry",
    auth,
    can("iam.jobs.execution", "execute"),
    wrap((req, res) => {
      res.json(jobExecution.requeueDeadLetter(db, req.params.id, { actor: req.actor, note: req.body?.note, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/job-execution/dead-letter/:id/discard",
    auth,
    can("iam.jobs.execution", "execute"),
    wrap((req, res) => {
      res.json(jobExecution.discardDeadLetter(db, req.params.id, { actor: req.actor, note: req.body?.note }));
    })
  );

  app.post(
    "/api/job-execution/tick",
    auth,
    can("iam.jobs.execution", "execute"),
    wrap(async (req, res) => {
      const result = await jobExecution.tick(db, {
        workerId: "api-tick",
        run: req.body?.run !== false,
        limit: Number(req.body?.limit) || 10,
        queueCodes: Array.isArray(req.body?.queues) ? req.body.queues : null,
      });
      res.json(result);
    })
  );

  app.post(
    "/api/job-execution/jobs/:id/execute",
    auth,
    can("iam.jobs.execution", "execute"),
    wrap(async (req, res) => {
      res.json(await jobExecution.runJobNow(db, req.params.id, { workerId: "api-run-now" }));
    })
  );

  app.post(
    "/api/job-execution/maintenance",
    auth,
    can("iam.jobs.execution", "execute"),
    wrap((_req, res) => {
      res.json(jobExecution.engineMaintenance(db));
    })
  );

  app.get(
    "/api/job-execution/audit",
    auth,
    can("iam.jobs.execution", "read"),
    wrap((req, res) => {
      res.json({ items: jobExecution.listEngineAudit(db, { tenantId: execScope(req), limit: req.query.limit }) });
    })
  );

  // ── Document & File Management ────────────────────────────────────────────
  // Business-facing file management: browser/search, uploads, immutable
  // versions, check-out/check-in locks, folders, associations, collections,
  // access control, processing status and audit. Physical bytes and processing
  // are handled by the File Storage & Processing Services module; clients only
  // ever receive opaque references and signed short-lived download URLs.
  // Every route is tenant-scoped; platform admins may request ?all=true.
  const fileTenant = (req) => req.tenantId || -1;
  const filePlatformAll = (req) =>
    tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true";
  const filePlatformAllAsync = async (req) =>
    req.query.all === "true" && (await tenants.isPlatformAdminAsync(db, req.actor.id));
  const RAW_UPLOAD_LIMIT = process.env.FILE_HTTP_UPLOAD_LIMIT || "64mb";
  const rawBody = express.raw({ type: () => true, limit: RAW_UPLOAD_LIMIT });

  // Converts a download descriptor into a signed, short-lived URL. The physical
  // storage key is embedded in the HMAC token only and never returned to clients.
  function fileDownloadResponse(result) {
    const d = result.descriptor || {};
    const token = signDownload({
      key: d.key,
      bucket: d.bucket,
      filename: d.filename,
      mimeType: d.mimeType,
      disposition: d.disposition,
      tenantId: d.tenantId,
      versionId: d.versionId,
    });
    return {
      file: result.file,
      version: result.version,
      download_url: signedDownloadPath(token),
      filename: d.filename,
      mime_type: d.mimeType,
      size_bytes: d.size,
      expires_in: storageConfig().signedUrlTtlSeconds,
    };
  }

  app.get(
    "/api/files/meta",
    auth,
    can("iam.files.browser", "read"),
    wrap((_req, res) => {
      res.json({
        ...files.vocabulary,
        sortable: Object.keys(files.SORTABLE_FILES),
        downloadable_statuses: files.DOWNLOADABLE_STATUSES,
        max_file_size: storageConfig().maxFileSize,
      });
    })
  );

  app.get(
    "/api/files/metrics",
    authAsync,
    canAsync("iam.files.browser", "read"),
    wrap(async (req, res) => {
      res.json(await files.fileMetricsAsync(db, req.actor, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/metrics/storage",
    authAsync,
    canAsync("iam.files.browser", "read"),
    wrap(async (req, res) => {
      res.json(await files.storageBreakdownAsync(db, req.actor, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/metrics/processing",
    authAsync,
    canAsync("iam.files.browser", "read"),
    wrap(async (req, res) => {
      res.json(await files.processingSummaryAsync(db, req.actor, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/events",
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(
        files.listFileEvents(db, {
          fileId: req.query.fileId,
          eventType: req.query.eventType,
          tenantId: filePlatformAll(req) ? null : fileTenant(req),
          limit: req.query.limit,
        })
      );
    })
  );

  app.get(
    "/api/files/facets",
    authAsync,
    canAsync("iam.files.browser", "read"),
    wrap(async (req, res) => {
      res.json(await files.fileFacetsAsync(db, req.query, req.actor, fileTenant(req)));
    })
  );

  // File ACL administration.
  app.get(
    "/api/files/permissions",
    authAsync,
    canAsync("iam.files.permissions", "read"),
    wrap(async (req, res) => {
      res.json(await files.listPermissionsAsync(db, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/permissions",
    authAsync,
    canAsync("iam.files.permissions", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await files.grantPermissionAsync(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.delete(
    "/api/files/permissions/:id",
    authAsync,
    canAsync("iam.files.permissions", "delete"),
    wrap(async (req, res) => {
      res.json(await files.revokePermissionAsync(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // Associations by business object (the file-side view lives under /api/files/:ref).
  app.get(
    "/api/file-associations",
    authAsync,
    canAsync("iam.files.associations", "read"),
    wrap(async (req, res) => {
      if (req.query.businessObjectType || req.query.business_object_type) {
        return res.json(
          await files.listObjectAssociationsAsync(
            db,
            {
              businessObjectType: req.query.businessObjectType || req.query.business_object_type,
              businessObjectId: req.query.businessObjectId || req.query.business_object_id,
              relationshipType: req.query.relationshipType || req.query.relationship_type,
            },
            req.actor,
            fileTenant(req)
          )
        );
      }
      res.json(await files.listAssociationsAsync(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.patch(
    "/api/file-associations/:id",
    authAsync,
    canAsync("iam.files.associations", "update"),
    wrap(async (req, res) => {
      res.json(await files.updateAssociationAsync(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.delete(
    "/api/file-associations/:id",
    authAsync,
    canAsync("iam.files.associations", "delete"),
    wrap(async (req, res) => {
      res.json(await files.removeAssociationAsync(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Uploads (single, multipart/chunked, resumable) ──
  app.get(
    "/api/files/uploads",
    authAsync,
    canAsync("iam.files.uploads", "read"),
    wrap(async (req, res) => {
      res.json(await files.listUploadsAsync(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/uploads",
    authAsync,
    canAsync("iam.files.uploads", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await files.initiateUploadAsync(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/files/uploads/:uploadId",
    authAsync,
    canAsync("iam.files.uploads", "read"),
    wrap(async (req, res) => {
      res.json(await files.getUploadAsync(db, req.params.uploadId, req.actor, fileTenant(req)));
    })
  );

  app.put(
    "/api/files/uploads/:uploadId/chunks/:index",
    authAsync,
    canAsync("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64");
      res.json(await files.uploadChunkAsync(db, req.params.uploadId, req.params.index, buffer, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/uploads/:uploadId/complete",
    authAsync,
    canAsync("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const payload = Buffer.isBuffer(req.body) ? { buffer: req.body } : (req.body || {});
      res.json(await files.completeUploadAsync(db, req.params.uploadId, payload, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/uploads/:uploadId/abort",
    authAsync,
    canAsync("iam.files.uploads", "create"),
    wrap(async (req, res) => {
      res.json(await files.abortUploadAsync(db, req.params.uploadId, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // Convenience: initiate + complete a single-shot upload in one request.
  app.post(
    "/api/files/upload",
    authAsync,
    canAsync("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64");
      const name = req.query.name || req.headers["x-file-name"] || req.body?.name || "upload.bin";
      const initiated = await files.initiateUploadAsync(
        db,
        {
          name,
          size: buffer.length,
          mime_type: req.query.mime_type || req.headers["content-type"],
          folder_id: req.query.folderId || req.query.folder_id,
          security_classification: req.query.security_classification,
          description: req.query.description,
        },
        req.actor,
        fileTenant(req),
        clientIp(req)
      );
      res.status(201).json(
        await files.completeUploadAsync(
          db,
          initiated.upload.upload_id,
          { buffer },
          req.actor,
          fileTenant(req),
          clientIp(req)
        )
      );
    })
  );

  // Signed download endpoint: verifies the short-lived HMAC token, then streams
  // the stored object. The physical storage key never leaves the backend.
  app.get(
    "/api/files/download/:token",
    auth,
    wrap(async (req, res) => {
      const payload = verifyDownloadToken(req.params.token);
      const provider = getStorageProvider();
      const info = await provider.stat(payload.k);
      if (!info) throw new HttpError(404, "Stored object not found");
      const filename = files.sanitizeFilename(payload.f || "download");
      res.setHeader("Content-Type", payload.m || "application/octet-stream");
      res.setHeader("Content-Length", String(info.size ?? 0));
      res.setHeader(
        "Content-Disposition",
        `${payload.d === "inline" ? "inline" : "attachment"}; filename="${filename}"`
      );
      provider.getStream(payload.k).pipe(res);
    })
  );

  // ── Folders ──
  app.get(
    "/api/folders",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.listFoldersAsync(db, req.query, fileTenant(req)));
    })
  );

  app.get(
    "/api/folders/tree",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.folderTreeAsync(db, fileTenant(req), { rootId: req.query.rootId }));
    })
  );

  app.post(
    "/api/folders",
    authAsync,
    canAsync("iam.files.folders", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await files.createFolderAsync(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/folders/:id/breadcrumb",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.folderBreadcrumbAsync(db, req.params.id, fileTenant(req)));
    })
  );

  app.get(
    "/api/folders/:id/files",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.listFolderFilesAsync(db, req.params.id, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/folders/:id/files",
    authAsync,
    canAsync("iam.files.folders", "update"),
    wrap(async (req, res) => {
      res.json(
        await files.moveFilesToFolderAsync(
          db,
          req.params.id,
          (req.body || {}).file_ids || (req.body || {}).fileIds || [],
          req.actor,
          fileTenant(req),
          clientIp(req)
        )
      );
    })
  );

  app.delete(
    "/api/folders/:id/files/:fileId",
    authAsync,
    canAsync("iam.files.folders", "update"),
    wrap(async (req, res) => {
      res.json(await files.removeFileFromFolderAsync(db, req.params.id, req.params.fileId, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/folders/:id",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.getFolderAsync(db, req.params.id, fileTenant(req)));
    })
  );

  const updateFolderHandlerAsync = async (req, res) => {
    res.json(await files.updateFolderAsync(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/folders/:id", authAsync, canAsync("iam.files.folders", "update"), wrap(updateFolderHandlerAsync));
  app.patch("/api/folders/:id", authAsync, canAsync("iam.files.folders", "update"), wrap(updateFolderHandlerAsync));

  app.delete(
    "/api/folders/:id",
    authAsync,
    canAsync("iam.files.folders", "delete"),
    wrap(async (req, res) => {
      res.json(
        await files.deleteFolderAsync(
          db,
          req.params.id,
          { force: req.query.force === "true" || (req.body || {}).force === true },
          req.actor,
          fileTenant(req),
          clientIp(req)
        )
      );
    })
  );

  app.post(
    "/api/folders/:id/restore",
    authAsync,
    canAsync("iam.files.folders", "update"),
    wrap(async (req, res) => {
      res.json(await files.restoreFolderAsync(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Collections ──
  app.get(
    "/api/file-collections",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.listCollectionsAsync(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/file-collections",
    authAsync,
    canAsync("iam.files.folders", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await files.createCollectionAsync(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/file-collections/:id",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      res.json(await files.getCollectionAsync(db, req.params.id, req.actor, fileTenant(req)));
    })
  );

  const updateCollectionHandlerAsync = async (req, res) => {
    res.json(await files.updateCollectionAsync(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/file-collections/:id", authAsync, canAsync("iam.files.folders", "update"), wrap(updateCollectionHandlerAsync));
  app.patch("/api/file-collections/:id", authAsync, canAsync("iam.files.folders", "update"), wrap(updateCollectionHandlerAsync));

  app.delete(
    "/api/file-collections/:id",
    authAsync,
    canAsync("iam.files.folders", "delete"),
    wrap(async (req, res) => {
      res.json(await files.deleteCollectionAsync(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/file-collections/:id/members",
    authAsync,
    canAsync("iam.files.associations", "create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await files.addCollectionMembersAsync(
          db,
          req.params.id,
          body.file_ids || body.fileIds || [],
          req.actor,
          fileTenant(req),
          clientIp(req)
        )
      );
    })
  );

  app.delete(
    "/api/file-collections/:id/members/:fileId",
    authAsync,
    canAsync("iam.files.associations", "delete"),
    wrap(async (req, res) => {
      res.json(await files.removeCollectionMemberAsync(db, req.params.id, req.params.fileId, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Files (definitions after the more specific /api/files/* routes above) ──
  app.get(
    "/api/files",
    authAsync,
    canAsync("iam.files.browser", "read"),
    wrap(async (req, res) => {
      res.json(
        await files.listFilesAsync(db, req.query, req.actor, fileTenant(req), { platformAll: await filePlatformAllAsync(req) })
      );
    })
  );

  app.get(
    "/api/files/:reference",
    authAsync,
    canAsync("iam.files.details", "read"),
    wrap(async (req, res) => {
      res.json(await files.getFileAsync(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  const updateFileHandlerAsync = async (req, res) => {
    res.json(await files.updateFileMetadataAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/files/:reference", authAsync, canAsync("iam.files.details", "update"), wrap(updateFileHandlerAsync));
  app.patch("/api/files/:reference", authAsync, canAsync("iam.files.details", "update"), wrap(updateFileHandlerAsync));

  app.delete(
    "/api/files/:reference",
    authAsync,
    canAsync("iam.files.details", "delete"),
    wrap(async (req, res) => {
      res.json(await files.deleteFileAsync(db, req.params.reference, req.body || req.query || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/restore",
    authAsync,
    canAsync("iam.files.details", "update"),
    wrap(async (req, res) => {
      res.json(await files.restoreFileAsync(db, req.params.reference, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/move",
    authAsync,
    canAsync("iam.files.details", "update"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await files.moveFileAsync(db, req.params.reference, body.folder_id ?? body.folderId ?? null, req.actor, fileTenant(req), clientIp(req))
      );
    })
  );

  app.get(
    "/api/files/:reference/events",
    auth,
    can("iam.files.details", "read"),
    wrap((req, res) => {
      const file = files.getFile(db, req.params.reference, req.actor, fileTenant(req)).file;
      res.json(files.listFileEvents(db, { fileId: file.id, eventType: req.query.eventType, limit: req.query.limit }));
    })
  );

  app.get(
    "/api/files/:reference/permissions",
    authAsync,
    canAsync("iam.files.permissions", "read"),
    wrap(async (req, res) => {
      const file = (await files.getFileAsync(db, req.params.reference, req.actor, fileTenant(req))).file;
      res.json(await files.listPermissionsAsync(db, { resourceType: "file", resourceId: file.id }, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/:reference/processing",
    authAsync,
    canAsync("iam.files.details", "read"),
    wrap(async (req, res) => {
      res.json(await files.getProcessingStatusAsync(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/processing/requeue",
    authAsync,
    canAsync("iam.files.details", "update"),
    wrap(async (req, res) => {
      res.json(
        await files.requeueProcessingAsync(
          db,
          req.params.reference,
          (req.body || {}).type || "virus_scan",
          req.actor,
          fileTenant(req),
          clientIp(req)
        )
      );
    })
  );

  // Versions.
  app.get(
    "/api/files/:reference/versions",
    authAsync,
    canAsync("iam.files.versions", "read"),
    wrap(async (req, res) => {
      res.json(await files.listVersionsAsync(db, req.params.reference, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/versions",
    authAsync,
    canAsync("iam.files.versions", "create"),
    wrap(async (req, res) => {
      res.status(201).json(
        await files.createVersionAsync(
          db,
          req.params.reference,
          req.body || {},
          { actor: req.actor, tenantId: fileTenant(req), ip: clientIp(req), source: "manual" }
        )
      );
    })
  );

  app.get(
    "/api/files/:reference/versions/:version",
    authAsync,
    canAsync("iam.files.versions", "read"),
    wrap(async (req, res) => {
      res.json(await files.getVersionAsync(db, req.params.reference, req.params.version, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/versions/:version/restore",
    authAsync,
    canAsync("iam.files.versions", "create"),
    wrap(async (req, res) => {
      res.status(201).json(
        await files.restoreVersionAsync(
          db,
          req.params.reference,
          req.params.version,
          req.body || {},
          { actor: req.actor, tenantId: fileTenant(req), ip: clientIp(req) }
        )
      );
    })
  );

  app.get(
    "/api/files/:reference/versions/:version/download",
    authAsync,
    canAsync("iam.files.details", "read"),
    wrap(async (req, res) => {
      res.json(fileDownloadResponse(await files.versionDownloadAsync(db, req.params.reference, req.params.version, req.actor, fileTenant(req))));
    })
  );

  app.get(
    "/api/files/:reference/download",
    authAsync,
    canAsync("iam.files.details", "read"),
    wrap(async (req, res) => {
      res.json(fileDownloadResponse(await files.versionDownloadAsync(db, req.params.reference, null, req.actor, fileTenant(req))));
    })
  );

  // Check-out / check-in / locks.
  app.get(
    "/api/files/:reference/lock",
    authAsync,
    canAsync("iam.files.locks", "read"),
    wrap(async (req, res) => {
      res.json(await files.getLockAsync(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/checkout",
    authAsync,
    canAsync("iam.files.locks", "execute"),
    wrap(async (req, res) => {
      res.status(201).json(await files.checkOutFileAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/checkin",
    authAsync,
    canAsync("iam.files.locks", "execute"),
    wrap(async (req, res) => {
      res.json(await files.checkInFileAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/lock/release",
    authAsync,
    canAsync("iam.files.locks", "execute"),
    wrap(async (req, res) => {
      res.json(await files.releaseLockAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/lock/force-release",
    authAsync,
    canAsync("iam.files.locks", "execute"),
    wrap(async (req, res) => {
      res.json(await files.forceReleaseLockAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // File associations.
  app.get(
    "/api/files/:reference/associations",
    authAsync,
    canAsync("iam.files.associations", "read"),
    wrap(async (req, res) => {
      res.json(await files.listFileAssociationsAsync(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/associations",
    authAsync,
    canAsync("iam.files.associations", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await files.createAssociationAsync(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/files/:reference/collections",
    authAsync,
    canAsync("iam.files.folders", "read"),
    wrap(async (req, res) => {
      const file = (await files.getFileAsync(db, req.params.reference, req.actor, fileTenant(req))).file;
      res.json(await files.listCollectionsForFileAsync(db, file.id, req.actor, fileTenant(req)));
    })
  );

  // Locks (tenant-wide view).
  app.get(
    "/api/file-locks",
    authAsync,
    canAsync("iam.files.locks", "read"),
    wrap(async (req, res) => {
      res.json(await files.listLocksAsync(db, req.query, req.actor, fileTenant(req)));
    })
  );

  // ── Search & Discovery Framework ─────────────────────────────────────────
  // A shared platform search service. Business modules register searchable
  // object types; the framework owns indexing, query execution, facets,
  // suggestions, saved searches, history, permission-aware filtering, index
  // administration, configuration and exports.
  const searchTenant = (req) => req.tenantId || -1;

  function searchInput(req) {
    return req.method === "GET" ? { ...req.query } : { ...(req.body || {}) };
  }

  app.get(
    "/api/search/meta",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json({
        ...search.vocabulary,
        providers: search.listSearchProviders(),
        object_types: await search.searchableObjectTypesAsync(db, searchTenant(req)),
        configuration: await search.getConfigurationAsync(db, searchTenant(req)),
      });
    })
  );

  app.post(
    "/api/search",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.searchAsync(db, req.body || {}, req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.searchAsync(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/suggestions",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getSuggestionsAsync(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/facets",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getFacetsAsync(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.post(
    "/api/search/advanced",
    authAsync,
    canAsync("iam.search.advanced", "read"),
    wrap(async (req, res) => {
      res.json(await search.advancedSearchAsync(db, req.body || {}, req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.post(
    "/api/search/by-type/:objectType",
    authAsync,
    canAsync("iam.search.advanced", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.searchByTypeAsync(db, req.params.objectType, req.body || {}, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  app.post(
    "/api/search/by-attributes",
    authAsync,
    canAsync("iam.search.advanced", "read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await search.searchByAttributesAsync(db, body.attributes || {}, body, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  app.post(
    "/api/search/by-relationship",
    authAsync,
    canAsync("iam.search.advanced", "read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await search.searchByRelationshipAsync(db, body.related_to || body.relatedTo || {}, body, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  // ── Saved searches ──
  app.get(
    "/api/search/saved",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json({
        items: await search.listSavedSearchesAsync(db, {
          tenantId: searchTenant(req),
          actorId: req.actor.id,
          includeShared: req.query.include_shared !== "false",
        }),
      });
    })
  );

  app.post(
    "/api/search/saved",
    authAsync,
    canAsync("iam.search.saved", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await search.createSavedSearchAsync(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json(await search.getSavedSearchAsync(db, req.params.reference, req.actor, searchTenant(req)));
    })
  );

  app.patch(
    "/api/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "update"),
    wrap(async (req, res) => {
      res.json(
        await search.updateSavedSearchAsync(db, req.params.reference, req.body || {}, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  app.delete(
    "/api/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "delete"),
    wrap(async (req, res) => {
      res.json(await search.deleteSavedSearchAsync(db, req.params.reference, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/search/saved/:reference/run",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.runSavedSearchAsync(db, req.params.reference, req.body || {}, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  // ── Search history ──
  app.get(
    "/api/search/history",
    authAsync,
    canAsync("iam.search.history", "read"),
    wrap(async (req, res) => {
      res.json({
        items: await search.listSearchHistoryAsync(db, {
          tenantId: searchTenant(req),
          actorId: req.actor.id,
          limit: req.query.limit,
          q: req.query.q,
        }),
      });
    })
  );

  app.delete(
    "/api/search/history",
    authAsync,
    canAsync("iam.search.history", "delete"),
    wrap(async (req, res) => {
      res.json(await search.clearSearchHistoryAsync(db, req.actor, searchTenant(req), { all: req.query.all === "true" }));
    })
  );

  app.delete(
    "/api/search/history/:id",
    authAsync,
    canAsync("iam.search.history", "delete"),
    wrap(async (req, res) => {
      res.json(await search.deleteSearchHistoryEntryAsync(db, req.params.id, req.actor, searchTenant(req)));
    })
  );

  // ── Exports ──
  app.get(
    "/api/search/exports",
    authAsync,
    canAsync("iam.search.export", "read"),
    wrap(async (req, res) => {
      res.json({
        items: await search.listExportsAsync(db, {
          tenantId: searchTenant(req),
          actorId: req.query.all === "true" ? null : req.actor.id,
          limit: req.query.limit,
        }),
      });
    })
  );

  app.post(
    "/api/search/exports",
    authAsync,
    canAsync("iam.search.export", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await search.requestExportAsync(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/exports/:reference",
    authAsync,
    canAsync("iam.search.export", "read"),
    wrap(async (req, res) => {
      res.json(await search.getExportAsync(db, req.params.reference, req.actor, searchTenant(req)));
    })
  );

  app.get(
    "/api/search/exports/:reference/download",
    authAsync,
    canAsync("iam.search.export", "read"),
    wrap(async (req, res) => {
      const result = await search.getExportAsync(db, req.params.reference, req.actor, searchTenant(req), {
        includeContent: true,
      });
      const extension = result.format === "csv" ? "csv" : "json";
      res.setHeader("Content-Type", result.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="search-export-${result.uuid}.${extension}"`);
      res.send(result.content);
    })
  );

  // ── Index administration ──
  app.get(
    "/api/search/object-types",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json({
        items: await search.listObjectTypesAsync(db, {
          tenantId: searchTenant(req),
          includeDisabled: req.query.include_disabled === "true",
        }),
      });
    })
  );

  app.post(
    "/api/search/object-types",
    authAsync,
    canAsync("iam.search.indexes", "create"),
    wrap(async (req, res) => {
      res.status(201).json(await search.registerObjectTypeAsync(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/object-types/:code",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json(await search.getObjectTypeAsync(db, req.params.code, searchTenant(req)));
    })
  );

  app.patch(
    "/api/search/object-types/:code",
    authAsync,
    canAsync("iam.search.indexes", "update"),
    wrap(async (req, res) => {
      res.json(await search.updateObjectTypeAsync(db, req.params.code, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/search/object-types/:code/status",
    authAsync,
    canAsync("iam.search.indexes", "update"),
    wrap(async (req, res) => {
      res.json(
        await search.setObjectTypeStatusAsync(db, req.params.code, req.body?.status, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  app.delete(
    "/api/search/object-types/:code",
    authAsync,
    canAsync("iam.search.indexes", "delete"),
    wrap(async (req, res) => {
      res.json(await search.deleteObjectTypeAsync(db, req.params.code, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/indexes/status",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json(await search.indexingStatusAsync(db, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/indexes/failures",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json({ items: await search.listIndexFailuresAsync(db, { tenantId: searchTenant(req), limit: req.query.limit }) });
    })
  );

  app.post(
    "/api/search/indexes/retry",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(
        search.retryIndexFailures(
          db,
          { tenantId: searchTenant(req), includeDeadLetter: req.body?.include_dead_letter === true },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  app.post(
    "/api/search/indexes/drain",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(search.drainIndexQueue(db, { tenantId: searchTenant(req), limit: req.body?.limit }));
    })
  );

  app.post(
    "/api/search/indexes/reindex",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      const body = req.body || {};
      const objectType = body.object_type || body.objectType || null;
      if (body.async === true) {
        const job = jobs.submitJob(
          db,
          {
            job_type_code: "SEARCH_REINDEX",
            name: objectType ? `Reindex ${objectType}` : "Reindex tenant search index",
            tenant_id: searchTenant(req),
            input: { tenant_id: searchTenant(req), object_type: objectType, limit: body.limit },
            source_module: "search",
          },
          { actor: req.actor, ip: clientIp(req) }
        );
        return res.status(202).json({ queued: true, job_ref: job.job_ref, job });
      }
      if (objectType) {
        return res.json(
          search.reindexType(db, { tenantId: searchTenant(req), objectType, limit: body.limit }, req.actor, clientIp(req))
        );
      }
      return res.json(search.reindexTenant(db, { tenantId: searchTenant(req), limit: body.limit }, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/search/indexes/reindex/:objectType/:objectId",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(
        search.reindexObject(
          db,
          { tenantId: searchTenant(req), objectType: req.params.objectType, objectId: req.params.objectId },
          req.actor,
          clientIp(req)
        )
      );
    })
  );

  app.post(
    "/api/search/indexes/prune",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(search.pruneIndex(db, { tenantId: searchTenant(req) }, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/search/indexes/jobs",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      const job = jobs.submitJob(
        db,
        {
          job_type_code: "SEARCH_INDEX",
          name: "Search index maintenance",
          tenant_id: searchTenant(req),
          input: { tenant_id: searchTenant(req), limit: req.body?.limit },
          source_module: "search",
        },
        { actor: req.actor, ip: clientIp(req) }
      );
      res.status(202).json({ queued: true, job_ref: job.job_ref, job });
    })
  );

  app.get(
    "/api/search/configuration",
    authAsync,
    canAsync("iam.search.configuration", "read"),
    wrap(async (req, res) => {
      res.json(await search.getConfigurationAsync(db, searchTenant(req)));
    })
  );

  app.put(
    "/api/search/configuration",
    authAsync,
    canAsync("iam.search.configuration", "update"),
    wrap(async (req, res) => {
      res.json(await search.updateConfigurationAsync(db, searchTenant(req), req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/search/metrics",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json(await search.searchMetricsAsync(db, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/health",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (_req, res) => {
      res.json(await search.searchHealthAsync(db));
    })
  );

  // ── Search & Discovery (versioned canonical API, /api/v1/search) ──────────
  // Provider-independent Enterprise Search Foundation surface. The canonical
  // contract never exposes storage-engine/provider syntax to callers.
  const v1SearchTenant = (req) => searchTenant(req);
  const v1SearchInput = (req) => (req.method === "GET" ? { ...req.query } : { ...(req.body || {}) });

  app.get(
    "/api/v1/search/meta",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getMetaAsync(db, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.post(
    "/api/v1/search",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.searchObjectsAsync(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.post(
    "/api/v1/search/parse",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.parseQuery(req.body || {}));
    })
  );

  app.post(
    "/api/v1/search/count",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.countObjectsAsync(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.post(
    "/api/v1/search/bulk",
    authAsync,
    canAsync("iam.search.advanced", "read"),
    wrap(async (req, res) => {
      res.json(await search.bulkSearchAsync(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/objects",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.listSearchObjectsAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          includeDisabled: req.query.include_disabled === "true",
        })
      );
    })
  );

  app.get(
    "/api/v1/search/objects/:objectType",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getSearchObjectAsync(db, req.params.objectType, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/facets",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getObjectFacetsAsync(db, v1SearchInput(req), req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/suggestions",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(await search.getObjectSuggestionsAsync(db, v1SearchInput(req), req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/history",
    authAsync,
    canAsync("iam.search.history", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.getHistoryAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          limit: req.query.limit,
          q: req.query.q,
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/history",
    authAsync,
    canAsync("iam.search.history", "delete"),
    wrap(async (req, res) => {
      res.json(
        await search.clearHistoryAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          all: req.query.all === "true",
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/history/:id",
    authAsync,
    canAsync("iam.search.history", "delete"),
    wrap(async (req, res) => {
      res.json(await search.removeHistoryEntryAsync(db, req.params.id, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/saved",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.listSavedAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          includeShared: req.query.include_shared !== "false",
        })
      );
    })
  );

  app.post(
    "/api/v1/search/saved",
    authAsync,
    canAsync("iam.search.saved", "create"),
    wrap(async (req, res) => {
      res.status(201).json(
        await search.createSavedAsync(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req), ip: clientIp(req) })
      );
    })
  );

  app.get(
    "/api/v1/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json(await search.getSavedAsync(db, req.params.reference, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.put(
    "/api/v1/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "update"),
    wrap(async (req, res) => {
      res.json(
        await search.updateSavedAsync(db, req.params.reference, req.body || {}, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/saved/:reference",
    authAsync,
    canAsync("iam.search.saved", "delete"),
    wrap(async (req, res) => {
      res.json(
        await search.removeSavedAsync(db, req.params.reference, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/v1/search/saved/:reference/execute",
    authAsync,
    canAsync("iam.search.saved", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.runSavedAsync(db, req.params.reference, req.body || {}, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/v1/search/index",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(
        search.indexDocuments(db, req.body || {}, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/v1/search/index/rebuild",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const job = jobs.submitJob(
          db,
          {
            job_type_code: "SEARCH_REINDEX",
            name: "Rebuild search index",
            tenant_id: v1SearchTenant(req),
            input: {
              tenant_id: v1SearchTenant(req),
              scope: body.scope,
              object_type: body.object_type || body.objectType,
              object_id: body.object_id || body.objectId,
              organization_id: body.organization_id || body.organizationId,
              limit: body.limit,
            },
            source_module: "search",
          },
          { actor: req.actor, ip: clientIp(req) }
        );
        return res.status(202).json({ queued: true, job_ref: job.job_ref, job });
      }
      res.json(
        search.rebuildIndex(db, body, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.get(
    "/api/v1/search/index/status",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.getIndexStatusAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          limit: req.query.limit,
        })
      );
    })
  );

  app.get(
    "/api/v1/search/index/jobs",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(
        jobs.listJobs(
          db,
          { job_type_code: "SEARCH_REINDEX", status: req.query.status, limit: req.query.limit },
          v1SearchTenant(req)
        )
      );
    })
  );

  app.post(
    "/api/v1/search/index/retry-failed",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(
        search.retryFailedIndexing(db, req.actor, {
          tenantId: v1SearchTenant(req),
          includeDeadLetter: req.body?.include_dead_letter === true,
          ip: clientIp(req),
        })
      );
    })
  );

  app.get(
    "/api/v1/search/fields",
    authAsync,
    canAsync("iam.search.configuration", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.listFieldsAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          objectType: req.query.object_type || req.query.objectType,
        })
      );
    })
  );

  app.post(
    "/api/v1/search/fields",
    authAsync,
    canAsync("iam.search.configuration", "update"),
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await search.createFieldAsync(db, req.body || {}, req.actor, {
            tenantId: v1SearchTenant(req),
            ip: clientIp(req),
          })
        );
    })
  );

  app.delete(
    "/api/v1/search/fields/:objectType/:field",
    authAsync,
    canAsync("iam.search.configuration", "update"),
    wrap(async (req, res) => {
      res.json(
        await search.removeFieldAsync(db, req.params.objectType, req.params.field, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/v1/search/content-text",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res
        .status(201)
        .json(
          search.putObjectExtractedText(db, req.body || {}, req.actor, {
            tenantId: v1SearchTenant(req),
            ip: clientIp(req),
          })
        );
    })
  );

  app.get(
    "/api/v1/search/content-text",
    authAsync,
    canAsync("iam.search.global", "read"),
    wrap(async (req, res) => {
      res.json(
        await search.getObjectExtractedTextAsync(db, req.actor, {
          tenantId: v1SearchTenant(req),
          objectType: req.query.object_type || req.query.objectType,
          objectId: req.query.object_id || req.query.objectId,
          limit: req.query.limit,
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/content-text",
    auth,
    can("iam.search.indexes", "execute"),
    wrap((req, res) => {
      res.json(
        search.removeObjectExtractedText(db, req.body || {}, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.get(
    "/api/v1/search/health",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (_req, res) => {
      res.json(await search.getHealthAsync(db));
    })
  );

  app.get(
    "/api/v1/search/metrics",
    authAsync,
    canAsync("iam.search.indexes", "read"),
    wrap(async (req, res) => {
      res.json(await search.getMetricsAsync(db, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  // ── Data Security & Entitlement Model (versioned API, /api/v1/security) ───
  // Centralized RBAC + object/field/row/organization/plant/classification
  // security + masking with an ABAC-ready policy engine.
  const securityTenant = (req) => req.tenantId ?? req.actor?.tenant_id ?? 0;

  app.get(
    "/api/v1/security/vocabulary",
    auth,
    can("iam.security.console", "read"),
    wrap((_req, res) => res.json(security.securityVocabulary()))
  );

  app.get(
    "/api/v1/security/overview",
    authAsync,
    canAsync("iam.security.console", "read"),
    wrap(async (req, res) => res.json(await security.securityOverviewAsync(db, securityTenant(req))))
  );

  app.post(
    "/api/v1/security/cache/invalidate",
    authAsync,
    canAsync("iam.security.console", "execute"),
    wrap(async (req, res) => {
      await security.invalidateSecurityAsync(db, securityTenant(req), req.body?.scope || "all");
      res.json({ ok: true });
    })
  );

  // Object type registration
  app.get(
    "/api/v1/security/object-types",
    authAsync,
    canAsync("iam.security.objecttypes", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityObjectTypesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/object-types",
    authAsync,
    canAsync("iam.security.objecttypes", "create"),
    wrap(async (req, res) =>
      res
        .status(201)
        .json(await security.registerSecurityObjectTypeAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/object-types/:objectType",
    authAsync,
    canAsync("iam.security.objecttypes", "update"),
    wrap(async (req, res) =>
      res.json(
        await security.updateSecurityObjectTypeAsync(
          db,
          securityTenant(req),
          req.params.objectType,
          req.body || {},
          req.actor,
          clientIp(req)
        )
      )
    )
  );
  app.post(
    "/api/v1/security/object-types/:objectType/status",
    authAsync,
    canAsync("iam.security.objecttypes", "update"),
    wrap(async (req, res) =>
      res.json(
        await security.setSecurityObjectTypeStatusAsync(
          db,
          securityTenant(req),
          req.params.objectType,
          req.body?.status,
          req.actor,
          clientIp(req)
        )
      )
    )
  );

  // Policies
  app.get(
    "/api/v1/security/policies",
    authAsync,
    canAsync("iam.security.policies", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityPoliciesAsync(db, securityTenant(req), req.query || {})))
  );
  app.get(
    "/api/v1/security/policies/:id",
    authAsync,
    canAsync("iam.security.policies", "read"),
    wrap(async (req, res) => res.json(await security.getSecurityPolicyAsync(db, securityTenant(req), req.params.id)))
  );
  app.post(
    "/api/v1/security/policies",
    authAsync,
    canAsync("iam.security.policies", "create"),
    wrap(async (req, res) =>
      res.status(201).json(await security.createSecurityPolicyAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/policies/:id",
    authAsync,
    canAsync("iam.security.policies", "update"),
    wrap(async (req, res) =>
      res.json(await security.updateSecurityPolicyAsync(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/policies/:id/status",
    authAsync,
    canAsync("iam.security.policies", "update"),
    wrap(async (req, res) =>
      res.json(await security.setSecurityPolicyStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Entitlements
  app.get(
    "/api/v1/security/entitlements",
    authAsync,
    canAsync("iam.security.entitlements", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityEntitlementsAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/entitlements",
    authAsync,
    canAsync("iam.security.entitlements", "create"),
    wrap(async (req, res) =>
      res.status(201).json(await security.createSecurityEntitlementAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/entitlements/:id",
    authAsync,
    canAsync("iam.security.entitlements", "update"),
    wrap(async (req, res) =>
      res.json(await security.updateSecurityEntitlementAsync(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/entitlements/:id/status",
    authAsync,
    canAsync("iam.security.entitlements", "update"),
    wrap(async (req, res) =>
      res.json(await security.setSecurityEntitlementStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Field security & masking
  app.get(
    "/api/v1/security/field-rules",
    authAsync,
    canAsync("iam.security.fields", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityFieldRulesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/field-rules",
    authAsync,
    canAsync("iam.security.fields", "create"),
    wrap(async (req, res) =>
      res.status(201).json(await security.createSecurityFieldRuleAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/field-rules/:id",
    authAsync,
    canAsync("iam.security.fields", "update"),
    wrap(async (req, res) =>
      res.json(await security.updateSecurityFieldRuleAsync(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/field-rules/:id/status",
    authAsync,
    canAsync("iam.security.fields", "update"),
    wrap(async (req, res) =>
      res.json(await security.setSecurityFieldRuleStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );
  app.get(
    "/api/v1/security/masking-rules",
    authAsync,
    canAsync("iam.security.fields", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityMaskingRulesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/masking-rules",
    authAsync,
    canAsync("iam.security.fields", "create"),
    wrap(async (req, res) =>
      res.status(201).json(await security.createSecurityMaskingRuleAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/masking-rules/:id/status",
    authAsync,
    canAsync("iam.security.fields", "update"),
    wrap(async (req, res) =>
      res.json(await security.setSecurityMaskingRuleStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Classification security
  app.get(
    "/api/v1/security/classification-rules",
    authAsync,
    canAsync("iam.security.classifications", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityClassificationRulesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/classification-rules",
    authAsync,
    canAsync("iam.security.classifications", "create"),
    wrap(async (req, res) =>
      res
        .status(201)
        .json(await security.createSecurityClassificationRuleAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/classification-rules/:id/status",
    authAsync,
    canAsync("iam.security.classifications", "update"),
    wrap(async (req, res) =>
      res.json(
        await security.setSecurityClassificationRuleStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );

  // Organization & plant security
  app.get(
    "/api/v1/security/organization-rules",
    authAsync,
    canAsync("iam.security.organizations", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityOrganizationRulesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/organization-rules",
    authAsync,
    canAsync("iam.security.organizations", "create"),
    wrap(async (req, res) =>
      res
        .status(201)
        .json(await security.createSecurityOrganizationRuleAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/organization-rules/:id/status",
    authAsync,
    canAsync("iam.security.organizations", "update"),
    wrap(async (req, res) =>
      res.json(
        await security.setSecurityOrganizationRuleStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );
  app.get(
    "/api/v1/security/plant-rules",
    authAsync,
    canAsync("iam.security.organizations", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityPlantRulesAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/plant-rules",
    authAsync,
    canAsync("iam.security.organizations", "create"),
    wrap(async (req, res) =>
      res.status(201).json(await security.createSecurityPlantRuleAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/plant-rules/:id/status",
    authAsync,
    canAsync("iam.security.organizations", "update"),
    wrap(async (req, res) =>
      res.json(
        await security.setSecurityPlantRuleStatusAsync(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );

  // Authorization debugger
  app.get(
    "/api/v1/security/decisions",
    authAsync,
    canAsync("iam.security.decisions", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityDecisionsAsync(db, securityTenant(req), req.query || {})))
  );
  app.get(
    "/api/v1/security/context/:userId",
    authAsync,
    canAsync("iam.security.decisions", "read"),
    wrap(async (req, res) =>
      res.json(await security.effectiveSecurityContextAsync(db, securityTenant(req), req.params.userId, { organizationId: req.query.organization_id }))
    )
  );
  app.post(
    "/api/v1/security/evaluate",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) =>
      res.json(security.explainAuthorization(db, req.actor, securityTenant(req), req.body || {}, { ip: clientIp(req), correlationId: req.correlationId }))
    )
  );
  // Batch evaluation reuses the same deterministic engine; order is preserved.
  app.post(
    "/api/v1/security/evaluate/batch",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) => {
      const body = req.body || {};
      const requests = Array.isArray(body.requests) ? body.requests : Array.isArray(body) ? body : [];
      res.json(
        security.explainAuthorizationBatch(
          db,
          req.actor,
          securityTenant(req),
          { requests },
          { ip: clientIp(req), correlationId: req.correlationId }
        )
      );
    })
  );

  // Canonical authorization surface (spec §16). Both delegate to the same
  // centralized engine so there is exactly one decision path.
  const subjectIdFrom = (body) => {
    const subject = body?.subject;
    if (subject && typeof subject === "object") return subject.id ?? subject.user_id ?? subject.userId ?? null;
    return subject ?? body?.user_id ?? body?.userId ?? null;
  };
  const authorizationInput = (body = {}, subjectId) => ({
    ...body,
    user_id: subjectId ?? undefined,
    action: body.action ?? "read",
    resource_type: body.resource?.type ?? body.resource_type ?? body.object_type,
    resource_id: body.resource?.id ?? body.resource_id ?? null,
    organization_id: body.resource?.organizationId ?? body.organization_id,
    plant_id: body.resource?.plantId ?? body.plant_id,
    classification: body.resource?.classification ?? body.classification,
  });
  app.post(
    "/api/v1/authorization/check",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        security.explainAuthorization(
          db,
          req.actor,
          securityTenant(req),
          authorizationInput(body, subjectIdFrom(body)),
          { ip: clientIp(req), correlationId: req.correlationId }
        )
      );
    })
  );
  app.post(
    "/api/v1/authorization/batch-check",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) => {
      const body = req.body || {};
      const requests = (Array.isArray(body.requests) ? body.requests : []).map((request) =>
        authorizationInput(request, subjectIdFrom(request))
      );
      res.json(
        security.explainAuthorizationBatch(
          db,
          req.actor,
          securityTenant(req),
          { requests },
          { ip: clientIp(req), correlationId: req.correlationId }
        )
      );
    })
  );

  // Canonical entitlement aliases (spec §16) backed by the same service.
  app.get(
    "/api/v1/entitlements",
    authAsync,
    canAsync("iam.security.entitlements", "read"),
    wrap(async (req, res) => res.json(await security.listSecurityEntitlementsAsync(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/entitlements",
    authAsync,
    canAsync("iam.security.entitlements", "create"),
    wrap(async (req, res) =>
      res
        .status(201)
        .json(await security.createSecurityEntitlementAsync(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/entitlements/:id",
    authAsync,
    canAsync("iam.security.entitlements", "update"),
    wrap(async (req, res) =>
      res.json(await security.updateSecurityEntitlementAsync(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );

  // ── Integration & API Framework ───────────────────────────────────────────
  const integrationTenant = (req) => req.tenantId ?? null;
  const canIntegrationsAsync = (action) => canAsync("iam.integration", action);
  const canIntSystemsAsync = (action) => canAsync("iam.integration.systems", action);
  const canIntEndpointsAsync = (action) => canAsync("iam.integration.endpoints", action);
  const canIntTransformsAsync = (action) => canAsync("iam.integration.transforms", action);
  const canIntMappingsAsync = (action) => canAsync("iam.integration.mappings", action);
  const canIntSchedulesAsync = (action) => canAsync("iam.integration.schedules", action);
  const canIntEventsAsync = (action) => canAsync("iam.integration.events", action);
  const canIntWebhooksAsync = (action) => canAsync("iam.integration.webhooks", action);
  const canIntMessagesAsync = (action) => canAsync("iam.integration.messages", action);
  const canIntDeadLettersAsync = (action) => canAsync("iam.integration.deadletters", action);
  const canIntTransfersAsync = (action) => canAsync("iam.integration.transfers", action);
  const canIntMonitoringAsync = (action) => canAsync("iam.integration.monitoring", action);
  const canIntApiAsync = (action) => canAsync("iam.integration.api", action);

  const integrationRouter = express.Router();

  integrationRouter.get(
    "/meta",
    authAsync,
    canIntegrationsAsync("read"),
    wrap((_req, res) => {
      res.json({
        ...integration.Validation.vocabulary(),
        adapters: integration.Adapters.listAdapters(),
        handlers: integration.Definitions.listIntegrationHandlers(),
        transfer_handlers: integration.Transfers.listTransferHandlers(),
      });
    })
  );

  // Definitions
  integrationRouter.get(
    "/definitions",
    authAsync,
    canIntegrationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.listDefinitionsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/definitions",
    authAsync,
    canIntegrationsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Definitions.createDefinitionAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/definitions/:code",
    authAsync,
    canIntegrationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.getDefinitionAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/definitions/:code",
    authAsync,
    canIntegrationsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.updateDefinitionAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/definitions/:code/status",
    authAsync,
    canIntegrationsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.setDefinitionStatusAsync(db, req.params.code, req.body?.status, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/definitions/:code",
    authAsync,
    canIntegrationsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.deleteDefinitionAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/definitions/:code/versions",
    authAsync,
    canIntegrationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.listDefinitionVersionsAsync(db, req.params.code));
    })
  );
  integrationRouter.post(
    "/definitions/:code/versions/:version/restore",
    authAsync,
    canIntegrationsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.restoreDefinitionVersionAsync(db, req.params.code, req.params.version, req.actor));
    })
  );
  integrationRouter.post(
    "/definitions/:code/run",
    authAsync,
    canIntegrationsAsync("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const definition = await integration.Definitions.getDefinitionAsync(db, req.params.code);
        const job = jobs.submitJob(
          db,
          {
            job_type_code: "INTEGRATION_SYNC",
            name: `Run integration ${definition.code}`,
            tenant_id: integrationTenant(req),
            input: { integration_code: definition.code, trigger_type: "api", payload: body.payload || {} },
            source_module: "integration",
          },
          { actor: req.actor, ip: clientIp(req) }
        );
        return res.status(202).json({ queued: true, job_ref: job.job_ref, job });
      }
      const result = await integration.Definitions.executeIntegrationAsync(db, req.params.code, {
        triggerType: "api",
        actor: req.actor,
        input: { payload: body.payload || {}, correlation_id: body.correlation_id, request_ref: body.request_ref },
      });
      res.json(result);
    })
  );

  // Executions
  integrationRouter.get(
    "/executions",
    authAsync,
    canIntegrationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.listExecutionsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/executions/:ref",
    authAsync,
    canIntegrationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.getExecutionAsync(db, req.params.ref));
    })
  );
  integrationRouter.post(
    "/executions/:ref/retry",
    authAsync,
    canIntegrationsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.retryExecutionAsync(db, req.params.ref, req.actor));
    })
  );
  integrationRouter.post(
    "/executions/:ref/cancel",
    authAsync,
    canIntegrationsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.markExecutionCancelledAsync(db, req.params.ref, req.actor));
    })
  );

  // Credentials
  integrationRouter.get(
    "/credentials",
    authAsync,
    canIntSystemsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.listCredentialsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/credentials",
    authAsync,
    canIntSystemsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Systems.createCredentialAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/credentials/:code",
    authAsync,
    canIntSystemsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.getCredentialAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/credentials/:code",
    authAsync,
    canIntSystemsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.updateCredentialAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/credentials/:code",
    authAsync,
    canIntSystemsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.deleteCredentialAsync(db, req.params.code, req.actor));
    })
  );

  // External systems
  integrationRouter.get(
    "/systems",
    authAsync,
    canIntSystemsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.listExternalSystemsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/systems",
    authAsync,
    canIntSystemsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Systems.createExternalSystemAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/systems/:code",
    authAsync,
    canIntSystemsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.getExternalSystemAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/systems/:code",
    authAsync,
    canIntSystemsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.updateExternalSystemAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/systems/:code",
    authAsync,
    canIntSystemsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.deleteExternalSystemAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/systems/:code/test",
    authAsync,
    canIntSystemsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Systems.testConnectionAsync(db, req.params.code, req.actor, clientIp(req)));
    })
  );
  integrationRouter.get(
    "/systems/:code/health",
    authAsync,
    canIntSystemsAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await integration.Systems.listHealthChecksAsync(db, req.params.code, { limit: req.query.limit }) });
    })
  );

  // Endpoints
  integrationRouter.get(
    "/endpoints",
    authAsync,
    canIntEndpointsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Endpoints.listEndpointsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/endpoints",
    authAsync,
    canIntEndpointsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Endpoints.createEndpointAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/endpoints/:code",
    authAsync,
    canIntEndpointsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Endpoints.getEndpointAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/endpoints/:code",
    authAsync,
    canIntEndpointsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Endpoints.updateEndpointAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/endpoints/:code",
    authAsync,
    canIntEndpointsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Endpoints.deleteEndpointAsync(db, req.params.code, req.actor));
    })
  );

  // Transformations
  integrationRouter.get(
    "/transformations",
    authAsync,
    canIntTransformsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Transform.listTransformationsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/transformations",
    authAsync,
    canIntTransformsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Transform.createTransformationAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/transformations/:code",
    authAsync,
    canIntTransformsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Transform.getTransformationAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/transformations/:code",
    authAsync,
    canIntTransformsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Transform.updateTransformationAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/transformations/:code",
    authAsync,
    canIntTransformsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Transform.deleteTransformationAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/transformations/:code/test",
    authAsync,
    canIntTransformsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Transform.testTransformationAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );

  // External object mappings
  integrationRouter.get(
    "/mappings/stats",
    authAsync,
    canIntMappingsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Mappings.mappingStatsAsync(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/mappings",
    authAsync,
    canIntMappingsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Mappings.listMappingsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/mappings",
    authAsync,
    canIntMappingsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Mappings.upsertMappingAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/mappings/:id",
    authAsync,
    canIntMappingsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Mappings.getMappingAsync(db, req.params.id));
    })
  );
  integrationRouter.patch(
    "/mappings/:id",
    authAsync,
    canIntMappingsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Mappings.updateMappingAsync(db, req.params.id, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/mappings/:id",
    authAsync,
    canIntMappingsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Mappings.deleteMappingAsync(db, req.params.id, req.actor));
    })
  );

  // Schedules
  integrationRouter.get(
    "/schedules",
    authAsync,
    canIntSchedulesAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.listSchedulesAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/schedules",
    authAsync,
    canIntSchedulesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Schedules.createScheduleAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/schedules/:code",
    authAsync,
    canIntSchedulesAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.getScheduleAsync(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/schedules/:code",
    authAsync,
    canIntSchedulesAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.updateScheduleAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/schedules/:code/status",
    authAsync,
    canIntSchedulesAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.setScheduleStatusAsync(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.post(
    "/schedules/:code/run",
    authAsync,
    canIntSchedulesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.runScheduleNowAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.delete(
    "/schedules/:code",
    authAsync,
    canIntSchedulesAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Schedules.deleteScheduleAsync(db, req.params.code, req.actor));
    })
  );

  // Event types
  integrationRouter.get(
    "/event-types",
    authAsync,
    canIntEventsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Events.listEventTypesAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/event-types",
    authAsync,
    canIntEventsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Events.createEventTypeAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.patch(
    "/event-types/:code",
    authAsync,
    canIntEventsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Events.updateEventTypeAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/event-types/:code",
    authAsync,
    canIntEventsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Events.deleteEventTypeAsync(db, req.params.code, req.actor));
    })
  );

  // Event subscriptions
  integrationRouter.get(
    "/subscriptions",
    authAsync,
    canIntEventsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Events.listSubscriptionsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/subscriptions",
    authAsync,
    canIntEventsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Events.createSubscriptionAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.patch(
    "/subscriptions/:code",
    authAsync,
    canIntEventsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Events.updateSubscriptionAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/subscriptions/:code/status",
    authAsync,
    canIntEventsAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Events.setSubscriptionStatusAsync(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.delete(
    "/subscriptions/:code",
    authAsync,
    canIntEventsAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Events.deleteSubscriptionAsync(db, req.params.code, req.actor));
    })
  );

  // Events
  integrationRouter.get(
    "/events",
    authAsync,
    canIntEventsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Events.listEventsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/events",
    authAsync,
    canIntEventsAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Events.publishEventAsync(db, { ...(req.body || {}), tenant_id: integrationTenant(req) }, req.actor));
    })
  );
  integrationRouter.get(
    "/events/:ref",
    authAsync,
    canIntEventsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Events.getEventAsync(db, req.params.ref, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/events/:ref/replay",
    authAsync,
    canIntEventsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Events.replayEventAsync(db, req.params.ref, req.actor));
    })
  );

  // Event deliveries
  integrationRouter.get(
    "/deliveries",
    authAsync,
    canIntEventsAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Events.listDeliveriesAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/deliveries/:id/retry",
    authAsync,
    canIntEventsAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Events.retryDeliveryAsync(db, req.params.id, req.actor));
    })
  );

  // Inbound webhooks
  integrationRouter.get(
    "/webhooks/inbound",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.listInboundWebhooksAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/webhooks/inbound",
    authAsync,
    canIntWebhooksAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Webhooks.createInboundWebhookAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/webhooks/inbound/:code",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.getInboundWebhookAsync(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/webhooks/inbound/:code",
    authAsync,
    canIntWebhooksAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.updateInboundWebhookAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/inbound/:code/status",
    authAsync,
    canIntWebhooksAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.setInboundWebhookStatusAsync(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.delete(
    "/webhooks/inbound/:code",
    authAsync,
    canIntWebhooksAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.deleteInboundWebhookAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/webhooks/inbound/:code/receipts",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      const endpoint = await integration.Webhooks.getInboundWebhookAsync(db, req.params.code);
      res.json(await integration.Webhooks.listInboundReceiptsAsync(db, { endpointId: endpoint.id, ...req.query }));
    })
  );

  // Outbound webhooks
  integrationRouter.get(
    "/webhooks/outbound",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.listOutboundWebhooksAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound",
    authAsync,
    canIntWebhooksAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Webhooks.createOutboundWebhookAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/webhooks/outbound/:code",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.getOutboundWebhookAsync(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/webhooks/outbound/:code",
    authAsync,
    canIntWebhooksAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.updateOutboundWebhookAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound/:code/status",
    authAsync,
    canIntWebhooksAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.setOutboundWebhookStatusAsync(db, req.params.code, req.body?.status, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/webhooks/outbound/:code",
    authAsync,
    canIntWebhooksAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.deleteOutboundWebhookAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound/:code/test",
    authAsync,
    canIntWebhooksAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.testOutboundWebhookAsync(db, req.params.code));
    })
  );
  integrationRouter.get(
    "/webhooks/outbound/:code/deliveries",
    authAsync,
    canIntWebhooksAsync("read"),
    wrap(async (req, res) => {
      const webhook = await integration.Webhooks.getOutboundWebhookAsync(db, req.params.code);
      res.json(await integration.Webhooks.listOutboundDeliveriesAsync(db, { subscriptionId: webhook.id, ...req.query }));
    })
  );

  // Public inbound webhook receiver (authenticated by endpoint signature/API key,
  // not by the session bearer token).
  const receiveWebhook = wrap(async (req, res) => {
    const body = req.body && Object.keys(req.body).length ? req.body : req.rawBody || {};
    const result = await integration.Webhooks.receiveInboundWebhookAsync(db, req.params.code, {
      headers: req.headers,
      body,
      rawBody: req.rawBody,
      ip: clientIp(req),
    });
    res.status(202).json(result);
  });
  integrationRouter.post("/webhooks/receive/:code", receiveWebhook);
  app.post("/api/v1/integration/webhooks/receive/:code", receiveWebhook);

  // Messages & queues
  integrationRouter.get(
    "/queues",
    authAsync,
    canIntMessagesAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await integration.Messages.listQueuesAsync(db, { tenantId: integrationTenant(req) }) });
    })
  );
  integrationRouter.get(
    "/messages",
    authAsync,
    canIntMessagesAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Messages.listMessagesAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/messages",
    authAsync,
    canIntMessagesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.Messages.enqueueMessageAsync(db, { ...(req.body || {}), tenant_id: integrationTenant(req) }, req.actor));
    })
  );
  integrationRouter.get(
    "/messages/:ref",
    authAsync,
    canIntMessagesAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Messages.getMessageAsync(db, req.params.ref, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/messages/:ref/retry",
    authAsync,
    canIntMessagesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Messages.requeueMessageAsync(db, req.params.ref, { resetAttempts: req.body?.reset_attempts === true, actor: req.actor }));
    })
  );
  integrationRouter.post(
    "/messages/:ref/cancel",
    authAsync,
    canIntMessagesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Messages.cancelMessageAsync(db, req.params.ref, req.actor, req.body?.reason));
    })
  );

  // Dead letters
  integrationRouter.get(
    "/dead-letters/stats",
    authAsync,
    canIntDeadLettersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.deadLetterStatsAsync(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/dead-letters",
    authAsync,
    canIntDeadLettersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.listDeadLettersAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/dead-letters/bulk-retry",
    authAsync,
    canIntDeadLettersAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.bulkRetryDeadLettersAsync(db, req.body?.ids || [], req.actor));
    })
  );
  integrationRouter.get(
    "/dead-letters/:id",
    authAsync,
    canIntDeadLettersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.getDeadLetterAsync(db, req.params.id, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/inspect",
    authAsync,
    canIntDeadLettersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.inspectDeadLetterPayloadAsync(db, req.params.id, req.actor));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/retry",
    authAsync,
    canIntDeadLettersAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.retryDeadLetterAsync(db, req.params.id, req.actor, { resetAttempts: req.body?.reset_attempts !== false }));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/resolve",
    authAsync,
    canIntDeadLettersAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.DeadLetter.resolveDeadLetterAsync(db, req.params.id, { status: req.body?.status, resolution: req.body?.resolution, actor: req.actor }));
    })
  );

  // Transfers (import/export)
  integrationRouter.get(
    "/transfers/handlers",
    authAsync,
    canIntTransfersAsync("read"),
    wrap((_req, res) => {
      res.json(integration.Transfers.listTransferHandlers());
    })
  );
  integrationRouter.get(
    "/transfers",
    authAsync,
    canIntTransfersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Transfers.listTransfersAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/transfers/import/preview",
    authAsync,
    canIntTransfersAsync("create"),
    wrap(async (req, res) => {
      res.json(await integration.Transfers.previewImportAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.post(
    "/transfers/import",
    authAsync,
    canIntTransfersAsync("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const transfer = await integration.Transfers.runImportTransferAsync(db, { ...body, dry_run: true }, req.actor, integrationTenant(req));
        const job = jobs.submitJob(
          db,
          {
            job_type_code: "INTEGRATION_TRANSFER",
            name: `Import ${body.resource_type || "data"}`,
            tenant_id: integrationTenant(req),
            input: { transfer_ref: transfer.transfer_ref, direction: "import" },
            source_module: "integration",
          },
          { actor: req.actor, ip: clientIp(req) }
        );
        return res.status(202).json({ queued: true, transfer_ref: transfer.transfer_ref, job_ref: job.job_ref, job });
      }
      res.status(201).json(await integration.Transfers.runImportTransferAsync(db, body, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.post(
    "/transfers/export",
    authAsync,
    canIntTransfersAsync("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const transfer = await integration.Transfers.runExportTransferAsync(db, { ...body, dry_run: true }, req.actor, integrationTenant(req));
        const job = jobs.submitJob(
          db,
          {
            job_type_code: "INTEGRATION_TRANSFER",
            name: `Export ${body.resource_type || "data"}`,
            tenant_id: integrationTenant(req),
            input: { transfer_ref: transfer.transfer_ref, direction: "export" },
            source_module: "integration",
          },
          { actor: req.actor, ip: clientIp(req) }
        );
        return res.status(202).json({ queued: true, transfer_ref: transfer.transfer_ref, job_ref: job.job_ref, job });
      }
      res.status(201).json(await integration.Transfers.runExportTransferAsync(db, body, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/transfers/:ref",
    authAsync,
    canIntTransfersAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Transfers.getTransferAsync(db, req.params.ref));
    })
  );
  integrationRouter.get(
    "/transfers/:ref/download",
    authAsync,
    canIntTransfersAsync("read"),
    wrap(async (req, res) => {
      const result = await integration.Transfers.getTransferContentAsync(db, req.params.ref);
      res.setHeader("Content-Type", result.content_type);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    })
  );
  integrationRouter.post(
    "/transfers/:ref/cancel",
    authAsync,
    canIntTransfersAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Transfers.cancelTransferAsync(db, req.params.ref, req.actor));
    })
  );

  // Monitoring & dashboards
  integrationRouter.get(
    "/monitoring/overview",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Monitoring.monitoringOverviewAsync(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );
  integrationRouter.get(
    "/monitoring/executions",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Monitoring.executionMetricsAsync(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );
  integrationRouter.get(
    "/monitoring/deliveries",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Monitoring.deliveryMetricsAsync(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/monitoring/systems",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json({ items: await integration.Monitoring.listSystemsHealthAsync(db, { tenantId: integrationTenant(req), status: req.query.status }) });
    })
  );
  integrationRouter.get(
    "/monitoring/systems/:code/uptime",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.Monitoring.systemUptimeAsync(db, req.params.code, { hours: req.query.hours }));
    })
  );
  integrationRouter.post(
    "/monitoring/health-checks/run",
    authAsync,
    canIntMonitoringAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Monitoring.runHealthChecksAsync(db, { actor: req.actor, tenantId: integrationTenant(req), systemType: req.body?.system_type }));
    })
  );
  integrationRouter.get(
    "/monitoring/api-usage",
    authAsync,
    canIntMonitoringAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.apiUsageStatsAsync(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );

  // API catalog & clients
  integrationRouter.get(
    "/api-catalog",
    authAsync,
    canIntApiAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.listApiCatalogAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/api-catalog",
    authAsync,
    canIntApiAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.ApiCatalog.createCatalogEntryAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/api-catalog/:code",
    authAsync,
    canIntApiAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.getCatalogEntryAsync(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/api-catalog/:code",
    authAsync,
    canIntApiAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.updateCatalogEntryAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/api-catalog/:code/status",
    authAsync,
    canIntApiAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.setCatalogStatusAsync(db, req.params.code, req.body?.status, req.actor, req.body || {}));
    })
  );
  integrationRouter.delete(
    "/api-catalog/:code",
    authAsync,
    canIntApiAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.deleteCatalogEntryAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/api-clients",
    authAsync,
    canIntApiAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.listApiClientsAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/api-clients",
    authAsync,
    canIntApiAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await integration.ApiCatalog.createApiClientAsync(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/api-clients/:code",
    authAsync,
    canIntApiAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.getApiClientAsync(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/api-clients/:code",
    authAsync,
    canIntApiAsync("update"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.updateApiClientAsync(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/api-clients/:code/rotate",
    authAsync,
    canIntApiAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.rotateApiKeyAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/api-clients/:code/revoke",
    authAsync,
    canIntApiAsync("execute"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.revokeApiClientAsync(db, req.params.code, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/api-clients/:code",
    authAsync,
    canIntApiAsync("delete"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.deleteApiClientAsync(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/api-usage",
    authAsync,
    canIntApiAsync("read"),
    wrap(async (req, res) => {
      res.json(await integration.ApiCatalog.listApiUsageAsync(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );

  app.use("/api/integration", integrationRouter);
  app.use("/api/v1/integration", integrationRouter);

  // ── Event & Messaging Framework ───────────────────────────────────────────
  const eventTenant = (req) => req.tenantId ?? null;
  const canEvents = (action) => can("iam.events", action);
  const canEventRegistry = (action) => can("iam.events.registry", action);
  const canEventPublish = (action) => can("iam.events.publish", action);
  const canEventSubscriptions = (action) => can("iam.events.subscriptions", action);
  const canEventTopology = (action) => can("iam.events.topology", action);
  const canEventDeliveries = (action) => can("iam.events.deliveries", action);
  const canEventDeadLetters = (action) => can("iam.events.deadletters", action);
  const canEventReplay = (action) => can("iam.events.replay", action);
  const canEventRetention = (action) => can("iam.events.retention", action);
  const canEventMonitoring = (action) => can("iam.events.monitoring", action);
  const truthy = (value) => value === true || /^(1|true|yes|on)$/i.test(String(value ?? ""));

  const eventsRouter = express.Router();

  eventsRouter.get(
    "/meta",
    auth,
    canEvents("read"),
    wrap((_req, res) => {
      res.json({
        ...events.Validation.vocabulary(),
        bus_providers: events.Bus.listBusProviders(),
        handlers: events.Handlers.listHandlers(),
        event_types: events.Registry.listEventTypes(db, { pageSize: 500 }).items.map((t) => ({ code: t.code, name: t.name, category: t.category })),
      });
    })
  );

  // ── Event registry & schema versions ──────────────────────────────────────
  eventsRouter.get(
    "/event-types",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json(events.Registry.listEventTypes(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/event-types",
    auth,
    canEventRegistry("create"),
    wrap((req, res) => {
      res.status(201).json(events.Registry.createEventType(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/event-types/:code",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json(events.Registry.getEventType(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/event-types/:code",
    auth,
    canEventRegistry("update"),
    wrap((req, res) => {
      res.json(events.Registry.updateEventType(db, req.params.code, req.body || {}, req.actor));
    })
  );
  eventsRouter.delete(
    "/event-types/:code",
    auth,
    canEventRegistry("delete"),
    wrap((req, res) => {
      res.json(events.Registry.deleteEventType(db, req.params.code, req.actor));
    })
  );
  eventsRouter.get(
    "/event-types/:code/versions",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json({ items: events.Registry.listVersions(db, req.params.code) });
    })
  );
  eventsRouter.post(
    "/event-types/:code/versions",
    auth,
    canEventRegistry("create"),
    wrap((req, res) => {
      res.status(201).json(events.Registry.addVersion(db, req.params.code, req.body || {}, req.actor));
    })
  );
  eventsRouter.patch(
    "/event-types/:code/versions/:version",
    auth,
    canEventRegistry("update"),
    wrap((req, res) => {
      res.json(events.Registry.setVersionStatus(db, req.params.code, Number(req.params.version), req.body?.status, req.actor));
    })
  );
  eventsRouter.post(
    "/event-types/:code/compatibility",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json(events.Registry.checkCompatibility(db, req.params.code, req.body || {}));
    })
  );

  // ── Publishing ────────────────────────────────────────────────────────────
  eventsRouter.get(
    "/",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Publisher.listEvents(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/",
    auth,
    canEventPublish("create"),
    wrap((req, res) => {
      const body = req.body || {};
      const useOutbox = body.async === false ? false : !truthy(req.query.immediate) && body.immediate !== true;
      res.status(202).json(events.Publisher.publishEvent(db, body, req.actor, { tenantId: eventTenant(req), useOutbox }));
    })
  );
  eventsRouter.post(
    "/publish",
    auth,
    canEventPublish("create"),
    wrap((req, res) => {
      const body = req.body || {};
      const useOutbox = body.async === false ? false : !truthy(req.query.immediate) && body.immediate !== true;
      res.status(202).json(events.Publisher.publishEvent(db, body, req.actor, { tenantId: eventTenant(req), useOutbox }));
    })
  );
  eventsRouter.post(
    "/batch",
    auth,
    canEventPublish("create"),
    wrap((req, res) => {
      const body = req.body || {};
      const result = events.Publisher.publishBatch(db, body.events || body, req.actor, { tenantId: eventTenant(req), useOutbox: truthy(req.query.immediate) ? false : true });
      res.status(207).json(result);
    })
  );
  eventsRouter.post(
    "/validate",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      const body = req.body || {};
      const validated = events.Publisher.validateEvent(db, body, { actor: req.actor, tenantId: eventTenant(req) });
      res.json({ valid: true, envelope: validated.envelope, event_type_code: validated.envelope.event_type_code, resolved_schema: validated.schema });
    })
  );
  eventsRouter.post(
    "/serialize",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      const validated = events.Publisher.validateEvent(db, req.body || {}, { actor: req.actor, tenantId: eventTenant(req) });
      res.json({ serialized: events.Publisher.serializeEvent(validated.envelope) });
    })
  );

  // ── Deliveries & consumers ────────────────────────────────────────────────
  eventsRouter.get(
    "/deliveries",
    auth,
    canEventDeliveries("read"),
    wrap((req, res) => {
      res.json(events.Publisher.listDeliveries(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/deliveries/stats",
    auth,
    canEventDeliveries("read"),
    wrap((req, res) => {
      res.json(events.Consumer.consumerStats(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/deliveries/:id",
    auth,
    canEventDeliveries("read"),
    wrap((req, res) => {
      const list = events.Publisher.listDeliveries(db, { pageSize: 1 });
      const row = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [Number(req.params.id)]);
      if (!row) throw new HttpError(404, "Delivery not found");
      res.json({ ...list, item: events.Repository.publicDelivery(row, { includePayload: true }), attempts: events.Consumer.listAttempts(db, row.id) });
    })
  );
  eventsRouter.post(
    "/deliveries/:id/retry",
    auth,
    canEventDeliveries("update"),
    wrap((req, res) => {
      res.json(events.Consumer.retryDelivery(db, req.params.id, req.actor));
    })
  );
  eventsRouter.post(
    "/deliveries/:id/skip",
    auth,
    canEventDeliveries("update"),
    wrap((req, res) => {
      res.json(events.Consumer.skipDelivery(db, req.params.id, req.actor, req.body?.reason));
    })
  );
  eventsRouter.get(
    "/deliveries/:id/attempts",
    auth,
    canEventDeliveries("read"),
    wrap((req, res) => {
      res.json({ items: events.Consumer.listAttempts(db, req.params.id) });
    })
  );

  // ── Subscriptions ─────────────────────────────────────────────────────────
  eventsRouter.get(
    "/subscriptions",
    auth,
    canEventSubscriptions("read"),
    wrap((req, res) => {
      res.json(events.Subscriptions.listSubscriptions(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/subscriptions",
    auth,
    canEventSubscriptions("create"),
    wrap((req, res) => {
      res.status(201).json(events.Subscriptions.createSubscription(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/subscriptions/:code",
    auth,
    canEventSubscriptions("read"),
    wrap((req, res) => {
      res.json(events.Subscriptions.getSubscription(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/subscriptions/:code",
    auth,
    canEventSubscriptions("update"),
    wrap((req, res) => {
      res.json(events.Subscriptions.updateSubscription(db, req.params.code, req.body || {}, req.actor));
    })
  );
  eventsRouter.delete(
    "/subscriptions/:code",
    auth,
    canEventSubscriptions("delete"),
    wrap((req, res) => {
      res.json(events.Subscriptions.deleteSubscription(db, req.params.code, req.actor));
    })
  );
  eventsRouter.post(
    "/subscriptions/:code/status",
    auth,
    canEventSubscriptions("update"),
    wrap((req, res) => {
      res.json(events.Subscriptions.setSubscriptionStatus(db, req.params.code, req.body?.status, req.actor));
    })
  );
  eventsRouter.post(
    "/subscriptions/:code/validate",
    auth,
    canEventSubscriptions("read"),
    wrap((req, res) => {
      res.json(events.Subscriptions.validateSubscription(db, req.params.code));
    })
  );
  eventsRouter.post(
    "/subscriptions/:code/test",
    auth,
    canEventSubscriptions("read"),
    wrap((req, res) => {
      res.json(events.Subscriptions.testSubscription(db, req.params.code, req.body || {}));
    })
  );
  eventsRouter.get(
    "/subscriptions/:code/stats",
    auth,
    canEventSubscriptions("read"),
    wrap((req, res) => {
      res.json(events.Subscriptions.subscriptionStats(db, req.params.code));
    })
  );

  // ── Topics / queues / consumer groups ─────────────────────────────────────
  eventsRouter.get(
    "/topics",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.listTopics(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/topics",
    auth,
    canEventTopology("create"),
    wrap((req, res) => {
      res.status(201).json(events.Bus.createTopic(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/topics/:code",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.getTopic(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/topics/:code",
    auth,
    canEventTopology("update"),
    wrap((req, res) => {
      res.json(events.Bus.updateTopic(db, req.params.code, req.body || {}));
    })
  );
  eventsRouter.delete(
    "/topics/:code",
    auth,
    canEventTopology("delete"),
    wrap((req, res) => {
      res.json(events.Bus.deleteTopic(db, req.params.code));
    })
  );
  eventsRouter.get(
    "/queues",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.listQueues(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/queues",
    auth,
    canEventTopology("create"),
    wrap((req, res) => {
      res.status(201).json(events.Bus.createQueue(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/queues/:code",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.getQueue(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/queues/:code",
    auth,
    canEventTopology("update"),
    wrap((req, res) => {
      res.json(events.Bus.updateQueue(db, req.params.code, req.body || {}));
    })
  );
  eventsRouter.delete(
    "/queues/:code",
    auth,
    canEventTopology("delete"),
    wrap((req, res) => {
      res.json(events.Bus.deleteQueue(db, req.params.code));
    })
  );
  eventsRouter.get(
    "/queues/:code/stats",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.queueStats(db, req.params.code));
    })
  );
  eventsRouter.get(
    "/consumer-groups",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.listConsumerGroups(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/consumer-groups",
    auth,
    canEventTopology("create"),
    wrap((req, res) => {
      res.status(201).json(events.Bus.createConsumerGroup(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/consumer-groups/:code",
    auth,
    canEventTopology("read"),
    wrap((req, res) => {
      res.json(events.Bus.getConsumerGroup(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/consumer-groups/:code",
    auth,
    canEventTopology("update"),
    wrap((req, res) => {
      res.json(events.Bus.updateConsumerGroup(db, req.params.code, req.body || {}));
    })
  );
  eventsRouter.delete(
    "/consumer-groups/:code",
    auth,
    canEventTopology("delete"),
    wrap((req, res) => {
      res.json(events.Bus.deleteConsumerGroup(db, req.params.code));
    })
  );

  // ── Handlers & outbox ─────────────────────────────────────────────────────
  eventsRouter.get(
    "/handlers",
    auth,
    canEventMonitoring("read"),
    wrap((_req, res) => {
      res.json({ items: events.Handlers.listHandlers() });
    })
  );
  eventsRouter.get(
    "/handlers/stats",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json({ items: events.Handlers.handlerStats(db, { tenantId: eventTenant(req), ...req.query }), slow: events.Handlers.slowHandlers(db, { tenantId: eventTenant(req) }) });
    })
  );
  eventsRouter.get(
    "/handlers/:code",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Handlers.handlerDetail(db, req.params.code, { tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/outbox",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Outbox.listOutbox(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/outbox/stats",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Outbox.outboxStats(db, { tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/outbox/process",
    auth,
    canEventPublish("update"),
    wrap(async (req, res) => {
      res.json(await events.Outbox.processOutbox(db, { limit: Number(req.body?.limit) || 50 }));
    })
  );
  eventsRouter.post(
    "/outbox/:id/retry",
    auth,
    canEventPublish("update"),
    wrap((req, res) => {
      res.json(events.Outbox.retryOutbox(db, req.params.id, req.actor));
    })
  );

  // ── Dead letters ──────────────────────────────────────────────────────────
  eventsRouter.get(
    "/dead-letters",
    auth,
    canEventDeadLetters("read"),
    wrap((req, res) => {
      res.json(events.DeadLetter.listDeadLetters(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/dead-letters/stats",
    auth,
    canEventDeadLetters("read"),
    wrap((req, res) => {
      res.json(events.DeadLetter.deadLetterStats(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.post(
    "/dead-letters/bulk-retry",
    auth,
    canEventDeadLetters("update"),
    wrap((req, res) => {
      res.json(events.DeadLetter.retryDeadLetters(db, { ...(req.body || {}), tenantId: eventTenant(req), actor: req.actor }));
    })
  );
  eventsRouter.get(
    "/dead-letters/:id",
    auth,
    canEventDeadLetters("read"),
    wrap((req, res) => {
      res.json(events.DeadLetter.getDeadLetter(db, req.params.id));
    })
  );
  eventsRouter.post(
    "/dead-letters/:id/resolve",
    auth,
    canEventDeadLetters("update"),
    wrap((req, res) => {
      res.json(events.DeadLetter.resolveDeadLetter(db, req.params.id, { action: req.body?.action, reason: req.body?.reason, actor: req.actor }));
    })
  );

  // ── Replay ────────────────────────────────────────────────────────────────
  eventsRouter.get(
    "/replays",
    auth,
    canEventReplay("read"),
    wrap((req, res) => {
      res.json(events.Replay.listReplays(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/replays/preview",
    auth,
    canEventReplay("read"),
    wrap((req, res) => {
      res.json(events.Replay.previewReplay(db, { ...(req.body || {}), tenant_id: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/replays",
    auth,
    canEventReplay("create"),
    wrap((req, res) => {
      res.status(201).json(events.Replay.createReplay(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/replays/stats",
    auth,
    canEventReplay("read"),
    wrap((req, res) => {
      res.json(events.Replay.replayStats(db, { tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/replays/:ref",
    auth,
    canEventReplay("read"),
    wrap((req, res) => {
      res.json(events.Replay.getReplay(db, req.params.ref));
    })
  );
  eventsRouter.post(
    "/replays/:ref/run",
    auth,
    canEventReplay("update"),
    wrap(async (req, res) => {
      res.json(await events.Replay.runReplay(db, req.params.ref, req.actor));
    })
  );
  eventsRouter.post(
    "/replays/:ref/cancel",
    auth,
    canEventReplay("update"),
    wrap((req, res) => {
      res.json(events.Replay.cancelReplay(db, req.params.ref, req.actor));
    })
  );

  // ── Retention ─────────────────────────────────────────────────────────────
  eventsRouter.get(
    "/retention-policies",
    auth,
    canEventRetention("read"),
    wrap((req, res) => {
      res.json(events.Retention.listRetentionPolicies(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/retention-policies",
    auth,
    canEventRetention("create"),
    wrap((req, res) => {
      res.status(201).json(events.Retention.createRetentionPolicy(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/retention-policies/:code",
    auth,
    canEventRetention("read"),
    wrap((req, res) => {
      res.json(events.Retention.getRetentionPolicy(db, req.params.code));
    })
  );
  eventsRouter.patch(
    "/retention-policies/:code",
    auth,
    canEventRetention("update"),
    wrap((req, res) => {
      res.json(events.Retention.updateRetentionPolicy(db, req.params.code, req.body || {}, req.actor));
    })
  );
  eventsRouter.delete(
    "/retention-policies/:code",
    auth,
    canEventRetention("delete"),
    wrap((req, res) => {
      res.json(events.Retention.deleteRetentionPolicy(db, req.params.code, req.actor));
    })
  );
  eventsRouter.post(
    "/retention-policies/:code/apply",
    auth,
    canEventRetention("update"),
    wrap((req, res) => {
      res.json(events.Retention.applyRetentionPolicy(db, req.params.code, { dryRun: truthy(req.body?.dry_run), actor: req.actor }));
    })
  );
  eventsRouter.post(
    "/retention/apply",
    auth,
    canEventRetention("update"),
    wrap((req, res) => {
      res.json(events.Retention.applyRetention(db, { dryRun: truthy(req.body?.dry_run), actor: req.actor, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/retention/stats",
    auth,
    canEventRetention("read"),
    wrap((req, res) => {
      res.json(events.Retention.retentionStats(db, { tenantId: eventTenant(req) }));
    })
  );

  // ── Monitoring & traceability ─────────────────────────────────────────────
  eventsRouter.get(
    "/monitoring/dashboard",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.dashboardSummary(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/monitoring/throughput",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.throughputTimeseries(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/monitoring/failures",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.failureBreakdown(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/monitoring/latency",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.latencyStats(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/monitoring/health",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.healthCheck(db, { tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/monitoring/ordering",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Ordering.orderingState(db, { tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/monitoring/traceability",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.traceability(db, { correlationId: req.query.correlationId, traceId: req.query.traceId, tenantId: eventTenant(req) }));
    })
  );

  // ── Canonical specification aliases ───────────────────────────────────────
  // Thin aliases exposing the framework under the canonical paths documented
  // in the Event & Messaging specification. They reuse the exact same
  // services, DTOs and permission guards as the primary routes above.
  const eventDefinitionVersion = (req, type) => Number(req.body?.version) || Number(type?.version) || 1;

  eventsRouter.get(
    "/definitions",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json(events.Registry.listEventTypes(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.post(
    "/definitions",
    auth,
    canEventRegistry("create"),
    wrap((req, res) => {
      res.status(201).json(events.Registry.createEventType(db, req.body || {}, req.actor, eventTenant(req)));
    })
  );
  eventsRouter.get(
    "/definitions/:id",
    auth,
    canEventRegistry("read"),
    wrap((req, res) => {
      res.json(events.Registry.getEventType(db, req.params.id));
    })
  );
  eventsRouter.put(
    "/definitions/:id",
    auth,
    canEventRegistry("update"),
    wrap((req, res) => {
      res.json(events.Registry.updateEventType(db, req.params.id, req.body || {}, req.actor));
    })
  );
  eventsRouter.post(
    "/definitions/:id/activate",
    auth,
    canEventRegistry("update"),
    wrap((req, res) => {
      const type = events.Registry.getEventType(db, req.params.id);
      res.json(events.Registry.setVersionStatus(db, req.params.id, eventDefinitionVersion(req, type), "active", req.actor));
    })
  );
  eventsRouter.post(
    "/definitions/:id/deprecate",
    auth,
    canEventRegistry("update"),
    wrap((req, res) => {
      const type = events.Registry.getEventType(db, req.params.id);
      res.json(events.Registry.setVersionStatus(db, req.params.id, eventDefinitionVersion(req, type), "deprecated", req.actor));
    })
  );

  eventsRouter.get(
    "/history",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Publisher.listEvents(db, { ...req.query, tenantId: eventTenant(req) }));
    })
  );
  eventsRouter.get(
    "/history/:eventId",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Publisher.getEvent(db, req.params.eventId, { includePayload: true }));
    })
  );

  eventsRouter.put(
    "/topics/:id",
    auth,
    canEventTopology("update"),
    wrap((req, res) => {
      res.json(events.Bus.updateTopic(db, req.params.id, req.body || {}));
    })
  );

  eventsRouter.put(
    "/subscriptions/:id",
    auth,
    canEventSubscriptions("update"),
    wrap((req, res) => {
      res.json(events.Subscriptions.updateSubscription(db, req.params.id, req.body || {}, req.actor));
    })
  );
  eventsRouter.post(
    "/subscriptions/:id/pause",
    auth,
    canEventSubscriptions("update"),
    wrap((req, res) => {
      res.json(events.Subscriptions.setSubscriptionStatus(db, req.params.id, "suspended", req.actor));
    })
  );
  eventsRouter.post(
    "/subscriptions/:id/resume",
    auth,
    canEventSubscriptions("update"),
    wrap((req, res) => {
      res.json(events.Subscriptions.setSubscriptionStatus(db, req.params.id, "active", req.actor));
    })
  );

  eventsRouter.post(
    "/replay",
    auth,
    canEventReplay("create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const created = events.Replay.createReplay(db, body, req.actor, eventTenant(req));
      if (body.run === false) return res.status(201).json(created);
      res.status(202).json(await events.Replay.runReplay(db, created.replay_ref, req.actor));
    })
  );
  eventsRouter.post(
    "/:eventId/replay",
    auth,
    canEventReplay("create"),
    wrap(async (req, res) => {
      const body = { scope_type: "event", event_ref: req.params.eventId, ...(req.body || {}) };
      const created = events.Replay.createReplay(db, body, req.actor, eventTenant(req));
      if (body.run === false) return res.status(201).json(created);
      res.status(202).json(await events.Replay.runReplay(db, created.replay_ref, req.actor));
    })
  );

  eventsRouter.post(
    "/dead-letters/:id/retry",
    auth,
    canEventDeadLetters("update"),
    wrap((req, res) => {
      res.json(events.DeadLetter.resolveDeadLetter(db, req.params.id, { action: "retry", reason: req.body?.reason, actor: req.actor }));
    })
  );
  eventsRouter.post(
    "/dead-letters/:id/replay",
    auth,
    canEventDeadLetters("update"),
    wrap((req, res) => {
      res.json(events.DeadLetter.resolveDeadLetter(db, req.params.id, { action: "retry", reason: req.body?.reason || "replayed by operator", actor: req.actor }));
    })
  );

  eventsRouter.get(
    "/metrics",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json(events.Monitoring.dashboardSummary(db, { tenantId: eventTenant(req), ...req.query }));
    })
  );
  eventsRouter.get(
    "/consumers",
    auth,
    canEventMonitoring("read"),
    wrap((req, res) => {
      res.json({
        items: events.Handlers.listHandlers(),
        stats: events.Handlers.handlerStats(db, { tenantId: eventTenant(req), ...req.query }),
        consumer_groups: events.Bus.listConsumerGroups(db, { tenantId: eventTenant(req) }),
        slow: events.Handlers.slowHandlers(db, { tenantId: eventTenant(req) }),
      });
    })
  );

  // ── Event records (generic, must be registered last to avoid shadowing) ──
  eventsRouter.get(
    "/:ref",
    auth,
    canEventPublish("read"),
    wrap((req, res) => {
      res.json(events.Publisher.getEvent(db, req.params.ref, { includePayload: true }));
    })
  );
  eventsRouter.post(
    "/:ref/route",
    auth,
    canEventPublish("create"),
    wrap((req, res) => {
      res.json(events.Publisher.routeStoredEvent(db, req.params.ref, { trigger: "api" }));
    })
  );
  eventsRouter.get(
    "/:ref/deliveries",
    auth,
    canEventDeliveries("read"),
    wrap((req, res) => {
      const event = events.Publisher.getEvent(db, req.params.ref);
      res.json(events.Publisher.listDeliveries(db, { ...req.query, eventId: event.id }));
    })
  );

  app.use("/api/events", eventsRouter);
  app.use("/api/v1/events", eventsRouter);

  // ── Enterprise Numbering & Identifier Service ─────────────────────────────
  const numberingTenant = (req) => req.tenantId ?? null;
  const canNumbering = (action) => can("iam.numbering", action);
  const canNumberingSchemes = (action) => can("iam.numbering.schemes", action);
  const canNumberingObjectTypes = (action) => can("iam.numbering.objecttypes", action);
  const canNumberingSequences = (action) => can("iam.numbering.sequences", action);
  const canNumberingAllocations = (action) => can("iam.numbering.allocations", action);
  const canNumberingGenerate = (action) => can("iam.numbering.generate", action);
  const canNumberingReserve = (action) => can("iam.numbering.reserve", action);
  const canNumberingConsume = (action) => can("iam.numbering.consume", action);
  const canNumberingRelease = (action) => can("iam.numbering.release", action);
  const canNumberingManual = (action) => can("iam.numbering.manual", action);
  const canNumberingMetrics = (action) => can("iam.numbering.metrics", action);
  const canNumberingAsync = (action) => canAsync("iam.numbering", action);
  const canNumberingObjectTypesAsync = (action) => canAsync("iam.numbering.objecttypes", action);
  const canNumberingSchemesAsync = (action) => canAsync("iam.numbering.schemes", action);
  const canNumberingSequencesAsync = (action) => canAsync("iam.numbering.sequences", action);
  const canNumberingAllocationsAsync = (action) => canAsync("iam.numbering.allocations", action);
  const canNumberingGenerateAsync = (action) => canAsync("iam.numbering.generate", action);
  const canNumberingReserveAsync = (action) => canAsync("iam.numbering.reserve", action);
  const canNumberingConsumeAsync = (action) => canAsync("iam.numbering.consume", action);
  const canNumberingReleaseAsync = (action) => canAsync("iam.numbering.release", action);
  const canNumberingManualAsync = (action) => canAsync("iam.numbering.manual", action);
  const canNumberingMetricsAsync = (action) => canAsync("iam.numbering.metrics", action);
  const manualGuard = (req, res, next) => {
    const wantsManual =
      req.body?.manualNumber !== undefined ||
      req.body?.manual_number !== undefined ||
      req.body?.number !== undefined ||
      req.body?.preferredNumber !== undefined;
    if (!wantsManual) return next();
    return canNumberingManual("create")(req, res, next);
  };
  const manualGuardAsync = async (req, res, next) => {
    const wantsManual =
      req.body?.manualNumber !== undefined ||
      req.body?.manual_number !== undefined ||
      req.body?.number !== undefined ||
      req.body?.preferredNumber !== undefined;
    if (!wantsManual) return next();
    return canNumberingManualAsync("create")(req, res, next);
  };
  const idempotencyKeyOf = (req) =>
    req.get("Idempotency-Key") || req.get("idempotency-key") || req.body?.idempotencyKey || null;

  const numberingRouter = express.Router();

  numberingRouter.get(
    "/meta",
    authAsync,
    canNumberingAsync("read"),
    wrap(async (_req, res) => {
      res.json({
        ...numbering.Validation.vocabulary(),
        tokens: await numbering.Tokens.listTokensAsync(db),
        scopes: numbering.Foundation.DEFAULT_SCOPES,
      });
    })
  );

  numberingRouter.get(
    "/object-types",
    authAsync,
    canNumberingObjectTypesAsync("read"),
    wrap(async (req, res) => {
      res.json({
        items: await numbering.Foundation.listObjectTypesAsync(db, {
          tenantId: numberingTenant(req),
          status: req.query.status || undefined,
        }),
      });
    })
  );
  numberingRouter.post(
    "/object-types",
    authAsync,
    canNumberingObjectTypesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await numbering.Foundation.createObjectTypeAsync(db, req.body || {}, req.actor, numberingTenant(req), req.ip));
    })
  );
  numberingRouter.post(
    "/object-types/:code/status",
    authAsync,
    canNumberingObjectTypesAsync("update"),
    wrap(async (req, res) => {
      res.json(await numbering.Foundation.setObjectTypeStatusAsync(db, req.params.code, req.body?.status, req.actor, req.ip));
    })
  );

  numberingRouter.get(
    "/scopes",
    authAsync,
    canNumberingAsync("read"),
    wrap(async (_req, res) => {
      res.json({ items: await numbering.Scopes.listScopesAsync(db) });
    })
  );
  numberingRouter.get(
    "/tokens",
    authAsync,
    canNumberingAsync("read"),
    wrap(async (_req, res) => {
      res.json({ items: await numbering.Tokens.listTokensAsync(db) });
    })
  );
  numberingRouter.post(
    "/tokens",
    authAsync,
    canNumberingSchemesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await numbering.Tokens.createTokenAsync(db, req.body || {}));
    })
  );

  // ── Schemes ────────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/schemes",
    authAsync,
    canNumberingSchemesAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Schemes.listSchemesAsync(db, { ...req.query, tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.post(
    "/schemes",
    authAsync,
    canNumberingSchemesAsync("create"),
    wrap(async (req, res) => {
      const scheme = await numbering.Schemes.createSchemeAsync(db, req.body || {}, req.actor, numberingTenant(req), req.ip);
      res.status(201).json(scheme);
    })
  );
  numberingRouter.get(
    "/schemes/:ref",
    authAsync,
    canNumberingSchemesAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Schemes.getSchemeAsync(db, req.params.ref));
    })
  );
  const updateSchemeHandler = wrap(async (req, res) => {
    res.json(await numbering.Schemes.updateSchemeAsync(db, req.params.ref, req.body || {}, req.actor, req.ip));
  });
  numberingRouter.put("/schemes/:ref", authAsync, canNumberingSchemesAsync("update"), updateSchemeHandler);
  numberingRouter.patch("/schemes/:ref", authAsync, canNumberingSchemesAsync("update"), updateSchemeHandler);
  numberingRouter.delete(
    "/schemes/:ref",
    authAsync,
    canNumberingSchemesAsync("delete"),
    wrap(async (req, res) => {
      res.json(await numbering.Schemes.deleteSchemeAsync(db, req.params.ref, req.actor, req.ip));
    })
  );
  numberingRouter.get(
    "/schemes/:ref/versions",
    authAsync,
    canNumberingSchemesAsync("read"),
    wrap(async (req, res) => {
      const scheme = await numbering.Schemes.getSchemeAsync(db, req.params.ref, { includeVersions: false });
      res.json({ items: await numbering.Schemes.listVersionsAsync(db, scheme.id) });
    })
  );
  numberingRouter.post(
    "/schemes/:ref/validate",
    authAsync,
    canNumberingSchemesAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Schemes.validateSchemeAsync(db, req.params.ref));
    })
  );
  numberingRouter.post(
    "/schemes/:ref/clone",
    authAsync,
    canNumberingSchemesAsync("create"),
    wrap(async (req, res) => {
      res.status(201).json(await numbering.Schemes.cloneSchemeAsync(db, req.params.ref, req.body || {}, req.actor, numberingTenant(req), req.ip));
    })
  );
  const schemeStatusHandler = (status) =>
    wrap(async (req, res) => {
      res.json(await numbering.Schemes.setSchemeStatusAsync(db, req.params.ref, status, req.actor, req.ip));
    });
  numberingRouter.post("/schemes/:ref/activate", authAsync, canNumberingSchemesAsync("execute"), schemeStatusHandler("active"));
  numberingRouter.post("/schemes/:ref/deactivate", authAsync, canNumberingSchemesAsync("execute"), schemeStatusHandler("inactive"));
  numberingRouter.post("/schemes/:ref/retire", authAsync, canNumberingSchemesAsync("execute"), schemeStatusHandler("retired"));

  // ── Generation ─────────────────────────────────────────────────────────────
  numberingRouter.post(
    "/generate",
    authAsync,
    canNumberingGenerateAsync("create"),
    manualGuardAsync,
    wrap(async (req, res) => {
      const allocation = await numbering.Allocations.generateNumberAsync(db, req.body || {}, req.actor, {
        tenantId: numberingTenant(req),
        ip: req.ip,
        idempotencyKey: idempotencyKeyOf(req),
      });
      res.status(201).json(allocation);
    })
  );
  numberingRouter.post(
    "/reserve",
    authAsync,
    canNumberingReserveAsync("create"),
    manualGuardAsync,
    wrap(async (req, res) => {
      const allocation = await numbering.Allocations.generateNumberAsync(
        db,
        { ...(req.body || {}), reserve: true },
        req.actor,
        { tenantId: numberingTenant(req), ip: req.ip, idempotencyKey: idempotencyKeyOf(req) }
      );
      res.status(201).json(allocation);
    })
  );
  numberingRouter.post(
    "/preview",
    authAsync,
    canNumberingGenerateAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Allocations.previewNumberAsync(db, req.body || {}, { tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.post(
    "/validate",
    authAsync,
    canNumberingGenerateAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Allocations.validateIdentifierAsync(db, req.body || {}, { tenantId: numberingTenant(req) }));
    })
  );

  // ── Allocations ────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/allocations",
    authAsync,
    canNumberingAllocationsAsync("read"),
    wrap(async (req, res) => {
      const query = numbering.Validation.normalizeAllocationQuery(req.query || {});
      res.json(await numbering.Allocations.listAllocationsAsync(db, { ...query, tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.get(
    "/allocations/:ref",
    authAsync,
    canNumberingAllocationsAsync("read"),
    wrap(async (req, res) => {
      res.json(await numbering.Allocations.getAllocationAsync(db, req.params.ref));
    })
  );
  numberingRouter.post(
    "/allocations/:ref/consume",
    authAsync,
    canNumberingConsumeAsync("execute"),
    wrap(async (req, res) => {
      res.json(
        await numbering.Allocations.consumeNumberAsync(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );
  numberingRouter.post(
    "/allocations/:ref/release",
    authAsync,
    canNumberingReleaseAsync("execute"),
    wrap(async (req, res) => {
      res.json(
        await numbering.Allocations.releaseNumberAsync(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );
  numberingRouter.post(
    "/allocations/:ref/cancel",
    authAsync,
    canNumberingReleaseAsync("execute"),
    wrap(async (req, res) => {
      res.json(
        await numbering.Allocations.cancelNumberAsync(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );

  // ── Sequences ──────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/sequences",
    authAsync,
    canNumberingSequencesAsync("read"),
    wrap(async (req, res) => {
      res.json(
        await numbering.Sequences.listSequencesAsync(db, {
          schemeId: req.query.schemeId || req.query.scheme_id,
          scopeKey: req.query.scopeKey || req.query.scope_key,
          status: req.query.status,
          objectType: req.query.objectType || req.query.object_type,
          tenantId: numberingTenant(req),
          page: req.query.page,
          pageSize: req.query.pageSize || req.query.page_size,
        })
      );
    })
  );
  numberingRouter.get(
    "/sequences/:id",
    authAsync,
    canNumberingSequencesAsync("read"),
    wrap(async (req, res) => {
      const sequence = await numbering.Sequences.publicSequenceAsync(
        db,
        await numbering.Sequences.getSequenceRowAsync(db, req.params.id)
      );
      if (!sequence) throw new HttpError(404, "Numbering sequence not found");
      res.json(sequence);
    })
  );
  numberingRouter.post(
    "/sequences/:id/reset",
    authAsync,
    canNumberingSequencesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await numbering.Sequences.resetSequenceAsync(db, req.params.id, req.body || {}, req.actor, req.ip));
    })
  );

  // ── Monitoring ─────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/metrics",
    authAsync,
    canNumberingMetricsAsync("read"),
    wrap(async (req, res) => {
      res.json({
        ...(await numbering.Allocations.metricsSnapshotAsync(db, { tenantId: numberingTenant(req) })),
        generation_latency: await numbering.Metrics.generationLatencyAsync(db, { tenantId: numberingTenant(req) }),
      });
    })
  );
  numberingRouter.get(
    "/dashboard",
    authAsync,
    canNumberingMetricsAsync("read"),
    wrap(async (req, res) => {
      res.json(
        await numbering.Metrics.dashboardSummaryAsync(db, {
          tenantId: numberingTenant(req),
          from: req.query.from,
          to: req.query.to,
        })
      );
    })
  );
  numberingRouter.post(
    "/maintenance/expire",
    authAsync,
    canNumberingSequencesAsync("execute"),
    wrap(async (req, res) => {
      res.json(await numbering.Allocations.expireReservationsAsync(db, { limit: Number(req.body?.limit) || 200 }));
    })
  );
  numberingRouter.get(
    "/health",
    wrap(async (req, res) => {
      const health = await numbering.Metrics.healthCheckAsync(db, { tenantId: numberingTenant(req) });
      res.status(health.healthy ? 200 : 503).json(health);
    })
  );
  numberingRouter.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  numberingRouter.get(
    "/health/ready",
    wrap(async (req, res) => {
      const health = await numbering.Metrics.healthCheckAsync(db, { tenantId: numberingTenant(req) });
      res.status(health.ready ? 200 : 503).json(health);
    })
  );

  app.use("/api/numbering", numberingRouter);
  app.use("/api/v1/numbering", numberingRouter);

  // ── Enterprise Effectivity & Versioning Kernel ────────────────────────────
  const versioningRouter = createVersioningRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/versioning", versioningRouter);
  app.use("/api/v1/versioning", versioningRouter);
  app.use("/api/v1", versioningRouter);

  // ── Enterprise Reference Data Management ──────────────────────────────────
  const referenceRouter = createReferenceRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/reference-data", referenceRouter);
  app.use("/api/v1/reference-data", referenceRouter);

  // ── File & Content Management Service ─────────────────────────────────────
  const contentRouter = createContentRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/content", contentRouter);
  app.use("/api/v1/content", contentRouter);

  // ── Data Governance & Data Quality ────────────────────────────────────────
  const dataGovernanceRouter = createDataGovernanceRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  const dataQualityRouter = createDataQualityRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/data-governance", dataGovernanceRouter);
  app.use("/api/v1/data-governance", dataGovernanceRouter);
  app.use("/api/data-quality", dataQualityRouter);
  app.use("/api/v1/data-quality", dataQualityRouter);

  // ── Data Catalog & Business Glossary ──────────────────────────────────────
  const dataCatalogRouter = createDataCatalogRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  const glossaryRouter = createGlossaryRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/data-catalog", dataCatalogRouter);
  app.use("/api/v1/data-catalog", dataCatalogRouter);
  app.use("/api/catalog", dataCatalogRouter);
  app.use("/api/v1/catalog", dataCatalogRouter);
  app.use("/api/glossary", glossaryRouter);
  app.use("/api/v1/glossary", glossaryRouter);

  // ── Data Lifecycle & Archival ─────────────────────────────────────────────
  const dataLifecycleRouter = createDataLifecycleRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/lifecycle", dataLifecycleRouter);
  app.use("/api/v1/lifecycle", dataLifecycleRouter);

  // ── Import & Export Framework ─────────────────────────────────────────────
  const dataExchangeRouter = createDataExchangeRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/data-exchange", dataExchangeRouter);
  app.use("/api/v1/data-exchange", dataExchangeRouter);

  // ── Migration & Onboarding Framework ──────────────────────────────────────
  const migrationRouter = createMigrationRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/migration", migrationRouter);
  app.use("/api/v1/migration", migrationRouter);

  // ── Enterprise Classification Framework ───────────────────────────────────
  const classificationRouter = createClassificationRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/classification", classificationRouter);
  app.use("/api/v1/classification", classificationRouter);

  // ── P1 BOM Engine ─────────────────────────────────────────────────────────
  const bomRouter = createBomRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/bom", bomRouter);
  app.use("/api/v1/bom", bomRouter);

  // ── P1 PDM domain ─────────────────────────────────────────────────────────
  const pdmRouter = createPdmRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/pdm", pdmRouter);
  app.use("/api/v1/pdm", pdmRouter);

  // ── Change Management (ECR/ECO/ECN) ──────────────────────────────────────
  const changeRouter = createChangeRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/change", changeRouter);
  app.use("/api/v1/change", changeRouter);

  // ── P1 Digital Thread ─────────────────────────────────────────────────────
  const threadRouter = createThreadRouter({ express, db, auth, can, authAsync, canAsync, wrap });
  app.use("/api/digital-thread", threadRouter);
  app.use("/api/v1/digital-thread", threadRouter);

  // ── P2 Standards & Exchange ───────────────────────────────────────────────
  const exchangeRouter = createExchangeRouter({ express, db, auth, can, wrap });
  app.use("/api/standards-exchange", exchangeRouter);
  app.use("/api/v1/standards-exchange", exchangeRouter);

  // ── P2 Reporting & Analytics ──────────────────────────────────────────────
  const reportingRouter = createReportingRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/reporting", requireFeature(db, "reporting"), reportingRouter);
  app.use("/api/v1/reporting", requireFeature(db, "reporting"), reportingRouter);

  // ── P2 Data Observability ────────────────────────────────────────────────
  const observabilityRouter = createObservabilityRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/observability", requireFeature(db, "observability"), observabilityRouter);
  app.use("/api/v1/observability", requireFeature(db, "observability"), observabilityRouter);

  // ── Deployment & Edition framework ───────────────────────────────────────
  const deploymentRouter = createDeploymentRouter({ express, db, auth, authAsync, can, canAsync, wrap });
  app.use("/api/deployment", deploymentRouter);
  app.use("/api/v1/deployment", deploymentRouter);

  app.use("/api/integration", integrationRouter);
  app.use("/api/v1/integration", integrationRouter);

  const dist = join(__dirname, "..", "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(dist, "index.html"));
    });
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      const payload = { error: err.message, details: err.details };
      if (err.code) payload.code = err.code;
      return res.status(err.status).json(payload);
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
