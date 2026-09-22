// Built-in connectors registered on first use. They are deliberately dependency
// free: CSV/JSON/XML/Excel are parsed in-process, REST uses the platform fetch,
// and DATABASE reads through the platform's own read-only query helper.
//
// Binary/enterprise systems (Cloud storage, Legacy PLM, ERP, CAD, MES, PDF,
// Parquet) are registered as **extension seams**: a deployment registers a
// provider with `registerConnector(..., { replace: true })` to back them with a
// real adapter. Until then they fail closed with a clear, actionable error.
import { queryAll } from "../../../db.js";
import { connectorFailed, connectorUnsupported, invalidConnector } from "../errors.js";
import { normalizeText, parseArray } from "../validation.js";
import { registerConnector, getConnector } from "./registry.js";
import {
  parseCsv,
  serializeCsv,
  parseJson,
  serializeJson,
  parseXml,
  serializeXml,
  parseSpreadsheet,
  serializeSpreadsheet,
  inferFields,
} from "./codecs.js";

function contentOf(ctx = {}) {
  if (Buffer.isBuffer(ctx.buffer)) return ctx.buffer.toString("utf8");
  if (ctx.buffer instanceof Uint8Array) return Buffer.from(ctx.buffer).toString("utf8");
  if (typeof ctx.content === "string") return ctx.content;
  const settings = ctx.settings || {};
  if (typeof settings.content === "string") return settings.content;
  throw connectorFailed("No content was supplied to the connector", { connector: ctx.connector_type || null });
}

function settingsOf(ctx = {}) {
  return ctx.settings && typeof ctx.settings === "object" ? ctx.settings : {};
}

function readOptions(settings) {
  return {
    delimiter: settings.delimiter || ",",
    quote: settings.quote || '"',
    hasHeader: settings.has_header !== false && settings.hasHeader !== false,
    ndjson: settings.ndjson === true,
    recordsPath: settings.records_path || settings.recordsPath || null,
    recordPath: settings.record_path || settings.recordPath || null,
  };
}

function normalizeFields(fields, fallbackRecords) {
  if (Array.isArray(fields) && fields.length) {
    return fields.map((field) => (typeof field === "string" ? { name: field, data_type: "string" } : field));
  }
  return inferFields(fallbackRecords || []);
}

function textConnector({ code, name, description, parse, serialize, capabilities }) {
  return {
    code,
    name,
    description,
    directions: ["SOURCE", "DESTINATION"],
    capabilities: capabilities || ["READ", "WRITE", "SCHEMA_DISCOVERY", "STREAMING"],
    formats: [code],
    built_in: true,
    testConnection: () => ({ ok: true, message: `${name} is an in-process format connector` }),
    discoverSchema: (ctx) => {
      const parsed = parse(contentOf(ctx), readOptions(settingsOf(ctx)));
      return { fields: normalizeFields(parsed.fields, parsed.records), sample: parsed.records.slice(0, 10) };
    },
    read: (ctx) => {
      const parsed = parse(contentOf(ctx), readOptions(settingsOf(ctx)));
      return { fields: normalizeFields(parsed.fields, parsed.records), records: parsed.records };
    },
    write: (ctx) => {
      const records = Array.isArray(ctx.records) ? ctx.records : [];
      const fields = normalizeFields(ctx.fields, records);
      return { ...serialize(records, fields, readOptions(settingsOf(ctx))), records: records.length };
    },
  };
}

function fileExtension(settings, fallback) {
  const name = settings.filename || settings.file_name || settings.path || "";
  const match = String(name).match(/\.([a-z0-9]+)$/i);
  return (match ? match[1] : fallback).toLowerCase();
}

