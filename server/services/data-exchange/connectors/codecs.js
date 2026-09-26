// Dependency-free codecs for the text-based interchange formats the framework
// supports out of the box: CSV, JSON/NDJSON, XML and SpreadsheetML 2003 (the
// XML spreadsheet format Excel opens natively). Binary formats (Parquet, PDF)
// are registered as provider extension points instead of being faked here.
//
// Codec interface:
//   parse(content, options)            -> { fields: [{ name, data_type }], records: [obj] }
//   serialize(records, fields, options) -> { content, content_type, extension }

// ── Shared helpers ───────────────────────────────────────────────────────────

export function inferDataType(value) {
  if (value === null || value === undefined || value === "") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) return "integer";
  if (/^-?\d*\.\d+$/.test(text)) return "number";
  if (/^-?\d{4}-\d{2}-\d{2}(T.*)?$/.test(text)) return "datetime";
  if (/^(true|false)$/i.test(text)) return "boolean";
  return "string";
}

export function inferFields(records = []) {
  const seen = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const [key, value] of Object.entries(record)) {
      if (!seen.has(key)) seen.set(key, { name: key, data_type: inferDataType(value) });
    }
  }
  return [...seen.values()];
}

function scalarize(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ── CSV (RFC 4180) ───────────────────────────────────────────────────────────

export function parseCsv(content, { delimiter = ",", quote = '"', hasHeader = true } = {}) {
  const text = String(content ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i += 1;
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
    } else if (char === "\r") {
      // swallow; handled by \n
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((entry) => !(entry.length === 1 && entry[0] === ""));
  if (nonEmpty.length === 0) return { fields: [], records: [] };
  const header = hasHeader ? nonEmpty[0].map((name, index) => name || `column_${index + 1}`) : null;
  const dataRows = hasHeader ? nonEmpty.slice(1) : nonEmpty;
  const records = dataRows.map((cells) =>
    Object.fromEntries(cells.map((cell, index) => [header ? header[index] : `column_${index + 1}`, cell]))
  );
  return { fields: inferFields(records), records };
}

export function serializeCsv(records = [], fields = null, { delimiter = ",", quote = '"', includeHeader = true } = {}) {
  const columns = (fields && fields.length ? fields.map((field) => (typeof field === "string" ? field : field.name)) : Object.keys(records[0] || {}));
  const escape = (value) => {
    const text = scalarize(value);
    if (text.includes(delimiter) || text.includes(quote) || /[\r\n]/.test(text)) {
      return `${quote}${text.split(quote).join(quote + quote)}${quote}`;
    }
    return text;
  };
  const lines = [];
  if (includeHeader) lines.push(columns.map(escape).join(delimiter));
  for (const record of records) lines.push(columns.map((column) => escape(record?.[column])).join(delimiter));
  return { content: lines.join("\n"), content_type: "text/csv; charset=utf-8", extension: "csv" };
}

// ── JSON / NDJSON ────────────────────────────────────────────────────────────

export function parseJson(content, { ndjson = false, recordsPath = null } = {}) {
  const text = String(content ?? "").trim();
  if (!text) return { fields: [], records: [] };
  let records;
  if (ndjson) {
    records = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } else {
    let parsed = JSON.parse(text);
    if (recordsPath) {
      for (const segment of String(recordsPath).split(".")) {
        parsed = parsed?.[segment];
      }
    } else if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const arrayKey = Object.keys(parsed).find((key) => Array.isArray(parsed[key]));
      if (arrayKey) parsed = parsed[arrayKey];
    }
    records = Array.isArray(parsed) ? parsed : [parsed];
  }
  return { fields: inferFields(records), records };
}

export function serializeJson(records = [], _fields = null, { ndjson = false, pretty = true } = {}) {
  if (ndjson) {
    return { content: records.map((record) => JSON.stringify(record)).join("\n"), content_type: "application/x-ndjson", extension: "ndjson" };
  }
  return {
    content: JSON.stringify(records, null, pretty ? 2 : 0),
    content_type: "application/json; charset=utf-8",
    extension: "json",
  };
}

// ── XML ──────────────────────────────────────────────────────────────────────

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

export function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseXmlTree(xml) {
  // Minimal, namespace-agnostic parser good enough for interchange documents.
  // It is not a validating XML parser and is only used on trusted import content.
  const root = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g;
  let match;
  while ((match = tokenRe.exec(String(xml ?? "")))) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      while (stack.length > 1) {
        const node = stack.pop();
        if (node.name === name) break;
      }
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/>$/.test(token);
      const inner = token.slice(1, selfClosing ? -2 : -1).trim();
      const spaceIndex = inner.search(/\s/);
      const name = spaceIndex === -1 ? inner : inner.slice(0, spaceIndex);
      const attrText = spaceIndex === -1 ? "" : inner.slice(spaceIndex + 1);
      const attributes = {};
      const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let attrMatch;
      while ((attrMatch = attrRe.exec(attrText))) attributes[attrMatch[1]] = unescapeXml(attrMatch[3] ?? attrMatch[4] ?? "");
      const node = { name, attributes, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    stack[stack.length - 1].text += unescapeXml(token);
  }
  return root;
}

// Convert a node to a plain JS value: object when it has child elements, else
// the trimmed text. Repeated children collapse into arrays.
export function xmlNodeToValue(node) {
  if (!node.children || node.children.length === 0) return node.text.trim();
  const result = {};
  for (const child of node.children) {
    const value = xmlNodeToValue(child);
    if (child.name in result) {
      if (!Array.isArray(result[child.name])) result[child.name] = [result[child.name]];
      result[child.name].push(value);
    } else {
      result[child.name] = value;
    }
  }
  return result;
}

function findRecordNodes(root, recordPath) {
  if (recordPath) {
    let nodes = root.children;
    for (const segment of String(recordPath).split(".")) {
      const next = [];
      for (const node of nodes) next.push(...node.children.filter((child) => child.name === segment));
      nodes = next;
    }
    return nodes;
  }
  // Auto-detect: the deepest repeated sibling set wins.
  let best = [];
  const walk = (node) => {
    const counts = new Map();
    for (const child of node.children) counts.set(child.name, (counts.get(child.name) || 0) + 1);
    for (const [name, count] of counts) {
      if (count > 1) {
        const siblings = node.children.filter((child) => child.name === name);
        if (siblings.length > best.length) best = siblings;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  if (best.length === 0 && root.children.length === 1) return root.children[0].children;
  return best;
}

export function parseXml(content, { recordPath = null } = {}) {
  const tree = parseXmlTree(content);
  const nodes = findRecordNodes(tree, recordPath);
  const records = nodes.map((node) => xmlNodeToValue(node));
  return { fields: inferFields(records), records };
}

export function serializeXml(records = [], fields = null, { rootName = "records", recordName = "record" } = {}) {
  const columns = fields && fields.length ? fields.map((field) => (typeof field === "string" ? field : field.name)) : Object.keys(records[0] || {});
  const rows = records.map((record) => {
    const cells = columns.map((column) => {
      const value = record?.[column];
      if (value !== null && value !== undefined && typeof value === "object") {
        return `    <${column}>${serializeXml([value], Object.keys(value).map((name) => ({ name })))}</${column}>`;
      }
      return `    <${column}>${escapeXml(scalarize(value))}</${column}>`;
    });
    return `  <${recordName}>\n${cells.join("\n")}\n  </${recordName}>`;
  });
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>\n${rows.join("\n")}\n</${rootName}>`;
  return { content, content_type: "application/xml; charset=utf-8", extension: "xml" };
}

// ── SpreadsheetML 2003 (Excel-readable XML) ──────────────────────────────────

export function parseSpreadsheet(content) {
  const tree = parseXmlTree(content);
  const rows = [];
  const findRows = (node) => {
    if (node.name === "Row") rows.push(node);
    for (const child of node.children) findRows(child);
  };
  findRows(tree);
  const matrix = rows.map((row) =>
    row.children
      .filter((child) => child.name === "Cell")
      .map((cell) => {
        const data = cell.children.find((child) => child.name === "Data");
        return data ? data.text.trim() : cell.text.trim();
      })
  );
  if (matrix.length === 0) return { fields: [], records: [] };
  const header = matrix[0].map((name, index) => name || `column_${index + 1}`);
  const records = matrix.slice(1).map((cells) => Object.fromEntries(cells.map((cell, index) => [header[index], cell])));
  return { fields: inferFields(records), records };
}

export function serializeSpreadsheet(records = [], fields = null, { sheetName = "Sheet1" } = {}) {
  const columns = fields && fields.length ? fields.map((field) => (typeof field === "string" ? field : field.name)) : Object.keys(records[0] || {});
  const cell = (value) =>
    value === null || value === undefined || value === ""
      ? "<Cell/>"
      : `<Cell><Data ss:Type="String">${escapeXml(scalarize(value))}</Data></Cell>`;
  const row = (cells) => `      <Row>${cells.map(cell).join("")}</Row>`;
  const body = [row(columns), ...records.map((record) => row(columns.map((column) => record?.[column])))].join("\n");
  const content = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n  <Worksheet ss:Name="${escapeXml(sheetName)}">\n    <Table>\n${body}\n    </Table>\n  </Worksheet>\n</Workbook>`;
  return { content, content_type: "application/vnd.ms-excel", extension: "xls" };
}
