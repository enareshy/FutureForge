// Provider registry for digital thread traversal.
//
// The thread engine is provider-based so it can follow edges from any platform
// domain without becoming another graph. Each provider declares the node types
// it understands and exposes two operations:
//
//   resolveMany(db, tenantId, refs, context) -> thread nodes
//   neighbors(db, tenantId, refs, context)   -> thread edges
//
// A provider may emit edges to node types it does not own (for example the BOM
// provider links a PART object to a BOM revision); traversal resolves the
// resulting nodes through whichever provider owns them.
import { nodeRefKey } from "./validation.js";

const registry = new Map();

export function nodeRef(objectType, objectId) {
  return `${String(objectType)}:${String(objectId)}`;
}

export function parseNodeRef(ref) {
  const text = String(ref || "");
  const index = text.indexOf(":");
  if (index <= 0) return { objectType: text, objectId: "" };
  return { objectType: text.slice(0, index), objectId: text.slice(index + 1) };
}

export function registerProvider(provider) {
  if (!provider?.code) throw new Error("A thread provider needs a code");
  registry.set(provider.code, provider);
  return provider.code;
}

export function getProvider(code) {
  return registry.get(String(code)) || null;
}

export function listProviders() {
  return [...registry.values()].map((provider) => ({
    code: provider.code,
    name: provider.name || provider.code,
    object_types: [...(provider.object_types || [])],
    builtin: Boolean(provider.builtin),
  }));
}

export function allProviders() {
  return [...registry.values()];
}

// Providers that accept a node type. Object types are lower-cased for
// comparison because metadata type codes are lower-case by convention.
export function providersForType(objectType) {
  const type = String(objectType || "").toLowerCase();
  const matches = [];
  for (const provider of registry.values()) {
    if (typeof provider.accepts === "function") {
      if (provider.accepts({ objectType: type })) matches.push(provider);
      continue;
    }
    if ((provider.object_types || []).map((code) => String(code).toLowerCase()).includes(type)) matches.push(provider);
  }
  return matches;
}

export function providerForType(objectType) {
  return providersForType(objectType)[0] || null;
}

// Resolves a set of refs through the owning providers, de-duplicating by
// node_ref. Returns a map keyed by node_ref plus the list of unresolved refs.
export function resolveRefs(db, tenantId, refs, context = {}) {
  const byProvider = new Map();
  for (const ref of refs) {
    if (!ref?.objectType || !ref?.objectId) continue;
    const key = nodeRefKey({ objectType: ref.objectType, objectId: ref.objectId });
    if (context.resolved?.has(key)) continue;
    for (const provider of providersForType(ref.objectType)) {
      if (!byProvider.has(provider.code)) byProvider.set(provider.code, { provider, refs: [] });
      byProvider.get(provider.code).refs.push(ref);
    }
  }
  const nodes = new Map();
  const unresolved = [];
  for (const { provider, refs: providerRefs } of byProvider.values()) {
    let resolved = [];
    if (typeof provider.resolveMany === "function") {
      resolved = provider.resolveMany(db, tenantId, providerRefs, context) || [];
    } else if (typeof provider.resolve === "function") {
      resolved = providerRefs.map((ref) => provider.resolve(db, tenantId, ref, context)).filter(Boolean);
    }
    const found = new Set();
    for (const node of resolved) {
      if (!node) continue;
      nodes.set(node.node_ref, node);
      found.add(node.node_ref);
    }
    for (const ref of providerRefs) {
      const key = nodeRefKey(ref);
      if (!found.has(key)) unresolved.push(ref);
    }
  }
  return { nodes, unresolved };
}

export function resetProviders() {
  registry.clear();
}
