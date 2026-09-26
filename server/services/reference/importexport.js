// Reference data import and export. Import is a governed, auditable two-step
// flow (validate/preview then commit); export produces a portable snapshot for
// integration or stewardship review.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { exportNotFound, importNotFound, invalidImport, invalidItem } from "./errors.js";
import { json, normalizeText, normalizeUpper, parseObject } from "./validation.js";
import { exportRef, importRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitReferenceEvent } from "./events.js";
import { getDomainRow, requireDomain } from "./domains.js";
import { createItem, getItemRow, publicItem, updateItem } from "./items.js";
import { listCodes } from "./codes.js";
import { listAliases } from "./aliases.js";
import { listTranslations } from "./translations.js";

const FORMATS = ["json", "csv", "tsv", "excel"];
const MAX_ROWS = 20000;

export function publicImport(row) {
  if (!row) return null;
  return {
    id: row.id,
    import_ref: row.import_ref,
    domain_id: row.domain_id,
    format: row.format,
    filename: row.filename,
    status: row.status,
    total_rows: row.total_rows,
    valid_rows: row.valid_rows,
    invalid_rows: row.invalid_rows,
    errors: (() => {
      try {
        return JSON.parse(row.error_json || "[]");
      } catch {
        return [];
      }
    })(),
    preview: (() => {
      try {
        return JSON.parse(row.preview_json || "[]");
      } catch {
        return [];
      }
    })(),
    options: parseObject(row.options_json, {}),
    created_by: row.created_by,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    committed_at: row.committed_at,
  };
}

export function parseDelimited(content, format) {
  if (format === "json" || format === "excel") {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
    } catch {
      throw invalidImport("Import JSON must be an array of row objects or { rows: [...] }");
    }
  }
  const delimiter = format === "tsv" ? "\t" : ",";
  const lines = String(content || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const header = splitLine(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line, delimiter);
    const row = {};
    header.forEach((key, index) => {
      row[key.trim()] = (cells[index] ?? "").trim();
    });
    return row;
  });
}

function splitLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeRow(raw) {
  const row = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, "_");
    row[normalized] = typeof value === "string" ? value.trim() : value;
  }
  return row;
}

function validateRow(db, domain, governance, raw, existingItems) {
  const row = normalizeRow(raw);
  const errors = [];
  const code = normalizeText(row.code || row.value_code || row.value);
  if (!code) errors.push("code is required");
  if (governance?.code_pattern && code) {
    const flags = governance.code_case_sensitive === false ? "i" : "";
    if (!new RegExp(governance.code_pattern, flags).test(code)) errors.push(`code "${code}" does not match the domain pattern`);
  }
  const scopeKey = normalizeText(row.scope_key, "GLOBAL");
  const existing = existingItems.find(
    (item) => item.scope_key === scopeKey && (governance.code_case_sensitive === false ? item.code.toLowerCase() === code.toLowerCase() : item.code === code)
  );
  return {
    row,
    errors,
    code,
    scope_key: scopeKey,
    operation: existing ? "update" : "create",
    existing_ref: existing?.item_ref ?? null,
    valid: errors.length === 0,
  };
}

