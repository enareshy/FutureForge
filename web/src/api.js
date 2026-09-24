const TOKEN_KEY = "helix_iam_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, { method = "GET", body, headers: extraHeaders } = {}) {
  const headers = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export async function apiDownload(path, { method = "GET", body } = {}) {
  const headers = { Accept: "*/*" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      message = data?.error || message;
    } catch {
      /* keep default message */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  return {
    blob: await res.blob(),
    filename: match ? match[1] : "audit-export",
    count: Number(res.headers.get("X-Audit-Export-Count") || 0),
  };
}

export async function apiUpload(path, { method = "POST", body, contentType = "application/octet-stream" } = {}) {
  const headers = { Accept: "application/json", "Content-Type": contentType };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export const iam = {
  login: (username, password, provider) =>
    api("/api/authentication/login", { method: "POST", body: { username, password, provider } }),
  me: () => api("/api/auth/me"),
  logout: () => api("/api/authentication/logout", { method: "POST" }),
  authProviders: () => api("/api/authentication/providers"),
  authProvidersAdmin: () => api("/api/authentication/providers/admin"),
  createAuthProvider: (body) => api("/api/authentication/providers", { method: "POST", body }),
  updateAuthProvider: (id, body) => api(`/api/authentication/providers/${id}`, { method: "PUT", body }),
  authSettings: () => api("/api/authentication/settings"),
  updateAuthSettings: (body) => api("/api/authentication/settings", { method: "PUT", body }),
  requestPasswordReset: (body) => api("/api/authentication/password-reset/request", { method: "POST", body }),
  completePasswordReset: (body) => api("/api/authentication/password-reset/complete", { method: "POST", body }),
  mySessions: () => api("/api/sessions"),
  revokeSession: (id) => api(`/api/sessions/${id}`, { method: "DELETE" }),
  revokeAllSessions: () => api("/api/sessions/revoke-all", { method: "POST" }),
  adminSessions: (qs) => api(`/api/sessions/admin${qs || ""}`),
  adminRevokeSession: (id) => api(`/api/sessions/admin/${id}`, { method: "DELETE" }),
  mfaStatus: () => api("/api/mfa/status"),
  mfaEnroll: () => api("/api/mfa/totp/enroll", { method: "POST" }),
  mfaVerifyEnroll: (code) => api("/api/mfa/totp/verify", { method: "POST", body: { code } }),
  mfaDisable: (body) => api("/api/mfa/totp/disable", { method: "POST", body }),
  mfaRecovery: (code) => api("/api/mfa/recovery/regenerate", { method: "POST", body: { code } }),
  mfaChallenge: (body) => api("/api/mfa/challenge/verify", { method: "POST", body }),
  adminResetMfa: (userId) => api(`/api/mfa/admin/${userId}/reset`, { method: "POST" }),
  ssoProviders: () => api("/api/sso/providers"),
  ssoStart: (code, body) => api(`/api/sso/${code}/start`, { method: "POST", body }),
  ssoCallback: (code, body) => api(`/api/sso/${code}/callback`, { method: "POST", body }),
  users: (qs) => api(`/api/users${qs || ""}`),
  user: (id) => api(`/api/users/${id}`),
  createUser: (body) => api("/api/users", { method: "POST", body }),
  updateUser: (id, body) => api(`/api/users/${id}`, { method: "PUT", body }),
  activate: (id) => api(`/api/users/${id}/activate`, { method: "POST" }),
  deactivate: (id) => api(`/api/users/${id}/deactivate`, { method: "POST" }),
  lock: (id) => api(`/api/users/${id}/lock`, { method: "POST" }),
  unlock: (id) => api(`/api/users/${id}/unlock`, { method: "POST" }),
  resetPassword: (id, password) =>
    api(`/api/users/${id}/reset-password`, { method: "POST", body: { password } }),
  assignUserRole: (id, roleId, organizationId) =>
    api(`/api/users/${id}/roles`, { method: "POST", body: { roleId, organizationId } }),
  unassignUserRole: (id, roleId, organizationId) =>
    api(`/api/users/${id}/roles/${roleId}?organizationId=${organizationId ?? 0}`, { method: "DELETE" }),
  addUserGroup: (id, groupId) => api(`/api/users/${id}/groups`, { method: "POST", body: { groupId } }),
  removeUserGroup: (id, groupId) => api(`/api/users/${id}/groups/${groupId}`, { method: "DELETE" }),
  groups: (qs) => api(`/api/groups${qs || ""}`),
  group: (id) => api(`/api/groups/${id}`),
  createGroup: (body) => api("/api/groups", { method: "POST", body }),
  updateGroup: (id, body) => api(`/api/groups/${id}`, { method: "PUT", body }),
  deleteGroup: (id) => api(`/api/groups/${id}`, { method: "DELETE" }),
  addMember: (id, userId) => api(`/api/groups/${id}/members`, { method: "POST", body: { userId } }),
  removeMember: (id, userId) => api(`/api/groups/${id}/members/${userId}`, { method: "DELETE" }),
  assignGroupRole: (id, roleId, organizationId) =>
    api(`/api/groups/${id}/roles`, { method: "POST", body: { roleId, organizationId } }),
  unassignGroupRole: (id, roleId, organizationId) =>
    api(`/api/groups/${id}/roles/${roleId}?organizationId=${organizationId ?? 0}`, { method: "DELETE" }),
  roles: (qs) => api(`/api/roles${qs || ""}`),
  role: (id) => api(`/api/roles/${id}`),
  createRole: (body) => api("/api/roles", { method: "POST", body }),
  updateRole: (id, body) => api(`/api/roles/${id}`, { method: "PUT", body }),
  deleteRole: (id) => api(`/api/roles/${id}`, { method: "DELETE" }),
  orgs: (qs) => api(`/api/organizations${qs || ""}`),
  organization: (id) => api(`/api/organizations/${id}`),
  createOrganization: (body) => api("/api/organizations", { method: "POST", body }),
  updateOrganization: (id, body) => api(`/api/organizations/${id}`, { method: "PUT", body }),
  deleteOrganization: (id) => api(`/api/organizations/${id}`, { method: "DELETE" }),
  activateOrganization: (id) => api(`/api/organizations/${id}/activate`, { method: "POST" }),
  deactivateOrganization: (id) => api(`/api/organizations/${id}/deactivate`, { method: "POST" }),
  orgTree: (qs) => api(`/api/organizations/tree${qs || ""}`),
  orgSites: (id) => api(`/api/organizations/${id}/sites`),
  createSite: (id, body) => api(`/api/organizations/${id}/sites`, { method: "POST", body }),
  moveOrganization: (id, parent_id) =>
    api(`/api/organizations/${id}/move`, { method: "POST", body: { parent_id } }),
  orgMembers: (id) => api(`/api/organizations/${id}/members`),
  addOrgMember: (id, body) => api(`/api/organizations/${id}/members`, { method: "POST", body }),
  removeOrgMember: (id, userId) => api(`/api/organizations/${id}/members/${userId}`, { method: "DELETE" }),
  orgContext: (id) => api(`/api/organizations/${id}/context`),
  companies: (qs) => api(`/api/companies${qs || ""}`),
  businessUnits: (qs) => api(`/api/business-units${qs || ""}`),
  plants: (qs) => api(`/api/plants${qs || ""}`),
  sites: (qs) => api(`/api/sites${qs || ""}`),
  departments: (qs) => api(`/api/departments${qs || ""}`),
  userOrganizations: (id) => api(`/api/users/${id}/organizations`),
  addUserOrganization: (id, body) => api(`/api/users/${id}/organizations`, { method: "POST", body }),
  removeUserOrganization: (id, orgId) => api(`/api/users/${id}/organizations/${orgId}`, { method: "DELETE" }),
  hierarchy: () => api("/api/hierarchy"),
  platformHierarchy: () => api("/api/platform/hierarchy"),
  updatePlatformHierarchy: (body) => api("/api/platform/hierarchy", { method: "PUT", body }),
  platformSettings: () => api("/api/platform/settings"),
  updatePlatformSettings: (body) => api("/api/platform/settings", { method: "PUT", body }),
  policy: () => api("/api/password-policy"),
  updatePolicy: (body) => api("/api/password-policy", { method: "PUT", body }),
  audit: (qs) => api(`/api/audit-logs${qs || ""}`),
  access: (userId) => api(`/api/iam/principals/${userId}/access`),
  applications: () => api("/api/applications"),
  createApplication: (body) => api("/api/applications", { method: "POST", body }),
  resources: (qs) => api(`/api/resources${qs || ""}`),
  createResource: (body) => api("/api/resources", { method: "POST", body }),
  permissions: (qs) => api(`/api/permissions${qs || ""}`),
  createPermission: (body) => api("/api/permissions", { method: "POST", body }),
  deletePermission: (id) => api(`/api/permissions/${id}`, { method: "DELETE" }),
  permissionMatrix: (qs) => api(`/api/permissions/matrix${qs || ""}`),
  rolePermissions: (id) => api(`/api/roles/${id}/permissions`),
  grantRolePermission: (id, body) => api(`/api/roles/${id}/permissions`, { method: "POST", body }),
  revokeRolePermission: (id, permissionId, organizationId) =>
    api(`/api/roles/${id}/permissions/${permissionId}?organizationId=${organizationId ?? 0}`, {
      method: "DELETE",
    }),
  tenants: (qs) => api(`/api/tenants${qs || ""}`),
  tenant: (id) => api(`/api/tenants/${id}`),
  createTenant: (body) => api("/api/tenants", { method: "POST", body }),
  updateTenant: (id, body) => api(`/api/tenants/${id}`, { method: "PUT", body }),
  activateTenant: (id) => api(`/api/tenants/${id}/activate`, { method: "POST" }),
  deactivateTenant: (id) => api(`/api/tenants/${id}/deactivate`, { method: "POST" }),
  deleteTenant: (id) => api(`/api/tenants/${id}`, { method: "DELETE" }),
  selectTenant: (id) => api(`/api/tenants/${id}/select`, { method: "POST" }),
  tenantContext: (id) => api(`/api/tenants/${id}/context`),
  tenantConfig: (id) => api(`/api/tenants/${id}/config`),
  updateTenantConfig: (id, values) =>
    api(`/api/tenants/${id}/config`, { method: "PUT", body: { values } }),
  config: (qs) => api(`/api/config${qs || ""}`),
  updateConfig: (body) => api("/api/config", { method: "PUT", body }),
  checkPermission: (body) => api("/api/authorization/check", { method: "POST", body }),
  effectivePermissions: (userId, qs) => api(`/api/authorization/effective/${userId}${qs || ""}`),
};

export const metadata = {
  types: (qs) => api(`/api/metadata/types${qs || ""}`),
  typeTree: (qs) => api(`/api/metadata/types/tree${qs || ""}`),
  type: (id) => api(`/api/metadata/types/${id}`),
  resolveType: (id) => api(`/api/metadata/types/${id}/resolve`),
  typeContract: (id) => api(`/api/metadata/types/${id}/contract`),
  createType: (body) => api("/api/metadata/types", { method: "POST", body }),
  updateType: (id, body) => api(`/api/metadata/types/${id}`, { method: "PUT", body }),
  deleteType: (id) => api(`/api/metadata/types/${id}`, { method: "DELETE" }),
  setTypeStatus: (id, status) => api(`/api/metadata/types/${id}/status`, { method: "POST", body: { status } }),
  attachAttribute: (id, body) => api(`/api/metadata/types/${id}/attributes`, { method: "POST", body }),
  updateTypeAttribute: (id, attributeId, body) =>
    api(`/api/metadata/types/${id}/attributes/${attributeId}`, { method: "PUT", body }),
  detachAttribute: (id, attributeId) =>
    api(`/api/metadata/types/${id}/attributes/${attributeId}`, { method: "DELETE" }),
  attributes: (qs) => api(`/api/metadata/attributes${qs || ""}`),
  attribute: (id) => api(`/api/metadata/attributes/${id}`),
  createAttribute: (body) => api("/api/metadata/attributes", { method: "POST", body }),
  updateAttribute: (id, body) => api(`/api/metadata/attributes/${id}`, { method: "PUT", body }),
  deleteAttribute: (id) => api(`/api/metadata/attributes/${id}`, { method: "DELETE" }),
  setAttributeStatus: (id, status) =>
    api(`/api/metadata/attributes/${id}/status`, { method: "POST", body: { status } }),
  lovs: (qs) => api(`/api/metadata/lovs${qs || ""}`),
  lov: (id) => api(`/api/metadata/lovs/${id}`),
  createLov: (body) => api("/api/metadata/lovs", { method: "POST", body }),
  updateLov: (id, body) => api(`/api/metadata/lovs/${id}`, { method: "PUT", body }),
  deleteLov: (id) => api(`/api/metadata/lovs/${id}`, { method: "DELETE" }),
  setLovStatus: (id, status) => api(`/api/metadata/lovs/${id}/status`, { method: "POST", body: { status } }),
  addLovValue: (id, body) => api(`/api/metadata/lovs/${id}/values`, { method: "POST", body }),
  updateLovValue: (id, valueId, body) =>
    api(`/api/metadata/lovs/${id}/values/${valueId}`, { method: "PUT", body }),
  removeLovValue: (id, valueId) => api(`/api/metadata/lovs/${id}/values/${valueId}`, { method: "DELETE" }),
  cascadeOptions: (id, qs) => api(`/api/metadata/lovs/${id}/cascade${qs || ""}`),
  forms: (qs) => api(`/api/metadata/forms${qs || ""}`),
  form: (id) => api(`/api/metadata/forms/${id}`),
  createForm: (body) => api("/api/metadata/forms", { method: "POST", body }),
  updateForm: (id, body) => api(`/api/metadata/forms/${id}`, { method: "PUT", body }),
  deleteForm: (id) => api(`/api/metadata/forms/${id}`, { method: "DELETE" }),
  setFormStatus: (id, status) => api(`/api/metadata/forms/${id}/status`, { method: "POST", body: { status } }),
  replaceLayout: (id, body) => api(`/api/metadata/forms/${id}/layout`, { method: "PUT", body }),
  formVersions: (id) => api(`/api/metadata/forms/${id}/versions`),
  renderForm: (id, body) => api(`/api/metadata/forms/${id}/render`, { method: "POST", body }),
  rules: (qs) => api(`/api/metadata/rules${qs || ""}`),
  rule: (id) => api(`/api/metadata/rules/${id}`),
  createRule: (body) => api("/api/metadata/rules", { method: "POST", body }),
  updateRule: (id, body) => api(`/api/metadata/rules/${id}`, { method: "PUT", body }),
  deleteRule: (id) => api(`/api/metadata/rules/${id}`, { method: "DELETE" }),
  setRuleStatus: (id, status) => api(`/api/metadata/rules/${id}/status`, { method: "POST", body: { status } }),
  testRule: (id, context) => api(`/api/metadata/rules/${id}/test`, { method: "POST", body: { context } }),
  validate: (body) => api("/api/metadata/validate", { method: "POST", body }),
  configurations: (qs) => api(`/api/metadata/configurations${qs || ""}`),
  effectiveCatalog: (qs) => api(`/api/metadata/configurations/effective${qs || ""}`),
  setConfiguration: (body) => api("/api/metadata/configurations", { method: "POST", body }),
  deleteConfiguration: (body) => api("/api/metadata/configurations", { method: "DELETE", body }),
};

export const objects = {
  types: () => api("/api/object-types"),
  typeForm: (id, qs) => api(`/api/object-types/${id}/form${qs || ""}`),
  list: (qs) => api(`/api/objects${qs || ""}`),
  summary: () => api("/api/objects/summary"),
  get: (id) => api(`/api/objects/${id}`),
  create: (body) => api("/api/objects", { method: "POST", body }),
  update: (id, body) => api(`/api/objects/${id}`, { method: "PUT", body }),
  remove: (id, force) => api(`/api/objects/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }),
  restore: (id) => api(`/api/objects/${id}/restore`, { method: "POST" }),
  setStatus: (id, status) => api(`/api/objects/${id}/status`, { method: "POST", body: { status } }),
  checkout: (id, body) => api(`/api/objects/${id}/checkout`, { method: "POST", body }),
  checkin: (id, body) => api(`/api/objects/${id}/checkin`, { method: "POST", body }),
  locks: (id) => api(`/api/objects/${id}/locks`),
  versions: (id, qs) => api(`/api/objects/${id}/versions${qs || ""}`),
  version: (id, revision) => api(`/api/objects/${id}/versions/${revision}`),
  relationships: (id, qs) => api(`/api/objects/${id}/relationships${qs || ""}`),
  tree: (id, qs) => api(`/api/objects/${id}/tree${qs || ""}`),
  graph: (id, qs) => api(`/api/objects/${id}/graph${qs || ""}`),
  dependencies: (id) => api(`/api/objects/${id}/dependencies`),
  safeDelete: (id) => api(`/api/objects/${id}/safe-delete`),
  relationshipTypes: (qs) => api(`/api/relationship-types${qs || ""}`),
  relationshipType: (id) => api(`/api/relationship-types/${id}`),
  createRelationshipType: (body) => api("/api/relationship-types", { method: "POST", body }),
  updateRelationshipType: (id, body) => api(`/api/relationship-types/${id}`, { method: "PUT", body }),
  setRelationshipTypeStatus: (id, status) =>
    api(`/api/relationship-types/${id}/status`, { method: "POST", body: { status } }),
  deleteRelationshipType: (id) => api(`/api/relationship-types/${id}`, { method: "DELETE" }),
  relationshipsList: (qs) => api(`/api/relationships${qs || ""}`),
  createRelationship: (body) => api("/api/relationships", { method: "POST", body }),
  validateRelationship: (body) => api("/api/relationships/validate", { method: "POST", body }),
  deleteRelationship: (id, force) =>
    api(`/api/relationships/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }),
  references: (qs) => api(`/api/references${qs || ""}`),
  referencesOrphans: () => api("/api/references/orphans"),
  createReference: (body) => api("/api/references", { method: "POST", body }),
  deleteReference: (id) => api(`/api/references/${id}`, { method: "DELETE" }),
  impact: (objectId, qs) => api(`/api/dependencies/impact?objectId=${objectId}${qs ? `&${qs}` : ""}`),
  cycles: () => api("/api/dependencies/cycles"),
  lifecycle: (id) => api(`/api/objects/${id}/lifecycle`),
  transitions: (id) => api(`/api/objects/${id}/transitions`),
  transition: (id, body) => api(`/api/objects/${id}/transitions`, { method: "POST", body }),
  statusHistory: (id, qs) => api(`/api/objects/${id}/status-history${qs || ""}`),
  releases: (id, qs) => api(`/api/objects/${id}/releases${qs || ""}`),
  requestRelease: (id, body) => api(`/api/objects/${id}/release`, { method: "POST", body }),
  decideApproval: (id, approvalId, body) =>
    api(`/api/objects/${id}/approvals/${approvalId}`, { method: "POST", body }),
};

export const workflow = {
  templates: (qs) => api(`/api/workflow-templates${qs || ""}`),
  template: (id) => api(`/api/workflow-templates/${id}`),
  createTemplate: (body) => api("/api/workflow-templates", { method: "POST", body }),
  updateTemplate: (id, body) => api(`/api/workflow-templates/${id}`, { method: "PUT", body }),
  setTemplateStatus: (id, status) => api(`/api/workflow-templates/${id}/status`, { method: "POST", body: { status } }),
  deleteTemplate: (id) => api(`/api/workflow-templates/${id}`, { method: "DELETE" }),
  versions: (id) => api(`/api/workflow-templates/${id}/versions`),
  createVersion: (id, body) => api(`/api/workflow-templates/${id}/versions`, { method: "POST", body: body || {} }),
  version: (id, version) => api(`/api/workflow-templates/${id}/versions/${version}`),
  validate: (id, body) => api(`/api/workflow-templates/${id}/validate`, { method: "POST", body: body || {} }),
  publish: (id, body) => api(`/api/workflow-templates/${id}/publish`, { method: "POST", body: body || {} }),
  clone: (id, body) => api(`/api/workflow-templates/${id}/clone`, { method: "POST", body: body || {} }),
  designer: (id, qs) => api(`/api/workflow-templates/${id}/designer${qs || ""}`),
  saveDesigner: (id, body) => api(`/api/workflow-templates/${id}/designer`, { method: "PUT", body }),
  autoLayout: (id, body) => api(`/api/workflow-templates/${id}/designer/auto-layout`, { method: "POST", body: body || {} }),
  validateDesigner: (id, body) => api(`/api/workflow-templates/${id}/designer/validate`, { method: "POST", body: body || {} }),
  instances: (qs) => api(`/api/workflow-instances${qs || ""}`),
  instance: (id) => api(`/api/workflow-instances/${id}`),
  startInstance: (body) => api("/api/workflow-instances", { method: "POST", body }),
  instanceNodes: (id) => api(`/api/workflow-instances/${id}/nodes`),
  instanceHistory: (id, qs) => api(`/api/workflow-instances/${id}/history${qs || ""}`),
  cancelInstance: (id, body) => api(`/api/workflow-instances/${id}/cancel`, { method: "POST", body: body || {} }),
  pauseInstance: (id) => api(`/api/workflow-instances/${id}/pause`, { method: "POST", body: {} }),
  resumeInstance: (id) => api(`/api/workflow-instances/${id}/resume`, { method: "POST", body: {} }),
  retryInstance: (id, body) => api(`/api/workflow-instances/${id}/retry`, { method: "POST", body: body || {} }),
  tasks: (qs) => api(`/api/tasks${qs || ""}`),
  task: (id) => api(`/api/tasks/${id}`),
  completeTask: (id, body) => api(`/api/tasks/${id}/complete`, { method: "POST", body: body || {} }),
  assignTask: (id, body) => api(`/api/tasks/${id}/assign`, { method: "POST", body }),
  claimTask: (id) => api(`/api/tasks/${id}/claim`, { method: "POST", body: {} }),
  setTaskStatus: (id, status) => api(`/api/tasks/${id}/status`, { method: "POST", body: { status } }),
  comments: (id) => api(`/api/tasks/${id}/comments`),
  addComment: (id, body) => api(`/api/tasks/${id}/comments`, { method: "POST", body }),
  attachments: (id) => api(`/api/tasks/${id}/attachments`),
  addAttachment: (id, body) => api(`/api/tasks/${id}/attachments`, { method: "POST", body }),
  addSubtask: (id, body) => api(`/api/tasks/${id}/subtasks`, { method: "POST", body }),
  updateSubtask: (id, subtaskId, body) => api(`/api/tasks/${id}/subtasks/${subtaskId}`, { method: "PATCH", body }),
  deleteSubtask: (id, subtaskId) => api(`/api/tasks/${id}/subtasks/${subtaskId}`, { method: "DELETE" }),
  approvals: (qs) => api(`/api/workflow-approvals${qs || ""}`),
  approval: (id) => api(`/api/workflow-approvals/${id}`),
  decideApproval: (id, body) => api(`/api/workflow-approvals/${id}/decision`, { method: "POST", body }),
  routingRules: (qs) => api(`/api/workflow-routing-rules${qs || ""}`),
  createRoutingRule: (body) => api("/api/workflow-routing-rules", { method: "POST", body }),
  escalationRules: (qs) => api(`/api/workflow-escalation-rules${qs || ""}`),
  createEscalationRule: (body) => api("/api/workflow-escalation-rules", { method: "POST", body }),
  sweepEscalations: () => api("/api/workflow-escalations/sweep", { method: "POST", body: {} }),
  notifications: (qs) => api(`/api/workflow-notifications${qs || ""}`),
  readNotification: (id) => api(`/api/workflow-notifications/${id}/read`, { method: "POST", body: {} }),
  notificationTemplates: (qs) => api(`/api/workflow-notification-templates${qs || ""}`),
  createNotificationTemplate: (body) => api("/api/workflow-notification-templates", { method: "POST", body }),
  bindings: (qs) => api(`/api/workflow-bindings${qs || ""}`),
  createBinding: (body) => api("/api/workflow-bindings", { method: "POST", body }),
  delegations: (qs) => api(`/api/workflow-delegations${qs || ""}`),
  createDelegation: (body) => api("/api/workflow-delegations", { method: "POST", body }),
  revokeDelegation: (id) => api(`/api/workflow-delegations/${id}`, { method: "DELETE" }),
  nodeTypes: () => Promise.resolve({ items: [
    "start", "end", "task", "approval", "decision", "parallel", "join", "notification", "timer", "subprocess", "service", "terminate",
  ] }),
};

export const audit = {
  events: (qs) => api(`/api/audit/events${qs || ""}`),
  event: (id) => api(`/api/audit/events/${id}`),
  summary: (qs) => api(`/api/audit/summary${qs || ""}`),
  facets: (qs) => api(`/api/audit/facets${qs || ""}`),
  metrics: (qs) => api(`/api/audit/metrics${qs || ""}`),
  record: (body) => api("/api/audit/events", { method: "POST", body }),
  recordBatch: (events) => api("/api/audit/events/batch", { method: "POST", body: { events } }),
  objectHistory: (objectType, objectId, qs) =>
    api(
      `/api/audit/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/history${qs || ""}`
    ),
  attributeHistory: (objectType, objectId, qs) =>
    api(
      `/api/audit/attributes/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/history${qs || ""}`
    ),
  relationshipHistory: (objectType, objectId, qs) =>
    api(
      `/api/audit/relationships/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/history${qs || ""}`
    ),
  userActivity: (userId, qs) => api(`/api/audit/users/${userId}/activity${qs || ""}`),
  security: (qs) => api(`/api/audit/security${qs || ""}`),
  workflow: (qs) => api(`/api/audit/workflows${qs || ""}`),
  lifecycle: (qs) => api(`/api/audit/lifecycle${qs || ""}`),
  configuration: (qs) => api(`/api/audit/configuration${qs || ""}`),
  exportEvents: (body) => apiDownload("/api/audit/export", { method: "POST", body }),
  exports: (qs) => api(`/api/audit/exports${qs || ""}`),
  exportRequest: (id) => api(`/api/audit/exports/${id}`),
  createExport: (body) => api("/api/audit/exports", { method: "POST", body }),
  downloadExport: (id) => apiDownload(`/api/audit/exports/${id}/download`, { method: "GET" }),
  policies: (qs) => api(`/api/audit/policies${qs || ""}`),
  policy: (id) => api(`/api/audit/policies/${id}`),
  createPolicy: (body) => api("/api/audit/policies", { method: "POST", body }),
  updatePolicy: (id, body) => api(`/api/audit/policies/${id}`, { method: "PUT", body }),
  deletePolicy: (id) => api(`/api/audit/policies/${id}`, { method: "DELETE" }),
  validatePolicy: (body) => api("/api/audit/policies/validate", { method: "POST", body }),
  actionTypes: (qs) => api(`/api/audit/action-types${qs || ""}`),
  createActionType: (body) => api("/api/audit/action-types", { method: "POST", body }),
  updateActionType: (code, body) =>
    api(`/api/audit/action-types/${encodeURIComponent(code)}`, { method: "PUT", body }),
  deleteActionType: (code) =>
    api(`/api/audit/action-types/${encodeURIComponent(code)}`, { method: "DELETE" }),
  filters: (qs) => api(`/api/audit/filters${qs || ""}`),
  createFilter: (body) => api("/api/audit/filters", { method: "POST", body }),
  updateFilter: (id, body) => api(`/api/audit/filters/${id}`, { method: "PUT", body }),
  deleteFilter: (id) => api(`/api/audit/filters/${id}`, { method: "DELETE" }),
  retentionRuns: (qs) => api(`/api/audit/retention/runs${qs || ""}`),
  runRetention: (body) => api("/api/audit/retention/run", { method: "POST", body }),
  retentionPolicies: (qs) => api(`/api/audit/retention/policies${qs || ""}`),
  createRetentionPolicy: (body) => api("/api/audit/retention/policies", { method: "POST", body }),
  updateRetentionPolicy: (id, body) =>
    api(`/api/audit/retention/policies/${id}`, { method: "PUT", body }),
  deleteRetentionPolicy: (id) => api(`/api/audit/retention/policies/${id}`, { method: "DELETE" }),
  executeRetention: (body) => api("/api/audit/retention/execute", { method: "POST", body }),
};

export const notifications = {
  meta: () => api("/api/notifications/meta"),
  inbox: (qs) => api(`/api/notifications${qs || ""}`),
  unreadCount: (qs) => api(`/api/notifications/unread-count${qs || ""}`),
  notification: (id) => api(`/api/notifications/${id}`),
  markRead: (id) => api(`/api/notifications/${id}/read`, { method: "PUT", body: {} }),
  markUnread: (id) => api(`/api/notifications/${id}/unread`, { method: "PUT", body: {} }),
  archive: (id) => api(`/api/notifications/${id}/archive`, { method: "PUT", body: {} }),
  remove: (id) => api(`/api/notifications/${id}`, { method: "DELETE" }),
  markAllRead: () => api("/api/notifications/mark-all-read", { method: "POST", body: {} }),
  archiveAllRead: (qs) => api(`/api/notifications/archive-all-read${qs || ""}`, { method: "POST", body: {} }),
  preferences: () => api("/api/notification-preferences"),
  updatePreferences: (body) => api("/api/notification-preferences", { method: "PUT", body }),
  mandatoryEvents: () => api("/api/notification-preferences/mandatory"),

  templateVariables: () => api("/api/notification-templates/variables"),
  templates: (qs) => api(`/api/notification-templates${qs || ""}`),
  template: (id) => api(`/api/notification-templates/${id}`),
  createTemplate: (body) => api("/api/notification-templates", { method: "POST", body }),
  updateTemplate: (id, body) => api(`/api/notification-templates/${id}`, { method: "PUT", body }),
  setTemplateStatus: (id, status) =>
    api(`/api/notification-templates/${id}/status`, { method: "PUT", body: { status } }),
  deleteTemplate: (id) => api(`/api/notification-templates/${id}`, { method: "DELETE" }),
  templateVersions: (id) => api(`/api/notification-templates/${id}/versions`),
  previewTemplate: (id, context) =>
    api(`/api/notification-templates/${id}/preview`, { method: "POST", body: { context } }),
  testSendTemplate: (id, body) => api(`/api/notification-templates/${id}/test-send`, { method: "POST", body }),

  rules: (qs) => api(`/api/notification-rules${qs || ""}`),
  rule: (id) => api(`/api/notification-rules/${id}`),
  createRule: (body) => api("/api/notification-rules", { method: "POST", body }),
  updateRule: (id, body) => api(`/api/notification-rules/${id}`, { method: "PUT", body }),
  setRuleStatus: (id, status) =>
    api(`/api/notification-rules/${id}/status`, { method: "PUT", body: { status } }),
  deleteRule: (id) => api(`/api/notification-rules/${id}`, { method: "DELETE" }),
  simulateRule: (id, body) => api(`/api/notification-rules/${id}/simulate`, { method: "POST", body }),

  providers: (qs) => api(`/api/notification-providers${qs || ""}`),
  createProvider: (body) => api("/api/notification-providers", { method: "POST", body }),
  updateProvider: (id, body) => api(`/api/notification-providers/${id}`, { method: "PUT", body }),
  testProvider: (id, recipient) =>
    api(`/api/notification-providers/${id}/test`, { method: "POST", body: { recipient } }),
  deleteProvider: (id) => api(`/api/notification-providers/${id}`, { method: "DELETE" }),

  history: (qs) => api(`/api/notification-history${qs || ""}`),
  events: (qs) => api(`/api/notification-events${qs || ""}`),
  event: (id) => api(`/api/notification-events/${id}`),
  publishEvent: (body) => api("/api/notification-events/publish", { method: "POST", body }),
  deliveries: (qs) => api(`/api/notification-deliveries${qs || ""}`),
  deliveryStats: (qs) => api(`/api/notification-deliveries/stats${qs || ""}`),
  processDeliveries: (limit) =>
    api("/api/notification-deliveries/process", { method: "POST", body: { limit } }),
  retryDelivery: (id) => api(`/api/notification-deliveries/${id}/retry`, { method: "POST", body: {} }),
  reminders: (qs) => api(`/api/notification-reminders${qs || ""}`),
  sweepReminders: (limit) => api("/api/notification-reminders/sweep", { method: "POST", body: { limit } }),
};

export const delivery = {
  meta: () => api("/api/delivery/meta"),
  requests: (qs) => api(`/api/delivery/requests${qs || ""}`),
  request: (id) => api(`/api/delivery/requests/${id}`),
  submitRequest: (body) => api("/api/delivery/requests", { method: "POST", body }),
  cancelRequest: (id) => api(`/api/delivery/requests/${id}/cancel`, { method: "POST", body: {} }),
  retryRequest: (id) => api(`/api/delivery/requests/${id}/retry`, { method: "POST", body: {} }),
  attempts: (id) => api(`/api/delivery/requests/${id}/attempts`),
  process: (limit) => api("/api/delivery/process", { method: "POST", body: { limit } }),

  providers: (qs) => api(`/api/delivery/providers${qs || ""}`),
  provider: (id) => api(`/api/delivery/providers/${id}`),
  createProvider: (body) => api("/api/delivery/providers", { method: "POST", body }),
  updateProvider: (id, body) => api(`/api/delivery/providers/${id}`, { method: "PUT", body }),
  setProviderStatus: (id, status) => api(`/api/delivery/providers/${id}/status`, { method: "PUT", body: { status } }),
  testProvider: (id, recipient) => api(`/api/delivery/providers/${id}/test`, { method: "POST", body: { recipient } }),
  deleteProvider: (id) => api(`/api/delivery/providers/${id}`, { method: "DELETE" }),
  providerHealth: (qs) => api(`/api/delivery/provider-health${qs || ""}`),
  providerFailures: (qs) => api(`/api/delivery/provider-failures${qs || ""}`),

  reminders: (qs) => api(`/api/delivery/reminders${qs || ""}`),
  reminder: (id) => api(`/api/delivery/reminders/${id}`),
  createReminder: (body) => api("/api/delivery/reminders", { method: "POST", body }),
  updateReminder: (id, body) => api(`/api/delivery/reminders/${id}`, { method: "PUT", body }),
  cancelReminder: (id) => api(`/api/delivery/reminders/${id}/cancel`, { method: "POST", body: {} }),
  sweepReminders: (limit) => api("/api/delivery/reminders/sweep", { method: "POST", body: { limit } }),

  escalations: (qs) => api(`/api/delivery/escalations${qs || ""}`),
  escalation: (id) => api(`/api/delivery/escalations/${id}`),
  createEscalation: (body) => api("/api/delivery/escalations", { method: "POST", body }),
  cancelEscalation: (id) => api(`/api/delivery/escalations/${id}/cancel`, { method: "POST", body: {} }),
  sweepEscalations: (limit) => api("/api/delivery/escalations/sweep", { method: "POST", body: { limit } }),

  metrics: (qs) => api(`/api/delivery/metrics${qs || ""}`),
  stats: (qs) => api(`/api/delivery/stats${qs || ""}`),
  timeseries: (qs) => api(`/api/delivery/timeseries${qs || ""}`),
  alerts: (qs) => api(`/api/delivery/alerts${qs || ""}`),
  acknowledgeAlert: (id) => api(`/api/delivery/alerts/${id}/acknowledge`, { method: "POST", body: {} }),
  runs: (qs) => api(`/api/delivery/runs${qs || ""}`),
};

export const jobs = {
  meta: () => api("/api/jobs/meta"),
  list: (qs) => api(`/api/jobs${qs || ""}`),
  get: (id) => api(`/api/jobs/${id}`),
  status: (id) => api(`/api/jobs/${id}/status`),
  submit: (body) => api("/api/jobs", { method: "POST", body }),
  history: (id, qs) => api(`/api/jobs/${id}/history${qs || ""}`),
  dependencies: (id) => api(`/api/jobs/${id}/dependencies`),
  addDependency: (id, body) => api(`/api/jobs/${id}/dependencies`, { method: "POST", body }),
  removeDependency: (id, dependsOnId) => api(`/api/jobs/${id}/dependencies/${dependsOnId}`, { method: "DELETE" }),
  children: (id) => api(`/api/jobs/${id}/children`),
  progress: (id, body) => api(`/api/jobs/${id}/progress`, { method: "POST", body }),
  cancel: (id, reason) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: { reason } }),
  retry: (id) => api(`/api/jobs/${id}/retry`, { method: "POST", body: {} }),
  pause: (id, reason) => api(`/api/jobs/${id}/pause`, { method: "POST", body: { reason } }),
  resume: (id) => api(`/api/jobs/${id}/resume`, { method: "POST", body: {} }),
  result: (id) => api(`/api/jobs/${id}/result`),
  artifacts: (id) => api(`/api/jobs/${id}/artifacts`),

  types: (qs) => api(`/api/job-types${qs || ""}`),
  type: (code) => api(`/api/job-types/${code}`),
  createType: (body) => api("/api/job-types", { method: "POST", body }),
  updateType: (code, body) => api(`/api/job-types/${code}`, { method: "PATCH", body }),
  setTypeStatus: (code, active) => api(`/api/job-types/${code}/status`, { method: "POST", body: { active } }),

  metrics: (qs) => api(`/api/job-metrics${qs || ""}`),
  timeseries: (qs) => api(`/api/job-metrics/timeseries${qs || ""}`),
};

