// Idempotent bootstrap for the Migration & Onboarding Framework.
//
// Called on every application boot and by the seed. It registers the built-in
// source adapters, background handlers and job types, installs event types,
// search sources and per-tenant configuration, and exposes a health summary. It
// never duplicates platform seams (IAM, events, jobs, storage, search) — it
// registers into them.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { tenantIds, tenantIdsAsync } from "../search/registry.js";
import { ensureSourceAdapters } from "./source-adapters/index.js";
import { ensureMigrationJobTypes, registerMigrationHandlers, ensureMigrationJobTypesAsync } from "./jobs.js";
import { ensureMigrationEventTypes, ensureMigrationEventTypesAsync } from "./events.js";
import { ensureMigrationConfig, ensureMigrationConfigAsync } from "./configuration.js";
import { ensureMigrationSearch, registerMigrationSources, ensureMigrationSearchAsync } from "./search.js";
import { SOURCE_MODULE } from "./constants.js";

export function ensureMigrationFoundation(db) {
  const adapters = ensureSourceAdapters();
  const jobTypes = ensureMigrationJobTypes(db);
  const handlers = registerMigrationHandlers();
  const eventTypes = ensureMigrationEventTypes(db);
  registerMigrationSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  let configuration = 0;
  const search = ensureMigrationSearch(db).created || 0;
  for (const tenantId of tenants) {
    configuration += ensureMigrationConfig(db, tenantId).created || 0;
  }

  return {
    source_module: SOURCE_MODULE,
    adapters,
    job_types: jobTypes.created,
    handlers,
    event_types: eventTypes,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export async function ensureMigrationFoundationAsync(db) {
  const adapters = ensureSourceAdapters();
  const jobTypes = await ensureMigrationJobTypesAsync(db);
  const handlers = registerMigrationHandlers();
  const eventTypes = await ensureMigrationEventTypesAsync(db);
  registerMigrationSources();

  let tenants = [];
  try {
    tenants = await tenantIdsAsync(db);
  } catch {
    tenants = [];
  }
  let configuration = 0;
  const search = (await ensureMigrationSearchAsync(db)).created || 0;
  for (const tenantId of tenants) {
    configuration += (await ensureMigrationConfigAsync(db, tenantId)).created || 0;
  }

  return {
    source_module: SOURCE_MODULE,
    adapters,
    job_types: jobTypes.created,
    handlers,
    event_types: eventTypes,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function migrationHealth(db, tenantId = null) {
  const scoped = (table, column = "tenant_id") =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      projects: scoped("mig_projects"),
      packages: scoped("mig_packages"),
      definitions: scoped("mig_definitions"),
      jobs: scoped("mig_jobs"),
      source_configurations: scoped("mig_source_configurations"),
      identifier_mappings: scoped("mig_identifier_mappings"),
      file_migrations: scoped("mig_file_migrations"),
      audit: scoped("mig_audit"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM mig_jobs").length,
  };
}

export async function migrationHealthAsync(db, tenantId = null) {
  const scoped = async (table, column = "tenant_id") =>
    tenantId
      ? Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [Number(tenantId)]))?.c || 0)
      : Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      projects: await scoped("mig_projects"),
      packages: await scoped("mig_packages"),
      definitions: await scoped("mig_definitions"),
      jobs: await scoped("mig_jobs"),
      source_configurations: await scoped("mig_source_configurations"),
      identifier_mappings: await scoped("mig_identifier_mappings"),
      file_migrations: await scoped("mig_file_migrations"),
      audit: await scoped("mig_audit"),
    },
    tenant_count: (await queryAllAsync(db, "SELECT DISTINCT tenant_id FROM mig_jobs")).length,
  };
}
