// Pluggable connector registry.
//
// A connector is a provider that knows how to read from / write to one kind of
// source or destination (CSV, JSON, XML, Excel, REST, a database, a file store,
// a legacy PLM, ...). The engine never hard-codes a format or endpoint: it looks
// the connector up by type and drives it through the uniform interface below.
//
// Connector interface:
//   code, name, description, directions[], capabilities[], formats[]
//   testConnection(ctx)   -> { ok, message, details? }
//   discoverSchema(ctx)   -> { fields: [{ name, data_type }], sample: [] }
//   read(ctx)             -> { fields, records, cursor? }
//   write(ctx)            -> { content, content_type, extension, records }
//
// `ctx` carries { settings, credentials, buffer, content, object_type, definition }.
import { CONNECTOR_CAPABILITIES, CONNECTOR_DIRECTIONS } from "../constants.js";
import { connectorNotFound, connectorUnsupported, invalidConnector } from "../errors.js";

const registry = new Map();

function assertConnectorShape(connector) {
  if (!connector || typeof connector !== "object") throw invalidConnector("A connector definition is required");
  if (!connector.code) throw invalidConnector("A connector requires a code");
  if (typeof connector.read !== "function" && typeof connector.write !== "function") {
    throw invalidConnector(`Connector ${connector.code} must implement read and/or write`);
  }
  for (const direction of connector.directions || []) {
    if (!CONNECTOR_DIRECTIONS.includes(direction)) throw invalidConnector(`Connector ${connector.code} has invalid direction ${direction}`);
  }
  for (const capability of connector.capabilities || []) {
    if (!CONNECTOR_CAPABILITIES.includes(capability)) throw invalidConnector(`Connector ${connector.code} has invalid capability ${capability}`);
  }
}

export function registerConnector(connector, { replace = true } = {}) {
  assertConnectorShape(connector);
  if (registry.has(connector.code) && !replace) throw invalidConnector(`Connector already registered: ${connector.code}`);
  const entry = {
    code: connector.code,
    name: connector.name || connector.code,
    description: connector.description || "",
    directions: connector.directions || [],
    capabilities: connector.capabilities || [],
    formats: connector.formats || [],
    built_in: Boolean(connector.built_in),
    testConnection: connector.testConnection || (() => ({ ok: true, message: "No connection test implemented" })),
    discoverSchema: connector.discoverSchema || (() => ({ fields: [], sample: [] })),
    read: connector.read,
    write: connector.write,
  };
  registry.set(entry.code, entry);
  return entry;
}

export function unregisterConnector(code) {
  return registry.delete(code);
}

export function getConnector(code) {
  return registry.get(String(code || "").toUpperCase()) || null;
}

export function requireConnector(code) {
  const connector = getConnector(code);
  if (!connector) throw connectorNotFound(code);
  return connector;
}

export function listConnectors() {
  return [...registry.values()].map((connector) => ({
    code: connector.code,
    name: connector.name,
    description: connector.description,
    directions: connector.directions,
    capabilities: connector.capabilities,
    formats: connector.formats,
    built_in: connector.built_in,
  }));
}

export function connectorTypes() {
  return [...registry.keys()];
}

export function supportsCapability(code, capability) {
  const connector = getConnector(code);
  return Boolean(connector && connector.capabilities.includes(capability));
}

export function assertConnectorCapability(code, capability) {
  const connector = requireConnector(code);
  if (!connector.capabilities.includes(capability)) throw connectorUnsupported(connector.code, capability);
  return connector;
}

export function assertConnectorDirection(code, direction) {
  const connector = requireConnector(code);
  if (!connector.directions.includes(direction) && !connector.directions.includes("BOTH")) {
    throw connectorUnsupported(connector.code, direction);
  }
  return connector;
}
