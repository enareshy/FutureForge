// Observability dashboards and widget rendering.
//
// Dashboards are configuration: a named set of widgets over observability
// signals. Rendering is done server-side (metric cards/trends, health, alert,
// freshness, SLO and incident summaries) so a client never has to assemble a
// view or hold business logic. Dashboard definitions can be mirrored into the
// shared Reporting & Analytics engine (see reporting-bridge.js) for BI reuse.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { DASHBOARD_CATALOG, DEFAULT_DASHBOARD_CODE } from "./constants.js";
import { dashboardRef, widgetRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged } from "./repository.js";
import { dashboardNotFound, dashboardConflict, invalidDashboard, widgetNotFound } from "./errors.js";
import { recordHistory } from "./history.js";
import { latestObservationFor, metricHistory, getMetricRow } from "./metrics.js";
import { currentHealth } from "./health.js";
import { alertSummary, listAlerts } from "./alerts.js";
import { freshnessSummary } from "./freshness.js";
import { sloSummary } from "./slo.js";
import { listIncidents, incidentSummary } from "./incidents.js";

export function publicDashboard(row) {
  if (!row) return null;
  return {
    id: row.id,
    dashboard_ref: row.dashboard_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    scope: row.scope,
    is_default: Boolean(row.is_default),
    reporting_dashboard_ref: row.reporting_dashboard_ref,
    config: parseJson(row.config_json, {}),
    version: row.version,
    status: row.status,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicWidget(row) {
  if (!row) return null;
  return {
    id: row.id,
    widget_ref: row.widget_ref,
    dashboard_id: row.dashboard_id,
    tenant_id: row.tenant_id,
    widget_type: row.widget_type,
    title: row.title,
    description: row.description,
    metric_code: row.metric_code,
    provider_code: row.provider_code,
    visualization: row.visualization,
    config: parseJson(row.config_json, {}),
    layout: parseJson(row.layout_json, {}),
    sequence: row.sequence,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getDashboardRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_dashboards WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_dashboards WHERE tenant_id = ? AND (dashboard_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getDashboard(db, tenantId, ref) {
  const row = getDashboardRow(db, tenantId, ref);
  if (!row) throw dashboardNotFound(ref);
  const widgets = queryAll(db, "SELECT * FROM observability_dashboard_widgets WHERE dashboard_id = ? ORDER BY sequence, id", [row.id]).map(publicWidget);
  return { ...publicDashboard(row), widgets };
}

export function createDashboard(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidDashboard("Dashboard code is required");
  if (queryOne(db, "SELECT id FROM observability_dashboards WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw dashboardConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_dashboards (dashboard_ref, tenant_id, organization_id, code, name, description, scope, is_default, reporting_dashboard_ref, config_json, version, status, owner_user_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      input.dashboard_ref || dashboardRef(code),
      Number(tenantId),
      input.organization_id ?? null,
      code,
      String(input.name || code),
      String(input.description || ""),
      String(input.scope || "PLATFORM").toUpperCase(),
      input.is_default ? 1 : 0,
      input.reporting_dashboard_ref ?? null,
      stringifyJson(input.config || {}),
      String(input.status || "ACTIVE").toUpperCase(),
      input.owner_user_id ?? actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_dashboards WHERE id = ?", [Number(result.lastInsertRowid)]);
  for (const [index, widget] of (Array.isArray(input.widgets) ? input.widgets : []).entries()) {
    run(
      db,
      `INSERT INTO observability_dashboard_widgets (widget_ref, dashboard_id, tenant_id, widget_type, title, description, metric_code, provider_code, visualization, config_json, layout_json, sequence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        widgetRef(),
        row.id,
        Number(tenantId),
        String(widget.widget_type || widget.type || "METRIC_CARD").toUpperCase(),
        String(widget.title || ""),
        String(widget.description || ""),
        widget.metric_code || widget.metric || null,
        widget.provider_code || null,
        String(widget.visualization || "LINE").toUpperCase(),
        stringifyJson(widget.config || {}),
        stringifyJson(widget.layout || {}),
        index,
        ts,
        ts,
      ]
    );
  }
  recordHistory(db, { tenantId, action: "DASHBOARD_CREATED", entityType: "dashboard", entityId: row.id, entityRef: row.dashboard_ref, actor, summary: `Dashboard ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.dashboard.create", resource_type: "observability_dashboard", resource_id: row.dashboard_ref, details: { code } });
  return getDashboard(db, tenantId, row.dashboard_ref);
}

export function updateDashboard(db, tenantId, ref, input = {}, actor = null) {
  const row = getDashboardRow(db, tenantId, ref);
  if (!row) throw dashboardNotFound(ref);
  run(
    db,
    "UPDATE observability_dashboards SET name = ?, description = ?, scope = ?, is_default = ?, config_json = ?, status = ?, owner_user_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.scope ? String(input.scope).toUpperCase() : row.scope,
      input.is_default !== undefined ? (input.is_default ? 1 : 0) : row.is_default,
      input.config !== undefined ? stringifyJson(input.config) : row.config_json,
      input.status ? String(input.status).toUpperCase() : row.status,
      input.owner_user_id !== undefined ? input.owner_user_id : row.owner_user_id,
      nowIso(),
      row.id,
    ]
  );
  recordHistory(db, { tenantId, action: "DASHBOARD_UPDATED", entityType: "dashboard", entityId: row.id, entityRef: row.dashboard_ref, actor, summary: `Dashboard ${row.code} updated` });
  return getDashboard(db, tenantId, row.dashboard_ref);
}

export function deleteDashboard(db, tenantId, ref, actor = null) {
  const row = getDashboardRow(db, tenantId, ref);
  if (!row) throw dashboardNotFound(ref);
  run(db, "UPDATE observability_dashboards SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "DASHBOARD_ARCHIVED", entityType: "dashboard", entityId: row.id, entityRef: row.dashboard_ref, actor, summary: `Dashboard ${row.code} archived` });
  return { archived: true, dashboard_ref: row.dashboard_ref };
}

export function listDashboards(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.scope) {
    where.push("scope = ?");
    params.push(String(query.scope).toUpperCase());
  }
  const result = paged(db, "observability_dashboards", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicDashboard });
  result.items = result.items.map((dashboard) => ({ ...dashboard, widget_count: Number(queryOne(db, "SELECT COUNT(*) AS c FROM observability_dashboard_widgets WHERE dashboard_id = ?", [dashboard.id])?.c || 0) }));
  return result;
}

export function getWidgetRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_dashboard_widgets WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_dashboard_widgets WHERE tenant_id = ? AND widget_ref = ?", [Number(tenantId), raw]);
}

export function addWidget(db, tenantId, dashboardRef, input = {}, actor = null) {
  const dashboard = getDashboardRow(db, tenantId, dashboardRef);
  if (!dashboard) throw dashboardNotFound(dashboardRef);
  const ts = nowIso();
  const maxSeq = Number(queryOne(db, "SELECT COALESCE(MAX(sequence), -1) AS s FROM observability_dashboard_widgets WHERE dashboard_id = ?", [dashboard.id])?.s ?? -1);
  const result = run(
    db,
    `INSERT INTO observability_dashboard_widgets (widget_ref, dashboard_id, tenant_id, widget_type, title, description, metric_code, provider_code, visualization, config_json, layout_json, sequence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      widgetRef(),
      dashboard.id,
      Number(tenantId),
      String(input.widget_type || input.type || "METRIC_CARD").toUpperCase(),
      String(input.title || ""),
      String(input.description || ""),
      input.metric_code || input.metric || null,
      input.provider_code || null,
      String(input.visualization || "LINE").toUpperCase(),
      stringifyJson(input.config || {}),
      stringifyJson(input.layout || {}),
      maxSeq + 1,
      ts,
      ts,
    ]
  );
  recordHistory(db, { tenantId, action: "WIDGET_ADDED", entityType: "dashboard", entityId: dashboard.id, entityRef: dashboard.dashboard_ref, actor, summary: `Widget added to ${dashboard.code}` });
  return publicWidget(queryOne(db, "SELECT * FROM observability_dashboard_widgets WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateWidget(db, tenantId, ref, input = {}, actor = null) {
  const row = getWidgetRow(db, tenantId, ref);
  if (!row) throw widgetNotFound(ref);
  run(
    db,
    "UPDATE observability_dashboard_widgets SET widget_type = ?, title = ?, description = ?, metric_code = ?, provider_code = ?, visualization = ?, config_json = ?, layout_json = ?, sequence = ?, status = ?, updated_at = ? WHERE id = ?",
    [
      input.widget_type ? String(input.widget_type).toUpperCase() : row.widget_type,
      input.title ?? row.title,
      input.description ?? row.description,
      input.metric_code !== undefined ? input.metric_code : row.metric_code,
      input.provider_code !== undefined ? input.provider_code : row.provider_code,
      input.visualization ? String(input.visualization).toUpperCase() : row.visualization,
      input.config !== undefined ? stringifyJson(input.config) : row.config_json,
      input.layout !== undefined ? stringifyJson(input.layout) : row.layout_json,
      input.sequence !== undefined ? Number(input.sequence) : row.sequence,
      input.status ? String(input.status).toUpperCase() : row.status,
      nowIso(),
      row.id,
    ]
  );
  return publicWidget(queryOne(db, "SELECT * FROM observability_dashboard_widgets WHERE id = ?", [row.id]));
}

export function removeWidget(db, tenantId, ref, actor = null) {
  const row = getWidgetRow(db, tenantId, ref);
  if (!row) throw widgetNotFound(ref);
  run(db, "UPDATE observability_dashboard_widgets SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "WIDGET_REMOVED", entityType: "dashboard", entityId: row.dashboard_id, entityRef: `widget:${row.widget_ref}`, actor, summary: `Widget ${row.widget_ref} archived` });
  return { archived: true, widget_ref: row.widget_ref };
}

// Renders a single widget into its data payload.
export function renderWidget(db, tenantId, widget) {
  const snapshot = { widget_ref: widget.widget_ref, type: widget.widget_type, title: widget.title, visualization: widget.visualization };
  try {
    switch (widget.widget_type) {
      case "METRIC_CARD": {
        if (!widget.metric_code) return { ...snapshot, data: null, error: "metric_code required" };
        const latest = latestObservationFor(db, tenantId, widget.metric_code);
        return { ...snapshot, data: latest ? { value: latest.value, unit: latest.unit, observed_at: latest.observed_at, metric_code: latest.metric_code } : null };
      }
      case "METRIC_TREND": {
        if (!widget.metric_code) return { ...snapshot, data: null, error: "metric_code required" };
        const metric = getMetricRow(db, tenantId, widget.metric_code);
        if (!metric) return { ...snapshot, data: null, error: "metric not found" };
        const history = metricHistory(db, tenantId, widget.metric_code, { limit: 200, window_seconds: widget.config?.window_seconds || 604800 });
        return { ...snapshot, data: { summary: history.summary, points: history.points.slice(-60) } };
      }
      case "HEALTH_STATUS":
        return { ...snapshot, data: currentHealth(db, tenantId) };
      case "ALERT_SUMMARY":
        return { ...snapshot, data: { summary: alertSummary(db, tenantId), recent: listAlerts(db, tenantId, { open: true, page_size: 5 }).items } };
      case "FRESHNESS_SUMMARY": {
        const summary = freshnessSummary(db, tenantId);
        return { ...snapshot, data: { total: summary.total, buckets: summary.buckets, items: summary.items.slice(0, 10) } };
      }
      case "SLO_SUMMARY": {
        const summary = sloSummary(db, tenantId);
        return { ...snapshot, data: { total: summary.total, compliant: summary.compliant, at_risk: summary.at_risk, breached: summary.breached, evaluations: summary.evaluations.slice(0, 10) } };
      }
      case "INCIDENT_LIST":
        return { ...snapshot, data: { summary: incidentSummary(db, tenantId), incidents: listIncidents(db, tenantId, { open: true, page_size: 10 }).items } };
      case "TEXT":
        return { ...snapshot, data: { text: widget.config?.text || widget.description || "" } };
      default:
        return { ...snapshot, data: null, error: `Unsupported widget type: ${widget.widget_type}` };
    }
  } catch (err) {
    return { ...snapshot, data: null, error: err.message };
  }
}

export function renderDashboard(db, tenantId, ref) {
  const dashboard = getDashboard(db, tenantId, ref);
  const widgets = dashboard.widgets.map((widget) => ({ ...renderWidget(db, tenantId, widget), layout: widget.layout, sequence: widget.sequence }));
  return { dashboard: { ...dashboard, widgets: undefined }, widgets, generated_at: nowIso() };
}

export function defaultDashboard(db, tenantId) {
  const row =
    queryOne(db, "SELECT * FROM observability_dashboards WHERE tenant_id = ? AND is_default = 1 AND status = 'ACTIVE' ORDER BY id LIMIT 1", [Number(tenantId)]) ||
    getDashboardRow(db, tenantId, DEFAULT_DASHBOARD_CODE);
  return row ? renderDashboard(db, tenantId, row.dashboard_ref) : null;
}

// Idempotent creation of the curated dashboards.
export function ensureDefaultDashboards(db, tenantId, actor = null) {
  let created = 0;
  for (const catalog of DASHBOARD_CATALOG) {
    const existing = getDashboardRow(db, tenantId, catalog.code);
    if (existing) {
      if (catalog.is_default && !existing.is_default) {
        run(db, "UPDATE observability_dashboards SET is_default = 1, updated_at = ? WHERE id = ?", [nowIso(), existing.id]);
      }
      continue;
    }
    createDashboard(
      db,
      tenantId,
      {
        code: catalog.code,
        name: catalog.name,
        description: catalog.description,
        scope: catalog.scope,
        is_default: catalog.is_default,
        widgets: catalog.widgets.map((widget) => ({ ...widget, metric_code: widget.metric || null })),
      },
      actor
    );
    created += 1;
  }
  return { created };
}
