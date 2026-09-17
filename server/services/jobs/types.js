import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import {
  assertJobTypeCode,
  assertPriority,
  assertQueue,
  normalizeMaxRetries,
  safeParse,
} from "./validation.js";

// Job type registry. Business modules register the asynchronous work they own
// (Bulk Import, CAD Processing, BOM Validation, Report Generation, Data Sync,
// Search Indexing, Workflow, Integrations, ...). This registry stores metadata
// and the handler reference only: it never executes a handler. The Job
// Scheduling & Execution Engine resolves `handler` + `queues_json` to run work.

const DEFAULT_TYPES = [
  {
    code: "BULK_IMPORT",
    name: "Bulk data import",
    description: "Import large record sets from an uploaded file into the platform.",
    source_module: "bulk-import",
    handler: "jobs.bulkImport",
    queues: ["imports", "default"],
    timeout_seconds: 3600,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "CAD_PROCESSING",
    name: "CAD processing",
    description: "Convert, tessellate and extract metadata from CAD models.",
    source_module: "cad",
    handler: "jobs.cadProcessing",
    queues: ["math", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_VALIDATION",
    name: "BOM validation",
    description: "Validate bill-of-material structures, cycles and references.",
    source_module: "bom",
    handler: "jobs.bomValidation",
    queues: ["default"],
    timeout_seconds: 900,
    max_retries: 1,
    default_priority: "high",
  },
  {
    code: "REPORT_GENERATION",
    name: "Report generation",
    description: "Render a report document and store the produced artifact.",
    source_module: "reports",
    handler: "jobs.reportGeneration",
    queues: ["reports", "default"],
    timeout_seconds: 1200,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_SYNC",
    name: "Data synchronization",
    description: "Synchronize records with an external system or data source.",
    source_module: "integrations",
    handler: "jobs.dataSync",
    queues: ["integrations", "default"],
    timeout_seconds: 1800,
    max_retries: 3,
    default_priority: "normal",
  },
  {
    code: "SEARCH_INDEXING",
    name: "Search indexing",
    description: "Reindex documents and objects for full-text search.",
    source_module: "search",
    handler: "jobs.searchIndexing",
    queues: ["default"],
    timeout_seconds: 900,
    max_retries: 2,
    default_priority: "low",
  },
  {
    code: "WORKFLOW_EXECUTION",
    name: "Workflow execution",
    description: "Advance a workflow instance through long-running steps.",
    source_module: "workflow",
    handler: "jobs.workflowExecution",
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 0,
    default_priority: "high",
  },
  {
    code: "INTEGRATION_SYNC",
    name: "Integration sync",
    description: "Push or pull records through a configured integration.",
    source_module: "integrations",
    handler: "jobs.integrationSync",
    queues: ["integrations", "default"],
    timeout_seconds: 1800,
    max_retries: 3,
    default_priority: "normal",
  },
  {
    code: "FILE_VIRUS_SCAN",
    name: "File virus scan",
    description: "Scan a stored file version for malware before it is released.",
    source_module: "files",
    handler: "files.virusScan",
    queues: ["default"],
    timeout_seconds: 900,
    max_retries: 2,
    default_priority: "high",
  },
  {
    code: "FILE_PREVIEW_GENERATION",
    name: "File preview generation",
    description: "Generate preview and rendition derivatives for a stored file version.",
    source_module: "files",
    handler: "files.previewGeneration",
    queues: ["default"],
    timeout_seconds: 900,
    max_retries: 2,
    default_priority: "normal",
  },
];

export function publicJobType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    source_module: row.source_module || "platform",
    handler: row.handler || "",
    queues: safeParse(row.queues_json, ["default"]),
    required_permissions: safeParse(row.required_permissions_json, []),
    timeout_seconds: row.timeout_seconds,
    max_retries: row.max_retries,
    default_priority: row.default_priority,
    retry_policy: safeParse(row.retry_policy_json, {}),
    active: row.active === 1,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeQueues(value, fallback = ["default"]) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : fallback;
  const queues = [...new Set(list.map((queue) => String(queue || "").trim()).filter(Boolean))];
  const safe = queues.length ? queues : ["default"];
  safe.forEach((queue) => assertQueue(queue));
  return safe;
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((code) => String(code || "").trim()).filter(Boolean).slice(0, 50);
}

export function getJobTypeRow(db, code) {
  const row = queryOne(db, "SELECT * FROM job_types WHERE code = ? COLLATE NOCASE", [String(code || "")]);
  return row || null;
}

export function getJobType(db, code) {
  const row = getJobTypeRow(db, code);
  if (!row) throw new HttpError(404, "Job type not found");
  return publicJobType(row);
}

export function listJobTypes(db, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.active !== undefined && query.active !== "") {
    where.push("active = ?");
    params.push(query.active === "true" || query.active === true || query.active === 1 ? 1 : 0);
  }
  if (query.module || query.source_module || query.sourceModule) {
    where.push("source_module = ?");
    params.push(query.module || query.source_module || query.sourceModule);
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_types ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM job_types ${clause} ORDER BY source_module, code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicJobType);
  return { items, total, page, pageSize };
}

