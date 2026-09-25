// Standards & Exchange history and error ledger.
//
// Every exchange operation appends an immutable exchange_history row (the
// queryable audit trail the domain owns) and mirrors it to the centralized
// Audit & History Framework. Structured validation/processing findings are
// persisted in exchange_errors so the UI can list, filter and resolve them
// without re-running a transaction.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicHistory, publicError } from "./repository.js";
import { SOURCE_MODULE, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, SEVERITIES } from "./constants.js";
import { normalizeUpper } from "../data-exchange/validation.js";

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function recordHistory(db, input = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_history
       (tenant_id, organization_id, transaction_ref, definition_code, definition_version, format_code, format_version,
        direction, action, status, actor_user_id, actor_username, counts_json, summary, correlation_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      input.organizationId ?? null,
      String(input.transactionRef || ""),
      String(input.definitionCode || ""),
      Number(input.definitionVersion || 0),
      String(input.formatCode || ""),
      String(input.formatVersion || ""),
      normalizeUpper(input.direction || "IMPORT"),
      normalizeUpper(input.action || "EXCHANGE"),
      normalizeUpper(input.status || ""),
      input.actorUserId != null ? Number(input.actorUserId) : input.actor?.id ?? null,
      String(input.actorUsername || input.actor?.username || ""),
      JSON.stringify(input.counts && typeof input.counts === "object" ? input.counts : {}),
      String(input.summary || ""),
      String(input.correlationId || ""),
      JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
      ts,
    ]
  );
  if (input.audit !== false) {
    try {
      writeAudit(db, {
        actor: input.actor || (input.actorUserId ? { id: input.actorUserId, username: input.actorUsername } : null),
        action: `exchange.${String(input.action || "exchange").toLowerCase()}`,
        resourceType: "exchange_transaction",
        resourceId: input.transactionRef ?? null,
        resourceName: input.transactionRef || input.definitionCode || "",
        details: {
          transaction_ref: input.transactionRef,
          definition_code: input.definitionCode,
          direction: input.direction,
          status: input.status,
          ...(input.details || {}),
        },
        sourceModule: SOURCE_MODULE,
        ip: input.ip || null,
      });
    } catch {
      // Auditing must never fail the business write.
    }
  }
  return Number(result.lastInsertRowid);
}

export function listHistory(db, { tenantId, transactionRef, definitionCode, formatCode, direction, action, status, from, to, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (transactionRef) {
    clauses.push("transaction_ref = ?");
    params.push(String(transactionRef));
  }
  if (definitionCode) {
    clauses.push("definition_code = ?");
    params.push(String(definitionCode));
  }
  if (formatCode) {
    clauses.push("format_code = ?");
    params.push(normalizeUpper(formatCode));
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(normalizeUpper(direction));
  }
  if (action) {
    clauses.push("action = ?");
    params.push(normalizeUpper(action));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (from) {
    clauses.push("created_at >= ?");
    params.push(String(from));
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(String(to));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { page: currentPage, pageSize: limit, offset } = pageArgs({ page, page_size: pageSize });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, pageSize: limit, source_module: SOURCE_MODULE };
}

export function transactionTimeline(db, tenantId, transactionRef) {
  const rows = queryAll(db, "SELECT * FROM exchange_history WHERE tenant_id = ? AND transaction_ref = ? ORDER BY id ASC", [
    Number(tenantId),
    String(transactionRef),
  ]);
  return rows.map(publicHistory);
}

export function recordErrors(db, tenantId, transactionRef, findings = [], { definitionCode = "" } = {}) {
  let created = 0;
  for (const entry of findings) {
    if (!entry) continue;
    run(
      db,
      `INSERT INTO exchange_errors
         (tenant_id, transaction_ref, definition_code, severity, code, message, source_path, target_object, attribute, rule, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      [
        Number(tenantId),
        String(transactionRef || ""),
        String(definitionCode || entry.definition_code || ""),
        SEVERITIES.includes(normalizeUpper(entry.severity)) ? normalizeUpper(entry.severity) : "ERROR",
        String(entry.code || ""),
        String(entry.message || ""),
        String(entry.source_path || entry.sourcePath || ""),
        String(entry.target_object || entry.targetObject || ""),
        String(entry.attribute || ""),
        String(entry.rule || ""),
        JSON.stringify(entry.details || {}),
        nowIso(),
      ]
    );
    created += 1;
  }
  return created;
}

export function listErrors(db, { tenantId, transactionRef, severity, status, code, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (transactionRef) {
    clauses.push("transaction_ref = ?");
    params.push(String(transactionRef));
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(normalizeUpper(severity));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (code) {
    clauses.push("code = ?");
    params.push(String(code));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { page: currentPage, pageSize: limit, offset } = pageArgs({ page, page_size: pageSize });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_errors ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_errors ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicError), total, page: currentPage, pageSize: limit, source_module: SOURCE_MODULE };
}

export function setErrorStatus(db, tenantId, errorId, status) {
  const next = normalizeUpper(status);
  if (!["OPEN", "RESOLVED", "IGNORED"].includes(next)) {
    throw new Error(`Unsupported error status: ${status}`);
  }
  const row = queryOne(db, "SELECT * FROM exchange_errors WHERE id = ? AND tenant_id = ?", [Number(errorId), Number(tenantId)]);
  if (!row) return null;
  run(db, "UPDATE exchange_errors SET status = ? WHERE id = ? AND tenant_id = ?", [next, row.id, Number(tenantId)]);
  return publicError(queryOne(db, "SELECT * FROM exchange_errors WHERE id = ?", [row.id]));
}

export function errorSummary(db, tenantId, transactionRef = null) {
  const params = [Number(tenantId)];
  let clause = "WHERE tenant_id = ?";
  if (transactionRef) {
    clause += " AND transaction_ref = ?";
    params.push(String(transactionRef));
  }
  const rows = queryAll(db, `SELECT severity, status, COUNT(*) AS c FROM exchange_errors ${clause} GROUP BY severity, status`, params);
  const summary = { ERROR: 0, WARNING: 0, INFO: 0, open: 0, resolved: 0, ignored: 0, total: 0 };
  for (const row of rows) {
    summary[row.severity] = (summary[row.severity] || 0) + Number(row.c);
    summary[String(row.status).toLowerCase()] = (summary[String(row.status).toLowerCase()] || 0) + Number(row.c);
    summary.total += Number(row.c);
  }
  return summary;
}