export const jobExecution = {
  meta: () => api("/api/job-queues/meta"),

  queues: (qs) => api(`/api/job-queues${qs || ""}`),
  queue: (id) => api(`/api/job-queues/${id}`),
  createQueue: (body) => api("/api/job-queues", { method: "POST", body }),
  updateQueue: (id, body) => api(`/api/job-queues/${id}`, { method: "PATCH", body }),
  setQueueStatus: (id, body) => api(`/api/job-queues/${id}/status`, { method: "POST", body }),
  queueHealth: (id) => api(`/api/job-queues/${id}/health`),

  schedules: (qs) => api(`/api/schedules${qs || ""}`),
  schedule: (id) => api(`/api/schedules/${id}`),
  createSchedule: (body) => api("/api/schedules", { method: "POST", body }),
  updateSchedule: (id, body) => api(`/api/schedules/${id}`, { method: "PATCH", body }),
  enableSchedule: (id) => api(`/api/schedules/${id}/enable`, { method: "POST", body: {} }),
  disableSchedule: (id) => api(`/api/schedules/${id}/disable`, { method: "POST", body: {} }),
  pauseSchedule: (id) => api(`/api/schedules/${id}/pause`, { method: "POST", body: {} }),
  resumeSchedule: (id) => api(`/api/schedules/${id}/resume`, { method: "POST", body: {} }),
  runScheduleNow: (id) => api(`/api/schedules/${id}/run-now`, { method: "POST", body: {} }),
  scheduleRuns: (id, qs) => api(`/api/schedules/${id}/runs${qs || ""}`),

  status: () => api("/api/job-execution/status"),
  metrics: (qs) => api(`/api/job-execution/metrics${qs || ""}`),
  workers: (qs) => api(`/api/job-execution/workers${qs || ""}`),
  handlers: () => api("/api/job-execution/handlers"),
  deadLetters: (qs) => api(`/api/job-execution/dead-letter${qs || ""}`),
  retryDeadLetter: (id, body) => api(`/api/job-execution/dead-letter/${id}/retry`, { method: "POST", body: body || {} }),
  discardDeadLetter: (id, body) => api(`/api/job-execution/dead-letter/${id}/discard`, { method: "POST", body: body || {} }),
  tick: (body) => api("/api/job-execution/tick", { method: "POST", body: body || {} }),
  executeJob: (id) => api(`/api/job-execution/jobs/${id}/execute`, { method: "POST", body: {} }),
  maintenance: () => api("/api/job-execution/maintenance", { method: "POST", body: {} }),
  audit: (qs) => api(`/api/job-execution/audit${qs || ""}`),
};