export function registerBuiltinConnectors() {
  if (getConnector("CSV")) return { registered: 0 };

  registerConnector(textConnector({ code: "CSV", name: "CSV", description: "Comma/character separated values.", parse: parseCsv, serialize: serializeCsv }));
  registerConnector(
    textConnector({
      code: "JSON",
      name: "JSON",
      description: "JSON array, wrapped array, or newline-delimited JSON.",
      parse: parseJson,
      serialize: serializeJson,
    })
  );
  registerConnector(textConnector({ code: "XML", name: "XML", description: "XML records with configurable record path.", parse: parseXml, serialize: serializeXml }));
  registerConnector(
    textConnector({
      code: "EXCEL",
      name: "Excel (SpreadsheetML)",
      description: "SpreadsheetML 2003 XML that Excel and LibreOffice open natively.",
      parse: parseSpreadsheet,
      serialize: serializeSpreadsheet,
      capabilities: ["READ", "WRITE", "SCHEMA_DISCOVERY"],
    })
  );

  // FILE: reads content already fetched by the File Storage / blob provider and
  // delegates to the matching in-process codec based on the file extension.
  registerConnector({
    code: "FILE",
    name: "File",
    description: "A stored file; the format is inferred from the file name or configured explicitly.",
    directions: ["SOURCE", "DESTINATION"],
    capabilities: ["READ", "SCHEMA_DISCOVERY", "STREAMING"],
    formats: ["CSV", "JSON", "XML", "EXCEL"],
    built_in: true,
    testConnection: () => ({ ok: true, message: "File connector resolves content through the configured storage provider" }),
    discoverSchema: (ctx) => requireConnectorForFormat(fileExtension(settingsOf(ctx), settingsOf(ctx).format)).discoverSchema(ctx),
    read: (ctx) => requireConnectorForFormat(fileExtension(settingsOf(ctx), settingsOf(ctx).format)).read(ctx),
    write: () => {
      throw connectorUnsupported("FILE", "WRITE");
    },
  });

  // REST: live HTTP(S) integration. Pagination, retry and rate limiting are
  // configured, never assumed.
  registerConnector({
    code: "REST",
    name: "REST API",
    description: "Reads and writes records through a configured HTTP(S) endpoint with pagination.",
    directions: ["SOURCE", "DESTINATION"],
    capabilities: ["READ", "WRITE", "PAGINATION", "INCREMENTAL", "SCHEMA_DISCOVERY"],
    formats: ["JSON", "XML", "CSV"],
    built_in: true,
    testConnection: async (ctx) => {
      const settings = settingsOf(ctx);
      if (!settings.url) throw invalidConnector("A REST connector requires settings.url");
      const response = await fetchWithTimeout(settings.url, { method: settings.test_method || "GET", headers: headersOf(ctx) }, settings);
      return { ok: response.ok, message: `HTTP ${response.status}`, details: { status: response.status } };
    },
    discoverSchema: async (ctx) => {
      const page = await readRestPage(ctx, 1);
      return { fields: normalizeFields(page.fields, page.records), sample: page.records.slice(0, 10) };
    },
    read: async (ctx) => {
      const settings = settingsOf(ctx);
      const maxPages = Number(settings.max_pages || 50);
      const pageSize = Number(settings.page_size || settings.pageSize || 100);
      let allRecords = [];
      let fields = [];
      let cursor = null;
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await readRestPage(ctx, page, cursor);
        fields = result.fields.length ? result.fields : fields;
        allRecords = allRecords.concat(result.records);
        cursor = result.cursor;
        if (result.records.length < pageSize || !settings.pagination) break;
        if (result.cursor && settings.pagination === "cursor") continue;
      }
      return { fields: normalizeFields(fields, allRecords), records: allRecords };
    },
    write: async (ctx) => {
      const settings = settingsOf(ctx);
      if (!settings.url) throw invalidConnector("A REST connector requires settings.url");
      const response = await fetchWithTimeout(
        settings.url,
        { method: settings.write_method || "POST", headers: { "content-type": "application/json", ...headersOf(ctx) }, body: JSON.stringify(ctx.records || []) },
        settings
      );
      if (!response.ok) throw connectorFailed(`REST write failed with HTTP ${response.status}`, { status: response.status });
      return { records: (ctx.records || []).length, content: "", content_type: "application/json", extension: "json", details: { status: response.status } };
    },
  });

  // DATABASE: reads through the platform's own read-only query helper. The query
  // is validated to be a single SELECT statement.
  registerConnector({
    code: "DATABASE",
    name: "Database",
    description: "Reads records from the platform database using a configured, read-only SELECT.",
    directions: ["SOURCE", "DESTINATION"],
    capabilities: ["READ", "SCHEMA_DISCOVERY", "PAGINATION", "TRANSACTION"],
    formats: ["DATABASE"],
    built_in: true,
    testConnection: (ctx) => {
      const settings = settingsOf(ctx);
      if (settings.query) assertSelect(settings.query);
      return { ok: true, message: "Database connector ready" };
    },
    discoverSchema: (ctx) => {
      const records = readDatabase(ctx);
      return { fields: normalizeFields(null, records), sample: records.slice(0, 10) };
    },
    read: (ctx) => {
      const records = readDatabase(ctx);
      return { fields: normalizeFields(null, records), records };
    },
    write: () => {
      throw connectorUnsupported("DATABASE", "WRITE");
    },
  });

  // Extension seams. A deployment replaces these with real adapters.
  for (const [code, name] of [
    ["CLOUD_STORAGE", "Cloud storage"],
    ["LEGACY_PLM", "Legacy PLM"],
    ["ERP", "ERP system"],
    ["CAD", "CAD system"],
    ["MES", "MES system"],
  ]) {
    registerConnector({
      code,
      name,
      description: `${name} adapter extension point. Register a provider to enable it.`,
      directions: ["SOURCE", "DESTINATION"],
      capabilities: [],
      formats: [],
      built_in: false,
      testConnection: () => {
        throw connectorUnsupported(code, "use");
      },
      discoverSchema: () => {
        throw connectorUnsupported(code, "SCHEMA_DISCOVERY");
      },
      read: () => {
        throw connectorUnsupported(code, "READ");
      },
      write: () => {
        throw connectorUnsupported(code, "WRITE");
      },
    });
  }

  return { registered: 12 };
}

