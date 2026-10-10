// Tenant configuration for the Requirement -> Manufacturing integration.
//
// Definitions live in the platform configuration catalog (server/services/
// config.js) so the integration reuses layered resolution, validation, audit and
// admin APIs instead of adding its own configuration store (mirrors
// requirement-pdm/configuration.js).
import {
  ensureDefinitions,
  ensureDefinitionsAsync,
  getDefinition,
  resolveConfig,
  resolveAll,
  putValues,
  catalogAndEffective,
} from "../config.js";
import { CONFIG_KEYS, CONFIG_DEFAULTS, CONFIG_PREFIX } from "./constants.js";
import { invalidConfiguration } from "./errors.js";

const SHORT_BY_FULL = Object.freeze(
  Object.fromEntries(Object.keys(CONFIG_DEFAULTS).map((shortKey) => [`${CONFIG_PREFIX}${shortKey}`, shortKey]))
);

const FULL_BY_SHORT = Object.freeze(
  Object.fromEntries(Object.keys(CONFIG_DEFAULTS).map((shortKey) => [shortKey, `${CONFIG_PREFIX}${shortKey}`]))
);

export function configKey(key) {
  const text = String(key || "");
  if (text.startsWith(CONFIG_PREFIX)) {
    if (!SHORT_BY_FULL[text]) throw invalidConfiguration(`Unknown Requirement-Manufacturing setting: ${text}`);
    return text;
  }
  const full = FULL_BY_SHORT[text];
  if (!full) throw invalidConfiguration(`Unknown Requirement-Manufacturing setting: ${text}`);
  return full;
}

function shortKey(fullKey) {
  return SHORT_BY_FULL[fullKey] || fullKey.replace(CONFIG_PREFIX, "");
}

export function getConfig(db, tenantId, key) {
  const full = configKey(key);
  return resolveConfig(db, full, { tenantId: Number(tenantId) }).value;
}

export function listConfig(db, tenantId) {
  const resolved = resolveAll(db, { tenantId: Number(tenantId) });
  const output = { ...CONFIG_DEFAULTS };
  for (const entry of resolved) {
    if (!String(entry.key).startsWith(CONFIG_PREFIX)) continue;
    output[shortKey(entry.key)] = entry.value;
  }
  return output;
}

export function describeConfig(db, tenantId) {
  const resolved = resolveAll(db, { tenantId: Number(tenantId) });
  return resolved
    .filter((entry) => String(entry.key).startsWith(CONFIG_PREFIX))
    .map((entry) => ({ ...entry, key: shortKey(entry.key), full_key: entry.key }));
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  const full = configKey(key);
  putValues(db, { scope: "tenant", scopeId: Number(tenantId), values: { [full]: value } }, actor, ip);
  return getConfig(db, tenantId, full);
}

export function configCatalog(db, context = {}) {
  return catalogAndEffective(db, { tenantId: Number(context.tenantId) || undefined, organizationId: Number(context.organizationId) || undefined });
}

export function ensureRequirementManufacturingConfig(db) {
  ensureDefinitions(db);
  try {
    getDefinition(db, CONFIG_KEYS.autoTraceOnAllocation);
  } catch {
    // ensureDefinitions is authoritative; this is a defensive no-op.
  }
  return { definitions: Object.keys(CONFIG_KEYS).length };
}

export async function ensureRequirementManufacturingConfigAsync(db) {
  await ensureDefinitionsAsync(db);
  return { definitions: Object.keys(CONFIG_KEYS).length };
}
