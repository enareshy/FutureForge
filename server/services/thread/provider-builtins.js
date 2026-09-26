// Registers the built-in digital thread providers. Kept separate from the
// registry so provider modules can import registry helpers without a cycle.
import { registerProvider } from "./providers.js";
import { objectProvider } from "./provider-object.js";
import { pdmProvider } from "./provider-pdm.js";
import { bomProvider } from "./provider-bom.js";

let registered = false;

export function registerBuiltinProviders() {
  if (registered) return ["object", "pdm", "bom"];
  registerProvider(objectProvider);
  registerProvider(pdmProvider);
  registerProvider(bomProvider);
  registered = true;
  return ["object", "pdm", "bom"];
}
