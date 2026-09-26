// Central vocabulary for the Data Security & Entitlement Model. Every security
// decision in the platform is expressed with these values so business modules do
// not invent their own actions, effects, scopes or masking strategies.

export const SECURITY_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "execute",
  "export",
  "search",
  "list",
];

export const SECURITY_EFFECTS = ["allow", "deny"];

// The outcome of an authorization decision. MASK means the caller may know the
// object exists but may not see every field.
export const SECURITY_DECISIONS = ["allow", "deny", "mask"];

export const SECURITY_SCOPES = [
  "tenant",
  "organization",
  "plant",
  "object_type",
  "object",
  "classification",
  "attribute",
];

export const SUBJECT_TYPES = ["user", "group", "role", "organization", "everyone"];

export const FIELD_EFFECTS = ["allow", "deny", "mask", "hide"];

export const MASKING_STRATEGIES = [
  "HIDE",
  "NULL",
  "PARTIAL",
  "REDACT",
  "HASH",
  "FIXED_MASK",
  "CUSTOM",
];

export const SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

export const CLASSIFICATION_RANK = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

// Reason codes are part of the API contract and the decision inspector. They
// must remain stable and explicit so an auditor can reconstruct any decision.
export const DECISION_REASONS = {
  TENANT_DENIED: "TENANT_DENIED",
  RBAC_DENIED: "RBAC_DENIED",
  RBAC_ALLOWED: "RBAC_ALLOWED",
  ORGANIZATION_DENIED: "ORGANIZATION_DENIED",
  PLANT_DENIED: "PLANT_DENIED",
  OBJECT_DENIED: "OBJECT_DENIED",
  CLASSIFICATION_DENIED: "CLASSIFICATION_DENIED",
  FIELD_DENIED: "FIELD_DENIED",
  POLICY_ALLOWED: "POLICY_ALLOWED",
  POLICY_DENIED: "POLICY_DENIED",
  ENTITLEMENT_ALLOWED: "ENTITLEMENT_ALLOWED",
  ENTITLEMENT_DENIED: "ENTITLEMENT_DENIED",
  DEFAULT_DENY: "DEFAULT_DENY",
};

export const DECISION_REASON_MESSAGES = {
  TENANT_DENIED: "Subject and resource belong to different tenants",
  RBAC_DENIED: "No role grants this action on the resource",
  RBAC_ALLOWED: "Role based access granted by the permission model",
  ORGANIZATION_DENIED: "Organization scope does not cover the resource",
  PLANT_DENIED: "Plant scope does not cover the resource",
  OBJECT_DENIED: "An explicit object entitlement denies access",
  CLASSIFICATION_DENIED: "Classification rules deny access to this resource",
  FIELD_DENIED: "An explicit field rule denies access",
  POLICY_ALLOWED: "An explicit security policy allows the action",
  POLICY_DENIED: "An explicit security policy denies the action",
  ENTITLEMENT_ALLOWED: "An explicit entitlement allows the action",
  ENTITLEMENT_DENIED: "An explicit entitlement denies the action",
  DEFAULT_DENY: "No matching entitlement; access denied by default",
};

export const POLICY_STATUSES = ["draft", "active", "inactive"];

export const ORGANIZATION_SCOPE_MODES = [
  "own",
  "self_and_descendants",
  "specific",
  "include_descendants",
  "cross",
];

// A registered object type decides whether the row level engine applies.
//   tenant      - only tenant isolation (the legacy default)
//   entitlement - apply entitlements / org / plant / classification predicates
//   policy      - apply policies as well (full ABAC ready evaluation)
export const OBJECT_ENFORCEMENT_MODES = ["tenant", "entitlement", "policy"];

export const DEFAULT_ENFORCEMENT = "tenant";