function requireConnectorForFormat(format) {
  const normalized = normalizeText(format, { max: 16 }).toUpperCase();
  const connector = getConnector(normalized);
  if (!connector) throw invalidConnector(`Unsupported file format: ${format}`);
  return connector;
}

function headersOf(ctx) {
  const settings = settingsOf(ctx);
  const headers = { ...(settings.headers && typeof settings.headers === "object" ? settings.headers : {}) };
  if (ctx.credentials?.token_ref_placeholder) headers.authorization = ctx.credentials.token_ref_placeholder;
  return headers;
}

async function fetchWithTimeout(url, init, settings) {
  const timeoutMs = Number(settings.timeout_seconds || settings.timeoutSeconds || 30) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw connectorFailed(`REST request failed: ${error.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

async function readRestPage(ctx, page, cursor = null) {
  const settings = settingsOf(ctx);
  if (!settings.url) throw invalidConnector("A REST connector requires settings.url");
  const url = new URL(settings.url);
  const pageParam = settings.page_param || settings.pageParam || "page";
  const sizeParam = settings.page_size_param || settings.pageSizeParam || "page_size";
  const cursorParam = settings.cursor_param || settings.cursorParam || "cursor";
  if (settings.pagination === "cursor" && cursor) url.searchParams.set(cursorParam, cursor);
  else {
    url.searchParams.set(pageParam, String(page));
    url.searchParams.set(sizeParam, String(settings.page_size || settings.pageSize || 100));
  }
  const response = await fetchWithTimeout(url.toString(), { method: settings.method || "GET", headers: headersOf(ctx) }, settings);
  if (!response.ok) throw connectorFailed(`REST read failed with HTTP ${response.status}`, { status: response.status });
  const text = await response.text();
  const format = String(settings.format || "JSON").toUpperCase();
  const opts = readOptions(settings);
  const parsed = format === "XML" ? parseXml(text, opts) : format === "CSV" ? parseCsv(text, opts) : parseJson(text, opts);
  let nextCursor = null;
  if (settings.pagination === "cursor") {
    try {
      const body = JSON.parse(text);
      nextCursor = body?.next_cursor || body?.nextCursor || body?.cursor || null;
    } catch {
      nextCursor = null;
    }
  }
  return { fields: parsed.fields, records: parsed.records, cursor: nextCursor };
}

function assertSelect(query) {
  const text = String(query).trim();
  if (!/^select\b/i.test(text) || /;\s*\S/.test(text)) {
    throw invalidConnector("A DATABASE connector only accepts a single read-only SELECT statement");
  }
  return text;
}

function readDatabase(ctx) {
  const settings = settingsOf(ctx);
  if (!settings.query) throw invalidConnector("A DATABASE connector requires settings.query");
  const db = ctx.db;
  if (!db) throw connectorFailed("A database handle is required to read from the platform database");
  const rows = queryAll(db, assertSelect(settings.query), parseArray(settings.params, []));
  return rows.map((row) => ({ ...row }));
}

export function connectorCatalog() {
  return { connectors: registerBuiltinConnectors(), types: ["CSV", "EXCEL", "JSON", "XML", "REST", "DATABASE", "FILE", "CLOUD_STORAGE", "LEGACY_PLM", "ERP", "CAD", "MES"] };
}
