import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { HttpError, pagination } from "./validation.js";
import { queryOne } from "./db.js";
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
import { getStorageProvider, verifyDownloadToken, storageConfig, signDownload, signedDownloadPath } from "./services/file-storage.js";
import { readTenant as metaReadTenant, writeTenant as metaWriteTenant } from "./services/metadata/scope.js";
import { writeAudit } from "./services/audit.js";
import { effectiveAccess } from "./services/access.js";
import { requirePermission } from "./middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
}

function requestMeta(req) {
  return { ip: clientIp(req), userAgent: req.headers["user-agent"] || "" };
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

function tenantFilter(req) {
  return { tenantId: req.tenantId || -1 };
}

function scopedOrg(db, req, id) {
  return orgs.getOrganization(db, id, tenantFilter(req));
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
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
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

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

  function handleLogin(req, res) {
    res.json(authentication.login(db, req.body || {}, requestMeta(req)));
  }

  app.post("/api/auth/login", wrap(handleLogin));
  app.post("/api/authentication/login", wrap(handleLogin));

  const auth = requireAuth(db);
  const can = (resource, action) => requirePermission(db, resource, action);

  app.get(
    "/api/auth/me",
    auth,
    wrap((req, res) => {
      const currentTenant = req.tenantId ? tenants.publicTenant(tenants.getTenant(db, req.tenantId)) : null;
      res.json({
        user: req.actor,
        access: effectiveAccess(db, req.actor.id),
        session: sessions.publicSession(req.sessionRow),
        mfa: mfa.mfaStatus(db, req.actor.id),
        tenant: currentTenant,
        tenants: tenants.switchableTenants(db, req.actor).map(tenants.publicTenant),
      });
    })
  );

  function handleLogout(req, res) {
    res.json(sessions.logoutToken(db, req.sessionToken, req.actor, clientIp(req)));
  }

  app.post("/api/auth/logout", auth, wrap(handleLogout));
  app.post("/api/authentication/logout", auth, wrap(handleLogout));

  app.get(
    "/api/authentication/providers",
    wrap((req, res) => {
      res.json({ items: providers.listProviders(db, { enabledOnly: true }) });
    })
  );

  app.get(
    "/api/authentication/providers/admin",
    auth,
    can("iam.authentication", "read"),
    wrap((_req, res) => {
      res.json({ items: providers.listProviders(db) });
    })
  );

  app.get(
    "/api/authentication/settings",
    auth,
    can("iam.authentication", "read"),
    wrap((_req, res) => {
      res.json(authentication.authSettings(db));
    })
  );

  app.put(
    "/api/authentication/settings",
    auth,
    can("iam.authentication", "update"),
    wrap((req, res) => {
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
      hierarchy.updateSettings(db, { values: patch }, req.actor, clientIp(req));
      res.json(authentication.authSettings(db));
    })
  );

  app.post(
    "/api/authentication/providers",
    auth,
    can("iam.authentication", "create"),
    wrap((req, res) => {
      res.status(201).json(providers.createProvider(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/authentication/providers/:id",
    auth,
    can("iam.authentication", "update"),
    wrap((req, res) => {
      res.json(providers.updateProvider(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/authentication/password-reset/request",
    wrap((req, res) => {
      authentication.requestPasswordReset(db, req.body || {}, requestMeta(req));
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/authentication/password-reset/complete",
    wrap((req, res) => {
      res.json(authentication.completePasswordReset(db, req.body || {}, requestMeta(req)));
    })
  );

  app.get(
    "/api/sessions",
    auth,
    wrap((req, res) => {
      res.json({ items: sessions.listMySessions(db, req.actor.id) });
    })
  );

  app.delete(
    "/api/sessions/:id",
    auth,
    wrap((req, res) => {
      res.json(sessions.revokeSession(db, req.params.id, req.actor, clientIp(req), { ownerId: req.actor.id }));
    })
  );

  app.post(
    "/api/sessions/revoke-all",
    auth,
    wrap((req, res) => {
      res.json(
        sessions.revokeAllSessions(db, req.actor.id, req.actor, clientIp(req), { exceptToken: req.sessionToken })
      );
    })
  );

  app.get(
    "/api/sessions/admin",
    auth,
    can("iam.sessions", "read"),
    wrap((req, res) => {
      res.json(sessions.listSessions(db, req.query));
    })
  );

  app.delete(
    "/api/sessions/admin/:id",
    auth,
    can("iam.sessions", "delete"),
    wrap((req, res) => {
      res.json(sessions.revokeSession(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/mfa/status",
    auth,
    wrap((req, res) => {
      res.json(mfa.mfaStatus(db, req.actor.id));
    })
  );

  app.post(
    "/api/mfa/totp/enroll",
    auth,
    wrap((req, res) => {
      res.json(mfa.enrollTotp(db, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/totp/verify",
    auth,
    wrap((req, res) => {
      res.json(mfa.verifyTotpEnrollment(db, req.actor, req.body?.code, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/totp/disable",
    auth,
    wrap((req, res) => {
      res.json(mfa.disableTotp(db, req.actor, req.body || {}, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/recovery/regenerate",
    auth,
    wrap((req, res) => {
      res.json(mfa.regenerateRecovery(db, req.actor, req.body?.code, clientIp(req)));
    })
  );

  app.post(
    "/api/mfa/challenge/verify",
    wrap((req, res) => {
      res.json(authentication.completeMfa(db, req.body || {}, requestMeta(req)));
    })
  );

  app.post(
    "/api/mfa/admin/:userId/reset",
    auth,
    can("iam.users", "execute"),
    wrap((req, res) => {
      users.getUser(db, req.params.userId);
      res.json(mfa.adminResetMfa(db, req.params.userId, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/sso/providers",
    wrap((_req, res) => {
      res.json({
        items: providers.listProviders(db, { enabledOnly: true }).filter((p) => p.type !== "password"),
      });
    })
  );

  app.post(
    "/api/sso/:code/start",
    wrap((req, res) => {
      res.json(authentication.startSso(db, req.params.code, req.body || {}, requestMeta(req)));
    })
  );

  function handleSsoCallback(req, res) {
    const body = { ...(req.query || {}), ...(req.body || {}) };
    res.json(authentication.completeSso(db, req.params.code, body, requestMeta(req)));
  }

  app.post("/api/sso/:code/callback", wrap(handleSsoCallback));
  app.get("/api/sso/:code/callback", wrap(handleSsoCallback));

  app.get(
    "/api/sso/:code/metadata",
    wrap((req, res) => {
      res.json(authentication.ssoMetadata(db, req.params.code));
    })
  );

  app.get(
    "/api/tenants",
    auth,
    can("iam.tenants", "read"),
    wrap((req, res) => {
      res.json(tenants.listTenants(db, req.query));
    })
  );

  app.post(
    "/api/tenants",
    auth,
    can("iam.tenants", "create"),
    wrap((req, res) => {
      res.status(201).json(tenants.createTenant(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/tenants/:id",
    auth,
    can("iam.tenants", "read"),
    wrap((req, res) => {
      res.json(tenants.getTenant(db, req.params.id));
    })
  );

  app.put(
    "/api/tenants/:id",
    auth,
    can("iam.tenants", "update"),
    wrap((req, res) => {
      res.json(tenants.updateTenant(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/activate",
    auth,
    can("iam.tenants", "update"),
    wrap((req, res) => {
      res.json(tenants.setTenantStatus(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/deactivate",
    auth,
    can("iam.tenants", "update"),
    wrap((req, res) => {
      res.json(tenants.setTenantStatus(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/tenants/:id",
    auth,
    can("iam.tenants", "delete"),
    wrap((req, res) => {
      res.json(tenants.deleteTenant(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/tenants/:id/select",
    auth,
    wrap((req, res) => {
      res.json(tenants.selectTenant(db, req.sessionToken, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/tenants/:id/context",
    auth,
    can("iam.tenants", "read"),
    wrap((req, res) => {
      res.json(tenants.tenantContext(db, req.params.id));
    })
  );

  app.get(
    "/api/tenants/:id/config",
    auth,
    can("iam.config", "read"),
    wrap((req, res) => {
      tenants.getTenant(db, req.params.id);
      res.json({
        scope: "tenant",
        scope_id: Number(req.params.id),
        items: config.listScopeValues(db, "tenant", req.params.id),
        effective: config.resolveAll(db, { tenantId: req.params.id }),
      });
    })
  );

  app.put(
    "/api/tenants/:id/config",
    auth,
    can("iam.config", "update"),
    wrap((req, res) => {
      tenants.getTenant(db, req.params.id);
      res.json(
        config.putValues(
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
    auth,
    can("iam.config", "read"),
    wrap((req, res) => {
      const organizationId = req.query.organizationId;
      if (organizationId) scopedOrg(db, req, organizationId);
      res.json(
        config.catalogAndEffective(db, {
          tenantId: req.tenantId,
          organizationId,
        })
      );
    })
  );

  app.put(
    "/api/config",
    auth,
    can("iam.config", "update"),
    wrap((req, res) => {
      const scope = req.body?.scope;
      const scopeId = req.body?.scopeId ?? req.body?.scope_id;
      if (scope === "tenant") tenants.getTenant(db, scopeId);
      if (scope === "organization") scopedOrg(db, req, scopeId);
      res.json(config.putValues(db, { scope, scopeId, values: req.body?.values || {} }, req.actor, clientIp(req)));
    })
  );

  // -------------------------------------------------------------------------
  // Configuration & Metadata Management
  // Global (system) metadata is stored with tenant_id = NULL and requires the
  // platform administrator; tenant metadata is isolated to the caller tenant.
  // -------------------------------------------------------------------------

  const canMeta = (action) => can("iam.metadata", action);
  const metaRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);
  const metaWrite = (req, body) => metaWriteTenant(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/metadata/types",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.listTypes(db, req.query, metaRead(req)));
    })
  );

  app.get(
    "/api/metadata/types/tree",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json({ items: metadata.typeTree(db, metaRead(req)) });
    })
  );

  app.post(
    "/api/metadata/types",
    auth,
    canMeta("create"),
    wrap((req, res) => {
      const tenantId = metaWrite(req, req.body);
      res.status(201).json(metadata.createType(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/types/:id",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.getType(db, req.params.id, metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/types/:id",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      const tenantId = metaRead(req);
      res.json(metadata.updateType(db, req.params.id, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.delete(
    "/api/metadata/types/:id",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      res.json(metadata.deleteType(db, req.params.id, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/types/:id/status",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.setTypeStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), metaRead(req))
      );
    })
  );

  app.get(
    "/api/metadata/types/:id/resolve",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.resolveType(db, req.params.id, metaRead(req)));
    })
  );

  app.get(
    "/api/metadata/types/:id/contract",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json({ items: metadata.attributeContract(db, req.params.id, metaRead(req)) });
    })
  );

  app.post(
    "/api/metadata/types/:id/attributes",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.status(201).json(
        metadata.addTypeAttribute(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req))
      );
    })
  );

  app.put(
    "/api/metadata/types/:id/attributes/:attributeId",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.updateTypeAttribute(
          db,
          req.params.id,
          req.params.attributeId,
          req.body || {},
          req.actor,
          clientIp(req),
          metaRead(req)
        )
      );
    })
  );

  app.delete(
    "/api/metadata/types/:id/attributes/:attributeId",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.removeTypeAttribute(
          db,
          req.params.id,
          req.params.attributeId,
          req.actor,
          clientIp(req),
          metaRead(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/attributes",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.listAttributes(db, req.query, metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/attributes",
    auth,
    canMeta("create"),
    wrap((req, res) => {
      const tenantId = metaWrite(req, req.body);
      res.status(201).json(metadata.createAttribute(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/attributes/:id",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.getAttribute(db, req.params.id, metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/attributes/:id",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.updateAttribute(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req))
      );
    })
  );

  app.delete(
    "/api/metadata/attributes/:id",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      const attribute = metadata.getAttribute(db, req.params.id, metaRead(req));
      // Attributes are retained when referenced so records keep their contract.
      res.json(
        metadata.setAttributeStatus(db, attribute.id, "inactive", req.actor, clientIp(req), metaRead(req))
      );
    })
  );

  app.post(
    "/api/metadata/attributes/:id/status",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.setAttributeStatus(
          db,
          req.params.id,
          req.body?.status,
          req.actor,
          clientIp(req),
          metaRead(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/lovs",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.listLovs(db, req.query, metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/lovs",
    auth,
    canMeta("create"),
    wrap((req, res) => {
      const tenantId = metaWrite(req, req.body);
      res.status(201).json(metadata.createLov(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/lovs/:id",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.getLov(db, req.params.id, metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/lovs/:id",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.updateLov(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.delete(
    "/api/metadata/lovs/:id",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      res.json(metadata.deleteLov(db, req.params.id, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/lovs/:id/status",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.setLovStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.get(
    "/api/metadata/lovs/:id/values",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const lov = metadata.getLov(db, req.params.id, metaRead(req));
      res.json({ items: metadata.listValues(db, lov.id) });
    })
  );

  app.post(
    "/api/metadata/lovs/:id/values",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res
        .status(201)
        .json(metadata.addValue(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/lovs/:id/values/:valueId",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.updateValue(
          db,
          req.params.id,
          req.params.valueId,
          req.body || {},
          req.actor,
          clientIp(req),
          metaRead(req)
        )
      );
    })
  );

  app.delete(
    "/api/metadata/lovs/:id/values/:valueId",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(
        metadata.removeValue(
          db,
          req.params.id,
          req.params.valueId,
          req.actor,
          clientIp(req),
          metaRead(req)
        )
      );
    })
  );

  app.get(
    "/api/metadata/lovs/:id/cascade",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json({
        items: metadata.cascadeOptions(
          db,
          req.params.id,
          req.query.parentValueId ?? req.query.parent_value_id,
          metaRead(req)
        ),
      });
    })
  );

  app.get(
    "/api/metadata/lovs/:id/usage",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json({ items: metadata.listUsage(db, req.params.id) });
    })
  );

  app.get(
    "/api/metadata/forms",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.listForms(db, req.query, metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/forms",
    auth,
    canMeta("create"),
    wrap((req, res) => {
      const tenantId = metaWrite(req, req.body);
      res.status(201).json(metadata.createForm(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/forms/:id",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.getForm(db, req.params.id, metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/forms/:id",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.updateForm(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.delete(
    "/api/metadata/forms/:id",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      res.json(metadata.deleteForm(db, req.params.id, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/forms/:id/status",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.setFormStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/forms/:id/layout",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.replaceLayout(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.get(
    "/api/metadata/forms/:id/versions",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json({ items: metadata.formVersions(db, req.params.id) });
    })
  );

  app.get(
    "/api/metadata/forms/:id/render",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.renderForm(db, req.params.id, metaRead(req), { mode: req.query.mode }));
    })
  );

  app.post(
    "/api/metadata/forms/:id/render",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const tenantId = metaRead(req);
      res.json(
        metadata.renderForm(db, req.params.id, tenantId, {
          mode: req.body?.mode,
          values: req.body?.values || {},
          context: req.body?.context || {},
        })
      );
    })
  );

  app.get(
    "/api/metadata/rules",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.listRules(db, req.query, metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/rules",
    auth,
    canMeta("create"),
    wrap((req, res) => {
      const tenantId = metaWrite(req, req.body);
      res.status(201).json(metadata.createRule(db, req.body || {}, req.actor, clientIp(req), tenantId));
    })
  );

  app.get(
    "/api/metadata/rules/:id",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      res.json(metadata.getRule(db, req.params.id, metaRead(req)));
    })
  );

  app.put(
    "/api/metadata/rules/:id",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.updateRule(db, req.params.id, req.body || {}, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.delete(
    "/api/metadata/rules/:id",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      res.json(metadata.deleteRule(db, req.params.id, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/rules/:id/status",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      res.json(metadata.setRuleStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), metaRead(req)));
    })
  );

  app.post(
    "/api/metadata/rules/:id/test",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const rule = metadata.getRule(db, req.params.id, metaRead(req));
      res.json(metadata.testRule(db, rule, req.body?.context || {}));
    })
  );

  app.post(
    "/api/metadata/validate",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const tenantId = metaRead(req, { ...req.query, ...(req.body || {}) });
      res.json(metadata.validateRecord(db, req.body || {}, tenantId));
    })
  );

  app.get(
    "/api/metadata/configurations",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const scope = req.query.scope || "system";
      const scopeId = req.query.scopeId ?? req.query.scope_id;
      if (scope === "organization" && scopeId) scopedOrg(db, req, scopeId);
      res.json({
        items: metadata.listConfigurations(db, { scope, scopeId, artifactType: req.query.artifactType }),
      });
    })
  );

  app.get(
    "/api/metadata/configurations/effective",
    auth,
    canMeta("read"),
    wrap((req, res) => {
      const organizationId = req.query.organizationId;
      if (organizationId) scopedOrg(db, req, organizationId);
      res.json({
        items: metadata.effectiveCatalog(db, {
          artifactType: req.query.artifactType,
          tenantId: req.tenantId,
          organizationId,
        }),
      });
    })
  );

  app.post(
    "/api/metadata/configurations",
    auth,
    canMeta("update"),
    wrap((req, res) => {
      const scope = req.body?.scope || "system";
      const scopeId = req.body?.scopeId ?? req.body?.scope_id;
      if (scope === "tenant") tenants.getTenant(db, scopeId);
      if (scope === "organization") scopedOrg(db, req, scopeId);
      res.json(metadata.setConfiguration(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/metadata/configurations",
    auth,
    canMeta("delete"),
    wrap((req, res) => {
      res.json(
        metadata.deleteConfiguration(
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
  const canRelationships = (action) => can("iam.objects.relationships", action);
  const canReferences = (action) => can("iam.objects.references", action);
  const canDependencies = (action) => can("iam.objects.dependencies", action);
  const relTypeRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);

  app.get(
    "/api/object-types",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.objectTypes(db, req.tenantId));
    })
  );

  app.get(
    "/api/object-types/:id/form",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(
        metadata.renderType(db, req.params.id, req.tenantId, {
          mode: req.query.mode || "create",
        })
      );
    })
  );

  app.get(
    "/api/objects/summary",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.objectSummary(db, req.tenantId));
    })
  );

  app.get(
    "/api/objects",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.listObjects(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/objects",
    auth,
    canObjects("create"),
    wrap((req, res) => {
      res.status(201).json(objects.createObject(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/bulk",
    auth,
    canObjects("create"),
    wrap((req, res) => {
      res.status(201).json(objects.bulkCreateObjects(db, req.body?.items || [], req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.patch(
    "/api/objects/bulk",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.bulkMutateObjects(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.getObject(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/objects/:id",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.updateObject(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/objects/:id",
    auth,
    canObjects("delete"),
    wrap((req, res) => {
      const force = req.query.force === "true" || req.query.force === true;
      res.json(
        objects.softDeleteObject(db, req.params.id, { force, summary: req.query.summary }, req.actor, req.tenantId, clientIp(req))
      );
    })
  );

  app.post(
    "/api/objects/:id/restore",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.restoreObject(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/status",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.setObjectStatus(db, req.params.id, req.body?.status, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/checkout",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.checkoutObject(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/objects/:id/checkin",
    auth,
    canObjects("update"),
    wrap((req, res) => {
      res.json(objects.checkinObject(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/objects/:id/locks",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.objectLocks(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/versions",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.listObjectVersions(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/versions/:revision",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(objects.getObjectVersion(db, req.params.id, req.params.revision, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/relationships",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.relationshipsForObject(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/tree",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.traverse(db, req.params.id, req.query, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/graph",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.graph(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/objects/:id/dependencies",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      res.json(objects.directDependencies(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/safe-delete",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      res.json(objects.safeDeleteReport(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/relationship-types",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.listRelationshipTypes(db, req.query, relTypeRead(req)));
    })
  );

  app.post(
    "/api/relationship-types",
    auth,
    canRelationships("create"),
    wrap((req, res) => {
      res
        .status(201)
        .json(objects.createRelationshipType(db, req.body || {}, req.actor, clientIp(req), req.tenantId, req.query));
    })
  );

  app.get(
    "/api/relationship-types/:id",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.getRelationshipType(db, req.params.id, relTypeRead(req)));
    })
  );

  app.put(
    "/api/relationship-types/:id",
    auth,
    canRelationships("update"),
    wrap((req, res) => {
      res.json(
        objects.updateRelationshipType(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId)
      );
    })
  );

  app.post(
    "/api/relationship-types/:id/status",
    auth,
    canRelationships("update"),
    wrap((req, res) => {
      res.json(
        objects.setRelationshipTypeStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId)
      );
    })
  );

  app.delete(
    "/api/relationship-types/:id",
    auth,
    canRelationships("delete"),
    wrap((req, res) => {
      res.json(objects.deleteRelationshipType(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/relationships",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.listRelationships(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/relationships/validate",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.validateRelationship(db, req.body || {}, req.tenantId));
    })
  );

  app.post(
    "/api/relationships",
    auth,
    canRelationships("create"),
    wrap((req, res) => {
      res.status(201).json(objects.createRelationship(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/relationships/:id",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      res.json(objects.getRelationship(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/relationships/:id",
    auth,
    canRelationships("update"),
    wrap((req, res) => {
      res.json(objects.updateRelationship(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/relationships/:id/validate",
    auth,
    canRelationships("read"),
    wrap((req, res) => {
      const existing = objects.getRelationship(db, req.params.id, req.tenantId);
      res.json(
        objects.validateRelationship(
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
    auth,
    canRelationships("delete"),
    wrap((req, res) => {
      const force = req.query.force === "true" || req.query.force === true;
      res.json(objects.deleteRelationship(db, req.params.id, { force }, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/references/orphans",
    auth,
    canReferences("read"),
    wrap((req, res) => {
      res.json(objects.orphanReferences(db, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/references",
    auth,
    canReferences("read"),
    wrap((req, res) => {
      res.json(objects.listReferences(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/references",
    auth,
    canReferences("create"),
    wrap((req, res) => {
      res.status(201).json(objects.createReference(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/references/:id",
    auth,
    canReferences("read"),
    wrap((req, res) => {
      res.json(objects.getReference(db, req.params.id, req.tenantId));
    })
  );

  app.put(
    "/api/references/:id",
    auth,
    canReferences("update"),
    wrap((req, res) => {
      res.json(objects.updateReference(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/references/:id",
    auth,
    canReferences("delete"),
    wrap((req, res) => {
      res.json(objects.deleteReference(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/dependencies/cycles",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      res.json(objects.detectCycles(db, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/dependencies/impact",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      const objectId = req.query.objectId ?? req.query.object_id ?? req.query.id;
      if (!objectId) throw new HttpError(400, "objectId is required");
      res.json(objects.impactOf(db, objectId, req.tenantId, req.query));
    })
  );

  app.get(
    "/api/dependencies/:objectId",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      res.json(objects.directDependencies(db, req.params.objectId, req.tenantId));
    })
  );

  // -------------------------------------------------------------------------
  // Lifecycle Management
  // Configurable statuses, lifecycle state machines, transition rules and the
  // release/approval engine. Configuration is global-or-tenant metadata gated by
  // iam.lifecycle.* sub-resources; object transitions re-use the object IAM.
  // -------------------------------------------------------------------------

  const canLifecycle = (action) => can("iam.lifecycle", action);
  const canLifecycleStatuses = (action) => can("iam.lifecycle.statuses", action);
  const canLifecycleDefinitions = (action) => can("iam.lifecycle.definitions", action);
  const canLifecycleTransitions = (action) => can("iam.lifecycle.transitions", action);
  const canReleaseRules = (action) => can("iam.lifecycle.release-rules", action);
  const canApprovals = (action) => can("iam.lifecycle.approvals", action);
  const lifecycleRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);
  const lifecycleWrite = (req, body) => metaWriteTenant(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/statuses",
    auth,
    canLifecycleStatuses("read"),
    wrap((req, res) => {
      res.json(lifecycle.listStatuses(db, req.query, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/statuses",
    auth,
    canLifecycleStatuses("create"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(201).json(lifecycle.createStatus(db, body, req.actor, clientIp(req), lifecycleWrite(req, body)));
    })
  );

  app.get(
    "/api/statuses/:id",
    auth,
    canLifecycleStatuses("read"),
    wrap((req, res) => {
      res.json(lifecycle.getStatus(db, req.params.id, lifecycleRead(req)));
    })
  );

  app.put(
    "/api/statuses/:id",
    auth,
    canLifecycleStatuses("update"),
    wrap((req, res) => {
      res.json(lifecycle.updateStatus(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.post(
    "/api/statuses/:id/status",
    auth,
    canLifecycleStatuses("update"),
    wrap((req, res) => {
      res.json(lifecycle.setStatusStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.delete(
    "/api/statuses/:id",
    auth,
    canLifecycleStatuses("delete"),
    wrap((req, res) => {
      res.json(lifecycle.deleteStatus(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.get(
    "/api/lifecycle-definitions",
    auth,
    canLifecycleDefinitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.listDefinitions(db, req.query, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/lifecycle-definitions",
    auth,
    canLifecycleDefinitions("create"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(201).json(lifecycle.createDefinition(db, body, req.actor, clientIp(req), lifecycleWrite(req, body)));
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id",
    auth,
    canLifecycleDefinitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.getDefinition(db, req.params.id, lifecycleRead(req)));
    })
  );

  app.put(
    "/api/lifecycle-definitions/:id",
    auth,
    canLifecycleDefinitions("update"),
    wrap((req, res) => {
      res.json(
        lifecycle.updateDefinition(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req))
      );
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/status",
    auth,
    canLifecycleDefinitions("update"),
    wrap((req, res) => {
      res.json(
        lifecycle.setDefinitionStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), lifecycleRead(req))
      );
    })
  );

  app.delete(
    "/api/lifecycle-definitions/:id",
    auth,
    canLifecycleDefinitions("delete"),
    wrap((req, res) => {
      res.json(lifecycle.deleteDefinition(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id/versions",
    auth,
    canLifecycleDefinitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.listVersions(db, req.params.id, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/versions",
    auth,
    canLifecycleDefinitions("update"),
    wrap((req, res) => {
      res.status(201).json(
        lifecycle.createVersion(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req))
      );
    })
  );

  app.get(
    "/api/lifecycle-definitions/:id/validate",
    auth,
    canLifecycleDefinitions("read"),
    wrap((req, res) => {
      res.json(
        lifecycle.validateDefinition(db, req.params.id, lifecycleRead(req), { version: req.query.version })
      );
    })
  );

  app.post(
    "/api/lifecycle-definitions/:id/publish",
    auth,
    canLifecycleDefinitions("update"),
    wrap((req, res) => {
      res.json(
        lifecycle.publishDefinition(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req))
      );
    })
  );

  app.get(
    "/api/lifecycle-states",
    auth,
    canLifecycleTransitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.listStates(db, req.query, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/lifecycle-states",
    auth,
    canLifecycleTransitions("update"),
    wrap((req, res) => {
      res.status(201).json(lifecycle.createState(db, req.body || {}, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.put(
    "/api/lifecycle-states/:id",
    auth,
    canLifecycleTransitions("update"),
    wrap((req, res) => {
      res.json(lifecycle.updateState(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.delete(
    "/api/lifecycle-states/:id",
    auth,
    canLifecycleTransitions("delete"),
    wrap((req, res) => {
      res.json(lifecycle.deleteState(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.get(
    "/api/lifecycle-transitions",
    auth,
    canLifecycleTransitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.listTransitions(db, req.query, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/lifecycle-transitions",
    auth,
    canLifecycleTransitions("update"),
    wrap((req, res) => {
      res.status(201).json(lifecycle.createTransition(db, req.body || {}, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.put(
    "/api/lifecycle-transitions/:id",
    auth,
    canLifecycleTransitions("update"),
    wrap((req, res) => {
      res.json(
        lifecycle.updateTransition(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req))
      );
    })
  );

  app.delete(
    "/api/lifecycle-transitions/:id",
    auth,
    canLifecycleTransitions("delete"),
    wrap((req, res) => {
      res.json(lifecycle.deleteTransition(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  app.get(
    "/api/lifecycle-assignments",
    auth,
    canLifecycleDefinitions("read"),
    wrap((req, res) => {
      res.json(lifecycle.listAssignments(db, req.query, lifecycleRead(req)));
    })
  );

  app.post(
    "/api/lifecycle-assignments",
    auth,
    canLifecycleDefinitions("update"),
    wrap((req, res) => {
      res.status(201).json(lifecycle.createAssignment(db, req.body || {}, req.actor, clientIp(req), lifecycleWrite(req)));
    })
  );

  app.delete(
    "/api/lifecycle-assignments/:id",
    auth,
    canLifecycleDefinitions("delete"),
    wrap((req, res) => {
      res.json(lifecycle.deleteAssignment(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
    })
  );

  const ruleRoutes = (base, kind, gate) => {
    app.get(
      base,
      auth,
      gate("read"),
      wrap((req, res) => {
        res.json(lifecycle.listRules(db, { ...req.query, kind }, lifecycleRead(req)));
      })
    );
    app.get(
      `${base}/:id`,
      auth,
      gate("read"),
      wrap((req, res) => {
        res.json(lifecycle.getRule(db, req.params.id, lifecycleRead(req)));
      })
    );
    app.post(
      base,
      auth,
      gate("create"),
      wrap((req, res) => {
        const body = { ...(req.body || {}), kind };
        res.status(201).json(lifecycle.createRule(db, body, req.actor, clientIp(req), lifecycleWrite(req, body)));
      })
    );
    app.put(
      `${base}/:id`,
      auth,
      gate("update"),
      wrap((req, res) => {
        res.json(lifecycle.updateRule(db, req.params.id, req.body || {}, req.actor, clientIp(req), lifecycleRead(req)));
      })
    );
    app.delete(
      `${base}/:id`,
      auth,
      gate("delete"),
      wrap((req, res) => {
        res.json(lifecycle.deleteRule(db, req.params.id, req.actor, clientIp(req), lifecycleRead(req)));
      })
    );
  };
  ruleRoutes("/api/release-rules", "release", canReleaseRules);
  ruleRoutes("/api/approval-rules", "approval", canReleaseRules);

  app.get(
    "/api/objects/:id/lifecycle",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(lifecycle.objectLifecycle(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/objects/:id/transitions",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json({ items: lifecycle.objectLifecycle(db, req.params.id, req.tenantId).transitions });
    })
  );

  app.post(
    "/api/objects/:id/transitions",
    auth,
    canLifecycle("execute"),
    wrap((req, res) => {
      res.json(
        lifecycle.transitionObject(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req))
      );
    })
  );

  app.get(
    "/api/objects/:id/status-history",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(lifecycle.statusHistory(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/objects/:id/release",
    auth,
    canReleaseRules("execute"),
    wrap((req, res) => {
      res.status(201).json(
        lifecycle.requestObjectRelease(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req))
      );
    })
  );

  app.get(
    "/api/objects/:id/releases",
    auth,
    canObjects("read"),
    wrap((req, res) => {
      res.json(lifecycle.objectReleases(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/objects/:id/approvals/:approvalId",
    auth,
    canApprovals("execute"),
    wrap((req, res) => {
      res.json(
        lifecycle.decideApproval(
          db,
          req.params.id,
          req.params.approvalId,
          req.body || {},
          req.actor,
          req.tenantId,
          clientIp(req)
        )
      );
    })
  );

  // Workflow & Process Engine: templates, designer, runtime instances, tasks,
  // approvals and configuration (routing, escalation, notifications, bindings,
  // delegations). Gated by iam.workflow.*; instances are tenant-scoped.
  const canWorkflow = (action) => can("iam.workflow", action);
  const canWorkflowTemplates = (action) => can("iam.workflow.templates", action);
  const canWorkflowDesigner = (action) => can("iam.workflow.designer", action);
  const canWorkflowInstances = (action) => can("iam.workflow.instances", action);
  const canWorkflowTasks = (action) => can("iam.workflow.tasks", action);
  const canWorkflowApprovals = (action) => can("iam.workflow.approvals", action);
  const canWorkflowConfig = (action) => can("iam.workflow.config", action);
  const wfRead = (req, source) => metaReadTenant(db, req.actor, source || req.query, req.tenantId);
  const wfWrite = (req, body) => metaWriteTenant(db, req.actor, body ?? req.body, req.tenantId);

  app.get(
    "/api/workflow-templates",
    auth,
    canWorkflowTemplates("read"),
    wrap((req, res) => {
      res.json(workflow.listDefinitions(db, req.query, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates",
    auth,
    canWorkflowTemplates("create"),
    wrap((req, res) => {
      const body = req.body || {};
      res.status(201).json(workflow.createDefinition(db, body, req.actor, clientIp(req), wfWrite(req, body)));
    })
  );

  app.get(
    "/api/workflow-templates/:id",
    auth,
    canWorkflowTemplates("read"),
    wrap((req, res) => {
      res.json(workflow.getDefinition(db, req.params.id, wfRead(req)));
    })
  );

  const updateWorkflowTemplate = wrap((req, res) => {
    res.json(workflow.updateDefinition(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
  });
  app.put("/api/workflow-templates/:id", auth, canWorkflowTemplates("update"), updateWorkflowTemplate);
  app.patch("/api/workflow-templates/:id", auth, canWorkflowTemplates("update"), updateWorkflowTemplate);

  app.post(
    "/api/workflow-templates/:id/status",
    auth,
    canWorkflowTemplates("update"),
    wrap((req, res) => {
      res.json(workflow.setDefinitionStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id",
    auth,
    canWorkflowTemplates("delete"),
    wrap((req, res) => {
      res.json(workflow.deleteDefinition(db, req.params.id, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.get(
    "/api/workflow-templates/:id/versions",
    auth,
    canWorkflowTemplates("read"),
    wrap((req, res) => {
      res.json(workflow.listVersions(db, req.params.id, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/versions",
    auth,
    canWorkflowTemplates("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.createVersion(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.get(
    "/api/workflow-templates/:id/versions/:version",
    auth,
    canWorkflowTemplates("read"),
    wrap((req, res) => {
      res.json(workflow.getVersion(db, req.params.id, req.params.version, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/validate",
    auth,
    canWorkflowTemplates("read"),
    wrap((req, res) => {
      res.json(workflow.validateDefinition(db, req.params.id, wfRead(req), { version: req.body?.version ?? req.query.version }));
    })
  );

  app.post(
    "/api/workflow-templates/:id/publish",
    auth,
    canWorkflowTemplates("update"),
    wrap((req, res) => {
      res.json(workflow.publishDefinition(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/clone",
    auth,
    canWorkflowTemplates("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.cloneDefinition(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  // --- Designer -----------------------------------------------------------
  app.get(
    "/api/workflow-templates/:id/designer",
    auth,
    canWorkflowDesigner("read"),
    wrap((req, res) => {
      res.json(workflow.designerContext(db, req.params.id, wfRead(req), req.query));
    })
  );

  app.put(
    "/api/workflow-templates/:id/designer",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.saveDesignerGraph(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/nodes",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.status(201).json(workflow.addNode(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.patch(
    "/api/workflow-templates/:id/designer/nodes/:nodeId",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.patchNode(db, req.params.id, req.params.nodeId, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id/designer/nodes/:nodeId",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.removeNode(db, req.params.id, req.params.nodeId, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/transitions",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.status(201).json(workflow.addTransition(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.patch(
    "/api/workflow-templates/:id/designer/transitions/:transitionId",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.patchTransition(db, req.params.id, req.params.transitionId, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-templates/:id/designer/transitions/:transitionId",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.removeTransition(db, req.params.id, req.params.transitionId, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/auto-layout",
    auth,
    canWorkflowDesigner("update"),
    wrap((req, res) => {
      res.json(workflow.applyAutoLayout(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-templates/:id/designer/validate",
    auth,
    canWorkflowDesigner("read"),
    wrap((req, res) => {
      res.json(workflow.validateDesignerGraph(db, req.params.id, req.body || {}, wfRead(req)));
    })
  );

  // --- Instances ----------------------------------------------------------
  app.get(
    "/api/workflow-instances",
    auth,
    canWorkflowInstances("read"),
    wrap((req, res) => {
      res.json(workflow.listInstances(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/workflow-instances",
    auth,
    canWorkflowInstances("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.startInstance(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/workflow-instances/:id",
    auth,
    canWorkflowInstances("read"),
    wrap((req, res) => {
      res.json(workflow.getInstance(db, req.params.id, req.tenantId));
    })
  );

  app.get(
    "/api/workflow-instances/:id/nodes",
    auth,
    canWorkflowInstances("read"),
    wrap((req, res) => {
      res.json({ items: workflow.instanceNodes(db, req.params.id, req.tenantId) });
    })
  );

  app.get(
    "/api/workflow-instances/:id/history",
    auth,
    canWorkflowInstances("read"),
    wrap((req, res) => {
      res.json(workflow.instanceHistory(db, req.params.id, req.tenantId, req.query));
    })
  );

  app.post(
    "/api/workflow-instances/:id/cancel",
    auth,
    canWorkflowInstances("execute"),
    wrap((req, res) => {
      res.json(
        workflow.cancelInstance(db, req.params.id, {
          reason: req.body?.reason || req.body?.comments || "",
          actor: req.actor,
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/workflow-instances/:id/pause",
    auth,
    canWorkflowInstances("execute"),
    wrap((req, res) => {
      res.json(workflow.pauseInstance(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/workflow-instances/:id/resume",
    auth,
    canWorkflowInstances("execute"),
    wrap((req, res) => {
      res.json(workflow.resumeInstance(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/workflow-instances/:id/retry",
    auth,
    canWorkflowInstances("execute"),
    wrap((req, res) => {
      res.json(workflow.retryInstance(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  // --- Tasks --------------------------------------------------------------
  app.get(
    "/api/tasks",
    auth,
    canWorkflowTasks("read"),
    wrap((req, res) => {
      res.json(workflow.listTasks(db, req.query, req.tenantId, req.actor, { scope: req.query.scope || "mine" }));
    })
  );

  app.get(
    "/api/tasks/:id",
    auth,
    canWorkflowTasks("read"),
    wrap((req, res) => {
      res.json(workflow.getTask(db, req.params.id, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/tasks/:id/complete",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.json(workflow.completeTask(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/assign",
    auth,
    canWorkflowTasks("update"),
    wrap((req, res) => {
      res.json(workflow.assignTask(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/claim",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.json(workflow.claimTask(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/delegate",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.json(workflow.delegateTask(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.post(
    "/api/tasks/:id/status",
    auth,
    canWorkflowTasks("update"),
    wrap((req, res) => {
      res.json(workflow.updateTaskStatus(db, req.params.id, req.body?.status, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/tasks/:id/comments",
    auth,
    canWorkflowTasks("read"),
    wrap((req, res) => {
      res.json({ items: workflow.listComments(db, req.params.id, req.tenantId) });
    })
  );

  app.post(
    "/api/tasks/:id/comments",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.status(201).json(workflow.addComment(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.get(
    "/api/tasks/:id/attachments",
    auth,
    canWorkflowTasks("read"),
    wrap((req, res) => {
      res.json({ items: workflow.listAttachments(db, req.params.id, req.tenantId) });
    })
  );

  app.post(
    "/api/tasks/:id/attachments",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.status(201).json(workflow.addAttachment(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.post(
    "/api/tasks/:id/subtasks",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.status(201).json(workflow.addSubtask(db, req.params.id, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.patch(
    "/api/tasks/:id/subtasks/:subtaskId",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.json(workflow.updateSubtask(db, req.params.id, req.params.subtaskId, req.body || {}, req.actor, req.tenantId));
    })
  );

  app.delete(
    "/api/tasks/:id/subtasks/:subtaskId",
    auth,
    canWorkflowTasks("execute"),
    wrap((req, res) => {
      res.json(workflow.deleteSubtask(db, req.params.id, req.params.subtaskId, req.actor, req.tenantId));
    })
  );

  // --- Approvals ----------------------------------------------------------
  app.get(
    "/api/workflow-approvals",
    auth,
    canWorkflowApprovals("read"),
    wrap((req, res) => {
      res.json(workflow.listApprovals(db, req.query, req.tenantId, req.actor, { scope: req.query.scope || "mine" }));
    })
  );

  app.get(
    "/api/workflow-approvals/:id",
    auth,
    canWorkflowApprovals("read"),
    wrap((req, res) => {
      res.json(workflow.getApproval(db, req.params.id, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/workflow-approvals/:id/decision",
    auth,
    canWorkflowApprovals("execute"),
    wrap((req, res) => {
      res.json(workflow.decideApproval(db, req.params.id, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  const approvalDecision = (decision) =>
    wrap((req, res) => {
      res.json(
        workflow.decideApproval(db, req.params.id, { ...(req.body || {}), decision }, req.actor, req.tenantId, clientIp(req))
      );
    });
  app.post("/api/workflow-approvals/:id/approve", auth, canWorkflowApprovals("execute"), approvalDecision("approve"));
  app.post("/api/workflow-approvals/:id/reject", auth, canWorkflowApprovals("execute"), approvalDecision("reject"));
  app.post(
    "/api/workflow-approvals/:id/request-changes",
    auth,
    canWorkflowApprovals("execute"),
    approvalDecision("request_changes")
  );

  // --- Routing rules ------------------------------------------------------
  app.get(
    "/api/workflow-routing-rules",
    auth,
    canWorkflowConfig("read"),
    wrap((req, res) => {
      res.json(workflow.listRoutingRules(db, req.query, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-routing-rules",
    auth,
    canWorkflowConfig("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.createRoutingRule(db, req.body || {}, req.actor, clientIp(req), wfWrite(req)));
    })
  );

  app.patch(
    "/api/workflow-routing-rules/:id",
    auth,
    canWorkflowConfig("update"),
    wrap((req, res) => {
      res.json(workflow.updateRoutingRule(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-routing-rules/:id",
    auth,
    canWorkflowConfig("delete"),
    wrap((req, res) => {
      res.json(workflow.deleteRoutingRule(db, req.params.id, req.actor, clientIp(req), wfRead(req)));
    })
  );

  // --- Escalation ---------------------------------------------------------
  app.get(
    "/api/workflow-escalation-rules",
    auth,
    canWorkflowConfig("read"),
    wrap((req, res) => {
      res.json(workflow.listEscalationRules(db, req.query, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-escalation-rules",
    auth,
    canWorkflowConfig("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.createEscalationRule(db, req.body || {}, req.actor, clientIp(req), wfWrite(req)));
    })
  );

  app.patch(
    "/api/workflow-escalation-rules/:id",
    auth,
    canWorkflowConfig("update"),
    wrap((req, res) => {
      res.json(workflow.updateEscalationRule(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-escalation-rules/:id",
    auth,
    canWorkflowConfig("delete"),
    wrap((req, res) => {
      res.json(workflow.deleteEscalationRule(db, req.params.id, req.actor, clientIp(req), wfRead(req)));
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
    auth,
    canWorkflow("read"),
    wrap((req, res) => {
      res.json(workflow.listNotifications(db, req.query, req.tenantId));
    })
  );

  app.post(
    "/api/workflow-notifications/:id/read",
    auth,
    canWorkflow("execute"),
    wrap((req, res) => {
      res.json(workflow.markNotificationRead(db, req.params.id, req.tenantId, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/workflow-notification-templates",
    auth,
    canWorkflowConfig("read"),
    wrap((req, res) => {
      res.json(workflow.listTemplates(db, req.query, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-notification-templates",
    auth,
    canWorkflowConfig("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.createTemplate(db, req.body || {}, req.actor, clientIp(req), wfWrite(req)));
    })
  );

  app.patch(
    "/api/workflow-notification-templates/:id",
    auth,
    canWorkflowConfig("update"),
    wrap((req, res) => {
      res.json(workflow.updateTemplate(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-notification-templates/:id",
    auth,
    canWorkflowConfig("delete"),
    wrap((req, res) => {
      res.json(workflow.deleteTemplate(db, req.params.id, req.actor, clientIp(req), wfRead(req)));
    })
  );

  // --- Bindings -----------------------------------------------------------
  app.get(
    "/api/workflow-bindings",
    auth,
    canWorkflowConfig("read"),
    wrap((req, res) => {
      res.json(workflow.listBindings(db, req.query, wfRead(req)));
    })
  );

  app.post(
    "/api/workflow-bindings",
    auth,
    canWorkflowConfig("create"),
    wrap((req, res) => {
      res.status(201).json(workflow.createBinding(db, req.body || {}, req.actor, clientIp(req), wfWrite(req)));
    })
  );

  app.patch(
    "/api/workflow-bindings/:id",
    auth,
    canWorkflowConfig("update"),
    wrap((req, res) => {
      res.json(workflow.updateBinding(db, req.params.id, req.body || {}, req.actor, clientIp(req), wfRead(req)));
    })
  );

  app.delete(
    "/api/workflow-bindings/:id",
    auth,
    canWorkflowConfig("delete"),
    wrap((req, res) => {
      res.json(workflow.deleteBinding(db, req.params.id, req.actor, clientIp(req), wfRead(req)));
    })
  );

  // --- Delegations --------------------------------------------------------
  app.get(
    "/api/workflow-delegations",
    auth,
    canWorkflow("read"),
    wrap((req, res) => {
      res.json(workflow.listDelegations(db, req.query, req.tenantId, req.actor));
    })
  );

  app.post(
    "/api/workflow-delegations",
    auth,
    canWorkflow("execute"),
    wrap((req, res) => {
      res.status(201).json(workflow.createDelegation(db, req.body || {}, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.delete(
    "/api/workflow-delegations/:id",
    auth,
    canWorkflow("execute"),
    wrap((req, res) => {
      res.json(workflow.revokeDelegation(db, req.params.id, req.actor, req.tenantId, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      res.json(orgs.listOrganizations(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.get(
    "/api/organizations/tree",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      res.json(orgs.organizationTree(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/organizations",
    auth,
    can("iam.organizations", "create"),
    wrap((req, res) => {
      const body = req.body || {};
      if (body.parent_id) scopedOrg(db, req, body.parent_id);
      const org = orgs.createOrganization(db, body, req.actor, clientIp(req));
      res.status(201).json(org);
    })
  );

  app.get(
    "/api/organizations/:id",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.organizationDetail(db, req.params.id));
    })
  );

  app.put(
    "/api/organizations/:id",
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.updateOrganization(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/organizations/:id",
    auth,
    can("iam.organizations", "delete"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.deleteOrganization(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/organizations/:id/activate",
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.setOrganizationStatus(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/organizations/:id/deactivate",
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.setOrganizationStatus(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations/:id/sites",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json({ items: orgs.listSites(db, req.params.id) });
    })
  );

  app.get(
    "/api/organizations/:id/config",
    auth,
    can("iam.config", "read"),
    wrap((req, res) => {
      const org = scopedOrg(db, req, req.params.id);
      res.json({
        scope: "organization",
        scope_id: Number(req.params.id),
        items: config.listScopeValues(db, "organization", req.params.id),
        effective: config.resolveAll(db, { tenantId: org.tenant_id || req.tenantId, organizationId: req.params.id }),
      });
    })
  );

  app.put(
    "/api/organizations/:id/config",
    auth,
    can("iam.config", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(
        config.putValues(
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
    auth,
    can("iam.organizations", "create"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      const site = orgs.createOrganization(
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
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      if (req.body?.parent_id) scopedOrg(db, req, req.body.parent_id);
      res.json(orgs.moveOrganization(db, req.params.id, req.body?.parent_id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/organizations/:id/members",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json({ items: orgs.listMembers(db, req.params.id) });
    })
  );

  app.post(
    "/api/organizations/:id/members",
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      const { userId, isPrimary } = req.body || {};
      scopedOrg(db, req, req.params.id);
      if (!userId) throw new HttpError(400, "userId is required");
      users.getUser(db, userId, tenantFilter(req));
      res.status(201).json({ items: orgs.addMember(db, req.params.id, userId, isPrimary, req.actor, clientIp(req)) });
    })
  );

  app.delete(
    "/api/organizations/:id/members/:userId",
    auth,
    can("iam.organizations", "update"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json({
        items: orgs.removeMember(db, req.params.id, req.params.userId, req.actor, clientIp(req)),
      });
    })
  );

  app.get(
    "/api/organizations/:id/context",
    auth,
    can("iam.organizations", "read"),
    wrap((req, res) => {
      scopedOrg(db, req, req.params.id);
      res.json(orgs.organizationContext(db, req.params.id));
    })
  );

  app.get(
    "/api/hierarchy",
    auth,
    can("iam.organizations", "read"),
    wrap((_req, res) => {
      res.json(hierarchy.getHierarchy(db));
    })
  );

  app.get(
    "/api/platform/hierarchy",
    auth,
    can("iam.platform", "read"),
    wrap((_req, res) => {
      res.json(hierarchy.getHierarchy(db, { includeInactive: true }));
    })
  );

  app.put(
    "/api/platform/hierarchy",
    auth,
    can("iam.platform", "update"),
    wrap((req, res) => {
      res.json(hierarchy.replaceHierarchy(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/platform/settings",
    auth,
    can("iam.platform", "read"),
    wrap((_req, res) => {
      res.json(hierarchy.getSettings(db));
    })
  );

  app.put(
    "/api/platform/settings",
    auth,
    can("iam.platform", "update"),
    wrap((req, res) => {
      res.json(hierarchy.updateSettings(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  for (const [prefix, kind] of Object.entries(orgs.typedCollections(db))) {
    app.get(
      `/api/${prefix}`,
      auth,
      can("iam.organizations", "read"),
      wrap((req, res) => {
        res.json(orgs.listOrganizations(db, { ...req.query, kind, ...tenantFilter(req) }));
      })
    );
    app.post(
      `/api/${prefix}`,
      auth,
      can("iam.organizations", "create"),
      wrap((req, res) => {
        if (req.body?.parent_id) scopedOrg(db, req, req.body.parent_id);
        const org = orgs.createOrganization(db, { ...(req.body || {}), kind }, req.actor, clientIp(req));
        res.status(201).json(org);
      })
    );
    app.get(
      `/api/${prefix}/:id`,
      auth,
      can("iam.organizations", "read"),
      wrap((req, res) => {
        orgs.getOrganizationOfKind(db, req.params.id, kind);
        scopedOrg(db, req, req.params.id);
        res.json(orgs.organizationDetail(db, req.params.id));
      })
    );
    app.put(
      `/api/${prefix}/:id`,
      auth,
      can("iam.organizations", "update"),
      wrap((req, res) => {
        orgs.getOrganizationOfKind(db, req.params.id, kind);
        scopedOrg(db, req, req.params.id);
        res.json(
          orgs.updateOrganization(db, req.params.id, { ...(req.body || {}), kind }, req.actor, clientIp(req))
        );
      })
    );
    app.delete(
      `/api/${prefix}/:id`,
      auth,
      can("iam.organizations", "delete"),
      wrap((req, res) => {
        orgs.getOrganizationOfKind(db, req.params.id, kind);
        scopedOrg(db, req, req.params.id);
        res.json(orgs.deleteOrganization(db, req.params.id, req.actor, clientIp(req)));
      })
    );
  }

  app.get(
    "/api/users",
    auth,
    can("iam.users", "read"),
    wrap((req, res) => {
      res.json(users.listUsers(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/users",
    auth,
    can("iam.users", "create"),
    wrap((req, res) => {
      const user = users.createUser(
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
    auth,
    can("iam.users", "read"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      const { user, groups: memberships, roles: assigned, organizations } = users.userMemberships(
        db,
        req.params.id
      );
      res.json({
        ...user,
        groups: memberships,
        roles: assigned,
        organizations,
        access: effectiveAccess(db, req.params.id),
      });
    })
  );

  app.put(
    "/api/users/:id",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json(users.updateUser(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/activate",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json(users.setUserStatus(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/deactivate",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json(users.setUserStatus(db, req.params.id, "inactive", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/lock",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json(users.setUserStatus(db, req.params.id, "locked", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/unlock",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json(users.setUserStatus(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/reset-password",
    auth,
    can("iam.users", "execute"),
    wrap((req, res) => {
      const { password } = req.body || {};
      users.getUser(db, req.params.id, tenantFilter(req));
      if (!password) throw new HttpError(400, "password is required");
      res.json(users.resetPassword(db, req.params.id, password, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/users/:id/groups",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      const { groupId } = req.body || {};
      users.getUser(db, req.params.id, tenantFilter(req));
      if (!groupId) throw new HttpError(400, "groupId is required");
      groups.getGroup(db, groupId, tenantFilter(req));
      res.json({ members: groups.addGroupMember(db, groupId, req.params.id, req.actor, clientIp(req)) });
    })
  );

  app.delete(
    "/api/users/:id/groups/:groupId",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      groups.getGroup(db, req.params.groupId, tenantFilter(req));
      res.json({
        members: groups.removeGroupMember(db, req.params.groupId, req.params.id, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/users/:id/roles",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      const { roleId, organizationId } = req.body || {};
      users.getUser(db, req.params.id, tenantFilter(req));
      if (!roleId) throw new HttpError(400, "roleId is required");
      if (organizationId) scopedOrg(db, req, organizationId);
      res.json({
        roles: roles.assignUserRole(db, req.params.id, roleId, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/users/:id/roles/:roleId",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json({
        roles: roles.unassignUserRole(
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
    auth,
    can("iam.users", "read"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      res.json({ items: orgs.listUserOrganizations(db, req.params.id) });
    })
  );

  app.post(
    "/api/users/:id/organizations",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      const { organizationId, isPrimary } = req.body || {};
      if (!organizationId) throw new HttpError(400, "organizationId is required");
      users.getUser(db, req.params.id, tenantFilter(req));
      scopedOrg(db, req, organizationId);
      orgs.addMember(db, organizationId, req.params.id, isPrimary, req.actor, clientIp(req));
      res.status(201).json({ items: orgs.listUserOrganizations(db, req.params.id) });
    })
  );

  app.delete(
    "/api/users/:id/organizations/:orgId",
    auth,
    can("iam.users", "update"),
    wrap((req, res) => {
      users.getUser(db, req.params.id, tenantFilter(req));
      scopedOrg(db, req, req.params.orgId);
      orgs.removeMember(db, req.params.orgId, req.params.id, req.actor, clientIp(req));
      res.json({ items: orgs.listUserOrganizations(db, req.params.id) });
    })
  );

  app.get(
    "/api/groups",
    auth,
    can("iam.groups", "read"),
    wrap((req, res) => {
      res.json(groups.listGroups(db, { ...req.query, ...tenantFilter(req) }));
    })
  );

  app.post(
    "/api/groups",
    auth,
    can("iam.groups", "create"),
    wrap((req, res) => {
      if (req.body?.organization_id) scopedOrg(db, req, req.body.organization_id);
      const group = groups.createGroup(
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
    auth,
    can("iam.groups", "read"),
    wrap((req, res) => {
      const group = groups.getGroup(db, req.params.id, tenantFilter(req));
      res.json({
        ...group,
        members: groups.listGroupMembers(db, req.params.id),
        roles: roles.listGroupRoles(db, req.params.id),
        ancestors: groups.ancestorGroups(db, req.params.id).slice(1),
      });
    })
  );

  app.put(
    "/api/groups/:id",
    auth,
    can("iam.groups", "update"),
    wrap((req, res) => {
      groups.getGroup(db, req.params.id, tenantFilter(req));
      if (req.body?.organization_id) scopedOrg(db, req, req.body.organization_id);
      res.json(groups.updateGroup(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/groups/:id",
    auth,
    can("iam.groups", "delete"),
    wrap((req, res) => {
      groups.getGroup(db, req.params.id, tenantFilter(req));
      res.json(groups.deleteGroup(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/groups/:id/members",
    auth,
    can("iam.groups", "read"),
    wrap((req, res) => {
      groups.getGroup(db, req.params.id, tenantFilter(req));
      res.json({ items: groups.listGroupMembers(db, req.params.id) });
    })
  );

  app.post(
    "/api/groups/:id/members",
    auth,
    can("iam.groups", "update"),
    wrap((req, res) => {
      const { userId } = req.body || {};
      groups.getGroup(db, req.params.id, tenantFilter(req));
      if (!userId) throw new HttpError(400, "userId is required");
      users.getUser(db, userId, tenantFilter(req));
      res.json({ items: groups.addGroupMember(db, req.params.id, userId, req.actor, clientIp(req)) });
    })
  );

  app.delete(
    "/api/groups/:id/members/:userId",
    auth,
    can("iam.groups", "update"),
    wrap((req, res) => {
      res.json({
        items: groups.removeGroupMember(db, req.params.id, req.params.userId, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/groups/:id/roles",
    auth,
    can("iam.groups", "update"),
    wrap((req, res) => {
      const { roleId, organizationId } = req.body || {};
      if (!roleId) throw new HttpError(400, "roleId is required");
      res.json({
        roles: roles.assignGroupRole(db, req.params.id, roleId, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/groups/:id/roles/:roleId",
    auth,
    can("iam.groups", "update"),
    wrap((req, res) => {
      res.json({
        roles: roles.unassignGroupRole(
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
    auth,
    can("iam.roles", "read"),
    wrap((req, res) => {
      res.json(roles.listRoles(db, req.query));
    })
  );

  app.post(
    "/api/roles",
    auth,
    can("iam.roles", "create"),
    wrap((req, res) => {
      const role = roles.createRole(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(role);
    })
  );

  app.get(
    "/api/roles/:id",
    auth,
    can("iam.roles", "read"),
    wrap((req, res) => {
      const role = roles.getRole(db, req.params.id);
      res.json({
        ...role,
        ancestors: roles.ancestorRoles(db, req.params.id).slice(1),
        assignments: roles.roleAssignments(db, req.params.id),
        permissions: grants.listRolePermissions(db, req.params.id),
      });
    })
  );

  app.put(
    "/api/roles/:id",
    auth,
    can("iam.roles", "update"),
    wrap((req, res) => {
      res.json(roles.updateRole(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/roles/:id",
    auth,
    can("iam.roles", "delete"),
    wrap((req, res) => {
      res.json(roles.deleteRole(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/roles/:id/users",
    auth,
    can("iam.roles", "update"),
    wrap((req, res) => {
      const { userId, organizationId } = req.body || {};
      if (!userId) throw new HttpError(400, "userId is required");
      res.json({
        roles: roles.assignUserRole(db, userId, req.params.id, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.post(
    "/api/roles/:id/groups",
    auth,
    can("iam.roles", "update"),
    wrap((req, res) => {
      const { groupId, organizationId } = req.body || {};
      if (!groupId) throw new HttpError(400, "groupId is required");
      res.json({
        roles: roles.assignGroupRole(db, groupId, req.params.id, organizationId, req.actor, clientIp(req)),
      });
    })
  );

  app.get(
    "/api/password-policy",
    auth,
    can("iam.policy", "read"),
    wrap((_req, res) => {
      res.json(policy.getPolicy(db));
    })
  );

  app.put(
    "/api/password-policy",
    auth,
    can("iam.policy", "update"),
    wrap((req, res) => {
      const next = policy.updatePolicy(db, req.body || {});
      audit.writeAudit(db, {
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
    auth,
    can("iam.audit", "read"),
    wrap((req, res) => {
      const page = pagination(req.query);
      res.json(
        audit.listAuditLogs(db, {
          ...page,
          action: req.query.action,
          resourceType: req.query.resourceType,
          q: req.query.q,
          scope: auditScope(req),
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

  app.get(
    "/api/audit/events",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.listEvents(db, eventFilters(req), auditScope(req)));
    })
  );

  app.get(
    "/api/audit/summary",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.auditSummary(db, eventFilters(req), auditScope(req)));
    })
  );

  app.get(
    "/api/audit/facets",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.eventFacets(db, eventFilters(req), auditScope(req)));
    })
  );

  app.get(
    "/api/audit/events/:id",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.getEvent(db, req.params.id, auditScope(req)));
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
    auth,
    can("iam.audit.history", "read"),
    wrap((req, res) => {
      assertHistoryVisible(req, req.params.objectType);
      res.json(
        audit.objectHistory(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId },
          eventFilters(req),
          auditScope(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/users/:userId/activity",
    auth,
    can("iam.audit.history", "read"),
    wrap((req, res) => {
      res.json(audit.userActivity(db, req.params.userId, eventFilters(req), auditScope(req)));
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
    auth,
    can("iam.audit.policies", "read"),
    wrap((req, res) => {
      const includeSystem = req.query.includeSystem !== "false";
      res.json(
        audit.listPolicies(db, {
          tenantId: tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true" ? null : req.tenantId,
          objectType: req.query.objectType,
          status: req.query.status,
          includeSystem,
        })
      );
    })
  );

  app.get(
    "/api/audit/policies/:id",
    auth,
    can("iam.audit.policies", "read"),
    wrap((req, res) => {
      res.json(audit.getPolicy(db, req.params.id, tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId));
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
    auth,
    can("iam.audit.retention", "read"),
    wrap((req, res) => {
      const page = pagination(req.query);
      res.json(audit.listRetentionRuns(db, { ...page, tenantId: req.tenantId }));
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
      auth,
      can("iam.audit.events", "read"),
      wrap((req, res) => {
        res.json(audit[fn](db, eventFilters(req), auditScope(req)));
      })
    );
  }

  app.get(
    "/api/audit/metrics",
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.auditMetrics(db, eventFilters(req), auditScope(req)));
    })
  );

  app.get(
    "/api/audit/attributes/:objectType/:objectId/history",
    auth,
    can("iam.audit.history", "read"),
    wrap((req, res) => {
      assertHistoryVisible(req, req.params.objectType);
      const attribute = req.query.attribute || req.query.changedAttribute;
      if (!attribute) throw new HttpError(400, "attribute query parameter is required");
      res.json(
        audit.attributeHistory(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId, attribute },
          eventFilters(req),
          auditScope(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/relationships/:objectType/:objectId/history",
    auth,
    can("iam.audit.history", "read"),
    wrap((req, res) => {
      assertHistoryVisible(req, req.params.objectType);
      res.json(
        audit.relationshipHistory(
          db,
          { objectType: req.params.objectType, objectId: req.params.objectId },
          eventFilters(req),
          auditScope(req)
        )
      );
    })
  );

  app.get(
    "/api/audit/exports",
    auth,
    can("iam.audit.export", "read"),
    wrap((req, res) => {
      const page = pagination(req.query);
      res.json(
        audit.listAuditExports(db, {
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
    auth,
    can("iam.audit.export", "read"),
    wrap((req, res) => {
      res.json(audit.getAuditExport(db, req.params.id, { tenantId: req.tenantId }));
    })
  );

  app.get(
    "/api/audit/exports/:id/download",
    auth,
    can("iam.audit.export", "read"),
    wrap((req, res) => {
      const result = audit.getAuditExport(db, req.params.id, { tenantId: req.tenantId, includeContent: true });
      audit.markAuditExportDownloaded(db, result.id);
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
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(
        audit.listActionTypes(db, {
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
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(audit.getActionType(db, req.params.code));
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
    auth,
    can("iam.audit.events", "read"),
    wrap((req, res) => {
      res.json(
        audit.listSavedFilters(db, {
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
    auth,
    can("iam.audit.retention", "read"),
    wrap((req, res) => {
      res.json(
        audit.listRetentionPolicies(db, {
          tenantId: tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true" ? null : req.tenantId,
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
    auth,
    can("iam.audit.retention", "read"),
    wrap((req, res) => {
      res.json(audit.getRetentionPolicy(db, req.params.id, tenants.isPlatformAdmin(db, req.actor.id) ? null : req.tenantId));
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
    auth,
    can("iam.permissions", "read"),
    wrap((_req, res) => {
      res.json({ items: catalog.listApplications(db) });
    })
  );

  app.post(
    "/api/applications",
    auth,
    can("iam.permissions", "create"),
    wrap((req, res) => {
      const appItem = catalog.createApplication(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(appItem);
    })
  );

  app.get(
    "/api/resources",
    auth,
    can("iam.permissions", "read"),
    wrap((req, res) => {
      res.json({ items: catalog.listResources(db, req.query) });
    })
  );

  app.post(
    "/api/resources",
    auth,
    can("iam.permissions", "create"),
    wrap((req, res) => {
      const resource = catalog.createResource(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(resource);
    })
  );

  app.put(
    "/api/resources/:id",
    auth,
    can("iam.permissions", "update"),
    wrap((req, res) => {
      res.json(catalog.updateResource(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/permissions",
    auth,
    can("iam.permissions", "read"),
    wrap((req, res) => {
      res.json(catalog.listPermissions(db, req.query));
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
    auth,
    can("iam.permissions", "create"),
    wrap((req, res) => {
      const permission = catalog.createPermission(db, req.body || {}, req.actor, clientIp(req));
      res.status(201).json(permission);
    })
  );

  app.delete(
    "/api/permissions/:id",
    auth,
    can("iam.permissions", "delete"),
    wrap((req, res) => {
      res.json(catalog.deletePermission(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/roles/:id/permissions",
    auth,
    can("iam.permissions", "read"),
    wrap((req, res) => {
      res.json({ items: grants.listRolePermissions(db, req.params.id) });
    })
  );

  app.put(
    "/api/roles/:id/permissions",
    auth,
    can("iam.permissions", "update"),
    wrap((req, res) => {
      const items = grants.replaceRolePermissionMatrix(
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
    auth,
    can("iam.permissions", "update"),
    wrap((req, res) => {
      res.status(201).json({
        items: grants.grantRolePermission(db, req.params.id, req.body || {}, req.actor, clientIp(req)),
      });
    })
  );

  app.delete(
    "/api/roles/:id/permissions/:permissionId",
    auth,
    can("iam.permissions", "update"),
    wrap((req, res) => {
      res.json({
        items: grants.revokeRolePermission(
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

  function notificationAdminScope(req) {
    if (tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true") return null;
    return req.tenantId || -1;
  }

  app.get(
    "/api/notifications/unread-count",
    auth,
    can("iam.notifications.inbox", "read"),
    wrap((req, res) => {
      res.json(notifications.unreadCount(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notifications/meta",
    auth,
    can("iam.notifications.inbox", "read"),
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
    auth,
    can("iam.notifications.inbox", "read"),
    wrap((req, res) => {
      res.json(notifications.listInbox(db, req.actor.id, notificationSelfTenant(req), req.query));
    })
  );

  app.post(
    "/api/notifications/mark-all-read",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.markAllRead(db, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/notifications/archive-all-read",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.archiveAllRead(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notifications/:id",
    auth,
    can("iam.notifications.inbox", "read"),
    wrap((req, res) => {
      res.json(notifications.getNotification(db, req.params.id, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.put(
    "/api/notifications/:id/read",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.markRead(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notifications/:id/unread",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.markUnread(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notifications/:id/archive",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.archiveNotification(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  app.delete(
    "/api/notifications/:id",
    auth,
    can("iam.notifications.inbox", "update"),
    wrap((req, res) => {
      res.json(notifications.deleteNotification(db, req.params.id, req.actor.id, notificationSelfTenant(req), req.actor, clientIp(req)));
    })
  );

  // ── Preferences (self-service) ───────────────────────────────────────────
  app.get(
    "/api/notification-preferences",
    auth,
    can("iam.notifications.preferences", "read"),
    wrap((req, res) => {
      res.json(notifications.getPreferences(db, req.actor.id, notificationSelfTenant(req)));
    })
  );

  app.put(
    "/api/notification-preferences",
    auth,
    can("iam.notifications.preferences", "update"),
    wrap((req, res) => {
      res.json(notifications.updatePreferences(db, req.actor.id, req.body || {}, req.actor, clientIp(req), notificationSelfTenant(req)));
    })
  );

  app.get(
    "/api/notification-preferences/mandatory",
    auth,
    can("iam.notifications.preferences", "read"),
    wrap((req, res) => {
      res.json({ items: notifications.mandatoryEvents(db, notificationSelfTenant(req)) });
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
    auth,
    can("iam.notifications.templates", "read"),
    wrap((req, res) => {
      res.json(notifications.listTemplates(db, req.query, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-templates",
    auth,
    can("iam.notifications.templates", "create"),
    wrap((req, res) => {
      res.status(201).json(notifications.createTemplate(db, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/notification-templates/:id",
    auth,
    can("iam.notifications.templates", "read"),
    wrap((req, res) => {
      res.json(notifications.publicTemplate(notifications.findTemplate(db, { id: req.params.id }, notificationSelfTenant(req))));
    })
  );

  app.get(
    "/api/notification-templates/:id/versions",
    auth,
    can("iam.notifications.templates", "read"),
    wrap((req, res) => {
      res.json({ items: notifications.listTemplateVersions(db, req.params.id, notificationSelfTenant(req)) });
    })
  );

  app.put(
    "/api/notification-templates/:id",
    auth,
    can("iam.notifications.templates", "update"),
    wrap((req, res) => {
      res.json(notifications.updateTemplate(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.put(
    "/api/notification-templates/:id/status",
    auth,
    can("iam.notifications.templates", "update"),
    wrap((req, res) => {
      res.json(notifications.setTemplateStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.post(
    "/api/notification-templates/:id/preview",
    auth,
    can("iam.notifications.templates", "execute"),
    wrap((req, res) => {
      res.json(notifications.previewTemplate(db, req.params.id, req.body?.context || {}, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-templates/:id/test-send",
    auth,
    can("iam.notifications.templates", "execute"),
    wrap((req, res) => {
      res.status(201).json(notifications.testSendTemplate(db, req.params.id, req.body || {}, req.actor, clientIp(req), notificationSelfTenant(req)));
    })
  );

  app.delete(
    "/api/notification-templates/:id",
    auth,
    can("iam.notifications.templates", "delete"),
    wrap((req, res) => {
      res.json(notifications.deleteTemplate(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  // ── Rules ────────────────────────────────────────────────────────────────
  app.get(
    "/api/notification-rules",
    auth,
    can("iam.notifications.rules", "read"),
    wrap((req, res) => {
      res.json(notifications.listRules(db, req.query, notificationSelfTenant(req)));
    })
  );

  app.post(
    "/api/notification-rules",
    auth,
    can("iam.notifications.rules", "create"),
    wrap((req, res) => {
      res.status(201).json(notifications.createRule(db, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.get(
    "/api/notification-rules/:id",
    auth,
    can("iam.notifications.rules", "read"),
    wrap((req, res) => {
      const row = notifications.getRuleRow(db, req.params.id);
      if (!row) throw new HttpError(404, "Notification rule not found");
      res.json(notifications.publicRule(row));
    })
  );

  app.put(
    "/api/notification-rules/:id",
    auth,
    can("iam.notifications.rules", "update"),
    wrap((req, res) => {
      res.json(notifications.updateRule(db, req.params.id, req.body || {}, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.put(
    "/api/notification-rules/:id/status",
    auth,
    can("iam.notifications.rules", "update"),
    wrap((req, res) => {
      res.json(notifications.setRuleStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req), req.tenantId));
    })
  );

  app.post(
    "/api/notification-rules/:id/simulate",
    auth,
    can("iam.notifications.rules", "execute"),
    wrap((req, res) => {
      res.json(notifications.simulateRule(db, req.params.id, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.delete(
    "/api/notification-rules/:id",
    auth,
    can("iam.notifications.rules", "delete"),
    wrap((req, res) => {
      res.json(notifications.deleteRule(db, req.params.id, req.actor, clientIp(req), req.tenantId));
    })
  );

  // ── Providers ────────────────────────────────────────────────────────────
  app.get(
    "/api/notification-providers",
    auth,
    can("iam.notifications.providers", "read"),
    wrap((req, res) => {
      res.json({ items: notifications.listProviders(db, { channel: req.query.channel }) });
    })
  );

  app.post(
    "/api/notification-providers",
    auth,
    can("iam.notifications.providers", "create"),
    wrap((req, res) => {
      res.status(201).json(notifications.createProvider(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/notification-providers/:id",
    auth,
    can("iam.notifications.providers", "update"),
    wrap((req, res) => {
      res.json(notifications.updateProvider(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/notification-providers/:id/test",
    auth,
    can("iam.notifications.providers", "execute"),
    wrap((req, res) => {
      res.json(notifications.testProvider(db, req.params.id, { recipient: req.body?.recipient }));
    })
  );

  app.delete(
    "/api/notification-providers/:id",
    auth,
    can("iam.notifications.providers", "delete"),
    wrap((req, res) => {
      res.json(notifications.deleteProvider(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  // ── History, delivery queue, reminders ───────────────────────────────────
  app.get(
    "/api/notification-history",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.listHistory(db, req.query, notificationAdminScope(req)));
    })
  );

  app.get(
    "/api/notification-events",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.listEvents(db, req.query, notificationAdminScope(req)));
    })
  );

  app.post(
    "/api/notification-events/publish",
    auth,
    can("iam.notifications.history", "execute"),
    wrap((req, res) => {
      res.status(201).json(notifications.publish(db, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/notification-events/:id",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.getEvent(db, req.params.id, notificationAdminScope(req)));
    })
  );

  app.get(
    "/api/notification-deliveries/stats",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.deliveryStats(db, notificationAdminScope(req)));
    })
  );

  app.get(
    "/api/notification-deliveries",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.listDeliveries(db, req.query, notificationAdminScope(req)));
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
    auth,
    can("iam.notifications.history", "execute"),
    wrap((req, res) => {
      res.json(notifications.retryDelivery(db, req.params.id, notificationAdminScope(req)));
    })
  );

  app.get(
    "/api/notification-reminders",
    auth,
    can("iam.notifications.history", "read"),
    wrap((req, res) => {
      res.json(notifications.listReminders(db, req.query, notificationAdminScope(req)));
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
    auth,
    can("iam.delivery.providers", "read"),
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
    auth,
    can("iam.delivery.requests", "read"),
    wrap((req, res) => {
      res.json(delivery.listRequests(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/requests",
    auth,
    can("iam.delivery.requests", "create"),
    wrap((req, res) => {
      res.status(201).json(delivery.submitRequest(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/requests/:id",
    auth,
    can("iam.delivery.requests", "read"),
    wrap((req, res) => {
      const request = delivery.getRequest(db, req.params.id, deliveryScope(req));
      request.attempts = delivery.listAttempts(db, request.id);
      res.json(request);
    })
  );

  app.get(
    "/api/delivery/requests/:id/attempts",
    auth,
    can("iam.delivery.requests", "read"),
    wrap((req, res) => {
      const request = delivery.getRequest(db, req.params.id, deliveryScope(req));
      res.json({ items: delivery.listAttempts(db, request.id) });
    })
  );

  app.post(
    "/api/delivery/requests/:id/cancel",
    auth,
    can("iam.delivery.requests", "execute"),
    wrap((req, res) => {
      res.json(delivery.cancelRequest(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/requests/:id/retry",
    auth,
    can("iam.delivery.requests", "execute"),
    wrap((req, res) => {
      res.json(delivery.retryRequest(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
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
    auth,
    can("iam.delivery.providers", "read"),
    wrap((req, res) => {
      res.json({ items: delivery.listDeliveryProviders(db, deliveryQuery(req)) });
    })
  );

  app.post(
    "/api/delivery/providers",
    auth,
    can("iam.delivery.providers", "create"),
    wrap((req, res) => {
      res.status(201).json(delivery.createDeliveryProvider(db, { ...(req.body || {}), tenant_id: req.tenantId }, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/delivery/providers/:id",
    auth,
    can("iam.delivery.providers", "read"),
    wrap((req, res) => {
      res.json(delivery.getDeliveryProvider(db, req.params.id));
    })
  );

  app.put(
    "/api/delivery/providers/:id",
    auth,
    can("iam.delivery.providers", "update"),
    wrap((req, res) => {
      res.json(delivery.updateDeliveryProvider(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.put(
    "/api/delivery/providers/:id/status",
    auth,
    can("iam.delivery.providers", "update"),
    wrap((req, res) => {
      res.json(delivery.setDeliveryProviderStatus(db, req.params.id, req.body?.status, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/delivery/providers/:id/test",
    auth,
    can("iam.delivery.providers", "execute"),
    wrap((req, res) => {
      res.json(delivery.testDeliveryProvider(db, req.params.id, { recipient: req.body?.recipient }));
    })
  );

  app.delete(
    "/api/delivery/providers/:id",
    auth,
    can("iam.delivery.providers", "delete"),
    wrap((req, res) => {
      res.json(delivery.deleteDeliveryProvider(db, req.params.id, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/delivery/provider-failures",
    auth,
    can("iam.delivery.providers", "read"),
    wrap((req, res) => {
      res.json({ items: delivery.listProviderFailures(db, req.query, deliveryScope(req)), summary: delivery.providerFailureSummary(db, deliveryScope(req)) });
    })
  );

  app.get(
    "/api/delivery/provider-health",
    auth,
    can("iam.delivery.providers", "read"),
    wrap((req, res) => {
      res.json(delivery.providerHealth(db, deliveryScope(req)));
    })
  );

  // Reminders
  app.get(
    "/api/delivery/reminders",
    auth,
    can("iam.delivery.reminders", "read"),
    wrap((req, res) => {
      res.json(delivery.listReminders(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/reminders",
    auth,
    can("iam.delivery.reminders", "create"),
    wrap((req, res) => {
      res.status(201).json(delivery.scheduleReminder(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/reminders/:id",
    auth,
    can("iam.delivery.reminders", "read"),
    wrap((req, res) => {
      res.json(delivery.getReminder(db, req.params.id, deliveryScope(req)));
    })
  );

  app.put(
    "/api/delivery/reminders/:id",
    auth,
    can("iam.delivery.reminders", "update"),
    wrap((req, res) => {
      res.json(delivery.updateReminder(db, req.params.id, req.body || {}, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/delivery/reminders/:id/cancel",
    auth,
    can("iam.delivery.reminders", "execute"),
    wrap((req, res) => {
      res.json(delivery.cancelReminder(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
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
    auth,
    can("iam.delivery.reminders", "read"),
    wrap((req, res) => {
      res.json(delivery.listEscalations(db, deliveryQuery(req), deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/escalations",
    auth,
    can("iam.delivery.reminders", "create"),
    wrap((req, res) => {
      res.status(201).json(delivery.scheduleEscalation(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/escalations/:id",
    auth,
    can("iam.delivery.reminders", "read"),
    wrap((req, res) => {
      res.json(delivery.getEscalation(db, req.params.id, deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/escalations/:id/cancel",
    auth,
    can("iam.delivery.reminders", "execute"),
    wrap((req, res) => {
      res.json(delivery.cancelEscalation(db, req.params.id, { tenantId: deliveryScope(req), actor: req.actor, ip: clientIp(req) }));
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
    auth,
    can("iam.delivery.monitoring", "read"),
    wrap((req, res) => {
      res.json(delivery.deliveryMetrics(db, { tenantId: deliveryScope(req), from: req.query.from, to: req.query.to }));
    })
  );

  app.get(
    "/api/delivery/stats",
    auth,
    can("iam.delivery.monitoring", "read"),
    wrap((req, res) => {
      res.json(delivery.deliveryStats(db, deliveryScope(req)));
    })
  );

  app.get(
    "/api/delivery/timeseries",
    auth,
    can("iam.delivery.monitoring", "read"),
    wrap((req, res) => {
      res.json({ items: delivery.deliveryTimeseries(db, { tenantId: deliveryScope(req), from: req.query.from, to: req.query.to }) });
    })
  );

  app.get(
    "/api/delivery/alerts",
    auth,
    can("iam.delivery.monitoring", "read"),
    wrap((req, res) => {
      res.json(delivery.listAlerts(db, req.query, deliveryScope(req)));
    })
  );

  app.post(
    "/api/delivery/alerts/:id/acknowledge",
    auth,
    can("iam.delivery.monitoring", "update"),
    wrap((req, res) => {
      res.json(delivery.acknowledgeAlert(db, req.params.id, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/delivery/runs",
    auth,
    can("iam.delivery.monitoring", "read"),
    wrap((req, res) => {
      res.json({
        items: delivery.listRuns(db, {
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
  function jobScope(req) {
    if (tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true") return null;
    return req.tenantId || -1;
  }

  function jobQuery(req) {
    const scope = jobScope(req);
    return scope === null ? { ...req.query } : { ...req.query, tenantId: scope };
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
    auth,
    can("iam.jobs.types", "read"),
    wrap((req, res) => {
      res.json(jobs.listJobTypes(db, req.query));
    })
  );

  app.get(
    "/api/job-types/:code",
    auth,
    can("iam.jobs.types", "read"),
    wrap((req, res) => {
      res.json(jobs.getJobType(db, req.params.code));
    })
  );

  app.post(
    "/api/job-types",
    auth,
    can("iam.jobs.types", "create"),
    wrap((req, res) => {
      res.status(201).json(jobs.createJobType(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.patch(
    "/api/job-types/:code",
    auth,
    can("iam.jobs.types", "update"),
    wrap((req, res) => {
      res.json(jobs.updateJobType(db, req.params.code, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/job-types/:code/status",
    auth,
    can("iam.jobs.types", "update"),
    wrap((req, res) => {
      res.json(jobs.setJobTypeStatus(db, req.params.code, req.body?.active !== false, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/job-metrics",
    auth,
    can("iam.jobs.monitoring", "read"),
    wrap((req, res) => {
      res.json(jobs.jobMetrics(db, jobScope(req)));
    })
  );

  app.get(
    "/api/job-metrics/timeseries",
    auth,
    can("iam.jobs.monitoring", "read"),
    wrap((req, res) => {
      res.json({ items: jobs.jobTimeseries(db, jobScope(req), { days: req.query.days }) });
    })
  );

  app.get(
    "/api/jobs",
    auth,
    can("iam.jobs.list", "read"),
    wrap((req, res) => {
      res.json(jobs.listJobs(db, jobQuery(req), jobScope(req)));
    })
  );

  app.post(
    "/api/jobs",
    auth,
    can("iam.jobs.list", "create"),
    wrap((req, res) => {
      res.status(201).json(jobs.submitJob(db, { ...(req.body || {}), tenant_id: req.tenantId }, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id",
    auth,
    can("iam.jobs.details", "read"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      job.dependencies_state = jobs.dependencyState(db, job.id, jobScope(req));
      res.json(job);
    })
  );

  app.get(
    "/api/jobs/:id/status",
    auth,
    can("iam.jobs.details", "read"),
    wrap((req, res) => {
      res.json(jobs.getStatus(db, req.params.id, jobScope(req)));
    })
  );

  app.get(
    "/api/jobs/:id/history",
    auth,
    can("iam.jobs.details", "read"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      res.json(jobs.listHistory(db, job.id, req.query));
    })
  );

  app.get(
    "/api/jobs/:id/dependencies",
    auth,
    can("iam.jobs.details", "read"),
    wrap((req, res) => {
      res.json(jobs.listDependencies(db, req.params.id, jobScope(req)));
    })
  );

  app.post(
    "/api/jobs/:id/dependencies",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      const dependencies = req.body?.dependencies || req.body?.depends_on || [];
      res.status(201).json({ items: jobs.addDependencies(db, job.id, dependencies, { actor: req.actor, ip: clientIp(req) }) });
    })
  );

  app.delete(
    "/api/jobs/:id/dependencies/:dependsOnId",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      res.json(jobs.removeDependency(db, job.id, req.params.dependsOnId, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/progress",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      res.json(jobs.updateProgress(db, req.params.id, req.body || {}, { tenantId: jobScope(req), actor: req.actor }));
    })
  );

  app.post(
    "/api/jobs/:id/cancel",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      res.json(jobs.cancelJob(db, req.params.id, { tenantId: jobScope(req), reason: req.body?.reason, actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/retry",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      res.json(jobs.retryJob(db, req.params.id, { tenantId: jobScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/pause",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      res.json(jobs.pauseJob(db, req.params.id, { tenantId: jobScope(req), reason: req.body?.reason, actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.post(
    "/api/jobs/:id/resume",
    auth,
    can("iam.jobs.control", "execute"),
    wrap((req, res) => {
      res.json(jobs.resumeJob(db, req.params.id, { tenantId: jobScope(req), actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id/result",
    auth,
    can("iam.jobs.results", "read"),
    wrap((req, res) => {
      const job = jobs.getJobRow(db, req.params.id, jobScope(req));
      res.json(jobs.resultPayload(db, job));
    })
  );

  app.post(
    "/api/jobs/:id/result",
    auth,
    can("iam.jobs.results", "create"),
    wrap((req, res) => {
      const job = jobs.getJobRow(db, req.params.id, jobScope(req));
      res.json(jobs.setJobResult(db, job, req.body || {}, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/jobs/:id/artifacts",
    auth,
    can("iam.jobs.results", "read"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      res.json({ items: jobs.listArtifacts(db, job.id) });
    })
  );

  app.post(
    "/api/jobs/:id/artifacts",
    auth,
    can("iam.jobs.results", "create"),
    wrap((req, res) => {
      const job = jobs.getJob(db, req.params.id, jobScope(req));
      res.status(201).json(jobs.addArtifact(db, job.id, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/jobs/:id/children",
    auth,
    can("iam.jobs.details", "read"),
    wrap((req, res) => {
      res.json({ items: jobs.listChildren(db, req.params.id, jobScope(req)) });
    })
  );

  // ── Job Scheduling & Execution Engine ─────────────────────────────────────
  // Queue administration, schedule administration and execution observability.
  // The engine owns execution; these routes expose configuration and control.
  function execScope(req) {
    if (tenants.isPlatformAdmin(db, req.actor.id) && req.query.all === "true") return null;
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
    auth,
    can("iam.jobs.queues", "read"),
    wrap((req, res) => {
      res.json(jobExecution.listQueues(db, req.query, execScope(req)));
    })
  );

  app.post(
    "/api/job-queues",
    auth,
    can("iam.jobs.queues", "create"),
    wrap((req, res) => {
      res.status(201).json(jobExecution.createQueue(db, req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/job-queues/:id/health",
    auth,
    can("iam.jobs.queues", "read"),
    wrap((req, res) => {
      res.json(jobExecution.queueHealth(db, req.params.id));
    })
  );

  app.get(
    "/api/job-queues/:id",
    auth,
    can("iam.jobs.queues", "read"),
    wrap((req, res) => {
      res.json(jobExecution.getQueue(db, req.params.id));
    })
  );

  const updateQueueHandler = (req, res) => {
    res.json(jobExecution.updateQueue(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
  };
  app.put("/api/job-queues/:id", auth, can("iam.jobs.queues", "update"), wrap(updateQueueHandler));
  app.patch("/api/job-queues/:id", auth, can("iam.jobs.queues", "update"), wrap(updateQueueHandler));

  app.post(
    "/api/job-queues/:id/status",
    auth,
    can("iam.jobs.queues", "update"),
    wrap((req, res) => {
      const body = req.body || {};
      if (body.paused !== undefined) {
        res.json(jobExecution.setQueuePaused(db, req.params.id, body.paused !== false, req.actor, clientIp(req)));
      } else {
        res.json(jobExecution.setQueueEnabled(db, req.params.id, body.enabled !== false, req.actor, clientIp(req)));
      }
    })
  );

  // ── Schedules ──
  app.get(
    "/api/schedules",
    auth,
    can("iam.jobs.schedules", "read"),
    wrap((req, res) => {
      res.json(jobExecution.listSchedules(db, req.query, execScope(req)));
    })
  );

  app.post(
    "/api/schedules",
    auth,
    can("iam.jobs.schedules", "create"),
    wrap((req, res) => {
      res.status(201).json(jobExecution.createSchedule(db, { ...(req.body || {}), tenant_id: req.tenantId }, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/schedules/:id",
    auth,
    can("iam.jobs.schedules", "read"),
    wrap((req, res) => {
      res.json(jobExecution.getSchedule(db, req.params.id, execScope(req)));
    })
  );

  const updateScheduleHandler = (req, res) => {
    res.json(jobExecution.updateSchedule(db, req.params.id, req.body || {}, req.actor, clientIp(req)));
  };
  app.put("/api/schedules/:id", auth, can("iam.jobs.schedules", "update"), wrap(updateScheduleHandler));
  app.patch("/api/schedules/:id", auth, can("iam.jobs.schedules", "update"), wrap(updateScheduleHandler));

  app.post(
    "/api/schedules/:id/enable",
    auth,
    can("iam.jobs.schedules", "update"),
    wrap((req, res) => {
      res.json(jobExecution.setScheduleEnabled(db, req.params.id, true, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/disable",
    auth,
    can("iam.jobs.schedules", "update"),
    wrap((req, res) => {
      res.json(jobExecution.setScheduleEnabled(db, req.params.id, false, req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/pause",
    auth,
    can("iam.jobs.schedules", "update"),
    wrap((req, res) => {
      res.json(jobExecution.setScheduleStatus(db, req.params.id, "paused", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/resume",
    auth,
    can("iam.jobs.schedules", "update"),
    wrap((req, res) => {
      res.json(jobExecution.setScheduleStatus(db, req.params.id, "active", req.actor, clientIp(req)));
    })
  );

  app.post(
    "/api/schedules/:id/run-now",
    auth,
    can("iam.jobs.schedules", "execute"),
    wrap((req, res) => {
      res.status(202).json(jobExecution.runScheduleNow(db, req.params.id, { actor: req.actor, ip: clientIp(req) }));
    })
  );

  app.get(
    "/api/schedules/:id/runs",
    auth,
    can("iam.jobs.schedules", "read"),
    wrap((req, res) => {
      res.json(jobExecution.listScheduleRuns(db, req.params.id, req.query));
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
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(files.fileMetrics(db, req.actor, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/metrics/storage",
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(files.storageBreakdown(db, req.actor, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/metrics/processing",
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(files.processingSummary(db, req.actor, fileTenant(req)));
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
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(files.fileFacets(db, req.query, req.actor, fileTenant(req)));
    })
  );

  // File ACL administration.
  app.get(
    "/api/files/permissions",
    auth,
    can("iam.files.permissions", "read"),
    wrap((req, res) => {
      res.json(files.listPermissions(db, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/permissions",
    auth,
    can("iam.files.permissions", "create"),
    wrap((req, res) => {
      res.status(201).json(files.grantPermission(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.delete(
    "/api/files/permissions/:id",
    auth,
    can("iam.files.permissions", "delete"),
    wrap((req, res) => {
      res.json(files.revokePermission(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // Associations by business object (the file-side view lives under /api/files/:ref).
  app.get(
    "/api/file-associations",
    auth,
    can("iam.files.associations", "read"),
    wrap((req, res) => {
      if (req.query.businessObjectType || req.query.business_object_type) {
        return res.json(
          files.listObjectAssociations(
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
      res.json(files.listAssociations(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.patch(
    "/api/file-associations/:id",
    auth,
    can("iam.files.associations", "update"),
    wrap((req, res) => {
      res.json(files.updateAssociation(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.delete(
    "/api/file-associations/:id",
    auth,
    can("iam.files.associations", "delete"),
    wrap((req, res) => {
      res.json(files.removeAssociation(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Uploads (single, multipart/chunked, resumable) ──
  app.get(
    "/api/files/uploads",
    auth,
    can("iam.files.uploads", "read"),
    wrap((req, res) => {
      res.json(files.listUploads(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/uploads",
    auth,
    can("iam.files.uploads", "create"),
    wrap((req, res) => {
      res.status(201).json(files.initiateUpload(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/files/uploads/:uploadId",
    auth,
    can("iam.files.uploads", "read"),
    wrap((req, res) => {
      res.json(files.getUpload(db, req.params.uploadId, req.actor, fileTenant(req)));
    })
  );

  app.put(
    "/api/files/uploads/:uploadId/chunks/:index",
    auth,
    can("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64");
      res.json(await files.uploadChunk(db, req.params.uploadId, req.params.index, buffer, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/uploads/:uploadId/complete",
    auth,
    can("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const payload = Buffer.isBuffer(req.body) ? { buffer: req.body } : (req.body || {});
      res.json(await files.completeUpload(db, req.params.uploadId, payload, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/uploads/:uploadId/abort",
    auth,
    can("iam.files.uploads", "create"),
    wrap((req, res) => {
      res.json(files.abortUpload(db, req.params.uploadId, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // Convenience: initiate + complete a single-shot upload in one request.
  app.post(
    "/api/files/upload",
    auth,
    can("iam.files.uploads", "create"),
    rawBody,
    wrap(async (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64");
      const name = req.query.name || req.headers["x-file-name"] || req.body?.name || "upload.bin";
      const initiated = files.initiateUpload(
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
        await files.completeUpload(
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
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.listFolders(db, req.query, fileTenant(req)));
    })
  );

  app.get(
    "/api/folders/tree",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.folderTree(db, fileTenant(req), { rootId: req.query.rootId }));
    })
  );

  app.post(
    "/api/folders",
    auth,
    can("iam.files.folders", "create"),
    wrap((req, res) => {
      res.status(201).json(files.createFolder(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/folders/:id/breadcrumb",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.folderBreadcrumb(db, req.params.id, fileTenant(req)));
    })
  );

  app.get(
    "/api/folders/:id/files",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.listFolderFiles(db, req.params.id, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/folders/:id/files",
    auth,
    can("iam.files.folders", "update"),
    wrap((req, res) => {
      res.json(
        files.moveFilesToFolder(
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
    auth,
    can("iam.files.folders", "update"),
    wrap((req, res) => {
      res.json(files.removeFileFromFolder(db, req.params.id, req.params.fileId, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/folders/:id",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.getFolder(db, req.params.id, fileTenant(req)));
    })
  );

  const updateFolderHandler = (req, res) => {
    res.json(files.updateFolder(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/folders/:id", auth, can("iam.files.folders", "update"), wrap(updateFolderHandler));
  app.patch("/api/folders/:id", auth, can("iam.files.folders", "update"), wrap(updateFolderHandler));

  app.delete(
    "/api/folders/:id",
    auth,
    can("iam.files.folders", "delete"),
    wrap((req, res) => {
      res.json(
        files.deleteFolder(
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
    auth,
    can("iam.files.folders", "update"),
    wrap((req, res) => {
      res.json(files.restoreFolder(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Collections ──
  app.get(
    "/api/file-collections",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.listCollections(db, req.query, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/file-collections",
    auth,
    can("iam.files.folders", "create"),
    wrap((req, res) => {
      res.status(201).json(files.createCollection(db, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/file-collections/:id",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      res.json(files.getCollection(db, req.params.id, req.actor, fileTenant(req)));
    })
  );

  const updateCollectionHandler = (req, res) => {
    res.json(files.updateCollection(db, req.params.id, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/file-collections/:id", auth, can("iam.files.folders", "update"), wrap(updateCollectionHandler));
  app.patch("/api/file-collections/:id", auth, can("iam.files.folders", "update"), wrap(updateCollectionHandler));

  app.delete(
    "/api/file-collections/:id",
    auth,
    can("iam.files.folders", "delete"),
    wrap((req, res) => {
      res.json(files.deleteCollection(db, req.params.id, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/file-collections/:id/members",
    auth,
    can("iam.files.associations", "create"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        files.addCollectionMembers(
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
    auth,
    can("iam.files.associations", "delete"),
    wrap((req, res) => {
      res.json(files.removeCollectionMember(db, req.params.id, req.params.fileId, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // ── Files (definitions after the more specific /api/files/* routes above) ──
  app.get(
    "/api/files",
    auth,
    can("iam.files.browser", "read"),
    wrap((req, res) => {
      res.json(
        files.listFiles(db, req.query, req.actor, fileTenant(req), { platformAll: filePlatformAll(req) })
      );
    })
  );

  app.get(
    "/api/files/:reference",
    auth,
    can("iam.files.details", "read"),
    wrap((req, res) => {
      res.json(files.getFile(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  const updateFileHandler = (req, res) => {
    res.json(files.updateFileMetadata(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
  };
  app.put("/api/files/:reference", auth, can("iam.files.details", "update"), wrap(updateFileHandler));
  app.patch("/api/files/:reference", auth, can("iam.files.details", "update"), wrap(updateFileHandler));

  app.delete(
    "/api/files/:reference",
    auth,
    can("iam.files.details", "delete"),
    wrap((req, res) => {
      res.json(files.deleteFile(db, req.params.reference, req.body || req.query || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/restore",
    auth,
    can("iam.files.details", "update"),
    wrap((req, res) => {
      res.json(files.restoreFile(db, req.params.reference, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/move",
    auth,
    can("iam.files.details", "update"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        files.moveFile(db, req.params.reference, body.folder_id ?? body.folderId ?? null, req.actor, fileTenant(req), clientIp(req))
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
    auth,
    can("iam.files.permissions", "read"),
    wrap((req, res) => {
      const file = files.getFile(db, req.params.reference, req.actor, fileTenant(req)).file;
      res.json(files.listPermissions(db, { resourceType: "file", resourceId: file.id }, fileTenant(req)));
    })
  );

  app.get(
    "/api/files/:reference/processing",
    auth,
    can("iam.files.details", "read"),
    wrap((req, res) => {
      res.json(files.getProcessingStatus(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/processing/requeue",
    auth,
    can("iam.files.details", "update"),
    wrap(async (req, res) => {
      res.json(
        await files.requeueProcessing(
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
    auth,
    can("iam.files.versions", "read"),
    wrap((req, res) => {
      res.json(files.listVersions(db, req.params.reference, req.query, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/versions",
    auth,
    can("iam.files.versions", "create"),
    wrap(async (req, res) => {
      res.status(201).json(
        await files.createVersion(
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
    auth,
    can("iam.files.versions", "read"),
    wrap((req, res) => {
      res.json(files.getVersion(db, req.params.reference, req.params.version, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/versions/:version/restore",
    auth,
    can("iam.files.versions", "create"),
    wrap(async (req, res) => {
      res.status(201).json(
        await files.restoreVersion(
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
    auth,
    can("iam.files.details", "read"),
    wrap((req, res) => {
      res.json(fileDownloadResponse(files.versionDownload(db, req.params.reference, req.params.version, req.actor, fileTenant(req))));
    })
  );

  app.get(
    "/api/files/:reference/download",
    auth,
    can("iam.files.details", "read"),
    wrap((req, res) => {
      res.json(fileDownloadResponse(files.versionDownload(db, req.params.reference, null, req.actor, fileTenant(req))));
    })
  );

  // Check-out / check-in / locks.
  app.get(
    "/api/files/:reference/lock",
    auth,
    can("iam.files.locks", "read"),
    wrap((req, res) => {
      res.json(files.getLock(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/checkout",
    auth,
    can("iam.files.locks", "execute"),
    wrap((req, res) => {
      res.status(201).json(files.checkOutFile(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/checkin",
    auth,
    can("iam.files.locks", "execute"),
    wrap(async (req, res) => {
      res.json(await files.checkInFile(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/lock/release",
    auth,
    can("iam.files.locks", "execute"),
    wrap((req, res) => {
      res.json(files.releaseLock(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/files/:reference/lock/force-release",
    auth,
    can("iam.files.locks", "execute"),
    wrap((req, res) => {
      res.json(files.forceReleaseLock(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  // File associations.
  app.get(
    "/api/files/:reference/associations",
    auth,
    can("iam.files.associations", "read"),
    wrap((req, res) => {
      res.json(files.listFileAssociations(db, req.params.reference, req.actor, fileTenant(req)));
    })
  );

  app.post(
    "/api/files/:reference/associations",
    auth,
    can("iam.files.associations", "create"),
    wrap((req, res) => {
      res.status(201).json(files.createAssociation(db, req.params.reference, req.body || {}, req.actor, fileTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/files/:reference/collections",
    auth,
    can("iam.files.folders", "read"),
    wrap((req, res) => {
      const file = files.getFile(db, req.params.reference, req.actor, fileTenant(req)).file;
      res.json(files.listCollectionsForFile(db, file.id, req.actor, fileTenant(req)));
    })
  );

  // Locks (tenant-wide view).
  app.get(
    "/api/file-locks",
    auth,
    can("iam.files.locks", "read"),
    wrap((req, res) => {
      res.json(files.listLocks(db, req.query, req.actor, fileTenant(req)));
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
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json({
        ...search.vocabulary,
        providers: search.listSearchProviders(),
        object_types: search.searchableObjectTypes(db, searchTenant(req)),
        configuration: search.getConfiguration(db, searchTenant(req)),
      });
    })
  );

  app.post(
    "/api/search",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.search(db, req.body || {}, req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.search(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/suggestions",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getSuggestions(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/facets",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getFacets(db, searchInput(req), req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.post(
    "/api/search/advanced",
    auth,
    can("iam.search.advanced", "read"),
    wrap((req, res) => {
      res.json(search.advancedSearch(db, req.body || {}, req.actor, { tenantId: searchTenant(req) }));
    })
  );

  app.post(
    "/api/search/by-type/:objectType",
    auth,
    can("iam.search.advanced", "read"),
    wrap((req, res) => {
      res.json(
        search.searchByType(db, req.params.objectType, req.body || {}, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  app.post(
    "/api/search/by-attributes",
    auth,
    can("iam.search.advanced", "read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        search.searchByAttributes(db, body.attributes || {}, body, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  app.post(
    "/api/search/by-relationship",
    auth,
    can("iam.search.advanced", "read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        search.searchByRelationship(db, body.related_to || body.relatedTo || {}, body, req.actor, {
          tenantId: searchTenant(req),
        })
      );
    })
  );

  // ── Saved searches ──
  app.get(
    "/api/search/saved",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json({
        items: search.listSavedSearches(db, {
          tenantId: searchTenant(req),
          actorId: req.actor.id,
          includeShared: req.query.include_shared !== "false",
        }),
      });
    })
  );

  app.post(
    "/api/search/saved",
    auth,
    can("iam.search.saved", "create"),
    wrap((req, res) => {
      res.status(201).json(search.createSavedSearch(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/saved/:reference",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json(search.getSavedSearch(db, req.params.reference, req.actor, searchTenant(req)));
    })
  );

  app.patch(
    "/api/search/saved/:reference",
    auth,
    can("iam.search.saved", "update"),
    wrap((req, res) => {
      res.json(
        search.updateSavedSearch(db, req.params.reference, req.body || {}, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  app.delete(
    "/api/search/saved/:reference",
    auth,
    can("iam.search.saved", "delete"),
    wrap((req, res) => {
      res.json(search.deleteSavedSearch(db, req.params.reference, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/search/saved/:reference/run",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json(
        search.runSavedSearch(db, req.params.reference, req.body || {}, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  // ── Search history ──
  app.get(
    "/api/search/history",
    auth,
    can("iam.search.history", "read"),
    wrap((req, res) => {
      res.json({
        items: search.listSearchHistory(db, {
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
    auth,
    can("iam.search.history", "delete"),
    wrap((req, res) => {
      res.json(search.clearSearchHistory(db, req.actor, searchTenant(req), { all: req.query.all === "true" }));
    })
  );

  app.delete(
    "/api/search/history/:id",
    auth,
    can("iam.search.history", "delete"),
    wrap((req, res) => {
      res.json(search.deleteSearchHistoryEntry(db, req.params.id, req.actor, searchTenant(req)));
    })
  );

  // ── Exports ──
  app.get(
    "/api/search/exports",
    auth,
    can("iam.search.export", "read"),
    wrap((req, res) => {
      res.json({
        items: search.listExports(db, {
          tenantId: searchTenant(req),
          actorId: req.query.all === "true" ? null : req.actor.id,
          limit: req.query.limit,
        }),
      });
    })
  );

  app.post(
    "/api/search/exports",
    auth,
    can("iam.search.export", "create"),
    wrap((req, res) => {
      res.status(201).json(search.requestExport(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/exports/:reference",
    auth,
    can("iam.search.export", "read"),
    wrap((req, res) => {
      res.json(search.getExport(db, req.params.reference, req.actor, searchTenant(req)));
    })
  );

  app.get(
    "/api/search/exports/:reference/download",
    auth,
    can("iam.search.export", "read"),
    wrap((req, res) => {
      const result = search.getExport(db, req.params.reference, req.actor, searchTenant(req), {
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
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json({
        items: search.listObjectTypes(db, {
          tenantId: searchTenant(req),
          includeDisabled: req.query.include_disabled === "true",
        }),
      });
    })
  );

  app.post(
    "/api/search/object-types",
    auth,
    can("iam.search.indexes", "create"),
    wrap((req, res) => {
      res.status(201).json(search.registerObjectType(db, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/object-types/:code",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(search.getObjectType(db, req.params.code, searchTenant(req)));
    })
  );

  app.patch(
    "/api/search/object-types/:code",
    auth,
    can("iam.search.indexes", "update"),
    wrap((req, res) => {
      res.json(search.updateObjectType(db, req.params.code, req.body || {}, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.post(
    "/api/search/object-types/:code/status",
    auth,
    can("iam.search.indexes", "update"),
    wrap((req, res) => {
      res.json(
        search.setObjectTypeStatus(db, req.params.code, req.body?.status, req.actor, searchTenant(req), clientIp(req))
      );
    })
  );

  app.delete(
    "/api/search/object-types/:code",
    auth,
    can("iam.search.indexes", "delete"),
    wrap((req, res) => {
      res.json(search.deleteObjectType(db, req.params.code, req.actor, searchTenant(req), clientIp(req)));
    })
  );

  app.get(
    "/api/search/indexes/status",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(search.indexingStatus(db, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/indexes/failures",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json({ items: search.listIndexFailures(db, { tenantId: searchTenant(req), limit: req.query.limit }) });
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
    auth,
    can("iam.search.configuration", "read"),
    wrap((req, res) => {
      res.json(search.getConfiguration(db, searchTenant(req)));
    })
  );

  app.put(
    "/api/search/configuration",
    auth,
    can("iam.search.configuration", "update"),
    wrap((req, res) => {
      res.json(search.updateConfiguration(db, searchTenant(req), req.body || {}, req.actor, clientIp(req)));
    })
  );

  app.get(
    "/api/search/metrics",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(search.searchMetrics(db, { tenantId: searchTenant(req) }));
    })
  );

  app.get(
    "/api/search/health",
    auth,
    can("iam.search.indexes", "read"),
    wrap((_req, res) => {
      res.json(search.searchHealth(db));
    })
  );

  // ── Search & Discovery (versioned canonical API, /api/v1/search) ──────────
  // Provider-independent Enterprise Search Foundation surface. The canonical
  // contract never exposes SQLite/provider syntax to callers.
  const v1SearchTenant = (req) => searchTenant(req);
  const v1SearchInput = (req) => (req.method === "GET" ? { ...req.query } : { ...(req.body || {}) });

  app.get(
    "/api/v1/search/meta",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getMeta(db, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.post(
    "/api/v1/search",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.searchObjects(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
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
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.countObjects(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.post(
    "/api/v1/search/bulk",
    auth,
    can("iam.search.advanced", "read"),
    wrap((req, res) => {
      res.json(search.bulkSearch(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/objects",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(
        search.listSearchObjects(db, req.actor, {
          tenantId: v1SearchTenant(req),
          includeDisabled: req.query.include_disabled === "true",
        })
      );
    })
  );

  app.get(
    "/api/v1/search/objects/:objectType",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getSearchObject(db, req.params.objectType, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/facets",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getObjectFacets(db, v1SearchInput(req), req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/suggestions",
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(search.getObjectSuggestions(db, v1SearchInput(req), req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/history",
    auth,
    can("iam.search.history", "read"),
    wrap((req, res) => {
      res.json(
        search.getHistory(db, req.actor, {
          tenantId: v1SearchTenant(req),
          limit: req.query.limit,
          q: req.query.q,
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/history",
    auth,
    can("iam.search.history", "delete"),
    wrap((req, res) => {
      res.json(
        search.clearHistory(db, req.actor, {
          tenantId: v1SearchTenant(req),
          all: req.query.all === "true",
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/history/:id",
    auth,
    can("iam.search.history", "delete"),
    wrap((req, res) => {
      res.json(search.removeHistoryEntry(db, req.params.id, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.get(
    "/api/v1/search/saved",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json(
        search.listSaved(db, req.actor, {
          tenantId: v1SearchTenant(req),
          includeShared: req.query.include_shared !== "false",
        })
      );
    })
  );

  app.post(
    "/api/v1/search/saved",
    auth,
    can("iam.search.saved", "create"),
    wrap((req, res) => {
      res.status(201).json(
        search.createSaved(db, req.body || {}, req.actor, { tenantId: v1SearchTenant(req), ip: clientIp(req) })
      );
    })
  );

  app.get(
    "/api/v1/search/saved/:reference",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json(search.getSaved(db, req.params.reference, req.actor, { tenantId: v1SearchTenant(req) }));
    })
  );

  app.put(
    "/api/v1/search/saved/:reference",
    auth,
    can("iam.search.saved", "update"),
    wrap((req, res) => {
      res.json(
        search.updateSaved(db, req.params.reference, req.body || {}, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.delete(
    "/api/v1/search/saved/:reference",
    auth,
    can("iam.search.saved", "delete"),
    wrap((req, res) => {
      res.json(
        search.removeSaved(db, req.params.reference, req.actor, {
          tenantId: v1SearchTenant(req),
          ip: clientIp(req),
        })
      );
    })
  );

  app.post(
    "/api/v1/search/saved/:reference/execute",
    auth,
    can("iam.search.saved", "read"),
    wrap((req, res) => {
      res.json(
        search.runSaved(db, req.params.reference, req.body || {}, req.actor, {
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
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(
        search.getIndexStatus(db, req.actor, {
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
    auth,
    can("iam.search.configuration", "read"),
    wrap((req, res) => {
      res.json(
        search.listFields(db, req.actor, {
          tenantId: v1SearchTenant(req),
          objectType: req.query.object_type || req.query.objectType,
        })
      );
    })
  );

  app.post(
    "/api/v1/search/fields",
    auth,
    can("iam.search.configuration", "update"),
    wrap((req, res) => {
      res
        .status(201)
        .json(
          search.createField(db, req.body || {}, req.actor, {
            tenantId: v1SearchTenant(req),
            ip: clientIp(req),
          })
        );
    })
  );

  app.delete(
    "/api/v1/search/fields/:objectType/:field",
    auth,
    can("iam.search.configuration", "update"),
    wrap((req, res) => {
      res.json(
        search.removeField(db, req.params.objectType, req.params.field, req.actor, {
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
    auth,
    can("iam.search.global", "read"),
    wrap((req, res) => {
      res.json(
        search.getObjectExtractedText(db, req.actor, {
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
    auth,
    can("iam.search.indexes", "read"),
    wrap((_req, res) => {
      res.json(search.getHealth(db));
    })
  );

  app.get(
    "/api/v1/search/metrics",
    auth,
    can("iam.search.indexes", "read"),
    wrap((req, res) => {
      res.json(search.getMetrics(db, req.actor, { tenantId: v1SearchTenant(req) }));
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
    auth,
    can("iam.security.console", "read"),
    wrap((req, res) => res.json(security.securityOverview(db, securityTenant(req))))
  );

  app.post(
    "/api/v1/security/cache/invalidate",
    auth,
    can("iam.security.console", "execute"),
    wrap((req, res) => {
      security.invalidateSecurity(db, securityTenant(req), req.body?.scope || "all");
      res.json({ ok: true });
    })
  );

  // Object type registration
  app.get(
    "/api/v1/security/object-types",
    auth,
    can("iam.security.objecttypes", "read"),
    wrap((req, res) => res.json(security.listSecurityObjectTypes(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/object-types",
    auth,
    can("iam.security.objecttypes", "create"),
    wrap((req, res) =>
      res
        .status(201)
        .json(security.registerSecurityObjectType(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/object-types/:objectType",
    auth,
    can("iam.security.objecttypes", "update"),
    wrap((req, res) =>
      res.json(
        security.updateSecurityObjectType(
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
    auth,
    can("iam.security.objecttypes", "update"),
    wrap((req, res) =>
      res.json(
        security.setSecurityObjectTypeStatus(
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
    auth,
    can("iam.security.policies", "read"),
    wrap((req, res) => res.json(security.listSecurityPolicies(db, securityTenant(req), req.query || {})))
  );
  app.get(
    "/api/v1/security/policies/:id",
    auth,
    can("iam.security.policies", "read"),
    wrap((req, res) => res.json(security.getSecurityPolicy(db, securityTenant(req), req.params.id)))
  );
  app.post(
    "/api/v1/security/policies",
    auth,
    can("iam.security.policies", "create"),
    wrap((req, res) =>
      res.status(201).json(security.createSecurityPolicy(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/policies/:id",
    auth,
    can("iam.security.policies", "update"),
    wrap((req, res) =>
      res.json(security.updateSecurityPolicy(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/policies/:id/status",
    auth,
    can("iam.security.policies", "update"),
    wrap((req, res) =>
      res.json(security.setSecurityPolicyStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Entitlements
  app.get(
    "/api/v1/security/entitlements",
    auth,
    can("iam.security.entitlements", "read"),
    wrap((req, res) => res.json(security.listSecurityEntitlements(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/entitlements",
    auth,
    can("iam.security.entitlements", "create"),
    wrap((req, res) =>
      res.status(201).json(security.createSecurityEntitlement(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/entitlements/:id",
    auth,
    can("iam.security.entitlements", "update"),
    wrap((req, res) =>
      res.json(security.updateSecurityEntitlement(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/entitlements/:id/status",
    auth,
    can("iam.security.entitlements", "update"),
    wrap((req, res) =>
      res.json(security.setSecurityEntitlementStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Field security & masking
  app.get(
    "/api/v1/security/field-rules",
    auth,
    can("iam.security.fields", "read"),
    wrap((req, res) => res.json(security.listSecurityFieldRules(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/field-rules",
    auth,
    can("iam.security.fields", "create"),
    wrap((req, res) =>
      res.status(201).json(security.createSecurityFieldRule(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/security/field-rules/:id",
    auth,
    can("iam.security.fields", "update"),
    wrap((req, res) =>
      res.json(security.updateSecurityFieldRule(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/field-rules/:id/status",
    auth,
    can("iam.security.fields", "update"),
    wrap((req, res) =>
      res.json(security.setSecurityFieldRuleStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );
  app.get(
    "/api/v1/security/masking-rules",
    auth,
    can("iam.security.fields", "read"),
    wrap((req, res) => res.json(security.listSecurityMaskingRules(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/masking-rules",
    auth,
    can("iam.security.fields", "create"),
    wrap((req, res) =>
      res.status(201).json(security.createSecurityMaskingRule(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/masking-rules/:id/status",
    auth,
    can("iam.security.fields", "update"),
    wrap((req, res) =>
      res.json(security.setSecurityMaskingRuleStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req)))
    )
  );

  // Classification security
  app.get(
    "/api/v1/security/classification-rules",
    auth,
    can("iam.security.classifications", "read"),
    wrap((req, res) => res.json(security.listSecurityClassificationRules(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/classification-rules",
    auth,
    can("iam.security.classifications", "create"),
    wrap((req, res) =>
      res
        .status(201)
        .json(security.createSecurityClassificationRule(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/classification-rules/:id/status",
    auth,
    can("iam.security.classifications", "update"),
    wrap((req, res) =>
      res.json(
        security.setSecurityClassificationRuleStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );

  // Organization & plant security
  app.get(
    "/api/v1/security/organization-rules",
    auth,
    can("iam.security.organizations", "read"),
    wrap((req, res) => res.json(security.listSecurityOrganizationRules(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/organization-rules",
    auth,
    can("iam.security.organizations", "create"),
    wrap((req, res) =>
      res
        .status(201)
        .json(security.createSecurityOrganizationRule(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/organization-rules/:id/status",
    auth,
    can("iam.security.organizations", "update"),
    wrap((req, res) =>
      res.json(
        security.setSecurityOrganizationRuleStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );
  app.get(
    "/api/v1/security/plant-rules",
    auth,
    can("iam.security.organizations", "read"),
    wrap((req, res) => res.json(security.listSecurityPlantRules(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/security/plant-rules",
    auth,
    can("iam.security.organizations", "create"),
    wrap((req, res) =>
      res.status(201).json(security.createSecurityPlantRule(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.post(
    "/api/v1/security/plant-rules/:id/status",
    auth,
    can("iam.security.organizations", "update"),
    wrap((req, res) =>
      res.json(
        security.setSecurityPlantRuleStatus(db, securityTenant(req), req.params.id, req.body?.status, req.actor, clientIp(req))
      )
    )
  );

  // Authorization debugger
  app.get(
    "/api/v1/security/decisions",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) => res.json(security.listSecurityDecisions(db, securityTenant(req), req.query || {})))
  );
  app.get(
    "/api/v1/security/context/:userId",
    auth,
    can("iam.security.decisions", "read"),
    wrap((req, res) =>
      res.json(security.effectiveSecurityContext(db, securityTenant(req), req.params.userId, { organizationId: req.query.organization_id }))
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
    auth,
    can("iam.security.entitlements", "read"),
    wrap((req, res) => res.json(security.listSecurityEntitlements(db, securityTenant(req), req.query || {})))
  );
  app.post(
    "/api/v1/entitlements",
    auth,
    can("iam.security.entitlements", "create"),
    wrap((req, res) =>
      res
        .status(201)
        .json(security.createSecurityEntitlement(db, req.body || {}, req.actor, securityTenant(req), clientIp(req)))
    )
  );
  app.put(
    "/api/v1/entitlements/:id",
    auth,
    can("iam.security.entitlements", "update"),
    wrap((req, res) =>
      res.json(security.updateSecurityEntitlement(db, securityTenant(req), req.params.id, req.body || {}, req.actor, clientIp(req)))
    )
  );

  // ── Integration & API Framework ───────────────────────────────────────────
  const integrationTenant = (req) => req.tenantId ?? null;
  const canIntegrations = (action) => can("iam.integration", action);
  const canIntSystems = (action) => can("iam.integration.systems", action);
  const canIntEndpoints = (action) => can("iam.integration.endpoints", action);
  const canIntTransforms = (action) => can("iam.integration.transforms", action);
  const canIntMappings = (action) => can("iam.integration.mappings", action);
  const canIntSchedules = (action) => can("iam.integration.schedules", action);
  const canIntEvents = (action) => can("iam.integration.events", action);
  const canIntWebhooks = (action) => can("iam.integration.webhooks", action);
  const canIntMessages = (action) => can("iam.integration.messages", action);
  const canIntDeadLetters = (action) => can("iam.integration.deadletters", action);
  const canIntTransfers = (action) => can("iam.integration.transfers", action);
  const canIntMonitoring = (action) => can("iam.integration.monitoring", action);
  const canIntApi = (action) => can("iam.integration.api", action);

  const integrationRouter = express.Router();

  integrationRouter.get(
    "/meta",
    auth,
    canIntegrations("read"),
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
    auth,
    canIntegrations("read"),
    wrap((req, res) => {
      res.json(integration.Definitions.listDefinitions(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/definitions",
    auth,
    canIntegrations("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Definitions.createDefinition(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/definitions/:code",
    auth,
    canIntegrations("read"),
    wrap((req, res) => {
      res.json(integration.Definitions.getDefinition(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/definitions/:code",
    auth,
    canIntegrations("update"),
    wrap((req, res) => {
      res.json(integration.Definitions.updateDefinition(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/definitions/:code/status",
    auth,
    canIntegrations("update"),
    wrap((req, res) => {
      res.json(integration.Definitions.setDefinitionStatus(db, req.params.code, req.body?.status, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/definitions/:code",
    auth,
    canIntegrations("delete"),
    wrap((req, res) => {
      res.json(integration.Definitions.deleteDefinition(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/definitions/:code/versions",
    auth,
    canIntegrations("read"),
    wrap((req, res) => {
      res.json(integration.Definitions.listDefinitionVersions(db, req.params.code));
    })
  );
  integrationRouter.post(
    "/definitions/:code/versions/:version/restore",
    auth,
    canIntegrations("update"),
    wrap((req, res) => {
      res.json(integration.Definitions.restoreDefinitionVersion(db, req.params.code, req.params.version, req.actor));
    })
  );
  integrationRouter.post(
    "/definitions/:code/run",
    auth,
    canIntegrations("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const definition = integration.Definitions.getDefinition(db, req.params.code);
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
      const result = await integration.Definitions.executeIntegration(db, req.params.code, {
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
    auth,
    canIntegrations("read"),
    wrap((req, res) => {
      res.json(integration.Definitions.listExecutions(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/executions/:ref",
    auth,
    canIntegrations("read"),
    wrap((req, res) => {
      res.json(integration.Definitions.getExecution(db, req.params.ref));
    })
  );
  integrationRouter.post(
    "/executions/:ref/retry",
    auth,
    canIntegrations("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Definitions.retryExecution(db, req.params.ref, req.actor));
    })
  );
  integrationRouter.post(
    "/executions/:ref/cancel",
    auth,
    canIntegrations("execute"),
    wrap((req, res) => {
      res.json(integration.Definitions.markExecutionCancelled(db, req.params.ref, req.actor));
    })
  );

  // Credentials
  integrationRouter.get(
    "/credentials",
    auth,
    canIntSystems("read"),
    wrap((req, res) => {
      res.json(integration.Systems.listCredentials(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/credentials",
    auth,
    canIntSystems("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Systems.createCredential(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/credentials/:code",
    auth,
    canIntSystems("read"),
    wrap((req, res) => {
      res.json(integration.Systems.getCredential(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/credentials/:code",
    auth,
    canIntSystems("update"),
    wrap((req, res) => {
      res.json(integration.Systems.updateCredential(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/credentials/:code",
    auth,
    canIntSystems("delete"),
    wrap((req, res) => {
      res.json(integration.Systems.deleteCredential(db, req.params.code, req.actor));
    })
  );

  // External systems
  integrationRouter.get(
    "/systems",
    auth,
    canIntSystems("read"),
    wrap((req, res) => {
      res.json(integration.Systems.listExternalSystems(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/systems",
    auth,
    canIntSystems("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Systems.createExternalSystem(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/systems/:code",
    auth,
    canIntSystems("read"),
    wrap((req, res) => {
      res.json(integration.Systems.getExternalSystem(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/systems/:code",
    auth,
    canIntSystems("update"),
    wrap((req, res) => {
      res.json(integration.Systems.updateExternalSystem(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/systems/:code",
    auth,
    canIntSystems("delete"),
    wrap((req, res) => {
      res.json(integration.Systems.deleteExternalSystem(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/systems/:code/test",
    auth,
    canIntSystems("execute"),
    wrap((req, res) => {
      res.json(integration.Systems.testConnection(db, req.params.code, req.actor, clientIp(req)));
    })
  );
  integrationRouter.get(
    "/systems/:code/health",
    auth,
    canIntSystems("read"),
    wrap((req, res) => {
      res.json({ items: integration.Systems.listHealthChecks(db, req.params.code, { limit: req.query.limit }) });
    })
  );

  // Endpoints
  integrationRouter.get(
    "/endpoints",
    auth,
    canIntEndpoints("read"),
    wrap((req, res) => {
      res.json(integration.Endpoints.listEndpoints(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/endpoints",
    auth,
    canIntEndpoints("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Endpoints.createEndpoint(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/endpoints/:code",
    auth,
    canIntEndpoints("read"),
    wrap((req, res) => {
      res.json(integration.Endpoints.getEndpoint(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/endpoints/:code",
    auth,
    canIntEndpoints("update"),
    wrap((req, res) => {
      res.json(integration.Endpoints.updateEndpoint(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/endpoints/:code",
    auth,
    canIntEndpoints("delete"),
    wrap((req, res) => {
      res.json(integration.Endpoints.deleteEndpoint(db, req.params.code, req.actor));
    })
  );

  // Transformations
  integrationRouter.get(
    "/transformations",
    auth,
    canIntTransforms("read"),
    wrap((req, res) => {
      res.json(integration.Transform.listTransformations(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/transformations",
    auth,
    canIntTransforms("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Transform.createTransformation(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/transformations/:code",
    auth,
    canIntTransforms("read"),
    wrap((req, res) => {
      res.json(integration.Transform.getTransformation(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/transformations/:code",
    auth,
    canIntTransforms("update"),
    wrap((req, res) => {
      res.json(integration.Transform.updateTransformation(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/transformations/:code",
    auth,
    canIntTransforms("delete"),
    wrap((req, res) => {
      res.json(integration.Transform.deleteTransformation(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/transformations/:code/test",
    auth,
    canIntTransforms("execute"),
    wrap((req, res) => {
      res.json(integration.Transform.testTransformation(db, req.params.code, req.body || {}, req.actor));
    })
  );

  // External object mappings
  integrationRouter.get(
    "/mappings/stats",
    auth,
    canIntMappings("read"),
    wrap((req, res) => {
      res.json(integration.Mappings.mappingStats(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/mappings",
    auth,
    canIntMappings("read"),
    wrap((req, res) => {
      res.json(integration.Mappings.listMappings(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/mappings",
    auth,
    canIntMappings("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Mappings.upsertMapping(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/mappings/:id",
    auth,
    canIntMappings("read"),
    wrap((req, res) => {
      res.json(integration.Mappings.getMapping(db, req.params.id));
    })
  );
  integrationRouter.patch(
    "/mappings/:id",
    auth,
    canIntMappings("update"),
    wrap((req, res) => {
      res.json(integration.Mappings.updateMapping(db, req.params.id, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/mappings/:id",
    auth,
    canIntMappings("delete"),
    wrap((req, res) => {
      res.json(integration.Mappings.deleteMapping(db, req.params.id, req.actor));
    })
  );

  // Schedules
  integrationRouter.get(
    "/schedules",
    auth,
    canIntSchedules("read"),
    wrap((req, res) => {
      res.json(integration.Schedules.listSchedules(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/schedules",
    auth,
    canIntSchedules("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Schedules.createSchedule(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/schedules/:code",
    auth,
    canIntSchedules("read"),
    wrap((req, res) => {
      res.json(integration.Schedules.getSchedule(db, req.params.code, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.patch(
    "/schedules/:code",
    auth,
    canIntSchedules("update"),
    wrap((req, res) => {
      res.json(integration.Schedules.updateSchedule(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/schedules/:code/status",
    auth,
    canIntSchedules("update"),
    wrap((req, res) => {
      res.json(integration.Schedules.setScheduleStatus(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.post(
    "/schedules/:code/run",
    auth,
    canIntSchedules("execute"),
    wrap((req, res) => {
      res.json(integration.Schedules.runScheduleNow(db, req.params.code, req.actor));
    })
  );
  integrationRouter.delete(
    "/schedules/:code",
    auth,
    canIntSchedules("delete"),
    wrap((req, res) => {
      res.json(integration.Schedules.deleteSchedule(db, req.params.code, req.actor));
    })
  );

  // Event types
  integrationRouter.get(
    "/event-types",
    auth,
    canIntEvents("read"),
    wrap((req, res) => {
      res.json(integration.Events.listEventTypes(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/event-types",
    auth,
    canIntEvents("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Events.createEventType(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.patch(
    "/event-types/:code",
    auth,
    canIntEvents("update"),
    wrap((req, res) => {
      res.json(integration.Events.updateEventType(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.delete(
    "/event-types/:code",
    auth,
    canIntEvents("delete"),
    wrap((req, res) => {
      res.json(integration.Events.deleteEventType(db, req.params.code, req.actor));
    })
  );

  // Event subscriptions
  integrationRouter.get(
    "/subscriptions",
    auth,
    canIntEvents("read"),
    wrap((req, res) => {
      res.json(integration.Events.listSubscriptions(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/subscriptions",
    auth,
    canIntEvents("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Events.createSubscription(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.patch(
    "/subscriptions/:code",
    auth,
    canIntEvents("update"),
    wrap((req, res) => {
      res.json(integration.Events.updateSubscription(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/subscriptions/:code/status",
    auth,
    canIntEvents("update"),
    wrap((req, res) => {
      res.json(integration.Events.setSubscriptionStatus(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.delete(
    "/subscriptions/:code",
    auth,
    canIntEvents("delete"),
    wrap((req, res) => {
      res.json(integration.Events.deleteSubscription(db, req.params.code, req.actor));
    })
  );

  // Events
  integrationRouter.get(
    "/events",
    auth,
    canIntEvents("read"),
    wrap((req, res) => {
      res.json(integration.Events.listEvents(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/events",
    auth,
    canIntEvents("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Events.publishEvent(db, { ...(req.body || {}), tenant_id: integrationTenant(req) }, req.actor));
    })
  );
  integrationRouter.get(
    "/events/:ref",
    auth,
    canIntEvents("read"),
    wrap((req, res) => {
      res.json(integration.Events.getEvent(db, req.params.ref, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/events/:ref/replay",
    auth,
    canIntEvents("execute"),
    wrap((req, res) => {
      res.json(integration.Events.replayEvent(db, req.params.ref, req.actor));
    })
  );

  // Event deliveries
  integrationRouter.get(
    "/deliveries",
    auth,
    canIntEvents("read"),
    wrap((req, res) => {
      res.json(integration.Events.listDeliveries(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/deliveries/:id/retry",
    auth,
    canIntEvents("execute"),
    wrap((req, res) => {
      res.json(integration.Events.retryDelivery(db, req.params.id, req.actor));
    })
  );

  // Inbound webhooks
  integrationRouter.get(
    "/webhooks/inbound",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      res.json(integration.Webhooks.listInboundWebhooks(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/webhooks/inbound",
    auth,
    canIntWebhooks("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Webhooks.createInboundWebhook(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/webhooks/inbound/:code",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      res.json(integration.Webhooks.getInboundWebhook(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/webhooks/inbound/:code",
    auth,
    canIntWebhooks("update"),
    wrap((req, res) => {
      res.json(integration.Webhooks.updateInboundWebhook(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/inbound/:code/status",
    auth,
    canIntWebhooks("update"),
    wrap((req, res) => {
      res.json(integration.Webhooks.setInboundWebhookStatus(db, req.params.code, req.body?.status, req.actor));
    })
  );
  integrationRouter.delete(
    "/webhooks/inbound/:code",
    auth,
    canIntWebhooks("delete"),
    wrap((req, res) => {
      res.json(integration.Webhooks.deleteInboundWebhook(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/webhooks/inbound/:code/receipts",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      const endpoint = integration.Webhooks.getInboundWebhook(db, req.params.code);
      res.json(integration.Webhooks.listInboundReceipts(db, { endpointId: endpoint.id, ...req.query }));
    })
  );

  // Outbound webhooks
  integrationRouter.get(
    "/webhooks/outbound",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      res.json(integration.Webhooks.listOutboundWebhooks(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound",
    auth,
    canIntWebhooks("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Webhooks.createOutboundWebhook(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/webhooks/outbound/:code",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      res.json(integration.Webhooks.getOutboundWebhook(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/webhooks/outbound/:code",
    auth,
    canIntWebhooks("update"),
    wrap((req, res) => {
      res.json(integration.Webhooks.updateOutboundWebhook(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound/:code/status",
    auth,
    canIntWebhooks("update"),
    wrap((req, res) => {
      res.json(integration.Webhooks.setOutboundWebhookStatus(db, req.params.code, req.body?.status, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/webhooks/outbound/:code",
    auth,
    canIntWebhooks("delete"),
    wrap((req, res) => {
      res.json(integration.Webhooks.deleteOutboundWebhook(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/webhooks/outbound/:code/test",
    auth,
    canIntWebhooks("execute"),
    wrap(async (req, res) => {
      res.json(await integration.Webhooks.testOutboundWebhook(db, req.params.code));
    })
  );
  integrationRouter.get(
    "/webhooks/outbound/:code/deliveries",
    auth,
    canIntWebhooks("read"),
    wrap((req, res) => {
      const webhook = integration.Webhooks.getOutboundWebhook(db, req.params.code);
      res.json(integration.Webhooks.listOutboundDeliveries(db, { subscriptionId: webhook.id, ...req.query }));
    })
  );

  // Public inbound webhook receiver (authenticated by endpoint signature/API key,
  // not by the session bearer token).
  const receiveWebhook = wrap((req, res) => {
    const body = req.body && Object.keys(req.body).length ? req.body : req.rawBody || {};
    const result = integration.Webhooks.receiveInboundWebhook(db, req.params.code, {
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
    auth,
    canIntMessages("read"),
    wrap((req, res) => {
      res.json({ items: integration.Messages.listQueues(db, { tenantId: integrationTenant(req) }) });
    })
  );
  integrationRouter.get(
    "/messages",
    auth,
    canIntMessages("read"),
    wrap((req, res) => {
      res.json(integration.Messages.listMessages(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/messages",
    auth,
    canIntMessages("create"),
    wrap((req, res) => {
      res.status(201).json(integration.Messages.enqueueMessage(db, { ...(req.body || {}), tenant_id: integrationTenant(req) }, req.actor));
    })
  );
  integrationRouter.get(
    "/messages/:ref",
    auth,
    canIntMessages("read"),
    wrap((req, res) => {
      res.json(integration.Messages.getMessage(db, req.params.ref, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/messages/:ref/retry",
    auth,
    canIntMessages("execute"),
    wrap((req, res) => {
      res.json(integration.Messages.requeueMessage(db, req.params.ref, { resetAttempts: req.body?.reset_attempts === true, actor: req.actor }));
    })
  );
  integrationRouter.post(
    "/messages/:ref/cancel",
    auth,
    canIntMessages("execute"),
    wrap((req, res) => {
      res.json(integration.Messages.cancelMessage(db, req.params.ref, req.actor, req.body?.reason));
    })
  );

  // Dead letters
  integrationRouter.get(
    "/dead-letters/stats",
    auth,
    canIntDeadLetters("read"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.deadLetterStats(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/dead-letters",
    auth,
    canIntDeadLetters("read"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.listDeadLetters(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/dead-letters/bulk-retry",
    auth,
    canIntDeadLetters("execute"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.bulkRetryDeadLetters(db, req.body?.ids || [], req.actor));
    })
  );
  integrationRouter.get(
    "/dead-letters/:id",
    auth,
    canIntDeadLetters("read"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.getDeadLetter(db, req.params.id, { includePayload: req.query.include_payload === "true" }));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/inspect",
    auth,
    canIntDeadLetters("read"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.inspectDeadLetterPayload(db, req.params.id, req.actor));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/retry",
    auth,
    canIntDeadLetters("execute"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.retryDeadLetter(db, req.params.id, req.actor, { resetAttempts: req.body?.reset_attempts !== false }));
    })
  );
  integrationRouter.post(
    "/dead-letters/:id/resolve",
    auth,
    canIntDeadLetters("execute"),
    wrap((req, res) => {
      res.json(integration.DeadLetter.resolveDeadLetter(db, req.params.id, { status: req.body?.status, resolution: req.body?.resolution, actor: req.actor }));
    })
  );

  // Transfers (import/export)
  integrationRouter.get(
    "/transfers/handlers",
    auth,
    canIntTransfers("read"),
    wrap((_req, res) => {
      res.json(integration.Transfers.listTransferHandlers());
    })
  );
  integrationRouter.get(
    "/transfers",
    auth,
    canIntTransfers("read"),
    wrap((req, res) => {
      res.json(integration.Transfers.listTransfers(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/transfers/import/preview",
    auth,
    canIntTransfers("create"),
    wrap((req, res) => {
      res.json(integration.Transfers.previewImport(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.post(
    "/transfers/import",
    auth,
    canIntTransfers("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const transfer = await integration.Transfers.runImportTransfer(db, { ...body, dry_run: true }, req.actor, integrationTenant(req));
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
      res.status(201).json(await integration.Transfers.runImportTransfer(db, body, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.post(
    "/transfers/export",
    auth,
    canIntTransfers("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      if (body.async === true) {
        const transfer = await integration.Transfers.runExportTransfer(db, { ...body, dry_run: true }, req.actor, integrationTenant(req));
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
      res.status(201).json(await integration.Transfers.runExportTransfer(db, body, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/transfers/:ref",
    auth,
    canIntTransfers("read"),
    wrap((req, res) => {
      res.json(integration.Transfers.getTransfer(db, req.params.ref));
    })
  );
  integrationRouter.get(
    "/transfers/:ref/download",
    auth,
    canIntTransfers("read"),
    wrap((req, res) => {
      const result = integration.Transfers.getTransferContent(db, req.params.ref);
      res.setHeader("Content-Type", result.content_type);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    })
  );
  integrationRouter.post(
    "/transfers/:ref/cancel",
    auth,
    canIntTransfers("execute"),
    wrap((req, res) => {
      res.json(integration.Transfers.cancelTransfer(db, req.params.ref, req.actor));
    })
  );

  // Monitoring & dashboards
  integrationRouter.get(
    "/monitoring/overview",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json(integration.Monitoring.monitoringOverview(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );
  integrationRouter.get(
    "/monitoring/executions",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json(integration.Monitoring.executionMetrics(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );
  integrationRouter.get(
    "/monitoring/deliveries",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json(integration.Monitoring.deliveryMetrics(db, { tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.get(
    "/monitoring/systems",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json({ items: integration.Monitoring.listSystemsHealth(db, { tenantId: integrationTenant(req), status: req.query.status }) });
    })
  );
  integrationRouter.get(
    "/monitoring/systems/:code/uptime",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json(integration.Monitoring.systemUptime(db, req.params.code, { hours: req.query.hours }));
    })
  );
  integrationRouter.post(
    "/monitoring/health-checks/run",
    auth,
    canIntMonitoring("execute"),
    wrap((req, res) => {
      res.json(integration.Monitoring.runHealthChecks(db, { actor: req.actor, tenantId: integrationTenant(req), systemType: req.body?.system_type }));
    })
  );
  integrationRouter.get(
    "/monitoring/api-usage",
    auth,
    canIntMonitoring("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.apiUsageStats(db, { tenantId: integrationTenant(req), hours: req.query.hours }));
    })
  );

  // API catalog & clients
  integrationRouter.get(
    "/api-catalog",
    auth,
    canIntApi("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.listApiCatalog(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/api-catalog",
    auth,
    canIntApi("create"),
    wrap((req, res) => {
      res.status(201).json(integration.ApiCatalog.createCatalogEntry(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/api-catalog/:code",
    auth,
    canIntApi("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.getCatalogEntry(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/api-catalog/:code",
    auth,
    canIntApi("update"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.updateCatalogEntry(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/api-catalog/:code/status",
    auth,
    canIntApi("update"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.setCatalogStatus(db, req.params.code, req.body?.status, req.actor, req.body || {}));
    })
  );
  integrationRouter.delete(
    "/api-catalog/:code",
    auth,
    canIntApi("delete"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.deleteCatalogEntry(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/api-clients",
    auth,
    canIntApi("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.listApiClients(db, { ...req.query, tenantId: integrationTenant(req) }));
    })
  );
  integrationRouter.post(
    "/api-clients",
    auth,
    canIntApi("create"),
    wrap((req, res) => {
      res.status(201).json(integration.ApiCatalog.createApiClient(db, req.body || {}, req.actor, integrationTenant(req)));
    })
  );
  integrationRouter.get(
    "/api-clients/:code",
    auth,
    canIntApi("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.getApiClient(db, req.params.code));
    })
  );
  integrationRouter.patch(
    "/api-clients/:code",
    auth,
    canIntApi("update"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.updateApiClient(db, req.params.code, req.body || {}, req.actor));
    })
  );
  integrationRouter.post(
    "/api-clients/:code/rotate",
    auth,
    canIntApi("execute"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.rotateApiKey(db, req.params.code, req.actor));
    })
  );
  integrationRouter.post(
    "/api-clients/:code/revoke",
    auth,
    canIntApi("execute"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.revokeApiClient(db, req.params.code, req.actor, req.body?.reason));
    })
  );
  integrationRouter.delete(
    "/api-clients/:code",
    auth,
    canIntApi("delete"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.deleteApiClient(db, req.params.code, req.actor));
    })
  );
  integrationRouter.get(
    "/api-usage",
    auth,
    canIntApi("read"),
    wrap((req, res) => {
      res.json(integration.ApiCatalog.listApiUsage(db, { ...req.query, tenantId: integrationTenant(req) }));
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
  const manualGuard = (req, res, next) => {
    const wantsManual =
      req.body?.manualNumber !== undefined ||
      req.body?.manual_number !== undefined ||
      req.body?.number !== undefined ||
      req.body?.preferredNumber !== undefined;
    if (!wantsManual) return next();
    return canNumberingManual("create")(req, res, next);
  };
  const idempotencyKeyOf = (req) =>
    req.get("Idempotency-Key") || req.get("idempotency-key") || req.body?.idempotencyKey || null;

  const numberingRouter = express.Router();

  numberingRouter.get(
    "/meta",
    auth,
    canNumbering("read"),
    wrap((_req, res) => {
      res.json({
        ...numbering.Validation.vocabulary(),
        tokens: numbering.Tokens.listTokens(db),
        scopes: numbering.Foundation.DEFAULT_SCOPES,
      });
    })
  );

  numberingRouter.get(
    "/object-types",
    auth,
    canNumberingObjectTypes("read"),
    wrap((req, res) => {
      res.json({
        items: numbering.Foundation.listObjectTypes(db, {
          tenantId: numberingTenant(req),
          status: req.query.status || undefined,
        }),
      });
    })
  );
  numberingRouter.post(
    "/object-types",
    auth,
    canNumberingObjectTypes("create"),
    wrap((req, res) => {
      res.status(201).json(numbering.Foundation.createObjectType(db, req.body || {}, req.actor, numberingTenant(req), req.ip));
    })
  );
  numberingRouter.post(
    "/object-types/:code/status",
    auth,
    canNumberingObjectTypes("update"),
    wrap((req, res) => {
      res.json(numbering.Foundation.setObjectTypeStatus(db, req.params.code, req.body?.status, req.actor, req.ip));
    })
  );

  numberingRouter.get(
    "/scopes",
    auth,
    canNumbering("read"),
    wrap((_req, res) => {
      res.json({ items: numbering.Scopes.listScopes(db) });
    })
  );
  numberingRouter.get(
    "/tokens",
    auth,
    canNumbering("read"),
    wrap((_req, res) => {
      res.json({ items: numbering.Tokens.listTokens(db) });
    })
  );
  numberingRouter.post(
    "/tokens",
    auth,
    canNumberingSchemes("create"),
    wrap((req, res) => {
      res.status(201).json(numbering.Tokens.createToken(db, req.body || {}));
    })
  );

  // ── Schemes ────────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/schemes",
    auth,
    canNumberingSchemes("read"),
    wrap((req, res) => {
      res.json(numbering.Schemes.listSchemes(db, { ...req.query, tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.post(
    "/schemes",
    auth,
    canNumberingSchemes("create"),
    wrap((req, res) => {
      const scheme = numbering.Schemes.createScheme(db, req.body || {}, req.actor, numberingTenant(req), req.ip);
      res.status(201).json(scheme);
    })
  );
  numberingRouter.get(
    "/schemes/:ref",
    auth,
    canNumberingSchemes("read"),
    wrap((req, res) => {
      res.json(numbering.Schemes.getScheme(db, req.params.ref));
    })
  );
  const updateSchemeHandler = wrap((req, res) => {
    res.json(numbering.Schemes.updateScheme(db, req.params.ref, req.body || {}, req.actor, req.ip));
  });
  numberingRouter.put("/schemes/:ref", auth, canNumberingSchemes("update"), updateSchemeHandler);
  numberingRouter.patch("/schemes/:ref", auth, canNumberingSchemes("update"), updateSchemeHandler);
  numberingRouter.delete(
    "/schemes/:ref",
    auth,
    canNumberingSchemes("delete"),
    wrap((req, res) => {
      res.json(numbering.Schemes.deleteScheme(db, req.params.ref, req.actor, req.ip));
    })
  );
  numberingRouter.get(
    "/schemes/:ref/versions",
    auth,
    canNumberingSchemes("read"),
    wrap((req, res) => {
      const scheme = numbering.Schemes.getScheme(db, req.params.ref, { includeVersions: false });
      res.json({ items: numbering.Schemes.listVersions(db, scheme.id) });
    })
  );
  numberingRouter.post(
    "/schemes/:ref/validate",
    auth,
    canNumberingSchemes("read"),
    wrap((req, res) => {
      res.json(numbering.Schemes.validateScheme(db, req.params.ref));
    })
  );
  numberingRouter.post(
    "/schemes/:ref/clone",
    auth,
    canNumberingSchemes("create"),
    wrap((req, res) => {
      res.status(201).json(numbering.Schemes.cloneScheme(db, req.params.ref, req.body || {}, req.actor, numberingTenant(req), req.ip));
    })
  );
  const schemeStatusHandler = (status) =>
    wrap((req, res) => {
      res.json(numbering.Schemes.setSchemeStatus(db, req.params.ref, status, req.actor, req.ip));
    });
  numberingRouter.post("/schemes/:ref/activate", auth, canNumberingSchemes("execute"), schemeStatusHandler("active"));
  numberingRouter.post("/schemes/:ref/deactivate", auth, canNumberingSchemes("execute"), schemeStatusHandler("inactive"));
  numberingRouter.post("/schemes/:ref/retire", auth, canNumberingSchemes("execute"), schemeStatusHandler("retired"));

  // ── Generation ─────────────────────────────────────────────────────────────
  numberingRouter.post(
    "/generate",
    auth,
    canNumberingGenerate("create"),
    manualGuard,
    wrap((req, res) => {
      const allocation = numbering.Allocations.generateNumber(db, req.body || {}, req.actor, {
        tenantId: numberingTenant(req),
        ip: req.ip,
        idempotencyKey: idempotencyKeyOf(req),
      });
      res.status(201).json(allocation);
    })
  );
  numberingRouter.post(
    "/reserve",
    auth,
    canNumberingReserve("create"),
    manualGuard,
    wrap((req, res) => {
      const allocation = numbering.Allocations.generateNumber(
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
    auth,
    canNumberingGenerate("read"),
    wrap((req, res) => {
      res.json(numbering.Allocations.previewNumber(db, req.body || {}, { tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.post(
    "/validate",
    auth,
    canNumberingGenerate("read"),
    wrap((req, res) => {
      res.json(numbering.Allocations.validateIdentifier(db, req.body || {}, { tenantId: numberingTenant(req) }));
    })
  );

  // ── Allocations ────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/allocations",
    auth,
    canNumberingAllocations("read"),
    wrap((req, res) => {
      const query = numbering.Validation.normalizeAllocationQuery(req.query || {});
      res.json(numbering.Allocations.listAllocations(db, { ...query, tenantId: numberingTenant(req) }));
    })
  );
  numberingRouter.get(
    "/allocations/:ref",
    auth,
    canNumberingAllocations("read"),
    wrap((req, res) => {
      res.json(numbering.Allocations.getAllocation(db, req.params.ref));
    })
  );
  numberingRouter.post(
    "/allocations/:ref/consume",
    auth,
    canNumberingConsume("execute"),
    wrap((req, res) => {
      res.json(
        numbering.Allocations.consumeNumber(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );
  numberingRouter.post(
    "/allocations/:ref/release",
    auth,
    canNumberingRelease("execute"),
    wrap((req, res) => {
      res.json(
        numbering.Allocations.releaseNumber(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );
  numberingRouter.post(
    "/allocations/:ref/cancel",
    auth,
    canNumberingRelease("execute"),
    wrap((req, res) => {
      res.json(
        numbering.Allocations.cancelNumber(db, req.params.ref, req.body || {}, req.actor, {
          tenantId: numberingTenant(req),
          ip: req.ip,
        })
      );
    })
  );

  // ── Sequences ──────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/sequences",
    auth,
    canNumberingSequences("read"),
    wrap((req, res) => {
      res.json(
        numbering.Sequences.listSequences(db, {
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
    auth,
    canNumberingSequences("read"),
    wrap((req, res) => {
      const sequence = numbering.Sequences.publicSequence(db, numbering.Sequences.getSequenceRow(db, req.params.id));
      if (!sequence) throw new HttpError(404, "Numbering sequence not found");
      res.json(sequence);
    })
  );
  numberingRouter.post(
    "/sequences/:id/reset",
    auth,
    canNumberingSequences("execute"),
    wrap((req, res) => {
      res.json(numbering.Sequences.resetSequence(db, req.params.id, req.body || {}, req.actor, req.ip));
    })
  );

  // ── Monitoring ─────────────────────────────────────────────────────────────
  numberingRouter.get(
    "/metrics",
    auth,
    canNumberingMetrics("read"),
    wrap((req, res) => {
      res.json({
        ...numbering.Allocations.metricsSnapshot(db, { tenantId: numberingTenant(req) }),
        generation_latency: numbering.Metrics.generationLatency(db, { tenantId: numberingTenant(req) }),
      });
    })
  );
  numberingRouter.get(
    "/dashboard",
    auth,
    canNumberingMetrics("read"),
    wrap((req, res) => {
      res.json(
        numbering.Metrics.dashboardSummary(db, {
          tenantId: numberingTenant(req),
          from: req.query.from,
          to: req.query.to,
        })
      );
    })
  );
  numberingRouter.post(
    "/maintenance/expire",
    auth,
    canNumberingSequences("execute"),
    wrap((req, res) => {
      res.json(numbering.Allocations.expireReservations(db, { limit: Number(req.body?.limit) || 200 }));
    })
  );
  numberingRouter.get(
    "/health",
    wrap((req, res) => {
      const health = numbering.Metrics.healthCheck(db, { tenantId: numberingTenant(req) });
      res.status(health.healthy ? 200 : 503).json(health);
    })
  );
  numberingRouter.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  numberingRouter.get("/health/ready", (req, res) => {
    const health = numbering.Metrics.healthCheck(db, { tenantId: numberingTenant(req) });
    res.status(health.ready ? 200 : 503).json(health);
  });

  app.use("/api/numbering", numberingRouter);
  app.use("/api/v1/numbering", numberingRouter);

  // ── Enterprise Effectivity & Versioning Kernel ────────────────────────────
  const versioningRouter = createVersioningRouter({ express, db, auth, can, wrap });
  app.use("/api/versioning", versioningRouter);
  app.use("/api/v1/versioning", versioningRouter);
  app.use("/api/v1", versioningRouter);

  // ── Enterprise Reference Data Management ──────────────────────────────────
  const referenceRouter = createReferenceRouter({ express, db, auth, can, wrap });
  app.use("/api/reference-data", referenceRouter);
  app.use("/api/v1/reference-data", referenceRouter);

  // ── File & Content Management Service ─────────────────────────────────────
  const contentRouter = createContentRouter({ express, db, auth, can, wrap });
  app.use("/api/content", contentRouter);
  app.use("/api/v1/content", contentRouter);

  // ── Data Governance & Data Quality ────────────────────────────────────────
  const dataGovernanceRouter = createDataGovernanceRouter({ express, db, auth, can, wrap });
  const dataQualityRouter = createDataQualityRouter({ express, db, auth, can, wrap });
  app.use("/api/data-governance", dataGovernanceRouter);
  app.use("/api/v1/data-governance", dataGovernanceRouter);
  app.use("/api/data-quality", dataQualityRouter);
  app.use("/api/v1/data-quality", dataQualityRouter);

  // ── Data Catalog & Business Glossary ──────────────────────────────────────
  const dataCatalogRouter = createDataCatalogRouter({ express, db, auth, can, wrap });
  const glossaryRouter = createGlossaryRouter({ express, db, auth, can, wrap });
  app.use("/api/data-catalog", dataCatalogRouter);
  app.use("/api/v1/data-catalog", dataCatalogRouter);
  app.use("/api/catalog", dataCatalogRouter);
  app.use("/api/v1/catalog", dataCatalogRouter);
  app.use("/api/glossary", glossaryRouter);
  app.use("/api/v1/glossary", glossaryRouter);

  // ── Data Lifecycle & Archival ─────────────────────────────────────────────
  const dataLifecycleRouter = createDataLifecycleRouter({ express, db, auth, can, wrap });
  app.use("/api/lifecycle", dataLifecycleRouter);
  app.use("/api/v1/lifecycle", dataLifecycleRouter);

  // ── Import & Export Framework ─────────────────────────────────────────────
  const dataExchangeRouter = createDataExchangeRouter({ express, db, auth, can, wrap });
  app.use("/api/data-exchange", dataExchangeRouter);
  app.use("/api/v1/data-exchange", dataExchangeRouter);

  // ── Migration & Onboarding Framework ──────────────────────────────────────
  const migrationRouter = createMigrationRouter({ express, db, auth, can, wrap });
  app.use("/api/migration", migrationRouter);
  app.use("/api/v1/migration", migrationRouter);

  // ── Enterprise Classification Framework ───────────────────────────────────
  const classificationRouter = createClassificationRouter({ express, db, auth, can, wrap });
  app.use("/api/classification", classificationRouter);
  app.use("/api/v1/classification", classificationRouter);

  // ── P1 BOM Engine ─────────────────────────────────────────────────────────
  const bomRouter = createBomRouter({ express, db, auth, can, wrap });
  app.use("/api/bom", bomRouter);
  app.use("/api/v1/bom", bomRouter);

  // ── P1 PDM domain ─────────────────────────────────────────────────────────
  const pdmRouter = createPdmRouter({ express, db, auth, can, wrap });
  app.use("/api/pdm", pdmRouter);
  app.use("/api/v1/pdm", pdmRouter);

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
