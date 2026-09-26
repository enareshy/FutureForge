// Reporting read model (§8, §20).
//
// The read model is a denormalized, refreshable projection of the operational
// model used by heavy analytical reports. It is deliberately derived data: the
// object model stays the source of truth and per-subject authorization is
// applied again when the read model is queried, so copying rows cannot widen
// access. Refresh runs as a background job.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { SEMANTIC_ENTITY_CODES } from "./constants.js";
import { resolveEntityRows } from "./semantic.js";
import { readModelRow, stringifyJson } from "./repository.js";
import { publishReportingEvent } from "./events.js";

export function refreshReadModel(db, { tenantId, entities = null, limit = 100000 } = {}) {
  const tenant = Number(tenantId);
  const codes = Array.isArray(entities) && entities.length ? entities : SEMANTIC_ENTITY_CODES;
  const ts = nowIso();
  const summary = { entities: 0, rows: 0, refreshed_at: ts, per_entity: {} };
  for (const entity of codes) {
    const { records } = resolveEntityRows(db, entity, { tenantId: tenant, system: true, limit });
    run(db, "DELETE FROM reporting_read_model WHERE tenant_id = ? AND entity = ?", [tenant, entity]);
    for (const record of records) {
      run(
        db,
        `INSERT INTO reporting_read_model (tenant_id, entity, object_type, object_id, organization_id, classification, attributes_json, source_updated_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenant, entity, record.object_type || entity, String(record.object_id), record.organization_id ?? null, record.classification || "", stringifyJson(record.attributes), null, ts]
      );
    }
    summary.entities += 1;
    summary.rows += records.length;
    summary.per_entity[entity] = records.length;
  }
  publishReportingEvent(db, { eventType: "ReportExecuted", payload: { action: "readmodel_refreshed", entities: summary.entities, rows: summary.rows }, objectType: "reporting_read_model", tenantId: tenant }, null);
  return summary;
}

export function listReadModelEntries(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.entity) {
    where.push("entity = ?");
    params.push(String(query.entity));
  }
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.page_size || query.pageSize) || 50));
  const clause = where.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reporting_read_model WHERE ${clause}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM reporting_read_model WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(readModelRow), total, page, pageSize };
}

export function readModelStatus(db, tenantId) {
  const rows = queryAll(db, "SELECT entity, COUNT(*) AS c, MAX(refreshed_at) AS refreshed_at FROM reporting_read_model WHERE tenant_id = ? GROUP BY entity", [Number(tenantId)]);
  return {
    enabled: true,
    entities: rows.map((row) => ({ entity: row.entity, rows: Number(row.c), refreshed_at: row.refreshed_at })),
    total_rows: rows.reduce((sum, row) => sum + Number(row.c), 0),
  };
}
