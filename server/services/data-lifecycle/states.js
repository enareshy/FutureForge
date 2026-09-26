// Configurable lifecycle state model and the transition graph.
//
// The state set is data, not logic: the system states are installed
// idempotently per tenant and administrators may add their own. Whether a
// transition is allowed is always answered from `lc_state_transitions`, so a
// deployment can tighten or extend the process without a code change.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  DEFAULT_STATES,
  DEFAULT_TRANSITIONS,
  DEFAULT_STATE_TIER_MAP,
  LIFECYCLE_STATES,
  SOURCE_MODULE,
} from "./constants.js";
import { stateRef } from "./refs.js";
import { publicState, publicTransition } from "./repository.js";
import { invalidState, stateNotFound, stateConflict } from "./errors.js";
import { assertCustomState, normalizeText, normalizeUpper, paginate } from "./validation.js";

export { publicState, publicTransition };

export function getStateRow(db, tenantId, code) {
  return queryOne(db, "SELECT * FROM lc_states WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(code)]);
}

export function requireState(db, tenantId, code) {
  const row = getStateRow(db, tenantId, code);
  if (!row) throw stateNotFound(normalizeUpper(code));
  return row;
}

export function listStates(db, { tenantId, status, active } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase() === "inactive" ? "inactive" : "active");
  }
  if (active !== undefined && active !== null && active !== "") {
    clauses.push("active = ?");
    params.push(active ? 1 : 0);
  }
  const rows = queryAll(db, `SELECT * FROM lc_states WHERE ${clauses.join(" AND ")} ORDER BY sequence, code`, params);
  return { items: rows.map(publicState), total: rows.length };
}

export function createState(db, tenantId, input = {}, actor = null, ip = null) {
  const code = assertCustomState(input.code || input.state);
  if (getStateRow(db, tenantId, code)) throw stateConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_states (state_ref, tenant_id, code, name, description, sequence, active, read_allowed, update_allowed, delete_allowed, restore_allowed, export_allowed, archive_eligible, purge_eligible, system, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      stateRef(code),
      Number(tenantId),
      code,
      normalizeText(input.name) || code,
      normalizeText(input.description),
      Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : 500,
      input.active === false ? 0 : 1,
      input.read_allowed === false ? 0 : 1,
      input.update_allowed ? 1 : 0,
      input.delete_allowed ? 1 : 0,
      input.restore_allowed ? 1 : 0,
      input.export_allowed ? 1 : 0,
      input.archive_eligible ? 1 : 0,
      input.purge_eligible ? 1 : 0,
      normalizeText(input.status) === "inactive" ? "inactive" : "active",
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "data_lifecycle.state.create",
    resourceType: "lc_states",
    resourceId: code,
    details: { code },
    ip,
  });
  return publicState(queryOne(db, "SELECT * FROM lc_states WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateState(db, tenantId, code, patch = {}, actor = null, ip = null) {
  const row = requireState(db, tenantId, code);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.name);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.sequence !== undefined) assign("sequence", Number.isFinite(Number(patch.sequence)) ? Number(patch.sequence) : row.sequence);
  if (patch.active !== undefined) assign("active", patch.active ? 1 : 0);
  const flags = [
    "read_allowed",
    "update_allowed",
    "delete_allowed",
    "restore_allowed",
    "export_allowed",
    "archive_eligible",
    "purge_eligible",
  ];
  for (const flag of flags) {
    if (patch[flag] !== undefined) assign(flag, patch[flag] ? 1 : 0);
  }
  if (patch.status !== undefined) assign("status", normalizeText(patch.status).toLowerCase() === "inactive" ? "inactive" : "active");
  if (!changes.length) return publicState(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE lc_states SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  writeAudit(db, {
    actor,
    action: "data_lifecycle.state.update",
    resourceType: "lc_states",
    resourceId: code,
    details: { code, changed: changes.map((c) => c.split(" ")[0]) },
    ip,
  });
  return publicState(queryOne(db, "SELECT * FROM lc_states WHERE id = ?", [row.id]));
}

// ── Transition graph ─────────────────────────────────────────────────────────

export function getTransitionRow(db, tenantId, from, to, action = null) {
  if (action) {
    return queryOne(db, "SELECT * FROM lc_state_transitions WHERE tenant_id = ? AND from_state = ? AND to_state = ? AND action = ?", [
      Number(tenantId),
      normalizeUpper(from),
      normalizeUpper(to),
      normalizeUpper(action),
    ]);
  }
  return queryOne(db, "SELECT * FROM lc_state_transitions WHERE tenant_id = ? AND from_state = ? AND to_state = ?", [
    Number(tenantId),
    normalizeUpper(from),
    normalizeUpper(to),
  ]);
}

export function listTransitions(db, { tenantId, fromState, toState, status } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (fromState) {
    clauses.push("from_state = ?");
    params.push(normalizeUpper(fromState));
  }
  if (toState) {
    clauses.push("to_state = ?");
    params.push(normalizeUpper(toState));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase() === "inactive" ? "inactive" : "active");
  }
  const rows = queryAll(db, `SELECT * FROM lc_state_transitions WHERE ${clauses.join(" AND ")} ORDER BY from_state, to_state`, params);
  return { items: rows.map(publicTransition), total: rows.length };
}