export const files = {
  meta: () => api("/api/files/meta"),
  metrics: (qs) => api(`/api/files/metrics${qs || ""}`),
  storageMetrics: (qs) => api(`/api/files/metrics/storage${qs || ""}`),
  processingMetrics: (qs) => api(`/api/files/metrics/processing${qs || ""}`),
  facets: (qs) => api(`/api/files/facets${qs || ""}`),
  events: (qs) => api(`/api/files/events${qs || ""}`),
  processEvent: (body) => api("/api/files/events", { method: "POST", body }),

  list: (qs) => api(`/api/files${qs || ""}`),
  get: (ref) => api(`/api/files/${encodeURIComponent(ref)}`),
  update: (ref, body) => api(`/api/files/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  remove: (ref, body) => api(`/api/files/${encodeURIComponent(ref)}`, { method: "DELETE", body }),
  restore: (ref) => api(`/api/files/${encodeURIComponent(ref)}/restore`, { method: "POST", body: {} }),
  move: (ref, folderId) =>
    api(`/api/files/${encodeURIComponent(ref)}/move`, { method: "POST", body: { folder_id: folderId } }),
  fileEvents: (ref, qs) => api(`/api/files/${encodeURIComponent(ref)}/events${qs || ""}`),
  processing: (ref) => api(`/api/files/${encodeURIComponent(ref)}/processing`),
  requeueProcessing: (ref, type) =>
    api(`/api/files/${encodeURIComponent(ref)}/processing/requeue`, { method: "POST", body: { type } }),
  downloadInfo: (ref) => api(`/api/files/${encodeURIComponent(ref)}/download`),
  versionDownloadInfo: (ref, version) =>
    api(`/api/files/${encodeURIComponent(ref)}/versions/${encodeURIComponent(version)}/download`),

  versions: (ref, qs) => api(`/api/files/${encodeURIComponent(ref)}/versions${qs || ""}`),
  createVersion: (ref, body) =>
    api(`/api/files/${encodeURIComponent(ref)}/versions`, { method: "POST", body: body || {} }),
  version: (ref, version) =>
    api(`/api/files/${encodeURIComponent(ref)}/versions/${encodeURIComponent(version)}`),
  restoreVersion: (ref, version, body) =>
    api(`/api/files/${encodeURIComponent(ref)}/versions/${encodeURIComponent(version)}/restore`, {
      method: "POST",
      body: body || {},
    }),

  uploads: (qs) => api(`/api/files/uploads${qs || ""}`),
  upload: (id) => api(`/api/files/uploads/${encodeURIComponent(id)}`),
  initiateUpload: (body) => api("/api/files/uploads", { method: "POST", body }),
  uploadChunk: (id, index, blob) =>
    apiUpload(`/api/files/uploads/${encodeURIComponent(id)}/chunks/${index}`, { method: "PUT", body: blob }),
  completeUploadBuffer: (id, buffer, contentType) =>
    apiUpload(`/api/files/uploads/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: buffer,
      contentType,
    }),
  completeUpload: (id, body) =>
    api(`/api/files/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", body: body || {} }),
  abortUpload: (id, body) =>
    api(`/api/files/uploads/${encodeURIComponent(id)}/abort`, { method: "POST", body: body || {} }),

  permissions: (qs) => api(`/api/files/permissions${qs || ""}`),
  grantPermission: (body) => api("/api/files/permissions", { method: "POST", body }),
  revokePermission: (id) => api(`/api/files/permissions/${id}`, { method: "DELETE" }),
  filePermissions: (ref) => api(`/api/files/${encodeURIComponent(ref)}/permissions`),

  folders: (qs) => api(`/api/folders${qs || ""}`),
  folderTree: (qs) => api(`/api/folders/tree${qs || ""}`),
  folder: (id) => api(`/api/folders/${id}`),
  createFolder: (body) => api("/api/folders", { method: "POST", body }),
  updateFolder: (id, body) => api(`/api/folders/${id}`, { method: "PATCH", body }),
  deleteFolder: (id, force) => api(`/api/folders/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }),
  restoreFolder: (id) => api(`/api/folders/${id}/restore`, { method: "POST", body: {} }),
  folderBreadcrumb: (id) => api(`/api/folders/${id}/breadcrumb`),
  folderFiles: (id, qs) => api(`/api/folders/${id}/files${qs || ""}`),
  moveFilesToFolder: (id, fileIds) => api(`/api/folders/${id}/files`, { method: "POST", body: { file_ids: fileIds } }),
  removeFileFromFolder: (id, fileId) => api(`/api/folders/${id}/files/${fileId}`, { method: "DELETE" }),

  collections: (qs) => api(`/api/file-collections${qs || ""}`),
  collection: (id) => api(`/api/file-collections/${id}`),
  createCollection: (body) => api("/api/file-collections", { method: "POST", body }),
  updateCollection: (id, body) => api(`/api/file-collections/${id}`, { method: "PATCH", body }),
  deleteCollection: (id) => api(`/api/file-collections/${id}`, { method: "DELETE" }),
  addCollectionMembers: (id, fileIds) =>
    api(`/api/file-collections/${id}/members`, { method: "POST", body: { file_ids: fileIds } }),
  removeCollectionMember: (id, fileId) => api(`/api/file-collections/${id}/members/${fileId}`, { method: "DELETE" }),
  fileCollections: (ref) => api(`/api/files/${encodeURIComponent(ref)}/collections`),

  associations: (qs) => api(`/api/file-associations${qs || ""}`),
  objectAssociations: (qs) => api(`/api/file-associations${qs || ""}`),
  updateAssociation: (id, body) => api(`/api/file-associations/${id}`, { method: "PATCH", body }),
  removeAssociation: (id) => api(`/api/file-associations/${id}`, { method: "DELETE" }),
  fileAssociations: (ref) => api(`/api/files/${encodeURIComponent(ref)}/associations`),
  createAssociation: (ref, body) =>
    api(`/api/files/${encodeURIComponent(ref)}/associations`, { method: "POST", body }),

  locks: (qs) => api(`/api/file-locks${qs || ""}`),
  lock: (ref) => api(`/api/files/${encodeURIComponent(ref)}/lock`),
  checkout: (ref, body) => api(`/api/files/${encodeURIComponent(ref)}/checkout`, { method: "POST", body: body || {} }),
  checkin: (ref, body) => api(`/api/files/${encodeURIComponent(ref)}/checkin`, { method: "POST", body: body || {} }),
  releaseLock: (ref, body) =>
    api(`/api/files/${encodeURIComponent(ref)}/lock/release`, { method: "POST", body: body || {} }),
  forceReleaseLock: (ref, body) =>
    api(`/api/files/${encodeURIComponent(ref)}/lock/force-release`, { method: "POST", body: body || {} }),
};

export const content = {
  meta: () => api("/api/content/meta"),
  health: () => api("/api/content/health"),
  metrics: (qs) => api(`/api/content/metrics${qs || ""}`),
  storageSummary: (qs) => api(`/api/content/storage/summary${qs || ""}`),

  list: (qs) => api(`/api/content${qs || ""}`),
  facets: (qs) => api(`/api/content/facets${qs || ""}`),
  upload: (name, blob, contentType = "application/octet-stream", extra = {}) => {
    const params = new URLSearchParams({ name });
    if (extra.objectType) params.set("objectType", extra.objectType);
    if (extra.objectId) params.set("objectId", extra.objectId);
    if (extra.contentRole) params.set("contentRole", extra.contentRole);
    if (extra.description) params.set("description", extra.description);
    return apiUpload(`/api/content?${params.toString()}`, { method: "POST", body: blob, contentType });
  },

  get: (ref) => api(`/api/content/${encodeURIComponent(ref)}`),
  update: (ref, body) => api(`/api/content/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  remove: (ref, body) => api(`/api/content/${encodeURIComponent(ref)}`, { method: "DELETE", body: body || {} }),
  restore: (ref) => api(`/api/content/${encodeURIComponent(ref)}/restore`, { method: "POST", body: {} }),
  downloadInfo: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/download${qs || ""}`),
  versionDownloadInfo: (ref, version, qs) =>
    api(`/api/content/${encodeURIComponent(ref)}/versions/${encodeURIComponent(version)}/download${qs || ""}`),

  versions: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/versions${qs || ""}`),
  restoreVersion: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/versions`, { method: "POST", body: body || {} }),

  renditions: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/renditions${qs || ""}`),
  requestRendition: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/renditions`, { method: "POST", body: body || {} }),
  renditionDownload: (ref, renditionRef, qs) =>
    api(`/api/content/${encodeURIComponent(ref)}/renditions/${encodeURIComponent(renditionRef)}/download${qs || ""}`),

  processing: (ref) => api(`/api/content/${encodeURIComponent(ref)}/processing`),
  requeueProcessing: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/processing`, { method: "POST", body: body || {} }),
  processingJobs: (qs) => api(`/api/content/processing-jobs${qs || ""}`),

  security: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/security${qs || ""}`),
  quarantine: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/quarantine`, { method: "POST", body: body || {} }),
  releaseQuarantine: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/release-quarantine`, { method: "POST", body: body || {} }),

  lifecycle: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/lifecycle`, { method: "POST", body: body || {} }),
  archive: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/archive`, { method: "POST", body: body || {} }),

  lock: (ref) => api(`/api/content/${encodeURIComponent(ref)}/lock`),
  locks: (qs) => api(`/api/content/locks${qs || ""}`),
  checkout: (ref, body) => api(`/api/content/${encodeURIComponent(ref)}/checkout`, { method: "POST", body: body || {} }),
  checkin: (ref, body) => api(`/api/content/${encodeURIComponent(ref)}/checkin`, { method: "POST", body: body || {} }),
  unlock: (ref, body) => api(`/api/content/${encodeURIComponent(ref)}/unlock`, { method: "POST", body: body || {} }),

  associations: (qs) => api(`/api/content/associations${qs || ""}`),
  association: (ref) => api(`/api/content/associations/${encodeURIComponent(ref)}`),
  createAssociation: (body) => api("/api/content/associations", { method: "POST", body }),
  updateAssociation: (ref, body) =>
    api(`/api/content/associations/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  removeAssociation: (ref) => api(`/api/content/associations/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  setPrimaryAssociation: (ref) =>
    api(`/api/content/associations/${encodeURIComponent(ref)}/primary`, { method: "POST", body: {} }),
  objectContent: (objectType, objectId, qs) =>
    api(`/api/content/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/content${qs || ""}`),
  contentAssociations: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/associations${qs || ""}`),
  contentEvents: (ref, qs) => api(`/api/content/${encodeURIComponent(ref)}/events${qs || ""}`),
  contentRetention: (ref) => api(`/api/content/${encodeURIComponent(ref)}/retention`),

  uploads: (qs) => api(`/api/content/uploads${qs || ""}`),
  uploadSession: (id) => api(`/api/content/uploads/${encodeURIComponent(id)}`),
  initiateUpload: (body) => api("/api/content/uploads", { method: "POST", body }),
  appendPart: (id, partNumber, blob) =>
    apiUpload(`/api/content/uploads/${encodeURIComponent(id)}/parts/${partNumber}`, { method: "PUT", body: blob }),
  completeUpload: (id, body) =>
    api(`/api/content/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", body: body || {} }),
  completeUploadBuffer: (id, buffer, contentType = "application/octet-stream") =>
    apiUpload(`/api/content/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", body: buffer, contentType }),
  abortUpload: (id, body) =>
    api(`/api/content/uploads/${encodeURIComponent(id)}/abort`, { method: "POST", body: body || {} }),

  retentionPolicies: (qs) => api(`/api/content/retention-policies${qs || ""}`),
  retentionPolicy: (ref) => api(`/api/content/retention-policies/${encodeURIComponent(ref)}`),
  createRetentionPolicy: (body) => api("/api/content/retention-policies", { method: "POST", body }),
  updateRetentionPolicy: (ref, body) =>
    api(`/api/content/retention-policies/${encodeURIComponent(ref)}`, { method: "PATCH", body }),

  applyLegalHold: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/legal-hold`, { method: "POST", body: body || {} }),
  releaseLegalHold: (ref, body) =>
    api(`/api/content/${encodeURIComponent(ref)}/legal-hold/release`, { method: "POST", body: body || {} }),
};

