// Small SQL helpers shared by the migration domain services. They keep the
// update/patch and count patterns in exactly one place.
import { nowIso, run } from "../../db.js";

// Applies a whitelisted patch to a row, always touching updated_at. Unknown keys
// are ignored so a caller can pass a merged object without escaping column names
// into SQL (the keys come from our own code, never the request).
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
