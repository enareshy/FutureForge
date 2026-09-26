// Small SQL helpers shared by the Change Management domain services. They
// keep the update/patch and optimistic-lock patterns in exactly one place
// (mirrors server/services/pdm/sql.js).
import { nowIso, run } from "../../db.js";

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

export function assertVersion(row, expectedVersion, conflict) {
  if (expectedVersion === null || expectedVersion === undefined || expectedVersion === "") return;
  const expected = Number(expectedVersion);
  if (!Number.isFinite(expected)) return;
  if (Number(row.version) !== expected) throw conflict({ expected_version: expected, actual_version: Number(row.version) });
}

export function bumpVersion(row) {
  return Number(row.version || 0) + 1;
}
