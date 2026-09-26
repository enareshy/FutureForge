// Integration endpoint catalog (exposed and consumed APIs) with versioning,
// authentication/authorization metadata, rate limits and schema references.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicEndpoint } from "./repository.js";
import { AUTH_METHODS, assertEnum, assertSafeUrl, normalizeDirection, safeParse, toJson } from "./validation.js";
import { auditIntegration } from "./hooks.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function scopeWhere({ tenantId, integrationId, externalSystemId, direction, status, apiVersion, q } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (integrationId) {
    clauses.push("integration_id = ?");
    params.push(Number(integrationId));
  }
  if (externalSystemId) {
    clauses.push("external_system_id = ?");
    params.push(Number(externalSystemId));
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(direction);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (apiVersion) {
    clauses.push("api_version = ?");
    params.push(apiVersion);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(path) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listEndpoints(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = scopeWhere(options);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_endpoints ${where}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM integration_endpoints ${where} ORDER BY api_version DESC, code LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)]
  );
  return { items: rows.map((r) => publicEndpoint(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getEndpointRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM integration_endpoints WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getEndpoint(db, ref, scope = {}) {
  const row = getEndpointRow(db, ref);
  if (!row) throw new HttpError(404, "Integration endpoint not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "Integration endpoint not found");
  }
  return publicEndpoint(row);
}

function validate(input, { partial = false } = {}) {
  if (!partial || input.method !== undefined) {
    const method = String(input.method ?? "POST").toUpperCase();
    if (!METHODS.includes(method)) throw new HttpError(400, `method must be one of: ${METHODS.join(", ")}`);
  }
  if (!partial || input.direction !== undefined) normalizeDirection(input.direction ?? "inbound");
  if (!partial || input.auth_method !== undefined) assertEnum(input.auth_method ?? "jwt", AUTH_METHODS, "auth_method");
  if (input.path && /^https?:\/\//i.test(String(input.path))) {
    assertSafeUrl(input.path, { allowPrivate: process.env.INTEGRATION_ALLOW_PRIVATE_HOSTS === "true" });
  }
}

export function createEndpoint(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  validate(input);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_endpoints
      (code, name, description, integration_id, external_system_id, direction, method, path, api_version,
       request_format, response_format, request_schema_json, response_schema_json, auth_required, auth_method,
       authorization_policy, ip_allowlist_json, timeout_seconds, rate_limit_per_minute, retry_policy_json,
       status, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.integration_id ?? null,
      input.external_system_id ?? null,
      normalizeDirection(input.direction || "inbound"),
      String(input.method || "POST").toUpperCase(),
      input.path || `/api/v1/${String(input.code).toLowerCase()}`,
      input.api_version || "v1",
      input.request_format || "json",
      input.response_format || "json",
      toJson(input.request_schema, {}),
      toJson(input.response_schema, {}),
      input.auth_required === false ? 0 : 1,
      input.auth_method || "jwt",
      input.authorization_policy || "",
      toJson(input.ip_allowlist, []),
      Number(input.timeout_seconds) || 30,
      Number(input.rate_limit_per_minute) || 0,
      toJson(input.retry_policy, {}),
      input.status || "enabled",
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_endpoints WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.endpoint.create", resourceType: "integration_endpoint", resourceId: row.id, details: { code: row.code, method: row.method, path: row.path } });
  return publicEndpoint(row);
}

export function updateEndpoint(db, ref, input = {}, actor = null) {
  const row = getEndpointRow(db, ref);
  if (!row) throw new HttpError(404, "Integration endpoint not found");
  validate(input, { partial: true });
  run(
    db,
    `UPDATE integration_endpoints SET name=?, description=?, integration_id=?, external_system_id=?, direction=?,
       method=?, path=?, api_version=?, request_format=?, response_format=?, request_schema_json=?, response_schema_json=?,
       auth_required=?, auth_method=?, authorization_policy=?, ip_allowlist_json=?, timeout_seconds=?,
       rate_limit_per_minute=?, retry_policy_json=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.integration_id !== undefined ? input.integration_id : row.integration_id,
      input.external_system_id !== undefined ? input.external_system_id : row.external_system_id,
      input.direction ?? row.direction,
      input.method ? String(input.method).toUpperCase() : row.method,
      input.path ?? row.path,
      input.api_version ?? row.api_version,
      input.request_format ?? row.request_format,
      input.response_format ?? row.response_format,
      input.request_schema !== undefined ? toJson(input.request_schema, {}) : row.request_schema_json,
      input.response_schema !== undefined ? toJson(input.response_schema, {}) : row.response_schema_json,
      input.auth_required === undefined ? row.auth_required : input.auth_required ? 1 : 0,
      input.auth_method ?? row.auth_method,
      input.authorization_policy ?? row.authorization_policy,
      input.ip_allowlist !== undefined ? toJson(input.ip_allowlist, []) : row.ip_allowlist_json,
      input.timeout_seconds !== undefined ? Number(input.timeout_seconds) : row.timeout_seconds,
      input.rate_limit_per_minute !== undefined ? Number(input.rate_limit_per_minute) : row.rate_limit_per_minute,
      input.retry_policy !== undefined ? toJson(input.retry_policy, {}) : row.retry_policy_json,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.endpoint.update", resourceType: "integration_endpoint", resourceId: row.id, details: { code: row.code } });
  return publicEndpoint(queryOne(db, "SELECT * FROM integration_endpoints WHERE id = ?", [row.id]));
}

export function deleteEndpoint(db, ref, actor = null) {
  const row = getEndpointRow(db, ref);
  if (!row) throw new HttpError(404, "Integration endpoint not found");
  run(db, "DELETE FROM integration_endpoints WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.endpoint.delete", resourceType: "integration_endpoint", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

export function endpointRetryPolicy(row) {
  return safeParse(row?.retry_policy_json, {});
}
