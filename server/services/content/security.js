import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { resolveScanProvider, registerScanProvider, scanProviderNames } from "../file-storage/scanning.js";
import { MAX_SCAN_BYTES } from "./constants.js";
import { Errors } from "./errors.js";
import { publicScan } from "./repository.js";
import { recordContentEvent, auditContent } from "./events.js";

// Provider-independent security scanning hook (spec §19). The core service never
// mandates a scanning implementation: deployments register a real engine through
// `registerContentScanner` (ClamAV, cloud malware service, ...) or rely on the
// built-in heuristic scanner. Infected content is quarantined, blocked from
// download, audited and surfaced as a security event.

const scanners = new Map();

export function registerContentScanner(name, scanner) {
  if (!name || typeof scanner?.scan !== "function") {
    throw new Error("A content scanner requires a name and a scan() method");
  }
  scanners.set(name, scanner);
  return scanner;
}

export function resolveContentScanner(name) {
  const requested = name || process.env.CONTENT_SCAN_PROVIDER || process.env.FILE_SCAN_PROVIDER || "heuristic";
  if (scanners.has(requested)) return scanners.get(requested);
  return resolveScanProvider(requested);
}

export function contentScannerNames() {
  return [...new Set([...scanners.keys(), ...scanProviderNames()])];
}

export async function runContentScan(store, {
  key,
  size = 0,
  mimeType = "",
  extension = "",
  scanner = null,
} = {}) {
  const engine = resolveContentScanner(scanner);
  let buffer = null;
  if (key) {
    try {
      buffer = await store.read(key, { maxBytes: MAX_SCAN_BYTES });
    } catch {
      buffer = null;
    }
  }
  const outcome = await engine.scan({
    buffer,
    size: Number(size) || (buffer ? buffer.length : 0),
    mimeType,
    extension,
  });
  return {
    status: outcome?.status || "unknown",
    engine: outcome?.engine || engine.name || "unknown",
    engineVersion: outcome?.engineVersion || "",
    signature: outcome?.signature || "",
    detail: outcome?.detail || "",
    scannedBytes: Number(size) || (buffer ? buffer.length : 0),
  };
}

function recordScan(db, { content, versionId, outcome, scanType = "upload" }) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO content_security_scans
      (tenant_id, content_id, version_id, scan_type, scanner, engine_version, status, result, signature,
       details_json, scanned_bytes, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      content?.tenant_id ?? null,
      content?.id ?? null,
      versionId ?? null,
      scanType,
      outcome.engine,
      outcome.engineVersion || "",
      outcome.status,
      outcome.detail || "",
      outcome.signature || "",
      JSON.stringify({ detail: outcome.detail || "", mimeType: content?.mime_type || "" }),
      outcome.scannedBytes || 0,
      ts,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM content_security_scans WHERE id = ?", [Number(result.lastInsertRowid)]);
}

// Applies the scan outcome to an existing content row + version, quarantining on
// infection. Must run inside a transaction.
export function applyScanOutcome(db, { content, versionId = null, outcome, actor = null }) {
  const scanRow = recordScan(db, { content, versionId, outcome });
  const ts = nowIso();
  const quarantined = outcome.status === "infected";
  const failed = outcome.status === "failed";
  const securityStatus = quarantined ? "infected" : failed ? "failed" : outcome.status === "clean" ? "clean" : outcome.status;
  const nextStatus = quarantined ? "quarantined" : failed ? "failed" : content.status;

  run(
    db,
    "UPDATE content SET security_status = ?, status = ?, quarantine_reason = ?, processing_status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
    [
      securityStatus,
      nextStatus,
      quarantined ? (outcome.signature || outcome.detail || "Malware detected") : "",
      quarantined || failed ? "failed" : "processing",
      ts,
      content.id,
    ]
  );
  if (versionId) {
    run(
      db,
      "UPDATE content_versions SET security_status = ?, status = ?, updated_at = ? WHERE id = ?",
      [securityStatus, quarantined ? "quarantined" : failed ? "failed" : "processing", ts, versionId]
    );
  }
  const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [content.id]);

  recordContentEvent(db, {
    eventType: quarantined ? "ContentQuarantined" : "ContentScanCompleted",
    content: updated,
    versionId,
    actor,
    payload: {
      result: securityStatus,
      scanner: outcome.engine,
      signature: outcome.signature || "",
      detail: outcome.detail || "",
    },
  });
  auditContent(db, {
    actor,
    tenantId: updated.tenant_id,
    action: quarantined ? "content.quarantined" : "content.scanned",
    content: updated,
    details: { result: securityStatus, scanner: outcome.engine, signature: outcome.signature || "" },
  });
  return { scan: publicScan(scanRow), content: updated, security_status: securityStatus, quarantined, failed };
}

// Exposed for deployments that want to subscribe to scan outcomes.
export function quarantineContent(db, contentRow, { reason = "Security policy", actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const ts = nowIso();
    run(
      db,
      "UPDATE content SET status = 'quarantined', security_status = 'infected', quarantine_reason = ?, processing_status = 'failed', updated_at = ?, revision = revision + 1 WHERE id = ?",
      [reason, ts, contentRow.id]
    );
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [contentRow.id]);
    auditContent(db, { actor, tenantId: tenantId ?? updated.tenant_id, action: "content.quarantined", content: updated, reason, ip });
    recordContentEvent(db, { eventType: "ContentQuarantined", content: updated, actor, payload: { reason } });
    return updated;
  });
}

export function releaseQuarantine(db, contentRow, { actor = null, reason = "", tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const ts = nowIso();
    run(
      db,
      "UPDATE content SET status = 'available', security_status = 'clean', quarantine_reason = '', processing_status = 'ready', updated_at = ?, revision = revision + 1 WHERE id = ?",
      [ts, contentRow.id]
    );
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [contentRow.id]);
    auditContent(db, { actor, tenantId: tenantId ?? updated.tenant_id, action: "content.quarantine.released", content: updated, reason, ip });
    recordContentEvent(db, { eventType: "ContentScanCompleted", content: updated, actor, payload: { released: true, reason } });
    return updated;
  });
}

export function listScans(db, contentId, { tenantId = null, limit = 50 } = {}) {
  let clause = "WHERE content_id = ?";
  const params = [Number(contentId)];
  if (tenantId !== null && tenantId !== undefined) {
    clause += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const rows = queryAll(db, `SELECT * FROM content_security_scans ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`, [
    ...params,
    Math.min(200, Math.max(1, Number(limit) || 50)),
  ]);
  return { items: rows.map(publicScan), total: rows.length };
}

export function latestScan(db, contentId) {
  const row = queryOne(db, "SELECT * FROM content_security_scans WHERE content_id = ? ORDER BY created_at DESC, id DESC", [
    Number(contentId),
  ]);
  return publicScan(row);
}
