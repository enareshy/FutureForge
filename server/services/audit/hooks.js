import { randomUuid } from "../../db.js";
import { capture, structuredLog } from "./events.js";

// Express integration for the audit framework: request context propagation,
// automatic failure capture and a declarative per-route success/failure hook.

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.toString().split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

export function requestContext(req) {
  return {
    ip: clientIp(req),
    device: req.headers["user-agent"] || null,
    requestId: req.auditRequestId || req.headers["x-request-id"] || null,
    correlationId: req.auditCorrelationId || req.headers["x-correlation-id"] || null,
    source: req.auditSource || "api",
  };
}

// Attaches a request id and correlation id to every request so that cascading
// operations (a UI action that triggers workflow and lifecycle writes) can be
// stitched together in the audit trail.
export function auditContext() {
  return (req, _res, next) => {
    req.auditRequestId = String(req.headers["x-request-id"] || randomUuid());
    req.auditCorrelationId = String(req.headers["x-correlation-id"] || req.auditRequestId);
    req.auditStart = Date.now();
    next();
  };
}

// Automatically records failed access attempts (401) and unexpected server
// errors (5xx) for API requests. Authorization denials (403) are already
// captured by the permission middleware, so they are not duplicated here.
export function captureApiFailures(db) {
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    res.on("finish", () => {
      try {
        if (req.auditCaptured) return;
        let action = null;
        if (res.statusCode === 401) action = "access.unauthenticated";
        else if (res.statusCode >= 500) action = "request.failed";
        if (!action) return;
        capture(db, {
          actor: req.actor || null,
          tenant_id: req.tenantId || null,
          action,
          event_type: res.statusCode === 401 ? "ACCESS_DENIED" : "ADMIN_ACTION",
          source: "api",
          object_type: "http_request",
          object_id: `${req.method} ${req.path}`,
          status: "failure",
          error_message: res.locals?.auditError || `HTTP ${res.statusCode}`,
          ip: clientIp(req),
          device: req.headers["user-agent"] || null,
          request_id: req.auditRequestId,
          correlation_id: req.auditCorrelationId,
          details: { method: req.method, path: req.path, status: res.statusCode },
          duration_ms: req.auditStart ? Date.now() - req.auditStart : null,
        });
        req.auditCaptured = true;
      } catch (err) {
        structuredLog("audit.middleware.failed", { message: err?.message });
      }
    });
    next();
  };
}

// Declarative audit hook for a route. Modules can opt in with
//   app.post("/api/things", auth, can("x", "create"), auditRoute(db, { action: "thing.create", objectType: "thing" }), handler)
// The middleware snapshots the response outcome after the handler completes.
export function auditRoute(db, options = {}) {
  const {
    action,
    objectType,
    objectId,
    objectName,
    source = "api",
    reasonFrom = (req) => req.body?.reason ?? req.body?.comment,
  } = options;
  return (req, res, next) => {
    res.on("finish", () => {
      try {
        if (req.auditCaptured) return;
        const status = res.statusCode < 400 ? "success" : "failure";
        const resolve = (value) => (typeof value === "function" ? value(req, res) : value);
        const resolvedAction = resolve(action);
        if (!resolvedAction) return;
        const result = capture(db, {
          actor: req.actor || null,
          tenant_id: req.tenantId || null,
          action: resolvedAction,
          object_type: resolve(objectType) ?? req.params?.objectType ?? req.params?.type ?? "system",
          object_id: resolve(objectId) ?? req.params?.id ?? null,
          object_name: resolve(objectName) ?? null,
          status,
          error_message: res.locals?.auditError || (status === "failure" ? `HTTP ${res.statusCode}` : null),
          reason: reasonFrom(req),
          source,
          ip: clientIp(req),
          device: req.headers["user-agent"] || null,
          request_id: req.auditRequestId,
          correlation_id: req.auditCorrelationId,
          duration_ms: req.auditStart ? Date.now() - req.auditStart : null,
        });
        req.auditCaptured = !!result;
      } catch (err) {
        structuredLog("audit.route.failed", { message: err?.message });
      }
    });
    next();
  };
}

// Pre-fills a capture payload from the request context. Handlers use this to
// emit rich explicit events without re-deriving actor/tenant/ip each time.
export function auditFromRequest(req, overrides = {}) {
  return {
    actor: req.actor || null,
    tenant_id: req.tenantId || null,
    source: "api",
    ip: clientIp(req),
    device: req.headers["user-agent"] || null,
    request_id: req.auditRequestId || null,
    correlation_id: req.auditCorrelationId || null,
    ...overrides,
  };
}
