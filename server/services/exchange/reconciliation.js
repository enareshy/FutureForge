// Exchange reconciliation (§18).
//
// A reconciliation is the durable, queryable record of what an exchange
// operation actually did: records read/validated/created/updated/skipped/
// failed, relationships created/failed, files processed, warnings and errors.
// It is derived from the transaction plus its findings and never mutates
// enterprise data, so it is always safe to (re)run.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { reconciliationRef } from "./identifiers.js";
import { publicReconciliation } from "./repository.js";
import { RECONCILIATION_COUNTERS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { transactionNotFound } from "./errors.js";
import { runtimeCounts } from "./processor-runtime.js";

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function emptyCounts() {
  const counts = {};
  for (const key of RECONCILIATION_COUNTERS) counts[key] = 0;
  return counts;
}

export function normalizeCounts(input = {}) {
  const counts = emptyCounts();
  for (const key of RECONCILIATION_COUNTERS) {
    if (input[key] !== undefined) counts[key] = Math.max(0, Number(input[key]) || 0);
  }
  if (input.recordsRead !== undefined && input.records_read === undefined) counts.records_read = Number(input.recordsRead) || 0;
  if (input.recordsCreated !== undefined && input.records_created === undefined) counts.records_created = Number(input.recordsCreated) || 0;
  if (input.recordsFailed !== undefined && input.records_failed === undefined) counts.records_failed = Number(input.recordsFailed) || 0;
  return counts;
}

export function recordReconciliation(db, tenantId, { transactionRef = "", counts = {}, details = {} } = {}) {
  const normalized = normalizeCounts(counts);
  const result = run(
    db,
    `INSERT INTO exchange_reconciliations
       (reconciliation_ref, tenant_id, transaction_ref, records_read, records_validated, records_created, records_updated,
        records_skipped, records_failed, relationships_created, relationships_failed, files_processed, warnings, errors, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reconciliationRef(),
      Number(tenantId),
      String(transactionRef || ""),
      normalized.records_read,
      normalized.records_validated,
      normalized.records_created,
      normalized.records_updated,
      normalized.records_skipped,
      normalized.records_failed,
      normalized.relationships_created,
      normalized.relationships_failed,
      normalized.files_processed,
      normalized.warnings,
      normalized.errors,
      JSON.stringify(details || {}),
      nowIso(),
    ]
  );
  return publicReconciliation(queryOne(db, "SELECT * FROM exchange_reconciliations WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function getReconciliation(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM exchange_reconciliations WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM exchange_reconciliations WHERE tenant_id = ? AND (reconciliation_ref = ? OR transaction_ref = ?) ORDER BY id DESC LIMIT 1", [
        Number(tenantId),
        raw,
        raw,
      ]);
  if (!row) throw transactionNotFound(ref);
  return publicReconciliation(row);
}

export function listReconciliations(db, tenantId, query = {}) {
  const { page, pageSize, offset } = pageArgs(query);
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.transaction_ref || query.transactionRef) {
    clauses.push("transaction_ref = ?");
    params.push(String(query.transaction_ref || query.transactionRef));
  }
  if (query.from) {
    clauses.push("created_at >= ?");
    params.push(String(query.from));
  }
  if (query.to) {
    clauses.push("created_at <= ?");
    params.push(String(query.to));
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_reconciliations WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_reconciliations WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicReconciliation), total, page, pageSize };
}

// Derives and persists a reconciliation for an existing transaction. Re-running
// is idempotent in effect: it appends a fresh reconciliation snapshot.
export function reconcileTransaction(db, tenantId, transactionRef, { actor = null, ip = null, persist = true, details = {} } = {}) {
  const txn = queryOne(db, "SELECT * FROM exchange_transactions WHERE tenant_id = ? AND (transaction_ref = ? OR id = ?)", [
    Number(tenantId),
    String(transactionRef),
    Number(transactionRef) || -1,
  ]);
  if (!txn) throw transactionNotFound(transactionRef);
  const counts = runtimeCounts(txn);
  const errorRows = queryAll(db, "SELECT severity, status, COUNT(*) AS c FROM exchange_errors WHERE tenant_id = ? AND transaction_ref = ? GROUP BY severity, status", [
    Number(tenantId),
    txn.transaction_ref,
  ]);
  for (const row of errorRows) {
    if (row.severity === "ERROR") counts.errors += Number(row.c);
    else if (row.severity === "WARNING") counts.warnings += Number(row.c);
  }
  if (!persist) return { transaction_ref: txn.transaction_ref, counts, details };
  const reconciliation = recordReconciliation(db, tenantId, {
    transactionRef: txn.transaction_ref,
    counts,
    details: { operation: txn.operation, direction: txn.direction, status: txn.status, ...(details || {}) },
  });
  run(db, "UPDATE exchange_transactions SET reconciliation_json = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify({ reconciliation_ref: reconciliation.reconciliation_ref, counts, reconciled_at: nowIso() }),
    nowIso(),
    txn.id,
  ]);
  return { transaction_ref: txn.transaction_ref, reconciliation, counts, details };
}
