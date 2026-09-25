// Tenant- and version-aware read cache for Digital Thread traversal projections.
//
// Definition resolution, node/edge providers and impact adjacency are read on
// every exploration; hot reads are cached and invalidated by a per-tenant epoch
// that structural writes bump. Authorization decisions are never cached.
const store = new Map();
const epochs = new Map();
let hits = 0;
let misses = 0;

function epochOf(tenantId) {
  return Number(epochs.get(Number(tenantId)) || 0);
}

function keyOf(tenantId, key) {
  return `${Number(tenantId)}:${key}`;
}

export function bumpEpoch(tenantId = null) {
  if (tenantId === null || tenantId === undefined) {
    for (const [key, value] of epochs.entries()) epochs.set(key, value + 1);
    return;
  }
  const id = Number(tenantId);
  epochs.set(id, epochOf(id) + 1);
}

export function cacheGet(tenantId, key, { epoch = null } = {}) {
  const entry = store.get(keyOf(tenantId, key));
  if (!entry) {
    misses += 1;
    return undefined;
  }
  if (entry.expiresAt <= Date.now() || (epoch !== null && entry.epoch !== Number(epoch))) {
    store.delete(keyOf(tenantId, key));
    misses += 1;
    return undefined;
  }
  hits += 1;
  return entry.value;
}

export function cacheSet(tenantId, key, value, ttlSeconds = 300) {
  store.set(keyOf(tenantId, key), {
    value,
    expiresAt: Date.now() + Math.max(0, Number(ttlSeconds)) * 1000,
    epoch: epochOf(tenantId),
  });
  return value;
}

// Loads through the cache; the loader runs only on a miss. The epoch captured
// before the loader runs is stored so a write during the load invalidates it.
export function cached(tenantId, key, ttlSeconds, loader) {
  const epoch = epochOf(tenantId);
  const existing = cacheGet(tenantId, key, { epoch });
  if (existing !== undefined) return existing;
  const value = loader();
  cacheSet(tenantId, key, value, ttlSeconds);
  const entry = store.get(keyOf(tenantId, key));
  if (entry) entry.epoch = epoch;
  return value;
}

export function invalidate(tenantId = null) {
  if (tenantId === null || tenantId === undefined) {
    store.clear();
    return;
  }
  const prefix = `${Number(tenantId)}:`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheStats() {
  return { entries: store.size, hits, misses, tenants: new Set([...store.keys()].map((key) => key.split(":")[0])).size };
}

export function resetCacheStats() {
  hits = 0;
  misses = 0;
}
