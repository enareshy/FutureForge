// EffectivityService — reusable effectivity definitions, structured values and
// assignments to concrete targets (object / revision / version).
//
// Definitions are deliberately data-driven: a new effectivity type or dimension
// is configuration, never a code change. Overlap and range validation live here
// so every caller shares the same rules.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { writeAudit } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import {
  publicDefinition,
  publicValue,
  publicAssignment,
  publicEffectivityType,
  normalizeText,
  safeParse,
  DIMENSIONS,
  BOUNDARIES,
  SERIAL_MODES,
  ASSIGNMENT_ROLES,
  validateRange,
  rangesOverlap,
  serialRangesOverlap,
  withinDateRange,
  withinSerialRange,
} from "./validation.js";
import { definitionRef, assignmentRef } from "./refs.js";
import {
  invalidEffectivity,
  invalidSerialRange,
  effectivityOverlap,
  revisionNotFound,
  invalidRelationship,
} from "./errors.js";

const TARGET_KINDS = ["object", "revision", "version"];

export function listEffectivityTypes(db, { dimension, status } = {}) {
  const clauses = [];
  const params = [];
  if (dimension) {
    clauses.push("dimension = ?");
    params.push(String(dimension));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryAll(db, `SELECT * FROM versioning_effectivity_types ${where} ORDER BY dimension, code`, params).map(publicEffectivityType);
}

export function effectivityType(db, code) {
  return queryOne(db, "SELECT * FROM versioning_effectivity_types WHERE code = ?", [String(code)]);
}

function valuesFor(db, definitionId) {
  return queryAll(db, "SELECT * FROM versioning_effectivity_values WHERE definition_id = ? ORDER BY dimension, id", [
    definitionId,
  ]);
}

export function getDefinitionRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE definition_ref = ? OR code = ?", [
    String(ref),
    String(ref),
  ]);
}

export function getDefinition(db, ref) {
  const row = getDefinitionRow(db, ref);
  if (!row) throw invalidEffectivity(`Effectivity definition not found: ${ref}`, { notFound: true });
  return publicDefinition(row, valuesFor(db, row.id));
}

function requireDefinitionRow(db, ref) {
  const row = getDefinitionRow(db, ref);
  if (!row) throw invalidEffectivity(`Effectivity definition not found: ${ref}`, { notFound: true });
  return row;
}

