// Demonstration and default seed for Reporting & Analytics.
//
// Idempotent: installs the foundation (event/job types, handlers, search
// sources, security object types, configuration) and materialises a small,
// reusable set of analytical assets (KPIs, a parts report and an operations
// dashboard) so the capability is usable immediately after boot.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureReportingFoundation } from "./foundation.js";
import { KPI_CATALOG, REPORTING_RESOURCES } from "./constants.js";
import { createKpi, setKpiStatus } from "./kpis.js";
import { createReport, publishReport } from "./reports.js";
import { createDashboard, publishDashboard } from "./dashboards.js";

const CROSS_DOMAIN_REPORT = "OBJECTS_BY_TYPE";
const OPERATIONS_DASHBOARD = "OPERATIONS_OVERVIEW";

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

function resolveSeedActor(db) {
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin' LIMIT 1");
  if (admin) return { id: admin.id, username: admin.username };
  const any = queryOne(db, "SELECT id, username FROM users ORDER BY id LIMIT 1");
  return any ? { id: any.id, username: any.username } : null;
}

export function reportingResourceCodes() {
  return Object.values(REPORTING_RESOURCES).filter((code) => typeof code === "string" && code.startsWith("iam.reporting"));
}

export function ensureDefaultReportingAssets(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { created: 0, reason: "no_tenant" };
  const actor = resolveSeedActor(db);
  let created = 0;

  for (const kpi of KPI_CATALOG) {
    if (queryOne(db, "SELECT id FROM reporting_kpis WHERE tenant_id = ? AND code = ?", [tenant, kpi.code])) continue;
    const record = createKpi(db, tenant, { ...kpi, visibility: undefined }, actor);
    setKpiStatus(db, tenant, record.code, "ACTIVE", actor);
    created += 1;
  }

  let report = queryOne(db, "SELECT id FROM reporting_reports WHERE tenant_id = ? AND code = ?", [tenant, CROSS_DOMAIN_REPORT]);
  if (!report) {
    const record = createReport(
      db,
      tenant,
      {
        code: CROSS_DOMAIN_REPORT,
        name: "Objects by type",
        description: "Cross-domain count of business objects grouped by object type.",
        report_type: "CROSS_DOMAIN",
        visibility: "ORGANIZATION",
        definition: {
          entity: "object",
          columns: [
            { attribute: "number", label: "Number" },
            { attribute: "name", label: "Name" },
            { attribute: "object_type", label: "Object type" },
            { attribute: "status", label: "Status" },
          ],
          group_by: ["object_type"],
          aggregations: [{ function: "COUNT", attribute: null, alias: "object_count" }],
          sort: [{ target: "object_count", direction: "DESC" }],
          visualization: { type: "BAR", x: "object_type", y: "object_count" },
        },
        visualization: { type: "BAR", x: "object_type", y: "object_count" },
      },
      actor
    );
    publishReport(db, tenant, record.id, actor);
    report = { id: record.id };
    created += 1;
  }

  if (!queryOne(db, "SELECT id FROM reporting_dashboards WHERE tenant_id = ? AND code = ?", [tenant, OPERATIONS_DASHBOARD])) {
    const kpiRows = KPI_CATALOG.slice(0, 3).map((kpi) => queryOne(db, "SELECT id FROM reporting_kpis WHERE tenant_id = ? AND code = ?", [tenant, kpi.code])).filter(Boolean);
    const dashboard = createDashboard(
      db,
      tenant,
      {
        code: OPERATIONS_DASHBOARD,
        name: "Operations overview",
        description: "Reusable operations dashboard for PDM and engineering change KPIs.",
        dashboard_type: "OPERATIONAL",
        visibility: "ORGANIZATION",
        is_default: true,
        layout: { columns: 2, row_height: 220 },
        widgets: [
          { widget_type: "REPORT", title: "Objects by type", report_id: report.id, layout: { w: 2, h: 1 } },
          ...kpiRows.map((kpi, index) => ({ widget_type: "KPI_CARD", title: `KPI ${index + 1}`, kpi_id: kpi.id, sequence: index + 10, layout: { w: 1, h: 1 } })),
        ],
      },
      actor
    );
    publishDashboard(db, tenant, dashboard.id, actor);
    created += 1;
  }

  return { created };
}

export function seedReporting(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureReportingFoundation(db);
    if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };
    const assets = ensureDefaultReportingAssets(db, tenant);
    return { foundation, assets, seeded: true };
  });
}

export function ensureReportingSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM reporting_reports WHERE tenant_id = ? AND code = ?", [tenant, CROSS_DOMAIN_REPORT]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedReporting(db, tenant);
}
