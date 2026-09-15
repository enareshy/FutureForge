import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import * as metadata from "../metadata.js";
import * as statuses from "./statuses.js";
import {
  DEFINITION_STATUSES,
  VERSION_STATUSES,
  TRANSITION_STATUSES,
  assertOneOf,
  assertCategory,
  normalizeConditions,
  safeParse,
  validateTransitionGraph,
} from "./validation.js";

// Lifecycle definitions, immutable versions, their state machines and the
// object-type assignments. A definition is the stable identity; a version is a
// snapshot of states + transitions. Publishing validates and freezes a version.
// Objects pin a version id, so later configuration edits never silently move
// existing records.

export function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    module: row.module,
    current_version: row.current_version,
    published_version: row.published_version ?? null,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    state_count: row.state_count ?? 0,
    transition_count: row.transition_count ?? 0,
    assignment_count: row.assignment_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const DEFINITION_SELECT = `
  SELECT d.*,
    (SELECT COUNT(*) FROM lifecycle_states s
       JOIN lifecycle_versions v ON v.id = s.lifecycle_version_id
      WHERE v.definition_id = d.id AND v.version = d.current_version) AS state_count,
    (SELECT COUNT(*) FROM lifecycle_transitions t
       JOIN lifecycle_versions v ON v.id = t.lifecycle_version_id
      WHERE v.definition_id = d.id AND v.version = d.current_version) AS transition_count,
    (SELECT COUNT(*) FROM lifecycle_type_assignments a WHERE a.lifecycle_definition_id = d.id) AS assignment_count
  FROM lifecycle_definitions d
`;

export function getDefinitionRow(db, id) {
  return queryOne(db, `${DEFINITION_SELECT} WHERE d.id = ?`, [Number(id)]);
}

export function findDefinition(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getDefinitionRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Lifecycle definition not found");
      return byId;
    }
  }
  const scope = tenantClause("d", tenantId);
  const byCode = queryOne(
    db,
    `${DEFINITION_SELECT} WHERE d.code = ? AND ${scope.sql} ORDER BY d.tenant_id IS NULL LIMIT 1`,
    [text, ...scope.params]
  );
  if (!byCode) throw new HttpError(404, "Lifecycle definition not found");
  return byCode;
}

export function getDefinition(db, idOrCode, tenantId) {
  return publicDefinition(findDefinition(db, idOrCode, tenantId));
}

