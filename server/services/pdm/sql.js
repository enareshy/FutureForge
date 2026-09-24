// Small SQL helpers shared by the PDM domain services. They keep the
// update/patch and count patterns in exactly one place.
import { nowIso, run } from "../../db.js";

// Applies a whitelisted patch to a row, always touching updated_at. Unknown keys
// are ignored so a caller can pass a merged object without escaping column names
// into SQL (keys come from our own code, never directly from the request).
export function updateRow(db, table, id, patch, { columns = null, touch = true } = {}) {
  const allowed = columns ? new Set(columns) : null;
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined && (!allowed || allowed.has(key)));
  if (!keys.length) return 0;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const params = keys.map((key) => patch[key]);
  let sql = `UPDATE ${table} SET ${assignments}`;
  if (touch) {
    sql += ", updated_at = ?";
    params.push(nowIso());
  }
  sql += " WHERE id = ?";
  params.push(Number(id));
  return run(db, sql, params).changes || 0;
}

// Applies optimistic-locking on update: when `expectedVersion` is supplied and
// does not match the persisted version, a 409 is raised instead of silently
// overwriting a concurrent change.
export function assertVersion(row, expectedVersion, conflict) {
  if (expectedVersion === null || expectedVersion === undefined || expectedVersion === "") return;
  const expected = Number(expectedVersion);
  if (!Number.isFinite(expected)) return;
  if (Number(row.version) !== expected) throw conflict({ expected_version: expected, actual_version: Number(row.version) });
}

export function bumpVersion(row) {
  return Number(row.version || 0) + 1;
}