export const search = {
  meta: () => api("/api/search/meta"),
  query: (qs) => api(`/api/search${qs || ""}`),
  global: (body) => api("/api/search", { method: "POST", body }),
  suggestions: (qs) => api(`/api/search/suggestions${qs || ""}`),
  facets: (qs) => api(`/api/search/facets${qs || ""}`),
  advanced: (body) => api("/api/search/advanced", { method: "POST", body }),
  byType: (objectType, body) => api(`/api/search/by-type/${encodeURIComponent(objectType)}`, { method: "POST", body }),
  byAttributes: (body) => api("/api/search/by-attributes", { method: "POST", body }),
  byRelationship: (body) => api("/api/search/by-relationship", { method: "POST", body }),

  saved: (qs) => api(`/api/search/saved${qs || ""}`),
  savedSearch: (reference) => api(`/api/search/saved/${encodeURIComponent(reference)}`),
  createSaved: (body) => api("/api/search/saved", { method: "POST", body }),
  updateSaved: (reference, body) => api(`/api/search/saved/${encodeURIComponent(reference)}`, { method: "PATCH", body }),
  deleteSaved: (reference) => api(`/api/search/saved/${encodeURIComponent(reference)}`, { method: "DELETE" }),
  runSaved: (reference, body) =>
    api(`/api/search/saved/${encodeURIComponent(reference)}/run`, { method: "POST", body: body || {} }),

  history: (qs) => api(`/api/search/history${qs || ""}`),
  clearHistory: (all) => api(`/api/search/history${all ? "?all=true" : ""}`, { method: "DELETE" }),
  deleteHistory: (id) => api(`/api/search/history/${id}`, { method: "DELETE" }),

  exports: (qs) => api(`/api/search/exports${qs || ""}`),
  searchExport: (reference) => api(`/api/search/exports/${encodeURIComponent(reference)}`),
  createExport: (body) => api("/api/search/exports", { method: "POST", body }),
  downloadExport: (reference) => apiDownload(`/api/search/exports/${encodeURIComponent(reference)}/download`),

  objectTypes: (qs) => api(`/api/search/object-types${qs || ""}`),
  objectType: (code) => api(`/api/search/object-types/${encodeURIComponent(code)}`),
  createObjectType: (body) => api("/api/search/object-types", { method: "POST", body }),
  updateObjectType: (code, body) => api(`/api/search/object-types/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setObjectTypeStatus: (code, status) =>
    api(`/api/search/object-types/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  deleteObjectType: (code) => api(`/api/search/object-types/${encodeURIComponent(code)}`, { method: "DELETE" }),

  indexStatus: () => api("/api/search/indexes/status"),
  indexFailures: (qs) => api(`/api/search/indexes/failures${qs || ""}`),
  retryFailures: (body) => api("/api/search/indexes/retry", { method: "POST", body: body || {} }),
  drainIndex: (body) => api("/api/search/indexes/drain", { method: "POST", body: body || {} }),
  reindex: (body) => api("/api/search/indexes/reindex", { method: "POST", body: body || {} }),
  reindexObject: (objectType, objectId) =>
    api(`/api/search/indexes/reindex/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, {
      method: "POST",
      body: {},
    }),
  pruneIndex: (body) => api("/api/search/indexes/prune", { method: "POST", body: body || {} }),
  indexJob: (body) => api("/api/search/indexes/jobs", { method: "POST", body: body || {} }),

  configuration: () => api("/api/search/configuration"),
  updateConfiguration: (body) => api("/api/search/configuration", { method: "PUT", body }),
  metrics: () => api("/api/search/metrics"),
  health: () => api("/api/search/health"),
};

// Enterprise Search Foundation (canonical, provider-independent /api/v1/search).
export const searchFoundation = {
  meta: () => api("/api/v1/search/meta"),
  search: (body) => api("/api/v1/search", { method: "POST", body }),
  count: (body) => api("/api/v1/search/count", { method: "POST", body }),
  parse: (body) => api("/api/v1/search/parse", { method: "POST", body }),
  bulk: (body) => api("/api/v1/search/bulk", { method: "POST", body }),

  objects: (qs) => api(`/api/v1/search/objects${qs || ""}`),
  object: (code) => api(`/api/v1/search/objects/${encodeURIComponent(code)}`),
  facets: (qs) => api(`/api/v1/search/facets${qs || ""}`),
  suggestions: (qs) => api(`/api/v1/search/suggestions${qs || ""}`),

  history: (qs) => api(`/api/v1/search/history${qs || ""}`),
  clearHistory: (all) => api(`/api/v1/search/history${all ? "?all=true" : ""}`, { method: "DELETE" }),
  deleteHistory: (id) => api(`/api/v1/search/history/${id}`, { method: "DELETE" }),

  saved: () => api("/api/v1/search/saved"),
  savedSearch: (reference) => api(`/api/v1/search/saved/${encodeURIComponent(reference)}`),
  createSaved: (body) => api("/api/v1/search/saved", { method: "POST", body }),
  updateSaved: (reference, body) =>
    api(`/api/v1/search/saved/${encodeURIComponent(reference)}`, { method: "PUT", body }),
  deleteSaved: (reference) => api(`/api/v1/search/saved/${encodeURIComponent(reference)}`, { method: "DELETE" }),
  runSaved: (reference, body) =>
    api(`/api/v1/search/saved/${encodeURIComponent(reference)}/execute`, { method: "POST", body: body || {} }),

  index: (body) => api("/api/v1/search/index", { method: "POST", body }),
  rebuild: (body) => api("/api/v1/search/index/rebuild", { method: "POST", body }),
  indexStatus: (qs) => api(`/api/v1/search/index/status${qs || ""}`),
  indexJobs: (qs) => api(`/api/v1/search/index/jobs${qs || ""}`),
  retryFailed: (body) => api("/api/v1/search/index/retry-failed", { method: "POST", body: body || {} }),

  fields: (qs) => api(`/api/v1/search/fields${qs || ""}`),
  createField: (body) => api("/api/v1/search/fields", { method: "POST", body }),
  deleteField: (objectType, field) =>
    api(`/api/v1/search/fields/${encodeURIComponent(objectType)}/${encodeURIComponent(field)}`, { method: "DELETE" }),

  contentText: (qs) => api(`/api/v1/search/content-text${qs || ""}`),
  putContentText: (body) => api("/api/v1/search/content-text", { method: "POST", body }),
  deleteContentText: (body) => api("/api/v1/search/content-text", { method: "DELETE", body }),

  health: () => api("/api/v1/search/health"),
  metrics: () => api("/api/v1/search/metrics"),
};

export const security = {
  vocabulary: () => api("/api/v1/security/vocabulary"),
  overview: () => api("/api/v1/security/overview"),
  invalidate: (scope) => api("/api/v1/security/cache/invalidate", { method: "POST", body: { scope } }),

  objectTypes: (qs) => api(`/api/v1/security/object-types${qs || ""}`),
  registerObjectType: (body) => api("/api/v1/security/object-types", { method: "POST", body }),
  updateObjectType: (objectType, body) =>
    api(`/api/v1/security/object-types/${encodeURIComponent(objectType)}`, { method: "PUT", body }),
  setObjectTypeStatus: (objectType, status) =>
    api(`/api/v1/security/object-types/${encodeURIComponent(objectType)}/status`, {
      method: "POST",
      body: { status },
    }),

  policies: (qs) => api(`/api/v1/security/policies${qs || ""}`),
  policy: (id) => api(`/api/v1/security/policies/${id}`),
  createPolicy: (body) => api("/api/v1/security/policies", { method: "POST", body }),
  updatePolicy: (id, body) => api(`/api/v1/security/policies/${id}`, { method: "PUT", body }),
  setPolicyStatus: (id, status) =>
    api(`/api/v1/security/policies/${id}/status`, { method: "POST", body: { status } }),

  entitlements: (qs) => api(`/api/v1/security/entitlements${qs || ""}`),
  createEntitlement: (body) => api("/api/v1/security/entitlements", { method: "POST", body }),
  updateEntitlement: (id, body) => api(`/api/v1/security/entitlements/${id}`, { method: "PUT", body }),
  setEntitlementStatus: (id, status) =>
    api(`/api/v1/security/entitlements/${id}/status`, { method: "POST", body: { status } }),

  fieldRules: (qs) => api(`/api/v1/security/field-rules${qs || ""}`),
  createFieldRule: (body) => api("/api/v1/security/field-rules", { method: "POST", body }),
  updateFieldRule: (id, body) => api(`/api/v1/security/field-rules/${id}`, { method: "PUT", body }),
  setFieldRuleStatus: (id, status) =>
    api(`/api/v1/security/field-rules/${id}/status`, { method: "POST", body: { status } }),

  maskingRules: (qs) => api(`/api/v1/security/masking-rules${qs || ""}`),
  createMaskingRule: (body) => api("/api/v1/security/masking-rules", { method: "POST", body }),
  setMaskingRuleStatus: (id, status) =>
    api(`/api/v1/security/masking-rules/${id}/status`, { method: "POST", body: { status } }),

  classificationRules: (qs) => api(`/api/v1/security/classification-rules${qs || ""}`),
  createClassificationRule: (body) => api("/api/v1/security/classification-rules", { method: "POST", body }),
  setClassificationRuleStatus: (id, status) =>
    api(`/api/v1/security/classification-rules/${id}/status`, { method: "POST", body: { status } }),

  organizationRules: (qs) => api(`/api/v1/security/organization-rules${qs || ""}`),
  createOrganizationRule: (body) => api("/api/v1/security/organization-rules", { method: "POST", body }),
  setOrganizationRuleStatus: (id, status) =>
    api(`/api/v1/security/organization-rules/${id}/status`, { method: "POST", body: { status } }),

  plantRules: (qs) => api(`/api/v1/security/plant-rules${qs || ""}`),
  createPlantRule: (body) => api("/api/v1/security/plant-rules", { method: "POST", body }),
  setPlantRuleStatus: (id, status) =>
    api(`/api/v1/security/plant-rules/${id}/status`, { method: "POST", body: { status } }),

  decisions: (qs) => api(`/api/v1/security/decisions${qs || ""}`),
  context: (userId, qs) => api(`/api/v1/security/context/${userId}${qs || ""}`),
  evaluate: (body) => api("/api/v1/security/evaluate", { method: "POST", body }),
  evaluateBatch: (body) => api("/api/v1/security/evaluate/batch", { method: "POST", body }),
};

export const integration = {
  meta: () => api("/api/integration/meta"),

  definitions: (qs) => api(`/api/integration/definitions${qs || ""}`),
  definition: (code) => api(`/api/integration/definitions/${encodeURIComponent(code)}`),
  createDefinition: (body) => api("/api/integration/definitions", { method: "POST", body }),
  updateDefinition: (code, body) => api(`/api/integration/definitions/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setDefinitionStatus: (code, status, reason) =>
    api(`/api/integration/definitions/${encodeURIComponent(code)}/status`, { method: "POST", body: { status, reason } }),
  deleteDefinition: (code) => api(`/api/integration/definitions/${encodeURIComponent(code)}`, { method: "DELETE" }),
  definitionVersions: (code) => api(`/api/integration/definitions/${encodeURIComponent(code)}/versions`),
  restoreDefinitionVersion: (code, version) =>
    api(`/api/integration/definitions/${encodeURIComponent(code)}/versions/${version}/restore`, { method: "POST" }),
  runDefinition: (code, body) => api(`/api/integration/definitions/${encodeURIComponent(code)}/run`, { method: "POST", body: body || {} }),
  executions: (qs) => api(`/api/integration/executions${qs || ""}`),
  execution: (ref) => api(`/api/integration/executions/${encodeURIComponent(ref)}`),
  retryExecution: (ref) => api(`/api/integration/executions/${encodeURIComponent(ref)}/retry`, { method: "POST" }),
  cancelExecution: (ref) => api(`/api/integration/executions/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),

  credentials: (qs) => api(`/api/integration/credentials${qs || ""}`),
  credential: (code) => api(`/api/integration/credentials/${encodeURIComponent(code)}`),
  createCredential: (body) => api("/api/integration/credentials", { method: "POST", body }),
  updateCredential: (code, body) => api(`/api/integration/credentials/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteCredential: (code) => api(`/api/integration/credentials/${encodeURIComponent(code)}`, { method: "DELETE" }),

  systems: (qs) => api(`/api/integration/systems${qs || ""}`),
  system: (code) => api(`/api/integration/systems/${encodeURIComponent(code)}`),
  createSystem: (body) => api("/api/integration/systems", { method: "POST", body }),
  updateSystem: (code, body) => api(`/api/integration/systems/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteSystem: (code) => api(`/api/integration/systems/${encodeURIComponent(code)}`, { method: "DELETE" }),
  testSystem: (code) => api(`/api/integration/systems/${encodeURIComponent(code)}/test`, { method: "POST" }),
  systemHealth: (code, qs) => api(`/api/integration/systems/${encodeURIComponent(code)}/health${qs || ""}`),

  endpoints: (qs) => api(`/api/integration/endpoints${qs || ""}`),
  endpoint: (code) => api(`/api/integration/endpoints/${encodeURIComponent(code)}`),
  createEndpoint: (body) => api("/api/integration/endpoints", { method: "POST", body }),
  updateEndpoint: (code, body) => api(`/api/integration/endpoints/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteEndpoint: (code) => api(`/api/integration/endpoints/${encodeURIComponent(code)}`, { method: "DELETE" }),

  transformations: (qs) => api(`/api/integration/transformations${qs || ""}`),
  transformation: (code) => api(`/api/integration/transformations/${encodeURIComponent(code)}`),
  createTransformation: (body) => api("/api/integration/transformations", { method: "POST", body }),
  updateTransformation: (code, body) => api(`/api/integration/transformations/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteTransformation: (code) => api(`/api/integration/transformations/${encodeURIComponent(code)}`, { method: "DELETE" }),
  testTransformation: (code, body) => api(`/api/integration/transformations/${encodeURIComponent(code)}/test`, { method: "POST", body: body || {} }),

  mappingStats: () => api("/api/integration/mappings/stats"),
  mappings: (qs) => api(`/api/integration/mappings${qs || ""}`),
  createMapping: (body) => api("/api/integration/mappings", { method: "POST", body }),
  updateMapping: (id, body) => api(`/api/integration/mappings/${id}`, { method: "PATCH", body }),
  deleteMapping: (id) => api(`/api/integration/mappings/${id}`, { method: "DELETE" }),

  schedules: (qs) => api(`/api/integration/schedules${qs || ""}`),
  schedule: (code) => api(`/api/integration/schedules/${encodeURIComponent(code)}`),
  createSchedule: (body) => api("/api/integration/schedules", { method: "POST", body }),
  updateSchedule: (code, body) => api(`/api/integration/schedules/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setScheduleStatus: (code, status) =>
    api(`/api/integration/schedules/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  runSchedule: (code) => api(`/api/integration/schedules/${encodeURIComponent(code)}/run`, { method: "POST" }),
  deleteSchedule: (code) => api(`/api/integration/schedules/${encodeURIComponent(code)}`, { method: "DELETE" }),

  eventTypes: (qs) => api(`/api/integration/event-types${qs || ""}`),
  createEventType: (body) => api("/api/integration/event-types", { method: "POST", body }),
  updateEventType: (code, body) => api(`/api/integration/event-types/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteEventType: (code) => api(`/api/integration/event-types/${encodeURIComponent(code)}`, { method: "DELETE" }),

  subscriptions: (qs) => api(`/api/integration/subscriptions${qs || ""}`),
  createSubscription: (body) => api("/api/integration/subscriptions", { method: "POST", body }),
  updateSubscription: (code, body) => api(`/api/integration/subscriptions/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setSubscriptionStatus: (code, status) =>
    api(`/api/integration/subscriptions/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  deleteSubscription: (code) => api(`/api/integration/subscriptions/${encodeURIComponent(code)}`, { method: "DELETE" }),

  events: (qs) => api(`/api/integration/events${qs || ""}`),
  publishEvent: (body) => api("/api/integration/events", { method: "POST", body }),
  event: (ref) => api(`/api/integration/events/${encodeURIComponent(ref)}`),
  replayEvent: (ref) => api(`/api/integration/events/${encodeURIComponent(ref)}/replay`, { method: "POST" }),
  deliveries: (qs) => api(`/api/integration/deliveries${qs || ""}`),
  retryDelivery: (id) => api(`/api/integration/deliveries/${id}/retry`, { method: "POST" }),

  inboundWebhooks: (qs) => api(`/api/integration/webhooks/inbound${qs || ""}`),
  createInboundWebhook: (body) => api("/api/integration/webhooks/inbound", { method: "POST", body }),
  updateInboundWebhook: (code, body) => api(`/api/integration/webhooks/inbound/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setInboundWebhookStatus: (code, status) =>
    api(`/api/integration/webhooks/inbound/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  deleteInboundWebhook: (code) => api(`/api/integration/webhooks/inbound/${encodeURIComponent(code)}`, { method: "DELETE" }),
  inboundReceipts: (code, qs) => api(`/api/integration/webhooks/inbound/${encodeURIComponent(code)}/receipts${qs || ""}`),

  outboundWebhooks: (qs) => api(`/api/integration/webhooks/outbound${qs || ""}`),
  createOutboundWebhook: (body) => api("/api/integration/webhooks/outbound", { method: "POST", body }),
  updateOutboundWebhook: (code, body) => api(`/api/integration/webhooks/outbound/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setOutboundWebhookStatus: (code, status, reason) =>
    api(`/api/integration/webhooks/outbound/${encodeURIComponent(code)}/status`, { method: "POST", body: { status, reason } }),
  deleteOutboundWebhook: (code) => api(`/api/integration/webhooks/outbound/${encodeURIComponent(code)}`, { method: "DELETE" }),
  testOutboundWebhook: (code) => api(`/api/integration/webhooks/outbound/${encodeURIComponent(code)}/test`, { method: "POST" }),
  outboundDeliveries: (code, qs) => api(`/api/integration/webhooks/outbound/${encodeURIComponent(code)}/deliveries${qs || ""}`),

  queues: () => api("/api/integration/queues"),
  messages: (qs) => api(`/api/integration/messages${qs || ""}`),
  createMessage: (body) => api("/api/integration/messages", { method: "POST", body }),
  message: (ref) => api(`/api/integration/messages/${encodeURIComponent(ref)}`),
  retryMessage: (ref) => api(`/api/integration/messages/${encodeURIComponent(ref)}/retry`, { method: "POST" }),
  cancelMessage: (ref) => api(`/api/integration/messages/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),

  deadLetterStats: () => api("/api/integration/dead-letters/stats"),
  deadLetters: (qs) => api(`/api/integration/dead-letters${qs || ""}`),
  deadLetter: (id) => api(`/api/integration/dead-letters/${id}`),
  inspectDeadLetter: (id) => api(`/api/integration/dead-letters/${id}/inspect`, { method: "POST" }),
  retryDeadLetter: (id) => api(`/api/integration/dead-letters/${id}/retry`, { method: "POST" }),
  resolveDeadLetter: (id, body) => api(`/api/integration/dead-letters/${id}/resolve`, { method: "POST", body: body || {} }),
  bulkRetryDeadLetters: (ids) => api("/api/integration/dead-letters/bulk-retry", { method: "POST", body: { ids } }),

  transferHandlers: () => api("/api/integration/transfers/handlers"),
  transfers: (qs) => api(`/api/integration/transfers${qs || ""}`),
  transfer: (ref) => api(`/api/integration/transfers/${encodeURIComponent(ref)}`),
  previewImport: (body) => api("/api/integration/transfers/import/preview", { method: "POST", body }),
  importTransfer: (body) => api("/api/integration/transfers/import", { method: "POST", body }),
  exportTransfer: (body) => api("/api/integration/transfers/export", { method: "POST", body }),
  downloadTransfer: (ref) => apiDownload(`/api/integration/transfers/${encodeURIComponent(ref)}/download`),
  cancelTransfer: (ref) => api(`/api/integration/transfers/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),

  monitoringOverview: (qs) => api(`/api/integration/monitoring/overview${qs || ""}`),
  monitoringExecutions: (qs) => api(`/api/integration/monitoring/executions${qs || ""}`),
  monitoringDeliveries: (qs) => api(`/api/integration/monitoring/deliveries${qs || ""}`),
  monitoringSystems: (qs) => api(`/api/integration/monitoring/systems${qs || ""}`),
  monitoringUptime: (code, qs) => api(`/api/integration/monitoring/systems/${encodeURIComponent(code)}/uptime${qs || ""}`),
  runHealthChecks: (body) => api("/api/integration/monitoring/health-checks/run", { method: "POST", body: body || {} }),
  monitoringApiUsage: (qs) => api(`/api/integration/monitoring/api-usage${qs || ""}`),

  apiCatalog: (qs) => api(`/api/integration/api-catalog${qs || ""}`),
  apiCatalogEntry: (code) => api(`/api/integration/api-catalog/${encodeURIComponent(code)}`),
  createApiCatalogEntry: (body) => api("/api/integration/api-catalog", { method: "POST", body }),
  updateApiCatalogEntry: (code, body) => api(`/api/integration/api-catalog/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  setApiCatalogStatus: (code, status) =>
    api(`/api/integration/api-catalog/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  deleteApiCatalogEntry: (code) => api(`/api/integration/api-catalog/${encodeURIComponent(code)}`, { method: "DELETE" }),

  apiClients: (qs) => api(`/api/integration/api-clients${qs || ""}`),
  apiClient: (code) => api(`/api/integration/api-clients/${encodeURIComponent(code)}`),
  createApiClient: (body) => api("/api/integration/api-clients", { method: "POST", body }),
  updateApiClient: (code, body) => api(`/api/integration/api-clients/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  rotateApiClient: (code) => api(`/api/integration/api-clients/${encodeURIComponent(code)}/rotate`, { method: "POST" }),
  revokeApiClient: (code) => api(`/api/integration/api-clients/${encodeURIComponent(code)}/revoke`, { method: "POST" }),
  deleteApiClient: (code) => api(`/api/integration/api-clients/${encodeURIComponent(code)}`, { method: "DELETE" }),
  apiUsage: (qs) => api(`/api/integration/api-usage${qs || ""}`),
};

export const events = {
  meta: () => api("/api/events/meta"),

  eventTypes: (qs) => api(`/api/events/event-types${qs || ""}`),
  eventType: (code) => api(`/api/events/event-types/${encodeURIComponent(code)}`),
  createEventType: (body) => api("/api/events/event-types", { method: "POST", body }),
  updateEventType: (code, body) => api(`/api/events/event-types/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteEventType: (code) => api(`/api/events/event-types/${encodeURIComponent(code)}`, { method: "DELETE" }),
  eventTypeVersions: (code) => api(`/api/events/event-types/${encodeURIComponent(code)}/versions`),
  addEventTypeVersion: (code, body) => api(`/api/events/event-types/${encodeURIComponent(code)}/versions`, { method: "POST", body }),
  setEventTypeVersionStatus: (code, version, status) =>
    api(`/api/events/event-types/${encodeURIComponent(code)}/versions/${version}`, { method: "PATCH", body: { status } }),
  eventTypeCompatibility: (code, body) => api(`/api/events/event-types/${encodeURIComponent(code)}/compatibility`, { method: "POST", body }),

  events: (qs) => api(`/api/events${qs || ""}`),
  publish: (body, immediate) => api(`/api/events${immediate ? "?immediate=true" : ""}`, { method: "POST", body }),
  publishBatch: (body) => api("/api/events/batch", { method: "POST", body }),
  validateEvent: (body) => api("/api/events/validate", { method: "POST", body }),
  serializeEvent: (body) => api("/api/events/serialize", { method: "POST", body }),
  event: (ref) => api(`/api/events/${encodeURIComponent(ref)}`),
  routeEvent: (ref) => api(`/api/events/${encodeURIComponent(ref)}/route`, { method: "POST" }),
  eventDeliveries: (ref, qs) => api(`/api/events/${encodeURIComponent(ref)}/deliveries${qs || ""}`),

  deliveries: (qs) => api(`/api/events/deliveries${qs || ""}`),
  deliveryStats: (qs) => api(`/api/events/deliveries/stats${qs || ""}`),
  delivery: (id) => api(`/api/events/deliveries/${id}`),
  retryDelivery: (id) => api(`/api/events/deliveries/${id}/retry`, { method: "POST" }),
  skipDelivery: (id, reason) => api(`/api/events/deliveries/${id}/skip`, { method: "POST", body: { reason } }),
  deliveryAttempts: (id) => api(`/api/events/deliveries/${id}/attempts`),

  subscriptions: (qs) => api(`/api/events/subscriptions${qs || ""}`),
  subscription: (code) => api(`/api/events/subscriptions/${encodeURIComponent(code)}`),
  createSubscription: (body) => api("/api/events/subscriptions", { method: "POST", body }),
  updateSubscription: (code, body) => api(`/api/events/subscriptions/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteSubscription: (code) => api(`/api/events/subscriptions/${encodeURIComponent(code)}`, { method: "DELETE" }),
  setSubscriptionStatus: (code, status) => api(`/api/events/subscriptions/${encodeURIComponent(code)}/status`, { method: "POST", body: { status } }),
  validateSubscription: (code) => api(`/api/events/subscriptions/${encodeURIComponent(code)}/validate`, { method: "POST" }),
  testSubscription: (code, body) => api(`/api/events/subscriptions/${encodeURIComponent(code)}/test`, { method: "POST", body: body || {} }),
  subscriptionStats: (code) => api(`/api/events/subscriptions/${encodeURIComponent(code)}/stats`),

  topics: (qs) => api(`/api/events/topics${qs || ""}`),
  createTopic: (body) => api("/api/events/topics", { method: "POST", body }),
  queues: (qs) => api(`/api/events/queues${qs || ""}`),
  createQueue: (body) => api("/api/events/queues", { method: "POST", body }),
  queueStats: (code) => api(`/api/events/queues/${encodeURIComponent(code)}/stats`),
  consumerGroups: (qs) => api(`/api/events/consumer-groups${qs || ""}`),
  createConsumerGroup: (body) => api("/api/events/consumer-groups", { method: "POST", body }),

  outbox: (qs) => api(`/api/events/outbox${qs || ""}`),
  outboxStats: () => api("/api/events/outbox/stats"),
  processOutbox: (body) => api("/api/events/outbox/process", { method: "POST", body: body || {} }),
  retryOutbox: (id) => api(`/api/events/outbox/${id}/retry`, { method: "POST" }),

  deadLetters: (qs) => api(`/api/events/dead-letters${qs || ""}`),
  deadLetterStats: (qs) => api(`/api/events/dead-letters/stats${qs || ""}`),
  deadLetter: (id) => api(`/api/events/dead-letters/${id}`),
  resolveDeadLetter: (id, body) => api(`/api/events/dead-letters/${id}/resolve`, { method: "POST", body: body || {} }),
  bulkRetryDeadLetters: (body) => api("/api/events/dead-letters/bulk-retry", { method: "POST", body: body || {} }),

  replays: (qs) => api(`/api/events/replays${qs || ""}`),
  replay: (ref) => api(`/api/events/replays/${encodeURIComponent(ref)}`),
  previewReplay: (body) => api("/api/events/replays/preview", { method: "POST", body: body || {} }),
  createReplay: (body) => api("/api/events/replays", { method: "POST", body }),
  runReplay: (ref) => api(`/api/events/replays/${encodeURIComponent(ref)}/run`, { method: "POST" }),
  cancelReplay: (ref) => api(`/api/events/replays/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),
  replayStats: () => api("/api/events/replays/stats"),

  retentionPolicies: (qs) => api(`/api/events/retention-policies${qs || ""}`),
  retentionPolicy: (code) => api(`/api/events/retention-policies/${encodeURIComponent(code)}`),
  createRetentionPolicy: (body) => api("/api/events/retention-policies", { method: "POST", body }),
  updateRetentionPolicy: (code, body) => api(`/api/events/retention-policies/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  deleteRetentionPolicy: (code) => api(`/api/events/retention-policies/${encodeURIComponent(code)}`, { method: "DELETE" }),
  applyRetentionPolicy: (code, body) => api(`/api/events/retention-policies/${encodeURIComponent(code)}/apply`, { method: "POST", body: body || {} }),
  applyRetention: (body) => api("/api/events/retention/apply", { method: "POST", body: body || {} }),
  retentionStats: () => api("/api/events/retention/stats"),

  handlers: () => api("/api/events/handlers"),
  handlerStats: (qs) => api(`/api/events/handlers/stats${qs || ""}`),
  handlerDetail: (code) => api(`/api/events/handlers/${encodeURIComponent(code)}`),

  monitoringDashboard: (qs) => api(`/api/events/monitoring/dashboard${qs || ""}`),
  monitoringHealth: () => api("/api/events/monitoring/health"),
  monitoringThroughput: (qs) => api(`/api/events/monitoring/throughput${qs || ""}`),
  monitoringFailures: (qs) => api(`/api/events/monitoring/failures${qs || ""}`),
  monitoringLatency: (qs) => api(`/api/events/monitoring/latency${qs || ""}`),
  monitoringOrdering: () => api("/api/events/monitoring/ordering"),
  monitoringTraceability: (qs) => api(`/api/events/monitoring/traceability${qs || ""}`),
};

export const lifecycle = {  statuses: (qs) => api(`/api/statuses${qs || ""}`),
  status: (id) => api(`/api/statuses/${id}`),
  createStatus: (body) => api("/api/statuses", { method: "POST", body }),
  updateStatus: (id, body) => api(`/api/statuses/${id}`, { method: "PUT", body }),
  deleteStatus: (id) => api(`/api/statuses/${id}`, { method: "DELETE" }),
  definitions: (qs) => api(`/api/lifecycle-definitions${qs || ""}`),
  definition: (id) => api(`/api/lifecycle-definitions/${id}`),
  get: (id) => api(`/api/lifecycle-definitions/${id}`),
  createDefinition: (body) => api("/api/lifecycle-definitions", { method: "POST", body }),
  updateDefinition: (id, body) => api(`/api/lifecycle-definitions/${id}`, { method: "PUT", body }),
  versions: (id) => api(`/api/lifecycle-definitions/${id}/versions`),
  validate: (id, qs) => api(`/api/lifecycle-definitions/${id}/validate${qs || ""}`),
  publish: (id, body) => api(`/api/lifecycle-definitions/${id}/publish`, { method: "POST", body }),
  states: (qs) => api(`/api/lifecycle-states${qs || ""}`),
  createState: (body) => api("/api/lifecycle-states", { method: "POST", body }),
  transitions: (qs) => api(`/api/lifecycle-transitions${qs || ""}`),
  createTransition: (body) => api("/api/lifecycle-transitions", { method: "POST", body }),
  assignments: (qs) => api(`/api/lifecycle-assignments${qs || ""}`),
  createAssignment: (body) => api("/api/lifecycle-assignments", { method: "POST", body }),
  releaseRules: (qs) => api(`/api/release-rules${qs || ""}`),
  approvalRules: (qs) => api(`/api/approval-rules${qs || ""}`),
  createApprovalRule: (body) => api("/api/approval-rules", { method: "POST", body }),
  createReleaseRule: (body) => api("/api/release-rules", { method: "POST", body }),
};


export const numbering = {
  meta: () => api("/api/numbering/meta"),

  objectTypes: (qs) => api(`/api/numbering/object-types${qs || ""}`),
  createObjectType: (body) => api("/api/numbering/object-types", { method: "POST", body }),
  setObjectTypeStatus: (code, body) =>
    api(`/api/numbering/object-types/${encodeURIComponent(code)}/status`, { method: "POST", body }),

  scopes: () => api("/api/numbering/scopes"),
  tokens: () => api("/api/numbering/tokens"),
  createToken: (body) => api("/api/numbering/tokens", { method: "POST", body }),

  schemes: (qs) => api(`/api/numbering/schemes${qs || ""}`),
  scheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}`),
  createScheme: (body) => api("/api/numbering/schemes", { method: "POST", body }),
  updateScheme: (ref, body) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}`, { method: "PUT", body }),
  deleteScheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  schemeVersions: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/versions`),
  validateScheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/validate`, { method: "POST" }),
  cloneScheme: (ref, body) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/clone`, { method: "POST", body: body || {} }),
  activateScheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  deactivateScheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/deactivate`, { method: "POST" }),
  retireScheme: (ref) => api(`/api/numbering/schemes/${encodeURIComponent(ref)}/retire`, { method: "POST" }),

  generate: (body, idempotencyKey) =>
    api("/api/numbering/generate", { method: "POST", body, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined }),
  reserve: (body, idempotencyKey) =>
    api("/api/numbering/reserve", { method: "POST", body, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined }),
  preview: (body) => api("/api/numbering/preview", { method: "POST", body }),
  validateIdentifier: (body) => api("/api/numbering/validate", { method: "POST", body }),

  allocations: (qs) => api(`/api/numbering/allocations${qs || ""}`),
  allocation: (ref) => api(`/api/numbering/allocations/${encodeURIComponent(ref)}`),
  consumeAllocation: (ref, body) =>
    api(`/api/numbering/allocations/${encodeURIComponent(ref)}/consume`, { method: "POST", body: body || {} }),
  releaseAllocation: (ref, body) =>
    api(`/api/numbering/allocations/${encodeURIComponent(ref)}/release`, { method: "POST", body: body || {} }),
  cancelAllocation: (ref, body) =>
    api(`/api/numbering/allocations/${encodeURIComponent(ref)}/cancel`, { method: "POST", body: body || {} }),

  sequences: (qs) => api(`/api/numbering/sequences${qs || ""}`),
  sequence: (id) => api(`/api/numbering/sequences/${encodeURIComponent(id)}`),
  resetSequence: (id, body) => api(`/api/numbering/sequences/${encodeURIComponent(id)}/reset`, { method: "POST", body: body || {} }),

  metrics: () => api("/api/numbering/metrics"),
  dashboard: (qs) => api(`/api/numbering/dashboard${qs || ""}`),
  health: () => api("/api/numbering/health"),
  expireReservations: (body) => api("/api/numbering/maintenance/expire", { method: "POST", body: body || {} }),
};


export const versioning = {
  meta: () => api("/api/versioning/meta"),
  effectivityTypes: (qs) => api(`/api/versioning/effectivity-types${qs || ""}`),

  revisions: (qs) => api(`/api/versioning/revisions${qs || ""}`),
  createRevision: (body) => api("/api/versioning/revisions", { method: "POST", body }),
  revision: (ref, qs) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}${qs || ""}`),
  updateRevision: (ref, body) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteRevision: (ref) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  activateRevision: (ref) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  supersedeRevision: (ref) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/supersede`, { method: "POST" }),
  retireRevision: (ref) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/retire`, { method: "POST" }),
  setDefaultRevision: (ref) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/default`, { method: "POST" }),
  revisionHistory: (ref, qs) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/history${qs || ""}`),
  compareRevisions: (ref, other) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/compare/${encodeURIComponent(other)}`),
  revisionRelationships: (ref, qs) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/relationships${qs || ""}`),
  createRevisionRelationship: (ref, body) =>
    api(`/api/versioning/revisions/${encodeURIComponent(ref)}/relationships`, { method: "POST", body }),
  deleteRevisionRelationship: (ref, id) =>
    api(`/api/versioning/revisions/${encodeURIComponent(ref)}/relationships/${encodeURIComponent(id)}`, { method: "DELETE" }),

  versions: (ref, qs) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/versions${qs || ""}`),
  createVersion: (ref, body) => api(`/api/versioning/revisions/${encodeURIComponent(ref)}/versions`, { method: "POST", body }),
  version: (ref) => api(`/api/versioning/versions/${encodeURIComponent(ref)}`),
  updateVersion: (ref, body) => api(`/api/versioning/versions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteVersion: (ref) => api(`/api/versioning/versions/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  activateVersion: (ref) => api(`/api/versioning/versions/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  supersedeVersion: (ref) => api(`/api/versioning/versions/${encodeURIComponent(ref)}/supersede`, { method: "POST" }),
  setDefaultVersion: (ref) => api(`/api/versioning/versions/${encodeURIComponent(ref)}/default`, { method: "POST" }),
  compareVersions: (ref, other) => api(`/api/versioning/versions/${encodeURIComponent(ref)}/compare/${encodeURIComponent(other)}`),

  effectivities: (qs) => api(`/api/versioning/effectivities${qs || ""}`),
  createEffectivity: (body) => api("/api/versioning/effectivities", { method: "POST", body }),
  effectivity: (ref) => api(`/api/versioning/effectivities/${encodeURIComponent(ref)}`),
  updateEffectivity: (ref, body) => api(`/api/versioning/effectivities/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteEffectivity: (ref) => api(`/api/versioning/effectivities/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  effectivityAssignments: (ref, qs) => api(`/api/versioning/effectivities/${encodeURIComponent(ref)}/assignments${qs || ""}`),
  createAssignment: (ref, body) =>
    api(`/api/versioning/effectivities/${encodeURIComponent(ref)}/assignments`, { method: "POST", body }),
  assignments: (qs) => api(`/api/versioning/assignments${qs || ""}`),
  deleteAssignment: (ref) => api(`/api/versioning/assignments/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  inspectEffectivity: (qs) => api(`/api/versioning/effectivity/inspect${qs || ""}`),

  resolve: (body) => api("/api/versioning/effectivity/resolve", { method: "POST", body }),
  resolveBulk: (body) => api("/api/versioning/effectivity/resolve/bulk", { method: "POST", body }),
  validateEffectivity: (body) => api("/api/versioning/effectivity/validate", { method: "POST", body }),

  policies: (qs) => api(`/api/versioning/resolution-policies${qs || ""}`),
  createPolicy: (body) => api("/api/versioning/resolution-policies", { method: "POST", body }),
  policy: (ref) => api(`/api/versioning/resolution-policies/${encodeURIComponent(ref)}`),
  updatePolicy: (ref, body) => api(`/api/versioning/resolution-policies/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deletePolicy: (ref) => api(`/api/versioning/resolution-policies/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  baselines: (qs) => api(`/api/versioning/baselines${qs || ""}`),
  createBaseline: (body) => api("/api/versioning/baselines", { method: "POST", body }),
  baseline: (ref) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}`),
  deleteBaseline: (ref) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  addBaselineObjects: (ref, body) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}/objects`, { method: "POST", body }),
  removeBaselineObject: (ref, objectType, objectId) =>
    api(`/api/versioning/baselines/${encodeURIComponent(ref)}/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, { method: "DELETE" }),
  freezeBaseline: (ref) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}/freeze`, { method: "POST" }),
  compareBaselines: (ref, other) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}/compare/${encodeURIComponent(other)}`),
  restoreBaseline: (ref) => api(`/api/versioning/baselines/${encodeURIComponent(ref)}/restore`),

  snapshots: (qs) => api(`/api/versioning/snapshots${qs || ""}`),
  createSnapshot: (body) => api("/api/versioning/snapshots", { method: "POST", body }),
  snapshot: (ref) => api(`/api/versioning/snapshots/${encodeURIComponent(ref)}`),
  deleteSnapshot: (ref) => api(`/api/versioning/snapshots/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  archiveSnapshot: (ref) => api(`/api/versioning/snapshots/${encodeURIComponent(ref)}/archive`, { method: "POST" }),
  compareSnapshots: (ref, other) => api(`/api/versioning/snapshots/${encodeURIComponent(ref)}/compare/${encodeURIComponent(other)}`),
  reconstructSnapshot: (ref) => api(`/api/versioning/snapshots/${encodeURIComponent(ref)}/reconstruct`),

  variants: (qs) => api(`/api/versioning/variants${qs || ""}`),
  createVariant: (body) => api("/api/versioning/variants", { method: "POST", body }),
  variant: (ref) => api(`/api/versioning/variants/${encodeURIComponent(ref)}`),
  updateVariant: (ref, body) => api(`/api/versioning/variants/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  addVariantOption: (ref, body) => api(`/api/versioning/variants/${encodeURIComponent(ref)}/options`, { method: "POST", body }),
  addVariantRule: (ref, body) => api(`/api/versioning/variants/${encodeURIComponent(ref)}/rules`, { method: "POST", body }),
  evaluateVariant: (ref, body) => api(`/api/versioning/variants/${encodeURIComponent(ref)}/evaluate`, { method: "POST", body }),
  variantHistory: (ref, qs) => api(`/api/versioning/variants/${encodeURIComponent(ref)}/history${qs || ""}`),

  contexts: (qs) => api(`/api/versioning/configuration-contexts${qs || ""}`),
  createContext: (body) => api("/api/versioning/configuration-contexts", { method: "POST", body }),
  context: (ref) => api(`/api/versioning/configuration-contexts/${encodeURIComponent(ref)}`),
  updateContext: (ref, body) => api(`/api/versioning/configuration-contexts/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteContext: (ref) => api(`/api/versioning/configuration-contexts/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  metrics: (qs) => api(`/api/versioning/metrics${qs || ""}`),
  dashboard: (qs) => api(`/api/versioning/dashboard${qs || ""}`),
  healthReady: () => api("/api/versioning/health/ready"),
};

export const referenceData = {
  meta: () => api("/api/reference-data/meta"),

  domains: (qs) => api(`/api/reference-data/domains${qs || ""}`),
  domain: (ref) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}`),
  createDomain: (body) => api("/api/reference-data/domains", { method: "POST", body }),
  updateDomain: (ref, body) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setDomainStatus: (ref, status) =>
    api(`/api/reference-data/domains/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  domainGovernance: (ref) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}/governance`),
  publishGovernance: (ref, body) =>
    api(`/api/reference-data/domains/${encodeURIComponent(ref)}/governance`, { method: "POST", body }),
  ownershipHistory: (ref, qs) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}/ownership-history${qs || ""}`),
  domainTree: (ref, qs) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}/tree${qs || ""}`),
  reindexDomain: (ref) => api(`/api/reference-data/domains/${encodeURIComponent(ref)}/reindex`, { method: "POST" }),

  items: (qs) => api(`/api/reference-data/items${qs || ""}`),
  item: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}`),
  createItem: (body) => api("/api/reference-data/items", { method: "POST", body }),
  updateItem: (ref, body) => api(`/api/reference-data/items/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  setItemStatus: (ref, status, extra) =>
    api(`/api/reference-data/items/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status, ...(extra || {}) } }),
  submitItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/submit`, { method: "POST" }),
  approveItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/approve`, { method: "POST" }),
  activateItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  inactivateItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/inactivate`, { method: "POST" }),
  retireItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/retire`, { method: "POST" }),
  rejectItem: (ref) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/reject`, { method: "POST" }),
  itemVersions: (ref, qs) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/versions${qs || ""}`),
  itemRelationships: (ref, qs) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/relationships${qs || ""}`),
  itemCodes: (ref, qs) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/codes${qs || ""}`),
  createItemCode: (ref, body) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/codes`, { method: "POST", body }),
  itemAliases: (ref, qs) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/aliases${qs || ""}`),
  createItemAlias: (ref, body) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/aliases`, { method: "POST", body }),
  itemTranslations: (ref, qs) => api(`/api/reference-data/items/${encodeURIComponent(ref)}/translations${qs || ""}`),
  createItemTranslation: (ref, body) =>
    api(`/api/reference-data/items/${encodeURIComponent(ref)}/translations`, { method: "POST", body }),

  hierarchy: (qs) => api(`/api/reference-data/hierarchy${qs || ""}`),
  createEdge: (body) => api("/api/reference-data/hierarchy", { method: "POST", body }),
  deleteEdge: (ref) => api(`/api/reference-data/hierarchy/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  relationships: (qs) => api(`/api/reference-data/relationships${qs || ""}`),
  createRelationship: (body) => api("/api/reference-data/relationships", { method: "POST", body }),
  deleteRelationship: (ref) => api(`/api/reference-data/relationships/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  versions: (ref) => api(`/api/reference-data/versions/${encodeURIComponent(ref)}`),
  compareVersions: (ref, other) =>
    api(`/api/reference-data/versions/${encodeURIComponent(ref)}/compare/${encodeURIComponent(other)}`),

  scopePolicies: (qs) => api(`/api/reference-data/scope-policies${qs || ""}`),
  scopePolicy: (ref) => api(`/api/reference-data/scope-policies/${encodeURIComponent(ref)}`),
  createScopePolicy: (body) => api("/api/reference-data/scope-policies", { method: "POST", body }),
  updateScopePolicy: (ref, body) =>
    api(`/api/reference-data/scope-policies/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteScopePolicy: (ref) => api(`/api/reference-data/scope-policies/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  resolve: (body) => api("/api/reference-data/resolve", { method: "POST", body }),
  resolveBulk: (body) => api("/api/reference-data/resolve/bulk", { method: "POST", body }),
  lookup: (body) => api("/api/reference-data/lookup", { method: "POST", body }),
  validate: (body) => api("/api/reference-data/validate", { method: "POST", body }),
  values: (qs) => api(`/api/reference-data/values${qs || ""}`),
  search: (qs) => api(`/api/reference-data/search${qs || ""}`),

  approvals: (qs) => api(`/api/reference-data/approvals${qs || ""}`),
  approval: (ref) => api(`/api/reference-data/approvals/${encodeURIComponent(ref)}`),
  submitApproval: (ref, body) =>
    api(`/api/reference-data/items/${encodeURIComponent(ref)}/approvals`, { method: "POST", body: body || {} }),
  decideApproval: (ref, body) =>
    api(`/api/reference-data/approvals/${encodeURIComponent(ref)}/decide`, { method: "POST", body }),

  changeRequests: (qs) => api(`/api/reference-data/change-requests${qs || ""}`),
  createChangeRequest: (body) => api("/api/reference-data/change-requests", { method: "POST", body }),
  updateChangeRequest: (ref, body) =>
    api(`/api/reference-data/change-requests/${encodeURIComponent(ref)}`, { method: "PATCH", body }),

  imports: (qs) => api(`/api/reference-data/imports${qs || ""}`),
  import: (ref) => api(`/api/reference-data/imports/${encodeURIComponent(ref)}`),
  createImport: (body) => api("/api/reference-data/imports", { method: "POST", body }),
  commitImport: (ref, body) => api(`/api/reference-data/imports/${encodeURIComponent(ref)}/commit`, { method: "POST", body: body || {} }),
  exports: (qs) => api(`/api/reference-data/exports${qs || ""}`),
  exportRecord: (ref) => api(`/api/reference-data/exports/${encodeURIComponent(ref)}`),
  createExport: (body) => api("/api/reference-data/exports", { method: "POST", body }),

  metrics: (qs) => api(`/api/reference-data/metrics${qs || ""}`),
  dashboard: (qs) => api(`/api/reference-data/dashboard${qs || ""}`),
  healthReady: () => api("/api/reference-data/health/ready"),
  healthLive: () => api("/api/reference-data/health/live"),
};

export const dataGovernance = {
  meta: () => api("/api/v1/data-governance/meta"),
  health: () => api("/api/v1/data-governance/health"),
  metrics: () => api("/api/v1/data-governance/metrics"),

  domains: (qs) => api(`/api/v1/data-governance/domains${qs || ""}`),
  domainTree: (qs) => api(`/api/v1/data-governance/domains/tree${qs || ""}`),
  domain: (ref) => api(`/api/v1/data-governance/domains/${encodeURIComponent(ref)}`),
  createDomain: (body) => api("/api/v1/data-governance/domains", { method: "POST", body }),
  updateDomain: (ref, body) => api(`/api/v1/data-governance/domains/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setDomainStatus: (ref, status) =>
    api(`/api/v1/data-governance/domains/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  catalog: (qs) => api(`/api/v1/data-governance/catalog${qs || ""}`),
  catalogEntry: (ref) => api(`/api/v1/data-governance/catalog/${encodeURIComponent(ref)}`),
  registerCatalog: (body) => api("/api/v1/data-governance/catalog", { method: "POST", body }),
  updateCatalog: (ref, body) => api(`/api/v1/data-governance/catalog/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  attributes: (ref) => api(`/api/v1/data-governance/catalog/${encodeURIComponent(ref)}/attributes`),
  registerAttribute: (ref, body) =>
    api(`/api/v1/data-governance/catalog/${encodeURIComponent(ref)}/attributes`, { method: "POST", body }),

  ownership: (qs) => api(`/api/v1/data-governance/ownership${qs || ""}`),
  createOwnership: (body) => api("/api/v1/data-governance/ownership", { method: "POST", body }),
  resolveOwnership: (body) => api("/api/v1/data-governance/ownership/resolve", { method: "POST", body }),

  policies: (qs) => api(`/api/v1/data-governance/policies${qs || ""}`),
  policy: (ref) => api(`/api/v1/data-governance/policies/${encodeURIComponent(ref)}`),
  createPolicy: (body) => api("/api/v1/data-governance/policies", { method: "POST", body }),
  updatePolicy: (ref, body) => api(`/api/v1/data-governance/policies/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setPolicyStatus: (ref, status) =>
    api(`/api/v1/data-governance/policies/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  configuration: () => api("/api/v1/data-governance/configuration"),
  setConfiguration: (body) => api("/api/v1/data-governance/configuration", { method: "PUT", body }),
  dimensions: () => api("/api/v1/data-governance/dimensions"),
  jobs: (qs) => api(`/api/v1/data-governance/jobs${qs || ""}`),
  submitEvaluation: (body) => api("/api/v1/data-governance/jobs/evaluate", { method: "POST", body }),
  submitDuplicateScan: (body) => api("/api/v1/data-governance/jobs/duplicates", { method: "POST", body }),
};

export const dataQuality = {
  meta: () => api("/api/v1/data-quality/meta"),

  rules: (qs) => api(`/api/v1/data-quality/rules${qs || ""}`),
  rule: (ref) => api(`/api/v1/data-quality/rules/${encodeURIComponent(ref)}`),
  createRule: (body) => api("/api/v1/data-quality/rules", { method: "POST", body }),
  updateRule: (ref, body) => api(`/api/v1/data-quality/rules/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  validateRule: (body) => api("/api/v1/data-quality/rules/validate", { method: "POST", body }),
  setRuleStatus: (ref, status) =>
    api(`/api/v1/data-quality/rules/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  evaluate: (body) => api("/api/v1/data-quality/evaluate", { method: "POST", body }),
  evaluateBatch: (body) => api("/api/v1/data-quality/evaluate/batch", { method: "POST", body }),

  results: (qs) => api(`/api/v1/data-quality/results${qs || ""}`),
  result: (objectType, objectId) =>
    api(`/api/v1/data-quality/results/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`),
  violations: (qs) => api(`/api/v1/data-quality/violations${qs || ""}`),
  scores: () => api("/api/v1/data-quality/scores"),
  domainScores: (qs) => api(`/api/v1/data-quality/scores/domains${qs || ""}`),
  typeScores: (qs) => api(`/api/v1/data-quality/scores/object-types${qs || ""}`),
  trend: (qs) => api(`/api/v1/data-quality/scores/trend${qs || ""}`),

  exceptions: (qs) => api(`/api/v1/data-quality/exceptions${qs || ""}`),
  exceptionSummary: () => api("/api/v1/data-quality/exceptions/summary"),
  exception: (ref) => api(`/api/v1/data-quality/exceptions/${encodeURIComponent(ref)}`),
  updateException: (ref, body) =>
    api(`/api/v1/data-quality/exceptions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  createException: (body) => api("/api/v1/data-quality/exceptions", { method: "POST", body }),
  assignException: (ref, body) =>
    api(`/api/v1/data-quality/exceptions/${encodeURIComponent(ref)}/assign`, { method: "POST", body }),
  setExceptionStatus: (ref, status, extra) =>
    api(`/api/v1/data-quality/exceptions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status, ...(extra || {}) } }),

  matchRules: (qs) => api(`/api/v1/data-quality/duplicates/match-rules${qs || ""}`),
  createMatchRule: (body) => api("/api/v1/data-quality/duplicates/match-rules", { method: "POST", body }),
  candidates: (qs) => api(`/api/v1/data-quality/duplicates/candidates${qs || ""}`),
  resolveCandidate: (ref, body) =>
    api(`/api/v1/data-quality/duplicates/candidates/${encodeURIComponent(ref)}/resolve`, { method: "POST", body }),
  detectDuplicates: (body) => api("/api/v1/data-quality/duplicates/detect", { method: "POST", body }),
  duplicateSummary: () => api("/api/v1/data-quality/duplicates/summary"),

  remediations: (qs) => api(`/api/v1/data-quality/remediations${qs || ""}`),
  applyRemediation: (body) => api("/api/v1/data-quality/remediations", { method: "POST", body }),
};

export const dataCatalog = {
  meta: () => api("/api/v1/data-catalog/meta"),
  health: () => api("/api/v1/data-catalog/health"),
  metrics: () => api("/api/v1/data-catalog/metrics"),

  entries: (qs) => api(`/api/v1/data-catalog/entries${qs || ""}`),
  entry: (ref) => api(`/api/v1/data-catalog/entries/${encodeURIComponent(ref)}`),
  entryVersions: (ref) => api(`/api/v1/data-catalog/entries/${encodeURIComponent(ref)}/versions`),
  setEntryStatus: (ref, status) =>
    api(`/api/v1/data-catalog/entries/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  objects: (qs) => api(`/api/v1/data-catalog/objects${qs || ""}`),
  object: (ref) => api(`/api/v1/data-catalog/objects/${encodeURIComponent(ref)}`),
  createObject: (body) => api("/api/v1/data-catalog/objects", { method: "POST", body }),
  updateObject: (ref, body) => api(`/api/v1/data-catalog/objects/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setObjectStatus: (ref, status) =>
    api(`/api/v1/data-catalog/objects/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  attributes: (ref, qs) => api(`/api/v1/data-catalog/objects/${encodeURIComponent(ref)}/attributes${qs || ""}`),
  attribute: (ref) => api(`/api/v1/data-catalog/attributes/${encodeURIComponent(ref)}`),
  createAttribute: (ref, body) =>
    api(`/api/v1/data-catalog/objects/${encodeURIComponent(ref)}/attributes`, { method: "POST", body }),
  updateAttribute: (ref, body) =>
    api(`/api/v1/data-catalog/attributes/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setAttributeStatus: (ref, status) =>
    api(`/api/v1/data-catalog/attributes/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  sources: (qs) => api(`/api/v1/data-catalog/sources${qs || ""}`),
  source: (ref) => api(`/api/v1/data-catalog/sources/${encodeURIComponent(ref)}`),
  createSource: (body) => api("/api/v1/data-catalog/sources", { method: "POST", body }),
  updateSource: (ref, body) => api(`/api/v1/data-catalog/sources/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setSourceStatus: (ref, status) =>
    api(`/api/v1/data-catalog/sources/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  sourceMappings: (ref, qs) => api(`/api/v1/data-catalog/sources/${encodeURIComponent(ref)}/mappings${qs || ""}`),
  createSourceMapping: (ref, body) =>
    api(`/api/v1/data-catalog/sources/${encodeURIComponent(ref)}/mappings`, { method: "POST", body }),
  updateSourceMapping: (id, body) =>
    api(`/api/v1/data-catalog/source-mappings/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  removeSourceMapping: (id) =>
    api(`/api/v1/data-catalog/source-mappings/${encodeURIComponent(id)}`, { method: "DELETE" }),

  consumers: (qs) => api(`/api/v1/data-catalog/consumers${qs || ""}`),
  consumer: (ref) => api(`/api/v1/data-catalog/consumers/${encodeURIComponent(ref)}`),
  createConsumer: (body) => api("/api/v1/data-catalog/consumers", { method: "POST", body }),
  updateConsumer: (ref, body) =>
    api(`/api/v1/data-catalog/consumers/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setConsumerStatus: (ref, status) =>
    api(`/api/v1/data-catalog/consumers/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  consumerMappings: (ref, qs) => api(`/api/v1/data-catalog/consumers/${encodeURIComponent(ref)}/mappings${qs || ""}`),
  createConsumerMapping: (ref, body) =>
    api(`/api/v1/data-catalog/consumers/${encodeURIComponent(ref)}/mappings`, { method: "POST", body }),
  updateConsumerMapping: (id, body) =>
    api(`/api/v1/data-catalog/consumer-mappings/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  removeConsumerMapping: (id) =>
    api(`/api/v1/data-catalog/consumer-mappings/${encodeURIComponent(id)}`, { method: "DELETE" }),

  lineage: (qs) => api(`/api/v1/data-catalog/lineage${qs || ""}`),
  lineageGraph: (qs) => api(`/api/v1/data-catalog/lineage/graph${qs || ""}`),
  lineageImpact: (qs) => api(`/api/v1/data-catalog/lineage/impact${qs || ""}`),
  createLineage: (body) => api("/api/v1/data-catalog/lineage", { method: "POST", body }),
  updateLineage: (id, body) => api(`/api/v1/data-catalog/lineage/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  removeLineage: (id) => api(`/api/v1/data-catalog/lineage/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runLineageMaintenance: () => api("/api/v1/data-catalog/lineage/maintenance", { method: "POST" }),

  relationshipTypes: (qs) => api(`/api/v1/data-catalog/relationship-types${qs || ""}`),
  createRelationshipType: (body) => api("/api/v1/data-catalog/relationship-types", { method: "POST", body }),
  updateRelationshipType: (ref, body) =>
    api(`/api/v1/data-catalog/relationship-types/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  relationships: (qs) => api(`/api/v1/data-catalog/relationships${qs || ""}`),
  createRelationship: (body) => api("/api/v1/data-catalog/relationships", { method: "POST", body }),
  updateRelationship: (id, body) =>
    api(`/api/v1/data-catalog/relationships/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  removeRelationship: (id) => api(`/api/v1/data-catalog/relationships/${encodeURIComponent(id)}`, { method: "DELETE" }),

  classifications: (qs) => api(`/api/v1/data-catalog/classifications${qs || ""}`),
  createClassification: (body) => api("/api/v1/data-catalog/classifications", { method: "POST", body }),
  updateClassification: (ref, body) =>
    api(`/api/v1/data-catalog/classifications/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setClassificationStatus: (ref, status) =>
    api(`/api/v1/data-catalog/classifications/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  classificationAssignments: (qs) => api(`/api/v1/data-catalog/classification-assignments${qs || ""}`),

  ownership: (qs) => api(`/api/v1/data-catalog/ownership${qs || ""}`),
  createOwnership: (body) => api("/api/v1/data-catalog/ownership", { method: "POST", body }),
  updateOwnership: (id, body) => api(`/api/v1/data-catalog/ownership/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  removeOwnership: (id) => api(`/api/v1/data-catalog/ownership/${encodeURIComponent(id)}`, { method: "DELETE" }),
  ownershipGaps: (qs) => api(`/api/v1/data-catalog/ownership/gaps${qs || ""}`),
  resolveOwnership: (qs) => api(`/api/v1/data-catalog/ownership/resolve${qs || ""}`),

  configuration: () => api("/api/v1/data-catalog/configuration"),
  setConfiguration: (key, value) =>
    api(`/api/v1/data-catalog/configuration/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  importRuns: (qs) => api(`/api/v1/data-catalog/import-runs${qs || ""}`),
  importRun: (id) => api(`/api/v1/data-catalog/import-runs/${encodeURIComponent(id)}`),
  importCatalog: (body) => api("/api/v1/data-catalog/import", { method: "POST", body }),
  exportCatalog: (qs) => api(`/api/v1/data-catalog/export${qs || ""}`),
  submitImport: (body) => api("/api/v1/data-catalog/import/submit", { method: "POST", body }),
  submitExport: (body) => api("/api/v1/data-catalog/export/submit", { method: "POST", body }),
  submitReindex: (body) => api("/api/v1/data-catalog/reindex", { method: "POST", body }),
};

export const glossary = {
  meta: () => api("/api/v1/glossary/meta"),
  metrics: () => api("/api/v1/glossary/metrics"),

  terms: (qs) => api(`/api/v1/glossary/terms${qs || ""}`),
  term: (ref) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}`),
  createTerm: (body) => api("/api/v1/glossary/terms", { method: "POST", body }),
  updateTerm: (ref, body) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  exportTerms: () => api("/api/v1/glossary/terms/export"),

  submitTerm: (ref, body) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/submit`, { method: "POST", body }),
  approveTerm: (ref, body) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/approve`, { method: "POST", body }),
  rejectTerm: (ref, body) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/reject`, { method: "POST", body }),
  setTermStatus: (ref, status) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  definitions: (ref) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/definitions`),
  upsertDefinition: (ref, type, body) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/definitions/${encodeURIComponent(type)}`, { method: "PUT", body }),
  removeDefinition: (ref, type) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/definitions/${encodeURIComponent(type)}`, { method: "DELETE" }),

  synonyms: (ref) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/synonyms`),
  addSynonym: (ref, body) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/synonyms`, { method: "POST", body }),
  removeSynonym: (ref, synonym) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/synonyms/${encodeURIComponent(synonym)}`, { method: "DELETE" }),

  relations: (ref) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/relations`),
  addRelation: (ref, body) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/relations`, { method: "POST", body }),
  removeRelation: (id) => api(`/api/v1/glossary/term-relations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  mappings: (ref) => api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/mappings`),
  addMapping: (ref, body) =>
    api(`/api/v1/glossary/terms/${encodeURIComponent(ref)}/mappings`, { method: "POST", body }),
  removeMapping: (id) => api(`/api/v1/glossary/term-mappings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  termsForTarget: (qs) => api(`/api/v1/glossary/term-mappings${qs || ""}`),
};

export const dataLifecycle = {
  meta: () => api("/api/v1/lifecycle/meta"),
  health: () => api("/api/v1/lifecycle/health"),
  metrics: () => api("/api/v1/lifecycle/metrics"),
  providers: () => api("/api/v1/lifecycle/providers"),

  states: (qs) => api(`/api/v1/lifecycle/states${qs || ""}`),
  state: (code) => api(`/api/v1/lifecycle/states/${encodeURIComponent(code)}`),
  createState: (body) => api("/api/v1/lifecycle/states", { method: "POST", body }),
  updateState: (code, body) => api(`/api/v1/lifecycle/states/${encodeURIComponent(code)}`, { method: "PATCH", body }),
  stateTransitions: (code) => api(`/api/v1/lifecycle/states/${encodeURIComponent(code)}/transitions`),
  transitions: (qs) => api(`/api/v1/lifecycle/transitions${qs || ""}`),
  createTransition: (body) => api("/api/v1/lifecycle/transitions", { method: "POST", body }),
  setTransitionStatus: (id, status) =>
    api(`/api/v1/lifecycle/transitions/${encodeURIComponent(id)}/status`, { method: "POST", body: { status } }),

  tiers: () => api("/api/v1/lifecycle/tiers"),
  setTier: (stateCode, dataTier, description) =>
    api(`/api/v1/lifecycle/tiers/${encodeURIComponent(stateCode)}`, { method: "PUT", body: { data_tier: dataTier, description } }),

  policies: (qs) => api(`/api/v1/lifecycle/policies${qs || ""}`),
  policy: (ref) => api(`/api/v1/lifecycle/policies/${encodeURIComponent(ref)}`),
  createPolicy: (body) => api("/api/v1/lifecycle/policies", { method: "POST", body }),
  updatePolicy: (ref, body) => api(`/api/v1/lifecycle/policies/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setPolicyStatus: (ref, status) =>
    api(`/api/v1/lifecycle/policies/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  policyVersions: (ref) => api(`/api/v1/lifecycle/policies/${encodeURIComponent(ref)}/versions`),
  resolvePolicy: (body) => api("/api/v1/lifecycle/policies/resolve", { method: "POST", body }),

  objects: (qs) => api(`/api/v1/lifecycle/objects${qs || ""}`),
  object: (objectType, objectId) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`),
  registerObject: (body) => api("/api/v1/lifecycle/objects", { method: "POST", body }),
  objectSnapshot: (objectType, objectId) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/snapshot`),
  objectHistory: (objectType, objectId, qs) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/history${qs || ""}`),
  objectDependencies: (objectType, objectId) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/dependencies`),
  objectEligibility: (objectType, objectId, action) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/eligibility?action=${encodeURIComponent(action)}`),
  changeObjectState: (objectType, objectId, body) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/state`, { method: "POST", body }),
  applyRetention: (objectType, objectId, body) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/retention`, { method: "POST", body }),
  setObjectTier: (objectType, objectId, dataTier) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/tier`, { method: "POST", body: { data_tier: dataTier } }),
  archiveObjectByRef: (objectType, objectId, body) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/archive`, { method: "POST", body }),
  moveToColdStorage: (objectType, objectId, body) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/cold-storage`, { method: "POST", body }),
  restoreObjectByRef: (objectType, objectId, body) =>
    api(`/api/v1/lifecycle/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/restore`, { method: "POST", body }),

  checkEligibility: (body) => api("/api/v1/lifecycle/eligibility/check", { method: "POST", body }),
  batchEligibility: (body) => api("/api/v1/lifecycle/eligibility/batch", { method: "POST", body }),
  dueObjects: (qs) => api(`/api/v1/lifecycle/eligibility/due${qs || ""}`),

  legalHolds: (qs) => api(`/api/v1/lifecycle/legal-holds${qs || ""}`),
  legalHold: (ref) => api(`/api/v1/lifecycle/legal-holds/${encodeURIComponent(ref)}`),
  createLegalHold: (body) => api("/api/v1/lifecycle/legal-holds", { method: "POST", body }),
  releaseLegalHold: (ref, body) =>
    api(`/api/v1/lifecycle/legal-holds/${encodeURIComponent(ref)}/release`, { method: "POST", body }),
  cancelLegalHold: (ref, body) =>
    api(`/api/v1/lifecycle/legal-holds/${encodeURIComponent(ref)}/cancel`, { method: "POST", body }),

  dependencies: (qs) => api(`/api/v1/lifecycle/dependencies${qs || ""}`),
  recordDependency: (body) => api("/api/v1/lifecycle/dependencies", { method: "POST", body }),
  refreshDependencies: (body) => api("/api/v1/lifecycle/dependencies/refresh", { method: "POST", body }),
  resolveDependency: (id) => api(`/api/v1/lifecycle/dependencies/${encodeURIComponent(id)}/resolve`, { method: "POST" }),

  archives: (qs) => api(`/api/v1/lifecycle/archives${qs || ""}`),
  archive: (ref) => api(`/api/v1/lifecycle/archives/${encodeURIComponent(ref)}`),
  archiveObject: (body) => api("/api/v1/lifecycle/archives", { method: "POST", body }),
  verifyArchive: (ref) => api(`/api/v1/lifecycle/archives/${encodeURIComponent(ref)}/verify`, { method: "POST" }),

  restores: (qs) => api(`/api/v1/lifecycle/restores${qs || ""}`),
  restore: (ref) => api(`/api/v1/lifecycle/restores/${encodeURIComponent(ref)}`),
  requestRestore: (body) => api("/api/v1/lifecycle/restores", { method: "POST", body }),
  executeRestore: (ref) => api(`/api/v1/lifecycle/restores/${encodeURIComponent(ref)}/execute`, { method: "POST" }),

  purges: (qs) => api(`/api/v1/lifecycle/purges${qs || ""}`),
  purgeSummary: () => api("/api/v1/lifecycle/purges/summary"),
  purge: (ref) => api(`/api/v1/lifecycle/purges/${encodeURIComponent(ref)}`),
  evaluatePurge: (body) => api("/api/v1/lifecycle/purges/evaluate", { method: "POST", body }),
  executePurge: (body) => api("/api/v1/lifecycle/purges", { method: "POST", body }),

  recoveries: (qs) => api(`/api/v1/lifecycle/recoveries${qs || ""}`),
  recovery: (ref) => api(`/api/v1/lifecycle/recoveries/${encodeURIComponent(ref)}`),
  requestRecovery: (body) => api("/api/v1/lifecycle/recoveries", { method: "POST", body }),
  executeRecovery: (ref) => api(`/api/v1/lifecycle/recoveries/${encodeURIComponent(ref)}/execute`, { method: "POST" }),

  history: (qs) => api(`/api/v1/lifecycle/history${qs || ""}`),
  catalogTypes: () => api("/api/v1/lifecycle/catalog-types"),
  snapshots: (body) => api("/api/v1/lifecycle/snapshots", { method: "POST", body }),

  configuration: () => api("/api/v1/lifecycle/configuration"),
  setConfiguration: (key, value) =>
    api(`/api/v1/lifecycle/configuration/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  jobs: (qs) => api(`/api/v1/lifecycle/jobs${qs || ""}`),
  job: (ref) => api(`/api/v1/lifecycle/jobs/${encodeURIComponent(ref)}`),
  submitEvaluation: (body) => api("/api/v1/lifecycle/jobs/evaluate", { method: "POST", body }),
  submitArchive: (body) => api("/api/v1/lifecycle/jobs/archive", { method: "POST", body }),
  submitColdStorage: (body) => api("/api/v1/lifecycle/jobs/cold-storage", { method: "POST", body }),
  submitRestore: (body) => api("/api/v1/lifecycle/jobs/restore", { method: "POST", body }),
  submitPurge: (body) => api("/api/v1/lifecycle/jobs/purge", { method: "POST", body }),
  submitRecovery: (body) => api("/api/v1/lifecycle/jobs/recovery", { method: "POST", body }),
  submitMaintenance: () => api("/api/v1/lifecycle/jobs/maintenance", { method: "POST" }),
};

export const dataExchange = {
  meta: () => api("/api/v1/data-exchange/meta"),
  health: () => api("/api/v1/data-exchange/health"),
  metrics: () => api("/api/v1/data-exchange/metrics"),
  connectors: () => api("/api/v1/data-exchange/connectors"),
  configuration: () => api("/api/v1/data-exchange/configuration"),
  setConfiguration: (key, value) =>
    api(`/api/v1/data-exchange/configuration/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  connectorConfigurations: (qs) => api(`/api/v1/data-exchange/connector-configurations${qs || ""}`),
  connectorConfiguration: (ref) => api(`/api/v1/data-exchange/connector-configurations/${encodeURIComponent(ref)}`),
  createConnectorConfiguration: (body) =>
    api("/api/v1/data-exchange/connector-configurations", { method: "POST", body }),
  testConnectorConfiguration: (ref) =>
    api(`/api/v1/data-exchange/connector-configurations/${encodeURIComponent(ref)}/test`, { method: "POST" }),
  setConnectorConfigurationStatus: (ref, status) =>
    api(`/api/v1/data-exchange/connector-configurations/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  credentialReferences: (qs) => api(`/api/v1/data-exchange/credential-references${qs || ""}`),
  createCredentialReference: (body) =>
    api("/api/v1/data-exchange/credential-references", { method: "POST", body }),

  importDefinitions: (qs) => api(`/api/v1/data-exchange/import-definitions${qs || ""}`),
  importDefinition: (ref) => api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}`),
  createImportDefinition: (body) => api("/api/v1/data-exchange/import-definitions", { method: "POST", body }),
  updateImportDefinition: (ref, body) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setImportDefinitionStatus: (ref, status) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  importDefinitionVersions: (ref) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/versions`),
  importDefinitionCatalog: (ref) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/catalog`),
  validateImportDefinition: (ref, body) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/validate`, { method: "POST", body }),
  previewImport: (ref, body) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/preview`, { method: "POST", body }),
  runImport: (ref, body) =>
    api(`/api/v1/data-exchange/import-definitions/${encodeURIComponent(ref)}/run`, { method: "POST", body }),

  importJobs: (qs) => api(`/api/v1/data-exchange/import-jobs${qs || ""}`),
  importJob: (ref) => api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}`),
  importJobRecords: (ref, qs) => api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}/records${qs || ""}`),
  importJobErrors: (ref, qs) => api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}/errors${qs || ""}`),
  reconcileImportJob: (ref) =>
    api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}/reconcile`, { method: "POST", body: {} }),
  retryImportJob: (ref) => api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}/retry`, { method: "POST" }),
  cancelImportJob: (ref) => api(`/api/v1/data-exchange/import-jobs/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),

  exportDefinitions: (qs) => api(`/api/v1/data-exchange/export-definitions${qs || ""}`),
  exportDefinition: (ref) => api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}`),
  createExportDefinition: (body) => api("/api/v1/data-exchange/export-definitions", { method: "POST", body }),
  updateExportDefinition: (ref, body) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setExportDefinitionStatus: (ref, status) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  exportDefinitionVersions: (ref) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/versions`),
  exportDefinitionCatalog: (ref) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/catalog`),
  validateExportDefinition: (ref) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/validate`, { method: "POST" }),
  previewExport: (ref, body) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/preview`, { method: "POST", body }),
  runExport: (ref, body) =>
    api(`/api/v1/data-exchange/export-definitions/${encodeURIComponent(ref)}/run`, { method: "POST", body }),

  exportJobs: (qs) => api(`/api/v1/data-exchange/export-jobs${qs || ""}`),
  exportJob: (ref) => api(`/api/v1/data-exchange/export-jobs/${encodeURIComponent(ref)}`),
  exportJobResults: (ref) => api(`/api/v1/data-exchange/export-jobs/${encodeURIComponent(ref)}/results`),
  cancelExportJob: (ref) => api(`/api/v1/data-exchange/export-jobs/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),
  exportResults: (qs) => api(`/api/v1/data-exchange/export-results${qs || ""}`),
  downloadExportResult: (ref) =>
    apiDownload(`/api/v1/data-exchange/export-results/${encodeURIComponent(ref)}/download`),

  templates: (qs) => api(`/api/v1/data-exchange/templates${qs || ""}`),
  template: (ref) => api(`/api/v1/data-exchange/templates/${encodeURIComponent(ref)}`),
  createTemplate: (body) => api("/api/v1/data-exchange/templates", { method: "POST", body }),
  updateTemplate: (ref, body) =>
    api(`/api/v1/data-exchange/templates/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setTemplateStatus: (ref, status) =>
    api(`/api/v1/data-exchange/templates/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),

  history: (qs) => api(`/api/v1/data-exchange/history${qs || ""}`),
  jobs: (qs) => api(`/api/v1/data-exchange/jobs${qs || ""}`),
};

export const migration = {
  meta: () => api("/api/v1/migration/meta"),
  health: () => api("/api/v1/migration/health"),
  metrics: () => api("/api/v1/migration/metrics"),
  sourceAdapters: () => api("/api/v1/migration/source-adapters"),
  configuration: () => api("/api/v1/migration/configuration"),
  setConfiguration: (key, value) =>
    api(`/api/v1/migration/configuration/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  sourceConfigurations: (qs) => api(`/api/v1/migration/source-configurations${qs || ""}`),
  sourceConfiguration: (ref) => api(`/api/v1/migration/source-configurations/${encodeURIComponent(ref)}`),
  createSourceConfiguration: (body) =>
    api("/api/v1/migration/source-configurations", { method: "POST", body }),
  updateSourceConfiguration: (ref, body) =>
    api(`/api/v1/migration/source-configurations/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setSourceConfigurationStatus: (ref, status) =>
    api(`/api/v1/migration/source-configurations/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  testSourceConfiguration: (ref) =>
    api(`/api/v1/migration/source-configurations/${encodeURIComponent(ref)}/test`, { method: "POST" }),
  discoverSourceConfiguration: (ref, body) =>
    api(`/api/v1/migration/source-configurations/${encodeURIComponent(ref)}/discover`, { method: "POST", body }),

  projects: (qs) => api(`/api/v1/migration/projects${qs || ""}`),
  project: (ref) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}`),
  createProject: (body) => api("/api/v1/migration/projects", { method: "POST", body }),
  updateProject: (ref, body) =>
    api(`/api/v1/migration/projects/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setProjectStatus: (ref, status) =>
    api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  projectPackages: (ref) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/packages`),
  projectDependencies: (ref) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/dependencies`),
  projectTopology: (ref) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/topology`),
  projectReadiness: (ref) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/readiness`),
  projectPlans: (ref, qs) => api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/plans${qs || ""}`),
  generatePlan: (ref, body) =>
    api(`/api/v1/migration/projects/${encodeURIComponent(ref)}/plans`, { method: "POST", body: body || {} }),

  plans: (qs) => api(`/api/v1/migration/plans${qs || ""}`),
  plan: (ref) => api(`/api/v1/migration/plans/${encodeURIComponent(ref)}`),
  approvePlan: (ref) => api(`/api/v1/migration/plans/${encodeURIComponent(ref)}/approve`, { method: "POST" }),

  packages: (qs) => api(`/api/v1/migration/packages${qs || ""}`),
  package: (ref) => api(`/api/v1/migration/packages/${encodeURIComponent(ref)}`),
  createPackage: (body) => api("/api/v1/migration/packages", { method: "POST", body }),
  updatePackage: (ref, body) =>
    api(`/api/v1/migration/packages/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setPackageStatus: (ref, status) =>
    api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  packageDependencies: (ref) => api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/dependencies`),
  packageReadiness: (ref) => api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/readiness`),
  previewPackage: (ref, body) =>
    api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/preview`, { method: "POST", body: body || {} }),
  validatePackage: (ref, body) =>
    api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/validate`, { method: "POST", body: body || {} }),
  runPackage: (ref, body) =>
    api(`/api/v1/migration/packages/${encodeURIComponent(ref)}/jobs`, { method: "POST", body: body || {} }),

  definitions: (qs) => api(`/api/v1/migration/definitions${qs || ""}`),
  definition: (ref) => api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}`),
  createDefinition: (body) => api("/api/v1/migration/definitions", { method: "POST", body }),
  updateDefinition: (ref, body) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setDefinitionStatus: (ref, status) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  validateDefinition: (ref) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}/validate`, { method: "POST" }),
  definitionVersions: (ref) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}/versions`),
  createDefinitionVersion: (ref, body) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}/versions`, { method: "POST", body: body || {} }),
  runDefinition: (ref, body) =>
    api(`/api/v1/migration/definitions/${encodeURIComponent(ref)}/jobs`, { method: "POST", body: body || {} }),

  jobs: (qs) => api(`/api/v1/migration/jobs${qs || ""}`),
  job: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}`),
  jobBatches: (ref, qs) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/batches${qs || ""}`),
  jobResults: (ref, qs) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/results${qs || ""}`),
  jobErrors: (ref, qs) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/errors${qs || ""}`),
  jobCheckpoints: (ref, qs) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/checkpoints${qs || ""}`),
  jobLineage: (ref, qs) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/lineage${qs || ""}`),
  executeJob: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/execute`, { method: "POST" }),
  cancelJob: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/cancel`, { method: "POST" }),
  pauseJob: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/pause`, { method: "POST" }),
  resumeJob: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/resume`, { method: "POST" }),
  retryJob: (ref) => api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/retry`, { method: "POST" }),
  reconcileJob: (ref, body) =>
    api(`/api/v1/migration/jobs/${encodeURIComponent(ref)}/reconcile`, { method: "POST", body: body || {} }),

  identifierMappings: (qs) => api(`/api/v1/migration/identifier-mappings${qs || ""}`),
  mapIdentifier: (body) => api("/api/v1/migration/identifier-mappings", { method: "POST", body }),
  bulkMapIdentifiers: (body) =>
    api("/api/v1/migration/identifier-mappings/bulk", { method: "POST", body }),
  resolveIdentifier: (qs) => api(`/api/v1/migration/identifier-mappings/resolve${qs || ""}`),

  relationshipMappings: (qs) => api(`/api/v1/migration/relationship-mappings${qs || ""}`),
  migrateRelationship: (body) => api("/api/v1/migration/relationships", { method: "POST", body }),
  bulkMigrateRelationships: (body) => api("/api/v1/migration/relationships/bulk", { method: "POST", body }),
  retryRelationships: (body) => api("/api/v1/migration/relationships/retry", { method: "POST", body: body || {} }),

  fileMigrations: (qs) => api(`/api/v1/migration/file-migrations${qs || ""}`),
  reconciliations: (qs) => api(`/api/v1/migration/reconciliations${qs || ""}`),
  reconciliation: (ref) => api(`/api/v1/migration/reconciliations/${encodeURIComponent(ref)}`),
  reconciliationExceptions: (ref, qs) =>
    api(`/api/v1/migration/reconciliations/${encodeURIComponent(ref)}/exceptions${qs || ""}`),
  statistics: (qs) => api(`/api/v1/migration/statistics${qs || ""}`),
  audit: (qs) => api(`/api/v1/migration/audit${qs || ""}`),
  objectLineage: (qs) => api(`/api/v1/migration/object-lineage${qs || ""}`),
};

export const classification = {
  meta: () => api("/api/v1/classification/meta"),
  health: () => api("/api/v1/classification/health"),
  metrics: () => api("/api/v1/classification/metrics"),
  coverage: (qs) => api(`/api/v1/classification/coverage${qs || ""}`),
  configuration: () => api("/api/v1/classification/config"),
  setConfiguration: (key, value) =>
    api(`/api/v1/classification/config/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  classifications: (qs) => api(`/api/v1/classification/classifications${qs || ""}`),
  classification: (ref) => api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}`),
  createClassification: (body) => api("/api/v1/classification/classifications", { method: "POST", body }),
  updateClassification: (ref, body) =>
    api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setClassificationStatus: (ref, status) =>
    api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  approveClassification: (ref) =>
    api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}/approve`, { method: "POST" }),
  classificationVersions: (ref) =>
    api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}/versions`),
  classificationTree: (ref, qs) =>
    api(`/api/v1/classification/classifications/${encodeURIComponent(ref)}/tree${qs || ""}`),

  classes: (qs) => api(`/api/v1/classification/classes${qs || ""}`),
  class: (ref) => api(`/api/v1/classification/classes/${encodeURIComponent(ref)}`),
  createClass: (body) => api("/api/v1/classification/classes", { method: "POST", body }),
  updateClass: (ref, body) =>
    api(`/api/v1/classification/classes/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setClassStatus: (ref, status) =>
    api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  moveClass: (ref, body) =>
    api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/move`, { method: "POST", body }),
  classEffective: (ref) => api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/effective`),
  classCharacteristics: (ref) => api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/characteristics`),
  addClassCharacteristic: (ref, body) =>
    api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/characteristics`, { method: "POST", body }),
  validateClass: (ref, body) =>
    api(`/api/v1/classification/classes/${encodeURIComponent(ref)}/validate`, { method: "POST", body }),
  updateClassCharacteristic: (ref, body) =>
    api(`/api/v1/classification/class-characteristics/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  removeClassCharacteristic: (ref) =>
    api(`/api/v1/classification/class-characteristics/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  characteristics: (qs) => api(`/api/v1/classification/characteristics${qs || ""}`),
  characteristic: (ref) => api(`/api/v1/classification/characteristics/${encodeURIComponent(ref)}`),
  createCharacteristic: (body) => api("/api/v1/classification/characteristics", { method: "POST", body }),
  updateCharacteristic: (ref, body) =>
    api(`/api/v1/classification/characteristics/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setCharacteristicStatus: (ref, status) =>
    api(`/api/v1/classification/characteristics/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  allowedValues: (ref, qs) =>
    api(`/api/v1/classification/characteristics/${encodeURIComponent(ref)}/allowed-values${qs || ""}`),
  createAllowedValue: (ref, body) =>
    api(`/api/v1/classification/characteristics/${encodeURIComponent(ref)}/allowed-values`, { method: "POST", body }),
  updateAllowedValue: (ref, body) =>
    api(`/api/v1/classification/allowed-values/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteAllowedValue: (ref) =>
    api(`/api/v1/classification/allowed-values/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  groups: (qs) => api(`/api/v1/classification/groups${qs || ""}`),
  createGroup: (body) => api("/api/v1/classification/groups", { method: "POST", body }),
  groupMembers: (ref) => api(`/api/v1/classification/groups/${encodeURIComponent(ref)}/members`),
  addGroupMember: (ref, body) =>
    api(`/api/v1/classification/groups/${encodeURIComponent(ref)}/members`, { method: "POST", body }),

  rules: (qs) => api(`/api/v1/classification/rules${qs || ""}`),
  createRule: (body) => api("/api/v1/classification/rules", { method: "POST", body }),
  updateRule: (ref, body) =>
    api(`/api/v1/classification/rules/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteRule: (ref) => api(`/api/v1/classification/rules/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  assignments: (qs) => api(`/api/v1/classification/assignments${qs || ""}`),
  assignment: (ref) => api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}`),
  assign: (body) => api("/api/v1/classification/assignments", { method: "POST", body }),
  setAssignmentValues: (ref, body) =>
    api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}/values`, { method: "PUT", body }),
  setAssignmentStatus: (ref, status) =>
    api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  reclassify: (ref, body) =>
    api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}/reclassify`, { method: "POST", body }),
  validateAssignment: (ref) =>
    api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}/validate`, { method: "POST" }),
  unassign: (ref) => api(`/api/v1/classification/assignments/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  objectClassifications: (objectType, objectId, qs) =>
    api(`/api/v1/classification/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}${qs || ""}`),
  objectValues: (objectType, objectId) =>
    api(`/api/v1/classification/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/values`),
  validateObject: (objectType, objectId) =>
    api(`/api/v1/classification/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}/validate`, { method: "POST" }),
  validateBatch: (objectType, body) =>
    api(`/api/v1/classification/objects/${encodeURIComponent(objectType)}/validate-batch`, { method: "POST", body }),

  scanDuplicates: (body) => api("/api/v1/classification/duplicates/scan", { method: "POST", body }),
  duplicateSummary: () => api("/api/v1/classification/duplicates/summary"),

  units: (qs) => api(`/api/v1/classification/units${qs || ""}`),
  convertUnit: (body) => api("/api/v1/classification/units/convert", { method: "POST", body }),

  history: (qs) => api(`/api/v1/classification/history${qs || ""}`),
  lineage: (objectType, objectId) =>
    api(`/api/v1/classification/lineage/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`),

  submitBulkAssign: (body) => api("/api/v1/classification/jobs/bulk-assign", { method: "POST", body }),
  submitBulkValidate: (body) => api("/api/v1/classification/jobs/bulk-validate", { method: "POST", body }),
  submitDuplicateScan: (body) => api("/api/v1/classification/jobs/duplicate-scan", { method: "POST", body }),
  submitMaintenance: () => api("/api/v1/classification/jobs/maintenance", { method: "POST" }),
};

export const bom = {
  meta: () => api("/api/v1/bom/meta"),
  health: () => api("/api/v1/bom/health"),
  metrics: (qs) => api(`/api/v1/bom/metrics${qs || ""}`),
  compareSummary: () => api("/api/v1/bom/compare-summary"),
  configuration: () => api("/api/v1/bom/config"),
  setConfiguration: (key, value) =>
    api(`/api/v1/bom/config/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),
  units: (qs) => api(`/api/v1/bom/units${qs || ""}`),
  convertUnit: (qs) => api(`/api/v1/bom/units/convert${qs || ""}`),

  boms: (qs) => api(`/api/v1/bom/boms${qs || ""}`),
  bom: (ref) => api(`/api/v1/bom/boms/${encodeURIComponent(ref)}`),
  createBom: (body) => api("/api/v1/bom/boms", { method: "POST", body }),
  updateBom: (ref, body) =>
    api(`/api/v1/bom/boms/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setBomStatus: (ref, status) =>
    api(`/api/v1/bom/boms/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  deleteBom: (ref) => api(`/api/v1/bom/boms/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  bomRevisions: (ref, qs) =>
    api(`/api/v1/bom/boms/${encodeURIComponent(ref)}/revisions${qs || ""}`),
  createRevision: (ref, body) =>
    api(`/api/v1/bom/boms/${encodeURIComponent(ref)}/revisions`, { method: "POST", body }),

  revisions: (qs) => api(`/api/v1/bom/revisions${qs || ""}`),
  revision: (ref) => api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}`),
  updateRevision: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setRevisionStatus: (ref, status) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  reviseRevision: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/revise`, { method: "POST", body }),
  deleteRevision: (ref) => api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  revisionTree: (ref, qs) => api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/tree${qs || ""}`),
  revisionStructure: (ref, qs) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/structure${qs || ""}`),
  revisionLines: (ref, qs) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/lines${qs || ""}`),
  createLine: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/lines`, { method: "POST", body }),
  reorderLines: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/lines/reorder`, { method: "POST", body }),
  revisionSubstitutes: (ref, qs) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/substitutes${qs || ""}`),
  createSubstitute: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/substitutes`, { method: "POST", body }),
  substituteSummary: (ref) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/substitutes/summary`),
  revisionRollup: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/rollup`, { method: "POST", body }),
  revisionValidate: (ref, body) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/validate`, { method: "POST", body }),
  revisionValidationResults: (ref, qs) =>
    api(`/api/v1/bom/revisions/${encodeURIComponent(ref)}/validation-results${qs || ""}`),

  lines: (qs) => api(`/api/v1/bom/lines${qs || ""}`),
  line: (ref) => api(`/api/v1/bom/lines/${encodeURIComponent(ref)}`),
  updateLine: (ref, body) =>
    api(`/api/v1/bom/lines/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteLine: (ref) => api(`/api/v1/bom/lines/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  lineAttributes: (ref) => api(`/api/v1/bom/lines/${encodeURIComponent(ref)}/attributes`),
  setLineAttributes: (ref, body) =>
    api(`/api/v1/bom/lines/${encodeURIComponent(ref)}/attributes`, { method: "PUT", body }),

  substitutes: (qs) => api(`/api/v1/bom/substitutes${qs || ""}`),
  updateSubstitute: (ref, body) =>
    api(`/api/v1/bom/substitutes/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteSubstitute: (ref) => api(`/api/v1/bom/substitutes/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  whereUsed: (objectId, qs) =>
    api(`/api/v1/bom/where-used/${encodeURIComponent(objectId)}${qs || ""}`),
  whereUsedSearch: (qs) => api(`/api/v1/bom/where-used${qs || ""}`),
  multiLevelWhereUsed: (objectId, body) =>
    api(`/api/v1/bom/where-used/${encodeURIComponent(objectId)}/multi-level`, { method: "POST", body }),
  componentUsageSummary: (objectId, qs) =>
    api(`/api/v1/bom/where-used/${encodeURIComponent(objectId)}/summary${qs || ""}`),
  uses: (qs) => api(`/api/v1/bom/uses${qs || ""}`),

  compare: (body) => api("/api/v1/bom/compare", { method: "POST", body }),
  comparisons: (qs) => api(`/api/v1/bom/comparisons${qs || ""}`),
  comparison: (ref) => api(`/api/v1/bom/comparisons/${encodeURIComponent(ref)}`),
  comparisonResults: (ref, qs) =>
    api(`/api/v1/bom/comparisons/${encodeURIComponent(ref)}/results${qs || ""}`),

  transformations: (qs) => api(`/api/v1/bom/transformations${qs || ""}`),
  transformation: (ref) => api(`/api/v1/bom/transformations/${encodeURIComponent(ref)}`),
  createTransformation: (body) => api("/api/v1/bom/transformations", { method: "POST", body }),
  updateTransformation: (ref, body) =>
    api(`/api/v1/bom/transformations/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteTransformation: (ref) =>
    api(`/api/v1/bom/transformations/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  transformationMappings: (ref, qs) =>
    api(`/api/v1/bom/transformations/${encodeURIComponent(ref)}/mappings${qs || ""}`),
  createTransformationMapping: (ref, body) =>
    api(`/api/v1/bom/transformations/${encodeURIComponent(ref)}/mappings`, { method: "POST", body }),
  transform: (body) => api("/api/v1/bom/transform", { method: "POST", body }),
  transformationRuns: (qs) => api(`/api/v1/bom/transformation-runs${qs || ""}`),
  transformationRun: (ref) => api(`/api/v1/bom/transformation-runs/${encodeURIComponent(ref)}`),

  validationRules: (qs) => api(`/api/v1/bom/validation-rules${qs || ""}`),
  createValidationRule: (body) => api("/api/v1/bom/validation-rules", { method: "POST", body }),
  updateValidationRule: (ref, body) =>
    api(`/api/v1/bom/validation-rules/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  deleteValidationRule: (ref) =>
    api(`/api/v1/bom/validation-rules/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  validationResults: (qs) => api(`/api/v1/bom/validation-results${qs || ""}`),
  validationResult: (ref) => api(`/api/v1/bom/validation-results/${encodeURIComponent(ref)}`),
  validationIssues: (ref, qs) =>
    api(`/api/v1/bom/validation-results/${encodeURIComponent(ref)}/issues${qs || ""}`),

  baselines: (qs) => api(`/api/v1/bom/baselines${qs || ""}`),
  baseline: (ref) => api(`/api/v1/bom/baselines/${encodeURIComponent(ref)}`),
  createBaseline: (body) => api("/api/v1/bom/baselines", { method: "POST", body }),
  baselineLines: (ref, qs) =>
    api(`/api/v1/bom/baselines/${encodeURIComponent(ref)}/lines${qs || ""}`),
  baselineSnapshot: (ref) => api(`/api/v1/bom/baselines/${encodeURIComponent(ref)}/snapshot`),
  freezeBaseline: (ref) =>
    api(`/api/v1/bom/baselines/${encodeURIComponent(ref)}/freeze`, { method: "POST" }),
  deleteBaseline: (ref) => api(`/api/v1/bom/baselines/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  history: (qs) => api(`/api/v1/bom/history${qs || ""}`),
  objectLineage: (objectType, objectId) =>
    api(`/api/v1/bom/history/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`),

  searchMeta: () => api("/api/v1/bom/search-meta"),
  reindexSearch: () => api("/api/v1/bom/search/reindex", { method: "POST" }),
  seed: () => api("/api/v1/bom/seed", { method: "POST" }),
  ensureFoundation: () => api("/api/v1/bom/foundation/ensure", { method: "POST" }),

  submitRollupJob: (body) => api("/api/v1/bom/jobs/rollup", { method: "POST", body }),
  submitWhereUsedJob: (body) => api("/api/v1/bom/jobs/where-used", { method: "POST", body }),
  submitTransformJob: (body) => api("/api/v1/bom/jobs/transform", { method: "POST", body }),
  submitValidateJob: (body) => api("/api/v1/bom/jobs/validate", { method: "POST", body }),
  submitCompareJob: (body) => api("/api/v1/bom/jobs/compare", { method: "POST", body }),
  submitMaintenanceJob: () => api("/api/v1/bom/jobs/maintenance", { method: "POST" }),
};

export const pdm = {
  meta: () => api("/api/v1/pdm/meta"),
  health: () => api("/api/v1/pdm/health"),
  metrics: (qs) => api(`/api/v1/pdm/metrics${qs || ""}`),
  ruleUsage: (qs) => api(`/api/v1/pdm/rule-usage${qs || ""}`),
  configuration: () => api("/api/v1/pdm/config"),
  setConfiguration: (key, value) =>
    api(`/api/v1/pdm/config/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),

  items: (qs) => api(`/api/v1/pdm/items${qs || ""}`),
  item: (ref) => api(`/api/v1/pdm/items/${encodeURIComponent(ref)}`),
  createItem: (body) => api("/api/v1/pdm/items", { method: "POST", body }),
  updateItem: (ref, body) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setItemStatus: (ref, status) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  deleteItem: (ref) => api(`/api/v1/pdm/items/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  itemRevisions: (ref, qs) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/revisions${qs || ""}`),
  itemStructure: (ref, qs) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/structure${qs || ""}`),
  itemWhereUsed: (ref, qs) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/where-used${qs || ""}`),
  itemAudit: (ref, qs) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/audit${qs || ""}`),

  parts: (qs) => api(`/api/v1/pdm/parts${qs || ""}`),
  products: (qs) => api(`/api/v1/pdm/products${qs || ""}`),

  revisions: (qs) => api(`/api/v1/pdm/revisions${qs || ""}`),
  revision: (ref) => api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}`),
  createRevision: (ref, body) =>
    api(`/api/v1/pdm/items/${encodeURIComponent(ref)}/revisions`, { method: "POST", body }),
  updateRevision: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  setRevisionStatus: (ref, status) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/status`, { method: "POST", body: { status } }),
  reviseRevision: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/revise`, { method: "POST", body }),
  deleteRevision: (ref) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  revisionValidate: (ref) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/validate`, { method: "POST" }),
  revisionDatasets: (ref, qs) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/datasets${qs || ""}`),
  revisionRepresentations: (ref, qs) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/representations${qs || ""}`),
  revisionDesignData: (ref, qs) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/design-data${qs || ""}`),
  revisionCad: (ref, qs) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/cad${qs || ""}`),

  datasets: (qs) => api(`/api/v1/pdm/datasets${qs || ""}`),
  dataset: (ref) => api(`/api/v1/pdm/datasets/${encodeURIComponent(ref)}`),
  createDataset: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/datasets`, { method: "POST", body }),
  linkDatasetContent: (ref, body) =>
    api(`/api/v1/pdm/datasets/${encodeURIComponent(ref)}/content`, { method: "POST", body }),

  representations: (qs) => api(`/api/v1/pdm/representations${qs || ""}`),
  createRepresentation: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/representations`, { method: "POST", body }),

  designData: (qs) => api(`/api/v1/pdm/design-data${qs || ""}`),
  createDesignData: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/design-data`, { method: "POST", body }),

  cadAssociations: (qs) => api(`/api/v1/pdm/cad-associations${qs || ""}`),
  createCadAssociation: (ref, body) =>
    api(`/api/v1/pdm/revisions/${encodeURIComponent(ref)}/cad`, { method: "POST", body }),

  revisionRules: (qs) => api(`/api/v1/pdm/revision-rules${qs || ""}`),
  revisionRule: (ref) => api(`/api/v1/pdm/revision-rules/${encodeURIComponent(ref)}`),
  createRevisionRule: (body) => api("/api/v1/pdm/revision-rules", { method: "POST", body }),
  activateRevisionRule: (ref) =>
    api(`/api/v1/pdm/revision-rules/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  resolveRevisionRule: (body) => api("/api/v1/pdm/revision-rules/resolve", { method: "POST", body }),
  revisionRuleVersions: (ref) =>
    api(`/api/v1/pdm/revision-rules/${encodeURIComponent(ref)}/versions`),

  configurationRules: (qs) => api(`/api/v1/pdm/configuration-rules${qs || ""}`),
  createConfigurationRule: (body) => api("/api/v1/pdm/configuration-rules", { method: "POST", body }),
  activateConfigurationRule: (ref) =>
    api(`/api/v1/pdm/configuration-rules/${encodeURIComponent(ref)}/activate`, { method: "POST" }),
  evaluateConfigurationRules: (body) =>
    api("/api/v1/pdm/configuration-rules/evaluate", { method: "POST", body }),

  baselines: (qs) => api(`/api/v1/pdm/baselines${qs || ""}`),
  baseline: (ref) => api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}`),
  createBaseline: (body) => api("/api/v1/pdm/baselines", { method: "POST", body }),
  releaseBaseline: (ref) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/release`, { method: "POST" }),
  freezeBaseline: (ref) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/freeze`, { method: "POST" }),
  retireBaseline: (ref) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/retire`, { method: "POST" }),
  baselineMembers: (ref, qs) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/members${qs || ""}`),
  addBaselineMember: (ref, body) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/members`, { method: "POST", body }),
  baselineSnapshot: (ref) =>
    api(`/api/v1/pdm/baselines/${encodeURIComponent(ref)}/snapshot`),

  relationships: (qs) => api(`/api/v1/pdm/relationships${qs || ""}`),
  createRelationship: (body) => api("/api/v1/pdm/relationships", { method: "POST", body }),
  references: (qs) => api(`/api/v1/pdm/references${qs || ""}`),
  whereUsed: (refOrQs, qs) =>
    refOrQs && !refOrQs.startsWith("?")
      ? api(`/api/v1/pdm/where-used/${encodeURIComponent(refOrQs)}${qs || ""}`)
      : api(`/api/v1/pdm/where-used${refOrQs || qs || ""}`),
  whereReferenced: (targetType, targetId, qs) =>
    api(`/api/v1/pdm/where-referenced/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}${qs || ""}`),
  referencesSummary: (targetType, targetId) =>
    api(`/api/v1/pdm/references/summary?target_type=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(targetId)}`),

  structure: (ref, qs) => api(`/api/v1/pdm/structure/${encodeURIComponent(ref)}${qs || ""}`),
  resolveStructure: (body) => api("/api/v1/pdm/structure/resolve", { method: "POST", body }),
  validateStructure: (ref) => api(`/api/v1/pdm/structure/${encodeURIComponent(ref)}/validate`),

  validationRules: (qs) => api(`/api/v1/pdm/validation-rules${qs || ""}`),
  createValidationRule: (body) => api("/api/v1/pdm/validation-rules", { method: "POST", body }),
  runValidation: (body) => api("/api/v1/pdm/validation/run", { method: "POST", body: body || {} }),
  validationResults: (qs) => api(`/api/v1/pdm/validation-results${qs || ""}`),
  validationResult: (ref) => api(`/api/v1/pdm/validation-results/${encodeURIComponent(ref)}`),

  history: (qs) => api(`/api/v1/pdm/history${qs || ""}`),
  objectLineage: (objectType, objectId) =>
    api(`/api/v1/pdm/history/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`),

  searchMeta: () => api("/api/v1/pdm/search-meta"),
  reindexSearch: () => api("/api/v1/pdm/search/reindex", { method: "POST" }),
  seed: () => api("/api/v1/pdm/seed", { method: "POST" }),
  ensureFoundation: () => api("/api/v1/pdm/foundation/ensure", { method: "POST" }),

  submitStructureJob: (body) => api("/api/v1/pdm/jobs/structure", { method: "POST", body }),
  submitWhereUsedJob: (body) => api("/api/v1/pdm/jobs/where-used", { method: "POST", body }),
  submitWhereReferencedJob: (body) => api("/api/v1/pdm/jobs/where-referenced", { method: "POST", body }),
  submitBaselineJob: (body) => api("/api/v1/pdm/jobs/baseline", { method: "POST", body }),
  submitValidateJob: (body) => api("/api/v1/pdm/jobs/validate", { method: "POST", body }),
  submitReindexJob: (body) => api("/api/v1/pdm/jobs/reindex", { method: "POST", body }),
  submitMaintenanceJob: () => api("/api/v1/pdm/jobs/maintenance", { method: "POST" }),
};
