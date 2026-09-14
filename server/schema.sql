PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'organization',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  description TEXT DEFAULT '',
  parent_id INTEGER REFERENCES organizations(id),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations(parent_id);
CREATE INDEX IF NOT EXISTS idx_organizations_kind ON organizations(kind);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  employee_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'locked')),
  organization_id INTEGER REFERENCES organizations(id),
  tenant_id INTEGER REFERENCES organizations(id),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_changed_at TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  parent_id INTEGER REFERENCES groups(id),
  organization_id INTEGER REFERENCES organizations(id),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  parent_id INTEGER REFERENCES roles(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_id, organization_id)
);

CREATE TABLE IF NOT EXISTS group_roles (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, role_id, organization_id)
);

CREATE TABLE IF NOT EXISTS password_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_length INTEGER NOT NULL DEFAULT 10,
  require_uppercase INTEGER NOT NULL DEFAULT 1,
  require_lowercase INTEGER NOT NULL DEFAULT 1,
  require_digit INTEGER NOT NULL DEFAULT 1,
  require_special INTEGER NOT NULL DEFAULT 1,
  max_age_days INTEGER NOT NULL DEFAULT 90,
  history_count INTEGER NOT NULL DEFAULT 5,
  lockout_threshold INTEGER NOT NULL DEFAULT 5,
  lockout_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  public_id TEXT,
  ip TEXT,
  user_agent TEXT,
  provider_code TEXT DEFAULT 'password',
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  revoked_at TEXT,
  tenant_id INTEGER REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('password', 'oidc', 'saml', 'ldap')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS mfa_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('totp')),
  label TEXT DEFAULT 'Authenticator',
  secret_enc TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mfa_factors_user ON mfa_factors(user_id);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_code TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sso_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL UNIQUE,
  nonce TEXT,
  code_verifier_enc TEXT DEFAULT '',
  provider_id INTEGER NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  redirect_uri TEXT DEFAULT '',
  relay TEXT DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket ON auth_attempts(bucket, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'object' CHECK (kind IN ('module', 'object')),
  parent_id INTEGER REFERENCES resources(id),
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resources_app ON resources(application_id);
CREATE INDEX IF NOT EXISTS idx_resources_parent ON resources(parent_id);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'read', 'update', 'delete', 'execute')),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (resource_id, action)
);

CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource_id);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  organization_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, permission_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

