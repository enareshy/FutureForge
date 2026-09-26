// Foundation bootstrap for the File & Content Management service. Idempotent on
// every boot: event types, search registration and baseline retention policies.
// Providers (storage, virus scanning, renditions) self-register on import.
import { ensureContentEventTypes } from "./events.js";
import { ensureContentSearchRegistration } from "./search.js";
import { ensureDefaultRetentionPolicies } from "./seed.js";
import { resolveContentStorage } from "./storage.js";
import { resolveScanProvider } from "../file-storage/scanning.js";

export function ensureContentFoundation(db) {
  let eventTypes = 0;
  let search = null;
  let retentionPolicies = 0;
  try {
    eventTypes = ensureContentEventTypes(db);
  } catch {
    eventTypes = 0;
  }
  try {
    search = ensureContentSearchRegistration(db);
  } catch {
    search = null;
  }
  try {
    retentionPolicies = ensureDefaultRetentionPolicies(db, {});
  } catch {
    retentionPolicies = 0;
  }
  let storage = "unknown";
  try {
    storage = resolveContentStorage().info().provider;
  } catch {
    storage = "unavailable";
  }
  let scan = "unavailable";
  try {
    scan = resolveScanProvider().name;
  } catch {
    scan = "unavailable";
  }
  return { event_types: eventTypes, search, retention_policies: retentionPolicies, storage_provider: storage, scan_provider: scan };
}

export function contentHealth(db) {
  let storage = { provider: "unavailable" };
  try {
    storage = resolveContentStorage().info();
  } catch {
    storage = { provider: "unavailable" };
  }
  let scan = { name: "unavailable" };
  try {
    scan = { name: resolveScanProvider().name };
  } catch {
    scan = { name: "unavailable" };
  }
  return {
    service: "content",
    status: storage.provider === "unavailable" ? "degraded" : "ok",
    storage,
    scan,
  };
}
