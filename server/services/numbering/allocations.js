// Allocation engine: the single place in the platform where enterprise numbers
// are generated, reserved, consumed, released, cancelled or expired.
//
// Correctness properties:
//   * uniqueness is enforced by a database unique index on `uniqueness_key`
//   * sequence values are taken with an atomic compare-and-swap UPDATE
//   * allocation + idempotency record + audit + outbox event share one txn
//   * historical rows are append-oriented; status only moves forward
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import {
  allocationNotFound,
  invalidNumberFormat,
  manualNumberingNotAllowed,
  numberAlreadyConsumed,
  numberAlreadyExists,
  reservationExpired,
  schemeInactive,
  NumberingError,
  NUMBERING_ERROR_CODES,
} from "./errors.js";
import { resolveApplicableScheme } from "./scopes.js";
import { buildScopeKey } from "./scopes.js";
import { scopeContextForScheme, allocateSequenceValue, previewSequenceValue } from "./sequences.js";
import { resolveTokenValues, renderPatternWithValues } from "./tokens.js";
import {
  emitNumberAllocated,
  emitNumberReserved,
  emitNumberConsumed,
  emitNumberReleased,
  emitNumberExpired,
  emitNumberCancelled,
} from "./events.js";
import { normalizeGenerateInput, normalizedObjectTypeCode } from "./validation.js";

const REUSE_AFTER_RELEASE = "reuse_after_release";
const REUSE_AFTER_EXPIRATION = "reuse_after_expiration";
const MANUAL_MODES = new Set(["manual", "automatic_with_manual_override", "manual_required"]);

// ── Projections ─────────────────────────────────────────────────────────────

export function publicAllocation(db, row) {
  if (!row) return null;
  const scheme = row.scheme_id
    ? queryOne(db, "SELECT code, name FROM numbering_schemes WHERE id = ?", [row.scheme_id])
    : null;
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}");
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    allocation_id: row.allocation_ref,
    allocation_ref: row.allocation_ref,
    number: row.number,
    object_type: row.object_type_code,
    object_id: row.object_id,
    object_ref: row.object_ref,
    scheme_id: row.scheme_id,
    scheme_code: scheme?.code ?? null,
    scheme_name: scheme?.name ?? null,
    scheme_version: row.scheme_version,
    sequence_id: row.sequence_id,
    sequence_value: row.sequence_value,
    is_manual: Boolean(row.is_manual),
    status: row.status,
    scope_key: row.scope_key,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    classification: row.classification,
    number_reuse_policy: row.number_reuse_policy,
    reusable: Boolean(row.reusable),
    requested_by: row.requested_by,
    requested_by_name: row.requested_by_name,
    consumed_by: row.consumed_by,
    consumed_by_name: row.consumed_by_name,
    requested_at: row.requested_at,
    reserved_at: row.reserved_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    released_at: row.released_at,
    cancelled_at: row.cancelled_at,
    reason: row.reason,
    source_application: row.source_application,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getAllocationRow(db, ref) {
  if (ref === null || ref === undefined) return null;
  const id = Number(ref);
  return queryOne(
    db,
    "SELECT * FROM numbering_allocations WHERE id = ? OR allocation_ref = ?",
    [Number.isFinite(id) ? id : -1, String(ref)]
  );
}

export function getAllocation(db, ref) {
  const row = getAllocationRow(db, ref);
  if (!row) throw allocationNotFound(ref);
  return publicAllocation(db, row);
}

// ── Idempotency ─────────────────────────────────────────────────────────────

