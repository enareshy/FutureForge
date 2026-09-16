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
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  providers.ensureDefaultProviders(db);
  config.ensureDefinitions(db);
  tenants.stampTenantIds(db);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // Audit & History Framework: propagate a request/correlation id on every
  // request and capture failed access attempts automatically.
  app.use(audit.auditContext());
  app.use(audit.captureApiFailures(db));

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
      action: req.query.action,
      eventType: req.query.eventType,
      source: req.query.source,
      status: req.query.status,
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
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
