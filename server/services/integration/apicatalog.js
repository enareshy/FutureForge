// API management: versioned API catalog with lifecycle (beta/active/deprecated/
// retired), service-account clients with hashed keys/scopes, usage metering and
// rate-limit accounting.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicApiCatalog, publicApiClient } from "./repository.js";
import { API_STATUSES, assertEnum, generateApiKey, hashApiKey, toJson } from "./validation.js";
import { auditIntegration } from "./hooks.js";

const CLIENT_TYPES = ["service_account", "integration", "external"];

// ── API catalog ─────────────────────────────────────────────────────────────
export function listApiCatalog(db, { tenantId, apiGroup, status, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (apiGroup) {
    clauses.push("api_group = ?");
    params.push(apiGroup);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(path) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_api_catalog ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_api_catalog ${where} ORDER BY api_group, version DESC, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicApiCatalog(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getCatalogRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_api_catalog WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getCatalogEntry(db, refValue) {
  const row = getCatalogRow(db, refValue);
  if (!row) throw new HttpError(404, "API catalog entry not found");
  return publicApiCatalog(row);
}

export function createCatalogEntry(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  if (input.status !== undefined) assertEnum(input.status, API_STATUSES, "status");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_api_catalog
      (code, name, api_group, version, description, auth_required, auth_methods_json, rate_limit_per_minute,
       request_schema_json, response_schema_json, docs_url, status, deprecated_at, sunset_at, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.api_group || "integration",
      input.version || "v1",
      input.description || "",
      input.auth_required === false ? 0 : 1,
      toJson(input.auth_methods, ["jwt", "api_key"]),
      Number(input.rate_limit_per_minute) || 0,
      toJson(input.request_schema, {}),
      toJson(input.response_schema, {}),
      input.docs_url || "",
      input.status || "active",
      input.deprecated_at || null,
      input.sunset_at || null,
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_api_catalog WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.api.catalog.create", resourceType: "integration_api_catalog", resourceId: row.id, details: { code: row.code, version: row.version } });
  return publicApiCatalog(row);
}

export function updateCatalogEntry(db, refValue, input = {}, actor = null) {
  const row = getCatalogRow(db, refValue);
  if (!row) throw new HttpError(404, "API catalog entry not found");
  if (input.status !== undefined) assertEnum(input.status, API_STATUSES, "status");
  run(
    db,
    `UPDATE integration_api_catalog SET name=?, api_group=?, version=?, description=?, auth_required=?, auth_methods_json=?,
       rate_limit_per_minute=?, request_schema_json=?, response_schema_json=?, docs_url=?, status=?, deprecated_at=?,
       sunset_at=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.api_group ?? row.api_group,
      input.version ?? row.version,
      input.description ?? row.description,
      input.auth_required !== undefined ? (input.auth_required ? 1 : 0) : row.auth_required,
      input.auth_methods !== undefined ? toJson(input.auth_methods, []) : row.auth_methods_json,
      input.rate_limit_per_minute !== undefined ? Number(input.rate_limit_per_minute) : row.rate_limit_per_minute,
      input.request_schema !== undefined ? toJson(input.request_schema, {}) : row.request_schema_json,
      input.response_schema !== undefined ? toJson(input.response_schema, {}) : row.response_schema_json,
      input.docs_url ?? row.docs_url,
      input.status ?? row.status,
      input.deprecated_at !== undefined ? input.deprecated_at : row.deprecated_at,
      input.sunset_at !== undefined ? input.sunset_at : row.sunset_at,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.api.catalog.update", resourceType: "integration_api_catalog", resourceId: row.id, details: { code: row.code } });
  return publicApiCatalog(queryOne(db, "SELECT * FROM integration_api_catalog WHERE id = ?", [row.id]));
}

export function setCatalogStatus(db, refValue, status, actor = null, { deprecated_at = null, sunset_at = null } = {}) {
  assertEnum(status, API_STATUSES, "status");
  const row = getCatalogRow(db, refValue);
  if (!row) throw new HttpError(404, "API catalog entry not found");
  run(db, "UPDATE integration_api_catalog SET status = ?, deprecated_at = ?, sunset_at = ?, updated_at = ? WHERE id = ?", [
    status,
    deprecated_at ?? (status === "deprecated" ? nowIso() : row.deprecated_at),
    sunset_at ?? row.sunset_at,
    nowIso(),
    row.id,
  ]);
  auditIntegration(db, { actor, action: "integration.api.catalog.status", resourceType: "integration_api_catalog", resourceId: row.id, details: { status } });
  return publicApiCatalog(queryOne(db, "SELECT * FROM integration_api_catalog WHERE id = ?", [row.id]));
}

export function deleteCatalogEntry(db, refValue, actor = null) {
  const row = getCatalogRow(db, refValue);
  if (!row) throw new HttpError(404, "API catalog entry not found");
  run(db, "DELETE FROM integration_api_catalog WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.api.catalog.delete", resourceType: "integration_api_catalog", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── API clients ─────────────────────────────────────────────────────────────
export function listApiClients(db, { tenantId, status, clientType, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (clientType) {
    clauses.push("client_type = ?");
    params.push(clientType);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_api_clients ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_api_clients ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicApiClient(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getApiClientRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_api_clients WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getApiClient(db, refValue) {
  const row = getApiClientRow(db, refValue);
  if (!row) throw new HttpError(404, "API client not found");
  return publicApiClient(row);
}

// Creates a client and returns the plaintext API key exactly once.
export function createApiClient(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  assertEnum(input.client_type || "service_account", CLIENT_TYPES, "client_type");
  const key = input.api_key ? { raw: input.api_key, prefix: String(input.api_key).slice(0, 12), hash: hashApiKey(input.api_key) } : generateApiKey("intg");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_api_clients
      (code, name, client_type, api_key_prefix, api_key_hash, credential_id, scopes_json, allowed_systems_json,
       ip_allowlist_json, status, expires_at, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.client_type || "service_account",
      key.prefix,
      key.hash,
      input.credential_id ?? null,
      toJson(input.scopes, []),
      toJson(input.allowed_systems, []),
      toJson(input.ip_allowlist, []),
      input.expires_at || null,
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_api_clients WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.api.client.create", resourceType: "integration_api_client", resourceId: row.id, details: { code: row.code } });
  return publicApiClient(row, { apiKey: key.raw });
}

export function updateApiClient(db, refValue, input = {}, actor = null) {
  const row = getApiClientRow(db, refValue);
  if (!row) throw new HttpError(404, "API client not found");
  if (input.client_type !== undefined) assertEnum(input.client_type, CLIENT_TYPES, "client_type");
  if (input.status !== undefined) assertEnum(input.status, ["active", "inactive", "revoked"], "status");
  run(
    db,
    `UPDATE integration_api_clients SET name=?, client_type=?, credential_id=?, scopes_json=?, allowed_systems_json=?,
       ip_allowlist_json=?, status=?, expires_at=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.client_type ?? row.client_type,
      input.credential_id !== undefined ? input.credential_id : row.credential_id,
      input.scopes !== undefined ? toJson(input.scopes, []) : row.scopes_json,
      input.allowed_systems !== undefined ? toJson(input.allowed_systems, []) : row.allowed_systems_json,
      input.ip_allowlist !== undefined ? toJson(input.ip_allowlist, []) : row.ip_allowlist_json,
      input.status ?? row.status,
      input.expires_at !== undefined ? input.expires_at : row.expires_at,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.api.client.update", resourceType: "integration_api_client", resourceId: row.id, details: { code: row.code } });
  return publicApiClient(queryOne(db, "SELECT * FROM integration_api_clients WHERE id = ?", [row.id]));
}

export function rotateApiKey(db, refValue, actor = null) {
  const row = getApiClientRow(db, refValue);
  if (!row) throw new HttpError(404, "API client not found");
  const key = generateApiKey("intg");
  run(db, "UPDATE integration_api_clients SET api_key_prefix = ?, api_key_hash = ?, status = 'active', updated_at = ? WHERE id = ?", [
    key.prefix,
    key.hash,
    nowIso(),
    row.id,
  ]);
  auditIntegration(db, { actor, action: "integration.api.client.rotate", resourceType: "integration_api_client", resourceId: row.id, details: { code: row.code } });
  return publicApiClient(queryOne(db, "SELECT * FROM integration_api_clients WHERE id = ?", [row.id]), { apiKey: key.raw });
}

export function revokeApiClient(db, refValue, actor = null, reason = "") {
  const row = getApiClientRow(db, refValue);
  if (!row) throw new HttpError(404, "API client not found");
  run(db, "UPDATE integration_api_clients SET status = 'revoked', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.api.client.revoke", resourceType: "integration_api_client", resourceId: row.id, details: { code: row.code, reason } });
  return publicApiClient(queryOne(db, "SELECT * FROM integration_api_clients WHERE id = ?", [row.id]));
}

export function deleteApiClient(db, refValue, actor = null) {
  const row = getApiClientRow(db, refValue);
  if (!row) throw new HttpError(404, "API client not found");
  run(db, "DELETE FROM integration_api_clients WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.api.client.delete", resourceType: "integration_api_client", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// Authenticates a raw API key. Returns the client row or null.
export function authenticateApiClient(db, rawKey) {
  if (!rawKey) return null;
  const hash = hashApiKey(rawKey);
  const row = queryOne(db, "SELECT * FROM integration_api_clients WHERE api_key_hash = ?", [hash]);
  if (!row || row.status !== "active") return null;
  if (row.expires_at && row.expires_at < nowIso()) return null;
  run(db, "UPDATE integration_api_clients SET last_used_at = ? WHERE id = ?", [nowIso(), row.id]);
  return publicApiClient(row);
}

// ── Usage metering ──────────────────────────────────────────────────────────
export function recordApiUsage(db, { clientId = null, endpointCode = "", apiVersion = "v1", method = "", path = "", statusCode = 0, durationMs = 0, correlationId = "", tenantId = null }) {
  run(
    db,
    `INSERT INTO integration_api_usage (client_id, endpoint_code, api_version, method, path, status_code, duration_ms, correlation_id, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, endpointCode, apiVersion, method, path, Number(statusCode) || 0, Number(durationMs) || 0, correlationId, tenantId, nowIso()]
  );
}

export function listApiUsage(db, { tenantId, clientId, apiVersion, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (clientId) {
    clauses.push("client_id = ?");
    params.push(Number(clientId));
  }
  if (apiVersion) {
    clauses.push("api_version = ?");
    params.push(apiVersion);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_api_usage ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_api_usage ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows, total, page: Number(page), page_size: Number(pageSize) };
}

export function apiUsageStats(db, { tenantId = null, hours = 24 } = {}) {
  const since = new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clauses = ["created_at >= ?"];
  const params = [since];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const totals = queryOne(db, `SELECT COUNT(*) AS requests, AVG(duration_ms) AS avg_ms, SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors FROM integration_api_usage ${where}`, params);
  const byEndpoint = queryAll(db, `SELECT endpoint_code, COUNT(*) AS requests, AVG(duration_ms) AS avg_ms FROM integration_api_usage ${where} GROUP BY endpoint_code ORDER BY requests DESC LIMIT 20`, params);
  const byStatus = queryAll(db, `SELECT status_code, COUNT(*) AS count FROM integration_api_usage ${where} GROUP BY status_code ORDER BY count DESC`, params);
  return {
    window_hours: Number(hours),
    requests: totals?.requests || 0,
    errors: totals?.errors || 0,
    avg_duration_ms: totals?.avg_ms ? Math.round(totals.avg_ms) : null,
    by_endpoint: byEndpoint,
    by_status: byStatus,
  };
}

// Simple fixed-window rate limiter backed by the usage table. Returns whether a
// request is allowed and the remaining budget for the current minute.
export function checkRateLimit(db, { clientId = null, apiVersion = "v1", limitPerMinute = 0, tenantId = null } = {}) {
  if (!limitPerMinute || limitPerMinute <= 0) return { allowed: true, remaining: null, limit: 0 };
  const since = new Date(Date.now() - 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clauses = ["created_at >= ?"];
  const params = [since];
  if (clientId) {
    clauses.push("client_id = ?");
    params.push(Number(clientId));
  } else {
    clauses.push("client_id IS NULL");
  }
  if (apiVersion) {
    clauses.push("api_version = ?");
    params.push(apiVersion);
  }
  const used = queryOne(db, `SELECT COUNT(*) AS c FROM integration_api_usage WHERE ${clauses.join(" AND ")}`, params).c;
  return { allowed: used < limitPerMinute, remaining: Math.max(0, limitPerMinute - used), limit: limitPerMinute, used };
}
