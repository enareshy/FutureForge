// Observability for Enterprise Reference Data Management: health endpoints,
// metrics and the stewardship dashboard summary. Pure read-only aggregation.
import { queryAll, queryOne } from "../../db.js";
import { getCacheEpoch } from "./cache.js";

function tenantClause(tenantId, column = "tenant_id") {
  if (tenantId === null || tenantId === undefined) return { clause: "", params: [] };
  return { clause: `AND (${column} IS NULL OR ${column} = ?)`, params: [Number(tenantId)] };
}

export function metricsSnapshot(db, { tenantId = null } = {}) {
  const tenant = tenantClause(tenantId);
  const domainsByStatus = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM reference_domains WHERE 1 = 1 ${tenant.clause} GROUP BY status`,
    tenant.params
  );
  const itemsByStatus = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM reference_data_items WHERE 1 = 1 ${tenant.clause} GROUP BY status`,
    tenant.params
  );
  const totals = {
    domains: Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_domains WHERE 1 = 1 ${tenant.clause}`, tenant.params)?.c ?? 0),
    items: Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_data_items WHERE 1 = 1 ${tenant.clause}`, tenant.params)?.c ?? 0),
    active_items: Number(
      queryOne(db, `SELECT COUNT(*) AS c FROM reference_data_items WHERE status = 'active' ${tenant.clause}`, tenant.params)?.c ?? 0
    ),
    codes: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_codes WHERE 1 = 1", [])?.c ?? 0),
    aliases: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_aliases WHERE 1 = 1", [])?.c ?? 0),
    translations: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_translations WHERE 1 = 1", [])?.c ?? 0),
    hierarchy_edges: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_hierarchy WHERE 1 = 1", [])?.c ?? 0),
    relationships: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_relationships WHERE 1 = 1", [])?.c ?? 0),
    pending_approvals: Number(
      queryOne(db, `SELECT COUNT(*) AS c FROM reference_approvals WHERE status IN ('submitted','under_review') ${tenant.clause}`, tenant.params)?.c ?? 0
    ),
    versions: Number(queryOne(db, "SELECT COUNT(*) AS c FROM reference_data_versions WHERE 1 = 1", [])?.c ?? 0),
    global_items: Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_data_items WHERE is_global = 1 ${tenant.clause}`, tenant.params)?.c ?? 0),
    tenant_items: Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_data_items WHERE is_global = 0 ${tenant.clause}`, tenant.params)?.c ?? 0),
  };
  const distinctDomains = Number(
    queryOne(db, `SELECT COUNT(DISTINCT domain_id) AS c FROM reference_data_items WHERE 1 = 1 ${tenant.clause}`, tenant.params)?.c ?? 0
  );
  const orphanRetiredCodes = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM reference_data_items WHERE status = 'retired' ${tenant.clause}`,
      tenant.params
    )?.c ?? 0
  );
  return {
    tenant_id: tenantId,
    cache_epoch: getCacheEpoch(db),
    totals: { ...totals, domains_with_items: distinctDomains, retired_items: orphanRetiredCodes },
    domains_by_status: Object.fromEntries(domainsByStatus.map((row) => [row.status, row.count])),
    items_by_status: Object.fromEntries(itemsByStatus.map((row) => [row.status, row.count])),
    generated_at: new Date().toISOString(),
  };
}

export function dashboardSummary(db, { tenantId = null } = {}) {
  const metrics = metricsSnapshot(db, { tenantId });
  const tenant = tenantClause(tenantId, "i.tenant_id");
  const topDomains = queryAll(
    db,
    `SELECT d.id, d.code, d.name, COUNT(i.id) AS item_count
     FROM reference_domains d
     LEFT JOIN reference_data_items i ON i.domain_id = d.id
     WHERE 1 = 1 ${tenant.clause}
     GROUP BY d.id ORDER BY item_count DESC, d.code LIMIT 10`,
    tenant.params
  );
  const recentItems = queryAll(
    db,
    `SELECT i.id, i.item_ref, i.code, i.name, i.status, i.scope_key, i.updated_at, d.code AS domain_code
     FROM reference_data_items i LEFT JOIN reference_domains d ON d.id = i.domain_id
     WHERE 1 = 1 ${tenant.clause}
     ORDER BY i.updated_at DESC LIMIT 10`,
    tenant.params
  );
  const pendingApprovals = queryAll(
    db,
    `SELECT a.id, a.approval_ref, a.status, a.submitted_at, i.code AS item_code, i.item_ref
     FROM reference_approvals a LEFT JOIN reference_data_items i ON i.id = a.item_id
     WHERE a.status IN ('submitted','under_review')
     ${tenantClause(tenantId, "a.tenant_id").clause}
     ORDER BY a.submitted_at DESC LIMIT 10`,
    tenantClause(tenantId, "a.tenant_id").params
  );
  return { metrics, top_domains: topDomains, recent_items: recentItems, pending_approvals: pendingApprovals };
}

export function healthCheck(db, { tenantId = null } = {}) {
  let metrics = null;
  let healthy = true;
  let error = null;
  try {
    metrics = metricsSnapshot(db, { tenantId });
  } catch (err) {
    healthy = false;
    error = err.message;
  }
  return {
    status: healthy ? "ok" : "unhealthy",
    service: "reference",
    ready: healthy,
    live: true,
    healthy,
    pending_approvals: metrics?.totals?.pending_approvals ?? 0,
    error,
    metrics,
    timestamp: new Date().toISOString(),
  };
}
