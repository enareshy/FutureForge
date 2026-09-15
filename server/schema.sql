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

-- ============================================================
-- Object & Relationship Framework
-- Objects are metadata-typed business instances; relationship
-- types define edges; references track strong/weak/external
-- links and dependencies for integrity and impact analysis.
-- ============================================================

CREATE TABLE IF NOT EXISTS relationship_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  module TEXT NOT NULL DEFAULT 'platform',
  source_type_id INTEGER REFERENCES metadata_types(id),
  target_type_id INTEGER REFERENCES metadata_types(id),
  cardinality TEXT NOT NULL DEFAULT 'N:N' CHECK (cardinality IN ('1:1', '1:N', 'N:1', 'N:N')),
  directed INTEGER NOT NULL DEFAULT 1 CHECK (directed IN (0, 1)),
  bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
  inverse_code TEXT DEFAULT '',
  semantic TEXT NOT NULL DEFAULT 'association'
    CHECK (semantic IN ('association', 'aggregation', 'composition')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  min_occurrences INTEGER NOT NULL DEFAULT 0,
  max_occurrences INTEGER,
  allow_self INTEGER NOT NULL DEFAULT 0 CHECK (allow_self IN (0, 1)),
  cascade_delete INTEGER NOT NULL DEFAULT 0 CHECK (cascade_delete IN (0, 1)),
  attributes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_types_code
  ON relationship_types(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_relationship_types_source ON relationship_types(source_type_id);
CREATE INDEX IF NOT EXISTS idx_relationship_types_target ON relationship_types(target_type_id);
CREATE INDEX IF NOT EXISTS idx_relationship_types_tenant ON relationship_types(tenant_id);

CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  object_type_id INTEGER NOT NULL REFERENCES metadata_types(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'released', 'obsolete', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL DEFAULT '{}',
  owner_id INTEGER REFERENCES users(id),
  owner_object_id INTEGER REFERENCES objects(id),
  organization_id INTEGER REFERENCES organizations(id),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  external_ref TEXT DEFAULT '',
  external_system TEXT DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_code ON objects(tenant_id, code);
CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(object_type_id);
CREATE INDEX IF NOT EXISTS idx_objects_tenant ON objects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(status);
CREATE INDEX IF NOT EXISTS idx_objects_owner ON objects(owner_id);
CREATE INDEX IF NOT EXISTS idx_objects_org ON objects(organization_id);
CREATE INDEX IF NOT EXISTS idx_objects_deleted ON objects(deleted_at);
CREATE INDEX IF NOT EXISTS idx_objects_name ON objects(name);

CREATE TABLE IF NOT EXISTS object_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  change_type TEXT NOT NULL DEFAULT 'update',
  snapshot TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (object_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_object_versions_object ON object_versions(object_id);

CREATE TABLE IF NOT EXISTS object_checkouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  locked_by INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'exclusive' CHECK (scope IN ('exclusive', 'shared')),
  reason TEXT DEFAULT '',
  expires_at TEXT,
  released_at TEXT,
  released_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_object_checkouts_object ON object_checkouts(object_id, released_at);

CREATE TABLE IF NOT EXISTS object_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relationship_type_id INTEGER NOT NULL REFERENCES relationship_types(id),
  source_object_id INTEGER NOT NULL REFERENCES objects(id),
  target_object_id INTEGER NOT NULL REFERENCES objects(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'inactive', 'expired')),
  sequence INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT,
  valid_to TEXT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (relationship_type_id, source_object_id, target_object_id)
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON object_relationships(source_object_id, status);
CREATE INDEX IF NOT EXISTS idx_rel_target ON object_relationships(target_object_id, status);
CREATE INDEX IF NOT EXISTS idx_rel_type ON object_relationships(relationship_type_id);
CREATE INDEX IF NOT EXISTS idx_rel_tenant ON object_relationships(tenant_id);

CREATE TABLE IF NOT EXISTS object_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_object_id INTEGER NOT NULL REFERENCES objects(id),
  target_object_id INTEGER REFERENCES objects(id),
  reference_type TEXT NOT NULL DEFAULT 'weak'
    CHECK (reference_type IN ('strong', 'weak', 'external')),
  dependency INTEGER NOT NULL DEFAULT 0 CHECK (dependency IN (0, 1)),
  context TEXT DEFAULT '',
  external_ref TEXT DEFAULT '',
  external_system TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ref_source ON object_references(source_object_id, status);
CREATE INDEX IF NOT EXISTS idx_ref_target ON object_references(target_object_id, status);
CREATE INDEX IF NOT EXISTS idx_ref_type ON object_references(reference_type);
CREATE INDEX IF NOT EXISTS idx_ref_tenant ON object_references(tenant_id);

-- ============================================================
-- Lifecycle Management
-- Statuses, lifecycle templates and versions, state machines,
-- release/approval rules and per-object lifecycle state, history
-- and approval decisions. Configuration is metadata-style scoped:
-- tenant_id NULL = global (platform-admin only), otherwise tenant.
-- ============================================================

CREATE TABLE IF NOT EXISTS lifecycle_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'draft'
    CHECK (category IN ('draft', 'in_review', 'approved', 'released', 'obsolete', 'cancelled')),
  module TEXT NOT NULL DEFAULT 'platform',
  owner TEXT DEFAULT '',
  legacy_status TEXT NOT NULL DEFAULT 'active'
    CHECK (legacy_status IN ('draft', 'active', 'released', 'obsolete', 'archived')),
  display_order INTEGER NOT NULL DEFAULT 0,
  color TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_statuses_code
  ON lifecycle_statuses(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_lifecycle_statuses_tenant ON lifecycle_statuses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_statuses_category ON lifecycle_statuses(category);

CREATE TABLE IF NOT EXISTS status_type_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_id INTEGER NOT NULL REFERENCES lifecycle_statuses(id) ON DELETE CASCADE,
  type_id INTEGER NOT NULL REFERENCES metadata_types(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (status_id, type_id)
);

CREATE INDEX IF NOT EXISTS idx_status_type_availability_type ON status_type_availability(type_id);

CREATE TABLE IF NOT EXISTS lifecycle_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  module TEXT NOT NULL DEFAULT 'platform',
  current_version INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'inactive', 'archived')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_definitions_code
  ON lifecycle_definitions(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_lifecycle_definitions_tenant ON lifecycle_definitions(tenant_id);

CREATE TABLE IF NOT EXISTS lifecycle_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES lifecycle_definitions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  notes TEXT DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  published_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_versions_definition ON lifecycle_versions(definition_id, status);

CREATE TABLE IF NOT EXISTS lifecycle_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lifecycle_version_id INTEGER NOT NULL REFERENCES lifecycle_versions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status_id INTEGER REFERENCES lifecycle_statuses(id),
  category TEXT NOT NULL DEFAULT 'draft'
    CHECK (category IN ('draft', 'in_review', 'approved', 'released', 'obsolete', 'cancelled')),
  is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  editable INTEGER NOT NULL DEFAULT 1 CHECK (editable IN (0, 1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  entry_conditions_json TEXT NOT NULL DEFAULT '{}',
  exit_conditions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lifecycle_version_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_states_version ON lifecycle_states(lifecycle_version_id);

CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lifecycle_version_id INTEGER NOT NULL REFERENCES lifecycle_versions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  from_state_id INTEGER NOT NULL REFERENCES lifecycle_states(id),
  to_state_id INTEGER NOT NULL REFERENCES lifecycle_states(id),
  required_permission TEXT DEFAULT '',
  required_role TEXT DEFAULT '',
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  approval_rule_id INTEGER,
  auto_approve INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0, 1)),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  display_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lifecycle_version_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_version ON lifecycle_transitions(lifecycle_version_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_from ON lifecycle_transitions(from_state_id);

CREATE TABLE IF NOT EXISTS lifecycle_type_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES metadata_types(id) ON DELETE CASCADE,
  lifecycle_definition_id INTEGER NOT NULL REFERENCES lifecycle_definitions(id) ON DELETE CASCADE,
  lifecycle_version_id INTEGER REFERENCES lifecycle_versions(id),
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_type_assignments_type
  ON lifecycle_type_assignments(type_id, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_lifecycle_type_assignments_def ON lifecycle_type_assignments(lifecycle_definition_id);

CREATE TABLE IF NOT EXISTS approval_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'approval' CHECK (kind IN ('release', 'approval')),
  module TEXT NOT NULL DEFAULT 'platform',
  lifecycle_version_id INTEGER REFERENCES lifecycle_versions(id) ON DELETE CASCADE,
  transition_id INTEGER REFERENCES lifecycle_transitions(id) ON DELETE CASCADE,
  require_all INTEGER NOT NULL DEFAULT 0 CHECK (require_all IN (0, 1)),
  min_approvals INTEGER NOT NULL DEFAULT 1,
  sequential INTEGER NOT NULL DEFAULT 0 CHECK (sequential IN (0, 1)),
  allow_self_approval INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_approval IN (0, 1)),
  mandatory_comment_on_reject INTEGER NOT NULL DEFAULT 1 CHECK (mandatory_comment_on_reject IN (0, 1)),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  auto_transition INTEGER NOT NULL DEFAULT 1 CHECK (auto_transition IN (0, 1)),
  rollback_state_id INTEGER REFERENCES lifecycle_states(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_rules_code
  ON approval_rules(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_approval_rules_tenant ON approval_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_approval_rules_version ON approval_rules(lifecycle_version_id);
CREATE INDEX IF NOT EXISTS idx_approval_rules_transition ON approval_rules(transition_id);

CREATE TABLE IF NOT EXISTS approval_rule_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES approval_rules(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  parallel INTEGER NOT NULL DEFAULT 0 CHECK (parallel IN (0, 1)),
  approver_type TEXT NOT NULL DEFAULT 'role' CHECK (approver_type IN ('role', 'user', 'organization')),
  approver_id INTEGER,
  approval_mode TEXT NOT NULL DEFAULT 'all' CHECK (approval_mode IN ('any', 'all', 'min')),
  min_approvals INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule_id, code)
);

CREATE INDEX IF NOT EXISTS idx_approval_rule_steps_rule ON approval_rule_steps(rule_id);

CREATE TABLE IF NOT EXISTS object_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  lifecycle_version_id INTEGER REFERENCES lifecycle_versions(id),
  transition_id INTEGER REFERENCES lifecycle_transitions(id),
  rule_id INTEGER REFERENCES approval_rules(id),
  from_state_id INTEGER REFERENCES lifecycle_states(id),
  to_state_id INTEGER REFERENCES lifecycle_states(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled')),
  requested_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  comments TEXT DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_object_releases_object ON object_releases(object_id, status);
CREATE INDEX IF NOT EXISTS idx_object_releases_tenant ON object_releases(tenant_id);

CREATE TABLE IF NOT EXISTS object_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES object_releases(id) ON DELETE CASCADE,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES approval_rule_steps(id),
  step_code TEXT DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  parallel INTEGER NOT NULL DEFAULT 0 CHECK (parallel IN (0, 1)),
  approver_type TEXT DEFAULT '',
  approver_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled', 'skipped')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  comment TEXT DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_object_approvals_release ON object_approvals(release_id);
CREATE INDEX IF NOT EXISTS idx_object_approvals_object ON object_approvals(object_id, status);
CREATE INDEX IF NOT EXISTS idx_object_approvals_approver ON object_approvals(approver_id);

CREATE TABLE IF NOT EXISTS object_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  lifecycle_version_id INTEGER,
  transition_id INTEGER,
  from_state_id INTEGER,
  to_state_id INTEGER,
  from_status_id INTEGER,
  to_status_id INTEGER,
  from_status TEXT,
  to_status TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'approval', 'system')),
  reason TEXT DEFAULT '',
  actor_id INTEGER REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_object_status_history_object ON object_status_history(object_id, id);

-- 011_workflow ---------------------------------------------------------------
-- Configuration-driven Workflow & Process Engine. Templates are versioned and
-- published versions are immutable; runtime instances pin the version they were
-- started with so authoring never mutates history.

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  module TEXT NOT NULL DEFAULT 'platform',
  current_version INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'inactive', 'archived')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_definitions_code
  ON workflow_definitions(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_tenant ON workflow_definitions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_module ON workflow_definitions(module);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  notes TEXT DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  published_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_definition ON workflow_versions(definition_id, status);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'start', 'end', 'task', 'approval', 'decision', 'parallel', 'join',
    'notification', 'timer', 'subprocess', 'service', 'terminate'
  )),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version_id, node_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_version ON workflow_nodes(version_id);

CREATE TABLE IF NOT EXISTS workflow_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  transition_key TEXT NOT NULL,
  from_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  to_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  condition_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version_id, transition_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_transitions_version ON workflow_transitions(version_id);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_from ON workflow_transitions(from_node_id);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_to ON workflow_transitions(to_node_id);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  definition_id INTEGER NOT NULL REFERENCES workflow_definitions(id),
  version_id INTEGER NOT NULL REFERENCES workflow_versions(id),
  object_id INTEGER REFERENCES objects(id),
  parent_instance_id INTEGER REFERENCES workflow_instances(id),
  parent_node_id INTEGER REFERENCES workflow_nodes(id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  context_json TEXT NOT NULL DEFAULT '{}',
  current_node_id INTEGER REFERENCES workflow_nodes(id),
  started_by INTEGER REFERENCES users(id),
  organization_id INTEGER REFERENCES organizations(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_definition ON workflow_instances(definition_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_tenant ON workflow_instances(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_object ON workflow_instances(object_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_parent ON workflow_instances(parent_instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_instances_code ON workflow_instances(code);

CREATE TABLE IF NOT EXISTS workflow_instance_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
  node_key TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'blocked', 'completed', 'skipped', 'failed', 'cancelled')),
  outcome TEXT DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  entered_at TEXT,
  completed_at TEXT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_instance_nodes_instance ON workflow_instance_nodes(instance_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_instance_nodes_node ON workflow_instance_nodes(node_id);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  instance_node_id INTEGER REFERENCES workflow_instance_nodes(id) ON DELETE CASCADE,
  definition_id INTEGER REFERENCES workflow_definitions(id),
  node_id INTEGER REFERENCES workflow_nodes(id),
  parent_task_id INTEGER REFERENCES workflow_tasks(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'blocked', 'awaiting_approval', 'completed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_type TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (assignee_type IN ('unassigned', 'user', 'role', 'organization', 'group', 'queue')),
  assignee_id INTEGER,
  assignee_ref TEXT DEFAULT '',
  claimed_by INTEGER REFERENCES users(id),
  due_at TEXT,
  escalation_at TEXT,
  escalated INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),
  outcome TEXT DEFAULT '',
  form_json TEXT NOT NULL DEFAULT '{}',
  data_json TEXT NOT NULL DEFAULT '{}',
  object_id INTEGER REFERENCES objects(id),
  organization_id INTEGER REFERENCES organizations(id),
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_instance ON workflow_tasks(instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_assignee ON workflow_tasks(assignee_type, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status ON workflow_tasks(status);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_tenant ON workflow_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_escalation ON workflow_tasks(escalation_at, escalated);

CREATE TABLE IF NOT EXISTS workflow_task_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
  display_order INTEGER NOT NULL DEFAULT 0,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_task_subtasks_task ON workflow_task_subtasks(task_id);

CREATE TABLE IF NOT EXISTS workflow_task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_task_comments_task ON workflow_task_comments(task_id);

CREATE TABLE IF NOT EXISTS workflow_task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  content_type TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_task_attachments_task ON workflow_task_attachments(task_id);

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES workflow_tasks(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES workflow_nodes(id),
  node_key TEXT NOT NULL,
  approval_rule_id INTEGER REFERENCES approval_rules(id),
  step_id INTEGER REFERENCES approval_rule_steps(id),
  step_code TEXT DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  parallel INTEGER NOT NULL DEFAULT 0 CHECK (parallel IN (0, 1)),
  approver_type TEXT DEFAULT '',
  approver_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled', 'skipped')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  comment TEXT DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_instance ON workflow_approvals(instance_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_approver ON workflow_approvals(approver_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_approvals_tenant ON workflow_approvals(tenant_id);

CREATE TABLE IF NOT EXISTS workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES workflow_tasks(id) ON DELETE SET NULL,
  node_key TEXT DEFAULT '',
  event_type TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  message TEXT DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_instance ON workflow_events(instance_id, id);

CREATE TABLE IF NOT EXISTS workflow_routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  definition_id INTEGER REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  node_type TEXT DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '{}',
  strategy TEXT NOT NULL DEFAULT 'first_match'
    CHECK (strategy IN ('first_match', 'round_robin', 'least_loaded')),
  assignee_type TEXT NOT NULL DEFAULT 'role'
    CHECK (assignee_type IN ('user', 'role', 'organization', 'group', 'queue')),
  assignee_id INTEGER,
  assignee_ref TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_routing_rules_code
  ON workflow_routing_rules(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_workflow_routing_rules_definition ON workflow_routing_rules(definition_id, priority);

CREATE TABLE IF NOT EXISTS workflow_escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  definition_id INTEGER REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  node_key TEXT DEFAULT '',
  after_minutes INTEGER NOT NULL DEFAULT 60,
  action TEXT NOT NULL DEFAULT 'notify'
    CHECK (action IN ('notify', 'reassign', 'raise_priority', 'escalate')),
  target_assignee_type TEXT DEFAULT '',
  target_assignee_id INTEGER,
  target_assignee_ref TEXT DEFAULT '',
  notify_user_id INTEGER REFERENCES users(id),
  priority TEXT DEFAULT 'high' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_escalation_rules_code
  ON workflow_escalation_rules(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_workflow_escalation_rules_definition ON workflow_escalation_rules(definition_id);

CREATE TABLE IF NOT EXISTS workflow_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT,
  ends_at TEXT,
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_delegations_to ON workflow_delegations(to_user_id, status);

CREATE TABLE IF NOT EXISTS workflow_notification_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'webhook')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_notification_templates_code
  ON workflow_notification_templates(code, COALESCE(tenant_id, 0));

CREATE TABLE IF NOT EXISTS workflow_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER REFERENCES workflow_instances(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES workflow_tasks(id) ON DELETE SET NULL,
  template_code TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'webhook')),
  recipient_type TEXT NOT NULL DEFAULT 'user' CHECK (recipient_type IN ('user', 'role', 'organization', 'group', 'queue')),
  recipient_id INTEGER,
  recipient_ref TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'read')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  read_at TEXT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_notifications_recipient ON workflow_notifications(recipient_type, recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_notifications_instance ON workflow_notifications(instance_id);

CREATE TABLE IF NOT EXISTS workflow_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  event TEXT NOT NULL,
  definition_id INTEGER NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES workflow_versions(id),
  condition_json TEXT NOT NULL DEFAULT '{}',
  context_map_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_bindings_code
  ON workflow_bindings(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_workflow_bindings_event ON workflow_bindings(event, status);
