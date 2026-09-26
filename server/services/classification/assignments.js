// Classification assignment: links a class (and therefore its effective
// characteristic contract) to any platform object (part, document, supplier,
// process, ...). Assignment is the point where classification becomes useful to
// other modules: they read `objectClassifications()` / `resolveObjectValues()`.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { publicAssignment, publicClass } from "./repository.js";
import { assignmentRef } from "./refs.js";
import { MAX_ASSIGNMENT_VALUES, ASSIGNABLE_STATUSES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { normalizeText, normalizeUpper, parseObject, paginate, coerceCharacteristicValue } from "./validation.js";
import { resolveEffectiveCharacteristics } from "./inheritance.js";
import { requireClassRow } from "./hierarchy.js";
import { requireClassificationRow } from "./definitions.js";
import { validateClassValues, storedValuesForAssignment, flattenValues } from "./validation-service.js";
import {
  assignmentNotFound,
  assignmentConflict,
  invalidAssignment,
  assignmentInactive,
  singleClassOnly,
  classificationObsolete,
  validationFailed,
} from "./errors.js";
import { convertValue, listUnits } from "./units.js";
import { recordChange } from "./history.js";
import { publishClassificationEvent, classificationEventCode } from "./events.js";
import { invalidate } from "./cache.js";

export function getAssignmentRow(db, tenantId, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM cla_assignments WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM cla_assignments WHERE tenant_id = ? AND assignment_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireAssignmentRow(db, tenantId, ref) {
  const row = getAssignmentRow(db, tenantId, ref);
  if (!row) throw assignmentNotFound(ref);
  return row;
}

export function assignmentValues(db, assignmentId) {
  return storedValuesForAssignment(db, assignmentId);
}

function matchEffective(resolved, ref) {
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return resolved.items.find((item) => Number(item.characteristic_id) === numeric) || null;
  }
  return resolved.items.find((item) => normalizeUpper(item.code) === normalizeUpper(ref)) || null;
}

// Persists a value map for an assignment. Returns { values, validation }.
function writeAssignmentValues(db, tenantId, assignment, effective, rawValues, actor) {
  const units = listUnits(db, { limit: 2000 });
  const autoNormalize = getConfig(db, tenantId, "auto_normalize_units") !== false;
  const grouped = new Map();
  for (const entry of flattenValues(rawValues)) {
    const item = matchEffective(effective, entry.ref);
    if (!item) continue;
    const list = grouped.get(item.characteristic_id) || [];
    list.push(entry);
    grouped.set(item.characteristic_id, list);
  }

  const rows = [];
  const errors = [];
  for (const item of effective.items) {
    const values = grouped.get(item.characteristic_id) || [];
    if (!values.length) continue;
    if (!item.multi_valued && values.length > 1 && getConfig(db, tenantId, "allow_multi_value") === false) {
      errors.push({ characteristic_id: item.characteristic_id, code: item.code, code: "MULTI_VALUE_NOT_ALLOWED", message: `${item.code} is single-valued` });
      continue;
    }
    const effectiveValues = item.multi_valued ? values : values.slice(0, 1);
    const allowedCodes = item.data_type === "ENUMERATION" ? (item.allowed_values || []).map((value) => normalizeUpper(value.code)) : null;
    for (let index = 0; index < effectiveValues.length; index += 1) {
      const entry = effectiveValues[index];
      const characteristic = {
        id: item.characteristic_id,
        code: item.code,
        name: item.name,
        data_type: item.data_type,
        required: false,
        min_value: item.min_value,
        max_value: item.max_value,
        min_inclusive: item.min_inclusive,
        max_inclusive: item.max_inclusive,
        scale: item.scale,
        unit: entry.unit || item.unit,
        base_unit: item.base_unit,
      };
      const coerced = coerceCharacteristicValue(characteristic, entry.value, { allowedCodes });
      if (!coerced.valid) {
        for (const issue of coerced.issues) errors.push({ characteristic_id: item.characteristic_id, code: item.code, ...issue });
        continue;
      }
      let normalizedValue = coerced.value_number;
      let normalizedUnit = coerced.normalized_unit || item.base_unit || item.unit || "";
      if (item.data_type === "UNIT_NUMERIC" && autoNormalize && coerced.value_number !== null) {
        const conversion = convertValue(coerced.value_number, coerced.unit || item.unit, item.base_unit || item.unit, { units, strict: false });
        if (conversion.compatible !== false) {
          normalizedValue = conversion.normalized_value ?? normalizedValue;
          normalizedUnit = conversion.normalized_unit || normalizedUnit;
        }
      }
      rows.push([
        Number(tenantId),
        assignment.id,
        item.characteristic_id,
        index,
        coerced.value_text || "",
        coerced.value_number,
        coerced.value_boolean === null || coerced.value_boolean === undefined ? null : coerced.value_boolean ? 1 : 0,
        coerced.value_date,
        coerced.value_reference || "",
        coerced.unit || "",
        normalizedValue,
        normalizedUnit,
        "ACTIVE",
        actor?.id ?? null,
        actor?.id ?? null,
        nowIso(),
        nowIso(),
      ]);
      if (rows.length > MAX_ASSIGNMENT_VALUES) {
        errors.push({ code: "TOO_MANY_VALUES", message: `At most ${MAX_ASSIGNMENT_VALUES} values are allowed per assignment` });
        break;
      }
    }
  }

  if (errors.length) throw invalidAssignment("One or more characteristic values are invalid", { errors });

  transaction(db, () => {
    run(db, "DELETE FROM cla_assignment_values WHERE assignment_id = ?", [assignment.id]);
    for (const row of rows) {
      run(
        db,
        `INSERT INTO cla_assignment_values
           (tenant_id, assignment_id, characteristic_id, sequence, value_text, value_number, value_boolean,
            value_date, value_reference, unit, normalized_value, normalized_unit, status, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row
      );
    }
  });
  return assignmentValues(db, assignment.id);
}

export function assignClass(db, tenantId, body = {}, actor = null, ip = null) {
  const objectType = normalizeText(body.object_type ?? body.objectType, { max: 120 });
  const objectId = normalizeText(body.object_id ?? body.objectId, { max: 300 });
  if (!objectType || !objectId) throw invalidAssignment("object_type and object_id are required");
  const classRow = requireClassRow(db, tenantId, body.class_id ?? body.classId ?? body.class);
  const classification = requireClassificationRow(db, tenantId, classRow.classification_id);

  const allowObsolete = getConfig(db, tenantId, "allow_obsolete_assignment") === true;
  if (!allowObsolete && classification.status === "OBSOLETE") throw classificationObsolete(classification.code);
  if (!allowObsolete && !ASSIGNABLE_STATUSES.includes(classRow.status)) {
    throw invalidAssignment(`Class ${classRow.code} is ${classRow.status} and cannot be assigned`);
  }

  if (getConfig(db, tenantId, "allow_multiple_classification") === false) {
    const others = queryAll(
      db,
      "SELECT id, class_id FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'ACTIVE' AND class_id <> ?",
      [Number(tenantId), objectType, objectId, classRow.id]
    );
    if (others.length) throw singleClassOnly(objectType);
  }

  const existing = queryOne(
    db,
    "SELECT * FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND class_id = ?",
    [Number(tenantId), objectType, objectId, classRow.id]
  );
  if (existing && existing.status === "ACTIVE") {
    if (body.values !== undefined && body.values !== null) {
      const effective = resolveEffectiveCharacteristics(db, tenantId, classRow.id);
      const values = writeAssignmentValues(db, tenantId, existing, effective, body.values, actor);
      recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: existing.id, entityRef: existing.assignment_ref, action: "VALUES_UPDATED", version: existing.version, status: existing.status, after: { values }, actor, ip });
      publishClassificationEvent(db, { eventType: classificationEventCode("VALUES_UPDATED"), payload: { assignment_id: existing.id, object_type: objectType, object_id: objectId, class_id: classRow.id }, objectType, objectId, tenantId }, actor);
      return { assignment: publicAssignment(existing), values, created: false };
    }
    throw assignmentConflict({ object_type: objectType, object_id: objectId, class_id: classRow.id });
  }

  const ts = nowIso();
  const status = existing ? normalizeUpper(body.status || "ACTIVE") : "ACTIVE";
  let id;
  if (existing) {
    run(
      db,
      "UPDATE cla_assignments SET status = ?, version = version + 1, metadata_json = ?, organization_id = ?, assigned_by = ?, assigned_at = ?, classification_version = ?, updated_at = ? WHERE id = ?",
      [
        status,
        JSON.stringify(parseObject(body.metadata, {})),
        body.organization_id != null ? Number(body.organization_id) : existing.organization_id ?? null,
        actor?.id ?? null,
        ts,
        classification.version,
        ts,
        existing.id,
      ]
    );
    id = existing.id;
  } else {
    const result = run(
      db,
      `INSERT INTO cla_assignments
         (assignment_ref, tenant_id, organization_id, classification_id, class_id, classification_version, object_type, object_id, assigned_by, assigned_at, status, version, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        assignmentRef(objectType, objectId),
        Number(tenantId),
        body.organization_id != null ? Number(body.organization_id) : null,
        classification.id,
        classRow.id,
        classification.version,
        objectType,
        objectId,
        actor?.id ?? null,
        ts,
        status,
        JSON.stringify(parseObject(body.metadata, {})),
        ts,
        ts,
      ]
    );
    id = Number(result.lastInsertRowid);
  }

  const assignmentRow = queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [id]);
  let values = [];
  if (body.values !== undefined && body.values !== null) {
    if (body.validate !== false) {
      const validation = validateClassValues(db, tenantId, classRow.id, body.values);
      if (!validation.valid) throw validationFailed({ errors: validation.errors, missing_required: validation.missing_required });
    }
    const effective = resolveEffectiveCharacteristics(db, tenantId, classRow.id);
    values = writeAssignmentValues(db, tenantId, assignmentRow, effective, body.values, actor);
  }
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: id, entityRef: assignmentRow.assignment_ref, action: "ASSIGNED", version: assignmentRow.version, status, after: { ...publicAssignment(assignmentRow), values }, actor, ip });
  publishClassificationEvent(db, { eventType: classificationEventCode("ASSIGNED"), payload: { assignment_id: id, classification_id: classification.id, class_id: classRow.id, object_type: objectType, object_id: objectId }, objectType, objectId, tenantId }, actor);
  return { assignment: publicAssignment(assignmentRow), values, created: !existing };
}

