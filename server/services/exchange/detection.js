// Format detection (§2 flow: External Standard -> Format Detection -> Adapter).
//
// Detection is driven entirely by registered formats and adapters: first a
// format hint, then MIME/extension, then adapter content sniffing. It never
// hard-codes a format list.
import { queryOne } from "../../db.js";
import { listAdapters as listAdapterInstances } from "./adapters/index.js";
import { getFormatRow, listFormats } from "./formats.js";
import { publicFormat, publicAdapter } from "./repository.js";
import { detectionFailed } from "./errors.js";

function extensionOf(fileName = "") {
  const match = /(\.[A-Za-z0-9]+)$/.exec(String(fileName));
  return match ? match[1].toLowerCase() : "";
}

function adapterRow(db, tenantId, code) {
  if (!code) return null;
  const row = queryOne(db, "SELECT * FROM exchange_adapters WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  return row ? publicAdapter(row) : null;
}

export function detectFormat(db, tenantId, { payload = null, fileName = "", mimeType = "", formatHint = "" } = {}) {
  const candidates = [];
  const extension = extensionOf(fileName);
  const registered = listFormats(db, tenantId, { page_size: 200 }).items;

  if (formatHint) {
    const hintRow = getFormatRow(db, tenantId, formatHint);
    if (hintRow) {
      const candidate = { format: publicFormat(hintRow), adapter: hintRow.adapter_code, confidence: 1, reason: "explicit format hint" };
      candidates.push(candidate);
      return {
        detected: true,
        format: candidate.format,
        adapter: adapterRow(db, tenantId, hintRow.adapter_code),
        confidence: 1,
        reason: candidate.reason,
        candidates,
      };
    }
  }

  for (const format of registered) {
    let confidence = 0;
    let reason = "";
    if (mimeType && (format.mime_types || []).some((entry) => String(entry).toLowerCase() === String(mimeType).toLowerCase())) {
      confidence = 0.95;
      reason = "mime type";
    } else if (extension && (format.extensions || []).some((entry) => String(entry).toLowerCase() === extension)) {
      confidence = 0.85;
      reason = "file extension";
    }
    if (confidence > 0) candidates.push({ format, adapter: format.adapter_code, confidence, reason });
  }

  for (const adapter of listAdapterInstances()) {
    if (!adapter.detect) continue;
    let result;
    try {
      result = adapter.detect(payload, { fileName, mimeType }) || {};
    } catch {
      result = { matched: false };
    }
    if (!result.matched) continue;
    const matchedFormat = (result.format_code && registered.find((entry) => entry.code === result.format_code)) || registered.find((entry) => entry.adapter_code === adapter.code) || null;
    const match = candidates.find((entry) => entry.adapter === adapter.code);
    if (match) {
      if (!match.format && matchedFormat) match.format = matchedFormat;
      match.confidence = Math.max(match.confidence, result.confidence || 0.6);
      match.reason = match.reason || result.reason || "adapter detection";
    } else {
      candidates.push({ format: matchedFormat, adapter: adapter.code, confidence: result.confidence || 0.6, reason: result.reason || "adapter detection" });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  if (!best) {
    return { detected: false, format: null, adapter: null, confidence: 0, reason: "no registered format matched", candidates: [] };
  }
  if (!best.format) {
    return {
      detected: true,
      format: null,
      adapter: adapterRow(db, tenantId, best.adapter),
      confidence: best.confidence,
      reason: best.reason,
      candidates,
      warning: `A ${best.adapter} adapter matched but no format is registered for it`,
    };
  }
  return {
    detected: true,
    format: best.format,
    adapter: adapterRow(db, tenantId, best.adapter),
    confidence: best.confidence,
    reason: best.reason,
    candidates,
  };
}

export function requireDetection(db, tenantId, options) {
  const result = detectFormat(db, tenantId, options);
  if (!result.detected) throw detectionFailed("Unable to detect the exchange format", { reason: result.reason });
  return result;
}