export function listDefinitions(db, { dimension, typeCode, status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (dimension) {
    clauses.push("dimension = ?");
    params.push(String(dimension));
  }
  if (typeCode) {
    clauses.push("type_code = ?");
    params.push(String(typeCode));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_effectivity_definitions WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(
    db,
    `SELECT * FROM versioning_effectivity_definitions WHERE ${where} ORDER BY dimension, priority, code LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    items: rows.map((row) => publicDefinition(row, valuesFor(db, row.id))),
    total,
    page: Number(page) || 1,
    page_size: limit,
  };
}

function validateDefinitionInput(input = {}, { partial = false } = {}) {
  const errors = [];
  const dimension = normalizeText(input.dimension);
  const typeCode = normalizeText(input.typeCode ?? input.type_code);
  const code = normalizeText(input.code);
  if (!partial) {
    if (!code) errors.push("code is required");
    if (!dimension) errors.push("dimension is required");
    if (!typeCode) errors.push("typeCode is required");
  }
  if (dimension && !DIMENSIONS.includes(dimension)) errors.push(`dimension must be one of: ${DIMENSIONS.join(", ")}`);
  const boundary = input.boundary ?? "inclusive";
  if (!BOUNDARIES.includes(boundary)) errors.push(`boundary must be one of: ${BOUNDARIES.join(", ")}`);
  const serialMode = input.serialMode ?? input.serial_mode ?? "numeric";
  if (!SERIAL_MODES.includes(serialMode)) errors.push(`serialMode must be one of: ${SERIAL_MODES.join(", ")}`);
  validateRange({
    from: input.effectiveFrom ?? input.effective_from,
    to: input.effectiveTo ?? input.effective_to,
    field: "effective",
    errors,
  });
  validateRange({
    from: input.serialFrom ?? input.serial_from,
    to: input.serialTo ?? input.serial_to,
    field: "serial",
    errors,
    useSerial: true,
    mode: serialMode,
  });
  const priority = input.priority === undefined ? 100 : Number(input.priority);
  if (!Number.isFinite(priority) || priority < 0) errors.push("priority must be a non-negative number");
  if (errors.length) {
    const serialRelated = errors.some((e) => e.toLowerCase().startsWith("serial"));
    if (serialRelated && errors.length === 1) throw invalidSerialRange(errors[0], { errors });
    throw invalidEffectivity(errors.join("; "), { errors });
  }
  return {
    code,
    dimension,
    typeCode,
    boundary,
    serialMode,
    priority,
    effectiveFrom: normalizeText(input.effectiveFrom ?? input.effective_from) || null,
    effectiveTo: normalizeText(input.effectiveTo ?? input.effective_to) || null,
    serialFrom: normalizeText(input.serialFrom ?? input.serial_from) || null,
    serialTo: normalizeText(input.serialTo ?? input.serial_to) || null,
  };
}

function normalizeValues(input, definition) {
  const explicit = input.values ?? input.effectivityValues;
  const rows = [];
  if (Array.isArray(explicit)) {
    for (const value of explicit) {
      const dim = normalizeText(value.dimension) || definition.dimension;
      const text = normalizeText(value.value);
      if (!text) continue;
      rows.push({
        dimension: DIMENSIONS.includes(dim) ? dim : definition.dimension,
        value: text,
        operator: value.operator === "exclude" ? "exclude" : "include",
        value_type: normalizeText(value.valueType ?? value.value_type, "string"),
      });
    }
  }
  const include = input.include;
  const exclude = input.exclude;
  if (Array.isArray(include)) {
    for (const value of include) {
      const text = normalizeText(value);
      if (text) rows.push({ dimension: definition.dimension, value: text, operator: "include", value_type: "string" });
    }
  }
  if (Array.isArray(exclude)) {
    for (const value of exclude) {
      const text = normalizeText(value);
      if (text) rows.push({ dimension: definition.dimension, value: text, operator: "exclude", value_type: "string" });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.dimension}|${row.operator}|${row.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function replaceValues(db, definitionId, rows) {
  run(db, "DELETE FROM versioning_effectivity_values WHERE definition_id = ?", [definitionId]);
  for (const row of rows) {
    run(
      db,
      `INSERT OR IGNORE INTO versioning_effectivity_values (definition_id, dimension, value, operator, value_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [definitionId, row.dimension, row.value, row.operator, row.value_type, nowIso()]
    );
  }
}

function includeExcludeFromValues(rows) {
  const include = rows.filter((r) => r.operator === "include").map((r) => r.value);
  const exclude = rows.filter((r) => r.operator === "exclude").map((r) => r.value);
  return { include, exclude };
}

// Overlap is prohibited only when two effectivity definitions of the same
// dimension are attached to the SAME target revision/version: reusable
// definitions and revisions of different objects are free to share ranges.
// Overlap across different revisions is legitimate and surfaces as a
// resolution CONFLICT rather than an assignment error.
function assertNoAssignmentOverlap(db, { objectType, objectId, revisionId, versionId, definition }) {
  if (!definition || definition.overlap_allowed) return;
  const hasRange =
    definition.effective_from || definition.effective_to || definition.serial_from || definition.serial_to;
  if (!hasRange) return;
  const siblings = queryAll(
    db,
    `SELECT d.* FROM versioning_effectivity_assignments a
     JOIN versioning_effectivity_definitions d ON d.id = a.definition_id
     WHERE a.status = 'active' AND d.status = 'active'
       AND a.object_type = ? AND a.object_id = ?
       AND COALESCE(a.revision_id, 0) = COALESCE(?, 0)
       AND COALESCE(a.version_id, 0) = COALESCE(?, 0)
       AND d.dimension = ? AND d.overlap_allowed = 0 AND d.id != ?`,
    [objectType, objectId, revisionId ?? null, versionId ?? null, definition.dimension, definition.id]
  );
  for (const sibling of siblings) {
    let overlap = false;
    if ((definition.serial_from || definition.serial_to) && (sibling.serial_from || sibling.serial_to)) {
      overlap = serialRangesOverlap(
        definition.serial_from,
        definition.serial_to,
        sibling.serial_from,
        sibling.serial_to,
        definition.serial_mode
      );
    }
    if (!overlap && (definition.effective_from || definition.effective_to) && (sibling.effective_from || sibling.effective_to)) {
      overlap = rangesOverlap(definition.effective_from, definition.effective_to, sibling.effective_from, sibling.effective_to);
    }
    if (overlap) {
      throw effectivityOverlap({
        definition: definition.code ?? definition.definition_ref,
        conflicts_with: sibling.code,
        dimension: definition.dimension,
      });
    }
  }
}

export function createDefinition(db, input = {}, actor = null, tenantId = null, ip = null) {
  const data = validateDefinitionInput(input);
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_effectivity_definitions WHERE code = ? AND (tenant_id IS NULL OR ? IS NULL OR tenant_id = ?)",
      [data.code, tenantId, tenantId]
    );
    if (existing) throw invalidEffectivity(`Effectivity definition ${data.code} already exists`);
    const type = effectivityType(db, data.typeCode);
    const ts = nowIso();
    const row = {
      definition_ref: definitionRef(data.code),
      code: data.code,
      name: normalizeText(input.name, data.code),
      description: normalizeText(input.description),
      type_code: data.typeCode,
      dimension: data.dimension,
      effective_from: data.effectiveFrom,
      effective_to: data.effectiveTo,
      boundary: data.boundary,
      serial_from: data.serialFrom,
      serial_to: data.serialTo,
      serial_mode: data.serialMode,
      revision_id: input.revisionId ?? input.revision_id ?? null,
      configuration_context_id: input.configurationContextId ?? input.configuration_context_id ?? null,
      include_json: "[]",
      exclude_json: "[]",
      priority: data.priority,
      overlap_allowed: input.overlapAllowed === true || input.overlap_allowed === true ? 1 : 0,
      status: input.status === "inactive" ? "inactive" : "active",
      tenant_id: input.tenantId ?? input.tenant_id ?? tenantId,
      organization_id: input.organizationId ?? input.organization_id ?? null,
      created_by: actor?.id ?? null,
      updated_by: actor?.id ?? null,
    };
    if (!type) {
      run(
        db,
        `INSERT INTO versioning_effectivity_types (code, name, dimension, value_mode, description, system, status, created_at, updated_at)
         VALUES (?, ?, ?, 'scalar', '', 0, 'active', ?, ?)`,
        [data.typeCode, data.typeCode, data.dimension, ts, ts]
      );
    }
    const values = normalizeValues(input, row);
    const { include, exclude } = includeExcludeFromValues(values);
    if (values.length && !include.length && !exclude.length) {
      throw invalidEffectivity("At least one effectivity value is required");
    }
    const result = run(
      db,
      `INSERT INTO versioning_effectivity_definitions
        (definition_ref, code, name, description, type_code, dimension, effective_from, effective_to, boundary,
         serial_from, serial_to, serial_mode, revision_id, configuration_context_id, include_json, exclude_json,
         priority, overlap_allowed, status, tenant_id, organization_id, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        row.definition_ref,
        row.code,
        row.name,
        row.description,
        row.type_code,
        row.dimension,
        row.effective_from,
        row.effective_to,
        row.boundary,
        row.serial_from,
        row.serial_to,
        row.serial_mode,
        row.revision_id,
        row.configuration_context_id,
        JSON.stringify(include),
        JSON.stringify(exclude),
        row.priority,
        row.overlap_allowed,
        row.status,
        row.tenant_id,
        row.organization_id,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    replaceValues(db, id, values);
    const created = queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.effectivity.create",
      resourceType: "versioning_effectivity_definition",
      resourceId: id,
      details: { code: row.code, dimension: row.dimension, type: row.type_code },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "EffectivityCreated",
        source_module: "versioning",
        source_object_type: "versioning_effectivity_definition",
        source_object_id: id,
        tenant_id: created.tenant_id,
        payload: { definition_id: id, code: created.code, dimension: created.dimension, type_code: created.type_code },
      },
      actor
    );
    return publicDefinition(created, valuesFor(db, id));
  });
}

export function updateDefinition(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireDefinitionRow(db, ref);
  validateDefinitionInput({ ...publicDefinition(row), ...patch }, { partial: true });
  return transaction(db, () => {
    const fields = [];
    const params = [];
    const set = (column, value) => {
      fields.push(`${column} = ?`);
      params.push(value);
    };
    for (const [camel, snake] of [
      ["name", "name"],
      ["description", "description"],
      ["boundary", "boundary"],
      ["status", "status"],
    ]) {
      if (patch[camel] !== undefined) set(snake, patch[camel]);
    }
    if (patch.priority !== undefined) set("priority", Number(patch.priority));
    if (patch.effectiveFrom !== undefined || patch.effective_from !== undefined) {
      set("effective_from", normalizeText(patch.effectiveFrom ?? patch.effective_from) || null);
    }
    if (patch.effectiveTo !== undefined || patch.effective_to !== undefined) {
      set("effective_to", normalizeText(patch.effectiveTo ?? patch.effective_to) || null);
    }
    if (patch.serialFrom !== undefined || patch.serial_from !== undefined) {
      set("serial_from", normalizeText(patch.serialFrom ?? patch.serial_from) || null);
    }
    if (patch.serialTo !== undefined || patch.serial_to !== undefined) {
      set("serial_to", normalizeText(patch.serialTo ?? patch.serial_to) || null);
    }
    if (patch.serialMode !== undefined || patch.serial_mode !== undefined) {
      set("serial_mode", patch.serialMode ?? patch.serial_mode);
    }
    if (patch.overlapAllowed !== undefined || patch.overlap_allowed !== undefined) {
      set("overlap_allowed", patch.overlapAllowed === true || patch.overlap_allowed === true ? 1 : 0);
    }
    if (patch.revisionId !== undefined || patch.revision_id !== undefined) {
      set("revision_id", patch.revisionId ?? patch.revision_id ?? null);
    }
    if (patch.configurationContextId !== undefined || patch.configuration_context_id !== undefined) {
      set("configuration_context_id", patch.configurationContextId ?? patch.configuration_context_id ?? null);
    }
    if (patch.values !== undefined || patch.include !== undefined || patch.exclude !== undefined) {
      const values = normalizeValues(patch, publicDefinition(row));
      replaceValues(db, row.id, values);
      const { include, exclude } = includeExcludeFromValues(values);
      set("include_json", JSON.stringify(include));
      set("exclude_json", JSON.stringify(exclude));
    }
    if (fields.length) {
      set("updated_by", actor?.id ?? null);
      set("version", Number(row.version) + 1);
      set("updated_at", nowIso());
      run(db, `UPDATE versioning_effectivity_definitions SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
    }
    const updated = queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE id = ?", [row.id]);
    writeAudit(db, {
      actor,
      action: "versioning.effectivity.update",
      resourceType: "versioning_effectivity_definition",
      resourceId: row.id,
      details: { code: row.code },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "EffectivityChanged",
        source_module: "versioning",
        source_object_type: "versioning_effectivity_definition",
        source_object_id: row.id,
        tenant_id: updated.tenant_id,
        payload: { definition_id: row.id, code: updated.code },
      },
      actor
    );
    return publicDefinition(updated, valuesFor(db, row.id));
  });
}