export function createImport(db, input = {}, actor = null, tenantId = null, ip = null) {
  const domain = requireDomain(db, input.domain_id ?? input.domainId ?? input.domain_code ?? input.domainCode);
  const format = FORMATS.includes(input.format) ? input.format : "json";
  let rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length && input.content) rows = parseDelimited(input.content, format);
  if (!rows.length) throw invalidImport("No import rows were supplied");
  if (rows.length > MAX_ROWS) throw invalidImport(`Import exceeds the maximum of ${MAX_ROWS} rows`);
  const governance = queryOne(db, "SELECT * FROM reference_governance_policies WHERE domain_id = ? AND status = 'active'", [domain.id]);
  const governanceShape = governance
    ? { ...governance, code_pattern: governance.code_pattern, code_case_sensitive: Boolean(governance.code_case_sensitive) }
    : { code_pattern: "", code_case_sensitive: true };
  const existingItems = queryAll(db, "SELECT item_ref, code, scope_key FROM reference_data_items WHERE domain_id = ?", [domain.id]);
  const validated = rows.map((row) => validateRow(db, domain, governanceShape, row, existingItems));
  const validRows = validated.filter((v) => v.valid);
  const errors = validated.filter((v) => !v.valid).map((v, index) => ({ row: index + 1, code: v.code, errors: v.errors }));
  const duplicateCodes = new Map();
  for (const v of validRows) {
    const key = `${v.scope_key}::${v.code.toLowerCase()}`;
    duplicateCodes.set(key, (duplicateCodes.get(key) || 0) + 1);
  }
  for (const [key, count] of duplicateCodes) {
    if (count > 1) errors.push({ row: null, code: key.split("::")[1], errors: ["duplicate code within the import file"] });
  }
  const status = errors.length && !validRows.length ? "failed" : errors.length ? "validated" : "previewed";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_imports
      (import_ref, domain_id, format, filename, status, total_rows, valid_rows, invalid_rows, error_json, preview_json, options_json, created_by, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      importRef(),
      Number(domain.id),
      format,
      normalizeText(input.filename),
      status,
      rows.length,
      validRows.length,
      errors.length,
      JSON.stringify(errors),
      JSON.stringify(validated.filter((v) => v.valid).map((v) => ({ ...v.row, code: v.code, scope_key: v.scope_key }))),
      JSON.stringify(input.options ?? {}),
      actor?.id ?? null,
      tenantId ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_imports WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "reference.import.validate",
    resourceType: "reference_import",
    resourceId: row.id,
    details: { domain: domain.code, total: rows.length, valid: validRows.length, invalid: errors.length },
    ip,
  });
  return publicImport(row);
}

export function getImportRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_imports WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_imports WHERE import_ref = ?", [String(ref)]) || null;
}

export function getImport(db, ref) {
  const row = getImportRow(db, ref);
  if (!row) throw importNotFound(ref);
  return publicImport(row);
}

export function listImports(db, { domainId, status, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { items: queryAll(db, `SELECT * FROM reference_imports ${where} ORDER BY created_at DESC LIMIT ?`, [...params, Math.min(500, Number(limit) || 100)]).map(publicImport) };
}

export function commitImport(db, ref, input = {}, actor = null, ip = null) {
  const row = getImportRow(db, ref);
  if (!row) throw importNotFound(ref);
  if (!["validated", "previewed"].includes(row.status)) throw invalidImport(`Import ${row.import_ref} is not in a committable state`, { status: row.status });
  const domain = queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [row.domain_id]);
  if (!domain) throw invalidImport("Import domain no longer exists");
  let payload = [];
  try {
    payload = JSON.parse(row.preview_json || "[]");
  } catch {
    payload = [];
  }
  const sourceRows = Array.isArray(input.rows) && input.rows.length ? input.rows : null;
  const rows = sourceRows || payload.filter((p) => p.valid !== false);
  let created = 0;
  let updated = 0;
  const failures = [];
  for (const entry of rows) {
    try {
      const code = normalizeText(entry.code);
      const scopeKey = normalizeText(entry.scope_key, "GLOBAL");
      const existing = queryOne(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND scope_key = ? AND code = ?", [
        Number(domain.id),
        scopeKey,
        code,
      ]);
      if (existing) {
        updateItem(db, existing.item_ref, entry, actor, ip);
        updated += 1;
      } else {
        createItem(db, { ...entry, domain_id: domain.id, scope_key: scopeKey }, actor, row.tenant_id, ip);
        created += 1;
      }
    } catch (error) {
      failures.push({ code: entry.code, error: error.message });
    }
  }
  const status = failures.length && !created && !updated ? "failed" : "committed";
  run(db, "UPDATE reference_imports SET status = ?, error_json = ?, committed_at = ?, updated_at = ? WHERE id = ?", [
    status,
    JSON.stringify(failures),
    nowIso(),
    nowIso(),
    row.id,
  ]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.import.commit",
    resourceType: "reference_import",
    resourceId: row.id,
    details: { domain: domain.code, created, updated, failures: failures.length },
    ip,
  });
  emitReferenceEvent(
    db,
    { eventType: "ReferenceImportCommitted", domainId: domain.id, tenantId: row.tenant_id, payload: { import_ref: row.import_ref, created, updated, failures: failures.length } },
    actor
  );
  return { ...publicImport(queryOne(db, "SELECT * FROM reference_imports WHERE id = ?", [row.id])), created, updated, failures };
}

