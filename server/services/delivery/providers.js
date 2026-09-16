import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import {
  SECRET_KEYS,
  publicProvider,
  getProviderRow,
  getProvider,
  listProviders,
  providerConfig,
  providerSecrets,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  providerForChannel,
  ensureDefaultProviders,
} from "../notifications/providers.js";
import { assertProviderType } from "../notifications/validation.js";

// Provider configuration for the Communication & Delivery Services module.
// Providers are stored in the shared `notification_providers` table so the
// notification console and the delivery console configure the same records.
// Credentials are encrypted at rest and never returned to clients.

export {
  SECRET_KEYS,
  getProviderRow,
  getProvider,
  providerConfig,
  providerSecrets,
  assertProviderType,
  ensureDefaultProviders,
};

export function publicDeliveryProvider(rowOrId, maybeId) {
  const row = typeof rowOrId === "object" && rowOrId !== null && rowOrId.code !== undefined
    ? rowOrId
    : getProviderRow(maybeId ?? rowOrId);
  return publicProvider(row);
}

// Lists providers with delivery filters: channel, enabled/status, tenant.
export function listDeliveryProviders(db, query = {}) {
  const where = [];
  const params = [];
  if (query.channel) {
    where.push("channel = ?");
    params.push(query.channel);
  }
  if (query.type) {
    where.push("type = ?");
    params.push(query.type);
  }
  if (query.tenantId !== undefined && query.tenantId !== null && query.tenantId !== "") {
    where.push("(tenant_id IS NULL OR COALESCE(tenant_id, 0) = ?)");
    params.push(Number(query.tenantId));
  }
  if (query.status) {
    where.push("COALESCE(status, CASE WHEN enabled = 1 THEN 'active' ELSE 'inactive' END) = ?");
    params.push(query.status);
  }
  if (query.enabled !== undefined && query.enabled !== "") {
    where.push("enabled = ?");
    params.push(query.enabled === true || query.enabled === "true" || query.enabled === "1" ? 1 : 0);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return queryAll(
    db,
    `SELECT * FROM notification_providers ${clause}
      ORDER BY channel, COALESCE(tenant_id, 0), is_default DESC, priority, name`,
    params
  ).map(publicProvider);
}

export function getDeliveryProvider(db, idOrCode) {
  return publicProvider(getProvider(db, idOrCode));
}

export function createDeliveryProvider(db, body = {}, actor = null, ip = null) {
  return createProvider(db, body, actor, ip);
}

export function updateDeliveryProvider(db, id, body = {}, actor = null, ip = null) {
  return updateProvider(db, id, body, actor, ip);
}

export function deleteDeliveryProvider(db, id, actor = null, ip = null) {
  return deleteProvider(db, id, actor, ip);
}

// Activation is a first-class operation: disabling keeps the configuration but
// removes the provider from failover resolution.
export function setDeliveryProviderStatus(db, id, status, actor = null, ip = null) {
  const current = getProvider(db, id);
  const next = String(status || "").toLowerCase();
  if (!["active", "inactive", "disabled"].includes(next)) {
    throw new HttpError(400, "status must be active or inactive");
  }
  const enabled = next === "active" ? 1 : 0;
  const normalized = next === "disabled" ? "inactive" : next;
  run(db, "UPDATE notification_providers SET enabled = ?, status = ?, updated_at = ? WHERE id = ?", [
    enabled,
    normalized,
    nowIso(),
    current.id,
  ]);
  writeAudit(db, { actor, action: "delivery.provider.status", resourceType: "delivery_provider", resourceId: current.id, details: { code: current.code, status: normalized, enabled }, ip });
  return publicProvider(getProviderRow(db, current.id));
}

export function testDeliveryProvider(db, idOrCode, options = {}) {
  return testProvider(db, idOrCode, options);
}

// Ordered failover chain for a channel. A tenant-specific provider always wins
// over a global one, then explicit default, then priority, then non-store
// transports, then insertion order.
export function resolveProviderChain(db, { channel, tenantId = null, exclude = [] } = {}) {
  if (!channel) return [];
  const rows = queryAll(
    db,
    `SELECT * FROM notification_providers
      WHERE channel = ? AND enabled = 1 AND COALESCE(status, 'active') = 'active'
      ORDER BY
        CASE WHEN ? IS NOT NULL AND tenant_id = ? THEN 0 ELSE 1 END,
        is_default DESC,
        priority ASC,
        (type = 'store') DESC,
        id`,
    [channel, tenantId ?? null, tenantId ?? null]
  );
  const excluded = new Set(exclude.map((value) => String(value)));
  const chain = rows.filter((row) => !excluded.has(String(row.code)) && !excluded.has(String(row.id)));
  if (!chain.length) {
    const fallback = providerForChannel(db, channel);
    if (fallback.row && !excluded.has(String(fallback.row.code)) && !excluded.has(String(fallback.row.id))) {
      return [fallback.row];
    }
    return [];
  }
  return chain;
}

export function defaultDeliveryProvider(db, channel, tenantId = null) {
  return resolveProviderChain(db, { channel, tenantId })[0] || null;
}

// Records a provider failure for the "view provider failures" view and returns
// the created row. Kept lightweight: failures are diagnostics, not workflows.
export function recordProviderFailure(db, { provider, requestId = null, tenantId = null, channel = "", errorCode = "", errorMessage = "", permanent = false } = {}) {
  const result = run(
    db,
    `INSERT INTO delivery_provider_failures
      (provider_id, provider_code, request_id, tenant_id, channel, error_code, error_message, permanent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      provider?.id ?? null,
      provider?.code ?? "",
      requestId ?? null,
      tenantId ?? null,
      channel || provider?.channel || "",
      String(errorCode || ""),
      String(errorMessage || ""),
      permanent ? 1 : 0,
      nowIso(),
    ]
  );
  return queryOne(db, "SELECT * FROM delivery_provider_failures WHERE id = ?", [result.lastInsertRowid]);
}

export function listProviderFailures(db, query = {}, tenantId = null) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(tenantId));
  }
  if (query.provider) {
    where.push("provider_code = ?");
    params.push(query.provider);
  }
  if (query.channel) {
    where.push("channel = ?");
    params.push(query.channel);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || 50));
  return queryAll(
    db,
    `SELECT * FROM delivery_provider_failures ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit]
  ).map((row) => ({
    id: row.id,
    provider_id: row.provider_id ?? null,
    provider_code: row.provider_code || "",
    request_id: row.request_id ?? null,
    tenant_id: row.tenant_id ?? null,
    channel: row.channel || "",
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    permanent: row.permanent === 1,
    created_at: row.created_at,
  }));
}

