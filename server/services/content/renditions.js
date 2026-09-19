import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { buildRenditionStorageKey, resolveContentStorage, signedDownloadPath } from "./storage.js";
import { signDownload } from "../file-storage/signing.js";
import { Errors } from "./errors.js";
import { publicRendition, currentVersionRow, findRenditionRow } from "./repository.js";
import { renditionRef } from "./refs.js";
import { recordContentEvent } from "./events.js";

// Rendition framework (spec §15-§18). Rendition generation is provider-driven:
// the core entity knows nothing about PDF/JT/CAD tooling, it only orchestrates
// registered processors. Expensive processors declare `deferred: true` so the
// caller enqueues a background job instead of blocking the request.

const processors = new Map();

export function registerRenditionProcessor(type, processor) {
  if (!type || typeof processor?.generate !== "function") {
    throw new Error("A rendition processor requires a type and a generate() method");
  }
  processors.set(String(type).toUpperCase(), processor);
  return processor;
}

export function resolveRenditionProcessor(type) {
  return processors.get(String(type || "").toUpperCase()) || null;
}

export function renditionProcessorNames() {
  return [...processors.keys()];
}

// ── Default processors ───────────────────────────────────────────────────────

const TEXT_MIMES = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "application/xml", "text/xml"]);

export const MetadataPreviewProcessor = {
  name: "metadata-preview",
  version: "1.0.0",
  supports({ mimeType }) {
    return true;
  },
  async generate({ buffer, content }) {
    const excerpt = buffer ? buffer.toString("utf8", 0, Math.min(buffer.length, 4096)) : "";
    const preview = [
      `Content: ${content.content_key} (${content.file_name})`,
      `Type: ${content.mime_type}`,
      `Size: ${content.file_size} bytes`,
      `Checksum: ${content.checksum}`,
      "",
      excerpt,
    ].join("\n");
    return {
      buffer: Buffer.from(preview, "utf8"),
      mimeType: "text/plain",
      fileName: `${content.file_name}.preview.txt`,
      metadata: { kind: "metadata-preview", bytes: Buffer.byteLength(preview) },
    };
  },
};

