// EBOM -> MBOM transformation trace (Boundary 3).
//
// This module never transforms BOMs and never stores a second mapping model. It
// reads the provenance the existing BOM transformation engine already persists
// onto target lines (`bom_lines.attributes_json`: source_line_ref /
// source_object_id / source_object_type), plus any explicit
// `ebom.transformed-to.mbom` object relationships, and projects:
//   - EBOM -> MBOM mappings (source-driven, one EBOM item -> many MBOM items)
//   - MBOM -> EBOM sources (target-driven)
//   - unmapped source-item and unlinked target-item detection
//   - invalid / non-effective link detection
//
// A missing transformation link is reported distinctly from a link that exists
// but is invalid or no longer effective. All reads are bounded, paginated and
// resolved through the existing BOM/Object facades (no N+1, no full loads).
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions } from "../bom/index.js";
import { parseObject, paginate } from "./validation.js";
import { invalidMapping, mappingNotFound } from "./errors.js";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";

const MBOM_BOM_TYPE = "MBOM";
const EBOM_BOM_TYPE = "EBOM";
const SOURCE_RELATIONSHIP_CODE = "ebom.transformed-to.mbom";
const MAX_SOURCE_KEYS = 800;
const MAX_ROWS = 20000;

const VALID = "VALID";
const MISSING_LINK = "MISSING_LINK";
const INVALID_LINK = "INVALID_LINK";
const NOT_EFFECTIVE = "NOT_EFFECTIVE";

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function chunk(values, size = MAX_SOURCE_KEYS) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = value === undefined || value === null ? "" : String(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function parseAttributes(json) {
  return parseObject(json, {});
}

function lineIsActive(line) {
  return String(line?.line_status || "ACTIVE").toUpperCase() === "ACTIVE";
}

function mappingStatus({ sourceFound, sourceActive = true, targetActive = true }) {
  if (!sourceFound) return INVALID_LINK;
  if (!sourceActive || !targetActive) return NOT_EFFECTIVE;
  return VALID;
}

function revisionDescriptor(revision, header) {
  return {
    revision_id: revision.id,
    revision_number: revision.revision_number,
    revision_ref: revision.revision_ref || "",
    status: revision.status || "",
    lifecycle_state: revision.lifecycle_state || revision.status || "",
    bom_id: header?.id ?? revision.bom_id ?? null,
    bom_number: header?.bom_number ?? "",
    bom_type: header?.bom_type ?? "",
    name: header?.name ?? "",
    configuration_context: revision.configuration_context || "",
    valid_from: revision.valid_from ?? null,
    valid_to: revision.valid_to ?? null,
  };
}

function sourceLineDescriptor(line) {
  if (!line) return null;
  return {
    found: true,
    line_id: line.id,
    line_ref: line.line_ref || "",
    object_id: line.child_object_id != null ? String(line.child_object_id) : null,
    object_type: line.child_object_type || "",
    revision: line.child_revision || "",
    parent_object_id: line.parent_object_id != null ? String(line.parent_object_id) : null,
    quantity: line.quantity,
    uom: line.uom,
    usage: line.usage,
    line_status: line.line_status,
    active: lineIsActive(line),
  };
}

function targetLineDescriptor(line) {
  if (!line) return null;
  return {
    found: true,
    line_id: line.id,
    line_ref: line.line_ref || "",
    object_id: line.child_object_id != null ? String(line.child_object_id) : null,
    object_type: line.child_object_type || "",
    revision: line.child_revision || "",
    parent_object_id: line.parent_object_id != null ? String(line.parent_object_id) : null,
    quantity: line.quantity,
    uom: line.uom,
    usage: line.usage,
    line_status: line.line_status,
    active: lineIsActive(line),
    bom_revision_id: line.bom_revision_id ?? null,
    configuration_context: line.configuration_context || "",
  };
}

function lineageKey(objectId) {
  return objectId === undefined || objectId === null ? "" : String(objectId);
}

// ── Data access ─────────────────────────────────────────────────────────────

function revisionLines(db, revisionId, { async: isAsync = false } = {}) {
  const sql = "SELECT * FROM bom_lines WHERE bom_revision_id = ? ORDER BY COALESCE(NULLIF(sequence,0), 2147483647), id LIMIT ?";
  const params = [Number(revisionId), MAX_ROWS];
  return isAsync ? queryAllAsync(db, sql, params) : queryAll(db, sql, params);
}

// Target MBOM lines whose persisted provenance references any of the supplied
// source line refs or source object ids. Chunked so huge EBOMs never build an
// unbounded IN list.
function fetchTargetLinesByProvenance(db, tenantId, sourceRefs, sourceObjects, { async: isAsync = false } = {}) {
  const clauses = [];
  const extra = [];
  for (const part of chunk(sourceRefs)) {
    clauses.push(`(NULLIF(l.attributes_json,'')::jsonb ->> 'source_line_ref') IN (${placeholders(part)})`);
    extra.push(...part);
  }
  for (const part of chunk(sourceObjects)) {
    clauses.push(`(NULLIF(l.attributes_json,'')::jsonb ->> 'source_object_id') IN (${placeholders(part)})`);
    extra.push(...part);
  }
  if (!clauses.length) return isAsync ? Promise.resolve([]) : [];
  const sql = `SELECT l.*,
                      h.id AS bom_id, h.bom_number AS bom_number, h.bom_type AS bom_type, h.name AS bom_name,
                      r.revision_number AS revision_number, r.revision_ref AS revision_ref, r.id AS bom_revision_id,
                      r.status AS revision_status, r.lifecycle_state AS revision_lifecycle_state,
                      r.configuration_context AS revision_configuration_context, r.valid_from AS revision_valid_from, r.valid_to AS revision_valid_to
                 FROM bom_lines l
                 JOIN bom_revisions r ON r.id = l.bom_revision_id
                 JOIN bom_headers h ON h.id = r.bom_id
                WHERE l.tenant_id = ? AND h.bom_type = ? AND (${clauses.join(" OR ")})
                ORDER BY l.id LIMIT ${MAX_ROWS}`;
  const params = [Number(tenantId), MBOM_BOM_TYPE, ...extra];
  return isAsync ? queryAllAsync(db, sql, params) : queryAll(db, sql, params);
}

// Resolves arbitrary BOM lines (any revision) by line ref or child object id.
function fetchLinesByKeys(db, tenantId, lineRefs, objectIds, { async: isAsync = false } = {}) {
  const clauses = [];
  const extra = [];
  for (const part of chunk(lineRefs)) {
    clauses.push(`l.line_ref IN (${placeholders(part)})`);
    extra.push(...part);
  }
  for (const part of chunk(objectIds)) {
    clauses.push(`l.child_object_id IN (${placeholders(part)})`);
    extra.push(...part);
  }
  if (!clauses.length) return isAsync ? Promise.resolve([]) : [];
  const sql = `SELECT l.*,
                      h.id AS bom_id, h.bom_number AS bom_number, h.bom_type AS bom_type, h.name AS bom_name,
                      r.revision_number AS revision_number, r.revision_ref AS revision_ref, r.id AS bom_revision_id,
                      r.status AS revision_status, r.lifecycle_state AS revision_lifecycle_state, r.object_id AS revision_object_id
                 FROM bom_lines l
                 JOIN bom_revisions r ON r.id = l.bom_revision_id
                 JOIN bom_headers h ON h.id = r.bom_id
                WHERE l.tenant_id = ? AND (${clauses.join(" OR ")})
                ORDER BY l.id LIMIT ${MAX_ROWS}`;
  const params = [Number(tenantId), ...extra];
  return isAsync ? queryAllAsync(db, sql, params) : queryAll(db, sql, params);
}

// Explicit `ebom.transformed-to.mbom` object relationships (used when a caller
// linked objects directly instead of relying on transformation provenance).
// object_relationships keys are bigint object ids, so non-numeric child keys
// (free-text BOM line object ids) are skipped rather than cast.
function fetchExplicitMappings(db, tenantId, sourceObjectIds, { async: isAsync = false } = {}) {
  const numeric = sourceObjectIds.filter((id) => /^\d+$/.test(String(id)));
  if (!numeric.length) return isAsync ? Promise.resolve([]) : [];
  const clauses = [];
  const extra = [];
  for (const part of chunk(numeric)) {
    clauses.push(`rel.source_object_id IN (${placeholders(part)})`);
    extra.push(...part);
  }
  const sql = `SELECT rel.id, rel.source_object_id, rel.target_object_id, rel.attributes_json,
                      rel.valid_from, rel.valid_to, rel.status AS relationship_status
                 FROM object_relationships rel
                 JOIN relationship_types rt ON rt.id = rel.relationship_type_id
                WHERE rel.tenant_id = ? AND rt.code = ? AND rel.deleted_at IS NULL AND (${clauses.join(" OR ")})`;
  const params = [Number(tenantId), SOURCE_RELATIONSHIP_CODE, ...extra];
  return isAsync ? queryAllAsync(db, sql, params) : queryAll(db, sql, params);
}

// ── Transformation runs ─────────────────────────────────────────────────────

function transformationRunItems(rows) {
  return rows.map((row) => ({
    id: row.id,
    run_ref: row.run_ref,
    mode: row.mode,
    status: row.status,
    mapped_count: Number(row.mapped_count || 0),
    unmapped_count: Number(row.unmapped_count || 0),
    warning_count: Number(row.warning_count || 0),
    target_revision_id: row.target_revision_id ?? null,
    target_bom_id: row.target_bom_id ?? null,
    summary: parseAttributes(row.summary_json),
    created_at: row.created_at,
  }));
}

const RUNS_SQL = `SELECT id, run_ref, mode, status, summary_json, mapped_count, unmapped_count, warning_count,
                         target_bom_id, target_revision_id, created_at
                    FROM bom_transformation_runs
                   WHERE tenant_id = ? AND source_revision_id = ?
                   ORDER BY id DESC LIMIT 200`;

export function listTransformationsForRevision(db, tenantId, ref) {
  const revision = BomRevisions.getRevisionRow(db, tenantId, ref);
  if (!revision) throw mappingNotFound(ref);
  const rows = queryAll(db, RUNS_SQL, [Number(tenantId), Number(revision.id)]);
  return {
    revision_id: revision.id,
    revision_ref: revision.revision_ref || "",
    items: transformationRunItems(rows),
    total: rows.length,
    source_module: "requirement-manufacturing",
  };
}

export async function listTransformationsForRevisionAsync(db, tenantId, ref) {
  const revision = await BomRevisions.getRevisionRowAsync(db, tenantId, ref);
  if (!revision) throw mappingNotFound(ref);
  const rows = await queryAllAsync(db, RUNS_SQL, [Number(tenantId), Number(revision.id)]);
  return {
    revision_id: revision.id,
    revision_ref: revision.revision_ref || "",
    items: transformationRunItems(rows),
    total: rows.length,
    source_module: "requirement-manufacturing",
  };
}

// ── EBOM -> MBOM mappings (source-driven) ───────────────────────────────────

function paginateItems(items, opts = {}) {
  const { limit, offset, page, pageSize } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const sorted = opts.sort === "status" ? [...items].sort((a, b) => String(a.status).localeCompare(String(b.status))) : items;
  return { items: sorted.slice(offset, offset + limit), total: items.length, page, page_size: pageSize };
}

function indexLinesByKeys(lines) {
  const byRef = new Map();
  const byObject = new Map();
  for (const line of lines) {
    if (line.line_ref) byRef.set(String(line.line_ref), line);
    const key = lineageKey(line.child_object_id);
    if (key) byObject.set(key, line);
  }
  return { byRef, byObject };
}

function resolveSourceLine(prov, index) {
  if (prov.source_line_ref && index.byRef.has(String(prov.source_line_ref))) return index.byRef.get(String(prov.source_line_ref));
  if (prov.source_object_id && index.byObject.has(String(prov.source_object_id))) return index.byObject.get(String(prov.source_object_id));
  return null;
}

function buildEbomMbomResult(revision, header, ebomLines, targetRows, explicitRows, opts) {
  const index = indexLinesByKeys(ebomLines);
  const items = [];
  const linkedSourceKeys = new Set();

  for (const row of targetRows) {
    const prov = parseAttributes(row.attributes_json);
    const sourceLine = resolveSourceLine(prov, index);
    const status = mappingStatus({ sourceFound: Boolean(sourceLine), sourceActive: sourceLine ? lineIsActive(sourceLine) : true, targetActive: lineIsActive(row) });
    if (sourceLine) {
      if (sourceLine.line_ref) linkedSourceKeys.add(String(sourceLine.line_ref));
      const objectKey = lineageKey(sourceLine.child_object_id);
      if (objectKey) linkedSourceKeys.add(objectKey);
    }
    items.push({
      direction: "EBOM_TO_MBOM",
      link_source: "TRANSFORMATION_PROVENANCE",
      status,
      source: sourceLine
        ? { ...sourceLineDescriptor(sourceLine), found: true }
        : {
            found: false,
            line_id: null,
            line_ref: prov.source_line_ref || null,
            object_id: prov.source_object_id || null,
            object_type: prov.source_object_type || "",
            revision: "",
            parent_object_id: null,
            quantity: null,
            uom: "",
            usage: "",
            line_status: "",
            active: null,
          },
      target: {
        ...targetLineDescriptor(row),
        bom_id: row.bom_id,
        bom_number: row.bom_number,
        bom_type: row.bom_type,
        bom_revision_id: row.bom_revision_id,
        revision_number: row.revision_number,
        revision_ref: row.revision_ref || "",
      },
      quantity: row.quantity,
      uom: row.uom,
      usage: row.usage,
      configuration_context: row.configuration_context || "",
      valid_from: row.valid_from ?? null,
      valid_to: row.valid_to ?? null,
      provenance: prov,
    });
  }

  for (const relation of explicitRows) {
    const sourceKey = lineageKey(relation.source_object_id);
    const sourceLine = sourceKey ? index.byObject.get(sourceKey) : null;
    const targetKey = lineageKey(relation.target_object_id);
    if (sourceLine) {
      if (sourceLine.line_ref) linkedSourceKeys.add(String(sourceLine.line_ref));
      if (sourceKey) linkedSourceKeys.add(sourceKey);
    }
    items.push({
      direction: "EBOM_TO_MBOM",
      link_source: "OBJECT_RELATIONSHIP",
      relationship_id: relation.id,
      status: mappingStatus({ sourceFound: Boolean(sourceLine), sourceActive: sourceLine ? lineIsActive(sourceLine) : true }),
      source: sourceLine
        ? { ...sourceLineDescriptor(sourceLine), found: true }
        : { found: false, line_id: null, line_ref: null, object_id: sourceKey || null, object_type: "", revision: "", parent_object_id: null, quantity: null, uom: "", usage: "", line_status: "", active: null },
      target: { found: true, object_id: targetKey || null, object_type: "", line_ref: null, line_id: null, bom_revision_id: null },
      quantity: null,
      uom: "",
      usage: "",
      configuration_context: "",
      valid_from: relation.valid_from ?? null,
      valid_to: relation.valid_to ?? null,
      provenance: {},
    });
  }

  const unmappedSourceItems = ebomLines
    .filter((line) => !linkedSourceKeys.has(String(line.line_ref)) && !linkedSourceKeys.has(lineageKey(line.child_object_id)))
    .map((line) => ({
      line_id: line.id,
      line_ref: line.line_ref || "",
      object_id: line.child_object_id != null ? String(line.child_object_id) : null,
      object_type: line.child_object_type || "",
      revision: line.child_revision || "",
      reason: MISSING_LINK,
      line_status: line.line_status,
    }));

  const invalidLinks = items.filter((item) => item.status === INVALID_LINK);
  const notEffective = items.filter((item) => item.status === NOT_EFFECTIVE);
  const paged = paginateItems(items, opts);

  return {
    direction: "EBOM_TO_MBOM",
    ebom_revision: revisionDescriptor(revision, header),
    items: paged.items,
    unmapped_source_items: unmappedSourceItems,
    invalid_links: invalidLinks,
    not_effective_links: notEffective,
    summary: {
      ebom_lines: ebomLines.length,
      mappings: items.length,
      mapped: items.filter((item) => item.status === VALID).length,
      invalid: invalidLinks.length,
      not_effective: notEffective.length,
      unmapped_source_items: unmappedSourceItems.length,
    },
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    source_module: "requirement-manufacturing",
  };
}

export function ebomMbomMappingsSync(db, tenantId, ebomRef, opts = {}) {
  const revision = BomRevisions.getRevisionRow(db, tenantId, ebomRef);
  if (!revision) throw mappingNotFound(ebomRef);
  const header = revision.bom_id ? BomDefinitions.getBomRow(db, tenantId, revision.bom_id) : null;
  if (!header || String(header.bom_type).toUpperCase() !== EBOM_BOM_TYPE) {
    throw invalidMapping(`${ebomRef} is not an EBOM revision`, { bom_type: header?.bom_type ?? null });
  }
  const ebomLines = revisionLines(db, revision.id);
  const sourceRefs = uniqueStrings(ebomLines.map((line) => line.line_ref));
  const sourceObjects = uniqueStrings(ebomLines.map((line) => lineageKey(line.child_object_id)));
  const targetRows = fetchTargetLinesByProvenance(db, tenantId, sourceRefs, sourceObjects);
  const explicitRows = fetchExplicitMappings(db, tenantId, sourceObjects);
  return buildEbomMbomResult(revision, header, ebomLines, targetRows, explicitRows, opts);
}

export async function ebomMbomMappingsAsync(db, tenantId, ebomRef, opts = {}) {
  const revision = await BomRevisions.getRevisionRowAsync(db, tenantId, ebomRef);
  if (!revision) throw mappingNotFound(ebomRef);
  const header = revision.bom_id ? await BomDefinitions.getBomRowAsync(db, tenantId, revision.bom_id) : null;
  if (!header || String(header.bom_type).toUpperCase() !== EBOM_BOM_TYPE) {
    throw invalidMapping(`${ebomRef} is not an EBOM revision`, { bom_type: header?.bom_type ?? null });
  }
  const ebomLines = await revisionLines(db, revision.id, { async: true });
  const sourceRefs = uniqueStrings(ebomLines.map((line) => line.line_ref));
  const sourceObjects = uniqueStrings(ebomLines.map((line) => lineageKey(line.child_object_id)));
  const targetRows = await fetchTargetLinesByProvenance(db, tenantId, sourceRefs, sourceObjects, { async: true });
  const explicitRows = await fetchExplicitMappings(db, tenantId, sourceObjects, { async: true });
  return buildEbomMbomResult(revision, header, ebomLines, targetRows, explicitRows, opts);
}

// ── MBOM -> EBOM sources (target-driven) ────────────────────────────────────

function buildMbomEbomResult(revision, header, mbomLines, sourceLines, opts) {
  const index = indexLinesByKeys(sourceLines);
  const items = [];
  const unlinkedTargetItems = [];
  const invalidItems = [];

  for (const line of mbomLines) {
    const prov = parseAttributes(line.attributes_json);
    if (!prov.source_line_ref && !prov.source_object_id) {
      unlinkedTargetItems.push({
        line_id: line.id,
        line_ref: line.line_ref || "",
        object_id: line.child_object_id != null ? String(line.child_object_id) : null,
        object_type: line.child_object_type || "",
        revision: line.child_revision || "",
        line_status: line.line_status,
        reason: MISSING_LINK,
      });
      continue;
    }
    const sourceLine = resolveSourceLine(prov, index);
    const status = mappingStatus({ sourceFound: Boolean(sourceLine), sourceActive: sourceLine ? lineIsActive(sourceLine) : true, targetActive: lineIsActive(line) });
    const entry = {
      direction: "MBOM_TO_EBOM",
      link_source: "TRANSFORMATION_PROVENANCE",
      status,
      target: { ...targetLineDescriptor(line), bom_revision_id: revision.id, revision_number: revision.revision_number },
      source: sourceLine
        ? {
            found: true,
            line_id: sourceLine.id,
            line_ref: sourceLine.line_ref || "",
            object_id: sourceLine.child_object_id != null ? String(sourceLine.child_object_id) : null,
            object_type: sourceLine.child_object_type || "",
            revision: sourceLine.child_revision || "",
            bom_revision_id: sourceLine.bom_revision_id ?? null,
            bom_id: sourceLine.bom_id ?? null,
            bom_number: sourceLine.bom_number ?? "",
            bom_type: sourceLine.bom_type ?? "",
            line_status: sourceLine.line_status,
            active: lineIsActive(sourceLine),
          }
        : {
            found: false,
            line_id: null,
            line_ref: prov.source_line_ref || null,
            object_id: prov.source_object_id || null,
            object_type: prov.source_object_type || "",
            revision: "",
            active: null,
          },
      quantity: line.quantity,
      uom: line.uom,
      usage: line.usage,
      provenance: prov,
    };
    items.push(entry);
    if (status === INVALID_LINK) invalidItems.push(entry);
  }

  const paged = paginateItems(items, opts);
  return {
    direction: "MBOM_TO_EBOM",
    mbom_revision: revisionDescriptor(revision, header),
    items: paged.items,
    unlinked_target_items: unlinkedTargetItems,
    invalid_links: invalidItems,
    summary: {
      mbom_lines: mbomLines.length,
      traced: items.length,
      valid: items.filter((item) => item.status === VALID).length,
      invalid: invalidItems.length,
      not_effective: items.filter((item) => item.status === NOT_EFFECTIVE).length,
      unlinked_target_items: unlinkedTargetItems.length,
    },
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    source_module: "requirement-manufacturing",
  };
}

export function mbomEbomSourcesSync(db, tenantId, mbomRef, opts = {}) {
  const revision = BomRevisions.getRevisionRow(db, tenantId, mbomRef);
  if (!revision) throw mappingNotFound(mbomRef);
  const header = revision.bom_id ? BomDefinitions.getBomRow(db, tenantId, revision.bom_id) : null;
  if (!header || String(header.bom_type).toUpperCase() !== MBOM_BOM_TYPE) {
    throw invalidMapping(`${mbomRef} is not an MBOM revision`, { bom_type: header?.bom_type ?? null });
  }
  const mbomLines = revisionLines(db, revision.id);
  const sourceRefs = uniqueStrings(mbomLines.map((line) => parseAttributes(line.attributes_json).source_line_ref));
  const sourceObjects = uniqueStrings(mbomLines.map((line) => parseAttributes(line.attributes_json).source_object_id));
  const sourceLines = fetchLinesByKeys(db, tenantId, sourceRefs, sourceObjects);
  return buildMbomEbomResult(revision, header, mbomLines, sourceLines, opts);
}

export async function mbomEbomSourcesAsync(db, tenantId, mbomRef, opts = {}) {
  const revision = await BomRevisions.getRevisionRowAsync(db, tenantId, mbomRef);
  if (!revision) throw mappingNotFound(mbomRef);
  const header = revision.bom_id ? await BomDefinitions.getBomRowAsync(db, tenantId, revision.bom_id) : null;
  if (!header || String(header.bom_type).toUpperCase() !== MBOM_BOM_TYPE) {
    throw invalidMapping(`${mbomRef} is not an MBOM revision`, { bom_type: header?.bom_type ?? null });
  }
  const mbomLines = await revisionLines(db, revision.id, { async: true });
  const provenance = mbomLines.map((line) => parseAttributes(line.attributes_json));
  const sourceRefs = uniqueStrings(provenance.map((prov) => prov.source_line_ref));
  const sourceObjects = uniqueStrings(provenance.map((prov) => prov.source_object_id));
  const sourceLines = await fetchLinesByKeys(db, tenantId, sourceRefs, sourceObjects, { async: true });
  return buildMbomEbomResult(revision, header, mbomLines, sourceLines, opts);
}

// ── Public facade ───────────────────────────────────────────────────────────

export const ebomMbomMappings = ebomMbomMappingsSync;
export const mbomEbomSources = mbomEbomSourcesSync;
