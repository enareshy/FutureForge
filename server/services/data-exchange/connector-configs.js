// Connector configuration and credential-reference administration.
//
// A connector configuration is the tenant's binding of a connector type (CSV,
// REST, ...) to concrete settings (URL, delimiter, query). Credentials are held
// by the platform secret store; this service stores only an opaque `secret_ref`
// and never a secret value. The raw external credential is never persisted here.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { CONNECTOR_DIRECTIONS, MAX_MAPPINGS } from "./constants.js";
import { connectorRef as makeConnectorRef } from "./refs.js";
import { publicConnectorConfiguration, publicCredentialReference } from "./repository.js";
import { connectorNotFound, invalidConnector } from "./errors.js";
import {
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireCode,
  assertConnectorType,
  assertConnectorDirection,
} from "./validation.js";
import { requireConnector, supportsCapability } from "./connectors/registry.js";

const CREDENTIAL_TYPES = ["TOKEN", "API_KEY", "USERNAME_PASSWORD", "OAUTH2", "CERTIFICATE", "CONNECTION_STRING", "NONE"];

function getConfigRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_connector_configurations WHERE tenant_id = ? AND (config_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), normalizeUpper(ref), String(ref)]
  );
}

export function getConnectorConfigurationRow(db, tenantId, ref) {
  const row = getConfigRow(db, tenantId, ref);
  if (!row) throw connectorNotFound(ref);
  return row;
}

export function getConnectorConfiguration(db, tenantId, ref) {
  return publicConnectorConfiguration(getConnectorConfigurationRow(db, tenantId, ref));
}

function assertCapabilitiesFor(connectorType, capabilities) {
  const list = Array.isArray(capabilities) ? capabilities.map((c) => normalizeUpper(c)) : [];
  if (list.length === 0) return [];
  if (!requireConnector(connectorType)) throw connectorNotFound(connectorType);
  return list.filter((capability) => {
    const supported = supportsCapability(connectorType, capability);
    if (!supported && capability !== "READ" && capability !== "WRITE") return false;
    return true;
  });
}

