// Per-request memoization.
//
// The synchronous service layer resolves the same authorization state several
// times per request (every `requirePermission` guard, plus route code that
// inspects the actor's access). Computing it once per request and reusing it
// removes a large amount of duplicated database work without any cross-request
// staleness: the cache lives for exactly one request and is never shared.
//
// Backed by AsyncLocalStorage so the context follows the request through the
// promise boundaries the Express handlers introduce. Outside a request (CLI
// scripts, seeders, tests) `memoize` simply computes without caching.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithRequestContext(fn) {
  return storage.run(new Map(), fn);
}

export function memoize(key, compute) {
  const store = storage.getStore();
  if (!store) return compute();
  if (store.has(key)) return store.get(key);
  const value = compute();
  store.set(key, value);
  return value;
}
