// Audit action type registry. Every canonical framework action is registered
// as a system action type; business modules may register additional action
// codes at runtime so their events classify correctly without code changes.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  AUDIT_ACTIONS,
  MANDATORY_ACTIONS,
  categoryOfAction,
  validateActionTypeInput,
} from "./validation.js";
import { capture } from "./events.js";

export function publicActionType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    label: row.label || "",
    category: row.category,
    event_type: row.event_type,
    description: row.description || "",
    mandatory: row.mandatory === 1,
    system: row.system === 1,
    active: row.active === 1,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getActionTypeRow(db, code) {
  return queryOne(db, "SELECT * FROM audit_action_types WHERE code = ? COLLATE NOCASE", [String(code || "")]);
}

export function listActionTypes(db, { category, active, mandatory, q } = {}) {
  const where = [];
  const params = [];
  if (category) {
    where.push("category = ?");
    params.push(String(category).toLowerCase());
  }
  if (active !== undefined && active !== "") {
    where.push("active = ?");
    params.push(active === true || active === "true" || active === 1 ? 1 : 0);
  }
  if (mandatory !== undefined && mandatory !== "") {
    where.push("mandatory = ?");
    params.push(mandatory === true || mandatory === "true" || mandatory === 1 ? 1 : 0);
  }
  if (q) {
    const like = `%${String(q)}%`;
    where.push("(code LIKE ? OR label LIKE ? OR description LIKE ?)");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM audit_action_types ${clause} ORDER BY category ASC, code ASC`,
    params
  ).map(publicActionType);
  return { items, total: items.length };
}

export function getActionType(db, code) {
  const row = getActionTypeRow(db, code);
  if (!row) throw new HttpError(404, "Audit action type not found");
  return publicActionType(row);
}

export function createActionType(db, body = {}, actor = null, ip = null) {
  const input = validateActionTypeInput(body, { partial: false });
  if (getActionTypeRow(db, input.code)) throw new HttpError(409, `Audit action type ${input.code} already exists`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO audit_action_types
       (code, label, category, event_type, description, mandatory, system, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      input.code,
      input.label || input.code,
      input.category,
      input.event_type,
      input.description || "",
      input.mandatory ? 1 : 0,
      input.active === false ? 0 : 1,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  capture(db, {
    actor,
    action: "audit.action_type.create",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_action_type",
    object_id: result.lastInsertRowid,
    object_name: input.code,
    details: { category: input.category, event_type: input.event_type },
    ip,
  });
  return getActionType(db, input.code);
}

export function updateActionType(db, code, body = {}, actor = null, ip = null) {
  const row = getActionTypeRow(db, code);
  if (!row) throw new HttpError(404, "Audit action type not found");
  const input = validateActionTypeInput(body, { partial: true });
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (input.label !== undefined) set("label", input.label);
  if (input.category !== undefined) set("category", input.category);
  if (input.event_type !== undefined) set("event_type", input.event_type);
  if (input.description !== undefined) set("description", input.description);
  if (row.system === 1 && body.mandatory !== undefined) {
    throw new HttpError(409, "Mandatory classification of system action types cannot be changed");
  }
  if (input.mandatory !== undefined) set("mandatory", input.mandatory ? 1 : 0);
  if (input.active !== undefined && row.system !== 1) set("active", input.active ? 1 : 0);
  if (!fields.length) return publicActionType(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE audit_action_types SET ${fields.join(", ")} WHERE id = ?`, params);
  capture(db, {
    actor,
    action: "audit.action_type.update",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_action_type",
    object_id: row.id,
    object_name: row.code,
    details: input,
    ip,
  });
  return getActionType(db, row.code);
}

export function deleteActionType(db, code, actor = null, ip = null) {
  const row = getActionTypeRow(db, code);
  if (!row) throw new HttpError(404, "Audit action type not found");
  if (row.system === 1) throw new HttpError(409, "System action types cannot be deleted");
  run(db, "DELETE FROM audit_action_types WHERE id = ?", [row.id]);
  capture(db, {
    actor,
    action: "audit.action_type.delete",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_action_type",
    object_id: row.id,
    object_name: row.code,
    ip,
  });
  return { ok: true, id: row.id };
}

// Registers the built-in canonical action types once. Idempotent.
export function ensureSystemActionTypes(db) {
  let created = 0;
  for (const action of AUDIT_ACTIONS) {
    const code = action.toLowerCase();
    if (getActionTypeRow(db, code)) continue;
    run(
      db,
      `INSERT INTO audit_action_types
         (code, label, category, event_type, description, mandatory, system, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, 1, 1, ?, ?)`,
      [
        code,
        action.replace(/_/g, " ").toLowerCase(),
        categoryOfAction(action, action),
        action,
        MANDATORY_ACTIONS.has(action) ? 1 : 0,
        nowIso(),
        nowIso(),
      ]
    );
    created += 1;
  }
  return { created };
}