export function deleteDefinition(db, ref, actor = null, ip = null) {
  const row = requireDefinitionRow(db, ref);
  const count = queryOne(db, "SELECT COUNT(*) AS c FROM versioning_effectivity_assignments WHERE definition_id = ?", [row.id]);
  run(db, "DELETE FROM versioning_effectivity_assignments WHERE definition_id = ?", [row.id]);
  run(db, "DELETE FROM versioning_effectivity_values WHERE definition_id = ?", [row.id]);
  run(db, "DELETE FROM versioning_effectivity_definitions WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.effectivity.delete",
    resourceType: "versioning_effectivity_definition",
    resourceId: row.id,
    details: { code: row.code, assignments_removed: Number(count?.c ?? 0) },
    ip,
  });
  return { deleted: true, id: row.id, assignments_removed: Number(count?.c ?? 0) };
}

// ── Assignments ─────────────────────────────────────────────────────────────

export function inferAssignmentKind(input = {}) {
  if (input.versionId ?? input.version_id) return "version";
  if (input.revisionId ?? input.revision_id) return "revision";
  return "object";
}

function assignmentTargets(row) {
  const kinds = [];
  if (row.version_id) kinds.push("version");
  if (row.revision_id) kinds.push("revision");
  if (row.object_id) kinds.push("object");
  return kinds;
}

