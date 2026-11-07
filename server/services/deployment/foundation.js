// Idempotent bootstrap for the Deployment & Edition framework.
//
// Called on every application boot. It guarantees the singleton profile row
// exists and that the feature catalog is present and its contract metadata
// (name, category, min_edition, allowed_modes, ...) matches the shipped
// catalog. Operator overrides (`enabled`, `notes`) are never overwritten, so a
// deployment can upgrade the platform without losing its entitlement choices.
import { queryOne, run, nowIso } from "../../db.js";
import { queryOneAsync, runAsync } from "../../db-async.js";
import { ensureProfileRow, getProfile, getProfileAsync, publicProfile, ensureProfileRowAsync } from "./profile.js";
import { featureRow, listFeatures, listFeaturesAsync, resolveCapabilities, resolveCapabilitiesAsync, featureRowAsync } from "./features.js";
import { invalidateCapabilities } from "./cache.js";
import { SOURCE_MODULE, FEATURE_CATALOG, findEdition } from "./constants.js";

function refreshFeatureContract(db, row, spec) {
  const patch = {};
  if (row.name !== spec.name) patch.name = spec.name;
  if (row.category !== spec.category) patch.category = spec.category;
  if ((row.description || "") !== (spec.description || "")) patch.description = spec.description || "";
  if (row.min_edition !== spec.min_edition) patch.min_edition = spec.min_edition;
  if (normalizeModes(row.allowed_modes) !== normalizeModes(spec.allowed_modes)) {
    patch.allowed_modes = spec.allowed_modes || "";
  }
  if (Number(row.sort_order) !== Number(spec.sort_order)) patch.sort_order = spec.sort_order;
  const columns = Object.keys(patch);
  if (!columns.length) return false;
  run(
    db,
    `UPDATE deployment_features SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE feature_code = ?`,
    [...columns.map((c) => patch[c]), nowIso(), row.feature_code]
  );
  return true;
}

function normalizeModes(value) {
  return String(value || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

export function ensureFeatureDefaults(db) {
  let created = 0;
  let updated = 0;
  for (const spec of FEATURE_CATALOG) {
    const row = featureRow(db, spec.feature_code);
    if (!row) {
      run(
        db,
        `INSERT INTO deployment_features
           (feature_code, name, category, description, enabled, min_edition, allowed_modes, notes, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, '', ?, ?, ?)`,
        [
          spec.feature_code,
          spec.name,
          spec.category,
          spec.description || "",
          spec.min_edition,
          spec.allowed_modes || "",
          spec.sort_order,
          nowIso(),
          nowIso(),
        ]
      );
      created += 1;
    } else if (refreshFeatureContract(db, row, spec)) {
      updated += 1;
    }
  }
  return { created, updated, total: FEATURE_CATALOG.length };
}

export function ensureDeploymentFoundation(db) {
  const profileCreated = ensureProfileRow(db);
  const features = ensureFeatureDefaults(db);
  invalidateCapabilities(db);
  return {
    source_module: SOURCE_MODULE,
    profile_created: profileCreated,
    features_created: features.created,
    features_updated: features.updated,
    features_total: features.total,
  };
}

async function refreshFeatureContractAsync(db, row, spec) {
  const patch = {};
  if (row.name !== spec.name) patch.name = spec.name;
  if (row.category !== spec.category) patch.category = spec.category;
  if ((row.description || "") !== (spec.description || "")) patch.description = spec.description || "";
  if (row.min_edition !== spec.min_edition) patch.min_edition = spec.min_edition;
  if (normalizeModes(row.allowed_modes) !== normalizeModes(spec.allowed_modes)) {
    patch.allowed_modes = spec.allowed_modes || "";
  }
  if (Number(row.sort_order) !== Number(spec.sort_order)) patch.sort_order = spec.sort_order;
  const columns = Object.keys(patch);
  if (!columns.length) return false;
  await runAsync(
    db,
    `UPDATE deployment_features SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE feature_code = ?`,
    [...columns.map((c) => patch[c]), nowIso(), row.feature_code]
  );
  return true;
}

export async function ensureFeatureDefaultsAsync(db) {
  let created = 0;
  let updated = 0;
  for (const spec of FEATURE_CATALOG) {
    const row = await featureRowAsync(db, spec.feature_code);
    if (!row) {
      await runAsync(
        db,
        `INSERT INTO deployment_features
           (feature_code, name, category, description, enabled, min_edition, allowed_modes, notes, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, '', ?, ?, ?)`,
        [
          spec.feature_code,
          spec.name,
          spec.category,
          spec.description || "",
          spec.min_edition,
          spec.allowed_modes || "",
          spec.sort_order,
          nowIso(),
          nowIso(),
        ]
      );
      created += 1;
    } else if (await refreshFeatureContractAsync(db, row, spec)) {
      updated += 1;
    }
  }
  return { created, updated, total: FEATURE_CATALOG.length };
}

export async function ensureDeploymentFoundationAsync(db) {
  const profileCreated = await ensureProfileRowAsync(db);
  const features = await ensureFeatureDefaultsAsync(db);
  invalidateCapabilities(db);
  return {
    source_module: SOURCE_MODULE,
    profile_created: profileCreated,
    features_created: features.created,
    features_updated: features.updated,
    features_total: features.total,
  };
}

function buildHealth(profile, capabilities, rows, historyEvents) {
  return {
    source_module: SOURCE_MODULE,
    mode: profile.mode,
    edition: profile.edition,
    edition_name: findEdition(profile.edition)?.name || profile.edition,
    installation_name: profile.installation_name,
    profile: publicProfile(profile),
    features: {
      total: rows.length,
      effective: capabilities.summary.effective,
      disabled: rows.length - capabilities.summary.effective,
    },
    history_events: Number(historyEvents || 0),
  };
}

export function deploymentHealth(db) {
  const profile = getProfile(db);
  const capabilities = resolveCapabilities(db);
  const rows = listFeatures(db);
  const historyEvents = Number(queryOne(db, "SELECT COUNT(*) AS c FROM deployment_history")?.c || 0);
  return buildHealth(profile, capabilities, rows, historyEvents);
}

export async function deploymentHealthAsync(db) {
  const profile = await getProfileAsync(db);
  const capabilities = await resolveCapabilitiesAsync(db);
  const rows = await listFeaturesAsync(db);
  const historyEvents = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM deployment_history"))?.c || 0);
  return buildHealth(profile, capabilities, rows, historyEvents);
}