export function createJobType(db, input = {}, actor = null, ip = null) {
  const code = String(input.code || "").trim().toUpperCase();
  assertJobTypeCode(code);
  if (getJobTypeRow(db, code)) throw new HttpError(409, `Job type ${code} already exists`);
  const priority = input.default_priority || input.defaultPriority || "normal";
  assertPriority(priority);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO job_types
       (code, name, description, source_module, handler, queues_json, required_permissions_json,
        timeout_seconds, max_retries, default_priority, retry_policy_json, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      String(input.name || code),
      String(input.description || ""),
      String(input.source_module || input.sourceModule || "platform"),
      String(input.handler || ""),
      JSON.stringify(normalizeQueues(input.queues)),
      JSON.stringify(normalizePermissions(input.required_permissions || input.requiredPermissions)),
      Math.max(0, Number(input.timeout_seconds ?? input.timeoutSeconds ?? 0) || 0),
      normalizeMaxRetries(input.max_retries ?? input.maxRetries, 0),
      priority,
      JSON.stringify(input.retry_policy || input.retryPolicy || {}),
      input.active === false ? 0 : 1,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "jobs.type.create",
    resourceType: "job_type",
    resourceId: result.lastInsertRowid,
    details: { code, source_module: input.source_module || input.sourceModule || "platform" },
    ip,
  });
  return publicJobType(getJobTypeRow(db, code));
}

export function updateJobType(db, code, input = {}, actor = null, ip = null) {
  const row = getJobTypeRow(db, code);
  if (!row) throw new HttpError(404, "Job type not found");
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (input.name !== undefined) set("name", String(input.name));
  if (input.description !== undefined) set("description", String(input.description));
  if (input.source_module !== undefined || input.sourceModule !== undefined) {
    set("source_module", String(input.source_module ?? input.sourceModule));
  }
  if (input.handler !== undefined) set("handler", String(input.handler));
  if (input.queues !== undefined) set("queues_json", JSON.stringify(normalizeQueues(input.queues)));
  if (input.required_permissions !== undefined || input.requiredPermissions !== undefined) {
    set("required_permissions_json", JSON.stringify(normalizePermissions(input.required_permissions ?? input.requiredPermissions)));
  }
  if (input.timeout_seconds !== undefined || input.timeoutSeconds !== undefined) {
    set("timeout_seconds", Math.max(0, Number(input.timeout_seconds ?? input.timeoutSeconds) || 0));
  }
  if (input.max_retries !== undefined || input.maxRetries !== undefined) {
    set("max_retries", normalizeMaxRetries(input.max_retries ?? input.maxRetries, row.max_retries));
  }
  if (input.default_priority !== undefined || input.defaultPriority !== undefined) {
    const priority = input.default_priority ?? input.defaultPriority;
    assertPriority(priority);
    set("default_priority", priority);
  }
  if (input.retry_policy !== undefined || input.retryPolicy !== undefined) {
    set("retry_policy_json", JSON.stringify(input.retry_policy ?? input.retryPolicy ?? {}));
  }
  if (input.active !== undefined) set("active", input.active ? 1 : 0);
  if (!fields.length) return publicJobType(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE job_types SET ${fields.join(", ")} WHERE id = ?`, params);
  writeAudit(db, { actor, action: "jobs.type.update", resourceType: "job_type", resourceId: row.id, details: { code: row.code }, ip });
  return publicJobType(getJobTypeRow(db, row.code));
}

export function setJobTypeStatus(db, code, active, actor = null, ip = null) {
  const row = getJobTypeRow(db, code);
  if (!row) throw new HttpError(404, "Job type not found");
  run(db, "UPDATE job_types SET active = ?, updated_at = ? WHERE id = ?", [active ? 1 : 0, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: active ? "jobs.type.activate" : "jobs.type.deactivate",
    resourceType: "job_type",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return publicJobType(getJobTypeRow(db, row.code));
}

// Inserts the standard enterprise job types once. Safe to call on every seed.
export function ensureDefaultJobTypes(db) {
  let created = 0;
  for (const def of DEFAULT_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    const ts = nowIso();
    run(
      db,
      `INSERT INTO job_types
         (code, name, description, source_module, handler, queues_json, required_permissions_json,
          timeout_seconds, max_retries, default_priority, retry_policy_json, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '{}', 1, NULL, ?, ?)`,
      [
        def.code,
        def.name,
        def.description,
        def.source_module,
        def.handler,
        JSON.stringify(def.queues),
        def.timeout_seconds,
        def.max_retries,
        def.default_priority,
        ts,
        ts,
      ]
    );
    created += 1;
  }
  return { created };
}

export { DEFAULT_TYPES };
