// Built-in source adapters.
//
// They are deliberately dependency-free and data-driven. The generic extraction
// core understands four settings shapes that cover the vast majority of legacy
// onboarding sources:
//
//   settings.records        -> an inline array of already-extracted records
//   settings.content        -> serialized text parsed with a data-exchange codec
//   settings.table / query  -> a read-only SELECT against the platform database
//   settings.url            -> a paginated REST/JSON endpoint
//
// The legacy enterprise adapters (Teamcenter, PLM, PDM, ERP, MES, object
// storage) share that core and are extension seams: a deployment registers a
// provider with `registerSourceAdapter(..., { replace: true })` to back them
// with a real system adapter. Until then they fail closed with a clear,
// actionable error rather than silently returning nothing.
import { queryAll } from "../../../db.js";
import { requireConnector } from "../../data-exchange/connectors/registry.js";
import { adapterFailed, adapterUnsupported } from "../errors.js";
import { normalizeText, parseArray, parseObject } from "../validation.js";
import { registerSourceAdapter } from "./registry.js";

function settingsOf(ctx = {}) {
  return ctx.settings && typeof ctx.settings === "object" ? ctx.settings : {};
}

function inlineRecords(settings) {
  const records = settings.records ?? settings.snapshot ?? settings.data;
  if (Array.isArray(records)) return records;
  if (typeof records === "string" && records.trim()) {
    try {
      const parsed = JSON.parse(records);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function inferFields(records) {
  const names = new Set();
  for (const record of records.slice(0, 50)) {
    if (record && typeof record === "object") for (const key of Object.keys(record)) names.add(key);
  }
  return [...names].map((name) => ({ name, data_type: "string" }));
}

function limitRecords(records, ctx = {}) {
  const limit = Number(ctx.limit);
  if (Number.isFinite(limit) && limit >= 0) return records.slice(0, limit);
  return records;
}

async function extractFromContent(settings) {
  const format = String(settings.format || settings.content_type || "JSON").toUpperCase();
  const connectorCode = format === "CSV" || format === "JSON" || format === "XML" || format === "EXCEL" ? format : "JSON";
  let connector = null;
  try {
    connector = requireConnector(connectorCode);
  } catch {
    connector = null;
  }
  if (!connector) throw adapterUnsupported(connectorCode, "READ");
  const result = await connector.read({ settings, content: settings.content });
  return { fields: result.fields || inferFields(result.records || []), records: result.records || [] };
}

function extractFromDatabase(db, settings) {
  if (!db) throw adapterFailed("The DATABASE source adapter requires a database handle");
  const table = normalizeText(settings.table, { max: 120 });
  if (!table || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw adapterFailed("The DATABASE source adapter requires settings.table (a plain table name) or inline settings.records", { table });
  }
  const columns = Array.isArray(settings.columns) && settings.columns.length ? settings.columns.map((c) => normalizeText(c, { max: 120 })).join(", ") : "*";
  const orderBy = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(settings.order_by || "")) ? ` ORDER BY ${settings.order_by}` : "";
  const limit = Number(settings.limit || settings.page_size || 0) || 0;
  const sql = `SELECT ${columns} FROM ${table}${orderBy}${limit > 0 ? ` LIMIT ${Math.min(limit, 1000000)}` : ""}`;
  const records = queryAll(db, sql);
  return { fields: inferFields(records), records };
}

async function extractFromRest(settings) {
  const url = normalizeText(settings.url, { max: 2000 });
  if (!url) throw adapterFailed("The REST source adapter requires settings.url");
  if (typeof fetch !== "function") throw adapterFailed("This runtime does not provide fetch for the REST source adapter");
  const timeoutMs = Math.max(1000, Number(settings.timeout_seconds || 60) * 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json", ...(parseObject(settings.headers, {})) };
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw adapterFailed(`REST source returned HTTP ${response.status}`, { url, status: response.status });
    const payload = await response.json();
    const recordsPath = normalizeText(settings.records_path, { max: 200 });
    const records = recordsPath ? recordsPath.split(".").reduce((value, key) => (value == null ? null : value[key]), payload) : payload;
    if (!Array.isArray(records)) throw adapterFailed("The REST source response did not contain a records array", { url });
    return { fields: inferFields(records), records };
  } catch (error) {
    if (error.code) throw error;
    if (error.name === "AbortError") throw adapterFailed(`REST source timed out after ${timeoutMs}ms`, { url });
    throw adapterFailed(`REST source failed: ${error.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

// Generic extraction shared by every adapter. `allowNetwork` lets specialized
// adapters opt out of the REST fallback.
async function genericExtract(ctx, { allowNetwork = true } = {}) {
  const settings = settingsOf(ctx);
  const inline = inlineRecords(settings);
  if (inline) return { fields: inferFields(inline), records: limitRecords(inline, ctx) };
  if (typeof settings.content === "string" && settings.content.trim()) {
    const parsed = await extractFromContent(settings);
    return { fields: parsed.fields, records: limitRecords(parsed.records, ctx) };
  }
  if (settings.table) {
    const parsed = extractFromDatabase(ctx.db, settings);
    return { fields: parsed.fields, records: limitRecords(parsed.records, ctx) };
  }
  if (allowNetwork && settings.url) {
    const parsed = await extractFromRest(settings);
    return { fields: parsed.fields, records: limitRecords(parsed.records, ctx) };
  }
  const hints = parseArray(settings.records_source_tags, []);
  throw adapterFailed(
    `Source adapter ${ctx.adapterType || settings.adapter_type || ""} has no extractable source configured. Provide settings.records, settings.content, settings.table or settings.url.`,
    { record_source_tags: hints }
  );
}

function adapter({ adapter_type, name, description, capabilities, settings_schema = {}, allowNetwork = true }) {
  return {
    adapter_type,
    name,
    description,
    capabilities: capabilities || ["READ", "SCHEMA_DISCOVERY"],
    settings_schema,
    built_in: true,
    testConnection: (ctx) => {
      const settings = settingsOf(ctx);
      const hasSource = Boolean(inlineRecords(settings) || settings.content || settings.table || settings.url);
      return hasSource
        ? { ok: true, message: `${name} source is configured` }
        : { ok: false, message: `${name} source is not configured` };
    },
    discoverSchema: async (ctx) => {
      const result = await genericExtract({ ...ctx, adapterType: adapter_type, limit: ctx?.limit || 10 }, { allowNetwork });
      return { fields: result.fields, sample: result.records.slice(0, 10) };
    },
    extract: (ctx) => genericExtract({ ...ctx, adapterType: adapter_type }, { allowNetwork }),
  };
}

export function registerBuiltinSourceAdapters() {
  registerSourceAdapter(adapter({
    adapter_type: "DATABASE",
    name: "Database",
    description: "Extract records from a database table, a read-only query or an inline snapshot.",
    capabilities: ["READ", "SCHEMA_DISCOVERY", "STREAMING", "PAGINATION"],
    settings_schema: { table: "string", columns: "string[]", order_by: "string", limit: "number" },
  }));
  registerSourceAdapter(adapter({
    adapter_type: "FILE",
    name: "File export",
    description: "Extract records from a CSV/JSON/XML/Excel export produced by a legacy system.",
    capabilities: ["READ", "SCHEMA_DISCOVERY", "BINARY_FILES", "STREAMING"],
    settings_schema: { format: "string", content: "string", filename: "string" },
  }));
  registerSourceAdapter(adapter({
    adapter_type: "REST",
    name: "REST interface",
    description: "Extract records from a paginated legacy REST/JSON interface.",
    capabilities: ["READ", "SCHEMA_DISCOVERY", "PAGINATION", "INCREMENTAL"],
    settings_schema: { url: "string", headers: "object", records_path: "string", timeout_seconds: "number" },
  }));
  registerSourceAdapter(adapter({
    adapter_type: "OBJECT_STORAGE",
    name: "Object storage",
    description: "Extract records or file manifests from object storage.",
    capabilities: ["READ", "BINARY_FILES", "SCHEMA_DISCOVERY"],
    settings_schema: { content: "string", format: "string", manifest: "object[]" },
    allowNetwork: false,
  }));
  for (const [adapter_type, name, description] of [
    ["LEGACY_TEAMCENTER", "Legacy Teamcenter", "Onboard objects from a Teamcenter instance."],
    ["LEGACY_PLM", "Legacy PLM", "Onboard objects from a legacy PLM system."],
    ["PDM", "PDM", "Onboard objects from a product data management system."],
    ["ERP", "ERP", "Onboard objects from an ERP system."],
    ["MES", "MES", "Onboard objects from a manufacturing execution system."],
    ["CUSTOM", "Custom source", "Onboard objects from a deployment-specific source adapter."],
  ]) {
    registerSourceAdapter(adapter({
      adapter_type,
      name,
      description,
      capabilities: ["READ", "SCHEMA_DISCOVERY", "INCREMENTAL", "PAGINATION", "BINARY_FILES"],
      settings_schema: { records: "object[]", content: "string", table: "string", url: "string", format: "string" },
    }));
  }
  return sourceAdapterTypesCached();
}

function sourceAdapterTypesCached() {
  return ["DATABASE", "FILE", "REST", "OBJECT_STORAGE", "LEGACY_TEAMCENTER", "LEGACY_PLM", "PDM", "ERP", "MES", "CUSTOM"];
}
