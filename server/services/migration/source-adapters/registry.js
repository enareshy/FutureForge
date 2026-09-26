// Pluggable migration source-adapter registry.
//
// A source adapter knows how to extract records (and optionally binary files)
// from one class of legacy system: a database, a file export, a REST endpoint, a
// PLM/PDM/ERP/MES system or object storage. The engine never hard-codes a source
// system: it looks the adapter up by type and drives it through the uniform
// interface below.
//
// Adapter interface:
//   code, name, description, adapter_type, capabilities[], settings_schema
//   testConnection(ctx)   -> { ok, message, details? }
//   discoverSchema(ctx)   -> { fields: [{ name, data_type }], sample: [] }
//   extract(ctx)          -> { fields, records, cursor?, files? }
//
// `ctx` carries { db, tenantId, settings, credential, definition, package,
// project, cursor, limit, pageSize }.
import { SOURCE_ADAPTER_CAPABILITIES } from "../constants.js";
import { adapterNotFound, adapterUnsupported, invalidSource } from "../errors.js";

const registry = new Map();

function assertAdapterShape(adapter) {
  if (!adapter || typeof adapter !== "object") throw invalidSource("A source adapter definition is required");
  if (!adapter.adapter_type) throw invalidSource("A source adapter requires an adapter_type");
  if (typeof adapter.extract !== "function") throw invalidSource(`Source adapter ${adapter.adapter_type} must implement extract`);
  for (const capability of adapter.capabilities || []) {
    if (!SOURCE_ADAPTER_CAPABILITIES.includes(capability)) {
      throw invalidSource(`Source adapter ${adapter.adapter_type} has invalid capability ${capability}`);
    }
  }
}

export function registerSourceAdapter(adapter, { replace = true } = {}) {
  assertAdapterShape(adapter);
  const code = String(adapter.adapter_type).toUpperCase();
  if (registry.has(code) && !replace) throw invalidSource(`Source adapter already registered: ${code}`);
  const entry = {
    adapter_type: code,
    code,
    name: adapter.name || code,
    description: adapter.description || "",
    capabilities: adapter.capabilities || [],
    settings_schema: adapter.settings_schema || {},
    built_in: Boolean(adapter.built_in),
    testConnection: adapter.testConnection || (() => ({ ok: true, message: "No connection test implemented" })),
    discoverSchema: adapter.discoverSchema || ((ctx) => extractSchemaFallback(adapter, ctx)),
    extract: adapter.extract,
  };
  registry.set(code, entry);
  return entry;
}

// Plain adapters without a discoverSchema implementation still get a schema by
// reading a small sample through extract.
async function extractSchemaFallback(adapter, ctx) {
  const pageSize = Number(ctx?.pageSize) || 10;
  const result = await adapter.extract({ ...ctx, limit: Math.min(Number(ctx?.limit) || pageSize, 100) });
  const records = Array.isArray(result?.records) ? result.records : [];
  const names = result?.fields && result.fields.length ? result.fields.map((field) => (typeof field === "string" ? field : field.name)) : Object.keys(records[0] || {});
  return { fields: names.map((name) => ({ name, data_type: "string" })), sample: records.slice(0, 10) };
}

export function unregisterSourceAdapter(adapterType) {
  return registry.delete(String(adapterType || "").toUpperCase());
}

export function getSourceAdapter(adapterType) {
  return registry.get(String(adapterType || "").toUpperCase()) || null;
}

export function requireSourceAdapter(adapterType) {
  const adapter = getSourceAdapter(adapterType);
  if (!adapter) throw adapterNotFound(adapterType);
  return adapter;
}

export function listSourceAdapters() {
  return [...registry.values()].map((adapter) => ({
    adapter_type: adapter.adapter_type,
    name: adapter.name,
    description: adapter.description,
    capabilities: adapter.capabilities,
    settings_schema: adapter.settings_schema,
    built_in: adapter.built_in,
  }));
}

export function sourceAdapterTypes() {
  return [...registry.keys()];
}

export function supportsCapability(adapterType, capability) {
  const adapter = getSourceAdapter(adapterType);
  return Boolean(adapter && adapter.capabilities.includes(String(capability).toUpperCase()));
}

export function assertAdapterCapability(adapterType, capability) {
  const adapter = requireSourceAdapter(adapterType);
  const wanted = String(capability).toUpperCase();
  if (!adapter.capabilities.includes(wanted)) throw adapterUnsupported(adapter.adapter_type, wanted);
  return adapter;
}