export function listDefinitions(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("d", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("d.status = ?");
    params.push(query.status);
  }
  if (query.module) {
    where.push("d.module = ?");
    params.push(query.module);
  }
  if (query.q) {
    where.push("(d.code LIKE ? OR d.name LIKE ? OR d.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM lifecycle_definitions d ${clause}`, params).c;
  const items = queryAll(
    db,
    `${DEFINITION_SELECT} ${clause} ORDER BY d.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicDefinition);
  return { items, total, page, pageSize };
}

export function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    version: row.version,
    status: row.status,
    notes: row.notes || "",
    snapshot: safeParse(row.snapshot, {}),
    published_at: row.published_at || null,
    published_by: row.published_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getVersionRow(db, id) {
  return queryOne(db, "SELECT * FROM lifecycle_versions WHERE id = ?", [Number(id)]);
}

export function currentVersionRow(db, definitionRow) {
  return queryOne(
    db,
    "SELECT * FROM lifecycle_versions WHERE definition_id = ? AND version = ?",
    [definitionRow.id, definitionRow.current_version]
  );
}

export function publishedVersionRow(db, definitionId) {
  return queryOne(
    db,
    "SELECT * FROM lifecycle_versions WHERE definition_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
    [Number(definitionId)]
  );
}

function createVersionRow(db, definitionId, version, actor, notes = "", status = "draft") {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lifecycle_versions (definition_id, version, status, notes, snapshot, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
    [definitionId, version, status, notes || "", actor?.id ?? null, ts, ts]
  );
  return getVersionRow(db, result.lastInsertRowid);
}

export function createDefinition(db, body, actor, ip, reqTenantId, query = {}) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Lifecycle code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO lifecycle_definitions
        (code, name, description, module, current_version, published_version, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NULL, 'draft', ?, 0, ?, ?)`,
      [body.code, String(body.name).trim(), body.description || "", body.module || "platform", tenantId ?? null, ts, ts]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Lifecycle code already exists in this scope");
    }
    throw err;
  }
  const version = createVersionRow(db, result.lastInsertRowid, 1, actor, "Initial draft");
  writeAudit(db, {
    actor,
    action: "lifecycle.definition.create",
    resourceType: "lifecycle_definition",
    resourceId: result.lastInsertRowid,
    details: { code: body.code, version: version.version, tenant_id: tenantId ?? null },
    ip,
  });
  return { definition: getDefinition(db, result.lastInsertRowid, tenantId), version: publicVersion(version) };
}

export function updateDefinition(db, id, body, actor, ip, tenantId) {
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Lifecycle definition not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Lifecycle code");
  const status = body.status === undefined ? row.status : assertOneOf(body.status, DEFINITION_STATUSES, "status");
  try {
    run(
      db,
      `UPDATE lifecycle_definitions SET code = ?, name = ?, description = ?, module = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [body.code ?? row.code, String(body.name ?? row.name).trim(), body.description ?? row.description, body.module ?? row.module, status, nowIso(), row.id]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Lifecycle code already exists in this scope");
    }
    throw err;
  }
  writeAudit(db, { actor, action: "lifecycle.definition.update", resourceType: "lifecycle_definition", resourceId: row.id, details: { code: row.code }, ip });
  return publicDefinition(getDefinitionRow(db, row.id));
}

export function setDefinitionStatus(db, id, status, actor, ip, tenantId) {
  assertOneOf(status, DEFINITION_STATUSES, "status");
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Lifecycle definition not found");
  run(db, "UPDATE lifecycle_definitions SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, { actor, action: `lifecycle.definition.${status}`, resourceType: "lifecycle_definition", resourceId: row.id, ip });
  return publicDefinition(getDefinitionRow(db, row.id));
}

export function deleteDefinition(db, id, actor, ip, tenantId) {
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Lifecycle definition not found");
  const assigned = queryOne(db, "SELECT COUNT(*) AS c FROM lifecycle_type_assignments WHERE lifecycle_definition_id = ?", [row.id]).c;
  if (assigned) throw new HttpError(409, "Cannot delete a lifecycle assigned to object types");
  const pinned = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM objects o
       JOIN lifecycle_versions v ON v.id = o.lifecycle_version_id
      WHERE v.definition_id = ?`,
    [row.id]
  ).c;
  if (pinned) throw new HttpError(409, "Cannot delete a lifecycle pinned by existing objects");
  run(db, "DELETE FROM lifecycle_definitions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "lifecycle.definition.delete", resourceType: "lifecycle_definition", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

export function listVersions(db, definitionId, tenantId) {
  const def = findDefinition(db, definitionId, tenantId);
  const items = queryAll(
    db,
    "SELECT * FROM lifecycle_versions WHERE definition_id = ? ORDER BY version DESC",
    [def.id]
  ).map(publicVersion);
  return { items, definition: publicDefinition(def) };
}

// Creates a new draft version by copying the latest (published or current) one.
export function createVersion(db, definitionId, body, actor, ip, tenantId) {
  const def = findDefinition(db, definitionId, tenantId);
  assertMutable(db, def, tenantId, actor, "Lifecycle definition not found");
  const source = body?.from_version
    ? queryOne(db, "SELECT * FROM lifecycle_versions WHERE definition_id = ? AND version = ?", [def.id, Number(body.from_version)])
    : publishedVersionRow(db, def.id) || currentVersionRow(db, def);
  if (!source) throw new HttpError(409, "No source version to copy");
  const nextVersion = Number(def.current_version) + 1;
  const version = createVersionRow(db, def.id, nextVersion, actor, body?.notes || `Draft from v${source.version}`);
  copyVersionGraph(db, source.id, version.id);
  run(db, "UPDATE lifecycle_definitions SET current_version = ?, updated_at = ? WHERE id = ?", [nextVersion, nowIso(), def.id]);
  writeAudit(db, {
    actor,
    action: "lifecycle.version.create",
    resourceType: "lifecycle_definition",
    resourceId: def.id,
    details: { version: nextVersion, from: source.version },
    ip,
  });
  return { definition: publicDefinition(getDefinitionRow(db, def.id)), version: publicVersion(version) };
}

function copyVersionGraph(db, sourceVersionId, targetVersionId) {
  const stateMap = new Map();
  for (const state of queryAll(db, "SELECT * FROM lifecycle_states WHERE lifecycle_version_id = ? ORDER BY display_order, id", [sourceVersionId])) {
    const result = run(
      db,
      `INSERT INTO lifecycle_states
        (lifecycle_version_id, code, name, description, status_id, category, is_initial, is_terminal,
         display_order, editable, visible, permissions_json, entry_conditions_json, exit_conditions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetVersionId,
        state.code,
        state.name,
        state.description,
        state.status_id,
        state.category,
        state.is_initial,
        state.is_terminal,
        state.display_order,
        state.editable,
        state.visible,
        state.permissions_json,
        state.entry_conditions_json,
        state.exit_conditions_json,
        nowIso(),
        nowIso(),
      ]
    );
    stateMap.set(state.id, result.lastInsertRowid);
  }
  for (const t of queryAll(db, "SELECT * FROM lifecycle_transitions WHERE lifecycle_version_id = ? ORDER BY display_order, id", [sourceVersionId])) {
    run(
      db,
      `INSERT INTO lifecycle_transitions
        (lifecycle_version_id, code, name, description, from_state_id, to_state_id, required_permission,
         required_role, requires_approval, approval_rule_id, auto_approve, conditions_json, display_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetVersionId,
        t.code,
        t.name,
        t.description,
        stateMap.get(t.from_state_id) ?? t.from_state_id,
        stateMap.get(t.to_state_id) ?? t.to_state_id,
        t.required_permission,
        t.required_role,
        t.requires_approval,
        null,
        t.auto_approve,
        t.conditions_json,
        t.display_order,
        t.status,
        nowIso(),
        nowIso(),
      ]
    );
  }
  return stateMap;
}

export function validateDefinitionVersion(db, versionId) {
  const version = getVersionRow(db, versionId);
  if (!version) throw new HttpError(404, "Lifecycle version not found");
  const states = queryAll(db, "SELECT * FROM lifecycle_states WHERE lifecycle_version_id = ?", [version.id]);
  const transitions = queryAll(db, "SELECT * FROM lifecycle_transitions WHERE lifecycle_version_id = ?", [version.id]);
  const errors = validateTransitionGraph(states, transitions);
  return { valid: errors.length === 0, errors, version: publicVersion(version), state_count: states.length, transition_count: transitions.length };
}

export function validateDefinition(db, definitionId, tenantId, { version } = {}) {
  const def = findDefinition(db, definitionId, tenantId);
  const row = version
    ? queryOne(db, "SELECT * FROM lifecycle_versions WHERE definition_id = ? AND version = ?", [def.id, Number(version)])
    : currentVersionRow(db, def);
  if (!row) throw new HttpError(404, "Lifecycle version not found");
  return validateDefinitionVersion(db, row.id);
}

export function publishDefinition(db, definitionId, body, actor, ip, tenantId) {
  const def = findDefinition(db, definitionId, tenantId);
  assertMutable(db, def, tenantId, actor, "Lifecycle definition not found");
  const version = body?.version
    ? queryOne(db, "SELECT * FROM lifecycle_versions WHERE definition_id = ? AND version = ?", [def.id, Number(body.version)])
    : currentVersionRow(db, def);
  if (!version) throw new HttpError(404, "Lifecycle version not found");
  const report = validateDefinitionVersion(db, version.id);
  if (!report.valid) {
    throw new HttpError(422, "Lifecycle definition is invalid", report.errors);
  }
  const snapshot = buildSnapshot(db, version.id);
  run(
    db,
    `UPDATE lifecycle_versions SET status = 'archived', updated_at = ? WHERE definition_id = ? AND status = 'published' AND id != ?`,
    [nowIso(), def.id, version.id]
  );
  run(
    db,
    `UPDATE lifecycle_versions SET status = 'published', snapshot = ?, notes = ?, published_at = ?, published_by = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(snapshot), body?.notes ?? version.notes ?? "", nowIso(), actor?.id ?? null, nowIso(), version.id]
  );
  run(
    db,
    "UPDATE lifecycle_definitions SET status = 'published', published_version = ?, current_version = ?, updated_at = ? WHERE id = ?",
    [version.version, version.version, nowIso(), def.id]
  );
  writeAudit(db, {
    actor,
    action: "lifecycle.definition.publish",
    resourceType: "lifecycle_definition",
    resourceId: def.id,
    details: { version: version.version, notes: body?.notes || "" },
    ip,
  });
  return { definition: publicDefinition(getDefinitionRow(db, def.id)), version: publicVersion(getVersionRow(db, version.id)) };
}

function buildSnapshot(db, versionId) {
  const states = queryAll(db, "SELECT * FROM lifecycle_states WHERE lifecycle_version_id = ? ORDER BY display_order, id", [versionId]);
  const transitions = queryAll(db, "SELECT * FROM lifecycle_transitions WHERE lifecycle_version_id = ? ORDER BY display_order, id", [versionId]);
  return { states, transitions };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function publicState(row) {
  if (!row) return null;
  return {
    id: row.id,
    lifecycle_version_id: row.lifecycle_version_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    status_id: row.status_id ?? null,
    status_code: row.status_code ?? null,
    category: row.category,
    is_initial: row.is_initial === 1,
    is_terminal: row.is_terminal === 1,
    display_order: row.display_order,
    editable: row.editable === 1,
    visible: row.visible === 1,
    permissions: safeParse(row.permissions_json, []),
    entry_conditions: safeParse(row.entry_conditions_json, {}),
    exit_conditions: safeParse(row.exit_conditions_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const STATE_SELECT = `
  SELECT s.*, st.code AS status_code
  FROM lifecycle_states s
  LEFT JOIN lifecycle_statuses st ON st.id = s.status_id
`;

export function getStateRow(db, id) {
  return queryOne(db, `${STATE_SELECT} WHERE s.id = ?`, [Number(id)]);
}

function versionContext(db, versionId) {
  const version = getVersionRow(db, versionId);
  if (!version) throw new HttpError(404, "Lifecycle version not found");
  const definition = queryOne(db, "SELECT * FROM lifecycle_definitions WHERE id = ?", [version.definition_id]);
  return { version, definition };
}

function assertDraftVersion(db, versionId, tenantId, actor) {
  const context = versionContext(db, versionId);
  assertMutable(db, context.definition, tenantId, actor, "Lifecycle definition not found");
  if (context.version.status !== "draft") {
    throw new HttpError(409, "Only draft lifecycle versions can be edited; create a new version first");
  }
  return context;
}

export function listStates(db, query = {}, tenantId) {
  const versionId = Number(query.versionId || query.version_id || query.lifecycle_version_id);
  if (!versionId) throw new HttpError(400, "versionId is required");
  const context = versionContext(db, versionId);
  assertReadable(context.definition, tenantId, "Lifecycle definition not found");
  return { items: queryAll(db, `${STATE_SELECT} WHERE s.lifecycle_version_id = ? ORDER BY s.display_order, s.code`, [versionId]).map(publicState) };
}

function normalizeStateStatus(db, body, versionDefinition, tenantId, fallback = {}) {
  if (body.status_id ?? body.statusId ?? body.status_code ?? body.statusCode) {
    const status = statuses.findStatus(db, body.status_id ?? body.statusId ?? body.status_code ?? body.statusCode, tenantId);
    return status;
  }
  return fallback.status_id ? statuses.findStatus(db, fallback.status_id, tenantId) : null;
}

export function createState(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name", "lifecycle_version_id"]);
  validateCode(body.code, "State code");
  const context = assertDraftVersion(db, body.lifecycle_version_id, tenantId, actor);
  const status = normalizeStateStatus(db, body, context.definition, tenantId);
  const category = assertCategory(body.category || (status ? status.category : "draft"));
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO lifecycle_states
        (lifecycle_version_id, code, name, description, status_id, category, is_initial, is_terminal,
         display_order, editable, visible, permissions_json, entry_conditions_json, exit_conditions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.version.id,
        body.code,
        String(body.name).trim(),
        body.description || "",
        status?.id ?? null,
        category,
        body.is_initial || body.isInitial ? 1 : 0,
        body.is_terminal || body.isTerminal ? 1 : 0,
        Number(body.display_order ?? body.displayOrder ?? 0) || 0,
        body.editable === undefined ? 1 : body.editable ? 1 : 0,
        body.visible === undefined ? 1 : body.visible ? 1 : 0,
        JSON.stringify(normalizePermissionList(body.permissions ?? body.permissions_json)),
        JSON.stringify(normalizeConditions(body.entry_conditions ?? body.entryConditions, "entry_conditions")),
        JSON.stringify(normalizeConditions(body.exit_conditions ?? body.exitConditions, "exit_conditions")),
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "State code already exists in this lifecycle version");
    throw err;
  }
  if (body.is_initial || body.isInitial) {
    run(db, "UPDATE lifecycle_states SET is_initial = 0 WHERE lifecycle_version_id = ? AND id != ?", [context.version.id, result.lastInsertRowid]);
  }
  writeAudit(db, { actor, action: "lifecycle.state.create", resourceType: "lifecycle_state", resourceId: result.lastInsertRowid, details: { code: body.code }, ip });
  return publicState(getStateRow(db, result.lastInsertRowid));
}

export function updateState(db, id, body, actor, ip, tenantId) {
  const row = getStateRow(db, id);
  if (!row) throw new HttpError(404, "State not found");
  const context = assertDraftVersion(db, row.lifecycle_version_id, tenantId, actor);
  if (body.code && body.code !== row.code) validateCode(body.code, "State code");
  const status =
    body.status_id !== undefined || body.statusId !== undefined || body.status_code !== undefined || body.statusCode !== undefined
      ? normalizeStateStatus(db, body, context.definition, tenantId)
      : row.status_id
        ? statuses.findStatus(db, row.status_id, tenantId)
        : null;
  const category = body.category === undefined ? row.category : assertCategory(body.category);
  try {
    run(
      db,
      `UPDATE lifecycle_states SET
        code = ?, name = ?, description = ?, status_id = ?, category = ?, is_initial = ?, is_terminal = ?,
        display_order = ?, editable = ?, visible = ?, permissions_json = ?, entry_conditions_json = ?,
        exit_conditions_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        status?.id ?? null,
        category,
        body.is_initial === undefined && body.isInitial === undefined ? row.is_initial : body.is_initial || body.isInitial ? 1 : 0,
        body.is_terminal === undefined && body.isTerminal === undefined ? row.is_terminal : body.is_terminal || body.isTerminal ? 1 : 0,
        body.display_order === undefined && body.displayOrder === undefined ? row.display_order : Number(body.display_order ?? body.displayOrder) || 0,
        body.editable === undefined ? row.editable : body.editable ? 1 : 0,
        body.visible === undefined ? row.visible : body.visible ? 1 : 0,
        body.permissions === undefined && body.permissions_json === undefined
          ? row.permissions_json
          : JSON.stringify(normalizePermissionList(body.permissions ?? body.permissions_json)),
        body.entry_conditions === undefined && body.entryConditions === undefined
          ? row.entry_conditions_json
          : JSON.stringify(normalizeConditions(body.entry_conditions ?? body.entryConditions, "entry_conditions")),
        body.exit_conditions === undefined && body.exitConditions === undefined
          ? row.exit_conditions_json
          : JSON.stringify(normalizeConditions(body.exit_conditions ?? body.exitConditions, "exit_conditions")),
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "State code already exists in this lifecycle version");
    throw err;
  }
  if (body.is_initial || body.isInitial) {
    run(db, "UPDATE lifecycle_states SET is_initial = 0 WHERE lifecycle_version_id = ? AND id != ?", [row.lifecycle_version_id, row.id]);
  }
  writeAudit(db, { actor, action: "lifecycle.state.update", resourceType: "lifecycle_state", resourceId: row.id, details: { code: row.code }, ip });
  return publicState(getStateRow(db, row.id));
}

export function deleteState(db, id, actor, ip, tenantId) {
  const row = getStateRow(db, id);
  if (!row) throw new HttpError(404, "State not found");
  assertDraftVersion(db, row.lifecycle_version_id, tenantId, actor);
  const used = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM lifecycle_transitions WHERE from_state_id = ? OR to_state_id = ?",
    [row.id, row.id]
  ).c;
  if (used) throw new HttpError(409, "Cannot delete a state referenced by transitions");
  run(db, "DELETE FROM lifecycle_states WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "lifecycle.state.delete", resourceType: "lifecycle_state", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

function normalizePermissionList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new HttpError(400, "permissions must be an array");
  return value.map(String);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function publicTransition(row) {
  if (!row) return null;
  return {
    id: row.id,
    lifecycle_version_id: row.lifecycle_version_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    from_state_id: row.from_state_id,
    from_state_code: row.from_state_code ?? null,
    to_state_id: row.to_state_id,
    to_state_code: row.to_state_code ?? null,
    required_permission: row.required_permission || "",
    required_role: row.required_role || "",
    requires_approval: row.requires_approval === 1,
    approval_rule_id: row.approval_rule_id ?? null,
    auto_approve: row.auto_approve === 1,
    conditions: safeParse(row.conditions_json, {}),
    display_order: row.display_order,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const TRANSITION_SELECT = `
  SELECT t.*, fs.code AS from_state_code, ts.code AS to_state_code
  FROM lifecycle_transitions t
  LEFT JOIN lifecycle_states fs ON fs.id = t.from_state_id
  LEFT JOIN lifecycle_states ts ON ts.id = t.to_state_id
`;

export function getTransitionRow(db, id) {
  return queryOne(db, `${TRANSITION_SELECT} WHERE t.id = ?`, [Number(id)]);
}

function resolveStateRef(db, versionId, value, label) {
  if (value === undefined || value === null || value === "") throw new HttpError(400, `${label} is required`);
  const text = String(value);
  const row = /^\d+$/.test(text)
    ? queryOne(db, "SELECT * FROM lifecycle_states WHERE id = ? AND lifecycle_version_id = ?", [Number(text), versionId])
    : queryOne(db, "SELECT * FROM lifecycle_states WHERE code = ? AND lifecycle_version_id = ?", [text, versionId]);
  if (!row) throw new HttpError(400, `${label} not found in this lifecycle version`);
  return row;
}

export function listTransitions(db, query = {}, tenantId) {
  const versionId = Number(query.versionId || query.version_id || query.lifecycle_version_id);
  if (!versionId) throw new HttpError(400, "versionId is required");
  const context = versionContext(db, versionId);
  assertReadable(context.definition, tenantId, "Lifecycle definition not found");
  const where = ["t.lifecycle_version_id = ?"];
  const params = [versionId];
  if (query.fromStateId || query.from_state_id) {
    where.push("t.from_state_id = ?");
    params.push(Number(query.fromStateId || query.from_state_id));
  }
  if (query.toStateId || query.to_state_id) {
    where.push("t.to_state_id = ?");
    params.push(Number(query.toStateId || query.to_state_id));
  }
  if (query.status) {
    where.push("t.status = ?");
    params.push(query.status);
  }
  return {
    items: queryAll(db, `${TRANSITION_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.display_order, t.code`, params).map(publicTransition),
  };
}

export function createTransition(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name", "lifecycle_version_id", "from_state", "to_state"]);
  validateCode(body.code, "Transition code");
  const context = assertDraftVersion(db, body.lifecycle_version_id, tenantId, actor);
  const from = resolveStateRef(db, context.version.id, body.from_state ?? body.from ?? body.from_state_id, "from_state");
  const to = resolveStateRef(db, context.version.id, body.to_state ?? body.to ?? body.to_state_id, "to_state");
  const status = assertOneOf(body.status || "active", TRANSITION_STATUSES, "status");
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO lifecycle_transitions
        (lifecycle_version_id, code, name, description, from_state_id, to_state_id, required_permission,
         required_role, requires_approval, approval_rule_id, auto_approve, conditions_json, display_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.version.id,
        body.code,
        String(body.name).trim(),
        body.description || "",
        from.id,
        to.id,
        body.required_permission || body.requiredPermission || "",
        body.required_role || body.requiredRole || "",
        body.requires_approval || body.requiresApproval ? 1 : 0,
        body.approval_rule_id ?? body.approvalRuleId ?? null,
        body.auto_approve || body.autoApprove ? 1 : 0,
        JSON.stringify(normalizeConditions(body.conditions, "conditions")),
        Number(body.display_order ?? body.displayOrder ?? 0) || 0,
        status,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Transition code already exists in this lifecycle version");
    throw err;
  }
  writeAudit(db, { actor, action: "lifecycle.transition.create", resourceType: "lifecycle_transition", resourceId: result.lastInsertRowid, details: { code: body.code }, ip });
  return publicTransition(getTransitionRow(db, result.lastInsertRowid));
}

export function updateTransition(db, id, body, actor, ip, tenantId) {
  const row = getTransitionRow(db, id);
  if (!row) throw new HttpError(404, "Transition not found");
  const context = assertDraftVersion(db, row.lifecycle_version_id, tenantId, actor);
  if (body.code && body.code !== row.code) validateCode(body.code, "Transition code");
  const from = body.from_state === undefined && body.from === undefined && body.from_state_id === undefined
    ? null
    : resolveStateRef(db, context.version.id, body.from_state ?? body.from ?? body.from_state_id, "from_state");
  const to = body.to_state === undefined && body.to === undefined && body.to_state_id === undefined
    ? null
    : resolveStateRef(db, context.version.id, body.to_state ?? body.to ?? body.to_state_id, "to_state");
  try {
    run(
      db,
      `UPDATE lifecycle_transitions SET
        code = ?, name = ?, description = ?, from_state_id = ?, to_state_id = ?, required_permission = ?,
        required_role = ?, requires_approval = ?, approval_rule_id = ?, auto_approve = ?, conditions_json = ?,
        display_order = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        from?.id ?? row.from_state_id,
        to?.id ?? row.to_state_id,
        body.required_permission ?? body.requiredPermission ?? row.required_permission,
        body.required_role ?? body.requiredRole ?? row.required_role,
        body.requires_approval === undefined && body.requiresApproval === undefined
          ? row.requires_approval
          : body.requires_approval || body.requiresApproval
            ? 1
            : 0,
        body.approval_rule_id === undefined && body.approvalRuleId === undefined ? row.approval_rule_id : body.approval_rule_id ?? body.approvalRuleId,
        body.auto_approve === undefined && body.autoApprove === undefined ? row.auto_approve : body.auto_approve || body.autoApprove ? 1 : 0,
        body.conditions === undefined ? row.conditions_json : JSON.stringify(normalizeConditions(body.conditions, "conditions")),
        body.display_order === undefined && body.displayOrder === undefined ? row.display_order : Number(body.display_order ?? body.displayOrder) || 0,
        body.status === undefined ? row.status : assertOneOf(body.status, TRANSITION_STATUSES, "status"),
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Transition code already exists in this lifecycle version");
    throw err;
  }
  writeAudit(db, { actor, action: "lifecycle.transition.update", resourceType: "lifecycle_transition", resourceId: row.id, details: { code: row.code }, ip });
  return publicTransition(getTransitionRow(db, row.id));
}

export function deleteTransition(db, id, actor, ip, tenantId) {
  const row = getTransitionRow(db, id);
  if (!row) throw new HttpError(404, "Transition not found");
  assertDraftVersion(db, row.lifecycle_version_id, tenantId, actor);
  run(db, "DELETE FROM lifecycle_transitions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "lifecycle.transition.delete", resourceType: "lifecycle_transition", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

// ---------------------------------------------------------------------------
// Object-type assignments
// ---------------------------------------------------------------------------

export function publicAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    type_id: row.type_id,
    type_code: row.type_code ?? null,
    lifecycle_definition_id: row.lifecycle_definition_id,
    lifecycle_code: row.lifecycle_code ?? null,
    lifecycle_version_id: row.lifecycle_version_id ?? null,
    version: row.version ?? null,
    is_default: row.is_default === 1,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, t.code AS type_code, d.code AS lifecycle_code, v.version AS version
  FROM lifecycle_type_assignments a
  LEFT JOIN metadata_types t ON t.id = a.type_id
  LEFT JOIN lifecycle_definitions d ON d.id = a.lifecycle_definition_id
  LEFT JOIN lifecycle_versions v ON v.id = a.lifecycle_version_id
`;

export function listAssignments(db, query = {}, tenantId) {
  const scope = tenantClause("a", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.typeId || query.type_id) {
    where.push("a.type_id = ?");
    params.push(Number(query.typeId || query.type_id));
  }
  if (query.lifecycleId || query.lifecycle_id || query.lifecycleDefinitionId) {
    where.push("a.lifecycle_definition_id = ?");
    params.push(Number(query.lifecycleId || query.lifecycle_id || query.lifecycleDefinitionId));
  }
  return {
    items: queryAll(db, `${ASSIGNMENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.code`, params).map(publicAssignment),
  };
}

export function createAssignment(db, body, actor, ip, reqTenantId) {
  requireFields(body, ["type", "lifecycle"]);
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const type = metadata.findType(db, body.type ?? body.type_id ?? body.typeCode, tenantId);
  if (!type) throw new HttpError(404, "Object type not found");
  const definition = findDefinition(db, body.lifecycle ?? body.lifecycle_definition_id ?? body.lifecycleCode, tenantId);
  assertMutable(db, definition, tenantId, actor, "Lifecycle definition not found");
  const published = publishedVersionRow(db, definition.id);
  if (!published) throw new HttpError(409, "Lifecycle has no published version to assign");
  const ts = nowIso();
  const existing = queryOne(
    db,
    "SELECT * FROM lifecycle_type_assignments WHERE type_id = ? AND COALESCE(tenant_id, 0) = ?",
    [type.id, tenantId ?? 0]
  );
  let id;
  if (existing) {
    run(
      db,
      "UPDATE lifecycle_type_assignments SET lifecycle_definition_id = ?, lifecycle_version_id = ?, is_default = ?, status = ?, updated_at = ? WHERE id = ?",
      [definition.id, published.id, body.is_default === false || body.isDefault === false ? 0 : 1, body.status || "active", ts, existing.id]
    );
    id = existing.id;
  } else {
    const result = run(
      db,
      `INSERT INTO lifecycle_type_assignments
        (type_id, lifecycle_definition_id, lifecycle_version_id, is_default, status, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [type.id, definition.id, published.id, body.is_default === false || body.isDefault === false ? 0 : 1, body.status || "active", tenantId ?? null, ts, ts]
    );
    id = result.lastInsertRowid;
  }
  writeAudit(db, {
    actor,
    action: "lifecycle.assignment.set",
    resourceType: "lifecycle_assignment",
    resourceId: id,
    details: { type: type.code, lifecycle: definition.code, version: published.version },
    ip,
  });
  return publicAssignment(queryOne(db, `${ASSIGNMENT_SELECT} WHERE a.id = ?`, [id]));
}

export function deleteAssignment(db, id, actor, ip, tenantId) {
  const row = queryOne(db, "SELECT * FROM lifecycle_type_assignments WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Lifecycle assignment not found");
  assertMutable(db, row, tenantId, actor, "Lifecycle assignment not found");
  run(db, "DELETE FROM lifecycle_type_assignments WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "lifecycle.assignment.delete", resourceType: "lifecycle_assignment", resourceId: row.id, ip });
  return { deleted: true, id: row.id };
}

// Resolves the effective assignment for a type: tenant row first, then global.
export function resolveAssignment(db, typeId, tenantId) {
  if (!typeId) return null;
  const scope = tenantClause("a", tenantId);
  return queryOne(
    db,
    `${ASSIGNMENT_SELECT} WHERE a.type_id = ? AND a.status = 'active' AND ${scope.sql}
     ORDER BY a.tenant_id IS NULL LIMIT 1`,
    [Number(typeId), ...scope.params]
  );
}

export function initialStateForVersion(db, versionId) {
  return queryOne(
    db,
    `${STATE_SELECT} WHERE s.lifecycle_version_id = ? AND s.is_initial = 1 ORDER BY s.display_order LIMIT 1`,
    [Number(versionId)]
  );
}

export function stateByCode(db, versionId, code) {
  return queryOne(db, `${STATE_SELECT} WHERE s.lifecycle_version_id = ? AND s.code = ?`, [Number(versionId), String(code)]);
}

export function transitionsFrom(db, versionId, stateId) {
  return queryAll(
    db,
    `${TRANSITION_SELECT} WHERE t.lifecycle_version_id = ? AND t.from_state_id = ? AND t.status = 'active'
     ORDER BY t.display_order, t.code`,
    [Number(versionId), Number(stateId)]
  ).map(publicTransition);
}

export function readDefinitionTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}
