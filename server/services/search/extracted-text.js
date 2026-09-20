// Extracted text integration contract (spec §35/§36).
//
// Search never reads binary content. The File & Content Management service (or
// a registered text extractor) pushes plain extracted text keyed by the owning
// object through this module, and indexing merges it into the document's
// searchable text. Binary payloads are never placed in the index.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";

const MAX_TEXT_LENGTH = 1_000_000;
const ALLOWED_SOURCES = ["content", "rendition", "metadata", "external", "manual"];

const extractorRegistry = new Map();

// Pluggable extractors turn an object reference into plain text. The default
// implementation stores nothing here: extraction is triggered explicitly by the
// owning module through `ingestExtractedText`.
export function registerTextExtractor(name, extractor, { replace = false } = {}) {
  const key = String(name || "").trim();
  if (!key) throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "A text extractor name is required");
  if (typeof extractor !== "function") {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "A text extractor must be a function");
  }
  if (extractorRegistry.has(key) && !replace) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, `Text extractor "${key}" is already registered`);
  }
  extractorRegistry.set(key, extractor);
  return key;
}

export function listTextExtractors() {
  return [...extractorRegistry.keys()];
}

export function getTextExtractor(name) {
  return extractorRegistry.get(String(name)) || null;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .slice(0, MAX_TEXT_LENGTH);
}

function normalizedSource(source) {
  const value = String(source || "content").toLowerCase();
  return ALLOWED_SOURCES.includes(value) ? value : "content";
}

export function putExtractedText(db, input = {}, actor, tenantId, ip) {
  const tenant = Number(tenantId ?? input.tenantId ?? input.tenant_id ?? 0);
  const objectType = String(input.objectType ?? input.object_type ?? "").trim();
  const objectId = String(input.objectId ?? input.object_id ?? "").trim();
  if (!tenant) throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "A tenant is required");
  if (!objectType || !objectId) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "objectType and objectId are required");
  }
  const contentId = String(input.contentId ?? input.content_id ?? "");
  const text = normalizeText(input.text);
  const source = normalizedSource(input.source);
  const language = String(input.language ?? "");
  const checksum = String(input.checksum ?? "");
  const ts = nowIso();
  const existing = queryOne(
    db,
    "SELECT * FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND content_id = ?",
    [tenant, objectType, objectId, contentId]
  );
  if (existing) {
    run(
      db,
      `UPDATE search_extracted_text SET source = ?, language = ?, text = ?, text_length = ?, checksum = ?, updated_at = ?
       WHERE id = ?`,
      [source, language, text, text.length, checksum, ts, existing.id]
    );
  } else {
    run(
      db,
      `INSERT INTO search_extracted_text
         (tenant_id, object_type, object_id, content_id, source, language, text, text_length, checksum, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant, objectType, objectId, contentId, source, language, text, text.length, checksum, ts, ts]
    );
  }
  writeAudit(db, {
    actor,
    action: existing ? "search.extracted_text.update" : "search.extracted_text.create",
    resourceType: "search_extracted_text",
    resourceId: `${objectType}:${objectId}`,
    details: { object_type: objectType, object_id: objectId, content_id: contentId, text_length: text.length },
    ip,
  });
  return publicExtractedText(
    queryOne(
      db,
      "SELECT * FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND content_id = ?",
      [tenant, objectType, objectId, contentId]
    )
  );
}

export function publicExtractedText(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    contentId: row.content_id,
    source: row.source,
    language: row.language,
    textLength: row.text_length,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listExtractedText(db, { tenantId, objectType = null, objectId = null, limit = 100 } = {}) {
  const params = [Number(tenantId)];
  let where = "tenant_id = ?";
  if (objectType) {
    where += " AND object_type = ?";
    params.push(String(objectType));
  }
  if (objectId) {
    where += " AND object_id = ?";
    params.push(String(objectId));
  }
  params.push(Number(limit));
  return queryAll(
    db,
    `SELECT * FROM search_extracted_text WHERE ${where} ORDER BY id DESC LIMIT ?`,
    params
  ).map(publicExtractedText);
}

// Concatenated, de-duplicated indexable text for one object. Used by the
// indexing pipeline; returns "" when nothing has been extracted.
export function extractedTextFor(db, tenantId, objectType, objectId) {
  const rows = queryAll(
    db,
    "SELECT text FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ? ORDER BY id",
    [Number(tenantId), String(objectType), String(objectId)]
  );
  const seen = new Set();
  const parts = [];
  for (const row of rows) {
    const text = String(row.text || "").trim();
    if (!text) continue;
    const key = text.slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  return parts.join("\n");
}

export function deleteExtractedText(db, { tenantId, objectType, objectId, contentId = null }, actor, ip) {
  const tenant = Number(tenantId);
  const type = String(objectType || "");
  const id = String(objectId || "");
  if (!tenant || !type || !id) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "tenantId, objectType and objectId are required");
  }
  if (contentId !== null && contentId !== undefined) {
    run(
      db,
      "DELETE FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND content_id = ?",
      [tenant, type, id, String(contentId)]
    );
  } else {
    run(db, "DELETE FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
      tenant,
      type,
      id,
    ]);
  }
  writeAudit(db, {
    actor,
    action: "search.extracted_text.delete",
    resourceType: "search_extracted_text",
    resourceId: `${type}:${id}`,
    details: { object_type: type, object_id: id, content_id: contentId },
    ip,
  });
  return { deleted: true, object_type: type, object_id: id };
}

export function purgeExtractedText(db, tenantId, objectType, objectId) {
  run(db, "DELETE FROM search_extracted_text WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    String(objectType),
    String(objectId),
  ]);
}

export const EXTRACTED_TEXT_MAX_LENGTH = MAX_TEXT_LENGTH;
export const EXTRACTED_TEXT_SOURCES = ALLOWED_SOURCES;