export const SvgThumbnailProcessor = {
  name: "svg-thumbnail",
  version: "1.0.0",
  supports() {
    return true;
  },
  async generate({ content }) {
    const initial = (content.content_key || "C").slice(-2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#f1f5f9" stroke="#cbd5e1"/><text x="80" y="60" font-family="sans-serif" font-size="14" fill="#475569" text-anchor="middle">${initial}</text><text x="80" y="82" font-family="sans-serif" font-size="9" fill="#94a3b8" text-anchor="middle">${(content.file_extension || "file").slice(0, 12)}</text></svg>`;
    return {
      buffer: Buffer.from(svg, "utf8"),
      mimeType: "image/svg+xml",
      fileName: `${content.file_name}.thumb.svg`,
      metadata: { kind: "svg-thumbnail" },
    };
  },
};

// Recognises native content that is already the target format (a common DMS
// pattern: the controlled PDF is registered as the native) and exposes it as a
// first-class rendition without conversion tooling.
function passthroughProcessor(type, mimeType) {
  return {
    name: `${type.toLowerCase()}-passthrough`,
    version: "1.0.0",
    supports({ mimeType: sourceMime }) {
      return String(sourceMime || "").toLowerCase() === mimeType;
    },
    async generate({ buffer, content }) {
      if (!buffer) return null;
      return {
        buffer,
        mimeType,
        fileName: content.file_name,
        metadata: { kind: "passthrough", source: content.mime_type },
      };
    },
  };
}

export const TextExtractionProcessor = {
  name: "text-extraction",
  version: "1.0.0",
  supports({ mimeType }) {
    return TEXT_MIMES.has(String(mimeType || "").toLowerCase());
  },
  async generate({ buffer, content }) {
    if (!buffer) return null;
    const text = buffer.toString("utf8", 0, Math.min(buffer.length, 256 * 1024));
    return {
      buffer: Buffer.from(text, "utf8"),
      mimeType: "text/plain",
      fileName: `${content.file_name}.txt`,
      metadata: { kind: "text-extraction", bytes: Buffer.byteLength(text) },
    };
  },
};

// Recognises a file that is already a PDF as the PDF rendition.
const PdfPassthroughProcessor = passthroughProcessor("PDF", "application/pdf");
const JtPassthroughProcessor = passthroughProcessor("JT", "application/octet-stream");

const DEFAULT_RENDITION_TYPES = ["PREVIEW", "THUMBNAIL", "PDF", "JT", "TEXT"];

registerRenditionProcessor("PREVIEW", MetadataPreviewProcessor);
registerRenditionProcessor("THUMBNAIL", SvgThumbnailProcessor);
registerRenditionProcessor("PDF", PdfPassthroughProcessor);
registerRenditionProcessor("JT", JtPassthroughProcessor);
registerRenditionProcessor("TEXT", TextExtractionProcessor);

export function defaultRenditionTypes() {
  return [...DEFAULT_RENDITION_TYPES];
}

export function requestRendition(db, contentRow, { renditionType, sourceVersionId = null, actor = null, tenantId = null, metadata = {} } = {}) {
  const type = String(renditionType || "").toUpperCase();
  if (!type) throw Errors.renditionFailed("rendition_type is required");
  const existing = queryOne(
    db,
    "SELECT * FROM content_renditions WHERE content_id = ? AND source_version_id IS ? AND rendition_type = ?",
    [Number(contentRow.id), sourceVersionId ?? null, type]
  );
  if (existing) return publicRendition(existing);
  const result = run(
    db,
    `INSERT INTO content_renditions
      (rendition_ref, tenant_id, content_id, source_content_id, source_version_id, rendition_type, status, metadata_json, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
    [
      renditionRef(),
      tenantId ?? contentRow.tenant_id,
      Number(contentRow.id),
      Number(contentRow.id),
      sourceVersionId ?? null,
      type,
      JSON.stringify(metadata || {}),
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordContentEvent(db, { eventType: "RenditionRequested", content: contentRow, renditionId: row.id, actor, tenantId, payload: { rendition_type: type } });
  return publicRendition(row);
}

// Runs a rendition processor and stores its output. Returns the rendition DTO.
export async function generateRendition(db, contentRow, renditionRow, { store = null, actor = null, buffer = null } = {}) {
  const ready = ensureStarted(db, contentRow, renditionRow);
  const processor = resolveRenditionProcessor(ready.rendition_type);
  if (!processor) {
    return skipRendition(db, contentRow, ready, "No processor registered for this rendition type", { actor });
  }
  const nativeBuffer = buffer || (await readNative(store, contentRow));
  if (!processor.supports({ mimeType: contentRow.mime_type, extension: contentRow.file_extension, content: contentRow })) {
    return skipRendition(db, contentRow, ready, "Rendition type is not supported for this content", { actor });
  }
  let output;
  try {
    output = await processor.generate({ buffer: nativeBuffer, content: contentRow, store });
  } catch (err) {
    return failRendition(db, contentRow, ready, err.message, { actor });
  }
  if (!output?.buffer) {
    return failRendition(db, contentRow, ready, "Processor produced no output", { actor });
  }
  const storage = store || resolveContentStorage();
  const key = buildRenditionStorageKey(contentRow.storage_key || `content/${contentRow.id}`, ready.rendition_type);
  const stored = await storage.upload({ key, buffer: output.buffer, contentType: output.mimeType });
  return transaction(db, () => {
    run(
      db,
      `UPDATE content_renditions SET status = 'available', file_name = ?, mime_type = ?, file_size = ?, checksum = ?,
         storage_provider = ?, storage_key = ?, storage_bucket = ?, generator = ?, generator_version = ?,
         error_message = '', metadata_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [
        output.fileName || contentRow.file_name,
        output.mimeType || "application/octet-stream",
        stored.size,
        stored.checksum,
        stored.provider,
        stored.key,
        stored.bucket,
        processor.name,
        processor.version || "1.0.0",
        JSON.stringify({ ...(ready.metadata ? JSON.parse(ready.metadata_json || "{}") : {}), ...(output.metadata || {}) }),
        nowIso(),
        nowIso(),
        ready.id,
      ]
    );
    const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [ready.id]);
    recordContentEvent(db, {
      eventType: "RenditionCreated",
      content: contentRow,
      renditionId: row.id,
      actor,
      payload: { rendition_type: ready.rendition_type, generator: processor.name, size: stored.size },
    });
    return publicRendition(row);
  });
}

