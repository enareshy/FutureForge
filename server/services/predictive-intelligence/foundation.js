// Idempotent bootstrap for the Predictive Intelligence & Recommendations layer.
//
// Called on every application boot: registers the layer's domain event types and
// tenant configuration definitions. Built-in use cases are seeded per tenant on
// first use (they are tenant data, not global metadata) via
// `ensureBuiltInUseCases`.
import { ensurePredictiveEventTypes, ensurePredictiveEventTypesAsync } from "./events.js";
import { ensurePredictiveConfig, ensurePredictiveConfigAsync } from "./configuration.js";
import { SOURCE_MODULE } from "./constants.js";

export function ensurePredictiveFoundation(db) {
  const eventTypes = ensurePredictiveEventTypes(db);
  const configuration = ensurePredictiveConfig(db);
  return { source_module: SOURCE_MODULE, event_types: eventTypes, configuration };
}

export async function ensurePredictiveFoundationAsync(db) {
  const eventTypes = await ensurePredictiveEventTypesAsync(db);
  const configuration = await ensurePredictiveConfigAsync(db);
  return { source_module: SOURCE_MODULE, event_types: eventTypes, configuration };
}
