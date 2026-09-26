// Dashboards, widgets and drill-down (§12–§14, §17, §18, §27).
//
// A dashboard is a versioned, shareable composition of widgets. Each widget is
// bound to a report, metric or KPI and is resolved server-side so a dashboard
// never leaks data the viewer could not read directly. Role-based dashboards
// are ordinary dashboards whose visibility scope is a role.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  DASHBOARD_STATUSES,
  IMMUTABLE_STATUSES,
  DASHBOARD_WIDGET_TYPES,
  VISIBILITY_SCOPES,
} from "./constants.js";
import { dashboardNotFound, dashboardConflict, invalidDashboard, widgetNotFound, securityBlocked } from "./errors.js";
import { dashboardRef as makeDashboardRef, widgetRef as makeWidgetRef } from "./identifiers.js";
import { publicDashboard, publicWidget, parseJson, stringifyJson } from "./repository.js";
import { canAccess } from "./visibility.js";
import { getReport, runReport } from "./reports.js";
import { getKpi, getKpiValue } from "./kpis.js";
import { computeMetric, getMetric } from "./metrics.js";
import { publishReportingEvent } from "./events.js";
import { recordHistory } from "./history.js";

function validateDashboard(input = {}) {
  if (!input.code || !String(input.code).trim()) throw invalidDashboard("Dashboard code is required");
  if (!input.name || !String(input.name).trim()) throw invalidDashboard("Dashboard name is required");
  const visibility = String(input.visibility || "PRIVATE").toUpperCase();
  if (!VISIBILITY_SCOPES.includes(visibility)) throw invalidDashboard(`Unsupported visibility scope: ${visibility}`);
  const dashboardType = String(input.dashboard_type || input.dashboardType || "OPERATIONAL").toUpperCase();
  return {
    code: String(input.code).trim().toUpperCase(),
    name: String(input.name).trim(),
    description: input.description ? String(input.description) : "",
    dashboard_type: dashboardType,
    layout: input.layout || {},
    visibility,
    visibility_subject: input.visibility_subject ?? input.visibilitySubject ?? null,
    is_default: input.is_default ?? input.isDefault ? 1 : 0,
    metadata: input.metadata || {},
    organization_id: input.organization_id ?? input.organizationId ?? null,
    site: input.site ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getDashboardById(db, tenantId, id) {
  return publicDashboard(queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getDashboard(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_dashboards WHERE tenant_id = ? AND (code = ? OR dashboard_ref = ?)", [Number(tenantId), raw.toUpperCase(), raw]);
  if (!row) throw dashboardNotFound(ref);
  return publicDashboard(row);
}

function dashboardShares(db, dashboardId) {
  return queryAll(db, "SELECT subject_type, subject_id FROM reporting_dashboard_shares WHERE dashboard_id = ?", [Number(dashboardId)]);
}

export function isDashboardVisible(db, actor, dashboard) {
  if (!dashboard) return false;
  return canAccess(db, actor, {
    ownerUserId: dashboard.owner_user_id,
    visibility: dashboard.visibility,
    subjectId: dashboard.visibility_subject,
    shares: dashboardShares(db, dashboard.id),
  });
}

export function assertDashboardVisible(db, actor, dashboard) {
  if (!isDashboardVisible(db, actor, dashboard)) throw securityBlocked({ reason: "DASHBOARD_NOT_VISIBLE", dashboard: dashboard?.code });
  return dashboard;
}

export function listDashboards(db, tenantId, query = {}, actor = null) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.dashboard_type || query.dashboardType) {
    where.push("dashboard_type = ?");
    params.push(String(query.dashboard_type || query.dashboardType).toUpperCase());
  }
  let rows = queryAll(db, `SELECT * FROM reporting_dashboards WHERE ${where.join(" AND ")} ORDER BY id DESC`, params);
  const search = query.search ? String(query.search).toLowerCase() : null;
  if (search) rows = rows.filter((row) => row.code.toLowerCase().includes(search) || row.name.toLowerCase().includes(search));
  if (actor) rows = rows.filter((row) => isDashboardVisible(db, actor, publicDashboard(row)));
  const total = rows.length;
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.page_size || query.pageSize) || 50));
  return { items: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(publicDashboard), total, page, pageSize };
}

