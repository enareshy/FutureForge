// Reporting & Analytics bridge.
//
// Module 21 does not invent another charting/BI layer. Its dashboards are
// rendered server-side for the observability UX, and it also mirrors a curated
// platform-health dashboard into the shared Reporting & Analytics engine so the
// same numbers can be governed, scheduled, exported and consumed by BI tools.
// The bridge is best-effort: a reporting hiccup must never break observability.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import * as reporting from "../reporting/index.js";

const BRIDGE_DASHBOARD_CODE = "OBSERVABILITY_PLATFORM_HEALTH";
// Reporting KPIs that already exist in the seeded semantic layer and map onto
// the same operational reality observability monitors.
const KPI_WIDGETS = [
  { kpi: "TOTAL_OBJECTS", title: "Total business objects" },
  { kpi: "TOTAL_PARTS", title: "Total parts" },
  { kpi: "RELEASED_PARTS", title: "Released parts" },
  { kpi: "OPEN_CHANGES", title: "Open engineering changes" },
];

export function reportingAvailable(db) {
  try {
    return Boolean(queryOne(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reporting_dashboards'"));
  } catch {
    return false;
  }
}

// Idempotently creates a reporting dashboard bound to curated KPIs and points
// the observability default dashboard at it.
export function ensureObservabilityReportingAssets(db, tenantId, actor = null) {
  const result = { dashboard_ref: null, widgets: 0, linked: 0, skipped: [] };
  if (!reportingAvailable(db)) {
    result.skipped.push("reporting_not_installed");
    return result;
  }
  let dashboard = null;
  try {
    dashboard = queryOne(db, "SELECT * FROM reporting_dashboards WHERE tenant_id = ? AND code = ?", [Number(tenantId), BRIDGE_DASHBOARD_CODE]);
    if (!dashboard) {
      const created = reporting.Dashboards.createDashboard(
        db,
        tenantId,
        {
          code: BRIDGE_DASHBOARD_CODE,
          name: "Platform Observability",
          description: "Governed platform-health KPIs mirrored from Data Observability.",
          dashboard_type: "OPERATIONAL",
          visibility: "ORGANIZATION",
          metadata: { source_module: "observability" },
        },
        actor
      );
      dashboard = queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ?", [created.id]);
    }
  } catch (err) {
    result.skipped.push(`dashboard:${err.message}`);
    return result;
  }
  result.dashboard_ref = dashboard?.dashboard_ref || null;

  // Resolve available reporting KPIs and add widgets for the ones that exist.
  let existing = [];
  try {
    existing = queryAll(db, "SELECT kpi_ref, code FROM reporting_dashboard_widgets w JOIN reporting_kpis k ON k.id = w.kpi_id WHERE w.dashboard_id = ?", [dashboard.id]).map((row) => row.code);
  } catch {
    existing = [];
  }
  for (const widget of KPI_WIDGETS) {
    if (existing.includes(widget.kpi)) continue;
    const kpi = queryOne(db, "SELECT * FROM reporting_kpis WHERE tenant_id = ? AND code = ?", [Number(tenantId), widget.kpi]);
    if (!kpi) {
      result.skipped.push(`kpi:${widget.kpi}`);
      continue;
    }
    try {
      reporting.Dashboards.addWidget(db, tenantId, dashboard.id, { widget_type: "KPI_CARD", title: widget.title, kpi_id: kpi.id }, actor);
      result.widgets += 1;
    } catch (err) {
      result.skipped.push(`widget:${widget.kpi}:${err.message}`);
    }
  }

  // Publish the dashboard so it is stable and shareable.
  try {
    const fresh = queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ?", [dashboard.id]);
    if (fresh && fresh.status === "DRAFT") reporting.Dashboards.publishDashboard(db, tenantId, fresh.dashboard_ref, actor);
  } catch (err) {
    result.skipped.push(`publish:${err.message}`);
  }

  // Point the observability default dashboard at the reporting dashboard.
  try {
    const linked = queryOne(db, "SELECT id FROM observability_dashboards WHERE tenant_id = ? AND code = 'OBSERVABILITY_OVERVIEW'", [Number(tenantId)]);
    if (linked) {
      run(db, "UPDATE observability_dashboards SET reporting_dashboard_ref = ?, updated_at = ? WHERE id = ?", [dashboard.dashboard_ref, nowIso(), linked.id]);
      result.linked = 1;
    }
  } catch (err) {
    result.skipped.push(`link:${err.message}`);
  }
  return result;
}

export { BRIDGE_DASHBOARD_CODE };
