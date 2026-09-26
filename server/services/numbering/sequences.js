// Sequence engine. Counters are stored one row per (scheme, scope, period) and
// advanced with a compare-and-swap UPDATE so concurrent callers across process
// boundaries can never receive the same value. Reset policies create a fresh,
// period-scoped counter instead of mutating history in place.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { sequenceExhausted, NUMBERING_ERROR_CODES, NumberingError } from "./errors.js";
import { buildPeriodKey, buildScopeKey, toSqlDate } from "./scopes.js";
import { formatSequence } from "./tokens.js";

const MAX_CAS_ATTEMPTS = 50;

function scopeColumns(scopeInput = {}) {
  return {
    tenant_id: scopeInput.tenantId ?? scopeInput.tenant_id ?? null,
    organization_id: scopeInput.organizationId ?? scopeInput.organization_id ?? null,
    plant_id: scopeInput.plantId ?? scopeInput.plant_id ?? null,
    site_id: scopeInput.siteId ?? scopeInput.site_id ?? null,
    classification: scopeInput.classification ?? "",
  };
}

export function scopeContextForScheme(scheme, request = {}) {
  return {
    sequenceScope: scheme.sequence_scope,
    schemeId: scheme.id,
    tenantId: request.tenantId ?? request.tenant_id ?? scheme.tenant_id ?? null,
    organizationId: request.organizationId ?? request.organization_id ?? null,
    plantId: request.plantId ?? request.plant_id ?? null,
    siteId: request.siteId ?? request.site_id ?? null,
    classification: request.classification ?? "",
    objectTypeCode: request.objectTypeCode ?? request.object_type_code ?? scheme.object_type_code,
  };
}