export function listAssignments(db, { objectType, objectId, definitionId, revisionId, status, tenantId } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType));
  }
  if (objectId) {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (definitionId) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  if (revisionId) {
    clauses.push("revision_id = ?");
    params.push(Number(revisionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  const rows = queryAll(
    db,
    `SELECT * FROM versioning_effectivity_assignments WHERE ${clauses.join(" AND ")} ORDER BY precedence, id`,
    params
  );
  return rows.map(publicAssignment);
}

export function getAssignment(db, ref) {
  const row = queryOne(db, "SELECT * FROM versioning_effectivity_assignments WHERE assignment_ref = ? OR id = ?", [
    String(ref),
    Number(ref) || -1,
  ]);
  if (!row) throw invalidEffectivity(`Effectivity assignment not found: ${ref}`, { notFound: true });
  return publicAssignment(row);
}

export function createAssignment(db, definitionRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const definition = requireDefinitionRow(db, definitionRefValue);
  const role = normalizeText(input.role, "primary");
  if (!ASSIGNMENT_ROLES.includes(role)) throw invalidEffectivity(`role must be one of: ${ASSIGNMENT_ROLES.join(", ")}`);
  const objectType = normalizeText(input.objectType ?? input.object_type ?? definition.object_type);
  const objectId = normalizeText(input.objectId ?? input.object_id);
  const revisionId = input.revisionId ?? input.revision_id ?? definition.revision_id ?? null;
  const versionId = input.versionId ?? input.version_id ?? null;
  if (!objectType) throw invalidEffectivity("objectType is required");
  if (!objectId) throw invalidEffectivity("objectId is required");
  if (versionId) {
    const version = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [Number(versionId)]);
    if (!version) throw invalidEffectivity(`Version not found: ${versionId}`, { versionId });
    if (version.object_type !== objectType || String(version.object_id) !== String(objectId)) {
      throw invalidEffectivity("Version does not belong to the supplied object", { versionId, objectId });
    }
    if (revisionId && Number(revisionId) !== Number(version.revision_id)) {
      throw invalidEffectivity("versionId does not belong to revisionId", { versionId, revisionId });
    }
  }
  if (revisionId) {
    const revision = queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [Number(revisionId)]);
    if (!revision) throw revisionNotFound(revisionId);
    if (revision.object_type !== objectType || String(revision.object_id) !== String(objectId)) {
      throw invalidEffectivity("Revision does not belong to the supplied object", { revisionId, objectId });
    }
  }
  return transaction(db, () => {
    const dup = queryOne(
      db,
      `SELECT id FROM versioning_effectivity_assignments
       WHERE definition_id = ? AND object_type = ? AND object_id = ?
         AND COALESCE(revision_id, 0) = COALESCE(?, 0) AND COALESCE(version_id, 0) = COALESCE(?, 0)`,
      [definition.id, objectType, objectId, revisionId, versionId]
    );
    if (dup) throw invalidEffectivity("Effectivity is already assigned to this target", { assignmentId: dup.id });
    assertNoAssignmentOverlap(db, {
      objectType,
      objectId,
      revisionId,
      versionId,
      definition,
    });
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_effectivity_assignments
        (assignment_ref, definition_id, object_type, object_id, revision_id, version_id, role, precedence, status,
         tenant_id, organization_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        assignmentRef(),
        definition.id,
        objectType,
        objectId,
        revisionId,
        versionId,
        role,
        input.precedence === undefined ? definition.priority : Number(input.precedence),
        input.tenantId ?? input.tenant_id ?? tenantId ?? definition.tenant_id,
        input.organizationId ?? input.organization_id ?? definition.organization_id,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const row = queryOne(db, "SELECT * FROM versioning_effectivity_assignments WHERE id = ?", [Number(result.lastInsertRowid)]);
    writeAudit(db, {
      actor,
      action: "versioning.effectivity.assign",
      resourceType: "versioning_effectivity_assignment",
      resourceId: row.id,
      details: { definition_id: definition.id, object_type: objectType, object_id: objectId, revision_id: revisionId, version_id: versionId },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "EffectivityChanged",
        source_module: "versioning",
        source_object_type: "versioning_effectivity_assignment",
        source_object_id: row.id,
        tenant_id: row.tenant_id,
        payload: { assignment_id: row.id, definition_id: definition.id, object_type: objectType, object_id: objectId },
      },
      actor
    );
    return publicAssignment(row);
  });
}

export function deleteAssignment(db, ref, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM versioning_effectivity_assignments WHERE assignment_ref = ? OR id = ?", [
    String(ref),
    Number(ref) || -1,
  ]);
  if (!row) throw invalidEffectivity(`Effectivity assignment not found: ${ref}`, { notFound: true });
  run(db, "DELETE FROM versioning_effectivity_assignments WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.effectivity.unassign",
    resourceType: "versioning_effectivity_assignment",
    resourceId: row.id,
    details: { definition_id: row.definition_id, object_type: row.object_type, object_id: row.object_id },
    ip,
  });
  return { deleted: true, id: row.id };
}

