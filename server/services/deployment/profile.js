// Deployment profile — the installed topology (Cloud SaaS / Private Cloud /
// Local), the licensed edition and the operator-controlled installation
// identity. Exactly one row exists per install (id = 1).
import { queryOne, run, nowIso } from "../../db.js";
import { queryOneAsync, runAsync } from "../../db-async.js";
import { validateEmail } from "../../validation.js";
import { invalidProfile } from "./errors.js";
import { recordDeploymentChange, recordDeploymentChangeAsync } from "./history.js";
import { invalidateCapabilities } from "./cache.js";
import {
  MODE_CODES,
  EDITION_CODES,
  TENANT_STRATEGIES,
  CONFIG_BOUNDS,
  findMode,
} from "./constants.js";

const DEFAULTS = Object.freeze({
  mode: "local",
  edition: "enterprise",
  installation_name: "Helix",
  tenant_strategy: "multi",
  self_registration: 0,
  telemetry_enabled: 1,
  support_email: "",
  notes: "",
});

function boolToInt(value) {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "yes") return 1;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "no") return 0;
  return null;
}

export function ensureProfileRow(db) {
  const existing = queryOne(db, "SELECT id FROM deployment_profile WHERE id = 1");
  if (existing) return false;
  run(
    db,
    `INSERT INTO deployment_profile
       (id, mode, edition, installation_name, tenant_strategy, self_registration,
        telemetry_enabled, support_email, notes, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULTS.mode,
      DEFAULTS.edition,
      DEFAULTS.installation_name,
      DEFAULTS.tenant_strategy,
      DEFAULTS.self_registration,
      DEFAULTS.telemetry_enabled,
      DEFAULTS.support_email,
      DEFAULTS.notes,
      nowIso(),
    ]
  );
  return true;
}

export function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    edition: row.edition,
    installation_name: row.installation_name,
    tenant_strategy: row.tenant_strategy,
    self_registration: Boolean(row.self_registration),
    telemetry_enabled: Boolean(row.telemetry_enabled),
    support_email: row.support_email || "",
    notes: row.notes || "",
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at,
  };
}

export function getProfile(db) {
  ensureProfileRow(db);
  return queryOne(db, "SELECT * FROM deployment_profile WHERE id = 1");
}

// Async twins of the profile bootstrap/read helpers.
export async function ensureProfileRowAsync(db) {
  const existing = await queryOneAsync(db, "SELECT id FROM deployment_profile WHERE id = 1");
  if (existing) return false;
  await runAsync(
    db,
    `INSERT INTO deployment_profile
       (id, mode, edition, installation_name, tenant_strategy, self_registration,
        telemetry_enabled, support_email, notes, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULTS.mode,
      DEFAULTS.edition,
      DEFAULTS.installation_name,
      DEFAULTS.tenant_strategy,
      DEFAULTS.self_registration,
      DEFAULTS.telemetry_enabled,
      DEFAULTS.support_email,
      DEFAULTS.notes,
      nowIso(),
    ]
  );
  return true;
}

export async function getProfileAsync(db) {
  await ensureProfileRowAsync(db);
  return queryOneAsync(db, "SELECT * FROM deployment_profile WHERE id = 1");
}

function assertName(value) {
  const name = String(value).trim();
  if (name.length < CONFIG_BOUNDS.installation_name.min || name.length > CONFIG_BOUNDS.installation_name.max) {
    throw invalidProfile({ field: "installation_name", reason: "length" });
  }
  return name;
}