export function listWidgets(db, tenantId, dashboardRef_) {
  const dashboard = getDashboard(db, tenantId, dashboardRef_);
  const rows = queryAll(db, "SELECT * FROM reporting_dashboard_widgets WHERE dashboard_id = ? AND tenant_id = ? ORDER BY sequence ASC, id ASC", [dashboard.id, Number(tenantId)]);
  return { items: rows.map(publicWidget), total: rows.length };
}

export function getWidget(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_dashboard_widgets WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_dashboard_widgets WHERE tenant_id = ? AND widget_ref = ?", [Number(tenantId), raw]);
  if (!row) throw widgetNotFound(ref);
  return publicWidget(row);
}

export function getDashboardWithWidgets(db, tenantId, ref) {
  const dashboard = getDashboard(db, tenantId, ref);
  return { ...dashboard, widgets: listWidgets(db, tenantId, dashboard.code).items };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export function createDashboard(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateDashboard(input);
  if (queryOne(db, "SELECT id FROM reporting_dashboards WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized.code])) {
    throw dashboardConflict(normalized.code);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_dashboards (dashboard_ref, tenant_id, organization_id, site, code, name, description, dashboard_type, layout_json, visibility, visibility_subject, owner_user_id, version, status, immutable, is_default, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DRAFT', 0, ?, ?, ?, ?, ?, ?)`,
    [
      makeDashboardRef(normalized.code),
      Number(tenantId),
      normalized.organization_id ?? null,
      normalized.site ?? null,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.dashboard_type,
      stringifyJson(normalized.layout),
      normalized.visibility,
      normalized.visibility_subject ?? null,
      input.owner_user_id ?? input.ownerUserId ?? actor?.id ?? null,
      normalized.is_default,
      stringifyJson(normalized.metadata),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const dashboardId = Number(result.lastInsertRowid);
  if (normalized.is_default) clearDefaultDashboard(db, Number(tenantId), dashboardId);
  if (input.shares) replaceDashboardShares(db, Number(tenantId), dashboardId, input.shares);
  for (const widget of input.widgets || []) addWidget(db, tenantId, dashboardId, widget, actor);
  const created = getDashboardById(db, Number(tenantId), dashboardId);
  writeAudit(db, { actor, action: "reporting.dashboard.create", resourceType: "reporting_dashboard", resourceId: normalized.code, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "DashboardCreated", payload: { code: normalized.code }, objectType: "reporting_dashboard", tenantId, organizationId: normalized.organization_id }, actor);
  recordHistory(db, { tenantId, action: "CREATE", entity_type: "dashboard", entity_id: dashboardId, entity_ref: created.dashboard_ref, actor_id: actor?.id, summary: `Created dashboard ${created.code}` });
  return created;
}

export function updateDashboard(db, tenantId, ref, input = {}, actor = null, ip = null) {
  const existing = getDashboard(db, tenantId, ref);
  const normalized = validateDashboard({ ...existing, ...input, code: existing.code });
  const ts = nowIso();
  let version = existing.version;
  let status = existing.status;
  const immutable = IMMUTABLE_STATUSES.includes(existing.status);
  if (immutable) {
    snapshotDashboard(db, queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ?", [existing.id]), existing.status, "Rolled forward from published version", actor?.id);
    version = existing.version + 1;
    status = "DRAFT";
  }
  run(
    db,
    `UPDATE reporting_dashboards SET name = ?, description = ?, dashboard_type = ?, layout_json = ?, visibility = ?, visibility_subject = ?, version = ?, status = ?, immutable = 0, is_default = ?, metadata_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      normalized.name,
      normalized.description,
      normalized.dashboard_type,
      stringifyJson(normalized.layout),
      normalized.visibility,
      normalized.visibility_subject ?? null,
      version,
      status,
      normalized.is_default,
      stringifyJson(normalized.metadata),
      actor?.id ?? null,
      ts,
      existing.id,
      Number(tenantId),
    ]
  );
  if (normalized.is_default) clearDefaultDashboard(db, Number(tenantId), existing.id);
  if (input.shares) replaceDashboardShares(db, Number(tenantId), existing.id, input.shares);
  writeAudit(db, { actor, action: "reporting.dashboard.update", resourceType: "reporting_dashboard", resourceId: existing.code, details: { version, rolled_forward: immutable }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "DashboardCreated", payload: { code: existing.code, action: "updated", version }, objectType: "reporting_dashboard", tenantId }, actor);
  return getDashboardById(db, Number(tenantId), existing.id);
}

export function publishDashboard(db, tenantId, ref, actor = null) {
  const existing = getDashboard(db, tenantId, ref);
  snapshotDashboard(db, queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ?", [existing.id]), "ACTIVE", "Published", actor?.id);
  const ts = nowIso();
  run(db, "UPDATE reporting_dashboards SET status = 'ACTIVE', immutable = 1, published_at = ?, published_by = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
    ts,
    actor?.id ?? null,
    actor?.id ?? null,
    ts,
    existing.id,
    Number(tenantId),
  ]);
  writeAudit(db, { actor, action: "reporting.dashboard.publish", resourceType: "reporting_dashboard", resourceId: existing.code, sourceModule: "reporting" });
  publishReportingEvent(db, { eventType: "DashboardPublished", payload: { code: existing.code, version: existing.version }, objectType: "reporting_dashboard", tenantId }, actor);
  return getDashboardById(db, Number(tenantId), existing.id);
}

export function setDashboardStatus(db, tenantId, ref, status, actor = null) {
  const existing = getDashboard(db, tenantId, ref);
  const next = String(status || "").toUpperCase();
  if (!DASHBOARD_STATUSES.includes(next)) throw invalidDashboard(`Unsupported dashboard status: ${status}`);
  run(db, "UPDATE reporting_dashboards SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [next, actor?.id ?? null, nowIso(), existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.dashboard.status", resourceType: "reporting_dashboard", resourceId: existing.code, details: { status: next }, sourceModule: "reporting" });
  return getDashboardById(db, Number(tenantId), existing.id);
}

export function deleteDashboard(db, tenantId, ref, actor = null) {
  const existing = getDashboard(db, tenantId, ref);
  run(db, "DELETE FROM reporting_dashboard_widgets WHERE dashboard_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_dashboard_versions WHERE dashboard_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_dashboard_shares WHERE dashboard_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_dashboards WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.dashboard.delete", resourceType: "reporting_dashboard", resourceId: existing.code, sourceModule: "reporting" });
  return { deleted: true, code: existing.code };
}

export function cloneDashboard(db, tenantId, ref, input = {}, actor = null) {
  const existing = getDashboardWithWidgets(db, tenantId, ref);
  return createDashboard(
    db,
    tenantId,
    { ...existing, code: input.code || `${existing.code}_COPY`, name: input.name || `${existing.name} (Copy)`, status: "DRAFT", organization_id: input.organization_id ?? existing.organization_id, widgets: existing.widgets.map((widget) => ({ ...widget })) },
    actor
  );
}

export function replaceDashboardShares(db, tenantId, dashboardId, shares = []) {
  run(db, "DELETE FROM reporting_dashboard_shares WHERE dashboard_id = ? AND tenant_id = ?", [Number(dashboardId), Number(tenantId)]);
  for (const share of shares) {
    const subjectType = String(share.subject_type || share.subjectType || "USER").toUpperCase();
    run(db, "INSERT INTO reporting_dashboard_shares (tenant_id, dashboard_id, subject_type, subject_id, created_at) VALUES (?, ?, ?, ?, ?)", [Number(tenantId), Number(dashboardId), subjectType, Number(share.subject_id ?? share.subjectId), nowIso()]);
  }
  return shares.length;
}

function clearDefaultDashboard(db, tenantId, exceptId) {
  run(db, "UPDATE reporting_dashboards SET is_default = 0 WHERE tenant_id = ? AND id != ?", [Number(tenantId), Number(exceptId)]);
}

function snapshotDashboard(db, dashboardRow, status, changeSummary, actorId = null) {
  run(
    db,
    `INSERT INTO reporting_dashboard_versions (dashboard_id, tenant_id, version, status, change_summary, snapshot_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [dashboardRow.id, dashboardRow.tenant_id, dashboardRow.version, status, changeSummary || "", stringifyJson(publicDashboard(dashboardRow)), actorId, nowIso()]
  );
}

export function listDashboardVersions(db, tenantId, ref) {
  const dashboard = getDashboard(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM reporting_dashboard_versions WHERE dashboard_id = ? ORDER BY version DESC", [dashboard.id]);
  return { items: rows.map((row) => ({ version: row.version, status: row.status, change_summary: row.change_summary, snapshot: parseJson(row.snapshot_json, {}), created_by: row.created_by, created_at: row.created_at })), total: rows.length };
}

// ── Widgets ──────────────────────────────────────────────────────────────────

export function addWidget(db, tenantId, dashboardRef_, input = {}, actor = null) {
  const dashboard = getDashboard(db, tenantId, dashboardRef_);
  const widgetType = String(input.widget_type || input.widgetType || "TABLE").toUpperCase();
  if (!DASHBOARD_WIDGET_TYPES.includes(widgetType)) throw invalidDashboard(`Unsupported widget type: ${widgetType}`);
  const reportId = input.report_id ? getReport(db, tenantId, input.report_id).id : null;
  const kpiId = input.kpi_id ? getKpi(db, tenantId, input.kpi_id).id : null;
  const metricId = input.metric_id ? getMetric(db, tenantId, input.metric_id).id : null;
  const ts = nowIso();
  const sequence = input.sequence ?? Number(queryOne(db, "SELECT COALESCE(MAX(sequence), 0) AS s FROM reporting_dashboard_widgets WHERE dashboard_id = ?", [dashboard.id])?.s || 0) + 1;
  const result = run(
    db,
    `INSERT INTO reporting_dashboard_widgets (widget_ref, dashboard_id, tenant_id, widget_type, title, report_id, kpi_id, metric_id, sequence, config_json, layout_json, filters_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      makeWidgetRef(),
      dashboard.id,
      Number(tenantId),
      widgetType,
      input.title ? String(input.title) : widgetType,
      reportId,
      kpiId,
      metricId,
      sequence,
      stringifyJson(input.config || {}),
      stringifyJson(input.layout || {}),
      stringifyJson(input.filters || [], "[]"),
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "reporting.widget.create", resourceType: "reporting_widget", resourceId: String(result.lastInsertRowid), details: { dashboard: dashboard.code, widget_type: widgetType }, sourceModule: "reporting" });
  return getWidget(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function updateWidget(db, tenantId, ref, input = {}, actor = null) {
  const existing = getWidget(db, tenantId, ref);
  const widgetType = String(input.widget_type || existing.widget_type).toUpperCase();
  if (!DASHBOARD_WIDGET_TYPES.includes(widgetType)) throw invalidDashboard(`Unsupported widget type: ${widgetType}`);
  const reportId = input.report_id ? getReport(db, tenantId, input.report_id).id : existing.report_id;
  const kpiId = input.kpi_id ? getKpi(db, tenantId, input.kpi_id).id : existing.kpi_id;
  const metricId = input.metric_id ? getMetric(db, tenantId, input.metric_id).id : existing.metric_id;
  run(
    db,
    `UPDATE reporting_dashboard_widgets SET widget_type = ?, title = ?, report_id = ?, kpi_id = ?, metric_id = ?, sequence = ?, config_json = ?, layout_json = ?, filters_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      widgetType,
      input.title ?? existing.title,
      reportId,
      kpiId,
      metricId,
      input.sequence ?? existing.sequence,
      stringifyJson(input.config ?? existing.config),
      stringifyJson(input.layout ?? existing.layout),
      stringifyJson(input.filters ?? existing.filters, "[]"),
      nowIso(),
      existing.id,
      Number(tenantId),
    ]
  );
  writeAudit(db, { actor, action: "reporting.widget.update", resourceType: "reporting_widget", resourceId: existing.widget_ref, sourceModule: "reporting" });
  return getWidget(db, Number(tenantId), existing.id);
}

export function deleteWidget(db, tenantId, ref, actor = null) {
  const existing = getWidget(db, tenantId, ref);
  run(db, "DELETE FROM reporting_dashboard_widgets WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.widget.delete", resourceType: "reporting_widget", resourceId: existing.widget_ref, sourceModule: "reporting" });
  return { deleted: true, widget_ref: existing.widget_ref };
}

export function reorderWidgets(db, tenantId, dashboardRef_, order = [], actor = null) {
  const dashboard = getDashboard(db, tenantId, dashboardRef_);
  order.forEach((ref, index) => {
    run(db, "UPDATE reporting_dashboard_widgets SET sequence = ?, updated_at = ? WHERE dashboard_id = ? AND tenant_id = ? AND widget_ref = ?", [index + 1, nowIso(), dashboard.id, Number(tenantId), String(ref)]);
  });
  writeAudit(db, { actor, action: "reporting.widget.reorder", resourceType: "reporting_dashboard", resourceId: dashboard.code, sourceModule: "reporting" });
  return listWidgets(db, tenantId, dashboard.code);
}

// ── Dashboard resolution / drill-down ────────────────────────────────────────

// Resolves every widget of a dashboard for the current actor. Widgets whose
// source is not visible to the actor are returned as `denied` placeholders.
export function refreshDashboard(db, tenantId, ref, context = {}, actor = null, ip = null) {
  const dashboard = assertDashboardVisible(db, actor, getDashboardWithWidgets(db, tenantId, ref));
  const widgets = dashboard.widgets.map((widget) => resolveWidget(db, tenantId, widget, { ...context, actor, ip }));
  return { ...dashboard, widgets, refreshed_at: nowIso(), cache_hit: widgets.some((widget) => widget.cache_hit) };
}

function widgetFiltersToQuery(widget) {
  return (widget.filters || []).map((filter) => ({ ...filter, operator: String(filter.operator || "EQ").toUpperCase() }));
}

export function resolveWidget(db, tenantId, widget, context = {}) {
  const actor = context.actor;
  try {
    if (widget.report_id) {
      const report = getReport(db, tenantId, widget.report_id);
      const result = runReport(db, tenantId, report, { ...context, mode: "PREVIEW", parameters: { ...(context.parameters || {}), ...(widget.config?.parameters || {}) }, enableCache: true });
      return { widget_ref: widget.widget_ref, widget_type: widget.widget_type, title: widget.title, source: "REPORT", report: report.code, data: result, drill_down: widget.config?.drill_down || null, cache_hit: result.cache_hit };
    }
    if (widget.kpi_id) {
      const value = getKpiValue(db, tenantId, widget.kpi_id, context);
      return { widget_ref: widget.widget_ref, widget_type: widget.widget_type, title: widget.title, source: "KPI", data: value, cache_hit: value.cache_hit };
    }
    if (widget.metric_id) {
      const metric = computeMetric(db, tenantId, widget.metric_id, context);
      return { widget_ref: widget.widget_ref, widget_type: widget.widget_type, title: widget.title, source: "METRIC", data: metric };
    }
    return { widget_ref: widget.widget_ref, widget_type: widget.widget_type, title: widget.title, source: "STATIC", data: widget.config || {} };
  } catch (error) {
    return { widget_ref: widget.widget_ref, widget_type: widget.widget_type, title: widget.title, source: "ERROR", denied: error.status === 403, error: error.message };
  }
}

// Drill-down: follows a widget's declared drill-down chain to the target report
// row, applying the clicked value as a parameter/filter.
export function drillDown(db, tenantId, widgetRef_, context = {}, actor = null, ip = null) {
  const widget = getWidget(db, tenantId, widgetRef_);
  const chain = widget.config?.drill_down;
  if (!chain) throw invalidDashboard(`Widget ${widget.widget_ref} has no drill-down configured`);
  const targetReport = chain.report_code || chain.reportCode || widget.report_id;
  const parameters = { ...(context.parameters || {}) };
  if (chain.parameter && context.value !== undefined) parameters[chain.parameter] = context.value;
  const filters = (chain.filters || []).map((filter) => ({ ...filter, value: filter.parameter && context.value !== undefined ? context.value : filter.value }));
  const report = getReport(db, tenantId, targetReport);
  return runReport(db, tenantId, report, { ...context, mode: "PREVIEW", parameters, filters: [...filters, ...(context.filters || [])], actor, ip });
}

export function listVisibleDashboardsForActor(db, tenantId, actor) {
  return listDashboards(db, tenantId, {}, actor).items;
}