// ── Validation / inspection ─────────────────────────────────────────────────

// Validate a definition in isolation and report range problems + overlap risk.
export function validateDefinition(db, input = {}) {
  const errors = [];
  try {
    validateDefinitionInput(input);
  } catch (error) {
    errors.push(error.message);
  }
  const warnings = [];
  const dimension = normalizeText(input.dimension);
  const values = normalizeValues(input, { dimension });
  if (["model", "plant", "unit", "variant", "configuration", "revision"].includes(dimension) && !values.length) {
    warnings.push(`Dimension "${dimension}" usually requires one or more values`);
  }
  if ((input.effectiveFrom || input.effective_from) && (input.effectiveTo || input.effective_to)) {
    warnings.push("A closed date range will stop applying after effectiveTo");
  }
  if (!input.effectiveTo && !input.effective_to && !input.serialTo && !input.serial_to) {
    warnings.push("Open-ended effectivity");
  }
  return { valid: errors.length === 0, errors, warnings, values };
}

// Inspect the date coverage for an object: overlaps, gaps, expired and future
// effectivity. Used by the dashboard and the Effectivity Editor.
export function inspectObject(db, { objectType, objectId, asOf = null }) {
  const revisions = queryAll(
    db,
    "SELECT * FROM versioning_revisions WHERE object_type = ? AND object_id = ? ORDER BY revision_sequence",
    [objectType, objectId]
  );
  const revisionIds = new Set(revisions.map((r) => r.id));
  const assignments = queryAll(
    db,
    `SELECT a.*, d.code AS definition_code, d.dimension, d.effective_from, d.effective_to, d.boundary,
            d.serial_from, d.serial_to, d.serial_mode, d.priority, d.overlap_allowed, d.type_code
     FROM versioning_effectivity_assignments a
     JOIN versioning_effectivity_definitions d ON d.id = a.definition_id
     WHERE a.status = 'active' AND a.object_type = ? AND a.object_id = ?
     ORDER BY d.effective_from`,
    [objectType, objectId]
  );
  const dateRanges = assignments.filter((a) => a.effective_from || a.effective_to);
  const overlaps = [];
  for (let i = 0; i < dateRanges.length; i += 1) {
    for (let j = i + 1; j < dateRanges.length; j += 1) {
      const a = dateRanges[i];
      const b = dateRanges[j];
      if (a.revision_id && b.revision_id && a.revision_id === b.revision_id) continue;
      if (rangesOverlap(a.effective_from, a.effective_to, b.effective_from, b.effective_to)) {
        overlaps.push({
          left: { definition: a.definition_code, from: a.effective_from, to: a.effective_to, revision_id: a.revision_id },
          right: { definition: b.definition_code, from: b.effective_from, to: b.effective_to, revision_id: b.revision_id },
          permitted: Boolean(a.overlap_allowed && b.overlap_allowed),
        });
      }
    }
  }
  const sorted = [...dateRanges].sort((a, b) => String(a.effective_from || "").localeCompare(String(b.effective_from || "")));
  const gaps = [];
  let cursor = null;
  for (const range of sorted) {
    const start = range.effective_from || null;
    const end = range.effective_to || null;
    if (start && cursor && start > cursor) gaps.push({ from: cursor, to: start });
    if (end && (!cursor || end > cursor)) cursor = end;
    if (!end) cursor = null;
  }
  const now = asOf || new Date().toISOString().slice(0, 10);
  const expired = dateRanges.filter((r) => r.effective_to && r.effective_to < now);
  const future = dateRanges.filter((r) => r.effective_from && r.effective_from > now);
  const openEnded = dateRanges.filter((r) => !r.effective_to);
  const serialRanges = assignments.filter((a) => a.serial_from || a.serial_to);
  const serialOverlaps = [];
  for (let i = 0; i < serialRanges.length; i += 1) {
    for (let j = i + 1; j < serialRanges.length; j += 1) {
      const a = serialRanges[i];
      const b = serialRanges[j];
      if (a.revision_id && b.revision_id && a.revision_id === b.revision_id) continue;
      if (serialRangesOverlap(a.serial_from, a.serial_to, b.serial_from, b.serial_to, a.serial_mode)) {
        serialOverlaps.push({
          left: { definition: a.definition_code, from: a.serial_from, to: a.serial_to },
          right: { definition: b.definition_code, from: b.serial_from, to: b.serial_to },
        });
      }
    }
  }
  return {
    object_type: objectType,
    object_id: objectId,
    revision_count: revisions.length,
    revision_ids: [...revisionIds],
    assignments: assignments.map((a) => ({
      assignment_ref: a.assignment_ref,
      definition_code: a.definition_code,
      dimension: a.dimension,
      effective_from: a.effective_from,
      effective_to: a.effective_to,
      serial_from: a.serial_from,
      serial_to: a.serial_to,
      revision_id: a.revision_id,
      version_id: a.version_id,
      status: a.status,
    })),
    overlaps,
    gaps,
    serial_overlaps: serialOverlaps,
    expired,
    future,
    open_ended: openEnded,
    has_conflicts: overlaps.some((o) => !o.permitted) || serialOverlaps.length > 0,
  };
}

export { valuesFor, withinDateRange, withinSerialRange };
