// Search & Discovery integration for Reporting & Analytics.
//
// Reports, dashboards and KPIs are indexed as read-only search object types
// through the shared Enterprise Search, so analytical assets are discoverable
// with the same facets, authorization and saved searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { REPORTING_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("reporting_report"),
    source_module: "reporting",
    source_table: "reporting_reports",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "report_type", "data_source", "entity", "status"],
    facet_attributes: ["report_type", "data_source", "entity", "status"],
    filter_attributes: ["status", "report_type", "data_source", "entity"],
    permission_resource: REPORTING_RESOURCES.reports,
    display_order: 220,
  },
  {
    ...defFor("reporting_dashboard"),
    source_module: "reporting",
    source_table: "reporting_dashboards",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "dashboard_type", "status"],
    facet_attributes: ["dashboard_type", "status"],
    filter_attributes: ["status", "dashboard_type"],
    permission_resource: REPORTING_RESOURCES.dashboards,
    display_order: 221,
  },
  {
    ...defFor("reporting_kpi"),
    source_module: "reporting",
    source_table: "reporting_kpis",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "metric_code", "entity", "aggregation", "unit", "status"],
    facet_attributes: ["entity", "aggregation", "unit", "status"],
    filter_attributes: ["status", "entity", "aggregation"],
    permission_resource: REPORTING_RESOURCES.kpis,
    display_order: 222,
  },
];

export function registerReportingSources() {
  registerSourceResolver("reporting_report", {
    code: "reporting_report",
    table: "reporting_reports",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM reporting_reports WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "reporting_report",
        objectId: String(row.id),
        code: row.report_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.report_type, row.data_source, row.entity, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.report_type, row.data_source, row.entity, row.status].filter(Boolean),
        attributes: { report_type: row.report_type, data_source: row.data_source, entity: row.entity, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM reporting_reports WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("reporting_dashboard", {
    code: "reporting_dashboard",
    table: "reporting_dashboards",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM reporting_dashboards WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "reporting_dashboard",
        objectId: String(row.id),
        code: row.dashboard_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.dashboard_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.dashboard_type, row.status].filter(Boolean),
        attributes: { dashboard_type: row.dashboard_type, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM reporting_dashboards WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("reporting_kpi", {
    code: "reporting_kpi",
    table: "reporting_kpis",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM reporting_kpis WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "reporting_kpi",
        objectId: String(row.id),
        code: row.kpi_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.metric_code, row.entity, row.aggregation, row.unit, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.entity, row.aggregation, row.unit, row.status].filter(Boolean),
        attributes: { entity: row.entity, aggregation: row.aggregation, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM reporting_kpis WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureReportingSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, Number(tenantId), def.code)) {
        registerSecurityObjectType(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}
