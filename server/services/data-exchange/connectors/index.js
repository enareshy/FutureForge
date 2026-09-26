// Connector subsystem facade. Importing this module does not register anything;
// call `ensureConnectors()` (idempotent) from the foundation/seed boot.
import * as Registry from "./registry.js";
import { registerBuiltinConnectors, connectorCatalog } from "./builtins.js";
import * as Codecs from "./codecs.js";

export { Registry, Codecs, registerBuiltinConnectors, connectorCatalog };

export function ensureConnectors() {
  return registerBuiltinConnectors();
}

export const Connectors = {
  register: Registry.registerConnector,
  unregister: Registry.unregisterConnector,
  get: Registry.getConnector,
  require: Registry.requireConnector,
  list: Registry.listConnectors,
  types: Registry.connectorTypes,
  supports: Registry.supportsCapability,
  assertCapability: Registry.assertConnectorCapability,
  assertDirection: Registry.assertConnectorDirection,
  ensure: ensureConnectors,
  catalog: connectorCatalog,
};

export default Connectors;
