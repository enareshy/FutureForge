// Shared parsing/serialization primitives used by the adapters.
import { parseFailed, serializeFailed, payloadTooLarge } from "./errors.js";
import { MAX_PAYLOAD_BYTES } from "./constants.js";
import { validateJsonSchema } from "./json-schema.js";

export function byteLength(source) {
  if (source === null || source === undefined) return 0;
  if (Buffer.isBuffer(source)) return source.length;
  return Buffer.byteLength(String(source), "utf8");
}

export function enforcePayloadLimit(source, limit = MAX_PAYLOAD_BYTES) {
  const size = byteLength(source);
  if (size > limit) throw payloadTooLarge(size, limit);
  return size;
}

export function parseJsonPayload(source, { limit = MAX_PAYLOAD_BYTES } = {}) {
  if (source && typeof source === "object") return source;
  enforcePayloadLimit(source, limit);
  try {
    return JSON.parse(String(source));
  } catch (error) {
    throw parseFailed(`Invalid JSON payload: ${error.message}`);
  }
}

export function serializeJsonPayload(value, { pretty = true } = {}) {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch (error) {
    throw serializeFailed(`Failed to serialize JSON: ${error.message}`);
  }
}

// Minimal RFC 4180-ish CSV reader with quoted-field support. Returns an array
// of row arrays.
export function parseCsv(text, { delimiter = ",", quote = '"', maxRows = 100000 } = {}) {
  const source = String(text ?? "");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === quote) {
        if (source[index + 1] === quote) {
          field += quote;
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === quote) {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > maxRows) throw parseFailed(`CSV exceeds the ${maxRows} row limit`);
    } else if (char === "\r") {
      // skip
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ""));
}

export function csvToRecords(text, { delimiter = ",", header = true } = {}) {
  const rows = parseCsv(text, { delimiter });
  if (rows.length === 0) return { columns: [], records: [] };
  const columns = header ? rows[0].map((entry) => String(entry).trim()) : rows[0].map((_, index) => `column_${index + 1}`);
  const dataRows = header ? rows.slice(1) : rows;
  const records = dataRows.map((cells) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column] = cells[index] !== undefined ? cells[index] : "";
    });
    return record;
  });
  return { columns, records };
}

export function serializeCsv(records, { columns = null, delimiter = "," } = {}) {
  const list = Array.isArray(records) ? records : [];
  const cols = columns && columns.length ? columns : [...new Set(list.flatMap((record) => Object.keys(record || {})))];
  const escapeCell = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /["\n\r,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [cols.map(escapeCell).join(delimiter)];
  for (const record of list) lines.push(cols.map((column) => escapeCell(record?.[column])).join(delimiter));
  return lines.join("\n");
}

export function validateAgainstJsonSchema(value, schema) {
  const errors = validateJsonSchema(value, schema);
  return { valid: errors.length === 0, errors };
}

export function sniffDelimiter(text) {
  const sample = String(text || "").slice(0, 4096);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export { validateJsonSchema };
