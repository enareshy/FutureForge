import { HttpError } from "../../validation.js";
import { DECISION_REASONS, SECURITY_EFFECTS, SECURITY_ACTIONS } from "./constants.js";

export { HttpError };

export function securityError(status, message, code) {
  const error = new HttpError(status, message);
  if (code) error.code = code;
  return error;
}

export function assertionError(message, code) {
  return securityError(400, message, code);
}

export function notFoundError(message) {
  return securityError(404, message, "NOT_FOUND");
}

export function conflictError(message) {
  return securityError(409, message, "CONFLICT");
}

export function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw assertionError(`${name} is required`);
  }
  return value.trim();
}

export function optionalString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function requireId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw assertionError(`${name} must be a positive integer`);
  }
  return id;
}

export function optionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export function requireAction(value, { allowList = false } = {}) {
  const action = String(value || "").trim();
  const allowed = allowList ? [...SECURITY_ACTIONS, "manage"] : SECURITY_ACTIONS;
  if (!allowed.includes(action)) {
    throw assertionError(`Unknown action "${value}"`);
  }
  return action;
}

export function requireEffect(value) {
  const effect = String(value || "").trim();
  if (!SECURITY_EFFECTS.includes(effect)) {
    throw assertionError(`Unknown effect "${value}"`);
  }
  return effect;
}

export function requireReason(value) {
  const reason = String(value || "").trim();
  if (!Object.values(DECISION_REASONS).includes(reason)) {
    throw assertionError(`Unknown reason "${value}"`);
  }
  return reason;
}