function providerStatusValue(row) {
  return row.status || (row.enabled === 1 ? "active" : "inactive");
}

// Availability snapshot for the operational dashboard.
export function providerHealth(db, tenantId = null) {
  const params = [];
  const clause = tenantId ? "WHERE (tenant_id IS NULL OR COALESCE(tenant_id, 0) = ?)" : "";
  if (tenantId) params.push(Number(tenantId));
  const rows = queryAll(db, `SELECT * FROM notification_providers ${clause}`, params);
  const failures = queryAll(
    db,
    `SELECT provider_code, COUNT(*) AS count FROM delivery_provider_failures
      ${tenantId ? "WHERE (tenant_id IS NULL OR COALESCE(tenant_id, 0) = ?)" : ""}
      GROUP BY provider_code`,
    tenantId ? [Number(tenantId)] : []
  );
  const failureMap = failures.reduce((acc, row) => {
    acc[row.provider_code] = row.count;
    return acc;
  }, {});
  const items = rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    channel: row.channel,
    type: row.type,
    enabled: row.enabled === 1,
    status: providerStatusValue(row),
    available: row.enabled === 1 && providerStatusValue(row) === "active",
    last_test_status: row.last_test_status || "",
    last_tested_at: row.last_tested_at || null,
    failures: failureMap[row.code] || 0,
  }));
  const available = items.filter((item) => item.available).length;
  return {
    total: items.length,
    available,
    unavailable: items.length - available,
    availability: items.length ? Math.round((available / items.length) * 1000) / 10 : 0,
    items,
  };
}

export { listProviders };
