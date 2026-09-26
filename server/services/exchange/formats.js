// Format Registry (§4).
//
// A single, centralized place where formats and their versions are registered,
// bound to an adapter, and given a lifecycle status. No format or version is
// ever hard-coded in the engine: the catalog seeds rows, and every lookup goes
// through here.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { formatRef } from "./identifiers.js";
import { FORMAT_CATALOG, ADAPTER_CATALOG, FORMAT_STATUSES, DIRECTIONS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { publicFormat, publicFormatVersion, publicAdapter, parseJson, toJson } from "./repository.js";
import { formatNotFound, formatConflict, invalidFormat, adapterNotFound, invalidQuery } from "./errors.js";
import { normalizeUpper } from "../data-exchange/validation.js";

function pageArgs(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize || DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function getFormatRow(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const raw = String(ref ?? "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = queryOne(db, "SELECT * FROM exchange_formats WHERE id = ? AND tenant_id = ?", [Number(raw), tenant]);
    if (byId) return byId;
  }
  return queryOne(
    db,
    "SELECT * FROM exchange_formats WHERE tenant_id = ? AND (format_ref = ? OR code = ? COLLATE NOCASE)",
    [tenant, raw, raw]
  );
}

export function requireFormatRow(db, tenantId, ref) {
  const row = getFormatRow(db, tenantId, ref);
  if (!row) throw formatNotFound(ref);
  return row;
}

function normalizeFormatInput(body = {}) {
  const code = normalizeUpper(body.code || body.format_code || "", { max: 80 });
  if (!code) throw invalidFormat("A format code is required");
  const direction = normalizeUpper(body.direction || "BOTH");
  if (!DIRECTIONS.includes(direction)) throw invalidFormat(`Unsupported direction: ${body.direction}`);
  const adapterCode = String(body.adapter_code || body.adapterCode || "").trim();
  return {
    code,
    name: String(body.name || code).trim(),
    standard_name: String(body.standard_name || body.standardName || "").trim(),
    standard_version: String(body.standard_version || body.standardVersion || "").trim(),
    description: String(body.description || "").trim(),
    category: normalizeUpper(body.category || "OTHER"),
    mime_types: Array.isArray(body.mime_types || body.mimeTypes) ? body.mime_types || body.mimeTypes : [],
    extensions: Array.isArray(body.extensions) ? body.extensions : [],
    direction,
    adapter_code: adapterCode,
    capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
    schema: body.schema && typeof body.schema === "object" ? body.schema : {},
    status: normalizeUpper(body.status || "ACTIVE"),
    effective_from: body.effective_from || body.effectiveFrom || null,
    effective_to: body.effective_to || body.effectiveTo || null,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    display_order: Number(body.display_order ?? body.displayOrder ?? 100),
  };
}

function capabilityFlags(adapterCode, requested = {}) {
  const descriptor = ADAPTER_CATALOG.find((entry) => entry.code === adapterCode);
  const available = descriptor ? descriptor.status === "AVAILABLE" : false;
  return {
    import_supported: available && requested.importSupported !== false ? 1 : 0,
    export_supported: available && requested.exportSupported !== false ? 1 : 0,
    validate_supported: available && requested.validateSupported !== false ? 1 : 0,
  };
}

export function createFormat(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeFormatInput(body);
  if (!FORMAT_STATUSES.includes(input.status)) throw invalidFormat(`Unsupported format status: ${input.status}`);
  if (input.adapter_code && !ADAPTER_CATALOG.some((entry) => entry.code === input.adapter_code)) {
    throw adapterNotFound(input.adapter_code);
  }
  const existing = queryOne(db, "SELECT id FROM exchange_formats WHERE tenant_id = ? AND code = ?", [tenant, input.code]);
  if (existing) throw formatConflict(input.code);
  const caps = capabilityFlags(input.adapter_code, input.capabilities || {});
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_formats
       (format_ref, tenant_id, code, name, standard_name, standard_version, description, category,
        mime_types_json, extensions_json, direction, adapter_code, import_supported, export_supported, validate_supported,
        capabilities_json, schema_json, status, effective_from, effective_to, is_system, display_order, metadata_json,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      formatRef(input.code),
      tenant,
      input.code,
      input.name,
      input.standard_name,
      input.standard_version,
      input.description,
      input.category,
      toJson(input.mime_types, []),
      toJson(input.extensions, []),
      input.direction,
      input.adapter_code,
      caps.import_supported,
      caps.export_supported,
      caps.validate_supported,
      toJson(input.capabilities, {}),
      toJson(input.schema, {}),
      input.status,
      input.effective_from,
      input.effective_to,
      input.display_order,
      toJson(input.metadata, {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return publicFormat(queryOne(db, "SELECT * FROM exchange_formats WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateFormat(db, tenantId, ref, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireFormatRow(db, tenant, ref);
  const input = normalizeFormatInput({ ...publicToInput(row), ...body });
  const caps = capabilityFlags(input.adapter_code, input.capabilities || {});
  run(
    db,
    `UPDATE exchange_formats SET name=?, standard_name=?, standard_version=?, description=?, category=?,
       mime_types_json=?, extensions_json=?, direction=?, adapter_code=?, import_supported=?, export_supported=?,
       validate_supported=?, capabilities_json=?, schema_json=?, effective_from=?, effective_to=?, display_order=?,
       metadata_json=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
    [
      input.name,
      input.standard_name,
      input.standard_version,
      input.description,
      input.category,
      toJson(input.mime_types, []),
      toJson(input.extensions, []),
      input.direction,
      input.adapter_code,
      caps.import_supported,
      caps.export_supported,
      caps.validate_supported,
      toJson(input.capabilities, {}),
      toJson(input.schema, {}),
      input.effective_from,
      input.effective_to,
      input.display_order,
      toJson(input.metadata, {}),
      actor?.id ?? null,
      nowIso(),
      row.id,
      tenant,
    ]
  );
  return publicFormat(queryOne(db, "SELECT * FROM exchange_formats WHERE id = ?", [row.id]));
}

function publicToInput(row) {
  return {
    code: row.code,
    name: row.name,
    standard_name: row.standard_name,
    standard_version: row.standard_version,
    description: row.description,
    category: row.category,
    mime_types: parseJson(row.mime_types_json, []),
    extensions: parseJson(row.extensions_json, []),
    direction: row.direction,
    adapter_code: row.adapter_code,
    capabilities: parseJson(row.capabilities_json, {}),
    schema: parseJson(row.schema_json, {}),
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    metadata: parseJson(row.metadata_json, {}),
    display_order: row.display_order,
  };
}

export function setFormatStatus(db, tenantId, ref, status, actor = null) {
  const tenant = Number(tenantId);
  const row = requireFormatRow(db, tenant, ref);
  const next = normalizeUpper(status);
  if (!FORMAT_STATUSES.includes(next)) throw invalidFormat(`Unsupported format status: ${status}`);
  run(db, "UPDATE exchange_formats SET status=?, updated_by=?, updated_at=? WHERE id=? AND tenant_id=?", [next, actor?.id ?? null, nowIso(), row.id, tenant]);
  return publicFormat(queryOne(db, "SELECT * FROM exchange_formats WHERE id = ?", [row.id]));
}

export function deleteFormat(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireFormatRow(db, tenant, ref);
  if (row.is_system) {
    // System formats are retired, never removed, to preserve history.
    return setFormatStatus(db, tenant, ref, "OBSOLETE");
  }
  run(db, "DELETE FROM exchange_formats WHERE id = ? AND tenant_id = ?", [row.id, tenant]);
  return { deleted: true, ref: row.format_ref, code: row.code };
}

export function listFormats(db, tenantId, query = {}) {
  const tenant = Number(tenantId);
  const { page, pageSize, offset } = pageArgs(query);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  if (query.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(query.status));
  }
  if (query.category) {
    clauses.push("category = ?");
    params.push(normalizeUpper(query.category));
  }
  if (query.direction) {
    clauses.push("(direction = ? OR direction = 'BOTH')");
    params.push(normalizeUpper(query.direction));
  }
  if (query.q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR standard_name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_formats WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(
    db,
    `SELECT * FROM exchange_formats WHERE ${where} ORDER BY display_order ASC, code ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items: rows.map(publicFormat), total, page, pageSize };
}

export function getFormat(db, tenantId, ref) {
  const row = requireFormatRow(db, tenantId, ref);
  const output = publicFormat(row);
  output.versions = listFormatVersions(db, tenantId, row.id).items;
  return output;
}

export function listFormatVersions(db, tenantId, formatRefValue) {
  const tenant = Number(tenantId);
  const row = requireFormatRow(db, tenant, formatRefValue);
  const rows = queryAll(db, "SELECT * FROM exchange_format_versions WHERE format_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicFormatVersion), total: rows.length };
}

export function createFormatVersion(db, tenantId, formatRefValue, body = {}, actor = null) {
  const tenant = Number(tenantId);
  const row = requireFormatRow(db, tenant, formatRefValue);
  const version = Number(body.version || (queryOne(db, "SELECT MAX(version) AS v FROM exchange_format_versions WHERE format_id = ?", [row.id])?.v || 0) + 1);
  const existing = queryOne(db, "SELECT id FROM exchange_format_versions WHERE format_id = ? AND version = ?", [row.id, version]);
  if (existing) throw formatConflict(`${row.code}@${version}`);
  const result = run(
    db,
    `INSERT INTO exchange_format_versions
       (format_id, tenant_id, version, standard_version, status, schema_json, capabilities_json, change_summary, effective_from, effective_to, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      tenant,
      version,
      String(body.standard_version || row.standard_version || ""),
      normalizeUpper(body.status || "ACTIVE"),
      toJson(body.schema || {}, {}),
      toJson(body.capabilities || {}, {}),
      String(body.change_summary || body.changeSummary || ""),
      body.effective_from || null,
      body.effective_to || null,
      actor?.id ?? null,
      nowIso(),
    ]
  );
  return publicFormatVersion(queryOne(db, "SELECT * FROM exchange_format_versions WHERE id = ?", [Number(result.lastInsertRowid)]));
}

// ── Adapter registry persistence ─────────────────────────────────────────────
export function ensureAdapters(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const descriptor of ADAPTER_CATALOG) {
    const existing = queryOne(db, "SELECT id FROM exchange_adapters WHERE tenant_id = ? AND code = ?", [tenant, descriptor.code]);
    if (existing) {
      run(
        db,
        "UPDATE exchange_adapters SET name=?, description=?, provider=?, category=?, status=?, capabilities_json=?, library=?, is_builtin=?, formats_json=?, updated_at=? WHERE id=?",
        [
          descriptor.name,
          descriptor.description || "",
          descriptor.provider || "platform",
          descriptor.category || "OTHER",
          descriptor.status,
          toJson(descriptor.capabilities || {}, {}),
          descriptor.library || "",
          descriptor.provider === "platform" ? 1 : 0,
          toJson(FORMAT_CATALOG.filter((format) => format.adapter_code === descriptor.code).map((format) => format.code), []),
          nowIso(),
          existing.id,
        ]
      );
      continue;
    }
    run(
      db,
      `INSERT INTO exchange_adapters
         (tenant_id, code, name, description, provider, provider_version, category, status, capabilities_json, formats_json, library, is_builtin, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      [
        tenant,
        descriptor.code,
        descriptor.name,
        descriptor.description || "",
        descriptor.provider || "platform",
        descriptor.provider_version || "",
        descriptor.category || "OTHER",
        descriptor.status,
        toJson(descriptor.capabilities || {}, {}),
        toJson(FORMAT_CATALOG.filter((format) => format.adapter_code === descriptor.code).map((format) => format.code), []),
        descriptor.library || "",
        descriptor.provider === "platform" ? 1 : 0,
        nowIso(),
        nowIso(),
      ]
    );
    created += 1;
  }
  return created;
}

export function ensureFormats(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const format of FORMAT_CATALOG) {
    const existing = queryOne(db, "SELECT id, is_system FROM exchange_formats WHERE tenant_id = ? AND code = ?", [tenant, format.code]);
    const descriptor = ADAPTER_CATALOG.find((entry) => entry.code === format.adapter_code);
    const available = descriptor ? descriptor.status === "AVAILABLE" : false;
    const caps = format.capabilities || {};
    const importSupported = available && caps.parse ? 1 : 0;
    const exportSupported = available && caps.serialize ? 1 : 0;
    const validateSupported = available && (caps.validate !== false && (caps.parse || caps.compliance || caps.schema)) ? 1 : 0;
    if (existing) {
      run(
        db,
        "UPDATE exchange_formats SET is_system=1, import_supported=?, export_supported=?, validate_supported=?, updated_at=? WHERE id=?",
        [importSupported, exportSupported, validateSupported, nowIso(), existing.id]
      );
      continue;
    }
    run(
      db,
      `INSERT INTO exchange_formats
         (format_ref, tenant_id, code, name, standard_name, standard_version, description, category,
          mime_types_json, extensions_json, direction, adapter_code, import_supported, export_supported, validate_supported,
          capabilities_json, schema_json, status, is_system, display_order, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'ACTIVE', 1, ?, '{}', ?, ?)`,
      [
        formatRef(format.code),
        tenant,
        format.code,
        format.name,
        format.standard_name || "",
        format.standard_version || "",
        format.description || "",
        format.category || "OTHER",
        toJson(format.mime_types || [], []),
        toJson(format.extensions || [], []),
        format.direction || "BOTH",
        format.adapter_code || "",
        importSupported,
        exportSupported,
        validateSupported,
        toJson(caps, {}),
        format.display_order ?? 100,
        nowIso(),
        nowIso(),
      ]
    );
    created += 1;
  }
  return created;
}

export function listAdapters(db, tenantId) {
  const tenant = Number(tenantId);
  const rows = queryAll(db, "SELECT * FROM exchange_adapters WHERE tenant_id = ? ORDER BY category, code", [tenant]);
  return { items: rows.map(publicAdapter), total: rows.length };
}

export function getAdapter(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = queryOne(db, "SELECT * FROM exchange_adapters WHERE tenant_id = ? AND (code = ? COLLATE NOCASE OR id = ?)", [tenant, String(ref), Number(ref) || -1]);
  if (!row) throw adapterNotFound(ref);
  return publicAdapter(row);
}

export function formatOptions(db, tenantId, query = {}) {
  const list = listFormats(db, tenantId, { ...query, page_size: MAX_PAGE_SIZE });
  if (query.page && Number(query.page) > Math.ceil(list.total / list.pageSize)) throw invalidQuery("Requested page is out of range");
  return list;
}