export function listAssignments(db, { tenantId, objectType, objectId, classId, classificationId, status, q, page, pageSize, sort } = {}) {
  const clauses = ["a.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("a.object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (objectId) {
    clauses.push("a.object_id = ?");
    params.push(normalizeText(objectId, { max: 300 }));
  }
  if (classId != null) {
    clauses.push("a.class_id = ?");
    params.push(Number(classId));
  }
  if (classificationId != null) {
    clauses.push("a.classification_id = ?");
    params.push(Number(classificationId));
  }
  if (status) {
    clauses.push("a.status = ?");
    params.push(normalizeUpper(status));
  }
  if (q) {
    clauses.push("(a.assignment_ref LIKE ? OR a.object_id LIKE ? OR c.code LIKE ?)");
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM cla_assignments a JOIN cla_classes c ON c.id = a.class_id WHERE ${where}`, params)?.c || 0);
  const { limit, offset, page: currentPage, pageSize: size } = paginate({ page, pageSize });
  const rows = queryAll(
    db,
    `SELECT a.*, c.code AS class_code, c.name AS class_name, c.path AS class_path, cl.code AS classification_code, cl.name AS classification_name
       FROM cla_assignments a
       JOIN cla_classes c ON c.id = a.class_id
       JOIN cla_classifications cl ON cl.id = a.classification_id
      WHERE ${where}
      ORDER BY a.assigned_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    items: rows.map((row) => ({
      ...publicAssignment(row),
      class_code: row.class_code,
      class_name: row.class_name,
      class_path: row.class_path,
      classification_code: row.classification_code,
      classification_name: row.classification_name,
    })),
    total,
    page: currentPage,
    page_size: size,
  };
}

export function getAssignment(db, tenantId, ref) {
  const row = requireAssignmentRow(db, tenantId, ref);
  return { assignment: publicAssignment(row), values: assignmentValues(db, row.id) };
}

export function setAssignmentValues(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireAssignmentRow(db, tenantId, ref);
  if (row.status !== "ACTIVE") throw assignmentInactive(ref);
  const rawValues = body.values ?? body;
  if (body.validate !== false) {
    const validation = validateClassValues(db, tenantId, row.class_id, rawValues, { partial: body.partial === true });
    if (!validation.valid) throw validationFailed({ errors: validation.errors, missing_required: validation.missing_required });
  }
  const effective = resolveEffectiveCharacteristics(db, tenantId, row.class_id);
  const values = writeAssignmentValues(db, tenantId, row, effective, rawValues, actor);
  run(db, "UPDATE cla_assignments SET version = version + 1, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  invalidate(tenantId);
  const after = queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [row.id]);
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: row.id, entityRef: row.assignment_ref, action: "VALUES_UPDATED", version: after.version, status: after.status, after: { values }, actor, ip });
  publishClassificationEvent(db, { eventType: classificationEventCode("VALUES_UPDATED"), payload: { assignment_id: row.id, object_type: row.object_type, object_id: row.object_id, class_id: row.class_id }, objectType: row.object_type, objectId: row.object_id, tenantId }, actor);
  return { assignment: publicAssignment(after), values };
}

