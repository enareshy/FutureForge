import { HttpError } from "../../validation.js";

// Shared vocabulary and pure helpers for the Lifecycle Management module. Keeping
// the controlled vocabularies here stops business logic from hard-coding status or
// lifecycle strings.

export const STATUS_CATEGORIES = ["draft", "in_review", "approved", "released", "obsolete", "cancelled"];
export const LEGACY_OBJECT_STATUSES = ["draft", "active", "released", "obsolete", "archived"];
export const DEFINITION_STATUSES = ["draft", "published", "inactive", "archived"];
export const VERSION_STATUSES = ["draft", "published", "archived"];
export const TRANSITION_STATUSES = ["active", "inactive"];
export const APPROVAL_RULE_KINDS = ["release", "approval"];
export const APPROVER_TYPES = ["role", "user", "organization"];
export const APPROVAL_MODES = ["any", "all", "min"];
export const RELEASE_STATUSES = ["pending", "approved", "rejected", "changes_requested", "cancelled"];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "changes_requested", "cancelled", "skipped"];
export const APPROVAL_DECISIONS = ["approve", "reject", "request_changes", "resubmit"];
export const HISTORY_SOURCES = ["manual", "approval", "system"];

export function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function assertCategory(value, label = "category") {
  return assertOneOf(value, STATUS_CATEGORIES, label);
}

// Conditions are metadata expression trees (or `{}` for "always"). They are stored
// as JSON so the evaluator can be swapped without a schema change.
export function normalizeConditions(value, label = "conditions") {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object expression`);
  }
  return value;
}

export function hasConditions(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.op);
}

export function safeParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Validates a lifecycle's state machine. Rejects duplicated/foreign references and,
// critically, any definition where a state cannot reach a terminal state — i.e. an
// unintended cycle that would trap objects forever. Rework loops that still lead to
// a terminal state are permitted.
export function validateTransitionGraph(states = [], transitions = []) {
  const errors = [];
  const byId = new Map(states.map((s) => [Number(s.id), s]));
  const codes = new Set();
  for (const state of states) {
    if (codes.has(state.code)) errors.push({ field: `states.${state.code}`, message: `Duplicate state code ${state.code}` });
    codes.add(state.code);
  }
  const initials = states.filter((s) => s.is_initial === 1 || s.is_initial === true);
  if (initials.length !== 1) {
    errors.push({ field: "states.initial", message: `Exactly one initial state is required (found ${initials.length})` });
  }
  const terminals = states.filter((s) => s.is_terminal === 1 || s.is_terminal === true);
  if (!terminals.length) {
    errors.push({ field: "states.terminal", message: "At least one terminal state is required" });
  }
  const seen = new Set();
  for (const t of transitions) {
    if (seen.has(t.code)) errors.push({ field: `transitions.${t.code}`, message: `Duplicate transition code ${t.code}` });
    seen.add(t.code);
    if (!byId.has(Number(t.from_state_id))) {
      errors.push({ field: `transitions.${t.code}`, message: "from_state does not belong to this lifecycle version" });
    }
    if (!byId.has(Number(t.to_state_id))) {
      errors.push({ field: `transitions.${t.code}`, message: "to_state does not belong to this lifecycle version" });
    }
    const from = byId.get(Number(t.from_state_id));
    if (from && (from.is_terminal === 1 || from.is_terminal === true)) {
      errors.push({ field: `transitions.${t.code}`, message: `Transition leaves terminal state ${from.code}` });
    }
  }
  // Reverse reachability: every state must lead to a terminal state.
  const incoming = new Map();
  for (const state of states) incoming.set(Number(state.id), []);
  for (const t of transitions) {
    if (incoming.has(Number(t.to_state_id))) incoming.get(Number(t.to_state_id)).push(Number(t.from_state_id));
  }
  const reachesTerminal = new Set(terminals.map((s) => Number(s.id)));
  const queue = [...reachesTerminal];
  while (queue.length) {
    const current = queue.shift();
    for (const source of incoming.get(current) || []) {
      if (!reachesTerminal.has(source)) {
        reachesTerminal.add(source);
        queue.push(source);
      }
    }
  }
  for (const state of states) {
    if (!reachesTerminal.has(Number(state.id))) {
      errors.push({
        field: `states.${state.code}`,
        message: `State ${state.code} cannot reach a terminal state (circular transition trap)`,
      });
    }
  }
  // Reachability from the initial state (informational but catches orphans).
  if (initials.length === 1) {
    const outgoing = new Map();
    for (const state of states) outgoing.set(Number(state.id), []);
    for (const t of transitions) {
      if (outgoing.has(Number(t.from_state_id))) outgoing.get(Number(t.from_state_id)).push(Number(t.to_state_id));
    }
    const reached = new Set([Number(initials[0].id)]);
    const walk = [Number(initials[0].id)];
    while (walk.length) {
      const current = walk.shift();
      for (const target of outgoing.get(current) || []) {
        if (!reached.has(target)) {
          reached.add(target);
          walk.push(target);
        }
      }
    }
    for (const state of states) {
      if (!reached.has(Number(state.id))) {
        errors.push({ field: `states.${state.code}`, message: `State ${state.code} is unreachable from the initial state` });
      }
    }
  }
  return errors;
}
