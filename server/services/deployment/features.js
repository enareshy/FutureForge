// Feature entitlements — the deployment's licensed capability ledger.
//
// A feature is *effective* only when all three hold:
//   1. the operator has not disabled it (`enabled`), and
//   2. the licensed edition is at least the feature's `min_edition`, and
//   3. the installed topology is one of `allowed_modes` (empty = every mode).
//
// Deriving the flag at read time keeps the recorded contract (edition/mode) and
// the operator override (`enabled`) separate. The resolved map is cached per
// database and invalidated on write (see cache.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { getCachedCapabilities, setCachedCapabilities, invalidateCapabilities } from "./cache.js";
import { getProfile, getProfileAsync, publicProfile } from "./profile.js";
import { recordDeploymentChange } from "./history.js";
import { featureNotFound, invalidFeature } from "./errors.js";
import { SOURCE_MODULE, CONFIG_BOUNDS, editionRank, findEdition, findMode } from "./constants.js";

export function listFeatures(db) {
  return queryAll(
    db,
    "SELECT * FROM deployment_features ORDER BY category, sort_order, feature_code"
  );
}

export function featureRow(db, code) {
  return queryOne(db, "SELECT * FROM deployment_features WHERE feature_code = ?", [String(code)]);
}

export function publicFeature(row) {
  if (!row) return null;
  return {
    feature_code: row.feature_code,
    name: row.name,
    category: row.category,
    description: row.description || "",
    enabled: Boolean(row.enabled),
    min_edition: row.min_edition,
    allowed_modes: String(row.allowed_modes || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    notes: row.notes || "",
    sort_order: row.sort_order,
    updated_at: row.updated_at,
  };
}

function allowedModesOf(row) {
  return String(row.allowed_modes || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export function evaluateFeature(profile, row) {
  const reasons = [];
  if (!row.enabled) reasons.push("disabled_by_operator");
  if (editionRank(profile.edition) < editionRank(row.min_edition)) reasons.push("edition_too_low");
  const modes = allowedModesOf(row);
  if (modes.length && !modes.includes(profile.mode)) reasons.push("mode_not_allowed");
  return { effective: reasons.length === 0, reasons };
}

export function resolveCapabilities(db) {
  const cached = getCachedCapabilities(db);
  if (cached) return cached;

  const profile = getProfile(db);
  const rows = listFeatures(db);
  const features = {};
  const catalog = [];
  const byCategory = {};

  for (const row of rows) {
    const { effective, reasons } = evaluateFeature(profile, row);
    features[row.feature_code] = effective;
    catalog.push({
      ...publicFeature(row),
      effective,
      reasons,
      required_edition: findEdition(row.min_edition)?.name || row.min_edition,
      mode: profile.mode,
    });
    const bucket = (byCategory[row.category] ||= { total: 0, effective: 0 });
    bucket.total += 1;
    if (effective) bucket.effective += 1;
  }

  const result = {
    source_module: SOURCE_MODULE,
    mode: profile.mode,
    edition: profile.edition,
    profile: publicProfile(profile),
    features,
    catalog,
    summary: {
      total: rows.length,
      effective: Object.values(features).filter(Boolean).length,
      by_category: byCategory,
    },
    generated_at: nowIso(),
  };
  return setCachedCapabilities(db, result);
}

// Async twins of the read-side resolvers. The per-database cache is shared with
// the synchronous path; on a cache miss the profile and feature rows are read
// without blocking the event loop.
export async function listFeaturesAsync(db) {
  return queryAllAsync(
    db,
    "SELECT * FROM deployment_features ORDER BY category, sort_order, feature_code"
  );
}

export async function resolveCapabilitiesAsync(db) {
  const cached = getCachedCapabilities(db);
  if (cached) return cached;

  const profile = await getProfileAsync(db);
  const rows = await listFeaturesAsync(db);
  const features = {};
  const catalog = [];
  const byCategory = {};

  for (const row of rows) {
    const { effective, reasons } = evaluateFeature(profile, row);
    features[row.feature_code] = effective;
    catalog.push({
      ...publicFeature(row),
      effective,
      reasons,
      required_edition: findEdition(row.min_edition)?.name || row.min_edition,
      mode: profile.mode,
    });
    const bucket = (byCategory[row.category] ||= { total: 0, effective: 0 });
    bucket.total += 1;
    if (effective) bucket.effective += 1;
  }

  const result = {
    source_module: SOURCE_MODULE,
    mode: profile.mode,
    edition: profile.edition,
    profile: publicProfile(profile),
    features,
    catalog,
    summary: {
      total: rows.length,
      effective: Object.values(features).filter(Boolean).length,
      by_category: byCategory,
    },
    generated_at: nowIso(),
  };
  return setCachedCapabilities(db, result);
}

export function isFeatureEnabled(db, code) {
  const capabilities = resolveCapabilities(db);
  if (!(code in capabilities.features)) return true; // unknown features are never gated
  return capabilities.features[code];
}

export function setFeature(db, code, body = {}, actor, ip) {
  const row = featureRow(db, code);
  if (!row) throw featureNotFound(code);

  const patch = {};
  const before = publicFeature(row);

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw invalidFeature({ field: "enabled", reason: "boolean" });
    patch.enabled = body.enabled ? 1 : 0;
  }
  if (body.notes !== undefined) {
    const notes = String(body.notes);
    if (notes.length > CONFIG_BOUNDS.feature_notes) throw invalidFeature({ field: "notes", reason: "length" });
    patch.notes = notes;
  }
  if (!Object.keys(patch).length) return { ...before, ...evaluateFeature(getProfile(db), row) };

  const columns = Object.keys(patch);
  run(
    db,
    `UPDATE deployment_features SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE feature_code = ?`,
    [...columns.map((c) => patch[c]), actor?.id ?? null, nowIso(), row.feature_code]
  );
  invalidateCapabilities(db);

  const after = featureRow(db, code);
  const evaluation = evaluateFeature(getProfile(db), after);

  recordDeploymentChange(db, {
    action: "feature.updated",
    entityType: "feature",
    entityRef: code,
    before,
    after: publicFeature(after),
    details: { changed: columns, effective: evaluation.effective, reasons: evaluation.reasons },
    actor,
    ip,
  });

  return { ...publicFeature(after), ...evaluation };
}

export function featureSummary(db) {
  const profile = getProfile(db);
  const rows = listFeatures(db);
  const byCategory = {};
  let effectiveCount = 0;
  for (const row of rows) {
    const { effective, reasons } = evaluateFeature(profile, row);
    if (effective) effectiveCount += 1;
    const bucket = (byCategory[row.category] ||= {
      total: 0,
      effective: 0,
      disabled: [],
    });
    bucket.total += 1;
    if (effective) bucket.effective += 1;
    else bucket.disabled.push({ feature_code: row.feature_code, reasons });
  }
  return {
    source_module: SOURCE_MODULE,
    mode: profile.mode,
    edition: profile.edition,
    edition_name: findEdition(profile.edition)?.name || profile.edition,
    mode_name: findMode(profile.mode)?.name || profile.mode,
    total: rows.length,
    effective: effectiveCount,
    by_category: byCategory,
  };
}