export function setAssignmentStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireAssignmentRow(db, tenantId, ref);
  const next = normalizeUpper(status);
  if (!["ACTIVE", "INACTIVE", "OBSOLETE"].includes(next)) throw invalidAssignment(`Unknown assignment status: ${status}`);
  run(db, "UPDATE cla_assignments SET status = ?, version = version + 1, updated_at = ? WHERE id = ?", [next, nowIso(), row.id]);
  invalidate(tenantId);
  const after = queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [row.id]);
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: row.id, entityRef: row.assignment_ref, action: next === "ACTIVE" ? "REACTIVATED" : "STATUS_CHANGED", version: after.version, status: next, before: publicAssignment(row), after: publicAssignment(after), actor, ip });
  return publicAssignment(after);
}

export function unassign(db, tenantId, ref, actor = null, ip = null) {
  const row = requireAssignmentRow(db, tenantId, ref);
  run(db, "DELETE FROM cla_assignments WHERE id = ?", [row.id]);
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: row.id, entityRef: row.assignment_ref, action: "UNASSIGNED", version: row.version, status: row.status, before: publicAssignment(row), actor, ip });
  publishClassificationEvent(db, { eventType: classificationEventCode("UNASSIGNED"), payload: { assignment_id: row.id, object_type: row.object_type, object_id: row.object_id, class_id: row.class_id }, objectType: row.object_type, objectId: row.object_id, tenantId }, actor);
  return { deleted: true, id: row.id };
}

