// Low-level persistence helpers for Data Observability.
//
// Rows are stored with `*_json` text columns; these helpers expand them into
// nested DTOs so the service layer never sees serialization details. All list
// queries go through `paged` so pagination, filtering and ordering stay
// consistent and safe (values are always bound, never interpolated).
import { queryAll, queryOne } from "../../db.js";

export function parseJson(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = "{}") {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

export function paged(db, table, { where = [], params = [], orderBy = "id DESC", page = 1, pageSize = 50, map = (row) => row } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(500, Math.max(1, Number(pageSize) || 50));
  const offset = (safePage - 1) * safeSize;
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${clause}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ${table} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, safeSize, offset]);
  return { items: rows.map(map), total, page: safePage, pageSize: safeSize };
}

export function tableExists(db, table) {
  try {
    return Boolean(queryOne(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]));
  } catch {
    return false;
  }
}

export function columnExists(db, table, column) {
  try {
    return queryAll(db, `PRAGMA table_info(${table})`).some((row) => String(row.name) === String(column));
  } catch {
    return false;
  }
}

export function tenantExists(db, tenantId) {
  return Boolean(queryOne(db, "SELECT id FROM organizations WHERE id = ?", [Number(tenantId)]));
}
