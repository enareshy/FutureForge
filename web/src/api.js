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