// Replaces the class of an existing assignment (single-classification model).
export function reclassify(db, tenantId, ref, { classId, values = undefined, validate = true } = {}, actor = null, ip = null) {
  const row = requireAssignmentRow(db, tenantId, ref);
  const classRow = requireClassRow(db, tenantId, classId);
  const classification = requireClassificationRow(db, tenantId, classRow.classification_id);
  run(
    db,
    "UPDATE cla_assignments SET class_id = ?, classification_id = ?, classification_version = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [classRow.id, classification.id, classification.version, nowIso(), row.id]
  );
  if (values !== undefined && values !== null) {
    const effective = resolveEffectiveCharacteristics(db, tenantId, classRow.id);
    writeAssignmentValues(db, tenantId, queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [row.id]), effective, values, actor);
  }
  invalidate(tenantId);
  const after = queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [row.id]);
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: row.id, entityRef: row.assignment_ref, action: "RECLASSIFIED", version: after.version, status: after.status, before: publicAssignment(row), after: publicAssignment(after), actor, ip });
  return { assignment: publicAssignment(after), values: assignmentValues(db, row.id), validated: validate };
}

// Returns every class (with values) assigned to an object. This is the read
// contract consumed by PDM, BOM, Documents, Manufacturing, Quality, Supplier and
// Product modules.
export function objectClassifications(db, tenantId, objectType, objectId = null, { includeInactive = false } = {}) {
  const clauses = ["tenant_id = ?", "object_type = ?"];
  const params = [Number(tenantId), normalizeText(objectType, { max: 120 })];
  if (objectId != null) {
    clauses.push("object_id = ?");
    params.push(normalizeText(objectId, { max: 300 }));
  }
  if (!includeInactive) clauses.push("status = 'ACTIVE'");
  const rows = queryAll(db, `SELECT * FROM cla_assignments WHERE ${clauses.join(" AND ")} ORDER BY id`, params);
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.object_id) || [];
    list.push(row);
    grouped.set(row.object_id, list);
  }
  const objects = [];
  for (const [key, assignments] of grouped) {
    objects.push({
      object_type: normalizeText(objectType, { max: 120 }),
      object_id: key,
      assignments: assignments.map((assignment) => {
        const classRow = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [assignment.class_id]);
        return {
          assignment: publicAssignment(assignment),
          class: publicClass(classRow),
          values: assignmentValues(db, assignment.id),
        };
      }),
    });
  }
  return { object_type: objectType, object_id: objectId, items: objects, total: objects.length };
}

