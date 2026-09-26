// Search & Discovery integration for Data Observability.
//
// Metric definitions, alerts, incidents and dashboards are indexed as read-only
// search object types through the shared Enterprise Search, so operational
// knowledge is discoverable with the same facets, authorization and saved
// searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { OBSERVABILITY_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

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
    ...defFor("observability_metric"),
    source_module: "observability",
    source_table: "observability_metric_definitions",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "category", "provider_code", "calculation", "unit", "status"],
    facet_attributes: ["category", "provider_code", "calculation", "unit", "status"],
    filter_attributes: ["status", "category", "provider_code"],
    permission_resource: OBSERVABILITY_RESOURCES.metrics,
    display_order: 240,
  },
  {
    ...defFor("observability_alert"),
    source_module: "observability",
    source_table: "observability_alerts",
    title_attribute: "message",
    subtitle_attribute: "metric_code",
    summary_attribute: "message",
    body_attributes: ["alert_ref", "rule_code", "metric_code", "service_code", "severity", "status", "message"],
    facet_attributes: ["severity", "status", "service_code", "metric_code"],
    filter_attributes: ["status", "severity", "service_code", "metric_code"],
    permission_resource: OBSERVABILITY_RESOURCES.alerts,
    display_order: 241,
  },
  {
    ...defFor("observability_incident"),
    source_module: "observability",
    source_table: "observability_incidents",
    title_attribute: "title",
    subtitle_attribute: "incident_ref",
    summary_attribute: "description",
    body_attributes: ["incident_ref", "title", "description", "severity", "status", "service_code", "metric_code"],
    facet_attributes: ["severity", "status", "service_code"],
    filter_attributes: ["status", "severity", "service_code"],
    permission_resource: OBSERVABILITY_RESOURCES.incidents,
    display_order: 242,
  },
  {
    ...defFor("observability_dashboard"),
    source_module: "observability",
    source_table: "observability_dashboards",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "scope", "status"],
    facet_attributes: ["scope", "status"],
    filter_attributes: ["scope", "status"],
    permission_resource: OBSERVABILITY_RESOURCES.dashboards,
    display_order: 243,
  },
];

export function registerObservabilitySources() {
  registerSourceResolver("observability_metric", {
    code: "observability_metric",
    table: "observability_metric_definitions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM observability_metric_definitions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "observability_metric",
        objectId: String(row.id),
        code: row.metric_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.category, row.provider_code, row.calculation, row.unit, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.category, row.provider_code, row.unit, row.status].filter(Boolean),
        attributes: { category: row.category, provider_code: row.provider_code, calculation: row.calculation, unit: row.unit, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM observability_metric_definitions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("observability_alert", {
    code: "observability_alert",
    table: "observability_alerts",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM observability_alerts WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "observability_alert",
        objectId: String(row.id),
        code: row.alert_ref,
        title: row.message || row.metric_code,
        subtitle: row.metric_code,
        summary: row.message || "",
        searchableText: joinText([row.alert_ref, row.rule_code, row.metric_code, row.service_code, row.severity, row.status, row.message]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.severity, row.status, row.service_code, row.metric_code].filter(Boolean),
        attributes: { severity: row.severity, status: row.status, service_code: row.service_code, metric_code: row.metric_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM observability_alerts WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("observability_incident", {
    code: "observability_incident",
    table: "observability_incidents",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM observability_incidents WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "observability_incident",
        objectId: String(row.id),
        code: row.incident_ref,
        title: row.title,
        subtitle: row.incident_ref,
        summary: row.description || "",
        searchableText: joinText([row.incident_ref, row.title, row.description, row.severity, row.status, row.service_code, row.metric_code]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.severity, row.status, row.service_code].filter(Boolean),
        attributes: { severity: row.severity, status: row.status, service_code: row.service_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM observability_incidents WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("observability_dashboard", {
    code: "observability_dashboard",
    table: "observability_dashboards",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM observability_dashboards WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "observability_dashboard",
        objectId: String(row.id),
        code: row.dashboard_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.scope, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? row.created_by ?? null,
        classification: "internal",
        tags: [row.scope, row.status].filter(Boolean),
        attributes: { scope: row.scope, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM observability_dashboards WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureObservabilitySearch(db) {
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