CREATE TABLE IF NOT EXISTS hierarchy_levels (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  allow_root INTEGER NOT NULL DEFAULT 0 CHECK (allow_root IN (0, 1)),
  collection TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hierarchy_parent_rules (
  child_code TEXT NOT NULL REFERENCES hierarchy_levels(code) ON DELETE CASCADE,
  parent_code TEXT NOT NULL,
  PRIMARY KEY (child_code, parent_code)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  feature TEXT NOT NULL DEFAULT 'platform',
  description TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config_definitions (
  key TEXT PRIMARY KEY,
  value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('boolean', 'number', 'string', 'json')),
  default_value TEXT NOT NULL DEFAULT '',
  min_value TEXT DEFAULT '',
  max_value TEXT DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '["system"]',
  system_only INTEGER NOT NULL DEFAULT 0 CHECK (system_only IN (0, 1)),
  feature TEXT NOT NULL DEFAULT 'platform',
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config_values (
  key TEXT NOT NULL REFERENCES config_definitions(key) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('system', 'tenant', 'organization')),
  scope_id INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_config_values_scope ON config_values(scope, scope_id);

-- ============================================================
-- Metadata & Configuration Management engine
-- ============================================================

CREATE TABLE IF NOT EXISTS metadata_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  module TEXT NOT NULL DEFAULT 'platform',
  parent_type_id INTEGER REFERENCES metadata_types(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_types_code
  ON metadata_types(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_metadata_types_parent ON metadata_types(parent_type_id);
CREATE INDEX IF NOT EXISTS idx_metadata_types_tenant ON metadata_types(tenant_id);

CREATE TABLE IF NOT EXISTS metadata_lovs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  selection_type TEXT NOT NULL DEFAULT 'single' CHECK (selection_type IN ('single', 'multi')),
  parent_lov_id INTEGER REFERENCES metadata_lovs(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_lovs_code
  ON metadata_lovs(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_metadata_lovs_tenant ON metadata_lovs(tenant_id);

CREATE TABLE IF NOT EXISTS metadata_lov_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lov_id INTEGER NOT NULL REFERENCES metadata_lovs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  parent_value_id INTEGER REFERENCES metadata_lov_values(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lov_id, code)
);

CREATE INDEX IF NOT EXISTS idx_metadata_lov_values_lov ON metadata_lov_values(lov_id);
CREATE INDEX IF NOT EXISTS idx_metadata_lov_values_parent ON metadata_lov_values(parent_value_id);

CREATE TABLE IF NOT EXISTS metadata_lov_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lov_id INTEGER NOT NULL REFERENCES metadata_lovs(id) ON DELETE CASCADE,
  value_id INTEGER REFERENCES metadata_lov_values(id) ON DELETE SET NULL,
  ref_type TEXT NOT NULL DEFAULT 'record',
  ref_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lov_id, value_id, ref_type, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_lov_usage_value ON metadata_lov_usage(value_id);

CREATE TABLE IF NOT EXISTS metadata_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string'
    CHECK (data_type IN ('string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'reference', 'multi_value')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  default_value TEXT DEFAULT '',
  min_length INTEGER,
  max_length INTEGER,
  min_value REAL,
  max_value REAL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  multi_value INTEGER NOT NULL DEFAULT 0 CHECK (multi_value IN (0, 1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  editable INTEGER NOT NULL DEFAULT 1 CHECK (editable IN (0, 1)),
  parent_attribute_id INTEGER REFERENCES metadata_attributes(id),
  lov_id INTEGER REFERENCES metadata_lovs(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_attributes_code
  ON metadata_attributes(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_metadata_attributes_tenant ON metadata_attributes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_metadata_attributes_parent ON metadata_attributes(parent_attribute_id);

CREATE TABLE IF NOT EXISTS metadata_type_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES metadata_types(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES metadata_attributes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL DEFAULT 0,
  required_override INTEGER CHECK (required_override IN (0, 1)),
  default_override TEXT,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  editable INTEGER NOT NULL DEFAULT 1 CHECK (editable IN (0, 1)),
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_type_attributes_type ON metadata_type_attributes(type_id);

CREATE TABLE IF NOT EXISTS metadata_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  type_id INTEGER NOT NULL REFERENCES metadata_types(id),
  mode TEXT NOT NULL DEFAULT 'create' CHECK (mode IN ('create', 'edit', 'view')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_forms_code
  ON metadata_forms(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_metadata_forms_type ON metadata_forms(type_id);
CREATE INDEX IF NOT EXISTS idx_metadata_forms_tenant ON metadata_forms(tenant_id);

CREATE TABLE IF NOT EXISTS metadata_form_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES metadata_forms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tab', 'section', 'group')),
  parent_id INTEGER REFERENCES metadata_form_nodes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  conditions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (form_id, code)
);

CREATE INDEX IF NOT EXISTS idx_metadata_form_nodes_form ON metadata_form_nodes(form_id);

CREATE TABLE IF NOT EXISTS metadata_form_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES metadata_forms(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES metadata_attributes(id),
  node_id INTEGER REFERENCES metadata_form_nodes(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  label_override TEXT DEFAULT '',
  placeholder TEXT DEFAULT '',
  help_text TEXT DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  required_override INTEGER CHECK (required_override IN (0, 1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  editable INTEGER NOT NULL DEFAULT 1 CHECK (editable IN (0, 1)),
  default_override TEXT,
  col_span INTEGER NOT NULL DEFAULT 12,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (form_id, code)
);

CREATE INDEX IF NOT EXISTS idx_metadata_form_fields_form ON metadata_form_fields(form_id);
CREATE INDEX IF NOT EXISTS idx_metadata_form_fields_node ON metadata_form_fields(node_id);

CREATE TABLE IF NOT EXISTS metadata_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'validation'
    CHECK (category IN ('validation', 'visibility', 'editability', 'default', 'dependency', 'condition')),
  type_id INTEGER REFERENCES metadata_types(id),
  form_id INTEGER REFERENCES metadata_forms(id),
  target_field TEXT DEFAULT '',
  condition_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_rules_code
  ON metadata_rules(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_metadata_rules_type ON metadata_rules(type_id);
CREATE INDEX IF NOT EXISTS idx_metadata_rules_form ON metadata_rules(form_id);
CREATE INDEX IF NOT EXISTS idx_metadata_rules_tenant ON metadata_rules(tenant_id);

CREATE TABLE IF NOT EXISTS metadata_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('type', 'attribute', 'lov', 'form', 'rule')),
  artifact_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  snapshot TEXT NOT NULL DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (artifact_type, artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_metadata_versions_artifact ON metadata_versions(artifact_type, artifact_id);

CREATE TABLE IF NOT EXISTS metadata_configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('system', 'tenant', 'organization')),
  scope_id INTEGER NOT NULL DEFAULT 0,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('type', 'attribute', 'lov', 'form', 'rule')),
  artifact_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  pinned_version INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, scope_id, artifact_type, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_configurations_scope ON metadata_configurations(scope, scope_id);