function buildProfilePatch(before, body = {}) {
  const patch = {};

  if (body.mode !== undefined) {
    const mode = String(body.mode).trim();
    if (!MODE_CODES.includes(mode)) throw invalidProfile({ field: "mode", allowed: MODE_CODES });
    if (mode !== before.mode) {
      patch.mode = mode;
      const info = findMode(mode);
      // Adopt the topology's recommended defaults unless the caller is
      // explicit, so switching to Cloud SaaS does not silently keep a
      // single-tenant, self-registration-off posture.
      if (body.tenant_strategy === undefined) patch.tenant_strategy = info.default_tenant_strategy;
      if (body.self_registration === undefined) patch.self_registration = info.default_self_registration;
    }
  }

  if (body.edition !== undefined) {
    const edition = String(body.edition).trim();
    if (!EDITION_CODES.includes(edition)) throw invalidProfile({ field: "edition", allowed: EDITION_CODES });
    patch.edition = edition;
  }

  if (body.installation_name !== undefined) patch.installation_name = assertName(body.installation_name);

  if (body.tenant_strategy !== undefined) {
    const strategy = String(body.tenant_strategy).trim();
    if (!TENANT_STRATEGIES.includes(strategy)) throw invalidProfile({ field: "tenant_strategy", allowed: TENANT_STRATEGIES });
    patch.tenant_strategy = strategy;
  }

  if (body.self_registration !== undefined) {
    const value = boolToInt(body.self_registration);
    if (value === null) throw invalidProfile({ field: "self_registration", reason: "boolean" });
    patch.self_registration = value;
  }

  if (body.telemetry_enabled !== undefined) {
    const value = boolToInt(body.telemetry_enabled);
    if (value === null) throw invalidProfile({ field: "telemetry_enabled", reason: "boolean" });
    patch.telemetry_enabled = value;
  }

  if (body.support_email !== undefined) {
    const email = String(body.support_email).trim();
    if (email) {
      if (email.length > CONFIG_BOUNDS.support_email.max) throw invalidProfile({ field: "support_email", reason: "length" });
      try {
        validateEmail(email);
      } catch {
        throw invalidProfile({ field: "support_email", reason: "format" });
      }
    }
    patch.support_email = email;
  }

  if (body.notes !== undefined) {
    const notes = String(body.notes);
    if (notes.length > CONFIG_BOUNDS.notes.max) throw invalidProfile({ field: "notes", reason: "length" });
    patch.notes = notes;
  }

  return patch;
}

function profileUpdateAssignments(columns) {
  return columns.map((c) => `${c} = ?`).join(", ");
}

export function updateProfile(db, body = {}, actor, ip) {
  const before = getProfile(db);
  const patch = buildProfilePatch(before, body);
  if (!Object.keys(patch).length) return publicProfile(before);

  const columns = Object.keys(patch);
  run(
    db,
    `UPDATE deployment_profile SET ${profileUpdateAssignments(columns)}, updated_by = ?, updated_at = ? WHERE id = 1`,
    [...columns.map((c) => patch[c]), actor?.id ?? null, nowIso()]
  );
  invalidateCapabilities(db);
  const after = getProfile(db);

  recordDeploymentChange(db, {
    action: "profile.updated",
    entityType: "profile",
    entityRef: "deployment",
    before: publicProfile(before),
    after: publicProfile(after),
    details: { changed: columns },
    actor,
    ip,
  });

  return publicProfile(after);
}

export async function updateProfileAsync(db, body = {}, actor, ip) {
  const before = await getProfileAsync(db);
  const patch = buildProfilePatch(before, body);
  if (!Object.keys(patch).length) return publicProfile(before);

  const columns = Object.keys(patch);
  await runAsync(
    db,
    `UPDATE deployment_profile SET ${profileUpdateAssignments(columns)}, updated_by = ?, updated_at = ? WHERE id = 1`,
    [...columns.map((c) => patch[c]), actor?.id ?? null, nowIso()]
  );
  invalidateCapabilities(db);
  const after = await getProfileAsync(db);

  await recordDeploymentChangeAsync(db, {
    action: "profile.updated",
    entityType: "profile",
    entityRef: "deployment",
    before: publicProfile(before),
    after: publicProfile(after),
    details: { changed: columns },
    actor,
    ip,
  });

  return publicProfile(after);
}
