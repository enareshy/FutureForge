// Built-in adapter registration (§3).
//
// Importing this module registers every bundled adapter exactly once. Adding a
// new standard means adding a file here (or registering at runtime); the core
// engine is never modified.
import { registerAdapter, adapters, StandardsExchangeAdapter, AdapterRegistry } from "./base.js";
import { jsonAdapter } from "./json.js";
import { xmlAdapter } from "./xml.js";
import { ediAdapter } from "./edi.js";
import { bomAdapter } from "./bom.js";
import { StepAp242Adapter, JtAdapter, PdfAAdapter, CadExchangeAdapter } from "./planned.js";

const BUILTIN = [
  jsonAdapter,
  xmlAdapter,
  ediAdapter,
  bomAdapter,
  new StepAp242Adapter(),
  new JtAdapter(),
  new PdfAAdapter(),
  new CadExchangeAdapter(),
];

let registered = false;

export function ensureBuiltinAdapters() {
  if (registered) return adapters.list().length;
  for (const adapter of BUILTIN) registerAdapter(adapter);
  registered = true;
  return adapters.list().length;
}

ensureBuiltinAdapters();

export function getAdapter(code) {
  return adapters.get(code);
}

export function listAdapters() {
  return adapters.list();
}

export function adapterCatalog() {
  return adapters.list().map((adapter) => ({
    code: adapter.code,
    name: adapter.name,
    category: adapter.category,
    status: adapter.status,
    provider: adapter.provider,
    library: adapter.library,
    capabilities: adapter.getCapabilities(),
    formats: adapter.getSupportedVersions(),
    extension_point: typeof adapter.getExtensionPoint === "function" ? adapter.getExtensionPoint() : null,
  }));
}

export {
  registerAdapter,
  adapters,
  StandardsExchangeAdapter,
  AdapterRegistry,
  jsonAdapter,
  xmlAdapter,
  ediAdapter,
  bomAdapter,
  StepAp242Adapter,
  JtAdapter,
  PdfAAdapter,
  CadExchangeAdapter,
};
