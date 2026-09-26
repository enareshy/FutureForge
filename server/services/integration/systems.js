// External systems + secure credential references.
//
// Credentials are always encrypted at rest with the platform crypto service and
// are never returned by the API, written to logs or included in audit detail.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { encryptSecret, decryptSecret, encryptJson, decryptJson } from "../../crypto.js";
import { publicCredential, publicExternalSystem, publicHealthCheck } from "./repository.js";
import {
  CREDENTIAL_KINDS,
  ENVIRONMENTS,
  SYSTEM_TYPES,
  AUTH_METHODS,
  assertEnum,
  assertSafeUrl,
  maskSecret,
  safeParse,
  toJson,
} from "./validation.js";
import { auditIntegration } from "./hooks.js";

function scopeClause(scope = {}, alias = "") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const clauses = [];
  const params = [];
  if (scope.tenantId !== undefined && scope.tenantId !== null) {
    clauses.push(`${col("tenant_id")} = ?`);
    params.push(Number(scope.tenantId));
  }
  return { clauses, params };
}

// ── Credentials ─────────────────────────────────────────────────────────────
export function listCredentials(db, { tenantId, status, q } = {}) {
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
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    params.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryAll(db, `SELECT * FROM integration_credentials ${where} ORDER BY code`, params).map((r) => publicCredential(r));
}

export function getCredentialRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM integration_credentials WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getCredential(db, ref, scope = {}) {
  const row = getCredentialRow(db, ref);
  if (!row) throw new HttpError(404, "Credential not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "Credential not found");
  }
  return publicCredential(row);
}