// ── Export ──────────────────────────────────────────────────────────────────

export function publicExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    export_ref: row.export_ref,
    domain_id: row.domain_id,
    format: row.format,
    status: row.status,
    filters: parseObject(row.filters_json, {}),
    row_count: row.row_count,
    content: row.content,
    requested_by: row.requested_by,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function buildExportContent(db, domain, format, filters) {
  const items = queryAll(
    db,
    `SELECT * FROM reference_data_items WHERE domain_id = ? ${filters.status ? "AND status = ?" : ""} ORDER BY sequence, code`,
    filters.status ? [domain.id, filters.status] : [domain.id]
  ).map(publicItem);
  const rows = items.map((item) => {
    const codes = listCodes(db, { itemId: item.id }).items;
    const aliases = listAliases(db, { itemId: item.id }).items;
    const translations = listTranslations(db, { itemId: item.id }).items;
    return {
      item_ref: item.item_ref,
      code: item.code,
      name: item.name,
      description: item.description,
      status: item.status,
      scope_type: item.scope_type,
      scope_key: item.scope_key,
      effective_from: item.effective_from,
      effective_to: item.effective_to,
      version: item.current_version_number,
      parent_id: item.parent_id,
      sequence: item.sequence,
      attributes: item.attributes,
      codes: codes.map((c) => ({ code: c.code, code_type: c.code_type, code_system: c.code_system, status: c.status })),
      aliases: aliases.map((a) => ({ alias: a.alias, alias_type: a.alias_type, language: a.language })),
      translations: translations.map((t) => ({ language: t.language, name: t.name, description: t.description, status: t.status })),
    };
  });
  if (format === "json") return { content: JSON.stringify({ domain: domain.code, exported_at: nowIso(), rows }, null, 2), row_count: rows.length };
  const headers = ["code", "name", "description", "status", "scope_key", "effective_from", "effective_to", "version"];
  const delimiter = format === "tsv" ? "\t" : ",";
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\t\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(delimiter)];
  for (const item of items) {
    lines.push(headers.map((header) => escape(item[header])).join(delimiter));
  }
  return { content: lines.join("\n"), row_count: items.length };
}

export function createExport(db, input = {}, actor = null, tenantId = null, ip = null) {
  const domain = requireDomain(db, input.domain_id ?? input.domainId ?? input.domain_code ?? input.domainCode);
  const format = ["json", "csv", "tsv"].includes(input.format) ? input.format : "json";
  const filters = input.filters ?? {};
  const { content, row_count } = buildExportContent(db, domain, format, filters);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_exports
      (export_ref, domain_id, format, status, filters_json, row_count, content, requested_by, tenant_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [exportRef(), Number(domain.id), format, JSON.stringify(filters), row_count, content, actor?.id ?? null, tenantId ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM reference_exports WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "reference.export.create",
    resourceType: "reference_export",
    resourceId: row.id,
    details: { domain: domain.code, format, row_count },
    ip,
  });
  emitReferenceEvent(
    db,
    { eventType: "ReferenceExportCreated", domainId: domain.id, tenantId, payload: { export_ref: row.export_ref, format, row_count } },
    actor
  );
  return publicExport(row);
}

export function getExportRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_exports WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_exports WHERE export_ref = ?", [String(ref)]) || null;
}

export function getExport(db, ref) {
  const row = getExportRow(db, ref);
  if (!row) throw exportNotFound(ref);
  return publicExport(row);
}

export function listExports(db, { domainId, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return {
    items: queryAll(db, `SELECT * FROM reference_exports ${where} ORDER BY created_at DESC LIMIT ?`, [...params, Math.min(500, Number(limit) || 100)]).map(
      publicExport
    ),
  };
}
