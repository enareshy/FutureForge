// Source-adapter subsystem facade. Importing this module does not register
// anything; call `ensureSourceAdapters()` (idempotent) from the foundation boot.
import * as Registry from "./registry.js";
import { registerBuiltinSourceAdapters } from "./builtins.js";

export { Registry, registerBuiltinSourceAdapters };

export function ensureSourceAdapters() {
  return registerBuiltinSourceAdapters();
}

export const SourceAdapters = {
  register: Registry.registerSourceAdapter,
  unregister: Registry.unregisterSourceAdapter,
  get: Registry.getSourceAdapter,
  require: Registry.requireSourceAdapter,
  list: Registry.listSourceAdapters,
  types: Registry.sourceAdapterTypes,
  supports: Registry.supportsCapability,
  assertCapability: Registry.assertAdapterCapability,
  ensure: ensureSourceAdapters,
};

export default SourceAdapters;
