import { listEvents } from "./query.js";

// Audit export. Dependency-free CSV and SpreadsheetML (Excel 2003 XML, opened
// natively by Excel) generation over the same filtered event stream.

export const EXPORT_FORMATS = ["csv", "excel"];

export const EXPORT_COLUMNS = [
  { key: "id", label: "Event ID" },
  { key: "occurred_at", label: "Timestamp (UTC)" },
  { key: "tenant_id", label: "Tenant" },
  { key: "organization_id", label: "Organization" },
  { key: "actor_username", label: "User" },
  { key: "user_display_name", label: "Display name" },
  { key: "action", label: "Action" },
  { key: "event_type", label: "Type" },
  { key: "source", label: "Source" },
  { key: "object_type", label: "Object type" },
  { key: "object_id", label: "Object ID" },
  { key: "object_name", label: "Object name" },
  { key: "status", label: "Status" },
  { key: "changed_fields", label: "Changed fields" },
  { key: "reason", label: "Reason" },
  { key: "error_message", label: "Error" },
  { key: "ip", label: "IP address" },
  { key: "correlation_id", label: "Correlation ID" },
];

function cellValue(event, key) {
  const value = event[key];
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(items) {
  const header = EXPORT_COLUMNS.map((c) => csvCell(c.label)).join(",");
  const lines = items.map((event) =>
    EXPORT_COLUMNS.map((c) => csvCell(cellValue(event, c.key))).join(",")
  );
  return `\uFEFF${[header, ...lines].join("\r\n")}`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toExcelXml(items, title = "Audit events") {
  const headerCells = EXPORT_COLUMNS.map(
    (c) => `<Cell><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`
  ).join("");
  const rows = items
    .map((event) => {
      const cells = EXPORT_COLUMNS.map(
        (c) => `<Cell><Data ss:Type="String">${xmlEscape(cellValue(event, c.key))}</Data></Cell>`
      ).join("");
      return `<Row>${cells}</Row>`;
    })
    .join("");
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${xmlEscape(title).slice(0, 31)}">
  <Table>
   <Row>${headerCells}</Row>
   ${rows}
  </Table>
 </Worksheet>
</Workbook>`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function exportEvents(db, { filters = {}, scope = {}, format = "csv", limit = 10000 } = {}) {
  const normalized = String(format || "csv").toLowerCase();
  if (!EXPORT_FORMATS.includes(normalized)) {
    throw new Error(`Unsupported export format: ${format}`);
  }
  const pageSize = Math.min(5000, Math.max(1, Number(limit) || 10000));
  const { items, total } = listEvents(db, { ...filters, page: 1, pageSize, sort: "created_at", order: "desc" }, scope);
  const filename = `audit-events-${stamp()}.${normalized === "excel" ? "xls" : "csv"}`;
  const content = normalized === "excel" ? toExcelXml(items) : toCsv(items);
  return {
    filename,
    content,
    count: items.length,
    total,
    truncated: items.length < total,
    content_type:
      normalized === "excel"
        ? "application/vnd.ms-excel; charset=utf-8"
        : "text/csv; charset=utf-8",
  };
}