export function createCredential(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  assertEnum(input.kind ?? "api_key", CREDENTIAL_KINDS, "kind");
  const secret = input.secret ?? input.value ?? input.password ?? "";
  const config = input.config || {};
  const combinedSecret = secret || config.secret || config.password || config.token || "";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_credentials
      (code, name, kind, description, tenant_id, secret_enc, config_json, status, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.kind || "api_key",
      input.description || "",
      tenantId ?? input.tenant_id ?? null,
      encryptSecret(combinedSecret),
      toJson({ ...config, secret: undefined, password: undefined, token: undefined }, {}),
      input.status || "active",
      input.expires_at || null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_credentials WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.credential.create", resourceType: "integration_credential", resourceId: row.id, details: { code: row.code, kind: row.kind, has_secret: Boolean(row.secret_enc) } });
  return publicCredential(row);
}

export function updateCredential(db, ref, input = {}, actor = null) {
  const row = getCredentialRow(db, ref);
  if (!row) throw new HttpError(404, "Credential not found");
  if (input.kind !== undefined) assertEnum(input.kind, CREDENTIAL_KINDS, "kind");
  const secretProvided = input.secret !== undefined || input.password !== undefined || input.token !== undefined;
  const secret = input.secret ?? input.password ?? input.token;
  run(
    db,
    `UPDATE integration_credentials SET name=?, kind=?, description=?, status=?, expires_at=?,
       secret_enc=?, config_json=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.kind ?? row.kind,
      input.description ?? row.description,
      input.status ?? row.status,
      input.expires_at !== undefined ? input.expires_at : row.expires_at,
      secretProvided ? encryptSecret(secret || "") : row.secret_enc,
      input.config !== undefined ? toJson({ ...input.config, secret: undefined, password: undefined, token: undefined }, {}) : row.config_json,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.credential.update", resourceType: "integration_credential", resourceId: row.id, details: { code: row.code, rotated: secretProvided } });
  return publicCredential(queryOne(db, "SELECT * FROM integration_credentials WHERE id = ?", [row.id]));
}

export function deleteCredential(db, ref, actor = null) {
  const row = getCredentialRow(db, ref);
  if (!row) throw new HttpError(404, "Credential not found");
  const referenced = queryOne(db, "SELECT 1 AS x FROM integration_definitions WHERE credential_id = ? LIMIT 1", [row.id])
    || queryOne(db, "SELECT 1 AS x FROM external_systems WHERE credential_id = ? LIMIT 1", [row.id]);
  if (referenced) throw new HttpError(409, "Credential is referenced by a system or integration");
  run(db, "DELETE FROM integration_credentials WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.credential.delete", resourceType: "integration_credential", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// Resolves the decrypted secret for adapter use. Never exposed by an API.
export function resolveCredentialSecret(db, credentialId) {
  if (!credentialId) return { secret: "", config: {} };
  const row = queryOne(db, "SELECT * FROM integration_credentials WHERE id = ?", [Number(credentialId)]);
  if (!row) return { secret: "", config: {} };
  return { secret: decryptSecret(row.secret_enc), config: decryptJson(row.secret_enc) || {}, kind: row.kind, row };
}

// ── External systems ────────────────────────────────────────────────────────
export function listExternalSystems(db, { tenantId, systemType, environment, status, connectionStatus, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  const scoped = scopeClause({ tenantId });
  clauses.push(...scoped.clauses);
  params.push(...scoped.params);
  if (systemType) {
    clauses.push("system_type = ?");
    params.push(systemType);
  }
  if (environment) {
    clauses.push("environment = ?");
    params.push(environment);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (connectionStatus) {
    clauses.push("connection_status = ?");
    params.push(connectionStatus);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(base_url) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM external_systems ${where}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM external_systems ${where} ORDER BY name, code LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)]
  );
  return { items: rows.map((r) => publicExternalSystem(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getSystemRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM external_systems WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getExternalSystem(db, ref, scope = {}) {
  const row = getSystemRow(db, ref);
  if (!row) throw new HttpError(404, "External system not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "External system not found");
  }
  return publicExternalSystem(row);
}

function validateSystemInput(input, { partial = false } = {}) {
  if (!partial || input.system_type !== undefined) assertEnum(input.system_type ?? "custom", SYSTEM_TYPES, "system_type");
  if (!partial || input.environment !== undefined) assertEnum(input.environment ?? "production", ENVIRONMENTS, "environment");
  if (!partial || input.auth_method !== undefined) assertEnum(input.auth_method ?? "none", AUTH_METHODS, "auth_method");
  if (input.base_url) {
    const allowPrivate = Boolean(input.allow_private || process.env.INTEGRATION_ALLOW_PRIVATE_HOSTS === "true");
    assertSafeUrl(input.base_url, { allowPrivate });
  }
}

export function createExternalSystem(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  validateSystemInput(input);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO external_systems
      (code, name, system_type, description, environment, base_url, connection_ref, auth_method, credential_id,
       protocols_json, health_check_json, config_json, status, tenant_id, organization_id, plant_id, site_id,
       owner_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.system_type || "custom",
      input.description || "",
      input.environment || "production",
      input.base_url || "",
      input.connection_ref || "",
      input.auth_method || "none",
      input.credential_id ?? null,
      toJson(input.protocols, []),
      toJson(input.health_check, {}),
      toJson(input.config, {}),
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      input.organization_id ?? null,
      input.plant_id ?? null,
      input.site_id ?? null,
      input.owner_id ?? actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.system.create", resourceType: "external_system", resourceId: row.id, details: { code: row.code, type: row.system_type, environment: row.environment } });
  return publicExternalSystem(row);
}

export function updateExternalSystem(db, ref, input = {}, actor = null) {
  const row = getSystemRow(db, ref);
  if (!row) throw new HttpError(404, "External system not found");
  validateSystemInput(input, { partial: true });
  run(
    db,
    `UPDATE external_systems SET name=?, system_type=?, description=?, environment=?, base_url=?, connection_ref=?,
       auth_method=?, credential_id=?, protocols_json=?, health_check_json=?, config_json=?, status=?,
       organization_id=?, plant_id=?, site_id=?, owner_id=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.system_type ?? row.system_type,
      input.description ?? row.description,
      input.environment ?? row.environment,
      input.base_url ?? row.base_url,
      input.connection_ref ?? row.connection_ref,
      input.auth_method ?? row.auth_method,
      input.credential_id !== undefined ? input.credential_id : row.credential_id,
      input.protocols !== undefined ? toJson(input.protocols, []) : row.protocols_json,
      input.health_check !== undefined ? toJson(input.health_check, {}) : row.health_check_json,
      input.config !== undefined ? toJson(input.config, {}) : row.config_json,
      input.status ?? row.status,
      input.organization_id !== undefined ? input.organization_id : row.organization_id,
      input.plant_id !== undefined ? input.plant_id : row.plant_id,
      input.site_id !== undefined ? input.site_id : row.site_id,
      input.owner_id !== undefined ? input.owner_id : row.owner_id,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.system.update", resourceType: "external_system", resourceId: row.id, details: { code: row.code } });
  return publicExternalSystem(queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [row.id]));
}

export function deleteExternalSystem(db, ref, actor = null) {
  const row = getSystemRow(db, ref);
  if (!row) throw new HttpError(404, "External system not found");
  const used = queryOne(db, "SELECT 1 AS x FROM integration_definitions WHERE source_system_id = ? OR target_system_id = ? LIMIT 1", [row.id, row.id]);
  if (used) throw new HttpError(409, "External system is referenced by an integration definition");
  run(db, "DELETE FROM external_systems WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.system.delete", resourceType: "external_system", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

function adapterTypeForSystem(system) {
  if (system.system_type === "sap") return "rest";
  if (system.system_type === "plm" || system.system_type === "cad") return "rest";
  if (system.system_type === "mes") return "message_queue";
  if (system.auth_method === "signature") return "webhook";
  return "rest";
}

// Tests a system connection without leaking credentials. Network calls are only
// attempted by adapters that actually open a connection; the default REST check
// validates configuration and (for non-private hosts) reachability metadata.
export function testConnection(db, ref, actor = null, ip = null) {
  const row = getSystemRow(db, ref);
  if (!row) throw new HttpError(404, "External system not found");
  const started = Date.now();
  let status = "healthy";
  let message = "Connection configuration is valid";
  const detail = { auth_method: row.auth_method, base_url: row.base_url ? row.base_url.replace(/\/\/[^@/]+@/, "//***@") : "", adapter: adapterTypeForSystem(row) };
  try {
    if (row.base_url) {
      const allowPrivate = Boolean(process.env.INTEGRATION_ALLOW_PRIVATE_HOSTS === "true");
      const parsed = assertSafeUrl(row.base_url, { allowPrivate });
      detail.host = parsed.host;
    }
    if (row.credential_id) {
      const resolved = resolveCredentialSecret(db, row.credential_id);
      if (!resolved.secret && resolved.kind && resolved.kind !== "none") {
        status = "degraded";
        message = "Credential reference exists but has no stored secret";
      }
    }
    if (row.status !== "active") {
      status = "degraded";
      message = `System is ${row.status}`;
    }
  } catch (error) {
    status = "down";
    message = error.message;
  }
  const latency = Date.now() - started;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO integration_health_checks (system_id, status, latency_ms, message, detail_json, tenant_id, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, status, latency, message, toJson(detail, {}), row.tenant_id ?? null, ts]
  );
  run(
    db,
    "UPDATE external_systems SET connection_status = ?, last_health_at = ?, last_health_message = ?, updated_at = ? WHERE id = ?",
    [status, ts, message, ts, row.id]
  );
  auditIntegration(db, { actor, action: "integration.system.test_connection", resourceType: "external_system", resourceId: row.id, details: { status, latency_ms: latency }, ip, status: status === "down" ? "failure" : "success" });
  return { ok: status !== "down", status, message, latency_ms: latency, system: publicExternalSystem(queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [row.id])) };
}

export function listHealthChecks(db, systemRef, { limit = 50 } = {}) {
  const row = getSystemRow(db, systemRef);
  if (!row) throw new HttpError(404, "External system not found");
  return queryAll(
    db,
    "SELECT * FROM integration_health_checks WHERE system_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?",
    [row.id, Number(limit)]
  ).map((r) => publicHealthCheck(r));
}