export function getOrCreateSequence(db, scheme, scopeInput, at = new Date()) {
  const scopeKey = buildScopeKey(scopeContextForScheme(scheme, scopeInput));
  const periodKey = buildPeriodKey(scheme.reset_policy, at);
  let sequence = queryOne(
    db,
    "SELECT * FROM numbering_sequences WHERE scheme_id = ? AND scope_key = ? AND period_key = ?",
    [scheme.id, scopeKey, periodKey]
  );
  if (sequence) return sequence;
  const ts = nowIso();
  const columns = scopeColumns(scopeInput);
  run(
    db,
    `INSERT OR IGNORE INTO numbering_sequences
       (scheme_id, scheme_version, scope_key, period_key, reset_policy, start_value, current_value, min_value, max_value,
        increment, padding, status, allocated_count, last_reset_at, tenant_id, organization_id, plant_id, site_id,
        classification, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scheme.id,
      scheme.current_version,
      scopeKey,
      periodKey,
      scheme.reset_policy,
      scheme.start_value,
      scheme.start_value - scheme.increment,
      scheme.min_value,
      scheme.max_value,
      scheme.increment,
      scheme.padding,
      columns.tenant_id,
      columns.organization_id,
      columns.plant_id,
      columns.site_id,
      columns.classification,
      ts,
      ts,
    ]
  );
  sequence = queryOne(
    db,
    "SELECT * FROM numbering_sequences WHERE scheme_id = ? AND scope_key = ? AND period_key = ?",
    [scheme.id, scopeKey, periodKey]
  );
  return sequence;
}

// Atomically reserves the next sequence value. Must be called inside a
// transaction for multi-process safety. Returns the sequence row (updated),
// the raw value and the padded representation.
export function allocateSequenceValue(db, scheme, scopeInput, options = {}) {
  const at = options.at || new Date();
  const nowStr = toSqlDate(at) || nowIso();
  const scopeKey = buildScopeKey(scopeContextForScheme(scheme, scopeInput));
  const periodKey = buildPeriodKey(scheme.reset_policy, at);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const sequence = getOrCreateSequence(db, scheme, scopeInput, at);
    if (sequence.status !== "active") {
      throw new NumberingError(409, `Sequence ${sequence.id} is ${sequence.status}`, NUMBERING_ERROR_CODES.SEQUENCE_NOT_FOUND, {
        sequenceId: sequence.id,
        status: sequence.status,
      });
    }
    const next = Number(sequence.current_value) + Number(sequence.increment);
    if (next > Number(sequence.max_value)) {
      run(db, "UPDATE numbering_sequences SET status = 'exhausted', updated_at = ? WHERE id = ?", [nowStr, sequence.id]);
      throw sequenceExhausted({
        sequenceId: sequence.id,
        scopeKey,
        maxValue: Number(sequence.max_value),
        currentValue: Number(sequence.current_value),
      });
    }
    const result = run(
      db,
      `UPDATE numbering_sequences
         SET current_value = ?, allocated_count = allocated_count + 1, last_allocated_at = ?, updated_at = ?
       WHERE id = ? AND current_value = ?`,
      [next, nowStr, nowStr, sequence.id, sequence.current_value]
    );
    if (result.changes === 1) {
      return {
        sequence: { ...sequence, current_value: next, last_allocated_at: nowStr },
        value: next,
        formatted: formatSequence(next, sequence.padding),
        scopeKey,
        periodKey,
      };
    }
  }
  throw new NumberingError(
    409,
    "Concurrent sequence update could not be completed",
    NUMBERING_ERROR_CODES.CONCURRENCY_CONFLICT
  );
}

// Non-mutating preview of the next value. Never advances or reserves.
export function previewSequenceValue(db, scheme, scopeInput, at = new Date()) {
  const scopeKey = buildScopeKey(scopeContextForScheme(scheme, scopeInput));
  const periodKey = buildPeriodKey(scheme.reset_policy, at);
  const sequence = queryOne(
    db,
    "SELECT * FROM numbering_sequences WHERE scheme_id = ? AND scope_key = ? AND period_key = ?",
    [scheme.id, scopeKey, periodKey]
  );
  const current = sequence ? Number(sequence.current_value) : Number(scheme.start_value) - Number(scheme.increment);
  const value = current + Number(scheme.increment);
  const padding = sequence ? sequence.padding : scheme.padding;
  const exhausted = value > Number(sequence ? sequence.max_value : scheme.max_value);
  const wouldReset = Boolean(periodKey) && !sequence;
  return {
    value,
    formatted: formatSequence(value, padding),
    scopeKey,
    periodKey,
    sequenceId: sequence?.id ?? null,
    exhausted,
    wouldReset,
  };
}

export function getSequenceRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM numbering_sequences WHERE id = ?", [Number.isFinite(id) ? id : -1]);
}

export function publicSequence(db, row) {
  if (!row) return null;
  const scheme = row.scheme_id
    ? queryOne(db, "SELECT code, name, object_type_code FROM numbering_schemes WHERE id = ?", [row.scheme_id])
    : null;
  const next = Number(row.current_value) + Number(row.increment);
  return {
    id: row.id,
    scheme_id: row.scheme_id,
    scheme_code: scheme?.code ?? null,
    scheme_name: scheme?.name ?? null,
    object_type: scheme?.object_type_code ?? null,
    scope_key: row.scope_key,
    period_key: row.period_key,
    reset_policy: row.reset_policy,
    start_value: row.start_value,
    current_value: row.current_value,
    next_value: next,
    min_value: row.min_value,
    max_value: row.max_value,
    increment: row.increment,
    padding: row.padding,
    status: row.status,
    allocated_count: row.allocated_count,
    utilization:
      Number(row.max_value) > Number(row.min_value)
        ? Math.min(100, Math.round(((Number(row.current_value) - Number(row.min_value) + Number(row.increment)) / (Number(row.max_value) - Number(row.min_value) + Number(row.increment))) * 1000) / 10)
        : null,
    remaining:
      Number(row.max_value) >= Number(row.current_value)
        ? Math.floor((Number(row.max_value) - Number(row.current_value)) / Number(row.increment))
        : 0,
    last_reset_at: row.last_reset_at,
    last_allocated_at: row.last_allocated_at,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    classification: row.classification,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSequences(db, { schemeId, scopeKey, status, tenantId, objectType, page = 1, pageSize = 25 } = {}) {
  const clauses = [];
  const params = [];
  if (schemeId) {
    clauses.push("s.scheme_id = ?");
    params.push(Number(schemeId));
  }
  if (scopeKey) {
    clauses.push("s.scope_key = ?");
    params.push(String(scopeKey));
  }
  if (status) {
    clauses.push("s.status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(s.tenant_id IS NULL OR s.tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (objectType) {
    clauses.push("sc.object_type_code = ?");
    params.push(String(objectType).toUpperCase());
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const base = `FROM numbering_sequences s LEFT JOIN numbering_schemes sc ON sc.id = s.scheme_id ${where}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c ${base}`, params).c;
  const rows = queryAll(
    db,
    `SELECT s.* ${base} ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)]
  );
  return { items: rows.map((row) => publicSequence(db, row)), total, page: Number(page), page_size: Number(pageSize) };
}

// Administrative reset. Sets the counter so the next allocation is `startValue`
// (or the scheme start). Recorded via audit; never used by ordinary users.
export function resetSequence(db, ref, input = {}, actor = null, ip = null) {
  const row = getSequenceRow(db, ref);
  if (!row) throw new HttpError(404, "Numbering sequence not found");
  const scheme = queryOne(db, "SELECT * FROM numbering_schemes WHERE id = ?", [row.scheme_id]);
  const startValue = input.startValue ?? input.start_value ?? scheme?.start_value ?? row.start_value;
  const increment = scheme?.increment ?? row.increment;
  const current = Number(startValue) - Number(increment);
  const ts = nowIso();
  run(
    db,
    `UPDATE numbering_sequences
       SET start_value = ?, current_value = ?, status = 'active', last_reset_at = ?, updated_at = ?
     WHERE id = ?`,
    [Number(startValue), current, ts, ts, row.id]
  );
  return publicSequence(db, getSequenceRow(db, row.id));
}

export { MAX_CAS_ATTEMPTS };