export function createTransition(db, tenantId, input = {}, actor = null, ip = null) {
  const from = normalizeUpper(input.from_state || input.from);
  const to = normalizeUpper(input.to_state || input.to);
  if (!from || !to) throw invalidState("Both from_state and to_state are required");
  if (from === to) throw invalidState("A transition cannot target the same state");
  requireState(db, tenantId, from);
  requireState(db, tenantId, to);
  const action = normalizeUpper(input.action || "CHANGE_STATE");
  if (getTransitionRow(db, tenantId, from, to, action)) {
    throw invalidState(`Transition ${from} -> ${to} already exists`, { from, to });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_state_transitions (tenant_id, from_state, to_state, action, description, requires_legal_hold_clear, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      from,
      to,
      action,
      normalizeText(input.description),
      input.requires_legal_hold_clear ? 1 : 0,
      normalizeText(input.status).toLowerCase() === "inactive" ? "inactive" : "active",
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "data_lifecycle.transition.create",
    resourceType: "lc_state_transitions",
    resourceId: `${from}->${to}`,
    details: { from, to, action },
    ip,
  });
  return publicTransition(queryOne(db, "SELECT * FROM lc_state_transitions WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function setTransitionStatus(db, tenantId, id, status, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM lc_state_transitions WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]);
  if (!row) throw invalidState(`Transition ${id} not found`);
  const next = normalizeText(status).toLowerCase() === "inactive" ? "inactive" : "active";
  run(db, "UPDATE lc_state_transitions SET status = ?, updated_at = ? WHERE id = ?", [next, nowIso(), row.id]);
  writeAudit(db, { actor, action: "data_lifecycle.transition.status", resourceType: "lc_state_transitions", resourceId: row.id, details: { status: next }, ip });
  return publicTransition(queryOne(db, "SELECT * FROM lc_state_transitions WHERE id = ?", [row.id]));
}

// All active transitions leaving `from` for the tenant. Falls back to the
// declarative defaults only when a tenant has no transition rows at all.
export function allowedTransitions(db, tenantId, from) {
  const rows = queryAll(
    db,
    "SELECT * FROM lc_state_transitions WHERE tenant_id = ? AND from_state = ? AND status = 'active' ORDER BY to_state",
    [Number(tenantId), normalizeUpper(from)]
  );
  if (rows.length) return rows;
  return DEFAULT_TRANSITIONS.filter((t) => t.from_state === normalizeUpper(from));
}

export function assertTransition(db, tenantId, from, to, { requireLegalHoldClear = null } = {}) {
  const normalizedFrom = normalizeUpper(from);
  const normalizedTo = normalizeUpper(to);
  const row = getTransitionRow(db, tenantId, normalizedFrom, normalizedTo);
  if (row && row.status !== "active") {
    throw invalidState(`Transition ${normalizedFrom} -> ${normalizedTo} is disabled`, { from: normalizedFrom, to: normalizedTo });
  }
  if (!row) {
    const fallback = DEFAULT_TRANSITIONS.find((t) => t.from_state === normalizedFrom && t.to_state === normalizedTo);
    if (!fallback) {
      const allowed = allowedTransitions(db, tenantId, normalizedFrom).map((t) => t.to_state);
      throw invalidState(`Transition ${normalizedFrom} -> ${normalizedTo} is not permitted`, { from: normalizedFrom, to: normalizedTo, allowed });
    }
    return { ...fallback, requires_legal_hold_clear: requireLegalHoldClear ? 1 : 0 };
  }
  return row;
}

// Deterministic, idempotent install of the default model for one tenant.
export function ensureDefaultStates(db, tenantId) {
  let states = 0;
  let transitions = 0;
  let tiers = 0;
  const ts = nowIso();
  for (const def of DEFAULT_STATES) {
    if (getStateRow(db, tenantId, def.code)) continue;
    run(
      db,
      `INSERT INTO lc_states (state_ref, tenant_id, code, name, description, sequence, active, read_allowed, update_allowed, delete_allowed, restore_allowed, export_allowed, archive_eligible, purge_eligible, system, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      [
        stateRef(def.code),
        Number(tenantId),
        def.code,
        def.name,
        def.description,
        def.sequence,
        def.read_allowed ? 1 : 0,
        def.update_allowed ? 1 : 0,
        def.delete_allowed ? 1 : 0,
        def.restore_allowed ? 1 : 0,
        def.export_allowed ? 1 : 0,
        def.archive_eligible ? 1 : 0,
        def.purge_eligible ? 1 : 0,
        ts,
        ts,
      ]
    );
    states += 1;
  }
  for (const def of DEFAULT_TRANSITIONS) {
    if (getTransitionRow(db, tenantId, def.from_state, def.to_state, def.action)) continue;
    run(
      db,
      `INSERT INTO lc_state_transitions (tenant_id, from_state, to_state, action, description, requires_legal_hold_clear, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, 'active', ?, ?)`,
      [Number(tenantId), def.from_state, def.to_state, def.action, def.to_state === "PURGED" ? 1 : 0, ts, ts]
    );
    transitions += 1;
  }
  for (const [stateCode, tier] of Object.entries(DEFAULT_STATE_TIER_MAP)) {
    const existing = queryOne(db, "SELECT id FROM lc_tier_policies WHERE tenant_id = ? AND state_code = ?", [Number(tenantId), stateCode]);
    if (existing) continue;
    run(
      db,
      `INSERT INTO lc_tier_policies (tenant_id, state_code, data_tier, description, system, status, created_at, updated_at)
       VALUES (?, ?, ?, 'System default tier mapping', 1, 'active', ?, ?)`,
      [Number(tenantId), stateCode, tier, ts, ts]
    );
    tiers += 1;
  }
  return { states, transitions, tiers };
}

export function stateVocabulary() {
  return { lifecycle_states: LIFECYCLE_STATES, source_module: SOURCE_MODULE };
}

export { paginate };
