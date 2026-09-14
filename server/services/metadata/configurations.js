import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertArtifactType } from "./versions.js";

export const SCOPES = ["system", "tenant", "organization"];
export const ARTIFACT_TYPES = ["type", "attribute", "lov", "form", "rule"];

function publicConfig(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1,
    settings: safeParse(row.settings_json, {}),
  };
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new HttpError(400, `scope must be one of: ${SCOPES.join(", ")}`);
}

export function listConfigurations(db, { scope, scopeId, artifactType } = {}) {
  const where = [];
  const params = [];
  if (scope) {
    assertScope(scope);
    where.push("scope = ?");
    params.push(scope);
  }
  if (scopeId !== undefined && scopeId !== null && scopeId !== "") {
    where.push("scope_id = ?");
    params.push(Number(scopeId) || 0);
  }
  if (artifactType) {
    assertArtifactType(artifactType);
    where.push("artifact_type = ?");
    params.push(artifactType);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return queryAll(
    db,
    `SELECT * FROM metadata_configurations ${clause} ORDER BY scope, artifact_type, artifact_id`,
    params
  ).map(publicConfig);
}

// Overlays scoped configuration rows for one artifact. Precedence runs
// system -> tenant -> organization: a lower scope wins for both `enabled` and
// `pinned_version`, matching the platform's general configuration idiom.
export function resolveArtifactConfig(db, artifactType, artifactId, context = {}) {
  assertArtifactType(artifactType);
  const tenantId = Number(context.tenantId || context.tenant_id || 0) || 0;
  const organizationId = Number(context.organizationId || context.organization_id || 0) || 0;
  const layers = [];
  const resolved = { enabled: true, pinned_version: null, settings: {}, source: "default" };

  const scopeIds = [["system", 0]];
  if (tenantId) scopeIds.push(["tenant", tenantId]);
  if (organizationId) scopeIds.push(["organization", organizationId]);

  for (const [scope, scopeId] of scopeIds) {
    const row = queryOne(
      db,
      "SELECT * FROM metadata_configurations WHERE scope = ? AND scope_id = ? AND artifact_type = ? AND artifact_id = ?",
      [scope, scopeId, artifactType, Number(artifactId)]
    );
    if (!row) continue;
    const config = publicConfig(row);
    resolved.enabled = config.enabled;
    if (config.pinned_version !== null && config.pinned_version !== undefined) {
      resolved.pinned_version = config.pinned_version;
    }
    resolved.settings = { ...resolved.settings, ...config.settings };
    resolved.source = scope;
    layers.push({ scope, scope_id: scopeId, enabled: config.enabled, pinned_version: config.pinned_version });
  }
  return { artifact_type: artifactType, artifact_id: Number(artifactId), ...resolved, layers };
}

export function setConfiguration(db, input, actor, ip) {
  const scope = input?.scope || "system";
  assertScope(scope);
  const artifactType = input?.artifactType ?? input?.artifact_type;
  assertArtifactType(artifactType);
  const artifactId = Number(input?.artifactId ?? input?.artifact_id);
  if (!artifactId) throw new HttpError(400, "artifact_id is required");
  const scopeId = scope === "system" ? 0 : Number(input?.scopeId ?? input?.scope_id ?? 0);
  if (scope !== "system" && !scopeId) throw new HttpError(400, "scope_id is required for tenant/organization scope");
  const enabled = input.enabled === false ? 0 : 1;
  const pinnedVersion =
    input.pinnedVersion === undefined && input.pinned_version === undefined
      ? null
      : input.pinnedVersion ?? input.pinned_version;
  const settings = input.settings || {};
  const ts = nowIso();
  run(
    db,
    `INSERT INTO metadata_configurations
      (scope, scope_id, artifact_type, artifact_id, enabled, pinned_version, settings_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id, artifact_type, artifact_id) DO UPDATE SET
       enabled = excluded.enabled,
       pinned_version = excluded.pinned_version,
       settings_json = excluded.settings_json,
       updated_at = excluded.updated_at`,
    [scope, scopeId, artifactType, artifactId, enabled, pinnedVersion, JSON.stringify(settings), ts]
  );
  writeAudit(db, {
    actor,
    action: "metadata.configuration.set",
    resourceType: "metadata_configuration",
    resourceId: `${scope}:${scopeId}:${artifactType}:${artifactId}`,
    details: { scope, scopeId, artifactType, artifactId, enabled: Boolean(enabled), pinnedVersion },
    ip,
  });
  return resolveArtifactConfig(db, artifactType, artifactId, {
    tenantId: scope === "tenant" ? scopeId : undefined,
    organizationId: scope === "organization" ? scopeId : undefined,
  });
}

export function deleteConfiguration(db, { scope, scopeId, artifactType, artifactId }, actor, ip) {
  assertScope(scope);
  assertArtifactType(artifactType);
  const result = run(
    db,
    "DELETE FROM metadata_configurations WHERE scope = ? AND scope_id = ? AND artifact_type = ? AND artifact_id = ?",
    [scope, Number(scopeId) || 0, artifactType, Number(artifactId)]
  );
  if (!result.changes) throw new HttpError(404, "Configuration not found");
  writeAudit(db, {
    actor,
    action: "metadata.configuration.delete",
    resourceType: "metadata_configuration",
    resourceId: `${scope}:${Number(scopeId) || 0}:${artifactType}:${artifactId}`,
    ip,
  });
  return { deleted: true };
}

// Batch view used by the Configuration admin UI: shows the effective state of
// every artifact in a scope alongside the originating layer.
export function effectiveCatalog(db, { artifactType, tenantId, organizationId } = {}) {
  const types = artifactType && artifactType !== "type" ? [] : queryAll(db, "SELECT id, code, name, tenant_id, status FROM metadata_types ORDER BY code");
  const lovs = artifactType && artifactType !== "lov" ? [] : queryAll(db, "SELECT id, code, name, tenant_id, status FROM metadata_lovs ORDER BY code");
  const forms = artifactType && artifactType !== "form" ? [] : queryAll(db, "SELECT id, code, name, tenant_id, status FROM metadata_forms ORDER BY code");
  const rules = artifactType && artifactType !== "rule" ? [] : queryAll(db, "SELECT id, code, name, tenant_id, status FROM metadata_rules ORDER BY code");
  const attributes = artifactType && artifactType !== "attribute" ? [] : queryAll(db, "SELECT id, code, name, tenant_id, status FROM metadata_attributes ORDER BY code");

  const context = { tenantId, organizationId };
  const decorate = (artifactTypeName, rows) =>
    rows.map((row) => ({
      artifact_type: artifactTypeName,
      artifact_id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      is_global: row.tenant_id === null || row.tenant_id === undefined,
      config: resolveArtifactConfig(db, artifactTypeName, row.id, context),
    }));

  return [
    ...decorate("type", types),
    ...decorate("attribute", attributes),
    ...decorate("lov", lovs),
    ...decorate("form", forms),
    ...decorate("rule", rules),
  ];
}

// Confirms an artifact is enabled in the given context before it is consumed.
export function assertEnabled(db, artifactType, artifactId, context) {
  const config = resolveArtifactConfig(db, artifactType, artifactId, context);
  if (!config.enabled) {
    throw new HttpError(409, `Metadata ${artifactType} ${artifactId} is disabled at ${config.source} scope`);
  }
  return config;
}
