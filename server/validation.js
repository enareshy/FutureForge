const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const EMPLOYEE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/;

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) {
    throw new HttpError(400, `Missing required fields: ${missing.join(", ")}`);
  }
}

export function validateUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "Username must start with a letter and be 3-64 characters (letters, digits, . _ -)");
  }
}

export function validateEmail(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, "Invalid email address");
  }
}

export function validateEmployeeId(id) {
  if (!EMPLOYEE_RE.test(id)) {
    throw new HttpError(400, "Employee ID must be 2-32 alphanumeric characters");
  }
}

export function validateCode(code, label = "Code") {
  if (!CODE_RE.test(code)) {
    throw new HttpError(400, `${label} must be lowercase, start with a letter, 2-64 chars`);
  }
}

export const ACTIONS = ["create", "read", "update", "delete", "execute"];
export const EFFECTS = ["allow", "deny"];

export function assertAction(action) {
  if (!ACTIONS.includes(action)) {
    throw new HttpError(400, "Action must be create, read, update, delete or execute");
  }
}

export function assertEffect(effect) {
  if (!EFFECTS.includes(effect)) {
    throw new HttpError(400, "Effect must be allow or deny");
  }
}

export function validatePasswordAgainstPolicy(password, policy) {
  const errors = [];
  if (typeof password !== "string") {
    throw new HttpError(400, "Password is required");
  }
  if (password.length < policy.min_length) {
    errors.push(`Must be at least ${policy.min_length} characters`);
  }
  if (password.length > 128) {
    errors.push("Must be at most 128 characters");
  }
  if (policy.require_uppercase && !/[A-Z]/.test(password)) {
    errors.push("Must include an uppercase letter");
  }
  if (policy.require_lowercase && !/[a-z]/.test(password)) {
    errors.push("Must include a lowercase letter");
  }
  if (policy.require_digit && !/[0-9]/.test(password)) {
    errors.push("Must include a digit");
  }
  if (policy.require_special && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Must include a special character");
  }
  if (errors.length) {
    throw new HttpError(400, "Password does not meet policy", errors);
  }
}

export function pagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function orgScope(value) {
  if (value === undefined || value === null || value === "" || value === "global") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "Invalid organization scope");
  }
  return n;
}
