// Configurable caching (§31).
//
// Caches KPI values, dashboard widgets, frequently executed reports, metadata
// and semantic definitions. Cache keys embed the tenant and a security-context
// fingerprint so cached analytical data is never served across tenants or
// authorization scopes. Expiry is enforced on read; a maintenance job prunes
// stale entries.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { parseJson, stringifyJson } from "./repository.js";

export function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

export function securityFingerprint({ tenantId, organizationId = null, userId = null, roles = [] }) {
  return fingerprint([Number(tenantId) || 0, organizationId ?? null, userId ?? null, [...(roles || [])].sort()]);
}

export function buildCacheKey(scope, parts) {
  return `${scope}:${fingerprint(parts)}`;
}

export function getCached(db, cacheKey) {
  const row = queryOne(db, "SELECT * FROM reporting_cache WHERE cache_key = ?", [cacheKey]);
  if (!row) return null;
  if (row.expires_at && row.expires_at <= nowIso()) {
    run(db, "DELETE FROM reporting_cache WHERE cache_key = ?", [cacheKey]);
    return null;
  }
  return parseJson(row.payload_json, null);
}

export function setCached(db, { tenantId, scope, cacheKey, payload, ttlSeconds = 300, securityHash = "" }) {
  if (!cacheKey) return null;
  const ttl = Math.max(0, Number(ttlSeconds) || 0);
  if (ttl === 0) return null;
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const existing = queryOne(db, "SELECT id FROM reporting_cache WHERE cache_key = ?", [cacheKey]);
  if (existing) {
    run(db, "UPDATE reporting_cache SET payload_json = ?, expires_at = ?, security_hash = ?, tenant_id = ?, scope = ?, updated_at = ? WHERE id = ?", [
      stringifyJson(payload, "{}"),
      expiresAt,
      securityHash,
      Number(tenantId) || null,
      scope,
      ts,
      existing.id,
    ]);
  } else {
    run(
      db,
      "INSERT INTO reporting_cache (cache_key, tenant_id, scope, security_hash, payload_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [cacheKey, Number(tenantId) || null, scope, securityHash, stringifyJson(payload, "{}"), expiresAt, ts, ts]
    );
  }
  return { cache_key: cacheKey, expires_at: expiresAt };
}

export function invalidateScope(db, tenantId, scope = null) {
  if (scope) return run(db, "DELETE FROM reporting_cache WHERE tenant_id = ? AND scope = ?", [Number(tenantId), scope]).changes || 0;
  return run(db, "DELETE FROM reporting_cache WHERE tenant_id = ?", [Number(tenantId)]).changes || 0;
}

export function invalidateAll(db) {
  return run(db, "DELETE FROM reporting_cache", []).changes || 0;
}

export function pruneExpired(db) {
  return run(db, "DELETE FROM reporting_cache WHERE expires_at IS NOT NULL AND expires_at <= ?", [nowIso()]).changes || 0;
}

export function cacheStats(db, tenantId = null) {
  const clause = tenantId ? "WHERE tenant_id = ?" : "";
  const params = tenantId ? [Number(tenantId)] : [];
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reporting_cache ${clause}`, params)?.c || 0);
  const byScope = queryAll(db, `SELECT scope, COUNT(*) AS c FROM reporting_cache ${clause} GROUP BY scope`, params);
  return {
    total,
    by_scope: Object.fromEntries(byScope.map((row) => [row.scope, Number(row.c)])),
    source_module: "reporting",
  };
}
