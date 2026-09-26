// Default seed for Data Observability.
//
// Idempotent: installs the foundation (event/job types, handlers, search
// sources, security object types, configuration) and materialises the curated
// metric catalogue, data assets, freshness definitions, alert rules, SLO/SLA
// definitions and dashboards. It then performs one collection pass so the
// overview is populated on a fresh install. All policy comes from constants,
// never hard-coded in the engine.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureObservabilityFoundation } from "./foundation.js";
import {
  METRIC_CATALOG,
  FRESHNESS_CATALOG,
  ALERT_RULE_CATALOG,
  SLO_CATALOG,
  DASHBOARD_CATALOG,
  OBSERVABILITY_RESOURCES,
} from "./constants.js";
import { createMetric, getMetricRow } from "./metrics.js";
import { createFreshness, createAsset, getFreshnessRow, getAssetRow } from "./freshness.js";
import { createAlertRule, getAlertRuleRow } from "./alerts.js";
import { createSlo, getSloRow } from "./slo.js";
import { ensureDefaultDashboards } from "./dashboards.js";
import { collectTenant } from "./collection.js";
import { getConfig } from "./configuration.js";
import { ensureObservabilityReportingAssets } from "./reporting-bridge.js";

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  if (helix) return helix.id;
  const any = queryOne(db, "SELECT id FROM organizations ORDER BY id LIMIT 1");
  return any?.id ?? null;
}

function resolveSeedActor(db) {
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin' LIMIT 1");
  if (admin) return { id: admin.id, username: admin.username };
  const any = queryOne(db, "SELECT id, username FROM users ORDER BY id LIMIT 1");
  return any ? { id: any.id, username: any.username } : null;
}

export function observabilityResourceCodes() {
  return Object.values(OBSERVABILITY_RESOURCES).filter((code) => typeof code === "string" && code.startsWith("iam.observability"));
}

export function ensureDefaultObservabilityAssets(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { created: 0, reason: "no_tenant" };
  const actor = resolveSeedActor(db);
  const created = { metrics: 0, assets: 0, freshness: 0, alert_rules: 0, slos: 0, dashboards: 0 };

  for (const entry of METRIC_CATALOG) {
    if (getMetricRow(db, tenant, entry.code)) continue;
    createMetric(
      db,
      tenant,
      {
        code: entry.code,
        name: entry.name,
        description: entry.description || `Auto-seeded metric ${entry.code}.`,
        category: entry.category,
        provider_code: entry.provider,
        entity_code: entry.entity,
        calculation: entry.calculation,
        attribute: entry.attribute,
        unit: entry.unit,
        direction: entry.direction,
        frequency_seconds: entry.frequency_seconds,
        aggregation: entry.aggregation,
        warning_threshold: entry.warning_threshold,
        critical_threshold: entry.critical_threshold,
        metadata: entry.metadata || {},
      },
      actor
    );
    created.metrics += 1;
  }

  for (const entry of FRESHNESS_CATALOG) {
    if (!getAssetRow(db, tenant, entry.asset)) {
      createAsset(
        db,
        tenant,
        {
          code: entry.asset,
          name: entry.name,
          description: `${entry.name} data asset.`,
          asset_type: "TABLE",
          provider_code: entry.provider,
          source_table: entry.table,
          refresh_interval_seconds: Math.max(60, Number(entry.warn_age_seconds) || 3600),
          warn_age_seconds: entry.warn_age_seconds,
          critical_age_seconds: entry.critical_age_seconds,
        },
        actor
      );
      created.assets += 1;
    }
    if (!getFreshnessRow(db, tenant, entry.code)) {
      createFreshness(
        db,
        tenant,
        {
          code: entry.code,
          name: entry.name,
          description: `${entry.name} freshness objective.`,
          asset_code: entry.asset,
          provider_code: entry.provider,
          source_table: entry.table,
          max_age_seconds: entry.max_age_seconds,
          warn_age_seconds: entry.warn_age_seconds,
          critical_age_seconds: entry.critical_age_seconds,
        },
        actor
      );
      created.freshness += 1;
    }
  }

  for (const entry of ALERT_RULE_CATALOG) {
    if (getAlertRuleRow(db, tenant, entry.code)) continue;
    createAlertRule(
      db,
      tenant,
      {
        code: entry.code,
        name: entry.name,
        description: entry.description || `Auto-seeded alert rule ${entry.code}.`,
        metric_code: entry.metric,
        condition: { operator: entry.operator, value: entry.value },
        severity: entry.severity,
        service_code: entry.service,
        for_seconds: entry.for_seconds,
        cooldown_seconds: entry.cooldown_seconds,
        auto_resolve: entry.auto_resolve,
      },
      actor
    );
    created.alert_rules += 1;
  }

  for (const entry of SLO_CATALOG) {
    if (getSloRow(db, tenant, entry.code)) continue;
    createSlo(
      db,
      tenant,
      {
        code: entry.code,
        name: entry.name,
        description: `${entry.kind} ${entry.name}.`,
        kind: entry.kind,
        metric_code: entry.metric,
        target: entry.target,
        comparison: entry.comparison,
        window_seconds: entry.window_seconds,
        unit: entry.unit,
      },
      actor
    );
    created.slos += 1;
  }

  const dashboards = ensureDefaultDashboards(db, tenant, actor);
  created.dashboards = dashboards.created;

  // Mirror a governed dashboard into Reporting & Analytics (best-effort).
  const bridge = ensureObservabilityReportingAssets(db, tenant, actor);

  // Populate a first set of observations so the overview is not empty.
  let collection = null;
  const autoCollect = getConfig(db, tenant, "auto_collect_on_seed");
  const hasObservation = queryOne(db, "SELECT id FROM observability_metric_observations WHERE tenant_id = ? LIMIT 1", [tenant]);
  if (autoCollect && !hasObservation) {
    try {
      collection = collectTenant(db, tenant, { trigger: "SEED", actor }).counts;
    } catch (err) {
      collection = { error: err.message };
    }
  }

  return { created, catalog: { metrics: METRIC_CATALOG.length, dashboards: DASHBOARD_CATALOG.length }, bridge, collection };
}

export function seedObservability(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureObservabilityFoundation(db);
    if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };
    const assets = ensureDefaultObservabilityAssets(db, tenant);
    return { foundation, assets, seeded: true };
  });
}

export function ensureObservabilitySeed(db, tenantId) {
  return seedObservability(db, tenantId);
}
