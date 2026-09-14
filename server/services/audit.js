import { run, queryAll, queryOne } from "../db.js";

export function writeAudit(db, { actor, action, resourceType, resourceId, details, ip }) {
  run(
    db,
    `INSERT INTO audit_logs (actor_id, actor_username, action, resource_type, resource_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.id ?? null,
      actor?.username ?? "system",
      action,
      resourceType,
      resourceId == null ? null : String(resourceId),
      details ? JSON.stringify(details) : null,
      ip || null,
    ]
  );
}

export function listAuditLogs(db, { page, pageSize, offset, action, resourceType, q }) {
  const where = [];
  const params = [];
  if (action) {
    where.push("action = ?");
    params.push(action);
  }
  if (resourceType) {
    where.push("resource_type = ?");
    params.push(resourceType);
  }
  if (q) {
    where.push("(actor_username LIKE ? OR resource_id LIKE ? OR details LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
  }));
  return { items, total, page, pageSize };
}