export function createConnectorConfiguration(db, tenantId, input = {}, actor = null, ip = null) {
  const code = requireCode(input.code, "Connector code");
  if (queryOne(db, "SELECT id FROM ie_connector_configurations WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) {
    throw invalidConnector(`Connector configuration already exists: ${code}`);
  }
  const connectorType = assertConnectorType(input.connector_type || input.connectorType || input.source_type || "CSV");
  const direction = assertConnectorDirection(input.direction || "SOURCE");
  const settings = parseObject(input.settings, {});
  const capabilities = assertCapabilitiesFor(connectorType, input.capabilities);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO ie_connector_configurations
      (config_ref, tenant_id, organization_id, code, name, description, connector_type, direction, settings_json, credential_ref_id, capabilities_json, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      makeConnectorRef(code),
      Number(tenantId),
      input.organization_id ?? input.organizationId ?? null,
      code,
      normalizeText(input.name, { max: 200 }) || code,
      normalizeText(input.description),
      connectorType,
      direction,
      JSON.stringify(settings),
      input.credential_ref_id ?? input.credentialRefId ?? null,
      JSON.stringify(capabilities),
      normalizeText(input.status, { max: 16 }).toLowerCase() || "active",
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "data_exchange.connector.create", resourceType: "ie_connector_configurations", resourceId: code, details: { connector_type: connectorType }, ip });
  return publicConnectorConfiguration(queryOne(db, "SELECT * FROM ie_connector_configurations WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateConnectorConfiguration(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = getConfigRow(db, tenantId, ref);
  if (!row) throw connectorNotFound(ref);
  const connectorType = patch.connector_type || patch.connectorType ? assertConnectorType(patch.connector_type || patch.connectorType) : row.connector_type;
  if (connectorType !== row.connector_type) throw invalidConnector("A connector configuration's type is immutable; create a new configuration instead");
  const settings = patch.settings !== undefined ? parseObject(patch.settings, parseObject(row.settings_json, {})) : parseObject(row.settings_json, {});
  const capabilities = patch.capabilities !== undefined ? assertCapabilitiesFor(connectorType, patch.capabilities) : JSON.parse(row.capabilities_json || "[]");
  run(
    db,
    `UPDATE ie_connector_configurations SET name = ?, description = ?, direction = ?, settings_json = ?, credential_ref_id = ?, capabilities_json = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [
      normalizeText(patch.name ?? row.name, { max: 200 }) || row.code,
      normalizeText(patch.description ?? row.description),
      patch.direction ? assertConnectorDirection(patch.direction) : row.direction,
      JSON.stringify(settings),
      patch.credential_ref_id ?? patch.credentialRefId ?? row.credential_ref_id,
      JSON.stringify(capabilities),
      patch.status ? normalizeText(patch.status, { max: 16 }).toLowerCase() : row.status,
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  writeAudit(db, { actor, action: "data_exchange.connector.update", resourceType: "ie_connector_configurations", resourceId: row.code, details: {}, ip });
  return publicConnectorConfiguration(queryOne(db, "SELECT * FROM ie_connector_configurations WHERE id = ?", [row.id]));
}

export function setConnectorConfigurationStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = getConfigRow(db, tenantId, ref);
  if (!row) throw connectorNotFound(ref);
  const next = normalizeText(status, { max: 16 }).toLowerCase();
  if (!["active", "inactive", "retired"].includes(next)) throw invalidConnector(`Invalid connector status: ${status}`);
  run(db, "UPDATE ie_connector_configurations SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  writeAudit(db, { actor, action: "data_exchange.connector.status", resourceType: "ie_connector_configurations", resourceId: row.code, details: { status: next }, ip });
  return publicConnectorConfiguration(queryOne(db, "SELECT * FROM ie_connector_configurations WHERE id = ?", [row.id]));
}

export function listConnectorConfigurations(db, { tenantId, connectorType, direction, status, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (connectorType) {
    clauses.push("connector_type = ?");
    params.push(assertConnectorType(connectorType));
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(CONNECTOR_DIRECTIONS.includes(normalizeUpper(direction)) ? normalizeUpper(direction) : direction);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status, { max: 16 }).toLowerCase());
  }
  const term = normalizeText(q);
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_connector_configurations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_connector_configurations ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicConnectorConfiguration), total, page: currentPage, page_size: limit };
}

export async function testConnectorConfiguration(db, tenantId, ref = null, inline = null) {
  let settings;
  let connectorType;
  if (inline) {
    connectorType = assertConnectorType(inline.connector_type || inline.connectorType || "CSV");
    settings = parseObject(inline.settings, {});
  } else {
    const row = getConnectorConfigurationRow(db, tenantId, ref);
    connectorType = row.connector_type;
    settings = parseObject(row.settings_json, {});
  }
  const connector = requireConnector(connectorType);
  const result = await connector.testConnection({ db, settings, tenant_id: Number(tenantId) });
  return { connector_type: connectorType, ...result };
}

export async function discoverConnectorConfigurationSchema(db, tenantId, ref, ctx = {}) {
  const row = getConnectorConfigurationRow(db, tenantId, ref);
  const connector = requireConnector(row.connector_type);
  const settings = { ...parseObject(row.settings_json, {}), ...parseObject(ctx.settings, {}) };
  const { discoverSourceSchema } = await import("./engines/schema.js");
  return { connector_type: connector.code, ...(await discoverSourceSchema(connector, { db, settings, tenant_id: Number(tenantId) })) };
}

// ── Credential references ────────────────────────────────────────────────────

export function createCredentialReference(db, tenantId, input = {}, actor = null, ip = null) {
  const code = requireCode(input.code, "Credential reference code");
  const credentialType = normalizeUpper(input.credential_type || input.credentialType || "TOKEN");
  if (!CREDENTIAL_TYPES.includes(credentialType)) throw invalidConnector(`Unsupported credential type: ${credentialType}`);
  const secretRef = normalizeText(input.secret_ref || input.secretRef, { max: 400 });
  if (!secretRef) throw invalidConnector("A credential reference requires an opaque secret_ref, not a secret value");
  if (queryOne(db, "SELECT id FROM ie_connector_credential_references WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) {
    throw invalidConnector(`Credential reference already exists: ${code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO ie_connector_credential_references (tenant_id, code, name, credential_type, secret_ref, metadata_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      Number(tenantId),
      code,
      normalizeText(input.name, { max: 200 }) || code,
      credentialType,
      secretRef,
      JSON.stringify(parseObject(input.metadata, {})),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "data_exchange.credential.create", resourceType: "ie_connector_credential_references", resourceId: code, details: { credential_type: credentialType }, ip });
  return publicCredentialReference(queryOne(db, "SELECT * FROM ie_connector_credential_references WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function listCredentialReferences(db, { tenantId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status, { max: 16 }).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_connector_credential_references ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_connector_credential_references ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicCredentialReference), total, page: currentPage, page_size: limit };
}

export function setCredentialReferenceStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = queryOne(
    db,
    "SELECT * FROM ie_connector_credential_references WHERE tenant_id = ? AND (code = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), normalizeUpper(ref), String(ref)]
  );
  if (!row) throw connectorNotFound(ref);
  const next = normalizeText(status, { max: 16 }).toLowerCase();
  if (!["active", "inactive", "retired"].includes(next)) throw invalidConnector(`Invalid credential status: ${status}`);
  run(db, "UPDATE ie_connector_credential_references SET status = ?, updated_at = ? WHERE id = ?", [next, nowIso(), row.id]);
  writeAudit(db, { actor, action: "data_exchange.credential.status", resourceType: "ie_connector_credential_references", resourceId: row.code, details: { status: next }, ip });
  return publicCredentialReference(queryOne(db, "SELECT * FROM ie_connector_credential_references WHERE id = ?", [row.id]));
}

export { MAX_MAPPINGS };