function ensureStarted(db, contentRow, renditionRow) {
  if (renditionRow.status === "requested") {
    run(db, "UPDATE content_renditions SET status = 'processing', updated_at = ? WHERE id = ?", [nowIso(), renditionRow.id]);
    return queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [renditionRow.id]);
  }
  return renditionRow;
}

// Unsupported conversions are not failures: the pipeline records them as
// skipped so a text file does not look "broken" because it has no PDF rendition.
function skipRendition(db, contentRow, renditionRow, message, { actor = null } = {}) {
  run(
    db,
    "UPDATE content_renditions SET status = 'skipped', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    [message || "Rendition skipped", nowIso(), nowIso(), renditionRow.id]
  );
  const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [renditionRow.id]);
  recordContentEvent(db, {
    eventType: "RenditionFailed",
    content: contentRow,
    renditionId: row.id,
    actor,
    payload: { rendition_type: row.rendition_type, skipped: true, reason: message },
  });
  return publicRendition(row);
}

function failRendition(db, contentRow, renditionRow, message, { actor = null } = {}) {
  run(
    db,
    "UPDATE content_renditions SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
    [message || "Rendition failed", nowIso(), renditionRow.id]
  );
  const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [renditionRow.id]);
  recordContentEvent(db, {
    eventType: "RenditionFailed",
    content: contentRow,
    renditionId: row.id,
    actor,
    payload: { rendition_type: row.rendition_type, error: message },
  });
  return publicRendition(row);
}

async function readNative(store, contentRow) {
  if (!contentRow.storage_key) return null;
  const storage = store || resolveContentStorage();
  try {
    return await storage.read(contentRow.storage_key);
  } catch {
    return null;
  }
}

export function listRenditions(db, contentRow, { status = null, type = null } = {}) {
  const where = ["content_id = ?"];
  const params = [Number(contentRow.id)];
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  if (type) {
    where.push("rendition_type = ?");
    params.push(String(type).toUpperCase());
  }
  const rows = queryAll(
    db,
    `SELECT * FROM content_renditions WHERE ${where.join(" AND ")} ORDER BY rendition_type, id`,
    params
  );
  return { items: rows.map(publicRendition), total: rows.length };
}

export function getRendition(db, contentRow, reference) {
  return publicRendition(findRenditionRow(db, contentRow.id, reference));
}

export function renditionAccessUrl(db, contentRow, rendition, { expiresIn = null, disposition = "attachment" } = {}) {
  if (rendition.status !== "available") throw Errors.renditionFailed("Rendition is not available");
  const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [Number(rendition.id)]);
  if (!row?.storage_key) throw Errors.renditionFailed("Rendition has no stored content");
  const token = signDownload({
    key: row.storage_key,
    filename: row.file_name,
    mimeType: row.mime_type,
    disposition,
    tenantId: contentRow.tenant_id,
    expiresIn,
  });
  return { url: signedDownloadPath(token), token, expires_in: Number(expiresIn) || 900 };
}

export function markRenditionsOutdated(db, contentRow) {
  return run(
    db,
    "UPDATE content_renditions SET status = 'outdated', updated_at = ? WHERE content_id = ? AND status = 'available'",
    [nowIso(), Number(contentRow.id)]
  );
}

export function currentSourceVersion(db, contentRow) {
  return currentVersionRow(db, contentRow.id);
}
