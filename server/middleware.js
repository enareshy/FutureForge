import { HttpError } from "./validation.js";
import { checkPermission, checkPermissionAsync } from "./services/authorization.js";
import { writeAudit } from "./services/audit.js";
import { emitDomainEvent } from "./services/events/emit.js";
import { isFeatureEnabled } from "./services/deployment/index.js";
import { featureDisabled } from "./services/deployment/errors.js";

function contextOrg(req) {
  const raw =
    req.body?.organization_id ??
    req.body?.organizationId ??
    req.query?.organizationId ??
    req.params?.organizationId ??
    0;
  if (raw === undefined || raw === null || raw === "" || raw === "global") return 0;
  return Number(raw) || 0;
}

export function requirePermission(db, resource, action) {
  return (req, _res, next) => {
    if (!req.actor) return next(new HttpError(401, "Authentication required"));
    const organizationId = contextOrg(req);
    const result = checkPermission(db, req.actor.id, resource, action, { organizationId });
    if (!result.allowed) {
      const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
      writeAudit(db, {
        actor: req.actor,
        action: "authz.deny",
        resourceType: "authorization",
        resourceId: resource,
        details: { action, reason: result.reason, organizationId },
        ip,
      });
      emitDomainEvent(
        db,
        {
          event_type_code: "SecurityAccessDenied",
          category: "security",
          source_module: "iam",
          source_system: "iam",
          source_object_type: "authorization",
          source_object_id: resource,
          tenant_id: req.actor.tenant_id ?? null,
          organization_id: req.actor.organization_id ?? null,
          security_classification: "confidential",
          payload: {
            principal: { id: req.actor.id, username: req.actor.username },
            resource,
            action,
            reason: result.reason,
            organization_id: organizationId,
          },
          metadata: { ip },
        },
        req.actor
      );
      return next(
        new HttpError(403, "Forbidden", { reason: result.reason, resource, action })
      );
    }
    req.authz = result;
    next();
  };
}

// Async counterpart of `requirePermission` for the asynchronous request paths.
// The denial side effects (audit + domain event) reuse the synchronous layer:
// they only run on the rare denied request, so blocking there is acceptable and
// keeps a single audit implementation.
export function requirePermissionAsync(db, resource, action) {
  return async (req, _res, next) => {
    try {
      if (!req.actor) return next(new HttpError(401, "Authentication required"));
      const organizationId = contextOrg(req);
      const result = await checkPermissionAsync(db, req.actor.id, resource, action, { organizationId });
      if (!result.allowed) {
        const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
        writeAudit(db, {
          actor: req.actor,
          action: "authz.deny",
          resourceType: "authorization",
          resourceId: resource,
          details: { action, reason: result.reason, organizationId },
          ip,
        });
        emitDomainEvent(
          db,
          {
            event_type_code: "SecurityAccessDenied",
            category: "security",
            source_module: "iam",
            source_system: "iam",
            source_object_type: "authorization",
            source_object_id: resource,
            tenant_id: req.actor.tenant_id ?? null,
            organization_id: req.actor.organization_id ?? null,
            security_classification: "confidential",
            payload: {
              principal: { id: req.actor.id, username: req.actor.username },
              resource,
              action,
              reason: result.reason,
              organization_id: organizationId,
            },
            metadata: { ip },
          },
          req.actor
        );
        return next(
          new HttpError(403, "Forbidden", { reason: result.reason, resource, action })
        );
      }
      req.authz = result;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Deployment feature gate. Modules the deployment is not entitled to (by
// edition, topology or operator override) are rejected with a 403 that names
// the feature, so the console can explain *why* a module is unavailable.
// Deliberately cheap: entitlements are resolved once and cached per database.
export function requireFeature(db, code) {
  return (req, _res, next) => {
    if (isFeatureEnabled(db, code)) return next();
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
    if (req.actor) {
      writeAudit(db, {
        actor: req.actor,
        action: "deployment.feature.denied",
        resourceType: "deployment_feature",
        resourceId: code,
        details: { feature: code, path: req.originalUrl },
        ip,
      });
    }
    next(featureDisabled(code));
  };
}
