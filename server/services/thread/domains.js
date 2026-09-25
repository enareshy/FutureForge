// Domain catalog resolution.
//
// A "domain" is a logical lifecycle stage (Requirement, Part, EBOM, ...). The
// built-in catalog is extendable per definition, so an organization can remap
// object types to its own stages without changing the engine. This module is
// pure: it only shapes catalog data, never touches the database.
import { DOMAIN_CODES, DOMAIN_TYPES } from "./constants.js";

const IMPORTANCE = new Map(DOMAIN_TYPES.map((entry) => [entry.code, entry.order]));

export function builtinDomains() {
  return DOMAIN_TYPES.map((entry) => ({
    domain_code: entry.code,
    label: entry.label,
    description: "",
    object_types: [...entry.object_types],
    color: entry.color,
    icon: entry.icon,
    is_required: false,
    display_order: entry.order,
    metadata: {},
  }));
}

// Merges built-in domains with a definition's overrides. A definition may add a
// domain, relabel a built-in one, or replace its object-type mapping.
export function domainCatalog(definition = null) {
  const merged = new Map(builtinDomains().map((entry) => [entry.domain_code, entry]));
  const overrides = definition?.domains || [];
  for (const override of overrides) {
    const code = String(override.domain_code || override.code || "").toUpperCase();
    if (!code) continue;
    const base = merged.get(code) || {
      domain_code: code,
      label: override.label || code,
      description: "",
      object_types: [],
      color: override.color || "",
      icon: override.icon || "",
      is_required: Boolean(override.is_required),
      display_order: override.display_order ?? 100,
      metadata: {},
    };
    merged.set(code, {
      ...base,
      label: override.label || base.label,
      description: override.description ?? base.description,
      object_types: Array.isArray(override.object_types) && override.object_types.length ? override.object_types.map((type) => String(type).toLowerCase()) : base.object_types,
      color: override.color || base.color,
      icon: override.icon || base.icon,
      is_required: override.is_required === undefined ? base.is_required : Boolean(override.is_required),
      display_order: override.display_order ?? base.display_order,
      metadata: override.metadata || base.metadata,
    });
  }
  return [...merged.values()].sort((a, b) => Number(a.display_order) - Number(b.display_order) || String(a.domain_code).localeCompare(String(b.domain_code)));
}

export function domainForType(objectType, definition = null) {
  const type = String(objectType || "").toLowerCase();
  if (!type) return "";
  for (const entry of domainCatalog(definition)) {
    if (entry.object_types.map((code) => String(code).toLowerCase()).includes(type)) return entry.domain_code;
  }
  return "";
}

export function domainExists(code, definition = null) {
  return domainCatalog(definition).some((entry) => entry.domain_code === String(code || "").toUpperCase());
}

export function domainOrder(code) {
  return IMPORTANCE.get(String(code || "").toUpperCase()) ?? 999;
}

export { DOMAIN_CODES };