// Flattens all active values for an object, keyed by class code and
// characteristic code. Used for search indexing, duplicate detection and export.
export function resolveObjectValues(db, tenantId, objectType, objectId) {
  const assignments = queryAll(
    db,
    "SELECT a.*, c.code AS class_code FROM cla_assignments a JOIN cla_classes c ON c.id = a.class_id WHERE a.tenant_id = ? AND a.object_type = ? AND a.object_id = ? AND a.status = 'ACTIVE'",
    [Number(tenantId), normalizeText(objectType, { max: 120 }), normalizeText(objectId, { max: 300 })]
  );
  const byClass = {};
  const flat = {};
  for (const assignment of assignments) {
    const values = assignmentValues(db, assignment.id);
    byClass[assignment.class_code] = values;
    const resolved = resolveEffectiveCharacteristics(db, tenantId, assignment.class_id);
    for (const value of values) {
      const item = resolved.items.find((entry) => Number(entry.characteristic_id) === Number(value.characteristic_id));
      if (item) flat[item.code] = value.value_number ?? value.value_boolean ?? value.value_date ?? value.value_reference ?? value.value_text;
    }
  }
  return { object_type: objectType, object_id: objectId, by_class: byClass, values: flat, class_count: assignments.length };
}

export function effectiveCharacteristicsForObject(db, tenantId, objectType, objectId) {
  const assignments = queryAll(
    db,
    "SELECT class_id FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'ACTIVE'",
    [Number(tenantId), normalizeText(objectType, { max: 120 }), normalizeText(objectId, { max: 300 })]
  );
  const merged = new Map();
  for (const assignment of assignments) {
    const resolved = resolveEffectiveCharacteristics(db, tenantId, assignment.class_id);
    for (const item of resolved.items) if (!merged.has(item.code)) merged.set(item.code, item);
  }
  return [...merged.values()];
}

export function validateAssignment(db, tenantId, ref) {
  const row = requireAssignmentRow(db, tenantId, ref);
  const validation = validateClassValues(db, tenantId, row.class_id, storedValuesForAssignment(db, row.id));
  recordChange(db, { tenantId, entityType: "ASSIGNMENT", entityId: row.id, entityRef: row.assignment_ref, action: "VALIDATED", version: row.version, status: row.status, details: { valid: validation.valid, errors: validation.errors.length }, audit: true });
  publishClassificationEvent(db, { eventType: classificationEventCode("VALIDATED"), payload: { assignment_id: row.id, valid: validation.valid }, objectType: row.object_type, objectId: row.object_id, tenantId });
  return { assignment: publicAssignment(row), validation };
}
