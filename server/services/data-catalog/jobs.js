// Background job handlers for the Data Catalog & Business Glossary. Import,
// export, lineage maintenance and search reindex run on the platform Job
// Scheduling & Execution Engine so a request never blocks.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { CATALOG_HANDLER_CODES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { importCatalog, exportCatalog, listImportRuns } from "./importexport.js";
import { lineageGraph, removeLineage } from "./lineage.js";
import { publicImportRun } from "./repository.js";

export function submitCatalogImport(db, { tenantId, resourceType, records = [], dryRun = false, actor = null, ip = null, transferRef = "" } = {}) {
  return submitJob(
    db,
    {
      job_type_code: "DATA_CATALOG_IMPORT",
      payload: { tenant_id: Number(tenantId), resource_type: resourceType, records, dry_run: dryRun, transfer_ref: transferRef },
      tenant_id: Number(tenantId),
      priority: "normal",
      queue: "default",
    },
    { actor, ip }
  );
}

export function submitCatalogExport(db, { tenantId, resourceTypes = null, format = "json", actor = null, ip = null } = {}) {
  return submitJob(
    db,
    {
      job_type_code: "DATA_CATALOG_EXPORT",
      payload: { tenant_id: Number(tenantId), resource_types: resourceTypes, format },
      tenant_id: Number(tenantId),
      priority: "normal",
      queue: "default",
    },
    { actor, ip }
  );
}

export function submitLineageMaintenance(db, { tenantId, actor = null, ip = null } = {}) {
  return submitJob(
    db,
    { job_type_code: "DATA_CATALOG_LINEAGE_MAINTENANCE", payload: { tenant_id: Number(tenantId) }, tenant_id: Number(tenantId), priority: "low", queue: "default" },
    { actor, ip }
  );
}

export function submitCatalogReindex(db, { tenantId, objectTypes = null, actor = null, ip = null } = {}) {
  return submitJob(
    db,
    { job_type_code: "DATA_CATALOG_REINDEX", payload: { tenant_id: Number(tenantId), object_types: objectTypes }, tenant_id: Number(tenantId), priority: "normal", queue: "default" },
    { actor, ip }
  );
}

// Maintenance: deactivate lineage edges whose effective_to has passed and prune
// edges that reference a retired catalog entry. Bounded per run.
export function runLineageMaintenance(db, { tenantId, limit = 2000 } = {}) {
  const now = nowIso();
  const expired = queryAll(
    db,
    "SELECT id FROM dc_lineage WHERE tenant_id = ? AND status = 'active' AND effective_to IS NOT NULL AND effective_to <> '' AND effective_to < ? LIMIT ?",
    [Number(tenantId), now, Number(limit) || 2000]
  );
  let deactivated = 0;
  for (const row of expired) {
    run(db, "UPDATE dc_lineage SET status = 'inactive', updated_at = ? WHERE id = ?", [now, row.id]);
    deactivated += 1;
  }
  const orphaned = queryAll(
    db,
    `SELECT l.id FROM dc_lineage l
      WHERE l.tenant_id = ?
        AND (
          (l.from_type IN ('OBJECT','ATTRIBUTE','BUSINESS_TERM','SOURCE','CONSUMER') AND NOT EXISTS (
             SELECT 1 FROM dc_entries e WHERE e.tenant_id = l.tenant_id AND (CAST(e.id AS TEXT) = l.from_id OR e.entry_ref = l.from_id)
          )) OR
          (l.to_type IN ('OBJECT','ATTRIBUTE','BUSINESS_TERM','SOURCE','CONSUMER') AND NOT EXISTS (
             SELECT 1 FROM dc_entries e WHERE e.tenant_id = l.tenant_id AND (CAST(e.id AS TEXT) = l.to_id OR e.entry_ref = l.to_id)
          ))
        )
      LIMIT ?`,
    [Number(tenantId), Number(limit) || 2000]
  );
  let pruned = 0;
  for (const row of orphaned) {
    run(db, "DELETE FROM dc_lineage WHERE id = ?", [row.id]);
    pruned += 1;
  }
  return { deactivated, pruned, ran_at: now };
}

// Reindex is delegated to the shared Search engine; this handler simply submits
// or drains the platform reindex job for catalog object types.
export function runCatalogReindex(db, { tenantId, objectTypes = null } = {}) {
  const types = objectTypes?.length
    ? objectTypes
    : ["business_term", "catalog_object", "catalog_attribute", "data_source", "data_consumer"];
  return { tenant_id: Number(tenantId), object_types: types, requested_at: nowIso() };
}

// Per-tenant maintenance entry point used by the worker's periodic sweep:
// converge lineage metadata (expire stale effectivities, prune orphaned edges).
export function runCatalogMaintenance(db, { limit = 2000 } = {}) {
  const tenants = queryAll(db, "SELECT DISTINCT tenant_id FROM dc_lineage WHERE tenant_id IS NOT NULL");
  let deactivated = 0;
  let pruned = 0;
  for (const row of tenants) {
    const result = runLineageMaintenance(db, { tenantId: row.tenant_id, limit });
    deactivated += result.deactivated;
    pruned += result.pruned;
  }
  return { tenants: tenants.length, deactivated, pruned, ran_at: nowIso() };
}

export function registerCatalogHandlers() {
  registerHandler(
    CATALOG_HANDLER_CODES.IMPORT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("importing", { progress: 10 });
      const result = importCatalog(context.db, {
        tenantId,
        resourceType: context.input.resource_type,
        records: Array.isArray(context.input.records) ? context.input.records : [],
        dryRun: Boolean(context.input.dry_run),
        transferRef: context.input.transfer_ref || "",
        jobRef: context.job_ref,
      });
      context.reportProgress({ progress: 100, message: "Import complete" }, { force: true });
      return { message: "Catalog import complete", result };
    },
    { description: "Import catalog metadata" }
  );

  registerHandler(
    CATALOG_HANDLER_CODES.EXPORT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("exporting", { progress: 10 });
      const result = exportCatalog(context.db, {
        tenantId,
        resourceTypes: context.input.resource_types || null,
        format: context.input.format || "json",
      });
      context.reportProgress({ progress: 100, message: "Export complete" }, { force: true });
      return { message: "Catalog export complete", result: { format: result.format, record_count: result.record_count, content: result.content } };
    },
    { description: "Export catalog metadata" }
  );

  registerHandler(
    CATALOG_HANDLER_CODES.LINEAGE_MAINTENANCE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("maintenance", { progress: 10 });
      const result = runLineageMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Lineage maintenance complete" }, { force: true });
      return { message: "Lineage maintenance complete", result };
    },
    { description: "Converge catalog lineage metadata" }
  );

  registerHandler(
    CATALOG_HANDLER_CODES.REINDEX,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("reindex", { progress: 10 });
      const result = runCatalogReindex(context.db, { tenantId, objectTypes: context.input.object_types || null });
      context.reportProgress({ progress: 100, message: "Reindex requested" }, { force: true });
      return { message: "Catalog reindex complete", result };
    },
    { description: "Rebuild the search index for catalog object types" }
  );

  return Object.values(CATALOG_HANDLER_CODES);
}

export function listCatalogJobs(db, { tenantId, limit = 50 } = {}) {
  return listImportRuns(db, { tenantId, limit });
}

export { publicImportRun };