export function hashRequest(input = {}) {
  const stable = JSON.stringify({
    objectType: input.object_type_code ?? null,
    organizationId: input.organization_id ?? null,
    plantId: input.plant_id ?? null,
    siteId: input.site_id ?? null,
    classification: input.classification ?? null,
    schemeCode: input.scheme_code ?? null,
    reserve: Boolean(input.reserve),
    manualNumber: input.manual_number ?? null,
    preferredNumber: input.preferred_number ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

function findIdempotent(db, key, tenantId) {
  if (!key) return null;
  return queryOne(
    db,
    "SELECT * FROM numbering_idempotency WHERE idempotency_key = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [String(key), tenantId ?? null]
  );
}

function rememberIdempotent(db, { key, tenantId, operation, requestHash, allocation, response }) {
  if (!key) return;
  const ts = nowIso();
  run(
    db,
    `INSERT OR IGNORE INTO numbering_idempotency
       (idempotency_key, tenant_id, operation, request_hash, allocation_id, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(key),
      tenantId ?? null,
      operation,
      requestHash,
      allocation?.id ?? null,
      JSON.stringify(response ?? {}),
      ts,
      null,
    ]
  );
}

function idempotentResult(db, record, requestHash) {
  if (!record) return null;
  if (record.request_hash && record.request_hash !== requestHash) {
    throw new NumberingError(
      409,
      "Idempotency key was already used for a different request",
      NUMBERING_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      { idempotencyKey: record.idempotency_key }
    );
  }
  let response = null;
  try {
    response = JSON.parse(record.response_json || "null");
  } catch {
    response = null;
  }
  if (response) return { ...response, idempotent_replay: true };
  if (record.allocation_id) return publicAllocation(db, getAllocationRow(db, record.allocation_id));
  return null;
}

// ── Scope helpers ───────────────────────────────────────────────────────────

function resolveScopeCodes(db, request) {
  const codeOf = (id) => {
    if (id === null || id === undefined || id === "") return "";
    const row = queryOne(db, "SELECT code FROM organizations WHERE id = ?", [Number(id)]);
    return row?.code ?? "";
  };
  return {
    organizationCode: codeOf(request.organization_id),
    plantCode: codeOf(request.plant_id),
    siteCode: codeOf(request.site_id),
  };
}

function extractionContext(db, scheme, request, { sequence, at }) {
  const codes = resolveScopeCodes(db, request);
  return {
    now: at,
    sequence,
    organizationCode: codes.organizationCode,
    plantCode: codes.plantCode,
    siteCode: codes.siteCode,
    classification: request.classification || "",
    objectType: scheme.object_type_code,
    username: request.username || request.actorName || "",
    fiscalYear: at.getUTCFullYear(),
  };
}

function renderNumber(db, scheme, request, { sequenceValue, sequenceFormatted, at }) {
  const ctx = extractionContext(db, scheme, request, { sequence: sequenceFormatted, at });
  const values = resolveTokenValues(db, ctx);
  if (sequenceFormatted !== undefined) values.SEQ = sequenceFormatted;
  if (sequenceValue !== undefined) values.SEQ = sequenceFormatted;
  const rendered = renderPatternWithValues(scheme.pattern, values);
  const number = `${scheme.prefix || ""}${rendered}${scheme.suffix || ""}`;
  if (scheme.max_length && number.length > Number(scheme.max_length)) {
    throw invalidNumberFormat(`Generated number exceeds maximum length of ${scheme.max_length}`, { number });
  }
  if (scheme.min_length && number.length < Number(scheme.min_length)) {
    throw invalidNumberFormat(`Generated number is shorter than the minimum length of ${scheme.min_length}`, { number });
  }
  return number;
}

function buildUniquenessKey(scopeKey, number) {
  return `${scopeKey}|${String(number)}`;
}

// ── Manual numbering validation ─────────────────────────────────────────────

export function validateManualNumber(db, scheme, request, number) {
  const result = { valid: true, errors: [], warnings: [] };
  const value = String(number || "").trim();
  if (!value) {
    return { valid: false, errors: ["Manual number is empty"], warnings: [] };
  }
  const normalizedMode = scheme.numbering_mode;
  const manualEnabled =
    MANUAL_MODES.has(normalizedMode) &&
    (scheme.manual_policy !== "disabled" || normalizedMode === "manual" || normalizedMode === "manual_required");
  if (!manualEnabled) {
    throw manualNumberingNotAllowed();
  }
  if (scheme.manual_pattern) {
    try {
      const re = new RegExp(scheme.manual_pattern);
      if (!re.test(value)) result.errors.push(`Manual number does not match pattern ${scheme.manual_pattern}`);
    } catch {
      result.warnings.push("Configured manual pattern is not a valid regular expression and was ignored");
    }
  }
  if (scheme.manual_allowed_chars) {
    const allowed = new Set(String(scheme.manual_allowed_chars).split(""));
    const invalid = [...value].filter((ch) => !allowed.has(ch));
    if (invalid.length) result.errors.push(`Manual number contains disallowed characters: ${[...new Set(invalid)].join("")}`);
  }
  const minLength = Number(scheme.manual_min_length) || Number(scheme.min_length) || 0;
  const maxLength = Number(scheme.manual_max_length) || Number(scheme.max_length) || 0;
  if (minLength && value.length < minLength) result.errors.push(`Manual number is shorter than ${minLength} characters`);
  if (maxLength && value.length > maxLength) result.errors.push(`Manual number is longer than ${maxLength} characters`);

  const scopeKey = buildScopeKeyFor(db, scheme, request);
  const existing = queryOne(db, "SELECT id, number FROM numbering_allocations WHERE uniqueness_key = ?", [
    buildUniquenessKey(scopeKey, value),
  ]);
  if (existing) result.errors.push(`Number "${value}" already exists in this scope`);
  result.valid = result.errors.length === 0;
  return result;
}

function buildScopeKeyFor(db, scheme, request) {
  const ctx = scopeContextForScheme(scheme, {
    tenantId: request.tenant_id ?? scheme.tenant_id ?? null,
    organizationId: request.organization_id ?? null,
    plantId: request.plant_id ?? null,
    siteId: request.site_id ?? null,
    classification: request.classification ?? "",
    objectTypeCode: request.object_type_code ?? scheme.object_type_code,
  });
  return buildScopeKey(ctx);
}

function scopeKeyOf(db, scheme, request) {
  return buildScopeKeyFor(db, scheme, request);
}

// ── Reuse ───────────────────────────────────────────────────────────────────

function findReusableAllocation(db, scheme, request, scopeKey) {
  const policy = scheme.number_reuse_policy;
  let status = null;
  if (policy === REUSE_AFTER_RELEASE) status = "released";
  else if (policy === REUSE_AFTER_EXPIRATION) status = "expired";
  else return null;
  return queryOne(
    db,
    `SELECT * FROM numbering_allocations
     WHERE object_type_code = ? AND scope_key = ? AND reusable = 1 AND status = ?
     ORDER BY requested_at ASC, id ASC LIMIT 1`,
    [scheme.object_type_code, scopeKey, status]
  );
}

function claimReusableAllocation(db, row, { reserve, request, actor }) {
  const ts = nowIso();
  const status = reserve ? "reserved" : "allocated";
  const expiresAt = reserve ? computeExpiry(null, request) : null;
  const result = run(
    db,
    `UPDATE numbering_allocations
       SET status = ?, reusable = 0, requested_by = ?, requested_by_name = ?, requested_at = ?,
           reserved_at = ?, expires_at = ?, released_at = NULL, reason = ?, source_application = ?,
           correlation_id = ?, request_id = ?, object_id = NULL, object_ref = '', updated_at = ?
     WHERE id = ? AND status = ? AND reusable = 1`,
    [
      status,
      actor?.id ?? null,
      actor?.username ?? actor?.display_name ?? "",
      ts,
      reserve ? ts : null,
      expiresAt,
      request.reason || "reused",
      request.source_application || "",
      request.correlation_id ?? null,
      request.request_id ?? null,
      ts,
      row.id,
      row.status,
    ]
  );
  if (result.changes !== 1) return null;
  return getAllocationRow(db, row.id);
}

function computeExpiry(scheme, request) {
  const configured = Number(request.reservation_timeout_seconds) || Number(scheme?.reservation_timeout_seconds) || 0;
  const seconds = configured > 0 ? configured : 900;
  return new Date(Date.now() + seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ── Generate / reserve ──────────────────────────────────────────────────────

export function generateNumber(db, body = {}, actor = null, options = {}) {
  const request = normalizeGenerateInput(body);
  request.tenant_id = options.tenantId ?? body.tenantId ?? null;
  request.actorName = actor?.username ?? actor?.display_name ?? "";
  request.username = actor?.username ?? "";
  const at = options.now ? new Date(options.now) : new Date();
  const idempotencyKey = options.idempotencyKey || request.idempotency_key || null;
  const requestHash = hashRequest(request);

  const preExisting = findIdempotent(db, idempotencyKey, request.tenant_id);
  if (preExisting) {
    const replay = idempotentResult(db, preExisting, requestHash);
    if (replay) return replay;
  }

  const scheme = resolveApplicableScheme(db, {
    objectTypeCode: request.object_type_code,
    schemeCode: request.scheme_code,
    tenantId: request.tenant_id,
    organizationId: request.organization_id,
    plantId: request.plant_id,
    siteId: request.site_id,
    classification: request.classification,
    now: at,
  });
  if (scheme.status !== "active") throw schemeInactive(scheme.code);

  const manualNumber = request.manual_number || request.preferred_number || null;

  const outcome = transaction(db, () => {
    const existingRecord = findIdempotent(db, idempotencyKey, request.tenant_id);
    if (existingRecord) {
      const replay = idempotentResult(db, existingRecord, requestHash);
      if (replay) return { replay };
    }

    let row = null;
    let number = null;
    let sequenceValue = null;
    let usedScopeKey = buildScopeKeyFor(db, scheme, request);

    if (manualNumber) {
      const validation = validateManualNumber(db, scheme, request, manualNumber);
      if (!validation.valid) {
        throw invalidNumberFormat(`Manual number rejected: ${validation.errors.join("; ")}`, {
          number: manualNumber,
          errors: validation.errors,
        });
      }
      number = String(manualNumber).trim();
      row = insertAllocation(db, {
        scheme,
        request,
        actor,
        scopeKey: usedScopeKey,
        number,
        sequenceValue: null,
        sequenceId: null,
        isManual: true,
        reserve: request.reserve,
        reusePolicy: scheme.number_reuse_policy,
        at,
      });
    } else {
      const reused = findReusableAllocation(db, scheme, request, usedScopeKey);
      if (reused) {
        row = claimReusableAllocation(db, reused, { reserve: request.reserve, request, actor });
        if (row) {
          number = row.number;
          sequenceValue = row.sequence_value;
        }
      }
      if (!row) {
        const allocationResult = allocateSequenceValue(db, scheme, request, { at });
        sequenceValue = allocationResult.value;
        usedScopeKey = allocationResult.scopeKey;
        number = renderNumber(db, scheme, request, {
          sequenceValue,
          sequenceFormatted: allocationResult.formatted,
          at,
        });
        row = insertAllocation(db, {
          scheme,
          request,
          actor,
          scopeKey: usedScopeKey,
          number,
          sequenceValue,
          sequenceId: allocationResult.sequence.id,
          isManual: false,
          reserve: request.reserve,
          reusePolicy: scheme.number_reuse_policy,
          at,
        });
      }
    }

    const response = publicAllocation(db, row);
    rememberIdempotent(db, {
      key: idempotencyKey,
      tenantId: request.tenant_id,
      operation: request.reserve ? "reserve" : "generate",
      requestHash,
      allocation: row,
      response,
    });
    writeAudit(db, {
      actor,
      action: request.reserve ? "numbering.allocation.reserve" : "numbering.allocation.generate",
      resourceType: "numbering_allocation",
      resourceId: row.id,
      details: {
        number,
        object_type: scheme.object_type_code,
        scheme: scheme.code,
        scheme_version: scheme.current_version,
        scope_key: usedScopeKey,
        manual: Boolean(manualNumber),
      },
      ip: options.ip ?? null,
    });
    return { row, response };
  });

  if (outcome.replay) return outcome.replay;
  const row = outcome.row;
  if (request.reserve) emitNumberReserved(db, row, actor);
  else emitNumberAllocated(db, row, actor);
  return outcome.response;
}

function insertAllocation(db, { scheme, request, actor, scopeKey, number, sequenceValue, sequenceId, isManual, reserve, reusePolicy, at }) {
  const ts = at.toISOString().replace("T", " ").slice(0, 19);
  const ref = `NAL-${randomUuid()}`;
  const status = reserve ? "reserved" : "allocated";
  const expiresAt = reserve ? computeExpiry(scheme, request) : null;
  try {
    const result = run(
      db,
      `INSERT INTO numbering_allocations
         (allocation_ref, number, uniqueness_key, object_type_code, object_id, object_ref, scheme_id, scheme_version,
          sequence_id, sequence_value, is_manual, status, scope_key, tenant_id, organization_id, plant_id, site_id,
          classification, number_reuse_policy, reusable, requested_by, requested_by_name, requested_at, reserved_at,
          expires_at, reason, source_application, request_id, correlation_id, idempotency_key, metadata_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ref,
        number,
        buildUniquenessKey(scopeKey, number),
        scheme.object_type_code,
        request.object_id ?? null,
        request.object_ref ?? "",
        scheme.id,
        scheme.current_version,
        sequenceId ?? null,
        sequenceValue,
        isManual ? 1 : 0,
        status,
        scopeKey,
        request.tenant_id ?? scheme.tenant_id ?? null,
        request.organization_id ?? null,
        request.plant_id ?? null,
        request.site_id ?? null,
        request.classification ?? "",
        reusePolicy ?? scheme.number_reuse_policy,
        actor?.id ?? null,
        actor?.username ?? actor?.display_name ?? "",
        ts,
        reserve ? ts : null,
        expiresAt,
        request.reason ?? "",
        request.source_application ?? "",
        request.request_id ?? null,
        request.correlation_id ?? null,
        request.idempotency_key ?? null,
        JSON.stringify(request.metadata || {}),
        ts,
        ts,
      ]
    );
    return getAllocationRow(db, Number(result.lastInsertRowid));
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) {
      throw numberAlreadyExists(number);
    }
    throw error;
  }
}

export function reserveNumber(db, body = {}, actor = null, options = {}) {
  const request = normalizeGenerateInput(body);
  return generateNumber(db, { ...request, reserve: true }, actor, options);
}

export function previewNumber(db, body = {}, options = {}) {
  const request = normalizeGenerateInput(body);
  request.tenant_id = options.tenantId ?? body.tenantId ?? null;
  const at = options.now ? new Date(options.now) : new Date();
  const scheme = resolveApplicableScheme(db, {
    objectTypeCode: request.object_type_code,
    schemeCode: request.scheme_code,
    tenantId: request.tenant_id,
    organizationId: request.organization_id,
    plantId: request.plant_id,
    siteId: request.site_id,
    classification: request.classification,
    now: at,
  });
  const preview = previewSequenceValue(db, scheme, request, at);
  const number = renderPreview(db, scheme, request, preview, at);
  return {
    number,
    scheme_id: scheme.id,
    scheme_code: scheme.code,
    scheme_version: scheme.current_version,
    sequence_value: preview.value,
    sequence_formatted: preview.formatted,
    scope_key: preview.scopeKey,
    period_key: preview.periodKey,
    would_reset: preview.wouldReset,
    exhausted: preview.exhausted,
    guaranteed: false,
    note: "Preview only. The value is not reserved and may be allocated to another request.",
  };
}

function renderPreview(db, scheme, request, preview, at) {
  const ref = resolveScopeCodes(db, request);
  const ctx = {
    now: at,
    sequence: preview.formatted,
    organizationCode: ref.organizationCode,
    plantCode: ref.plantCode,
    siteCode: ref.siteCode,
    classification: request.classification || "",
    objectType: scheme.object_type_code,
    username: request.username || "",
    fiscalYear: at.getUTCFullYear(),
  };
  const values = resolveTokenValues(db, ctx);
  values.SEQ = preview.formatted;
  return `${scheme.prefix || ""}${renderPatternWithValues(scheme.pattern, values)}${scheme.suffix || ""}`;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function assertTenantAccess(db, row, tenantId) {
  if (tenantId === null || tenantId === undefined) return;
  if (row.tenant_id === null || row.tenant_id === undefined) return;
  if (Number(row.tenant_id) !== Number(tenantId)) throw allocationNotFound(row.allocation_ref);
}

export function consumeNumber(db, ref, body = {}, actor = null, options = {}) {
  const row = getAllocationRow(db, ref);
  if (!row) throw allocationNotFound(ref);
  assertTenantAccess(db, row, options.tenantId ?? null);
  const objectId = body.objectId ?? body.object_id ?? row.object_id ?? null;
  const objectRef = body.objectRef ?? body.object_ref ?? row.object_ref ?? "";
  const reason = body.reason ?? row.reason ?? "";
  const tenantId = options.tenantId ?? row.tenant_id ?? null;

  if (row.status === "consumed") {
    if (objectId && row.object_id && String(row.object_id) !== String(objectId)) {
      throw numberAlreadyConsumed(row.allocation_ref);
    }
    return { ...publicAllocation(db, row), idempotent: true };
  }
  if (!["allocated", "reserved"].includes(row.status)) {
    throw new NumberingError(409, `Allocation cannot be consumed from status ${row.status}`, NUMBERING_ERROR_CODES.NUMBER_ALREADY_CONSUMED, { status: row.status });
  }
  const expiresAt = row.expires_at ? new Date(row.expires_at.replace(" ", "T") + "Z") : null;
  if (row.status === "reserved" && expiresAt && expiresAt.getTime() < Date.now() && !options.allowExpired) {
    throw reservationExpired(row.allocation_ref);
  }
  if (body.objectType || body.object_type) {
    const expected = normalizedObjectTypeCode(body);
    if (expected && expected !== row.object_type_code) {
      throw new NumberingError(409, "Allocation object type does not match request", NUMBERING_ERROR_CODES.INVALID_OBJECT_TYPE, {
        expected: row.object_type_code,
        actual: expected,
      });
    }
  }
  if (row.object_id && objectId && String(row.object_id) !== String(objectId)) {
    throw new NumberingError(409, "Allocation is bound to a different object", NUMBERING_ERROR_CODES.NUMBER_ALREADY_CONSUMED, {
      allocationObject: row.object_id,
      requestedObject: objectId,
    });
  }
  const consumed = transaction(db, () => {
    const ts = nowIso();
    const result = run(
      db,
      `UPDATE numbering_allocations
         SET status = 'consumed', consumed_by = ?, consumed_by_name = ?, consumed_at = ?, object_id = ?, object_ref = ?,
             reason = CASE WHEN ? <> '' THEN ? ELSE reason END, updated_at = ?
       WHERE id = ? AND status IN ('allocated', 'reserved')`,
      [
        actor?.id ?? null,
        actor?.username ?? actor?.display_name ?? "",
        ts,
        objectId,
        objectRef ?? "",
        reason ?? "",
        reason ?? "",
        ts,
        row.id,
      ]
    );
    if (result.changes !== 1) return null;
    writeAudit(db, {
      actor,
      action: "numbering.allocation.consume",
      resourceType: "numbering_allocation",
      resourceId: row.id,
      details: { number: row.number, object_type: row.object_type_code, object_id: objectId, tenant_id: tenantId },
      ip: options.ip ?? null,
    });
    return getAllocationRow(db, row.id);
  });
  if (!consumed) {
    const latest = getAllocationRow(db, row.id);
    if (latest?.status === "consumed") return { ...publicAllocation(db, latest), idempotent: true };
    throw numberAlreadyConsumed(row.allocation_ref);
  }
  emitNumberConsumed(db, consumed, actor);
  return publicAllocation(db, consumed);
}

export function releaseNumber(db, ref, body = {}, actor = null, options = {}) {
  const row = getAllocationRow(db, ref);
  if (!row) throw allocationNotFound(ref);
  assertTenantAccess(db, row, options.tenantId ?? null);
  if (row.status === "released") return { ...publicAllocation(db, row), idempotent: true };
  if (!["allocated", "reserved"].includes(row.status)) {
    throw new NumberingError(409, `Allocation cannot be released from status ${row.status}`, NUMBERING_ERROR_CODES.NUMBER_ALREADY_CONSUMED, { status: row.status });
  }
  const reusable = row.number_reuse_policy === REUSE_AFTER_RELEASE ? 1 : 0;
  const released = transaction(db, () => {
    const ts = nowIso();
    run(
      db,
      `UPDATE numbering_allocations
         SET status = 'released', released_at = ?, reusable = ?, reason = CASE WHEN ? <> '' THEN ? ELSE reason END, updated_at = ?
       WHERE id = ? AND status IN ('allocated', 'reserved')`,
      [ts, reusable, body.reason ?? "", body.reason ?? "", ts, row.id]
    );
    writeAudit(db, {
      actor,
      action: "numbering.allocation.release",
      resourceType: "numbering_allocation",
      resourceId: row.id,
      details: { number: row.number, reusable: Boolean(reusable), reason: body.reason ?? "" },
      ip: options.ip ?? null,
    });
    return getAllocationRow(db, row.id);
  });
  emitNumberReleased(db, released, actor);
  return publicAllocation(db, released);
}

export function cancelNumber(db, ref, body = {}, actor = null, options = {}) {
  const row = getAllocationRow(db, ref);
  if (!row) throw allocationNotFound(ref);
  assertTenantAccess(db, row, options.tenantId ?? null);
  if (row.status === "cancelled") return { ...publicAllocation(db, row), idempotent: true };
  if (["consumed"].includes(row.status)) {
    throw new NumberingError(409, "A consumed number cannot be cancelled", NUMBERING_ERROR_CODES.NUMBER_ALREADY_CONSUMED);
  }
  const cancelled = transaction(db, () => {
    const ts = nowIso();
    run(
      db,
      `UPDATE numbering_allocations
         SET status = 'cancelled', cancelled_at = ?, reusable = 0, reason = CASE WHEN ? <> '' THEN ? ELSE reason END, updated_at = ?
       WHERE id = ? AND status IN ('allocated', 'reserved')`,
      [ts, body.reason ?? "", body.reason ?? "", ts, row.id]
    );
    writeAudit(db, {
      actor,
      action: "numbering.allocation.cancel",
      resourceType: "numbering_allocation",
      resourceId: row.id,
      details: { number: row.number, reason: body.reason ?? "" },
      ip: options.ip ?? null,
    });
    return getAllocationRow(db, row.id);
  });
  emitNumberCancelled(db, cancelled, actor);
  return publicAllocation(db, cancelled);
}

// Background expiry sweep. Reserved rows past their expiry move to EXPIRED and
// become reusable only when the scheme explicitly opts in.
export function expireReservations(db, { limit = 200, now = new Date() } = {}) {
  const nowStr = now.toISOString().replace("T", " ").slice(0, 19);
  const rows = queryAll(
    db,
    `SELECT * FROM numbering_allocations
     WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at ASC LIMIT ?`,
    [nowStr, Number(limit)]
  );
  const expired = [];
  for (const row of rows) {
    const reusable = row.number_reuse_policy === REUSE_AFTER_EXPIRATION ? 1 : 0;
    const result = run(
      db,
      `UPDATE numbering_allocations
         SET status = 'expired', reusable = ?, updated_at = ?
       WHERE id = ? AND status = 'reserved'`,
      [reusable, nowStr, row.id]
    );
    if (result.changes === 1) {
      const updated = getAllocationRow(db, row.id);
      writeAudit(db, {
        actor: null,
        action: "numbering.allocation.expire",
        resourceType: "numbering_allocation",
        resourceId: row.id,
        details: { number: row.number, reusable: Boolean(reusable) },
      });
      emitNumberExpired(db, updated, null);
      expired.push(publicAllocation(db, updated));
    }
  }
  return { expired_count: expired.length, items: expired };
}

// ── Query / validation ──────────────────────────────────────────────────────

export function listAllocations(db, query = {}) {
  const clauses = [];
  const params = [];
  if (query.tenantId !== undefined && query.tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(query.tenantId));
  }
  if (query.objectType) {
    clauses.push("object_type_code = ?");
    params.push(String(query.objectType).toUpperCase());
  }
  if (query.objectId) {
    clauses.push("object_id = ?");
    params.push(String(query.objectId));
  }
  if (query.schemeId) {
    clauses.push("scheme_id = ?");
    params.push(Number(query.schemeId));
  }
  if (query.schemeCode) {
    clauses.push("scheme_id IN (SELECT id FROM numbering_schemes WHERE code = ?)");
    params.push(String(query.schemeCode));
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status));
  }
  if (query.organizationId) {
    clauses.push("organization_id = ?");
    params.push(Number(query.organizationId));
  }
  if (query.plantId) {
    clauses.push("plant_id = ?");
    params.push(Number(query.plantId));
  }
  if (query.classification) {
    clauses.push("classification = ?");
    params.push(String(query.classification));
  }
  if (query.correlationId) {
    clauses.push("correlation_id = ?");
    params.push(String(query.correlationId));
  }
  if (query.reusable !== null && query.reusable !== undefined) {
    clauses.push("reusable = ?");
    params.push(query.reusable ? 1 : 0);
  }
  if (query.from) {
    clauses.push("requested_at >= ?");
    params.push(String(query.from).replace("T", " ").slice(0, 19));
  }
  if (query.to) {
    clauses.push("requested_at <= ?");
    params.push(String(query.to).replace("T", " ").slice(0, 19));
  }
  if (query.q) {
    clauses.push("(LOWER(number) LIKE ? OR LOWER(allocation_ref) LIKE ? OR LOWER(object_id) LIKE ? OR LOWER(object_ref) LIKE ?)");
    const like = `%${String(query.q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM numbering_allocations ${where}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM numbering_allocations ${where} ORDER BY requested_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, Number(query.pageSize || 25), ((Number(query.page) || 1) - 1) * Number(query.pageSize || 25)]
  );
  return {
    items: rows.map((row) => publicAllocation(db, row)),
    total,
    page: Number(query.page) || 1,
    page_size: Number(query.pageSize) || 25,
  };
}

// Full identifier validation used by the standalone validate API.
export function validateIdentifier(db, body = {}, options = {}) {
  const request = normalizeGenerateInput(body);
  request.tenant_id = options.tenantId ?? body.tenantId ?? null;
  const value = body.number ?? body.manualNumber ?? body.manual_number ?? null;
  const errors = [];
  const warnings = [];
  let scheme = null;
  try {
    scheme = resolveApplicableScheme(db, {
      objectTypeCode: request.object_type_code,
      schemeCode: request.scheme_code,
      tenantId: request.tenant_id,
      organizationId: request.organization_id,
      plantId: request.plant_id,
      siteId: request.site_id,
      classification: request.classification,
      now: new Date(),
    });
  } catch (error) {
    errors.push(error.message);
  }
  if (!value) {
    errors.push("number is required");
    return { valid: false, errors, warnings, scheme: scheme?.code ?? null, number: null };
  }
  const number = String(value).trim();
  const length = number.length;
  if (scheme) {
    if (scheme.max_length && length > Number(scheme.max_length)) errors.push(`Number exceeds maximum length of ${scheme.max_length}`);
    if (scheme.min_length && length < Number(scheme.min_length)) errors.push(`Number is shorter than minimum length of ${scheme.min_length}`);
    if (scheme.prefix && !number.startsWith(scheme.prefix)) errors.push(`Number must start with prefix "${scheme.prefix}"`);
    if (scheme.suffix && !number.endsWith(scheme.suffix)) errors.push(`Number must end with suffix "${scheme.suffix}"`);
    // Validate the number against the scheme pattern by structural comparison.
    if (scheme.pattern) {
      const patternCheck = validateAgainstPattern(scheme.pattern, number, scheme.prefix, scheme.suffix);
      if (!patternCheck.valid) errors.push(...patternCheck.errors);
    }
    const scopeKey = scopeKeyOf(db, scheme, request);
    const existing = queryOne(db, "SELECT id, status FROM numbering_allocations WHERE uniqueness_key = ?", [
      buildUniquenessKey(scopeKey, number),
    ]);
    if (existing) {
      warnings.push("Number already exists in this scope and cannot be reused unless the scheme allows it");
    }
  }
  return { valid: errors.length === 0, errors, warnings, scheme: scheme?.code ?? null, number };
}

// Structural pattern validation: replaces tokens with wildcard classes and
// anchors the remainder so manual numbers can be checked without allocating.
function validateAgainstPattern(pattern, number, prefix = "", suffix = "") {
  let body = number;
  if (prefix && body.startsWith(prefix)) body = body.slice(prefix.length);
  if (suffix && body.endsWith(suffix)) body = body.slice(0, body.length - suffix.length);
  const tokenClasses = {
    SEQ: "\\d+",
    YYYY: "\\d{4}",
    YY: "\\d{2}",
    MM: "\\d{2}",
    DD: "\\d{2}",
    WW: "\\d{2}",
  };
  let regex = "";
  let i = 0;
  const errors = [];
  while (i < pattern.length) {
    if (pattern[i] === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) break;
      const token = pattern.slice(i + 1, end).trim();
      regex += tokenClasses[token] || "[A-Za-z0-9._-]+";
      i = end + 1;
      continue;
    }
    regex += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  try {
    const re = new RegExp(`^${regex}$`);
    if (!re.test(body)) errors.push("Number does not match the scheme pattern");
  } catch {
    errors.push("Scheme pattern could not be compiled");
  }
  return { valid: errors.length === 0, errors };
}

export function metricsSnapshot(db, { tenantId = null, from = null, to = null } = {}) {
  const tenantClause = tenantId === null || tenantId === undefined ? "" : " AND (tenant_id IS NULL OR tenant_id = ?)";
  const params = tenantId === null || tenantId === undefined ? [] : [Number(tenantId)];
  const byStatus = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM numbering_allocations WHERE 1 = 1 ${tenantClause} GROUP BY status`,
    params
  );
  const statusMap = Object.fromEntries(byStatus.map((row) => [row.status, row.count]));
  const schemes = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
            SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) AS retired
     FROM numbering_schemes WHERE 1 = 1 ${tenantClause.replace("tenant_id", "tenant_id")}`,
    params
  );
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const generatedToday = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM numbering_allocations WHERE requested_at LIKE ?${tenantClause}`,
    [`${today}%`, ...params]
  ).c;
  const generatedMonth = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM numbering_allocations WHERE requested_at LIKE ?${tenantClause}`,
    [`${month}%`, ...params]
  ).c;
  const sequences = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
            COALESCE(SUM(allocated_count), 0) AS allocated,
            COALESCE(SUM(CASE WHEN max_value < 999999999999 THEN max_value ELSE 0 END), 0) AS bounded_capacity
     FROM numbering_sequences s WHERE 1 = 1 ${tenantClause.replace("tenant_id", "s.tenant_id")}`,
    params
  );
  const reservationTimeout = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM numbering_allocations
     WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ?${tenantClause}`,
    [new Date().toISOString().replace("T", " ").slice(0, 19), ...params]
  ).c;
  const errors = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'numbering.allocation.%' AND status = 'failure'${tenantClause.replace("tenant_id", "tenant_id")}`,
    params
  ).c;
  const utilization = sequences.bounded_capacity
    ? Math.min(100, Math.round((sequences.allocated / sequences.bounded_capacity) * 1000) / 10)
    : null;
  const rangeClause = from ? " AND requested_at >= ?" : "";
  const rangeClauseTo = to ? " AND requested_at <= ?" : "";
  const rangeParams = [...params];
  if (from) rangeParams.push(String(from).replace("T", " ").slice(0, 19));
  if (to) rangeParams.push(String(to).replace("T", " ").slice(0, 19));
  const allocatedInRange = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM numbering_allocations WHERE status IN ('allocated','reserved','consumed') ${tenantClause}${rangeClause}${rangeClauseTo}`,
    rangeParams
  ).c;
  return {
    schemes: {
      total: schemes.total ?? 0,
      active: schemes.active ?? 0,
      inactive: schemes.inactive ?? 0,
      draft: schemes.draft ?? 0,
      retired: schemes.retired ?? 0,
    },
    allocations: {
      allocated: statusMap.allocated ?? 0,
      reserved: statusMap.reserved ?? 0,
      consumed: statusMap.consumed ?? 0,
      released: statusMap.released ?? 0,
      expired: statusMap.expired ?? 0,
      cancelled: statusMap.cancelled ?? 0,
      in_range: allocatedInRange,
    },
    generated_today: generatedToday,
    generated_month: generatedMonth,
    expired_reservations: reservationTimeout,
    numbering_errors: errors,
    sequences: {
      total: sequences.total ?? 0,
      exhausted: sequences.exhausted ?? 0,
      paused: sequences.paused ?? 0,
      allocated: sequences.allocated ?? 0,
      bounded_capacity: sequences.bounded_capacity ?? 0,
      utilization,
    },
  };
}
