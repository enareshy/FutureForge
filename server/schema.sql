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

-- ── Audit & History Framework ──────────────────────────────────────────────
-- The audit_logs table is the append-only event store. Rich columns are added
-- by migration ensureColumn so that pre-existing databases are upgraded too.

CREATE TABLE IF NOT EXISTS audit_event_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  value_type TEXT NOT NULL DEFAULT 'string',
  masked INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_changes_event ON audit_event_changes(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_changes_attribute ON audit_event_changes(attribute);

CREATE TABLE IF NOT EXISTS audit_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  object_type TEXT NOT NULL DEFAULT '*',
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  record_success INTEGER NOT NULL DEFAULT 1,
  record_failure INTEGER NOT NULL DEFAULT 1,
  capture_reads INTEGER NOT NULL DEFAULT 0,
  capture_views INTEGER NOT NULL DEFAULT 0,
  capture_downloads INTEGER NOT NULL DEFAULT 1,
  actions_json TEXT NOT NULL DEFAULT '[]',
  categories_json TEXT NOT NULL DEFAULT '[]',
  track_attributes_json TEXT NOT NULL DEFAULT '[]',
  masked_attributes_json TEXT NOT NULL DEFAULT '[]',
  ignored_attributes_json TEXT NOT NULL DEFAULT '[]',
  retention_days INTEGER NOT NULL DEFAULT 2555,
  visibility TEXT NOT NULL DEFAULT 'admin' CHECK (visibility IN ('user', 'manager', 'admin')),
  export_allowed INTEGER NOT NULL DEFAULT 1,
  system_mandatory INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_policies_scope
  ON audit_policies(COALESCE(tenant_id, 0), object_type);

CREATE TABLE IF NOT EXISTS audit_retention_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  policy_id INTEGER,
  cutoff TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  purged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  dry_run INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_retention_tenant ON audit_retention_runs(tenant_id, started_at);

-- Archive store for retention/archival. Mirrors the audit event shape and is
-- written only by the retention service.
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  actor_id INTEGER,
  actor_username TEXT,
  user_display_name TEXT,
  actor_type TEXT DEFAULT 'user',
  actor_ref TEXT,
  action TEXT NOT NULL,
  event_type TEXT,
  category TEXT DEFAULT 'administration',
  source TEXT,
  security_classification TEXT DEFAULT 'internal',
  retention_category TEXT DEFAULT 'standard',
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  object_name TEXT,
  object_revision TEXT,
  session_id TEXT,
  related_resource_type TEXT,
  related_resource_id TEXT,
  details TEXT,
  changed_fields TEXT,
  before_values TEXT,
  after_values TEXT,
  related_json TEXT,
  status TEXT,
  failure_category TEXT,
  error_message TEXT,
  reason TEXT,
  correlation_id TEXT,
  request_id TEXT,
  parent_event_id INTEGER,
  ip TEXT,
  device TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_object ON audit_logs_archive(resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_archive_tenant ON audit_logs_archive(tenant_id, created_at);

-- Immutability guard. Normal application code can only INSERT and SELECT audit
-- events. Retention may remove rows only while the guard flag is set.
CREATE TABLE IF NOT EXISTS audit_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allow_delete INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO audit_guard (id, allow_delete) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs
WHEN (SELECT allow_delete FROM audit_guard WHERE id = 1) <> 1
BEGIN
  SELECT RAISE(ABORT, 'Audit records are immutable');
END;

-- Action type registry. Maps stable action codes to the category and coarse
-- event type used for classification, filtering and mandatory-capture rules.
-- Business modules may register additional action types at runtime.
CREATE TABLE IF NOT EXISTS audit_action_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'administration',
  event_type TEXT NOT NULL DEFAULT 'ADMIN_ACTION',
  description TEXT DEFAULT '',
  mandatory INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action_types_category ON audit_action_types(category, active);

-- Dedicated retention policies. A policy targets a category and/or object type
-- for a tenant, optionally under legal hold. Distinct from audit_policies
-- (capture policies) so compliance teams can manage lifecycle independently.
CREATE TABLE IF NOT EXISTS audit_retention_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT '*',
  object_type TEXT NOT NULL DEFAULT '*',
  retention_days INTEGER NOT NULL DEFAULT 2555,
  action TEXT NOT NULL DEFAULT 'archive' CHECK (action IN ('archive', 'purge')),
  legal_hold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  priority INTEGER NOT NULL DEFAULT 100,
  system INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_retention_policies_scope
  ON audit_retention_policies(COALESCE(tenant_id, 0), category, object_type);
CREATE INDEX IF NOT EXISTS idx_audit_retention_policies_status
  ON audit_retention_policies(tenant_id, status, priority);

-- Asynchronous export requests. The export is materialised by a background job
-- and retained for a bounded window, so large result sets never block a request.
CREATE TABLE IF NOT EXISTS audit_export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  tenant_id INTEGER,
  requested_by INTEGER,
  name TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'csv',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  scope_json TEXT NOT NULL DEFAULT '{}',
  columns_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  content_type TEXT,
  error TEXT,
  job_id INTEGER,
  expires_at TEXT,
  downloaded_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_export_requests_tenant
  ON audit_export_requests(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_export_requests_status
  ON audit_export_requests(status, expires_at);

-- Reusable saved filter definitions for the audit console and APIs.
CREATE TABLE IF NOT EXISTS audit_saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  owner_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'events',
  filters_json TEXT NOT NULL DEFAULT '{}',
  shared INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_saved_filters_owner
  ON audit_saved_filters(tenant_id, owner_id, scope);

-- ── Notification & Communication Framework ─────────────────────────────────
-- Central, reusable notification platform capability. Business modules publish
-- domain events (notification_events) and the framework resolves rules,
-- recipients, templates and preferences before handing delivery requests to the
-- channel providers. Nothing here contains workflow/lifecycle-specific logic.

-- Inbound domain events published by business modules.
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  source_module TEXT NOT NULL DEFAULT 'platform',
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  object_type TEXT DEFAULT '',
  object_id TEXT DEFAULT '',
  object_name TEXT DEFAULT '',
  initiator_id INTEGER REFERENCES users(id),
  initiator_username TEXT DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  related_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT DEFAULT '',
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'processed'
    CHECK (status IN ('received', 'processed', 'skipped', 'failed')),
  rule_count INTEGER NOT NULL DEFAULT 0,
  notification_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_events_type ON notification_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_tenant ON notification_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_correlation ON notification_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_object ON notification_events(object_type, object_id);

-- Templates. Global templates have tenant_id NULL; tenants may override by
-- creating a row with the same code/channel/locale in their own scope.
CREATE TABLE IF NOT EXISTS notification_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  event_type TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'in_app'
    CHECK (channel IN ('in_app', 'email', 'sms', 'teams', 'slack', 'push', 'webhook')),
  subject TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  variables_json TEXT NOT NULL DEFAULT '[]',
  locale TEXT NOT NULL DEFAULT 'en',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_templates_scope
  ON notification_templates(code, channel, locale, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_notification_templates_event ON notification_templates(event_type, status);

-- Immutable version snapshots of a template, written on every update.
CREATE TABLE IF NOT EXISTS notification_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES notification_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  variables_json TEXT NOT NULL DEFAULT '[]',
  changed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_template_versions ON notification_template_versions(template_id, version);

-- Configurable rules that map an event to recipients, template and channels.
CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  source_module TEXT DEFAULT '',
  condition_json TEXT NOT NULL DEFAULT '{}',
  recipient_json TEXT NOT NULL DEFAULT '{}',
  template_id INTEGER REFERENCES notification_templates(id) ON DELETE SET NULL,
  template_code TEXT DEFAULT '',
  channels_json TEXT NOT NULL DEFAULT '["in_app"]',
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  delivery_mode TEXT NOT NULL DEFAULT 'immediate'
    CHECK (delivery_mode IN ('immediate', 'delayed', 'digest')),
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  reminder_json TEXT NOT NULL DEFAULT '{}',
  escalation_json TEXT NOT NULL DEFAULT '{}',
  mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_rules_scope
  ON notification_rules(code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS idx_notification_rules_event ON notification_rules(event_type, status);

-- Per-user channel / event preferences.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER REFERENCES organizations(id),
  in_app INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0, 1)),
  email INTEGER NOT NULL DEFAULT 1 CHECK (email IN (0, 1)),
  frequency TEXT NOT NULL DEFAULT 'immediate'
    CHECK (frequency IN ('immediate', 'daily', 'weekly', 'off')),
  language TEXT NOT NULL DEFAULT 'en',
  quiet_hours_json TEXT NOT NULL DEFAULT '{}',
  reminders INTEGER NOT NULL DEFAULT 1 CHECK (reminders IN (0, 1)),
  escalations INTEGER NOT NULL DEFAULT 1 CHECK (escalations IN (0, 1)),
  self_notify INTEGER NOT NULL DEFAULT 1 CHECK (self_notify IN (0, 1)),
  event_preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_user
  ON notification_preferences(user_id, COALESCE(tenant_id, 0));

-- One row per recipient/channel delivery. Doubles as the notification history
-- and the in-app inbox.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES notification_events(id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES notification_rules(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_address TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'in_app',
  template_id INTEGER REFERENCES notification_templates(id) ON DELETE SET NULL,
  template_code TEXT DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  content_ref TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'retrying')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  read_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT '',
  provider_response TEXT DEFAULT '',
  correlation_id TEXT DEFAULT '',
  object_type TEXT DEFAULT '',
  object_id TEXT DEFAULT '',
  object_name TEXT DEFAULT '',
  deep_link TEXT DEFAULT '',
  action_links_json TEXT NOT NULL DEFAULT '[]',
  archived_at TEXT,
  deleted_at TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency
  ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_status ON notifications(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_event ON notifications(event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_channel_status ON notifications(channel, status);

-- Delivery queue / outbox with retry bookkeeping.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'in_app',
  provider_code TEXT NOT NULL DEFAULT 'store',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'failed', 'retrying', 'dead_letter', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  dead_letter INTEGER NOT NULL DEFAULT 0 CHECK (dead_letter IN (0, 1)),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_queue
  ON notification_deliveries(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
  ON notification_deliveries(notification_id);

-- Reminder and escalation schedule (pull-based, like workflow escalations).
CREATE TABLE IF NOT EXISTS notification_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER REFERENCES notification_rules(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES notification_events(id) ON DELETE SET NULL,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  fired_at TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'cancelled', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_reminders_dedupe
  ON notification_reminders(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_reminders_due ON notification_reminders(status, due_at);

-- Channel provider configuration. Credentials live encrypted in secrets_enc and
-- are never serialized back to clients.
CREATE TABLE IF NOT EXISTS notification_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('in_app', 'email', 'sms', 'teams', 'slack', 'push', 'webhook')),
  type TEXT NOT NULL DEFAULT 'store'
    CHECK (type IN ('store', 'smtp', 'sendgrid', 'graph', 'webhook', 'ses', 'mailgun', 'postmark', 'teams', 'slack', 'twilio', 'fcm', 'custom')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- Communication & Delivery Services Module (migration 014_delivery)
--
-- This module is the centralized outbound delivery infrastructure. It receives
-- rendered delivery requests from the Notification Management module (or any
-- other producer) and owns the provider abstraction, queue, background worker,
-- retry/dead-letter handling, delivery tracking, provider configuration,
-- reminder/escalation execution and operational alerts.
--
-- It deliberately contains NO notification rules, templates, recipient
-- resolution heuristics or user preference logic: those stay in the
-- Notification Management module, which hands off the finished message.
-- ===========================================================================

-- Canonical outbound delivery request and its delivery-tracking lifecycle.
CREATE TABLE IF NOT EXISTS delivery_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES notification_events(id) ON DELETE SET NULL,
  source_module TEXT NOT NULL DEFAULT 'platform',
  recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_address TEXT NOT NULL DEFAULT '',
  recipient_json TEXT NOT NULL DEFAULT '{}',
  channel TEXT NOT NULL DEFAULT 'in_app'
    CHECK (channel IN ('in_app', 'email', 'sms', 'teams', 'slack', 'push', 'webhook')),
  provider_id INTEGER REFERENCES notification_providers(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  content_ref TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'queued', 'processing', 'sent', 'delivered', 'failed', 'retrying', 'cancelled', 'dead_lettered')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  queued_at TEXT,
  processing_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  last_retry_at TEXT,
  processed_at TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  object_name TEXT NOT NULL DEFAULT '',
  deep_link TEXT NOT NULL DEFAULT '',
  related_json TEXT NOT NULL DEFAULT '{}',
  dead_letter INTEGER NOT NULL DEFAULT 0 CHECK (dead_letter IN (0, 1)),
  cancelled_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_requests_idempotency
  ON delivery_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_requests_queue
  ON delivery_requests(status, scheduled_at, priority);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_tenant
  ON delivery_requests(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_notification
  ON delivery_requests(notification_id);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_event
  ON delivery_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_correlation
  ON delivery_requests(correlation_id);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_channel_status
  ON delivery_requests(channel, status);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_provider_status
  ON delivery_requests(provider_code, status);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_recipient
  ON delivery_requests(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_ref
  ON delivery_requests(request_ref);

-- One row per delivery attempt, for provider error capture and latency stats.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  provider_id INTEGER REFERENCES notification_providers(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_request ON delivery_attempts(request_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_provider ON delivery_attempts(provider_code, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_created ON delivery_attempts(created_at);

-- Provider failure log (feeds "view provider failures" and operational alerts).
CREATE TABLE IF NOT EXISTS delivery_provider_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER REFERENCES notification_providers(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL DEFAULT '',
  request_id INTEGER REFERENCES delivery_requests(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  channel TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_provider_failures_provider
  ON delivery_provider_failures(provider_code, created_at);

-- Sliding-window rate-limit buckets for bulk and test-send operations.
CREATE TABLE IF NOT EXISTS delivery_rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  provider_id INTEGER,
  action TEXT NOT NULL DEFAULT 'send',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_rate_events_bucket
  ON delivery_rate_events(bucket, created_at);

-- Reminder schedule. The sender supplies the recipient and schedule; the
-- delivery service only executes due/overdue/repeat reminders.
CREATE TABLE IF NOT EXISTS delivery_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  source_module TEXT NOT NULL DEFAULT 'platform',
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  object_name TEXT NOT NULL DEFAULT '',
  deep_link TEXT NOT NULL DEFAULT '',
  recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_json TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL DEFAULT 'due'
    CHECK (kind IN ('due', 'overdue', 'repeat')),
  due_at TEXT NOT NULL,
  next_run_at TEXT,
  repeat_minutes INTEGER NOT NULL DEFAULT 0,
  max_repeats INTEGER NOT NULL DEFAULT 0,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'cancelled', 'completed', 'skipped')),
  stop_on_complete INTEGER NOT NULL DEFAULT 1 CHECK (stop_on_complete IN (0, 1)),
  completed_at TEXT,
  last_run_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  escalation_json TEXT NOT NULL DEFAULT '{}',
  details_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_reminders_dedupe
  ON delivery_reminders(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_reminders_due ON delivery_reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_delivery_reminders_tenant ON delivery_reminders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_reminders_object ON delivery_reminders(object_type, object_id);

-- Escalation schedule: level-based escalation to a supplied recipient set.
CREATE TABLE IF NOT EXISTS delivery_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER REFERENCES delivery_reminders(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  source_module TEXT NOT NULL DEFAULT 'platform',
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  object_name TEXT NOT NULL DEFAULT '',
  deep_link TEXT NOT NULL DEFAULT '',
  recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_json TEXT NOT NULL DEFAULT '{}',
  level INTEGER NOT NULL DEFAULT 1,
  max_level INTEGER NOT NULL DEFAULT 3,
  after_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'cancelled', 'completed')),
  due_at TEXT,
  fired_at TEXT,
  last_run_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  dedupe_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_escalations_dedupe
  ON delivery_escalations(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_escalations_due ON delivery_escalations(status, due_at);
CREATE INDEX IF NOT EXISTS idx_delivery_escalations_object ON delivery_escalations(object_type, object_id);

-- Reminder/escalation execution history.
CREATE TABLE IF NOT EXISTS delivery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'escalation')),
  reminder_id INTEGER REFERENCES delivery_reminders(id) ON DELETE SET NULL,
  escalation_id INTEGER REFERENCES delivery_escalations(id) ON DELETE SET NULL,
  level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'fired',
  request_id INTEGER REFERENCES delivery_requests(id) ON DELETE SET NULL,
  detail TEXT NOT NULL DEFAULT '',
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_runs_reminder ON delivery_runs(reminder_id, ran_at);
CREATE INDEX IF NOT EXISTS idx_delivery_runs_escalation ON delivery_runs(escalation_id, ran_at);
CREATE INDEX IF NOT EXISTS idx_delivery_runs_kind ON delivery_runs(kind, ran_at);

-- Operational alerts raised on dead-lettering / provider failures.
CREATE TABLE IF NOT EXISTS delivery_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'delivery_failed',
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  tenant_id INTEGER REFERENCES organizations(id),
  provider_id INTEGER,
  provider_code TEXT NOT NULL DEFAULT '',
  request_id INTEGER REFERENCES delivery_requests(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged')),
  acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_alerts_status ON delivery_alerts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_alerts_tenant ON delivery_alerts(tenant_id, created_at);

-- ===========================================================================
-- Background Job Management Module (migration 015_jobs)
--
-- Centralized registry, submission, monitoring, control, history and result
-- tracking for asynchronous jobs. Business modules (Bulk Import, CAD
-- Processing, BOM Validation, Report Generation, Data Sync, Search Indexing,
-- Workflow, Integrations, ...) submit jobs here instead of building their own
-- job management.
--
-- The actual execution infrastructure is provided by the separate Job
-- Scheduling & Execution Engine. This module stores NO queues, workers,
-- scheduling algorithms or retry execution: it records state the engine
-- reports and exposes management operations (submit/cancel/pause/resume/retry).
-- ===========================================================================

-- Job type registry. Business modules own the handlers; this module only stores
-- their metadata and handler reference.
CREATE TABLE IF NOT EXISTS job_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_module TEXT NOT NULL DEFAULT 'platform',
  handler TEXT NOT NULL DEFAULT '',
  queues_json TEXT NOT NULL DEFAULT '["default"]',
  required_permissions_json TEXT NOT NULL DEFAULT '[]',
  timeout_seconds INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  default_priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_types_active ON job_types(active, source_module);

-- Canonical job record and its lifecycle.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT NOT NULL UNIQUE,
  job_type_code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  source_module TEXT NOT NULL DEFAULT 'platform',
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_as TEXT NOT NULL DEFAULT 'user'
    CHECK (submitted_as IN ('user', 'system', 'schedule', 'event', 'workflow', 'integration')),
  queue TEXT NOT NULL DEFAULT 'default',
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'queued', 'waiting_for_dependency', 'scheduled', 'running', 'paused', 'completed', 'failed', 'retrying', 'cancel_requested', 'cancelled', 'timed_out', 'skipped')),
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  input_ref TEXT NOT NULL DEFAULT '',
  related_object_type TEXT NOT NULL DEFAULT '',
  related_object_id TEXT NOT NULL DEFAULT '',
  related_object_name TEXT NOT NULL DEFAULT '',
  parent_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  worker_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  error_json TEXT NOT NULL DEFAULT '{}',
  result_ref TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancel_requested_at TEXT,
  cancel_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TEXT,
  execution_group TEXT NOT NULL DEFAULT '',
  schedule_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  next_retry_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
  ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, queue, priority, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(job_type_code, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_submitter ON jobs(submitted_by, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_module, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_correlation ON jobs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_object ON jobs(related_object_type, related_object_id);
CREATE INDEX IF NOT EXISTS idx_jobs_ref ON jobs(job_ref);

-- Dependency edges: job_id depends on depends_on_job_id.
CREATE TABLE IF NOT EXISTS job_dependencies (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, depends_on_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_dependencies_depends ON job_dependencies(depends_on_job_id);

-- Immutable status-transition and administrative-action history.
CREATE TABLE IF NOT EXISTS job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT 'status',
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  progress INTEGER,
  stage TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'platform',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_history_job ON job_history(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_history_event ON job_history(event_type, created_at);

-- Result artifacts. Only secure references into the Document & File Management
-- storage abstraction are stored here; no bytes live in this table.
CREATE TABLE IF NOT EXISTS job_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'output',
  name TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  storage_ref TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  secure INTEGER NOT NULL DEFAULT 0 CHECK (secure IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_artifacts_job ON job_artifacts(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_kind ON job_artifacts(kind);

-- ===========================================================================
-- Job Scheduling & Execution Engine
--
-- The engine owns execution concerns only: logical queues, worker liveness,
-- scheduling/recurrence, leases, retries, timeouts, cancellation, distributed
-- locking, dead-letter and execution bookkeeping. Business handlers are
-- registered by the owning modules; no business logic lives in these tables.
-- ===========================================================================

-- Logical queues. Concurrency/rate-limit/retry/timeout policy is evaluated by
-- the engine when claiming and finalising work.
CREATE TABLE IF NOT EXISTS job_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  priority INTEGER NOT NULL DEFAULT 50,
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  worker_allocation INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
  retry_max_attempts INTEGER NOT NULL DEFAULT 3,
  retry_strategy TEXT NOT NULL DEFAULT 'exponential'
    CHECK (retry_strategy IN ('none', 'fixed', 'exponential')),
  retry_delay_seconds INTEGER NOT NULL DEFAULT 30,
  retry_max_delay_seconds INTEGER NOT NULL DEFAULT 3600,
  timeout_seconds INTEGER NOT NULL DEFAULT 600,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  last_claimed_at TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_queues_enabled ON job_queues(enabled, priority);
CREATE INDEX IF NOT EXISTS idx_job_queues_tenant ON job_queues(tenant_id, priority);

-- Worker registry and liveness. Rows are upserted by workers at start-up and
-- refreshed by heartbeats; stale rows are reconciled to offline by the engine.
CREATE TABLE IF NOT EXISTS job_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'idle', 'busy', 'draining', 'stopped', 'offline')),
  concurrency INTEGER NOT NULL DEFAULT 1,
  queues_json TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  active_jobs INTEGER NOT NULL DEFAULT 0,
  processed_total INTEGER NOT NULL DEFAULT 0,
  failed_total INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  last_heartbeat TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_workers_heartbeat ON job_workers(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_job_workers_status ON job_workers(status);

-- Recurring schedule definitions.
CREATE TABLE IF NOT EXISTS job_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  job_type_code TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'DEFAULT',
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  schedule_type TEXT NOT NULL DEFAULT 'once'
    CHECK (schedule_type IN ('once', 'interval', 'daily', 'weekly', 'monthly', 'cron')),
  cron_expression TEXT NOT NULL DEFAULT '',
  interval_seconds INTEGER NOT NULL DEFAULT 0,
  daily_time TEXT NOT NULL DEFAULT '00:00',
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  day_of_month INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  start_at TEXT,
  end_at TEXT,
  max_executions INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL DEFAULT 0,
  retry_strategy TEXT NOT NULL DEFAULT 'exponential',
  retry_delay_seconds INTEGER NOT NULL DEFAULT 30,
  failure_policy TEXT NOT NULL DEFAULT 'continue'
    CHECK (failure_policy IN ('continue', 'pause', 'disable')),
  concurrency_policy TEXT NOT NULL DEFAULT 'allow'
    CHECK (concurrency_policy IN ('allow', 'skip', 'queue', 'cancel_previous')),
  catchup_policy TEXT NOT NULL DEFAULT 'skip'
    CHECK (catchup_policy IN ('skip', 'run_once', 'run_all')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'disabled', 'completed', 'expired')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  submitted_as TEXT NOT NULL DEFAULT 'schedule',
  execution_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  last_error TEXT NOT NULL DEFAULT '',
  next_run_at TEXT,
  locked_by TEXT NOT NULL DEFAULT '',
  locked_at TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_schedules_due ON job_schedules(enabled, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_job_schedules_type ON job_schedules(job_type_code);
CREATE INDEX IF NOT EXISTS idx_job_schedules_tenant ON job_schedules(tenant_id, created_at);

-- One row per materialised schedule occurrence. The unique key makes duplicate
-- execution prevention durable across restarts and concurrent schedulers.
CREATE TABLE IF NOT EXISTS job_schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES job_schedules(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'enqueued', 'running', 'completed', 'failed', 'skipped', 'cancelled', 'timed_out')),
  attempt INTEGER NOT NULL DEFAULT 1,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_job_schedule_runs_schedule ON job_schedule_runs(schedule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_job_schedule_runs_job ON job_schedule_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_schedule_runs_status ON job_schedule_runs(status, scheduled_for);

-- Dead-letter registry for jobs that exhausted their retry policy.
CREATE TABLE IF NOT EXISTS job_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue TEXT NOT NULL DEFAULT '',
  job_type_code TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  reason TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'unknown',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'requeued', 'discarded')),
  requeued_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_dead_letters_status ON job_dead_letters(status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_dead_letters_queue ON job_dead_letters(queue, created_at);
CREATE INDEX IF NOT EXISTS idx_job_dead_letters_tenant ON job_dead_letters(tenant_id, created_at);

-- Distributed locks used for scheduler leadership and dedupe.
CREATE TABLE IF NOT EXISTS job_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_locks_expires ON job_locks(expires_at);

-- One row per handler invocation (observability + retry-from-failed-step).
CREATE TABLE IF NOT EXISTS job_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT NOT NULL DEFAULT '',
  queue TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  last_step TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  error_category TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_executions_job ON job_executions(job_id, attempt);
CREATE INDEX IF NOT EXISTS idx_job_executions_status ON job_executions(status, created_at);

-- Administrative configuration audit trail (queue and schedule changes).
CREATE TABLE IF NOT EXISTS job_engine_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  entity_code TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_engine_audit_entity ON job_engine_audit(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_engine_audit_tenant ON job_engine_audit(tenant_id, created_at);

-- ── Document & File Management module ────────────────────────────────────────
-- Business-facing file metadata, versions, check-in/out, folders, collections,
-- associations and access control. Physical bytes, virus scanning, preview and
-- rendition generation are owned by the separate File Storage & Processing
-- Services module; this module only stores opaque storage references.

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES folders(id),
  path TEXT NOT NULL DEFAULT '/',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  security_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_code
  ON folders(tenant_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_sibling_name
  ON folders(tenant_id, COALESCE(parent_id, 0), name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_tenant ON folders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(tenant_id, path);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_ref TEXT NOT NULL UNIQUE,
  uuid TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  folder_id INTEGER REFERENCES folders(id),
  name TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_category TEXT NOT NULL DEFAULT 'document'
    CHECK (file_category IN ('document', 'drawing', 'image', 'pdf', 'spreadsheet', 'presentation',
      'archive', 'video', 'audio', 'cad', 'text', 'other')),
  description TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  current_version_id INTEGER,
  version_count INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('uploading', 'upload_failed', 'pending_scan', 'scan_in_progress', 'available',
      'quarantined', 'scan_failed', 'checked_out', 'locked', 'processing', 'deleted', 'archived')),
  security_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  virus_scan_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (virus_scan_status IN ('pending', 'in_progress', 'clean', 'infected', 'failed', 'skipped')),
  preview_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (preview_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  rendition_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (rendition_status IN ('pending', 'processing', 'ready', 'failed')),
  custom_metadata_json TEXT NOT NULL DEFAULT '{}',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_tenant ON files(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
CREATE INDEX IF NOT EXISTS idx_files_checksum ON files(checksum);
CREATE INDEX IF NOT EXISTS idx_files_type ON files(mime_type, extension);
CREATE INDEX IF NOT EXISTS idx_files_category ON files(file_category);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_org ON files(organization_id, deleted_at);

-- Immutable version chain. Historical versions are never overwritten; restoring
-- an old version creates a brand-new version row with a new version number.
CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  version_label TEXT NOT NULL DEFAULT '',
  major INTEGER NOT NULL DEFAULT 1,
  minor INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  previous_version_id INTEGER REFERENCES file_versions(id),
  name TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('uploading', 'processing', 'available', 'quarantined', 'failed', 'deleted')),
  virus_scan_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (virus_scan_status IN ('pending', 'in_progress', 'clean', 'infected', 'failed', 'skipped')),
  checkin_comment TEXT NOT NULL DEFAULT '',
  restored_from_version_id INTEGER REFERENCES file_versions(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, version_number);
CREATE INDEX IF NOT EXISTS idx_file_versions_current ON file_versions(file_id, is_current);
CREATE INDEX IF NOT EXISTS idx_file_versions_checksum ON file_versions(checksum);

-- Exclusive/shared checkout locks. The partial unique index is the durable
-- guarantee that two users can never hold an active lock on the same file.
CREATE TABLE IF NOT EXISTS file_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK (lock_type IN ('exclusive', 'shared')),
  lock_token TEXT NOT NULL UNIQUE,
  locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  last_activity_at TEXT,
  released_at TEXT,
  released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  force_released INTEGER NOT NULL DEFAULT 0 CHECK (force_released IN (0, 1)),
  release_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_locks_active
  ON file_locks(file_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_locks_file ON file_locks(file_id, released_at);
CREATE INDEX IF NOT EXISTS idx_file_locks_owner ON file_locks(locked_by, released_at);
CREATE INDEX IF NOT EXISTS idx_file_locks_expiry ON file_locks(expires_at, released_at);

-- Upload sessions (single, multipart/chunked and resumable). The upload id is
-- the client-facing handle; storage keys stay server-side and opaque.
CREATE TABLE IF NOT EXISTS file_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT NOT NULL UNIQUE,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  folder_id INTEGER REFERENCES folders(id),
  name TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_category TEXT NOT NULL DEFAULT 'document',
  description TEXT NOT NULL DEFAULT '',
  security_classification TEXT NOT NULL DEFAULT 'internal',
  custom_metadata_json TEXT NOT NULL DEFAULT '{}',
  declared_size INTEGER NOT NULL DEFAULT 0,
  declared_checksum TEXT NOT NULL DEFAULT '',
  upload_mode TEXT NOT NULL DEFAULT 'single' CHECK (upload_mode IN ('single', 'multipart', 'external')),
  chunk_size INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  received_chunks INTEGER NOT NULL DEFAULT 0,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  staging_key TEXT NOT NULL DEFAULT '',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'in_progress', 'completing', 'completed', 'aborted', 'expired', 'failed')),
  idempotency_key TEXT,
  duplicate_of_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  error_message TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_uploads_idempotency
  ON file_uploads(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_uploads_tenant ON file_uploads(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_file_uploads_status ON file_uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_file_uploads_file ON file_uploads(file_id);

-- Generic file ↔ business-object associations (Product Revision, Change Notice,
-- Manufacturing Operation, ...). Business objects live in the Object &
-- Relationship Framework; this table records the attachment semantics.
CREATE TABLE IF NOT EXISTS file_associations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  business_object_type TEXT NOT NULL DEFAULT '',
  business_object_id TEXT NOT NULL DEFAULT '',
  business_object_name TEXT NOT NULL DEFAULT '',
  relationship_type TEXT NOT NULL DEFAULT 'attachment',
  association_role TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_associations_unique
  ON file_associations(file_id, business_object_type, business_object_id, relationship_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_associations_file ON file_associations(file_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_file_associations_object
  ON file_associations(business_object_type, business_object_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_file_associations_tenant ON file_associations(tenant_id, created_at);

-- Logical groupings / saved file sets. Membership never duplicates bytes.
CREATE TABLE IF NOT EXISTS file_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_collections_code
  ON file_collections(tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_collections_tenant ON file_collections(tenant_id, deleted_at);

CREATE TABLE IF NOT EXISTS file_collection_members (
  collection_id INTEGER NOT NULL REFERENCES file_collections(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_file_collection_members_file ON file_collection_members(file_id);

-- Resource-level ACL for files, folders and collections. Explicit deny always
-- wins over allow; tenant/org/role/group/user/file principals are supported.
CREATE TABLE IF NOT EXISTS file_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder', 'collection')),
  resource_id INTEGER NOT NULL,
  principal_type TEXT NOT NULL
    CHECK (principal_type IN ('user', 'group', 'role', 'tenant', 'organization')),
  principal_id INTEGER,
  permission TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_permissions_unique
  ON file_permissions(resource_type, resource_id, principal_type, COALESCE(principal_id, 0), permission);
CREATE INDEX IF NOT EXISTS idx_file_permissions_resource ON file_permissions(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_file_permissions_principal
  ON file_permissions(principal_type, principal_id, tenant_id);

-- Storage/processing status (virus scan, preview, rendition, checksum). Rows are
-- written by the File Storage & Processing Services module via this module's
-- integration hooks so UI and API always reflect real processing state.
CREATE TABLE IF NOT EXISTS file_processing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES file_versions(id) ON DELETE CASCADE,
  processing_type TEXT NOT NULL
    CHECK (processing_type IN ('virus_scan', 'preview', 'rendition', 'checksum', 'metadata_extraction')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  provider TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version_id, processing_type)
);

CREATE INDEX IF NOT EXISTS idx_file_processing_file ON file_processing(file_id, processing_type);
CREATE INDEX IF NOT EXISTS idx_file_processing_status ON file_processing(status);

-- Module event outbox. File domain events are appended here and re-published
-- through the platform Event & Messaging / Notification framework.
CREATE TABLE IF NOT EXISTS file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  version_id INTEGER REFERENCES file_versions(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'published', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_events_idempotency
  ON file_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_events_type ON file_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_file_events_file ON file_events(file_id, created_at);
CREATE INDEX IF NOT EXISTS idx_file_events_tenant ON file_events(tenant_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- Search & Discovery Framework (migration 018_search)
--
-- A shared, tenant-aware search platform. Business modules register their
-- searchable object types and index documents here instead of building their
-- own search. The index is a denormalised read model; source modules remain
-- the system of record and are re-read only during (re)indexing.
-- ═══════════════════════════════════════════════════════════════════════════

-- Registry of searchable object types contributed by business modules.
CREATE TABLE IF NOT EXISTS search_object_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_module TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL DEFAULT '',
  key_column TEXT NOT NULL DEFAULT 'id',
  title_attribute TEXT NOT NULL DEFAULT 'name',
  subtitle_attribute TEXT NOT NULL DEFAULT '',
  summary_attribute TEXT NOT NULL DEFAULT 'description',
  body_attributes_json TEXT NOT NULL DEFAULT '[]',
  facet_attributes_json TEXT NOT NULL DEFAULT '[]',
  filter_attributes_json TEXT NOT NULL DEFAULT '[]',
  relationship_types_json TEXT NOT NULL DEFAULT '[]',
  index_name TEXT NOT NULL DEFAULT '',
  identifier_field TEXT NOT NULL DEFAULT 'id',
  searchable_fields_json TEXT NOT NULL DEFAULT '[]',
  sortable_fields_json TEXT NOT NULL DEFAULT '[]',
  facetable_fields_json TEXT NOT NULL DEFAULT '[]',
  display_fields_json TEXT NOT NULL DEFAULT '[]',
  relationship_fields_json TEXT NOT NULL DEFAULT '[]',
  security_policy TEXT NOT NULL DEFAULT 'tenant',
  indexing_strategy TEXT NOT NULL DEFAULT 'event',
  permission_resource TEXT NOT NULL DEFAULT '',
  permission_action TEXT NOT NULL DEFAULT 'read',
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  display_order INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'draft')),
  registered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_search_object_types_tenant ON search_object_types(tenant_id, status, display_order);

-- Explicit per-object-type field definitions. Fields are never indexed by
-- default: administrators/module owners opt each field in and declare how it
-- may be searched, filtered, sorted and faceted. Provider-agnostic metadata.
CREATE TABLE IF NOT EXISTS search_field_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  field TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string'
    CHECK (data_type IN ('string', 'text', 'number', 'boolean', 'date', 'datetime', 'enum', 'reference', 'array', 'object')),
  searchable INTEGER NOT NULL DEFAULT 1,
  filterable INTEGER NOT NULL DEFAULT 0,
  sortable INTEGER NOT NULL DEFAULT 0,
  facetable INTEGER NOT NULL DEFAULT 0,
  full_text INTEGER NOT NULL DEFAULT 0,
  exact_match INTEGER NOT NULL DEFAULT 1,
  wildcard INTEGER NOT NULL DEFAULT 1,
  boost REAL NOT NULL DEFAULT 1,
  analyzer TEXT NOT NULL DEFAULT 'standard',
  security_sensitive INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, field)
);

CREATE INDEX IF NOT EXISTS idx_search_field_defs_type ON search_field_definitions(tenant_id, object_type, display_order);

-- Per-tenant search provider selection. Business modules never choose a
-- provider; they call the Search API and the configured provider is resolved
-- transparently. Migrating SQLite -> OpenSearch is a configuration change.
CREATE TABLE IF NOT EXISTS search_provider_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'sqlite',
  enabled INTEGER NOT NULL DEFAULT 1,
  index_name TEXT NOT NULL DEFAULT 'enterprise',
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Denormalised search index documents. One row per indexed object per tenant.
CREATE TABLE IF NOT EXISTS search_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  site_id INTEGER REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_uuid TEXT,
  code TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  searchable_text TEXT NOT NULL DEFAULT '',
  external_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  lifecycle_state TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'internal',
  tags_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  relationships_json TEXT NOT NULL DEFAULT '[]',
  revisions TEXT NOT NULL DEFAULT '',
  source_revision TEXT,
  score_weight REAL NOT NULL DEFAULT 1,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_search_index_tenant ON search_index(tenant_id, object_type);
CREATE INDEX IF NOT EXISTS idx_search_index_type ON search_index(object_type, status);
CREATE INDEX IF NOT EXISTS idx_search_index_org ON search_index(tenant_id, organization_id);
CREATE INDEX IF NOT EXISTS idx_search_index_owner ON search_index(tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_search_index_status ON search_index(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_search_index_title ON search_index(tenant_id, title);
CREATE INDEX IF NOT EXISTS idx_search_index_indexed ON search_index(tenant_id, indexed_at);

-- Indexing work queue and per-object index status. Business modules emit
-- change events; the indexer drains this queue (synchronously or via the
-- background job engine). Unique per object so bursts coalesce.
CREATE TABLE IF NOT EXISTS search_index_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'upsert' CHECK (operation IN ('upsert', 'delete')),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  last_error TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_search_index_status_pending ON search_index_status(status, available_at);
CREATE INDEX IF NOT EXISTS idx_search_index_status_tenant ON search_index_status(tenant_id, status, updated_at);

-- Extracted, indexable text for content-backed objects. Binary payloads never
-- enter the search index: the File & Content Management service (or a
-- registered text extractor) pushes plain text here through an integration
-- contract, and indexing merges it into the document's searchable text.
CREATE TABLE IF NOT EXISTS search_extracted_text (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  content_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'content',
  language TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  text_length INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, object_id, content_id)
);

CREATE INDEX IF NOT EXISTS idx_search_extracted_object
  ON search_extracted_text(tenant_id, object_type, object_id);


-- Saved searches (personal and shared).
CREATE TABLE IF NOT EXISTS search_saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  query_json TEXT NOT NULL DEFAULT '{}',
  strategy TEXT NOT NULL DEFAULT 'standard',
  is_shared INTEGER NOT NULL DEFAULT 0,
  sharing_scope TEXT NOT NULL DEFAULT 'private' CHECK (sharing_scope IN ('private', 'organization', 'tenant')),
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_saved_tenant ON search_saved_searches(tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_search_saved_shared ON search_saved_searches(tenant_id, is_shared, sharing_scope);

-- Search history (per user).
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  query_text TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT 'standard',
  scope TEXT NOT NULL DEFAULT 'tenant',
  filters_json TEXT NOT NULL DEFAULT '{}',
  result_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  saved_search_id INTEGER REFERENCES search_saved_searches(id) ON DELETE SET NULL,
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(tenant_id, user_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_search_history_query ON search_history(tenant_id, query_text);

-- Export requests. Large result sets are materialised asynchronously by the
-- background job engine and stored through the File service when available.
CREATE TABLE IF NOT EXISTS search_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  query_json TEXT NOT NULL DEFAULT '{}',
  format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  row_count INTEGER NOT NULL DEFAULT 0,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  result_json TEXT,
  error TEXT,
  expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_exports_tenant ON search_exports(tenant_id, status, created_at);

-- Per-tenant search configuration (a single row per tenant).
CREATE TABLE IF NOT EXISTS search_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  default_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (default_scope IN ('tenant', 'organization', 'global')),
  page_size INTEGER NOT NULL DEFAULT 20,
  max_results INTEGER NOT NULL DEFAULT 500,
  min_query_length INTEGER NOT NULL DEFAULT 2,
  max_query_length INTEGER NOT NULL DEFAULT 400,
  highlight INTEGER NOT NULL DEFAULT 1,
  fuzzy INTEGER NOT NULL DEFAULT 1,
  history_retention_days INTEGER NOT NULL DEFAULT 90,
  index_files INTEGER NOT NULL DEFAULT 1,
  excluded_types_json TEXT NOT NULL DEFAULT '[]',
  default_sort TEXT NOT NULL DEFAULT 'relevance',
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Directed relationship edges projected from source modules for
-- relationship-aware search. Kept separate from the denormalised documents so
-- that edges can be filtered and traversed without scanning documents.
CREATE TABLE IF NOT EXISTS search_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, source_type, source_id, target_type, target_id, relationship_type, direction)
);

CREATE INDEX IF NOT EXISTS idx_search_rel_source ON search_relationships(tenant_id, source_type, source_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_search_rel_target ON search_relationships(tenant_id, target_type, target_id, relationship_type);

-- ── Integration & API Framework ────────────────────────────────────────────
-- Centralised Integration Hub. Business modules never build point-to-point
-- integrations; they register integration definitions, publish/subscribe to
-- domain events, enqueue asynchronous messages and use shared adapters,
-- transformation, import/export, webhook, scheduling, retry, dead-letter and
-- monitoring services provided here. No external system is hard-coded.

-- Credential references. Secrets are always encrypted at rest (server/crypto)
-- and are never returned to the API or written to logs.
CREATE TABLE IF NOT EXISTS integration_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'api_key',
  description TEXT DEFAULT '',
  tenant_id INTEGER,
  secret_enc TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired', 'revoked')),
  rotated_at TEXT,
  expires_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_tenant ON integration_credentials(tenant_id, status);

-- External systems the platform integrates with (SAP, MES, CAD, ERP, CRM,
-- PLM, suppliers, customers, ...). Provider-independent connection metadata.
CREATE TABLE IF NOT EXISTS external_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  system_type TEXT NOT NULL DEFAULT 'custom',
  description TEXT DEFAULT '',
  environment TEXT NOT NULL DEFAULT 'production',
  base_url TEXT DEFAULT '',
  connection_ref TEXT DEFAULT '',
  auth_method TEXT NOT NULL DEFAULT 'none',
  credential_id INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  protocols_json TEXT NOT NULL DEFAULT '[]',
  health_check_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  connection_status TEXT NOT NULL DEFAULT 'unknown' CHECK (connection_status IN ('unknown', 'healthy', 'degraded', 'down')),
  last_health_at TEXT,
  last_health_message TEXT DEFAULT '',
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  owner_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_systems_tenant ON external_systems(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_external_systems_type ON external_systems(system_type, environment);

-- Integration schedule definitions. Platform scheduling (cron/interval/timezone)
-- is delegated to the Background Job framework; this row keeps the
-- integration-specific metadata and a reference to the engine schedule.
CREATE TABLE IF NOT EXISTS integration_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  integration_id INTEGER,
  schedule_type TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_type IN ('once', 'interval', 'cron', 'daily', 'weekly', 'monthly')),
  cron_expression TEXT DEFAULT '',
  interval_seconds INTEGER NOT NULL DEFAULT 0,
  daily_time TEXT DEFAULT '',
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  day_of_month INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  start_at TEXT,
  end_at TEXT,
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip', 'allow', 'queue')),
  catchup_policy TEXT NOT NULL DEFAULT 'skip',
  max_duration_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'inactive')),
  job_schedule_code TEXT DEFAULT '',
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT DEFAULT '',
  failure_count INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  organization_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_schedules_tenant ON integration_schedules(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_integration_schedules_integration ON integration_schedules(integration_id, status);

-- Transformation & mapping definitions. Versioned, declarative and pluggable:
-- custom handlers are referenced by name only so business mapping logic never
-- lives inside the engine.
CREATE TABLE IF NOT EXISTS transformation_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  source_format TEXT NOT NULL DEFAULT 'json',
  target_format TEXT NOT NULL DEFAULT 'json',
  source_schema_json TEXT NOT NULL DEFAULT '{}',
  target_schema_json TEXT NOT NULL DEFAULT '{}',
  mappings_json TEXT NOT NULL DEFAULT '[]',
  constants_json TEXT NOT NULL DEFAULT '{}',
  conditionals_json TEXT NOT NULL DEFAULT '[]',
  conversions_json TEXT NOT NULL DEFAULT '[]',
  lookups_json TEXT NOT NULL DEFAULT '[]',
  validation_json TEXT NOT NULL DEFAULT '[]',
  error_handling TEXT NOT NULL DEFAULT 'fail' CHECK (error_handling IN ('fail', 'skip', 'null', 'default')),
  sample_input_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transformation_definitions_tenant ON transformation_definitions(tenant_id, status);

-- Canonical integration definitions (the hub's routing configuration).
CREATE TABLE IF NOT EXISTS integration_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  integration_type TEXT NOT NULL DEFAULT 'api',
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  adapter_type TEXT NOT NULL DEFAULT 'rest',
  protocol TEXT NOT NULL DEFAULT 'https',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'suspended', 'retired')),
  source_system_id INTEGER REFERENCES external_systems(id) ON DELETE SET NULL,
  target_system_id INTEGER REFERENCES external_systems(id) ON DELETE SET NULL,
  credential_id INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  transformation_id INTEGER REFERENCES transformation_definitions(id) ON DELETE SET NULL,
  schedule_id INTEGER REFERENCES integration_schedules(id) ON DELETE SET NULL,
  endpoint_id INTEGER,
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  auth_json TEXT NOT NULL DEFAULT '{}',
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  owner_id INTEGER,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  last_run_at TEXT,
  last_status TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_definitions_tenant ON integration_definitions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_integration_definitions_systems ON integration_definitions(source_system_id, target_system_id);

-- Immutable snapshot history for integration definitions (version + clone).
CREATE TABLE IF NOT EXISTS integration_definition_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES integration_definitions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT DEFAULT '',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS idx_integration_definition_versions ON integration_definition_versions(definition_id, version);

-- Exposed / consumed API endpoints (API catalog + versioning + rate limits).
CREATE TABLE IF NOT EXISTS integration_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  integration_id INTEGER REFERENCES integration_definitions(id) ON DELETE SET NULL,
  external_system_id INTEGER REFERENCES external_systems(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  method TEXT NOT NULL DEFAULT 'POST',
  path TEXT NOT NULL DEFAULT '',
  api_version TEXT NOT NULL DEFAULT 'v1',
  request_format TEXT NOT NULL DEFAULT 'json',
  response_format TEXT NOT NULL DEFAULT 'json',
  request_schema_json TEXT NOT NULL DEFAULT '{}',
  response_schema_json TEXT NOT NULL DEFAULT '{}',
  auth_required INTEGER NOT NULL DEFAULT 1,
  auth_method TEXT NOT NULL DEFAULT 'jwt',
  authorization_policy TEXT DEFAULT '',
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_endpoints_tenant ON integration_endpoints(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_integration_endpoints_version ON integration_endpoints(api_version, status);

-- Execution records: one row per integration run, with step-level timeline.
CREATE TABLE IF NOT EXISTS integration_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_ref TEXT NOT NULL UNIQUE,
  definition_id INTEGER REFERENCES integration_definitions(id) ON DELETE SET NULL,
  integration_code TEXT NOT NULL DEFAULT '',
  correlation_id TEXT DEFAULT '',
  parent_execution_id INTEGER,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  source_system_id INTEGER,
  target_system_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'partial', 'cancelled', 'timed_out')),
  current_step TEXT DEFAULT '',
  request_ref TEXT DEFAULT '',
  response_ref TEXT DEFAULT '',
  record_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  error_code TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  error_category TEXT DEFAULT '',
  initiated_by INTEGER,
  initiated_as TEXT NOT NULL DEFAULT 'user',
  job_id INTEGER,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_executions_tenant ON integration_executions(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_executions_definition ON integration_executions(definition_id, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_executions_status ON integration_executions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_executions_correlation ON integration_executions(correlation_id);

CREATE TABLE IF NOT EXISTS integration_execution_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES integration_executions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'retrying')),
  message TEXT DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_integration_execution_steps ON integration_execution_steps(execution_id, seq);

-- Provider-independent messages. Long-running / high-volume work is enqueued
-- here and processed asynchronously by the worker via background jobs.
CREATE TABLE IF NOT EXISTS integration_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_ref TEXT NOT NULL UNIQUE,
  message_type TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  integration_id INTEGER REFERENCES integration_definitions(id) ON DELETE SET NULL,
  queue TEXT NOT NULL DEFAULT 'INTEGRATION',
  source_system_id INTEGER,
  target_system_id INTEGER,
  correlation_id TEXT DEFAULT '',
  idempotency_key TEXT,
  payload_ref TEXT DEFAULT '',
  payload_format TEXT NOT NULL DEFAULT 'json',
  payload_json TEXT,
  payload_size INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'retry', 'dead_letter', 'duplicate', 'ignored', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  last_error TEXT DEFAULT '',
  error_category TEXT DEFAULT '',
  scheduled_at TEXT,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_messages_queue ON integration_messages(queue, status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_integration_messages_tenant ON integration_messages(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_messages_idempotency ON integration_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES integration_messages(id) ON DELETE SET NULL,
  execution_id INTEGER REFERENCES integration_executions(id) ON DELETE SET NULL,
  integration_id INTEGER,
  correlation_id TEXT DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  error_category TEXT DEFAULT '',
  error_code TEXT DEFAULT '',
  attempt_history_json TEXT NOT NULL DEFAULT '[]',
  stack_ref TEXT DEFAULT '',
  payload_ref TEXT DEFAULT '',
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retrying', 'reprocessed', 'ignored', 'closed')),
  resolution TEXT DEFAULT '',
  resolved_by INTEGER,
  resolved_at TEXT,
  tenant_id INTEGER,
  dead_lettered_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_tenant ON integration_dead_letters(tenant_id, status, created_at);

-- External-to-internal object identity mapping with conflict detection.
CREATE TABLE IF NOT EXISTS external_object_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_system_id INTEGER NOT NULL REFERENCES external_systems(id) ON DELETE CASCADE,
  external_object_type TEXT NOT NULL,
  external_object_id TEXT NOT NULL,
  internal_object_type TEXT NOT NULL,
  internal_object_id TEXT NOT NULL,
  internal_revision TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'conflict', 'orphan', 'ignored')),
  source_of_truth TEXT NOT NULL DEFAULT 'external' CHECK (source_of_truth IN ('external', 'internal')),
  conflict_status TEXT DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_execution_id INTEGER,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (external_system_id, external_object_type, external_object_id)
);

CREATE INDEX IF NOT EXISTS idx_external_object_mappings_internal ON external_object_mappings(internal_object_type, internal_object_id);
CREATE INDEX IF NOT EXISTS idx_external_object_mappings_tenant ON external_object_mappings(tenant_id, status);

-- Event catalog and subscriptions for the shared event framework.
CREATE TABLE IF NOT EXISTS integration_event_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'domain',
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound', 'internal')),
  schema_json TEXT NOT NULL DEFAULT '{}',
  example_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deprecated')),
  system INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_event_types_category ON integration_event_types(category, status);

CREATE TABLE IF NOT EXISTS integration_event_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  event_type_code TEXT NOT NULL,
  subscriber_type TEXT NOT NULL DEFAULT 'webhook' CHECK (subscriber_type IN ('webhook', 'integration', 'queue', 'internal', 'subscription')),
  target_ref TEXT DEFAULT '',
  filter_json TEXT NOT NULL DEFAULT '{}',
  delivery_mode TEXT NOT NULL DEFAULT 'push' CHECK (delivery_mode IN ('push', 'pull')),
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  connection_status TEXT NOT NULL DEFAULT 'unknown',
  last_delivery_at TEXT,
  last_status TEXT DEFAULT '',
  failure_count INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  organization_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_event_subscriptions_event ON integration_event_subscriptions(event_type_code, status);
CREATE INDEX IF NOT EXISTS idx_integration_event_subscriptions_tenant ON integration_event_subscriptions(tenant_id, status);

-- Published domain events and their per-subscription deliveries.
CREATE TABLE IF NOT EXISTS integration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ref TEXT NOT NULL UNIQUE,
  event_type_code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_module TEXT NOT NULL DEFAULT 'integration',
  payload_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT DEFAULT '',
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'processing', 'processed', 'partial', 'failed')),
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  organization_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_events_type ON integration_events(event_type_code, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_events_tenant ON integration_events(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_events_idempotency ON integration_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_event_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES integration_events(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES integration_event_subscriptions(id) ON DELETE SET NULL,
  event_type_code TEXT NOT NULL DEFAULT '',
  subscriber_type TEXT NOT NULL DEFAULT '',
  target_ref TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retry', 'dead_letter', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  response_code INTEGER,
  last_error TEXT DEFAULT '',
  payload_json TEXT,
  correlation_id TEXT DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_status ON integration_event_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_event ON integration_event_deliveries(event_id);

-- Inbound webhook endpoints.
CREATE TABLE IF NOT EXISTS integration_webhook_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  integration_id INTEGER REFERENCES integration_definitions(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL DEFAULT 'POST',
  auth_type TEXT NOT NULL DEFAULT 'signature' CHECK (auth_type IN ('none', 'api_key', 'signature', 'basic')),
  credential_id INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  event_type_code TEXT DEFAULT '',
  payload_schema_json TEXT NOT NULL DEFAULT '{}',
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  replay_window_seconds INTEGER NOT NULL DEFAULT 300,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'disabled')),
  last_received_at TEXT,
  receive_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_endpoints_tenant ON integration_webhook_endpoints(tenant_id, status);

-- Inbound webhook receipt log (replay protection + failed tracking).
CREATE TABLE IF NOT EXISTS integration_webhook_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER REFERENCES integration_webhook_endpoints(id) ON DELETE CASCADE,
  signature TEXT DEFAULT '',
  event_type_code TEXT DEFAULT '',
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'duplicate', 'rejected', 'failed')),
  reason TEXT DEFAULT '',
  message_id INTEGER,
  execution_id INTEGER,
  correlation_id TEXT DEFAULT '',
  tenant_id INTEGER,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_receipts_endpoint ON integration_webhook_receipts(endpoint_id, received_at);

-- Outbound webhook subscriptions and deliveries.
CREATE TABLE IF NOT EXISTS integration_webhook_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  url TEXT NOT NULL,
  event_filter_json TEXT NOT NULL DEFAULT '{}',
  credential_id INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  header_json TEXT NOT NULL DEFAULT '{}',
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 10,
  disabled_reason TEXT DEFAULT '',
  last_delivery_at TEXT,
  last_status_code INTEGER,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_subscriptions_tenant ON integration_webhook_subscriptions(tenant_id, status);

CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER REFERENCES integration_webhook_subscriptions(id) ON DELETE CASCADE,
  event_id INTEGER,
  event_type_code TEXT DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'outbound',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retry', 'dead_letter')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  request_headers_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT,
  response_code INTEGER,
  response_body TEXT DEFAULT '',
  duration_ms INTEGER,
  error TEXT DEFAULT '',
  next_retry_at TEXT,
  correlation_id TEXT DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_status ON integration_webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_subscription ON integration_webhook_deliveries(subscription_id, created_at);

-- Import/export transfers (file or REST based).
CREATE TABLE IF NOT EXISTS integration_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_ref TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('import', 'export')),
  name TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'csv',
  resource_type TEXT NOT NULL DEFAULT '',
  integration_id INTEGER REFERENCES integration_definitions(id) ON DELETE SET NULL,
  mapping_id INTEGER REFERENCES transformation_definitions(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'upsert' CHECK (mode IN ('create', 'create_only', 'upsert', 'replace')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  filename TEXT DEFAULT '',
  content_type TEXT DEFAULT '',
  content TEXT,
  template_code TEXT DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preview', 'validating', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT NOT NULL DEFAULT '{}',
  job_id INTEGER,
  tenant_id INTEGER,
  initiated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_transfers_tenant ON integration_transfers(tenant_id, direction, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_transfers_status ON integration_transfers(status);

-- API management catalog: externally visible API versions and lifecycle
-- (active / deprecated / retired) with auth and rate-limit metadata.
CREATE TABLE IF NOT EXISTS integration_api_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  api_group TEXT NOT NULL DEFAULT 'integration',
  version TEXT NOT NULL DEFAULT 'v1',
  description TEXT DEFAULT '',
  auth_required INTEGER NOT NULL DEFAULT 1,
  auth_methods_json TEXT NOT NULL DEFAULT '[]',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
  request_schema_json TEXT NOT NULL DEFAULT '{}',
  response_schema_json TEXT NOT NULL DEFAULT '{}',
  docs_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('beta', 'active', 'deprecated', 'retired')),
  deprecated_at TEXT,
  sunset_at TEXT,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (api_group, version)
);

CREATE INDEX IF NOT EXISTS idx_integration_api_catalog_status ON integration_api_catalog(status, api_group);

-- API consumers / service accounts. The plaintext key is shown once on create;
-- only its hash is persisted.
CREATE TABLE IF NOT EXISTS integration_api_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  client_type TEXT NOT NULL DEFAULT 'service_account' CHECK (client_type IN ('service_account', 'integration', 'external')),
  api_key_prefix TEXT DEFAULT '',
  api_key_hash TEXT DEFAULT '',
  credential_id INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  allowed_systems_json TEXT NOT NULL DEFAULT '[]',
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'revoked')),
  last_used_at TEXT,
  expires_at TEXT,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_api_clients_tenant ON integration_api_clients(tenant_id, status);

CREATE TABLE IF NOT EXISTS integration_api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  endpoint_code TEXT DEFAULT '',
  api_version TEXT DEFAULT 'v1',
  method TEXT DEFAULT '',
  path TEXT DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_api_usage_tenant ON integration_api_usage(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_api_usage_client ON integration_api_usage(client_id, created_at);

-- External system health check history.
CREATE TABLE IF NOT EXISTS integration_health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER REFERENCES external_systems(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy', 'degraded', 'down', 'unknown')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_health_checks_system ON integration_health_checks(system_id, checked_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 021_event_messaging_framework
-- Event & Messaging Framework: registry, schemas, events, transactional outbox,
-- topics/queues/consumer groups, subscriptions, deliveries, attempts,
-- idempotency, dead letters, replays and retention policies.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'domain',
  source_module TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  security_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  retention_days INTEGER NOT NULL DEFAULT 90,
  replay_policy TEXT NOT NULL DEFAULT 'controlled'
    CHECK (replay_policy IN ('allowed', 'controlled', 'denied')),
  ordering_required INTEGER NOT NULL DEFAULT 0 CHECK (ordering_required IN (0, 1)),
  ordering_scope TEXT NOT NULL DEFAULT 'none'
    CHECK (ordering_scope IN ('none', 'aggregate', 'object', 'partition', 'global')),
  default_priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (default_priority IN ('low', 'normal', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'inactive', 'deprecated', 'retired')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  schema_json TEXT NOT NULL DEFAULT '{}',
  example_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_registry_category ON event_registry(category, status);
CREATE INDEX IF NOT EXISTS idx_event_registry_module ON event_registry(source_module, status);
CREATE INDEX IF NOT EXISTS idx_event_registry_tenant ON event_registry(tenant_id, status);

CREATE TABLE IF NOT EXISTS event_schemas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type_id INTEGER NOT NULL REFERENCES event_registry(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  compatibility TEXT NOT NULL DEFAULT 'backward'
    CHECK (compatibility IN ('none', 'backward', 'forward', 'full')),
  schema_json TEXT NOT NULL DEFAULT '{}',
  example_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_type_id, version)
);

CREATE INDEX IF NOT EXISTS idx_event_schemas_type ON event_schemas(event_type_id, version);

CREATE TABLE IF NOT EXISTS event_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_ref TEXT NOT NULL UNIQUE,
  event_type_code TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  source_module TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'platform',
  source_object_type TEXT,
  source_object_id TEXT,
  source_object_revision TEXT,
  actor_id INTEGER,
  actor_type TEXT NOT NULL DEFAULT 'SYSTEM'
    CHECK (actor_type IN ('USER', 'SYSTEM', 'INTEGRATION', 'JOB', 'WORKFLOW')),
  correlation_id TEXT,
  causation_id TEXT,
  trace_id TEXT,
  parent_event_id TEXT,
  sequence_number INTEGER,
  partition_key TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  security_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('draft', 'queued', 'published', 'processing', 'completed', 'failed', 'archived')),
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_records_idempotency ON event_records(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_records_type_time ON event_records(event_type_code, created_at);
CREATE INDEX IF NOT EXISTS idx_event_records_tenant_time ON event_records(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_records_correlation ON event_records(correlation_id);
CREATE INDEX IF NOT EXISTS idx_event_records_trace ON event_records(trace_id);
CREATE INDEX IF NOT EXISTS idx_event_records_partition ON event_records(partition_key, sequence_number);
CREATE INDEX IF NOT EXISTS idx_event_records_object ON event_records(source_object_type, source_object_id);
CREATE INDEX IF NOT EXISTS idx_event_records_status ON event_records(status, created_at);

CREATE TABLE IF NOT EXISTS event_records_archive (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_type_code TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  source_module TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'platform',
  source_object_type TEXT,
  source_object_id TEXT,
  source_object_revision TEXT,
  actor_id INTEGER,
  actor_type TEXT NOT NULL DEFAULT 'SYSTEM',
  correlation_id TEXT,
  causation_id TEXT,
  trace_id TEXT,
  parent_event_id TEXT,
  sequence_number INTEGER,
  partition_key TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  security_classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'archived',
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  retention_policy_code TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_event_records_archive_type ON event_records_archive(event_type_code, created_at);
CREATE INDEX IF NOT EXISTS idx_event_records_archive_tenant ON event_records_archive(tenant_id, archived_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ref TEXT NOT NULL,
  event_type_code TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  aggregate_type TEXT,
  aggregate_id TEXT,
  correlation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_retry_at TEXT,
  locked_by TEXT NOT NULL DEFAULT '',
  locked_at TEXT,
  published_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  error_category TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_due ON event_outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_event_outbox_event ON event_outbox(event_ref);
CREATE INDEX IF NOT EXISTS idx_event_outbox_tenant ON event_outbox(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS event_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_type_code TEXT,
  partitions INTEGER NOT NULL DEFAULT 1,
  retention_hours INTEGER NOT NULL DEFAULT 168,
  max_message_bytes INTEGER NOT NULL DEFAULT 262144,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_topics_tenant ON event_topics(tenant_id, status);

CREATE TABLE IF NOT EXISTS event_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  consumer_group TEXT NOT NULL DEFAULT '',
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  visibility_timeout_seconds INTEGER NOT NULL DEFAULT 300,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retention_days INTEGER NOT NULL DEFAULT 30,
  dead_letter_enabled INTEGER NOT NULL DEFAULT 1 CHECK (dead_letter_enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_queues_tenant ON event_queues(tenant_id, status);

CREATE TABLE IF NOT EXISTS event_consumer_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  topic_code TEXT NOT NULL DEFAULT '',
  queue_code TEXT NOT NULL DEFAULT '',
  partition_strategy TEXT NOT NULL DEFAULT 'key_hash',
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  ordering_required INTEGER NOT NULL DEFAULT 0 CHECK (ordering_required IN (0, 1)),
  members INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_consumer_groups_tenant ON event_consumer_groups(tenant_id, status);

CREATE TABLE IF NOT EXISTS event_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subscriber TEXT NOT NULL,
  event_type_code TEXT NOT NULL,
  event_version INTEGER,
  topic_code TEXT NOT NULL DEFAULT '',
  queue_code TEXT NOT NULL DEFAULT '',
  consumer_group TEXT NOT NULL DEFAULT '',
  handler TEXT NOT NULL DEFAULT '',
  filter_json TEXT NOT NULL DEFAULT '{}',
  ordering_required INTEGER NOT NULL DEFAULT 0 CHECK (ordering_required IN (0, 1)),
  ordering_scope TEXT NOT NULL DEFAULT 'none'
    CHECK (ordering_scope IN ('none', 'aggregate', 'object', 'partition', 'global')),
  ordering_timeout_seconds INTEGER NOT NULL DEFAULT 30,
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  dead_letter_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'suspended')),
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_subscriptions_event ON event_subscriptions(event_type_code, status);
CREATE INDEX IF NOT EXISTS idx_event_subscriptions_tenant ON event_subscriptions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_event_subscriptions_queue ON event_subscriptions(queue_code, status);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES event_records(id) ON DELETE CASCADE,
  event_ref TEXT NOT NULL,
  subscription_id INTEGER REFERENCES event_subscriptions(id) ON DELETE SET NULL,
  event_type_code TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  subscriber TEXT NOT NULL DEFAULT '',
  handler TEXT NOT NULL DEFAULT '',
  topic_code TEXT NOT NULL DEFAULT '',
  queue_code TEXT NOT NULL DEFAULT '',
  consumer_group TEXT NOT NULL DEFAULT '',
  partition_key TEXT,
  sequence_number INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'retry', 'failed', 'dead_letter', 'skipped', 'duplicate', 'out_of_order', 'cancelled', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TEXT,
  next_retry_at TEXT,
  locked_by TEXT NOT NULL DEFAULT '',
  locked_at TEXT,
  visibility_expires_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  causation_id TEXT,
  trace_id TEXT,
  idempotency_key TEXT,
  security_classification TEXT NOT NULL DEFAULT 'internal',
  last_error TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_category TEXT NOT NULL DEFAULT '',
  last_processing_step TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  duration_ms INTEGER,
  replay_ref TEXT,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_deliveries_event_sub
  ON event_deliveries(event_id, subscription_id) WHERE event_id IS NOT NULL AND replay_ref IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_deliveries_due ON event_deliveries(status, available_at);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_queue ON event_deliveries(queue_code, status, available_at);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_tenant ON event_deliveries(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_partition ON event_deliveries(partition_key, sequence_number);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_event_ref ON event_deliveries(event_ref);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_correlation ON event_deliveries(correlation_id);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_subscription ON event_deliveries(subscription_id, status);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_handler ON event_deliveries(handler, updated_at);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_replay ON event_deliveries(replay_ref);

CREATE TABLE IF NOT EXISTS event_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES event_deliveries(id) ON DELETE CASCADE,
  event_id INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'failed',
  step TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_category TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_attempts_delivery ON event_delivery_attempts(delivery_id, id);

CREATE TABLE IF NOT EXISTS event_idempotency (
  key TEXT PRIMARY KEY,
  delivery_id INTEGER,
  event_id INTEGER,
  consumer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_idempotency_event ON event_idempotency(event_id);

CREATE TABLE IF NOT EXISTS event_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES event_records(id) ON DELETE SET NULL,
  delivery_id INTEGER REFERENCES event_deliveries(id) ON DELETE SET NULL,
  event_ref TEXT NOT NULL DEFAULT '',
  event_type_code TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  subscriber TEXT NOT NULL DEFAULT '',
  handler TEXT NOT NULL DEFAULT '',
  subscription_id INTEGER,
  topic_code TEXT NOT NULL DEFAULT '',
  queue_code TEXT NOT NULL DEFAULT '',
  correlation_id TEXT,
  causation_id TEXT,
  trace_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_category TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  last_processing_step TEXT NOT NULL DEFAULT '',
  failure_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  security_classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retrying', 'resolved', 'ignored')),
  resolved_by INTEGER,
  resolved_at TEXT,
  resolution_reason TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_dead_letters_status ON event_dead_letters(status, failure_at);
CREATE INDEX IF NOT EXISTS idx_event_dead_letters_tenant ON event_dead_letters(tenant_id, status, failure_at);
CREATE INDEX IF NOT EXISTS idx_event_dead_letters_delivery ON event_dead_letters(delivery_id);
CREATE INDEX IF NOT EXISTS idx_event_dead_letters_type ON event_dead_letters(event_type_code, failure_at);

CREATE TABLE IF NOT EXISTS event_replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_ref TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL DEFAULT 'event',
  criteria_json TEXT NOT NULL DEFAULT '{}',
  target_subscriptions_json TEXT NOT NULL DEFAULT '[]',
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'validating', 'validated', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  requested_by INTEGER,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  total_events INTEGER NOT NULL DEFAULT 0,
  matched_events INTEGER NOT NULL DEFAULT 0,
  replayed_events INTEGER NOT NULL DEFAULT 0,
  failed_events INTEGER NOT NULL DEFAULT 0,
  skipped_events INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_second INTEGER NOT NULL DEFAULT 25,
  error_message TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_replays_status ON event_replays(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_event_replays_tenant ON event_replays(tenant_id, requested_at);

CREATE TABLE IF NOT EXISTS event_retention_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  event_type_code TEXT,
  retention_days INTEGER NOT NULL DEFAULT 90,
  action TEXT NOT NULL DEFAULT 'archive' CHECK (action IN ('delete', 'archive', 'delete_after_archive')),
  archive_target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  last_run_at TEXT,
  last_run_deleted INTEGER NOT NULL DEFAULT 0,
  last_run_archived INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_retention_status ON event_retention_policies(status, event_type_code);

-- ── Enterprise Numbering & Identifier Service ───────────────────────────────
-- A shared platform capability. Business modules never own numbering state:
-- they resolve a scheme, request an identifier and consume it through this
-- service. All counters, patterns, scopes and history live here.

-- Registry of object types that can receive enterprise identifiers. Seeded
-- with the standard set but fully extensible by administrators.
CREATE TABLE IF NOT EXISTS numbering_object_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  module TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_object_types_code
  ON numbering_object_types(COALESCE(tenant_id, 0), code);
CREATE INDEX IF NOT EXISTS idx_numbering_object_types_status
  ON numbering_object_types(status, tenant_id);

-- Token registry. The pattern engine resolves tokens through this table so new
-- tokens can be registered without rewriting the engine.
CREATE TABLE IF NOT EXISTS numbering_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  resolver TEXT NOT NULL,
  example TEXT NOT NULL DEFAULT '',
  requires_permission TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_numbering_tokens_status ON numbering_tokens(status, code);

-- Registry of scope dimensions an administrator can attach to a scheme or a
-- sequence. Informational for the UI and validation; resolution is deterministic.
CREATE TABLE IF NOT EXISTS numbering_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT 'custom',
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Numbering scheme. Only one applicable default scheme is selected for a given
-- scope; resolution is deterministic and refuses ambiguity.
CREATE TABLE IF NOT EXISTS numbering_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  object_type_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'retired')),
  current_version INTEGER NOT NULL DEFAULT 1,
  pattern TEXT NOT NULL DEFAULT '{TYPE}-{YYYY}-{SEQ}',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT 'global'
    CHECK (scope_type IN ('global', 'tenant', 'organization', 'company', 'plant', 'site', 'classification', 'object_type', 'custom')),
  number_reuse_policy TEXT NOT NULL DEFAULT 'never_reuse'
    CHECK (number_reuse_policy IN ('never_reuse', 'reuse_after_release', 'reuse_after_expiration', 'custom')),
  numbering_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK (numbering_mode IN ('automatic', 'manual', 'automatic_with_manual_override', 'manual_required')),
  manual_policy TEXT NOT NULL DEFAULT 'disabled'
    CHECK (manual_policy IN ('disabled', 'allowed', 'approval_required', 'mandatory')),
  manual_pattern TEXT NOT NULL DEFAULT '',
  manual_allowed_chars TEXT NOT NULL DEFAULT '',
  manual_min_length INTEGER NOT NULL DEFAULT 0,
  manual_max_length INTEGER NOT NULL DEFAULT 0,
  min_length INTEGER NOT NULL DEFAULT 0,
  max_length INTEGER NOT NULL DEFAULT 64,
  start_value INTEGER NOT NULL DEFAULT 1,
  min_value INTEGER NOT NULL DEFAULT 1,
  max_value INTEGER NOT NULL DEFAULT 999999999999,
  increment INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 6,
  reset_policy TEXT NOT NULL DEFAULT 'never'
    CHECK (reset_policy IN ('never', 'daily', 'monthly', 'yearly', 'fiscal_year')),
  sequence_scope TEXT NOT NULL DEFAULT 'scheme'
    CHECK (sequence_scope IN ('global', 'tenant', 'organization', 'company', 'plant', 'site', 'object_type', 'classification', 'scheme', 'custom')),
  reservation_timeout_seconds INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  effective_from TEXT,
  effective_to TEXT,
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER REFERENCES organizations(id),
  site_id INTEGER REFERENCES organizations(id),
  classification TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_schemes_code
  ON numbering_schemes(COALESCE(tenant_id, 0), code);
CREATE INDEX IF NOT EXISTS idx_numbering_schemes_resolution
  ON numbering_schemes(object_type_code, status, priority);
CREATE INDEX IF NOT EXISTS idx_numbering_schemes_scope
  ON numbering_schemes(tenant_id, organization_id, plant_id, site_id);
CREATE INDEX IF NOT EXISTS idx_numbering_schemes_effective
  ON numbering_schemes(effective_from, effective_to);

-- Immutable version snapshots. Historical allocations retain the scheme version
-- that generated them so an activation can never make history ambiguous.
CREATE TABLE IF NOT EXISTS numbering_scheme_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_id INTEGER NOT NULL REFERENCES numbering_schemes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  config_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  effective_from TEXT,
  effective_to TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_scheme_versions_unique
  ON numbering_scheme_versions(scheme_id, version);
CREATE INDEX IF NOT EXISTS idx_numbering_scheme_versions_status
  ON numbering_scheme_versions(scheme_id, status);

-- Sequence counter. `current_value` is the last allocated value; the next
-- allocation is `current_value + increment`. Compound unique key on
-- (scheme, scope, period) makes cross-instance allocation safe.
CREATE TABLE IF NOT EXISTS numbering_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_id INTEGER NOT NULL REFERENCES numbering_schemes(id) ON DELETE CASCADE,
  scheme_version INTEGER NOT NULL DEFAULT 1,
  scope_key TEXT NOT NULL DEFAULT 'global',
  period_key TEXT NOT NULL DEFAULT '',
  reset_policy TEXT NOT NULL DEFAULT 'never'
    CHECK (reset_policy IN ('never', 'daily', 'monthly', 'yearly', 'fiscal_year')),
  start_value INTEGER NOT NULL DEFAULT 1,
  current_value INTEGER NOT NULL DEFAULT 1,
  min_value INTEGER NOT NULL DEFAULT 1,
  max_value INTEGER NOT NULL DEFAULT 999999999999,
  increment INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'exhausted', 'retired')),
  allocated_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at TEXT,
  last_allocated_at TEXT,
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  classification TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_sequences_scope
  ON numbering_sequences(scheme_id, scope_key, period_key);
CREATE INDEX IF NOT EXISTS idx_numbering_sequences_status
  ON numbering_sequences(status, tenant_id);
CREATE INDEX IF NOT EXISTS idx_numbering_sequences_scope_lookup
  ON numbering_sequences(scope_key, tenant_id);

-- Allocation / reservation / history record. Append-oriented: status columns
-- move forward and are never rewritten in place, and the uniqueness_key makes
-- duplicate numbers impossible within a scope at the database level.
CREATE TABLE IF NOT EXISTS numbering_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_ref TEXT NOT NULL UNIQUE,
  number TEXT NOT NULL,
  uniqueness_key TEXT NOT NULL,
  object_type_code TEXT NOT NULL,
  object_id TEXT,
  object_ref TEXT NOT NULL DEFAULT '',
  scheme_id INTEGER REFERENCES numbering_schemes(id) ON DELETE SET NULL,
  scheme_version INTEGER NOT NULL DEFAULT 1,
  sequence_id INTEGER REFERENCES numbering_sequences(id) ON DELETE SET NULL,
  sequence_value INTEGER,
  is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'allocated'
    CHECK (status IN ('allocated', 'reserved', 'consumed', 'released', 'expired', 'cancelled')),
  scope_key TEXT NOT NULL DEFAULT 'global',
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  classification TEXT NOT NULL DEFAULT '',
  number_reuse_policy TEXT NOT NULL DEFAULT 'never_reuse',
  reusable INTEGER NOT NULL DEFAULT 0 CHECK (reusable IN (0, 1)),
  requested_by INTEGER REFERENCES users(id),
  requested_by_name TEXT NOT NULL DEFAULT '',
  consumed_by INTEGER REFERENCES users(id),
  consumed_by_name TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reserved_at TEXT,
  expires_at TEXT,
  consumed_at TEXT,
  released_at TEXT,
  cancelled_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  source_application TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  correlation_id TEXT,
  idempotency_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_allocations_number
  ON numbering_allocations(uniqueness_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_allocations_idempotency
  ON numbering_allocations(COALESCE(tenant_id, 0), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_history
  ON numbering_allocations(tenant_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_object
  ON numbering_allocations(object_type_code, object_id);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_status
  ON numbering_allocations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_scheme
  ON numbering_allocations(scheme_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_scope
  ON numbering_allocations(scope_key, requested_at);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_reusable
  ON numbering_allocations(reusable, object_type_code, status);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_correlation
  ON numbering_allocations(correlation_id);
CREATE INDEX IF NOT EXISTS idx_numbering_allocations_ref
  ON numbering_allocations(allocation_ref);

-- Idempotency records. Stored per tenant and unique per key so a retried
-- allocation returns the original result instead of burning another number.
CREATE TABLE IF NOT EXISTS numbering_idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  tenant_id INTEGER,
  operation TEXT NOT NULL DEFAULT 'generate',
  request_hash TEXT NOT NULL DEFAULT '',
  allocation_id INTEGER REFERENCES numbering_allocations(id) ON DELETE SET NULL,
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_numbering_idempotency_key
  ON numbering_idempotency(COALESCE(tenant_id, 0), idempotency_key);
CREATE INDEX IF NOT EXISTS idx_numbering_idempotency_expiry
  ON numbering_idempotency(expires_at);

-- ============================================================================
-- Effectivity & Versioning Kernel (P0 platform capability)
--
-- The single source of truth for revision, version, effectivity, baseline,
-- snapshot, variant, configuration-context and as-of resolution across every
-- enterprise object. Business modules (PDM, BOM, MBOM, BOP, Manufacturing,
-- Change, Requirements, Documents, Product Configuration) consume this kernel
-- and never implement their own revision/effectivity logic.
-- ============================================================================

-- Extensible effectivity dimension registry. Declares the supported effectivity
-- types so new dimensions can be introduced as data, not kernel redesigns.
CREATE TABLE IF NOT EXISTS versioning_effectivity_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value_mode TEXT NOT NULL DEFAULT 'structured'
    CHECK (value_mode IN ('date_range', 'serial_range', 'list', 'scalar', 'boolean', 'reference')),
  description TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  system INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_types_dimension
  ON versioning_effectivity_types(dimension, status);

-- Revisions: a controlled evolution of an enterprise object.
CREATE TABLE IF NOT EXISTS versioning_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_ref TEXT NOT NULL UNIQUE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision_code TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'retired', 'archived')),
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  is_default INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  superseded_at TEXT,
  effective_from TEXT,
  effective_to TEXT,
  revision_metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  organization_id INTEGER,
  plant_id INTEGER,
  site_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (object_type, object_id, revision_code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_revisions_object
  ON versioning_revisions(object_type, object_id, revision_sequence);
CREATE INDEX IF NOT EXISTS idx_versioning_revisions_status
  ON versioning_revisions(status, object_type);
CREATE INDEX IF NOT EXISTS idx_versioning_revisions_tenant
  ON versioning_revisions(tenant_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_versioning_revisions_effective
  ON versioning_revisions(effective_from, effective_to);

-- Versions: independent evolution inside a revision where required.
CREATE TABLE IF NOT EXISTS versioning_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_ref TEXT NOT NULL UNIQUE,
  revision_id INTEGER NOT NULL REFERENCES versioning_revisions(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  version_number TEXT NOT NULL,
  version_sequence INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'retired', 'archived')),
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  is_default INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  superseded_at TEXT,
  effective_from TEXT,
  effective_to TEXT,
  version_metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (revision_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_versioning_versions_revision
  ON versioning_versions(revision_id, version_sequence);
CREATE INDEX IF NOT EXISTS idx_versioning_versions_object
  ON versioning_versions(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_versioning_versions_status
  ON versioning_versions(status);

-- Revision-to-revision effectivity relationships.
CREATE TABLE IF NOT EXISTS versioning_revision_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_revision_id INTEGER NOT NULL REFERENCES versioning_revisions(id) ON DELETE CASCADE,
  to_revision_id INTEGER NOT NULL REFERENCES versioning_revisions(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('supersedes', 'effective_after', 'effective_before', 'applicable_with', 'derived_from')),
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_revision_id, to_revision_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_versioning_revision_rel_from ON versioning_revision_relationships(from_revision_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_versioning_revision_rel_to ON versioning_revision_relationships(to_revision_id, relationship_type);

-- Variants and variant options.
CREATE TABLE IF NOT EXISTS versioning_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES versioning_variants(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_default INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_variants_parent ON versioning_variants(parent_id);
CREATE INDEX IF NOT EXISTS idx_versioning_variants_object ON versioning_variants(object_type, status);

CREATE TABLE IF NOT EXISTS versioning_variant_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES versioning_variants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (variant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_variant_options_variant ON versioning_variant_options(variant_id, sequence);

CREATE TABLE IF NOT EXISTS versioning_variant_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES versioning_variants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL DEFAULT 'applicability'
    CHECK (rule_type IN ('inclusion', 'exclusion', 'constraint', 'applicability')),
  expression_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (variant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_variant_rules_variant ON versioning_variant_rules(variant_id, rule_type);

-- Reusable configuration contexts shared by BOM, PDM, Manufacturing, Change,
-- Product Configuration, reporting, search and AI services.
CREATE TABLE IF NOT EXISTS versioning_configuration_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  configuration_version TEXT NOT NULL DEFAULT '1',
  variant_id INTEGER REFERENCES versioning_variants(id) ON DELETE SET NULL,
  model_id TEXT,
  plant_id INTEGER,
  site_id INTEGER,
  organization_id INTEGER,
  revision_id INTEGER REFERENCES versioning_revisions(id) ON DELETE SET NULL,
  as_of_date TEXT,
  serial_number TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_config_contexts_variant ON versioning_configuration_contexts(variant_id);
CREATE INDEX IF NOT EXISTS idx_versioning_config_contexts_tenant ON versioning_configuration_contexts(tenant_id, status);

-- Reusable effectivity definitions (ranges + structured values).
CREATE TABLE IF NOT EXISTS versioning_effectivity_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type_code TEXT NOT NULL,
  dimension TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  boundary TEXT NOT NULL DEFAULT 'inclusive' CHECK (boundary IN ('inclusive', 'exclusive')),
  serial_from TEXT,
  serial_to TEXT,
  serial_mode TEXT NOT NULL DEFAULT 'numeric' CHECK (serial_mode IN ('numeric', 'alphanumeric')),
  revision_id INTEGER REFERENCES versioning_revisions(id) ON DELETE SET NULL,
  configuration_context_id INTEGER REFERENCES versioning_configuration_contexts(id) ON DELETE SET NULL,
  include_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 100,
  overlap_allowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER,
  organization_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_defs_type ON versioning_effectivity_definitions(type_code, status);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_defs_dates ON versioning_effectivity_definitions(effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_defs_serial ON versioning_effectivity_definitions(serial_from, serial_to);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_defs_tenant ON versioning_effectivity_definitions(tenant_id, status);

-- Structured effectivity values (model lists, plant lists, variant applicability,
-- inclusion/exclusion operators). Keeping values in rows avoids hard-coding any
-- single product's rule shape into the kernel.
CREATE TABLE IF NOT EXISTS versioning_effectivity_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES versioning_effectivity_definitions(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'include' CHECK (operator IN ('include', 'exclude')),
  value_type TEXT NOT NULL DEFAULT 'string',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, dimension, operator, value)
);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_values_lookup ON versioning_effectivity_values(dimension, value);

-- Effectivity assignments link a reusable definition to a concrete target
-- (object / revision / version).
CREATE TABLE IF NOT EXISTS versioning_effectivity_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_ref TEXT NOT NULL UNIQUE,
  definition_id INTEGER NOT NULL REFERENCES versioning_effectivity_definitions(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision_id INTEGER REFERENCES versioning_revisions(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES versioning_versions(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'override', 'exclusion')),
  precedence INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tenant_id INTEGER,
  organization_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versioning_effectivity_assign_unique
  ON versioning_effectivity_assignments(definition_id, object_type, object_id, COALESCE(revision_id, 0), COALESCE(version_id, 0));
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_assign_target
  ON versioning_effectivity_assignments(object_type, object_id, status);
CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_assign_revision
  ON versioning_effectivity_assignments(revision_id, status);

-- Configurable, deterministic resolution policies. Precedence and conflict
-- handling live in configuration rather than scattered code.
CREATE TABLE IF NOT EXISTS versioning_resolution_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  precedence_json TEXT NOT NULL DEFAULT '["configuration","revision","serial","model","plant","unit","date","default"]',
  boundary TEXT NOT NULL DEFAULT 'inclusive' CHECK (boundary IN ('inclusive', 'exclusive')),
  ambiguity_strategy TEXT NOT NULL DEFAULT 'error'
    CHECK (ambiguity_strategy IN ('error', 'priority', 'latest_revision')),
  allow_overlap INTEGER NOT NULL DEFAULT 0,
  fallback_to_default INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_default INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versioning_resolution_policies_default ON versioning_resolution_policies(is_default, status);

-- Resolution audit + metrics feed. Every resolve call records a row.
CREATE TABLE IF NOT EXISTS versioning_resolution_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_ref TEXT NOT NULL UNIQUE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  policy_code TEXT,
  context_hash TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL
    CHECK (status IN ('RESOLVED', 'AMBIGUOUS', 'NOT_FOUND', 'INVALID_CONTEXT', 'CONFLICT')),
  revision_id INTEGER,
  version_id INTEGER,
  resolution_reason TEXT NOT NULL DEFAULT '',
  candidate_scores_json TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL DEFAULT '',
  duration_ms REAL NOT NULL DEFAULT 0,
  resolved_by INTEGER,
  tenant_id INTEGER,
  request_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versioning_resolution_results_object
  ON versioning_resolution_results(object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_versioning_resolution_results_status
  ON versioning_resolution_results(status, created_at);
CREATE INDEX IF NOT EXISTS idx_versioning_resolution_results_tenant
  ON versioning_resolution_results(tenant_id, created_at);

-- Baselines: frozen logical state of selected enterprise data.
CREATE TABLE IF NOT EXISTS versioning_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baseline_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER,
  owner_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'retired')),
  context_json TEXT NOT NULL DEFAULT '{}',
  object_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT,
  frozen_by INTEGER,
  tenant_id INTEGER,
  organization_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_baselines_status ON versioning_baselines(status, tenant_id);

CREATE TABLE IF NOT EXISTS versioning_baseline_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baseline_id INTEGER NOT NULL REFERENCES versioning_baselines(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision_id INTEGER,
  version_id INTEGER,
  revision_code TEXT NOT NULL DEFAULT '',
  version_number TEXT NOT NULL DEFAULT '',
  resolution_status TEXT NOT NULL DEFAULT 'RESOLVED',
  resolution_reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (baseline_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_versioning_baseline_objects_object ON versioning_baseline_objects(object_type, object_id);

-- Historical snapshots: immutable resolved state at a point in time/context.
CREATE TABLE IF NOT EXISTS versioning_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  context_json TEXT NOT NULL DEFAULT '{}',
  object_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  parent_snapshot_id INTEGER REFERENCES versioning_snapshots(id) ON DELETE SET NULL,
  tenant_id INTEGER,
  organization_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_versioning_snapshots_tenant ON versioning_snapshots(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS versioning_snapshot_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES versioning_snapshots(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision_id INTEGER,
  version_id INTEGER,
  revision_code TEXT NOT NULL DEFAULT '',
  version_number TEXT NOT NULL DEFAULT '',
  resolution_status TEXT NOT NULL DEFAULT 'RESOLVED',
  resolution_reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (snapshot_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_versioning_snapshot_objects_object ON versioning_snapshot_objects(object_type, object_id);

-- Cache epoch: bumping this invalidates the in-process resolution cache after any
-- kernel mutation without a network round trip.
CREATE TABLE IF NOT EXISTS versioning_cache_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT OR IGNORE INTO versioning_cache_epoch (id, epoch) VALUES (1, 0);

-- ── Enterprise Reference Data Management (ERDM) ────────────────────────────
-- Governed, reusable enterprise master/reference values. Distinct from
-- Metadata LOVs: reference data carries governance, ownership, lifecycle,
-- effective dating, versioning, scope, translation, alias and auditability.
-- Business modules consume these tables only through the Reference Data API/SDK.

CREATE TABLE IF NOT EXISTS reference_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive', 'retired')),
  scope_type TEXT NOT NULL DEFAULT 'GLOBAL'
    CHECK (scope_type IN ('GLOBAL', 'TENANT', 'ORGANIZATION', 'COMPANY', 'BUSINESS_UNIT', 'PLANT', 'SITE')),
  owner_user_id INTEGER REFERENCES users(id),
  owner_group_id INTEGER REFERENCES groups(id),
  owner_label TEXT NOT NULL DEFAULT '',
  business_owner TEXT NOT NULL DEFAULT '',
  technical_owner TEXT NOT NULL DEFAULT '',
  steward_user_id INTEGER REFERENCES users(id),
  steward_group_id INTEGER REFERENCES groups(id),
  steward_label TEXT NOT NULL DEFAULT '',
  default_language TEXT NOT NULL DEFAULT 'en',
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  current_governance_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_domains_code
  ON reference_domains(COALESCE(tenant_id, 0), code);
CREATE INDEX IF NOT EXISTS idx_reference_domains_status ON reference_domains(status, tenant_id);
CREATE INDEX IF NOT EXISTS idx_reference_domains_scope ON reference_domains(scope_type, tenant_id);

-- Versioned governance policy. Behaviour is configuration, not code: approval,
-- translation, hierarchy, code reuse, effective dating and lifecycle.
CREATE TABLE IF NOT EXISTS reference_governance_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  approval_required INTEGER NOT NULL DEFAULT 0 CHECK (approval_required IN (0, 1)),
  translation_required INTEGER NOT NULL DEFAULT 0 CHECK (translation_required IN (0, 1)),
  alias_enabled INTEGER NOT NULL DEFAULT 1 CHECK (alias_enabled IN (0, 1)),
  hierarchy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (hierarchy_enabled IN (0, 1)),
  effective_dating_enabled INTEGER NOT NULL DEFAULT 1 CHECK (effective_dating_enabled IN (0, 1)),
  versioning_enabled INTEGER NOT NULL DEFAULT 1 CHECK (versioning_enabled IN (0, 1)),
  code_reuse_policy TEXT NOT NULL DEFAULT 'never_reuse'
    CHECK (code_reuse_policy IN ('never_reuse', 'reuse_after_retirement', 'always_reuse')),
  code_case_sensitive INTEGER NOT NULL DEFAULT 1 CHECK (code_case_sensitive IN (0, 1)),
  code_pattern TEXT NOT NULL DEFAULT '',
  default_language TEXT NOT NULL DEFAULT 'en',
  lifecycle_json TEXT NOT NULL DEFAULT '["draft","submitted","under_review","approved","active","inactive","retired"]',
  approval_policy_json TEXT NOT NULL DEFAULT '{}',
  versioning_policy_json TEXT NOT NULL DEFAULT '{}',
  effective_date_policy_json TEXT NOT NULL DEFAULT '{}',
  workflow_definition_code TEXT NOT NULL DEFAULT '',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_governance_unique
  ON reference_governance_policies(domain_id, version);
CREATE INDEX IF NOT EXISTS idx_reference_governance_active
  ON reference_governance_policies(domain_id, status);

-- Generic reference item. Domain-specific fields live in attributes_json; the
-- core never grows domain-specific columns.
CREATE TABLE IF NOT EXISTS reference_data_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_ref TEXT NOT NULL UNIQUE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'active', 'inactive', 'retired', 'rejected', 'returned')),
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  scope_type TEXT NOT NULL DEFAULT 'GLOBAL'
    CHECK (scope_type IN ('GLOBAL', 'TENANT', 'ORGANIZATION', 'COMPANY', 'BUSINESS_UNIT', 'PLANT', 'SITE')),
  scope_key TEXT NOT NULL DEFAULT 'GLOBAL',
  is_global INTEGER NOT NULL DEFAULT 1 CHECK (is_global IN (0, 1)),
  effective_from TEXT,
  effective_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  current_version_number INTEGER NOT NULL DEFAULT 1,
  parent_id INTEGER REFERENCES reference_data_items(id) ON DELETE SET NULL,
  hierarchy_path TEXT NOT NULL DEFAULT '',
  hierarchy_level INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  owner_user_id INTEGER REFERENCES users(id),
  steward_user_id INTEGER REFERENCES users(id),
  owner_label TEXT NOT NULL DEFAULT '',
  steward_label TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  versioning_revision_id INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  company_id INTEGER REFERENCES organizations(id),
  business_unit_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER REFERENCES organizations(id),
  site_id INTEGER REFERENCES organizations(id),
  submitted_at TEXT,
  approved_at TEXT,
  activated_at TEXT,
  inactivated_at TEXT,
  retired_at TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_items_code
  ON reference_data_items(domain_id, scope_key, code);
CREATE INDEX IF NOT EXISTS idx_reference_items_domain ON reference_data_items(domain_id, status, code);
CREATE INDEX IF NOT EXISTS idx_reference_items_scope ON reference_data_items(scope_key, status);
CREATE INDEX IF NOT EXISTS idx_reference_items_effective ON reference_data_items(effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_reference_items_parent ON reference_data_items(parent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_reference_items_tenant ON reference_data_items(tenant_id, domain_id);
CREATE INDEX IF NOT EXISTS idx_reference_items_revision ON reference_data_items(versioning_revision_id);

-- Immutable version snapshots. Governed history is never overwritten.
CREATE TABLE IF NOT EXISTS reference_data_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_ref TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'active', 'inactive', 'retired', 'superseded', 'rejected', 'returned')),
  change_summary TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  effective_from TEXT,
  effective_to TEXT,
  versioning_revision_id INTEGER,
  owner_label TEXT NOT NULL DEFAULT '',
  steward_label TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_reference_versions_item ON reference_data_versions(item_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_reference_versions_domain ON reference_data_versions(domain_id, status);
CREATE INDEX IF NOT EXISTS idx_reference_versions_revision ON reference_data_versions(versioning_revision_id);

-- First-class codes: primary, external, legacy, deprecated and replacement
-- mappings. Retirement history is retained so a code is never silently reused.
CREATE TABLE IF NOT EXISTS reference_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_ref TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  code_type TEXT NOT NULL DEFAULT 'primary'
    CHECK (code_type IN ('primary', 'external', 'legacy', 'deprecated', 'replacement')),
  code_system TEXT NOT NULL DEFAULT '',
  external_system TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  case_sensitive INTEGER NOT NULL DEFAULT 1 CHECK (case_sensitive IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deprecated', 'retired')),
  effective_from TEXT,
  effective_to TEXT,
  replacement_item_id INTEGER REFERENCES reference_data_items(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_codes_lookup ON reference_codes(domain_id, code, status);
CREATE INDEX IF NOT EXISTS idx_reference_codes_item ON reference_codes(item_id, code_type);
CREATE INDEX IF NOT EXISTS idx_reference_codes_system ON reference_codes(code_system, external_system, code);

CREATE TABLE IF NOT EXISTS reference_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_ref TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_type TEXT NOT NULL DEFAULT 'synonym'
    CHECK (alias_type IN ('synonym', 'abbreviation', 'translation', 'external', 'legacy', 'search')),
  language TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  scope_key TEXT NOT NULL DEFAULT 'GLOBAL',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_from TEXT,
  effective_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, language, alias)
);
CREATE INDEX IF NOT EXISTS idx_reference_aliases_lookup ON reference_aliases(domain_id, alias);
CREATE INDEX IF NOT EXISTS idx_reference_aliases_item ON reference_aliases(item_id, status);

CREATE TABLE IF NOT EXISTS reference_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  translation_ref TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'active', 'inactive')),
  source TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, language)
);
CREATE INDEX IF NOT EXISTS idx_reference_translations_lookup ON reference_translations(domain_id, language, status);
CREATE INDEX IF NOT EXISTS idx_reference_translations_item ON reference_translations(item_id);

-- Hierarchy edges (authoritative for ordering and relationship type; the item's
-- parent_id/hierarchy_path are maintained as a fast read projection).
CREATE TABLE IF NOT EXISTS reference_hierarchy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_ref TEXT NOT NULL UNIQUE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'parent_child'
    CHECK (relationship_type IN ('parent_child', 'component', 'classification', 'grouping')),
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_from TEXT,
  effective_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (parent_id, child_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_reference_hierarchy_parent ON reference_hierarchy(parent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_reference_hierarchy_child ON reference_hierarchy(child_id);
CREATE INDEX IF NOT EXISTS idx_reference_hierarchy_domain ON reference_hierarchy(domain_id, status);

-- Generic cross-domain relationships (Country -> Currency, Plant -> Plant Type).
CREATE TABLE IF NOT EXISTS reference_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relationship_ref TEXT NOT NULL UNIQUE,
  source_item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  target_item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  source_domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  target_domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'GLOBAL',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_from TEXT,
  effective_to TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_item_id, target_item_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_reference_relationships_source ON reference_relationships(source_item_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_reference_relationships_target ON reference_relationships(target_item_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_reference_relationships_domain ON reference_relationships(source_domain_id, target_domain_id, status);

-- Configurable scope precedence (PLANT -> ORGANIZATION -> TENANT -> GLOBAL by
-- default). Resolution never silently returns conflicting values.
CREATE TABLE IF NOT EXISTS reference_scope_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_ref TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  precedence_json TEXT NOT NULL DEFAULT '["PLANT","ORGANIZATION","TENANT","GLOBAL"]',
  allow_global_fallback INTEGER NOT NULL DEFAULT 1 CHECK (allow_global_fallback IN (0, 1)),
  conflict_strategy TEXT NOT NULL DEFAULT 'error' CHECK (conflict_strategy IN ('error', 'highest_precedence', 'latest_version')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  tenant_id INTEGER REFERENCES organizations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_reference_scope_policies_default ON reference_scope_policies(is_default, tenant_id, status);

CREATE TABLE IF NOT EXISTS reference_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_ref TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES reference_data_items(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES reference_data_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected', 'returned', 'cancelled')),
  required_approvals INTEGER NOT NULL DEFAULT 1,
  approval_count INTEGER NOT NULL DEFAULT 0,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  workflow_instance_id INTEGER,
  workflow_definition_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_approvals_item ON reference_approvals(item_id, status);
CREATE INDEX IF NOT EXISTS idx_reference_approvals_domain ON reference_approvals(domain_id, status);
CREATE INDEX IF NOT EXISTS idx_reference_approvals_assignee ON reference_approvals(decided_by, status);

CREATE TABLE IF NOT EXISTS reference_ownership_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES reference_domains(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES reference_data_items(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  changed_by INTEGER REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_ownership_domain ON reference_ownership_history(domain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reference_ownership_item ON reference_ownership_history(item_id, created_at);

CREATE TABLE IF NOT EXISTS reference_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_ref TEXT NOT NULL UNIQUE,
  domain_id INTEGER REFERENCES reference_domains(id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES reference_data_items(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  change_type TEXT NOT NULL DEFAULT 'update'
    CHECK (change_type IN ('create', 'update', 'retire', 'governance', 'import')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'applied', 'cancelled')),
  requested_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  approval_id INTEGER REFERENCES reference_approvals(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT,
  decided_at TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_change_requests_status ON reference_change_requests(status, domain_id);
CREATE INDEX IF NOT EXISTS idx_reference_change_requests_item ON reference_change_requests(item_id);

CREATE TABLE IF NOT EXISTS reference_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_ref TEXT NOT NULL UNIQUE,
  domain_id INTEGER REFERENCES reference_domains(id) ON DELETE SET NULL,
  format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv', 'tsv', 'excel')),
  filename TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'validated', 'previewed', 'failed', 'approved', 'committed', 'cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  error_json TEXT NOT NULL DEFAULT '[]',
  preview_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '{}',
  workflow_instance_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reference_imports_domain ON reference_imports(domain_id, status);
CREATE INDEX IF NOT EXISTS idx_reference_imports_tenant ON reference_imports(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS reference_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  export_ref TEXT NOT NULL UNIQUE,
  domain_id INTEGER REFERENCES reference_domains(id) ON DELETE SET NULL,
  format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv', 'tsv')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'ready', 'expired', 'failed')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  row_count INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  requested_by INTEGER REFERENCES users(id),
  tenant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reference_exports_domain ON reference_exports(domain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reference_exports_tenant ON reference_exports(tenant_id, created_at);

-- Cache epoch: bumping invalidates the per-tenant reference-data read cache
-- without a network round trip after any governed mutation.
CREATE TABLE IF NOT EXISTS reference_cache_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT OR IGNORE INTO reference_cache_epoch (id, epoch) VALUES (1, 0);

-- ── File & Content Management Service ────────────────────────────────────────
-- Generic, object-type-agnostic binary content capability. Business objects own
-- meaning/metadata/lifecycle/revision; this module owns physical content, its
-- versions, storage references, security scanning, quarantining, renditions and
-- retention. Binary bytes live only in the pluggable storage provider; these
-- tables hold metadata, checksums and opaque storage keys.

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL UNIQUE,
  content_key TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  plant_id INTEGER,
  site_id INTEGER,
  department_id INTEGER,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  versioning_revision_id INTEGER,
  version_id TEXT,
  content_type TEXT NOT NULL DEFAULT 'file',
  content_role TEXT NOT NULL DEFAULT 'NATIVE',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  file_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL DEFAULT '',
  file_extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_security'
    CHECK (status IN ('initiated', 'pending_security', 'scanning', 'processing', 'available',
      'locked', 'superseded', 'quarantined', 'archived', 'retained', 'deleted', 'failed')),
  security_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (security_status IN ('pending', 'scanning', 'clean', 'infected', 'failed', 'unknown')),
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'ready', 'partial', 'failed')),
  current_version_id INTEGER,
  version_count INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT NOT NULL DEFAULT '',
  dedupe_of_content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
  security_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_tenant ON content(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_object ON content(tenant_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_content_status ON content(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_content_security ON content(tenant_id, security_status);
CREATE INDEX IF NOT EXISTS idx_content_role ON content(content_role);
CREATE INDEX IF NOT EXISTS idx_content_checksum ON content(checksum, file_size);
CREATE INDEX IF NOT EXISTS idx_content_deleted ON content(deleted_at);
CREATE INDEX IF NOT EXISTS idx_content_storage ON content(storage_provider, storage_key);

-- Immutable content version chain. Historical versions are never overwritten.
CREATE TABLE IF NOT EXISTS content_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  tenant_id INTEGER REFERENCES organizations(id),
  version_number INTEGER NOT NULL,
  version_label TEXT NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  previous_version_id INTEGER REFERENCES content_versions(id),
  file_name TEXT NOT NULL DEFAULT '',
  original_file_name TEXT NOT NULL DEFAULT '',
  file_extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('pending_security', 'scanning', 'processing', 'available', 'quarantined', 'failed', 'deleted')),
  security_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (security_status IN ('pending', 'scanning', 'clean', 'infected', 'failed', 'unknown')),
  checkin_comment TEXT NOT NULL DEFAULT '',
  restored_from_version_id INTEGER REFERENCES content_versions(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (content_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_content_versions_content ON content_versions(content_id, version_number);
CREATE INDEX IF NOT EXISTS idx_content_versions_current ON content_versions(content_id, is_current);
CREATE INDEX IF NOT EXISTS idx_content_versions_checksum ON content_versions(checksum);

-- Generic Object ↔ Content association. Not document-specific: any object type
-- (part, CAD model, BOM, change, requirement, workflow task, ...) can own roles.
CREATE TABLE IF NOT EXISTS content_associations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  association_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_name TEXT NOT NULL DEFAULT '',
  versioning_revision_id INTEGER,
  version_id TEXT,
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  content_role TEXT NOT NULL DEFAULT 'ATTACHMENT',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'superseded', 'deleted')),
  effective_from TEXT,
  effective_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_assoc_unique
  ON content_associations(tenant_id, object_type, object_id, content_id, content_role)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_assoc_object ON content_associations(tenant_id, object_type, object_id, status);
CREATE INDEX IF NOT EXISTS idx_content_assoc_content ON content_associations(content_id, status);
CREATE INDEX IF NOT EXISTS idx_content_assoc_primary ON content_associations(tenant_id, object_type, object_id, is_primary);

-- Upload sessions (single, multipart/chunked, resumable). The upload id is the
-- client-facing handle; staging/storage keys stay server-side and opaque.
CREATE TABLE IF NOT EXISTS content_upload_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  versioning_revision_id INTEGER,
  version_id TEXT,
  content_role TEXT NOT NULL DEFAULT 'NATIVE',
  file_name TEXT NOT NULL DEFAULT '',
  original_file_name TEXT NOT NULL DEFAULT '',
  file_extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  expected_size INTEGER NOT NULL DEFAULT 0,
  received_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  declared_checksum TEXT NOT NULL DEFAULT '',
  security_classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'uploading', 'uploaded', 'scanning', 'processing', 'completed',
      'failed', 'cancelled', 'expired')),
  chunk_size INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  received_chunks INTEGER NOT NULL DEFAULT 0,
  staging_key TEXT NOT NULL DEFAULT '',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
  error_message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_uploads_tenant ON content_upload_sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_content_uploads_expiry ON content_upload_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_content_uploads_content ON content_upload_sessions(content_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_uploads_idem
  ON content_upload_sessions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_upload_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES content_upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  staging_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, part_number)
);

-- Check-out/check-in locks. Partial unique index enforces a single active lock.
CREATE TABLE IF NOT EXISTS content_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  tenant_id INTEGER REFERENCES organizations(id),
  lock_token TEXT NOT NULL UNIQUE,
  lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK (lock_type IN ('exclusive', 'shared')),
  locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  expires_at TEXT,
  released_at TEXT,
  released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  force_released INTEGER NOT NULL DEFAULT 0 CHECK (force_released IN (0, 1)),
  release_reason TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_locks_active
  ON content_locks(content_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_locks_owner ON content_locks(locked_by, released_at);
CREATE INDEX IF NOT EXISTS idx_content_locks_expiry ON content_locks(expires_at, released_at);

-- Renditions (PDF, JT, preview, thumbnail, ...). Framework-derived derivatives.
CREATE TABLE IF NOT EXISTS content_renditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rendition_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  source_content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
  source_version_id INTEGER REFERENCES content_versions(id) ON DELETE SET NULL,
  rendition_type TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  storage_bucket TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'available', 'failed', 'skipped', 'outdated', 'cancelled')),
  generator TEXT NOT NULL DEFAULT '',
  generator_version TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (content_id, source_version_id, rendition_type)
);

CREATE INDEX IF NOT EXISTS idx_content_renditions_content ON content_renditions(content_id, status);
CREATE INDEX IF NOT EXISTS idx_content_renditions_type ON content_renditions(rendition_type, status);

CREATE TABLE IF NOT EXISTS content_processing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES content_versions(id) ON DELETE SET NULL,
  rendition_id INTEGER REFERENCES content_renditions(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_jobs_content ON content_processing_jobs(content_id, job_type);
CREATE INDEX IF NOT EXISTS idx_content_jobs_status ON content_processing_jobs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS content_security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES content_versions(id) ON DELETE SET NULL,
  scan_type TEXT NOT NULL DEFAULT 'upload',
  scanner TEXT NOT NULL DEFAULT '',
  engine_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scanning', 'clean', 'infected', 'failed', 'unknown')),
  result TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  scanned_bytes INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_scans_content ON content_security_scans(content_id, status);
CREATE INDEX IF NOT EXISTS idx_content_scans_status ON content_security_scans(status, created_at);

CREATE TABLE IF NOT EXISTS content_retention_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER REFERENCES organizations(id),
  policy_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  retention_days INTEGER NOT NULL DEFAULT 0,
  retention_start_basis TEXT NOT NULL DEFAULT 'created'
    CHECK (retention_start_basis IN ('created', 'modified', 'superseded', 'release')),
  disposition TEXT NOT NULL DEFAULT 'review' CHECK (disposition IN ('review', 'archive', 'purge')),
  applies_to_role TEXT NOT NULL DEFAULT '',
  applies_to_object_type TEXT NOT NULL DEFAULT '',
  applies_to_classification TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_retention_policy_code
  ON content_retention_policies(COALESCE(tenant_id, 0), policy_code);

CREATE TABLE IF NOT EXISTS content_retention_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES content_retention_policies(id) ON DELETE SET NULL,
  retention_start TEXT,
  retention_end TEXT,
  disposition TEXT NOT NULL DEFAULT 'review',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'eligible', 'archived', 'purged', 'released')),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
  evaluated_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (content_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_content_retention_content ON content_retention_records(content_id, status);
CREATE INDEX IF NOT EXISTS idx_content_retention_end ON content_retention_records(status, retention_end);

CREATE TABLE IF NOT EXISTS content_legal_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  case_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  applied_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_legal_holds_active
  ON content_legal_holds(content_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_content_legal_holds_content ON content_legal_holds(content_id, status);

CREATE TABLE IF NOT EXISTS content_storage_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES organizations(id),
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES content_versions(id) ON DELETE SET NULL,
  storage_provider TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL,
  storage_bucket TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'orphaned', 'deleted')),
  last_verified_at TEXT,
  verified_checksum TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (storage_provider, storage_key)
);

CREATE INDEX IF NOT EXISTS idx_content_storage_content ON content_storage_references(content_id, status);
CREATE INDEX IF NOT EXISTS idx_content_storage_key ON content_storage_references(storage_key);

-- Module outbox mirroring the platform Event & Messaging framework.
CREATE TABLE IF NOT EXISTS content_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
  version_id INTEGER,
  rendition_id INTEGER,
  tenant_id INTEGER,
  organization_id INTEGER,
  actor_id INTEGER,
  correlation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'recorded',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_events_content ON content_events(content_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_events_type ON content_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_content_events_tenant ON content_events(tenant_id, created_at);

-- ===========================================================================
-- P0 Data Security & Entitlement Model
-- A single centralized authorization model: RBAC + object/field/row/organization/
-- plant/classification security + masking, with an ABAC-ready policy engine.
-- Business modules register object types here and never implement their own
-- authorization engine.
-- ===========================================================================

-- Registration per object type. `enforcement` decides how aggressively the
-- centralized engine filters rows: tenant isolation always applies.
CREATE TABLE IF NOT EXISTS security_object_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  enforcement TEXT NOT NULL DEFAULT 'tenant' CHECK (enforcement IN ('tenant', 'entitlement', 'policy')),
  permission_resource TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type)
);

CREATE INDEX IF NOT EXISTS idx_security_object_types_tenant ON security_object_types(tenant_id, enforcement);

-- Security policies: the ABAC-ready rule container. A policy targets a subject
-- and an action on an object type, optionally guarded by attribute conditions.
CREATE TABLE IF NOT EXISTS security_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  scope TEXT NOT NULL DEFAULT 'object_type' CHECK (scope IN ('tenant', 'organization', 'plant', 'object_type', 'object', 'classification', 'attribute')),
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  condition_json TEXT NOT NULL DEFAULT '',
  valid_from TEXT,
  valid_to TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_security_policies_lookup ON security_policies(tenant_id, status, resource_type, action);
CREATE INDEX IF NOT EXISTS idx_security_policies_subject ON security_policies(tenant_id, subject_type, subject_id);

-- Normalized rules attached to a policy (conditions, actions, masking actions).
CREATE TABLE IF NOT EXISTS security_policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES security_policies(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL DEFAULT 'condition' CHECK (rule_type IN ('condition', 'action', 'masking')),
  field TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT 'eq',
  value_json TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  masking_strategy TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_policy_rules_policy ON security_policy_rules(policy_id, sort_order);

-- Explicit entitlements at object type or single-object granularity.
CREATE TABLE IF NOT EXISTS security_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'read',
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  scope TEXT NOT NULL DEFAULT 'object_type' CHECK (scope IN ('tenant', 'organization', 'plant', 'object_type', 'object', 'classification', 'attribute')),
  classification TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  valid_from TEXT,
  valid_to TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, subject_type, subject_id, resource_type, resource_id, action, scope, effect)
);

CREATE INDEX IF NOT EXISTS idx_security_entitlements_lookup ON security_entitlements(tenant_id, status, resource_type, action);
CREATE INDEX IF NOT EXISTS idx_security_entitlements_subject ON security_entitlements(tenant_id, subject_type, subject_id);

-- Field level security. Effects: allow (default), deny (never visible),
-- mask (visible but transformed), hide (removed from the payload).
CREATE TABLE IF NOT EXISTS security_field_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'read',
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'mask', 'hide')),
  masking_strategy TEXT NOT NULL DEFAULT '',
  masking_config_json TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, field_name, action, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_security_field_rules_lookup ON security_field_rules(tenant_id, object_type, field_name, action);

-- Classification security. Rules are matched by classification (public,
-- internal, confidential, restricted) and can be scoped to an object type.
CREATE TABLE IF NOT EXISTS security_classification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  classification TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'read',
  resource_type TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, subject_type, subject_id, classification, action, resource_type, effect)
);

CREATE INDEX IF NOT EXISTS idx_security_classification_rules_lookup ON security_classification_rules(tenant_id, classification, action);

-- Organization scoped security (own / descendants / specific / cross).
CREATE TABLE IF NOT EXISTS security_organization_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'read',
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  scope_mode TEXT NOT NULL DEFAULT 'self_and_descendants' CHECK (scope_mode IN ('own', 'self_and_descendants', 'specific', 'include_descendants', 'cross')),
  include_descendants INTEGER NOT NULL DEFAULT 1,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, subject_type, subject_id, resource_type, action, organization_id, effect)
);

CREATE INDEX IF NOT EXISTS idx_security_org_rules_lookup ON security_organization_rules(tenant_id, resource_type, action);

-- Plant scoped security.
CREATE TABLE IF NOT EXISTS security_plant_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  subject_type TEXT NOT NULL DEFAULT 'everyone' CHECK (subject_type IN ('user', 'group', 'role', 'organization', 'everyone')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'read',
  plant_id INTEGER NOT NULL REFERENCES organizations(id),
  include_descendants INTEGER NOT NULL DEFAULT 0,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, subject_type, subject_id, resource_type, action, plant_id, effect)
);

CREATE INDEX IF NOT EXISTS idx_security_plant_rules_lookup ON security_plant_rules(tenant_id, resource_type, action);

-- Reusable named masking configurations referenced by field rules / policies.
CREATE TABLE IF NOT EXISTS security_masking_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  field_name TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL CHECK (strategy IN ('HIDE', 'NULL', 'PARTIAL', 'REDACT', 'HASH', 'FIXED_MASK', 'CUSTOM')),
  config_json TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_security_masking_rules_lookup ON security_masking_rules(tenant_id, object_type, field_name);

-- Optional decision journal for the authorization debugger and monitoring.
CREATE TABLE IF NOT EXISTS security_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER,
  subject_type TEXT NOT NULL DEFAULT 'user',
  subject_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'read',
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT 'deny',
  reason TEXT NOT NULL DEFAULT 'DEFAULT_DENY',
  allowed INTEGER NOT NULL DEFAULT 0,
  organization_id INTEGER,
  plant_id INTEGER,
  classification TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_decisions_lookup ON security_decisions(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_security_decisions_subject ON security_decisions(tenant_id, user_id, created_at);

-- Cache invalidation epochs. Bumping the epoch invalidates in-process caches
-- without touching every business module.
CREATE TABLE IF NOT EXISTS security_cache_epoch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'all',
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, scope)
);

-- ============================================================================
-- P1 Data Governance & Data Quality
--
-- Centralized, reusable platform capability: business modules register their
-- data definitions (domains, objects, attributes), governance policies and
-- quality rules; this service owns evaluation, scoring, duplicate detection,
-- exceptions, remediation and history. Nothing here duplicates IAM, security,
-- events, audit, notifications, jobs or search.
-- ============================================================================

-- Governance domains: hierarchical containers for governed data.
CREATE TABLE IF NOT EXISTS dg_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  parent_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive', 'retired')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_group_id INTEGER,
  owner_organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  owner_role_id INTEGER,
  secondary_owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_group_id INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dg_domains_tenant ON dg_domains(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dg_domains_parent ON dg_domains(parent_id);

-- Ownership & stewardship assignments. A subject is accountable for a scope
-- (domain, object type or attribute); relationship is owner or steward.
CREATE TABLE IF NOT EXISTS dg_ownership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('domain', 'object', 'attribute')),
  scope_ref TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  attribute_name TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL CHECK (relationship IN ('owner', 'steward')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'organization', 'role')),
  subject_id INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_ownership_domain ON dg_ownership(tenant_id, domain_id, relationship);
CREATE INDEX IF NOT EXISTS idx_dg_ownership_scope ON dg_ownership(tenant_id, scope_type, object_type, attribute_name);
CREATE INDEX IF NOT EXISTS idx_dg_ownership_subject ON dg_ownership(tenant_id, subject_type, subject_id);

-- Governed object/attribute catalogue registered by business modules.
CREATE TABLE IF NOT EXISTS dg_catalog_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_adapter TEXT NOT NULL DEFAULT 'platform.objects',
  event_trigger INTEGER NOT NULL DEFAULT 1,
  schedule TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type)
);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_objects_domain ON dg_catalog_objects(tenant_id, domain_id, status);

CREATE TABLE IF NOT EXISTS dg_catalog_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_id INTEGER REFERENCES dg_catalog_objects(id) ON DELETE CASCADE,
  attribute_name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string',
  is_required INTEGER NOT NULL DEFAULT 0,
  reference_domain TEXT NOT NULL DEFAULT '',
  enum_values_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_attributes_object ON dg_catalog_attributes(tenant_id, object_id);

-- Data policies (versioned). The live row carries the pointer to the active
-- version; each version stores an immutable snapshot of scope + rule set.
CREATE TABLE IF NOT EXISTS dg_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  effective_from TEXT,
  effective_to TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  rule_set_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dg_policies_scope ON dg_policies(tenant_id, object_type, status);

CREATE TABLE IF NOT EXISTS dg_policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES dg_policies(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (policy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_dg_policy_versions ON dg_policy_versions(tenant_id, policy_id, version);

-- Data quality rules (versioned) + the pluggable evaluation contract.
CREATE TABLE IF NOT EXISTS dg_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  policy_id INTEGER REFERENCES dg_policies(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  attribute_name TEXT NOT NULL DEFAULT '',
  rule_type TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT 'validity',
  expression_json TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'warning',
  weight REAL NOT NULL DEFAULT 1,
  threshold_json TEXT NOT NULL DEFAULT '{}',
  execution_mode TEXT NOT NULL DEFAULT 'SYNC',
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'retired')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dg_rules_scope ON dg_rules(tenant_id, object_type, status);
CREATE INDEX IF NOT EXISTS idx_dg_rules_dimension ON dg_rules(tenant_id, dimension, status);

CREATE TABLE IF NOT EXISTS dg_rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES dg_rules(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule_id, version)
);

CREATE INDEX IF NOT EXISTS idx_dg_rule_versions ON dg_rule_versions(tenant_id, rule_id, version);

-- Configurable quality dimensions and tenant scoring/threshold settings.
CREATE TABLE IF NOT EXISTS dg_dimensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dg_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

-- Quality results (historical) and the violations that produced them.
CREATE TABLE IF NOT EXISTS dg_quality_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  plant_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_name TEXT NOT NULL DEFAULT '',
  overall_score REAL,
  quality_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  evaluation_version INTEGER NOT NULL DEFAULT 1,
  rule_count INTEGER NOT NULL DEFAULT 0,
  violation_count INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 1,
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_results_object ON dg_quality_results(tenant_id, object_type, object_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_dg_results_current ON dg_quality_results(tenant_id, is_current, quality_status);
CREATE INDEX IF NOT EXISTS idx_dg_results_domain ON dg_quality_results(tenant_id, domain_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_dg_results_score ON dg_quality_results(tenant_id, overall_score);

CREATE TABLE IF NOT EXISTS dg_quality_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  result_id INTEGER REFERENCES dg_quality_results(id) ON DELETE CASCADE,
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  rule_id INTEGER REFERENCES dg_rules(id) ON DELETE SET NULL,
  rule_code TEXT NOT NULL DEFAULT '',
  attribute_name TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL DEFAULT 'validity',
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL DEFAULT '',
  detected_value TEXT NOT NULL DEFAULT '',
  expected_value TEXT NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_violations_object ON dg_quality_violations(tenant_id, object_type, object_id, is_current);
CREATE INDEX IF NOT EXISTS idx_dg_violations_rule ON dg_quality_violations(tenant_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_dg_violations_dimension ON dg_quality_violations(tenant_id, dimension);

-- Exception management lifecycle + comments.
CREATE TABLE IF NOT EXISTS dg_quality_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exception_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  plant_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  attribute_name TEXT NOT NULL DEFAULT '',
  rule_id INTEGER REFERENCES dg_rules(id) ON DELETE SET NULL,
  rule_code TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL DEFAULT 'validity',
  severity TEXT NOT NULL DEFAULT 'warning',
  priority TEXT NOT NULL DEFAULT 'normal',
  description TEXT NOT NULL DEFAULT '',
  detected_value TEXT NOT NULL DEFAULT '',
  expected_value TEXT NOT NULL DEFAULT '',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_group_id INTEGER,
  assignee_organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  sla_hours INTEGER,
  due_date TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  resolution TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT,
  waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  waived_at TEXT,
  waiver_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_exceptions_status ON dg_quality_exceptions(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_dg_exceptions_object ON dg_quality_exceptions(tenant_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_dg_exceptions_assignee ON dg_quality_exceptions(tenant_id, assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_dg_exceptions_due ON dg_quality_exceptions(tenant_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_dg_exceptions_domain ON dg_quality_exceptions(tenant_id, domain_id, status);

CREATE TABLE IF NOT EXISTS dg_exception_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  exception_id INTEGER NOT NULL REFERENCES dg_quality_exceptions(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL DEFAULT '',
  status_change TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_exception_comments ON dg_exception_comments(tenant_id, exception_id, created_at);

-- Duplicate detection: match rules (configuration) and candidate findings.
CREATE TABLE IF NOT EXISTS dg_duplicate_match_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '[]',
  strategy TEXT NOT NULL DEFAULT 'normalized',
  threshold REAL NOT NULL DEFAULT 1,
  normalization_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dg_dup_rules_object ON dg_duplicate_match_rules(tenant_id, object_type, status);

CREATE TABLE IF NOT EXISTS dg_duplicate_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  matched_object_id TEXT NOT NULL DEFAULT '',
  matched_object_name TEXT NOT NULL DEFAULT '',
  match_rule_id INTEGER REFERENCES dg_duplicate_match_rules(id) ON DELETE SET NULL,
  strategy TEXT NOT NULL DEFAULT 'normalized',
  score REAL NOT NULL DEFAULT 1,
  match_type TEXT NOT NULL DEFAULT 'POTENTIAL',
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, object_id, matched_object_id, match_rule_id)
);

CREATE INDEX IF NOT EXISTS idx_dg_dup_candidates_object ON dg_duplicate_candidates(tenant_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_dg_dup_candidates_status ON dg_duplicate_candidates(tenant_id, status, detected_at);

-- Remediation actions with before/after values and approval trail.
CREATE TABLE IF NOT EXISTS dg_remediations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  exception_id INTEGER REFERENCES dg_quality_exceptions(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL DEFAULT 'SET_ATTRIBUTE',
  attribute_name TEXT NOT NULL DEFAULT '',
  before_value TEXT NOT NULL DEFAULT '',
  after_value TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'applied',
  message TEXT NOT NULL DEFAULT '',
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_remediations_object ON dg_remediations(tenant_id, object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dg_remediations_exception ON dg_remediations(tenant_id, exception_id);

-- Quality job tracking (batch / scheduled / event-driven runs).
CREATE TABLE IF NOT EXISTS dg_quality_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  mode TEXT NOT NULL DEFAULT 'BATCH',
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  job_ref TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dg_quality_jobs_tenant ON dg_quality_jobs(tenant_id, status, created_at);

-- ============================================================================
-- Data Catalog & Business Glossary (migration 029)
--
-- Centralized governance metadata layer: catalog entries (domains, objects,
-- attributes, terms, sources, consumers), the business glossary, mappings,
-- lineage, classifications, ownership and metadata versioning. It REFERENCES
-- the centralized domain model (dg_domains) and reuses IAM, security, search,
-- events, audit, jobs, notifications, workflow and the data quality engine.
-- It never stores the underlying business data.
-- ============================================================================

-- Unified registry of every catalog asset. Type-specific tables hold the
-- detail; this registry powers the unified catalog list, classification,
-- ownership and lineage so those features do not need N joins per asset type.
CREATE TABLE IF NOT EXISTS dc_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('DOMAIN', 'OBJECT', 'ATTRIBUTE', 'BUSINESS_TERM', 'SOURCE', 'CONSUMER', 'CLASSIFICATION', 'LINEAGE')),
  subject_table TEXT NOT NULL DEFAULT '',
  subject_id INTEGER,
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  source_id INTEGER,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'internal',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_group_id INTEGER,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_group_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, entry_type, code)
);

CREATE INDEX IF NOT EXISTS idx_dc_entries_tenant ON dc_entries(tenant_id, entry_type, status);
CREATE INDEX IF NOT EXISTS idx_dc_entries_domain ON dc_entries(tenant_id, domain_id);
CREATE INDEX IF NOT EXISTS idx_dc_entries_subject ON dc_entries(tenant_id, subject_table, subject_id);
CREATE INDEX IF NOT EXISTS idx_dc_entries_classification ON dc_entries(tenant_id, classification);

-- Catalog metadata version history. Every governance mutation appends a
-- snapshot; current state lives on the entry row, history is never overwritten.
CREATE TABLE IF NOT EXISTS dc_metadata_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER NOT NULL REFERENCES dc_entries(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, version)
);

CREATE INDEX IF NOT EXISTS idx_dc_metadata_versions_entry ON dc_metadata_versions(tenant_id, entry_id, version);

-- Catalog data objects: metadata about an enterprise object type. The catalog
-- references existing business objects (target_object_type/target_object_ref);
-- it does not duplicate their storage.
CREATE TABLE IF NOT EXISTS dc_catalog_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  source_id INTEGER,
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type)
);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_domain ON dc_catalog_objects(tenant_id, domain_id, status);
CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_ref ON dc_catalog_objects(tenant_id, object_ref);

CREATE TABLE IF NOT EXISTS dc_catalog_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  object_id INTEGER NOT NULL REFERENCES dc_catalog_objects(id) ON DELETE CASCADE,
  attribute_name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string',
  mandatory INTEGER NOT NULL DEFAULT 0,
  business_definition TEXT NOT NULL DEFAULT '',
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  source_id INTEGER,
  classification TEXT NOT NULL DEFAULT 'internal',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_object ON dc_catalog_attributes(tenant_id, object_id, status);
CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_ref ON dc_catalog_attributes(tenant_id, attribute_ref);

-- Business glossary: terms are business concepts, not technical objects.
CREATE TABLE IF NOT EXISTS dc_business_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  preferred_name TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  domain_id INTEGER REFERENCES dg_domains(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'active', 'deprecated', 'retired')),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'in_review', 'approved', 'rejected')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_group_id INTEGER,
  steward_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  steward_group_id INTEGER,
  classification TEXT NOT NULL DEFAULT 'internal',
  version INTEGER NOT NULL DEFAULT 1,
  workflow_instance_id INTEGER,
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_domain ON dc_business_terms(tenant_id, domain_id, status);
CREATE INDEX IF NOT EXISTS idx_dc_business_terms_status ON dc_business_terms(tenant_id, status, approval_status);

CREATE TABLE IF NOT EXISTS dc_term_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  term_id INTEGER NOT NULL REFERENCES dc_business_terms(id) ON DELETE CASCADE,
  definition_type TEXT NOT NULL CHECK (definition_type IN ('BUSINESS', 'TECHNICAL', 'OPERATIONAL', 'CALCULATION')),
  definition TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, definition_type)
);

CREATE TABLE IF NOT EXISTS dc_term_synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  term_id INTEGER NOT NULL REFERENCES dc_business_terms(id) ON DELETE CASCADE,
  synonym TEXT NOT NULL,
  synonym_type TEXT NOT NULL DEFAULT 'SYNONYM' CHECK (synonym_type IN ('SYNONYM', 'ABBREVIATION', 'ACRONYM', 'ALIAS', 'DEPRECATED')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, synonym)
);

CREATE INDEX IF NOT EXISTS idx_dc_term_synonyms_term ON dc_term_synonyms(tenant_id, term_id);

CREATE TABLE IF NOT EXISTS dc_term_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  term_id INTEGER NOT NULL REFERENCES dc_business_terms(id) ON DELETE CASCADE,
  related_term_id INTEGER NOT NULL REFERENCES dc_business_terms(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('RELATED_TO', 'BROADER_THAN', 'NARROWER_THAN', 'SYNONYM_OF', 'ABBREVIATION_OF', 'CONTAINS', 'DERIVED_FROM')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, related_term_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_dc_term_relations_term ON dc_term_relations(tenant_id, term_id);

-- Many-to-many mappings from terms to catalog objects, attributes, domains,
-- sources and consumers.
CREATE TABLE IF NOT EXISTS dc_term_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  term_id INTEGER NOT NULL REFERENCES dc_business_terms(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('OBJECT', 'ATTRIBUTE', 'DOMAIN', 'SOURCE', 'CONSUMER')),
  target_id INTEGER NOT NULL,
  target_ref TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_dc_term_mappings_target ON dc_term_mappings(tenant_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_dc_term_mappings_term ON dc_term_mappings(tenant_id, term_id);

-- Configurable catalog relationship types (data-driven, not hard-coded).
CREATE TABLE IF NOT EXISTS dc_relationship_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_entry_type TEXT NOT NULL DEFAULT '',
  target_entry_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dc_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  relationship_type_id INTEGER NOT NULL REFERENCES dc_relationship_types(id) ON DELETE CASCADE,
  from_entry_id INTEGER NOT NULL REFERENCES dc_entries(id) ON DELETE CASCADE,
  to_entry_id INTEGER NOT NULL REFERENCES dc_entries(id) ON DELETE CASCADE,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, relationship_type_id, from_entry_id, to_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_dc_relationships_from ON dc_relationships(tenant_id, from_entry_id);
CREATE INDEX IF NOT EXISTS idx_dc_relationships_to ON dc_relationships(tenant_id, to_entry_id);

-- Data sources. Credentials are NEVER stored here; connection_reference points
-- at the Integration/API credential model.
CREATE TABLE IF NOT EXISTS dc_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'APPLICATION' CHECK (source_type IN ('APPLICATION', 'DATABASE', 'API', 'FILE', 'DATA_LAKE', 'DATA_WAREHOUSE', 'EXTERNAL_SYSTEM')),
  description TEXT NOT NULL DEFAULT '',
  system TEXT NOT NULL DEFAULT '',
  connection_reference TEXT NOT NULL DEFAULT '',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dc_sources_type ON dc_sources(tenant_id, source_type, status);

-- Source-to-target object mappings. The catalog stores the metadata; the
-- Integration Framework owns any actual transformation.
CREATE TABLE IF NOT EXISTS dc_source_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  source_id INTEGER NOT NULL REFERENCES dc_sources(id) ON DELETE CASCADE,
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_ref TEXT NOT NULL DEFAULT '',
  target_entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  mapping_type TEXT NOT NULL DEFAULT 'SOURCE_TO_OBJECT' CHECK (mapping_type IN ('SOURCE_TO_OBJECT', 'OBJECT_TO_CONSUMER', 'RENAME', 'TRANSFORM', 'ENRICH', 'AGGREGATE', 'SPLIT', 'MERGE')),
  transformation_reference TEXT NOT NULL DEFAULT '',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  effective_date TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_source ON dc_source_mappings(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_target ON dc_source_mappings(tenant_id, target_entry_id);

-- Data consumers (systems, services and people that read catalog data).
CREATE TABLE IF NOT EXISTS dc_consumers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER REFERENCES dc_entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  consumer_type TEXT NOT NULL DEFAULT 'APPLICATION',
  description TEXT NOT NULL DEFAULT '',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dc_consumers_type ON dc_consumers(tenant_id, consumer_type, status);

CREATE TABLE IF NOT EXISTS dc_consumer_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  consumer_id INTEGER NOT NULL REFERENCES dc_consumers(id) ON DELETE CASCADE,
  object_id INTEGER REFERENCES dc_catalog_objects(id) ON DELETE CASCADE,
  attribute_id INTEGER REFERENCES dc_catalog_attributes(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_consumer ON dc_consumer_mappings(tenant_id, consumer_id);
CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_object ON dc_consumer_mappings(tenant_id, object_id);

-- Metadata-level lineage. Endpoints are typed subjects (entry refs or external
-- object refs). The catalog stores metadata only; Integration can publish
-- lineage events. Traversal is bounded by depth and node limits.
CREATE TABLE IF NOT EXISTS dc_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_ref TEXT NOT NULL DEFAULT '',
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_ref TEXT NOT NULL DEFAULT '',
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('SOURCE_OF', 'DERIVED_FROM', 'TRANSFORMED_FROM', 'SENT_TO', 'CONSUMED_BY', 'COPIED_TO', 'AGGREGATED_FROM')),
  transformation_reference TEXT NOT NULL DEFAULT '',
  job_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_from TEXT,
  effective_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, from_type, from_id, to_type, to_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_dc_lineage_from ON dc_lineage(tenant_id, from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_dc_lineage_to ON dc_lineage(tenant_id, to_type, to_id);

-- Catalog classifications: business categories optionally bound to a security
-- classification from the P0 Data Security model.
CREATE TABLE IF NOT EXISTS dc_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  classification_ref TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'business',
  security_classification TEXT NOT NULL DEFAULT 'internal' CHECK (security_classification IN ('public', 'internal', 'confidential', 'restricted')),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dc_classification_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER NOT NULL REFERENCES dc_entries(id) ON DELETE CASCADE,
  classification_id INTEGER REFERENCES dc_classifications(id) ON DELETE SET NULL,
  classification_code TEXT NOT NULL DEFAULT '',
  security_classification TEXT NOT NULL DEFAULT 'internal',
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, entry_id, classification_code)
);

CREATE INDEX IF NOT EXISTS idx_dc_classification_assignments_entry ON dc_classification_assignments(tenant_id, entry_id);

-- Ownership & stewardship. Four kinds per the spec: Data Owner, Data Steward,
-- Technical Owner, Business Owner. Subjects are IAM principals or org units.
CREATE TABLE IF NOT EXISTS dc_ownership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  entry_id INTEGER NOT NULL REFERENCES dc_entries(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('owner', 'steward')),
  ownership_kind TEXT NOT NULL DEFAULT 'DATA_OWNER' CHECK (ownership_kind IN ('DATA_OWNER', 'DATA_STEWARD', 'TECHNICAL_OWNER', 'BUSINESS_OWNER')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'role', 'organization')),
  subject_id INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dc_ownership_entry ON dc_ownership(tenant_id, entry_id, relationship);
CREATE INDEX IF NOT EXISTS idx_dc_ownership_subject ON dc_ownership(tenant_id, subject_type, subject_id);

-- Controlled metadata import runs (CSV / JSON / XLSX via Integration transfers).
CREATE TABLE IF NOT EXISTS dc_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  resource_type TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'csv',
  status TEXT NOT NULL DEFAULT 'pending',
  dry_run INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '[]',
  transfer_ref TEXT NOT NULL DEFAULT '',
  job_ref TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dc_import_runs_tenant ON dc_import_runs(tenant_id, status, created_at);

-- Tenant-scoped catalog configuration. Values are data so traversal bounds,
-- import batch sizes and approval requirements can change without a deployment.
CREATE TABLE IF NOT EXISTS dc_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_dc_configuration_tenant ON dc_configuration(tenant_id, key);

-- ── Data Lifecycle & Archival ────────────────────────────────────────────────
-- Centralized lifecycle of actual enterprise/business data: states, retention
-- policies, legal holds, archive/cold-storage/restore/recovery/purge, tiers and
-- lifecycle history. This is deliberately independent from the Audit & History
-- retention engine: Audit keeps controlling audit records; this service owns
-- business-data lifecycle. All tables are tenant scoped.

-- Configurable lifecycle state model. System states are seeded per tenant and
-- carry the capability matrix the service and UI consult.
CREATE TABLE IF NOT EXISTS lc_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  read_allowed INTEGER NOT NULL DEFAULT 1,
  update_allowed INTEGER NOT NULL DEFAULT 0,
  delete_allowed INTEGER NOT NULL DEFAULT 0,
  restore_allowed INTEGER NOT NULL DEFAULT 0,
  export_allowed INTEGER NOT NULL DEFAULT 0,
  archive_eligible INTEGER NOT NULL DEFAULT 0,
  purge_eligible INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lc_states_tenant ON lc_states(tenant_id, sequence);

-- Policy-controlled transition graph. The service refuses any transition that is
-- not declared here (and legal holds can block declared transitions too).
CREATE TABLE IF NOT EXISTS lc_state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'CHANGE_STATE',
  description TEXT NOT NULL DEFAULT '',
  requires_legal_hold_clear INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, from_state, to_state, action)
);

CREATE INDEX IF NOT EXISTS idx_lc_transitions_tenant ON lc_state_transitions(tenant_id, from_state);

-- Retention / archive / purge policies. A policy declares the scope dimensions
-- (org, object type, subtype, classification, lifecycle state), the retention
-- anchor and period, and the actions to take at each stage.
CREATE TABLE IF NOT EXISTS lc_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT 'TENANT' CHECK (scope_type IN ('PLATFORM', 'TENANT', 'ORGANIZATION', 'OBJECT_TYPE', 'OBJECT')),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  plant_id INTEGER,
  object_type TEXT NOT NULL DEFAULT '',
  subtype TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  retention_period_days INTEGER NOT NULL DEFAULT 0,
  retention_basis TEXT NOT NULL DEFAULT 'LAST_MODIFIED_DATE',
  archive_action TEXT NOT NULL DEFAULT 'MARK_ELIGIBLE',
  cold_storage_action TEXT NOT NULL DEFAULT 'MARK_ELIGIBLE',
  purge_action TEXT NOT NULL DEFAULT 'MARK_ELIGIBLE',
  archive_after_days INTEGER NOT NULL DEFAULT 0,
  cold_storage_after_days INTEGER NOT NULL DEFAULT 0,
  purge_after_days INTEGER NOT NULL DEFAULT 0,
  data_tier TEXT NOT NULL DEFAULT 'HOT',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  effective_from TEXT,
  effective_to TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lc_policies_resolve ON lc_policies(tenant_id, status, object_type, organization_id, priority);
CREATE INDEX IF NOT EXISTS idx_lc_policies_scope ON lc_policies(tenant_id, scope_type, lifecycle_state);

-- Immutable policy versions. Editing an active policy snapshots the prior state
-- so change control is preserved.
CREATE TABLE IF NOT EXISTS lc_policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES lc_policies(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (policy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_lc_policy_versions_policy ON lc_policy_versions(policy_id, version);

-- State -> data tier mapping, decoupled from lifecycle state so physical storage
-- can differ from logical state where required.
CREATE TABLE IF NOT EXISTS lc_tier_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  state_code TEXT NOT NULL,
  data_tier TEXT NOT NULL CHECK (data_tier IN ('HOT', 'WARM', 'ARCHIVE', 'COLD')),
  description TEXT NOT NULL DEFAULT '',
  system INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, state_code)
);

CREATE INDEX IF NOT EXISTS idx_lc_tier_policies_tenant ON lc_tier_policies(tenant_id, state_code);

-- One row per tracked business object. This is the lifecycle ledger; it stores
-- metadata only and never a copy of business data (archives do that).
CREATE TABLE IF NOT EXISTS lc_object_lifecycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  plant_id INTEGER,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_ref TEXT NOT NULL DEFAULT '',
  current_state TEXT NOT NULL DEFAULT 'ACTIVE',
  previous_state TEXT,
  data_tier TEXT NOT NULL DEFAULT 'HOT',
  retention_policy_id INTEGER REFERENCES lc_policies(id) ON DELETE SET NULL,
  retention_anchor TEXT,
  retention_basis TEXT,
  retention_start TEXT,
  archive_eligible_at TEXT,
  cold_storage_at TEXT,
  purge_eligible_at TEXT,
  legal_hold_status TEXT NOT NULL DEFAULT 'NONE',
  classification TEXT NOT NULL DEFAULT 'internal',
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  purged_at TEXT,
  last_evaluated_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_lc_object_tenant_type ON lc_object_lifecycle(tenant_id, object_type);
CREATE INDEX IF NOT EXISTS idx_lc_object_object ON lc_object_lifecycle(tenant_id, object_id);
CREATE INDEX IF NOT EXISTS idx_lc_object_state ON lc_object_lifecycle(tenant_id, current_state);
CREATE INDEX IF NOT EXISTS idx_lc_object_tier ON lc_object_lifecycle(tenant_id, data_tier);
CREATE INDEX IF NOT EXISTS idx_lc_object_archive_at ON lc_object_lifecycle(tenant_id, archive_eligible_at);
CREATE INDEX IF NOT EXISTS idx_lc_object_purge_at ON lc_object_lifecycle(tenant_id, purge_eligible_at);
CREATE INDEX IF NOT EXISTS idx_lc_object_hold ON lc_object_lifecycle(tenant_id, legal_hold_status);
CREATE INDEX IF NOT EXISTS idx_lc_object_org ON lc_object_lifecycle(tenant_id, organization_id);

-- Immutable lifecycle history. Every transition and operation appends here.
CREATE TABLE IF NOT EXISTS lc_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  data_tier TEXT,
  policy_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lc_history_object ON lc_history(tenant_id, object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lc_history_action ON lc_history(tenant_id, action, created_at);

-- Legal holds. A hold blocks archive/purge/deletion where policy requires it, and
-- always overrides purge eligibility.
CREATE TABLE IF NOT EXISTS lc_legal_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT 'OBJECT' CHECK (scope_type IN ('OBJECT', 'OBJECT_TYPE', 'OBJECT_SET', 'ORGANIZATION', 'PLANT', 'CLASSIFICATION', 'BUSINESS_DOMAIN')),
  object_type TEXT NOT NULL DEFAULT '',
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  plant_id INTEGER,
  classification TEXT NOT NULL DEFAULT '',
  business_domain TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED', 'EXPIRED')),
  start_date TEXT,
  end_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  released_at TEXT,
  release_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_lc_legal_holds_scope ON lc_legal_holds(tenant_id, status, scope_type, object_type);
CREATE INDEX IF NOT EXISTS idx_lc_legal_holds_org ON lc_legal_holds(tenant_id, status, organization_id);

-- Explicit object scope for a legal hold (bounded, indexed).
CREATE TABLE IF NOT EXISTS lc_legal_hold_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES lc_legal_holds(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (hold_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_lc_hold_objects_lookup ON lc_legal_hold_objects(tenant_id, object_type, object_id);

-- Rule-based scopes evaluated by query, so millions of ids are never loaded.
CREATE TABLE IF NOT EXISTS lc_legal_hold_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES lc_legal_holds(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lc_hold_scopes_lookup ON lc_legal_hold_scopes(tenant_id, scope_type, scope_value);

-- Archive records: the durable evidence an object version was packaged and
-- stored, with the integrity checksum. Idempotent on object + version + key.
CREATE TABLE IF NOT EXISTS lc_archive_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_ref TEXT NOT NULL DEFAULT '',
  object_version INTEGER,
  policy_id INTEGER,
  state_at_archive TEXT NOT NULL DEFAULT '',
  data_tier TEXT NOT NULL DEFAULT 'ARCHIVE',
  provider_code TEXT NOT NULL DEFAULT 'database',
  provider_type TEXT NOT NULL DEFAULT 'DATABASE',
  storage_uri TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'failed', 'restored', 'purged')),
  idempotency_key TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lc_archive_object ON lc_archive_records(tenant_id, object_type, object_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lc_archive_idem ON lc_archive_records(tenant_id, idempotency_key) WHERE idempotency_key <> '';

-- Local database-backed archive payload store (development/testing provider).
-- Production providers (object storage, cloud archive) replace this behind the
-- same provider interface without touching business modules.
CREATE TABLE IF NOT EXISTS lc_archive_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  storage_uri TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (storage_uri)
);

CREATE INDEX IF NOT EXISTS idx_lc_archive_blobs_tenant ON lc_archive_blobs(tenant_id, storage_uri);

-- Restore orchestration records.
CREATE TABLE IF NOT EXISTS lc_restore_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restore_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  archive_id INTEGER REFERENCES lc_archive_records(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_ref TEXT NOT NULL DEFAULT '',
  target_state TEXT NOT NULL DEFAULT 'INACTIVE',
  conflict_strategy TEXT NOT NULL DEFAULT 'FAIL',
  conflict_detected INTEGER NOT NULL DEFAULT 0,
  conflict_json TEXT NOT NULL DEFAULT '{}',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'completed', 'failed', 'skipped')),
  idempotency_key TEXT NOT NULL DEFAULT '',
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  UNIQUE (tenant_id, restore_ref)
);

CREATE INDEX IF NOT EXISTS idx_lc_restore_object ON lc_restore_records(tenant_id, object_type, object_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lc_restore_idem ON lc_restore_records(tenant_id, idempotency_key) WHERE idempotency_key <> '';

-- Recovery framework records (recover after failure/corruption/storage loss).
CREATE TABLE IF NOT EXISTS lc_recovery_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recovery_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  provider_code TEXT NOT NULL DEFAULT 'database',
  recovery_point_ref TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'completed', 'failed')),
  details_json TEXT NOT NULL DEFAULT '{}',
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  UNIQUE (tenant_id, recovery_ref)
);

CREATE INDEX IF NOT EXISTS idx_lc_recovery_tenant ON lc_recovery_records(tenant_id, status, requested_at);

-- Purge records. Purge is the most restricted operation and always carries the
-- eligibility snapshot that authorized it.
CREATE TABLE IF NOT EXISTS lc_purge_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purge_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_ref TEXT NOT NULL DEFAULT '',
  policy_id INTEGER,
  archive_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  eligibility_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'executed' CHECK (status IN ('executed', 'failed', 'denied')),
  idempotency_key TEXT NOT NULL DEFAULT '',
  executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lc_purge_object ON lc_purge_records(tenant_id, object_type, object_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lc_purge_idem ON lc_purge_records(tenant_id, idempotency_key) WHERE idempotency_key <> '';

-- Lifecycle job ledger. Mirrors the platform job engine status for lifecycle
-- operations, with per-object success/failure/error counters.
CREATE TABLE IF NOT EXISTS lc_lifecycle_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  priority TEXT NOT NULL DEFAULT 'normal',
  object_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  platform_job_id INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, job_ref)
);

CREATE INDEX IF NOT EXISTS idx_lc_jobs_tenant ON lc_lifecycle_jobs(tenant_id, status, created_at);

-- Dependency snapshot used for pre-archive/purge checks. Populated from the
-- Object & Relationship Framework; never a parallel relationship engine.
CREATE TABLE IF NOT EXISTS lc_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  depends_on_type TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT '',
  blocking INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  details_json TEXT NOT NULL DEFAULT '{}',
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lc_dependencies_object ON lc_dependencies(tenant_id, object_type, object_id, status);

-- Tenant-scoped lifecycle configuration. Bounds and gates are data, not code.
CREATE TABLE IF NOT EXISTS lc_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_lc_configuration_tenant ON lc_configuration(tenant_id, key);

-- ─────────────────────────────────────────────────────────────────────────────
-- Import / Export Framework (data-exchange)
--
-- The single reusable enterprise data-movement layer. Business modules declare
-- what data moves, its mappings, transformations and validations; this schema
-- owns transport, parsing, orchestration, reconciliation and history. It never
-- stores a copy of business data and never stores raw external credentials.
-- ─────────────────────────────────────────────────────────────────────────────

-- Reusable source/destination connector configuration (no secrets inline).
CREATE TABLE IF NOT EXISTS ie_connector_configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  connector_type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'SOURCE' CHECK (direction IN ('SOURCE', 'DESTINATION', 'BOTH')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  credential_ref_id INTEGER,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_ie_connector_config_tenant ON ie_connector_configurations(tenant_id, connector_type, status);

-- Reference to a secret held by the platform secret store. The secret value is
-- never written here; only an opaque reference and metadata are persisted.
CREATE TABLE IF NOT EXISTS ie_connector_credential_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  credential_type TEXT NOT NULL DEFAULT 'TOKEN',
  secret_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

-- ── Import definitions & versions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_import_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL,
  target_subtype TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'CSV',
  connector_config_id INTEGER REFERENCES ie_connector_configurations(id) ON DELETE SET NULL,
  source_config_json TEXT NOT NULL DEFAULT '{}',
  mapping_json TEXT NOT NULL DEFAULT '{}',
  transformation_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  duplicate_strategy TEXT NOT NULL DEFAULT 'REJECT',
  duplicate_key_json TEXT NOT NULL DEFAULT '{}',
  batch_size INTEGER NOT NULL DEFAULT 500,
  error_strategy TEXT NOT NULL DEFAULT 'CONTINUE',
  reconciliation_strategy TEXT NOT NULL DEFAULT 'COUNT',
  transaction_strategy TEXT NOT NULL DEFAULT 'PER_BATCH',
  mode TEXT NOT NULL DEFAULT 'IMPORT',
  template_id INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DEPRECATED')),
  version INTEGER NOT NULL DEFAULT 1,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  catalog_refs_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_ie_import_def_tenant ON ie_import_definitions(tenant_id, status, target_object_type);

CREATE TABLE IF NOT EXISTS ie_import_definition_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_import_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ie_import_ver_definition ON ie_import_definition_versions(definition_id, version);

CREATE TABLE IF NOT EXISTS ie_import_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_import_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  source_field TEXT NOT NULL,
  target_field TEXT NOT NULL,
  mapping_type TEXT NOT NULL DEFAULT 'DIRECT',
  data_type TEXT NOT NULL DEFAULT 'string',
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  constant_value TEXT,
  expression TEXT NOT NULL DEFAULT '',
  lookup_json TEXT NOT NULL DEFAULT '{}',
  condition_json TEXT NOT NULL DEFAULT '{}',
  concat_json TEXT NOT NULL DEFAULT '[]',
  split_json TEXT NOT NULL DEFAULT '{}',
  nested_json TEXT NOT NULL DEFAULT '{}',
  transform_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_mapping_def ON ie_import_mappings(definition_id, sequence);

CREATE TABLE IF NOT EXISTS ie_import_transformations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_import_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'FIELD',
  target_field TEXT NOT NULL DEFAULT '',
  transformation_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_transform_def ON ie_import_transformations(definition_id, sequence);

CREATE TABLE IF NOT EXISTS ie_import_validation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_import_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'FIELD',
  target_field TEXT NOT NULL DEFAULT '',
  rule_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR', 'WARNING', 'INFO')),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_rule_def ON ie_import_validation_rules(definition_id, sequence);

-- ── Import execution ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  definition_id INTEGER REFERENCES ie_import_definitions(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'IMPORT',
  duplicate_strategy TEXT NOT NULL DEFAULT 'REJECT',
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'VALIDATING', 'PREVIEW', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  total_records INTEGER NOT NULL DEFAULT 0,
  processed_records INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 500,
  source_json TEXT NOT NULL DEFAULT '{}',
  mapping_json TEXT NOT NULL DEFAULT '{}',
  transformation_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  options_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  platform_job_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_jobs_tenant ON ie_import_jobs(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ie_import_jobs_def ON ie_import_jobs(definition_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ie_import_jobs_idem ON ie_import_jobs(tenant_id, idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS ie_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_import_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  batch_number INTEGER NOT NULL,
  start_record INTEGER NOT NULL DEFAULT 0,
  end_record INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_ie_import_batches_job ON ie_import_batches(job_id, batch_number);

CREATE TABLE IF NOT EXISTS ie_import_record_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_import_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  batch_number INTEGER NOT NULL DEFAULT 0,
  record_number INTEGER NOT NULL,
  business_key TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'CREATE' CHECK (action IN ('CREATE', 'UPDATE', 'SKIP', 'REJECT', 'FAIL', 'WARNING')),
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'WARNING', 'ERROR', 'SKIPPED', 'FAILED')),
  target_object_type TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  source_json TEXT NOT NULL DEFAULT '{}',
  mapped_json TEXT NOT NULL DEFAULT '{}',
  transformed_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_results_job ON ie_import_record_results(job_id, record_number);
CREATE INDEX IF NOT EXISTS idx_ie_import_results_status ON ie_import_record_results(job_id, status);

CREATE TABLE IF NOT EXISTS ie_import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_import_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  batch_number INTEGER NOT NULL DEFAULT 0,
  record_number INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL,
  error_type TEXT NOT NULL DEFAULT 'RECORD',
  message TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL DEFAULT '',
  object_ref TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0,
  suggested_resolution TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_errors_job ON ie_import_errors(job_id, error_code);
CREATE INDEX IF NOT EXISTS idx_ie_import_errors_retry ON ie_import_errors(job_id, retryable, resolved);

CREATE TABLE IF NOT EXISTS ie_import_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_import_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  checkpoint_number INTEGER NOT NULL DEFAULT 1,
  last_record INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, checkpoint_number)
);

CREATE INDEX IF NOT EXISTS idx_ie_import_checkpoints_job ON ie_import_checkpoints(job_id, checkpoint_number);

CREATE TABLE IF NOT EXISTS ie_import_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_import_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  strategy TEXT NOT NULL DEFAULT 'COUNT',
  source_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  target_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  variance INTEGER NOT NULL DEFAULT 0,
  reconciliation_percent REAL NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'VARIANCE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id)
);

CREATE TABLE IF NOT EXISTS ie_import_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  job_id INTEGER REFERENCES ie_import_jobs(id) ON DELETE SET NULL,
  definition_id INTEGER REFERENCES ie_import_definitions(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  total_records INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_import_history_tenant ON ie_import_history(tenant_id, created_at);

-- ── Export definitions & versions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_export_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '[]',
  filters_json TEXT NOT NULL DEFAULT '[]',
  sort_json TEXT NOT NULL DEFAULT '[]',
  transformation_json TEXT NOT NULL DEFAULT '{}',
  format TEXT NOT NULL DEFAULT 'CSV',
  destination TEXT NOT NULL DEFAULT 'DOWNLOAD',
  destination_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  security_json TEXT NOT NULL DEFAULT '{}',
  catalog_refs_json TEXT NOT NULL DEFAULT '{}',
  max_records INTEGER NOT NULL DEFAULT 100000,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DEPRECATED')),
  version INTEGER NOT NULL DEFAULT 1,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_ie_export_def_tenant ON ie_export_definitions(tenant_id, status, object_type);

CREATE TABLE IF NOT EXISTS ie_export_definition_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_export_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE TABLE IF NOT EXISTS ie_export_field_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_export_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  field_path TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string',
  transformation_json TEXT NOT NULL DEFAULT '[]',
  nested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_fields_def ON ie_export_field_selections(definition_id, sequence);

CREATE TABLE IF NOT EXISTS ie_export_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_export_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  filter_type TEXT NOT NULL DEFAULT 'ATTRIBUTE',
  field TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT 'eq',
  value_json TEXT NOT NULL DEFAULT 'null',
  conjunction TEXT NOT NULL DEFAULT 'AND',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_filters_def ON ie_export_filters(definition_id, sequence);

CREATE TABLE IF NOT EXISTS ie_export_transformations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES ie_export_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  field_path TEXT NOT NULL,
  transformation_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_transform_def ON ie_export_transformations(definition_id, sequence);

-- ── Export execution ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  definition_id INTEGER REFERENCES ie_export_definitions(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  object_type TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'CSV',
  destination TEXT NOT NULL DEFAULT 'DOWNLOAD',
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')),
  record_count INTEGER NOT NULL DEFAULT 0,
  exported_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  output_size INTEGER NOT NULL DEFAULT 0,
  output_uri TEXT NOT NULL DEFAULT '',
  output_filename TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  filters_json TEXT NOT NULL DEFAULT '[]',
  fields_json TEXT NOT NULL DEFAULT '[]',
  transformation_json TEXT NOT NULL DEFAULT '{}',
  destination_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  platform_job_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_jobs_tenant ON ie_export_jobs(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ie_export_jobs_def ON ie_export_jobs(definition_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ie_export_jobs_idem ON ie_export_jobs(tenant_id, idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS ie_export_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES ie_export_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  result_ref TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'CSV',
  storage_uri TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  record_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'EXPIRED', 'DELETED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_results_job ON ie_export_results(job_id);

CREATE TABLE IF NOT EXISTS ie_export_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  job_id INTEGER REFERENCES ie_export_jobs(id) ON DELETE SET NULL,
  definition_id INTEGER REFERENCES ie_export_definitions(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  record_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ie_export_history_tenant ON ie_export_history(tenant_id, created_at);

-- ── Templates ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'IMPORT' CHECK (direction IN ('IMPORT', 'EXPORT')),
  object_type TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DEPRECATED')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code, version)
);

CREATE INDEX IF NOT EXISTS idx_ie_templates_tenant ON ie_templates(tenant_id, direction, code);

-- ── Stored payloads (database provider) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  storage_uri TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, storage_uri)
);

CREATE INDEX IF NOT EXISTS idx_ie_blobs_tenant ON ie_blobs(tenant_id, storage_uri);

-- ── Tenant configuration ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ie_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_ie_configuration_tenant ON ie_configuration(tenant_id, key);

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration & Onboarding Framework (P1)
--
-- A first-class, dependency-aware onboarding capability for large-scale legacy
-- migrations. It reuses the shared data-movement engines (connectors, mapping,
-- transformation, validation) from the Import/Export Framework but owns its own
-- projects, packages, dependency graph, planning, identifier mapping,
-- checkpoints, reconciliation and migration audit.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mig_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT '',
  source_version TEXT NOT NULL DEFAULT '',
  target_platform_version TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PLANNED','READY','RUNNING','PAUSED','COMPLETED','PARTIALLY_COMPLETED','FAILED','CANCELLED','ARCHIVED')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_date TEXT,
  end_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_mig_projects_tenant ON mig_projects(tenant_id, status);

CREATE TABLE IF NOT EXISTS mig_project_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES mig_projects(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS mig_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_ref TEXT NOT NULL DEFAULT '',
  project_id INTEGER NOT NULL REFERENCES mig_projects(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  source_object_type TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  source_json TEXT NOT NULL DEFAULT '{}',
  scope_json TEXT NOT NULL DEFAULT '{}',
  mapping_json TEXT NOT NULL DEFAULT '{}',
  transformation_json TEXT NOT NULL DEFAULT '[]',
  validation_json TEXT NOT NULL DEFAULT '[]',
  dependency_json TEXT NOT NULL DEFAULT '[]',
  duplicate_strategy TEXT NOT NULL DEFAULT 'REJECT',
  execution_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','BLOCKED','RUNNING','PAUSED','COMPLETED','PARTIALLY_COMPLETED','FAILED','CANCELLED')),
  statistics_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, code)
);

CREATE INDEX IF NOT EXISTS idx_mig_packages_project ON mig_packages(project_id, execution_order);

CREATE TABLE IF NOT EXISTS mig_package_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES mig_packages(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (package_id, version)
);

CREATE TABLE IF NOT EXISTS mig_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_object_type TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  source_json TEXT NOT NULL DEFAULT '{}',
  target_schema_json TEXT NOT NULL DEFAULT '{}',
  duplicate_strategy TEXT NOT NULL DEFAULT 'REJECT',
  duplicate_key_json TEXT NOT NULL DEFAULT '{}',
  dependency_strategy TEXT NOT NULL DEFAULT 'STRICT',
  batch_size INTEGER NOT NULL DEFAULT 1000,
  retry_json TEXT NOT NULL DEFAULT '{}',
  error_policy TEXT NOT NULL DEFAULT 'CONTINUE',
  reconciliation_policy TEXT NOT NULL DEFAULT 'COUNT',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','DEPRECATED')),
  version INTEGER NOT NULL DEFAULT 1,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_mig_definitions_tenant ON mig_definitions(tenant_id, status);

CREATE TABLE IF NOT EXISTS mig_definition_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES mig_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_summary TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (definition_id, version)
);

CREATE TABLE IF NOT EXISTS mig_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES mig_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  source_field TEXT NOT NULL DEFAULT '',
  target_field TEXT NOT NULL,
  mapping_type TEXT NOT NULL DEFAULT 'DIRECT',
  config_json TEXT NOT NULL DEFAULT '{}',
  required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_mappings_definition ON mig_mappings(definition_id, sequence);

CREATE TABLE IF NOT EXISTS mig_transformations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES mig_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'FIELD',
  target_field TEXT NOT NULL DEFAULT '',
  transformation_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_transformations_definition ON mig_transformations(definition_id, sequence);

CREATE TABLE IF NOT EXISTS mig_validation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL REFERENCES mig_definitions(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'FIELD',
  target_field TEXT NOT NULL DEFAULT '',
  rule_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'ERROR',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_validation_definition ON mig_validation_rules(definition_id, sequence);

CREATE TABLE IF NOT EXISTS mig_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER NOT NULL REFERENCES mig_projects(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES mig_packages(id) ON DELETE CASCADE,
  depends_on_package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  dependency_type TEXT NOT NULL DEFAULT 'PACKAGE',
  source_ref TEXT NOT NULL DEFAULT '',
  target_ref TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','satisfied','missing','circular')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_dependencies_package ON mig_dependencies(package_id);

CREATE TABLE IF NOT EXISTS mig_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER NOT NULL REFERENCES mig_projects(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','BLOCKED','APPROVED','RUNNING','COMPLETED','FAILED')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_plans_project ON mig_plans(project_id);

CREATE TABLE IF NOT EXISTS mig_plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES mig_plans(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  package_code TEXT NOT NULL DEFAULT '',
  dependency_json TEXT NOT NULL DEFAULT '[]',
  estimated_records INTEGER NOT NULL DEFAULT 0,
  estimated_duration_ms INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  readiness TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_plan_steps_plan ON mig_plan_steps(plan_id, sequence);

CREATE TABLE IF NOT EXISTS mig_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  definition_id INTEGER REFERENCES mig_definitions(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  source_adapter TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'EXECUTE' CHECK (mode IN ('DRY_RUN','EXECUTE','VALIDATE')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PREPARING','VALIDATING','RUNNING','PAUSED','RETRYING','RECONCILING','COMPLETED','PARTIALLY_COMPLETED','FAILED','CANCELLED')),
  batch_size INTEGER NOT NULL DEFAULT 1000,
  worker_count INTEGER NOT NULL DEFAULT 1,
  total_records INTEGER NOT NULL DEFAULT 0,
  processed_records INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  statistics_json TEXT NOT NULL DEFAULT '{}',
  params_json TEXT NOT NULL DEFAULT '{}',
  source_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_jobs_tenant ON mig_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_mig_jobs_package ON mig_jobs(package_id, id);

CREATE TABLE IF NOT EXISTS mig_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  batch_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','PARTIAL')),
  records INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_mig_batches_job ON mig_batches(job_id, batch_number);

CREATE TABLE IF NOT EXISTS mig_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  checkpoint_number INTEGER NOT NULL,
  last_record INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, checkpoint_number)
);

CREATE INDEX IF NOT EXISTS idx_mig_checkpoints_job ON mig_checkpoints(job_id, checkpoint_number);

CREATE TABLE IF NOT EXISTS mig_object_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES mig_batches(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  record_number INTEGER NOT NULL DEFAULT 0,
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  business_key TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'CREATE',
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  mapped_json TEXT NOT NULL DEFAULT '{}',
  transformed_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  message TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_results_job ON mig_object_results(job_id, record_number);
CREATE INDEX IF NOT EXISTS idx_mig_results_target ON mig_object_results(target_object_type, target_object_id);

CREATE TABLE IF NOT EXISTS mig_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES mig_batches(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  record_number INTEGER NOT NULL DEFAULT 0,
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_type TEXT NOT NULL DEFAULT 'RECORD',
  category TEXT NOT NULL DEFAULT 'SYSTEM_ERROR',
  message TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RETRYING','RESOLVED','IGNORED','REJECTED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_errors_job ON mig_errors(job_id, status, category);

CREATE TABLE IF NOT EXISTS mig_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  error_id INTEGER REFERENCES mig_errors(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  strategy TEXT NOT NULL DEFAULT 'MANUAL',
  status TEXT NOT NULL DEFAULT 'PENDING',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_retries_job ON mig_retries(job_id, id);

CREATE TABLE IF NOT EXISTS mig_identifier_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  source_system TEXT NOT NULL DEFAULT '',
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL,
  target_object_type TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  target_object_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'MAPPED' CHECK (status IN ('MAPPED','PENDING','MISSING','REJECTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, source_system, source_object_type, source_object_id)
);

CREATE INDEX IF NOT EXISTS idx_mig_identifiers_target ON mig_identifier_mappings(target_object_type, target_object_id);

CREATE TABLE IF NOT EXISTS mig_relationship_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES mig_jobs(id) ON DELETE SET NULL,
  relationship_type TEXT NOT NULL DEFAULT '',
  source_relationship_id TEXT NOT NULL DEFAULT '',
  source_parent_id TEXT NOT NULL DEFAULT '',
  source_child_id TEXT NOT NULL DEFAULT '',
  target_parent_id TEXT NOT NULL DEFAULT '',
  target_child_id TEXT NOT NULL DEFAULT '',
  target_relationship_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'MAPPED' CHECK (status IN ('MAPPED','MISSING','SKIPPED','FAILED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_relationship_job ON mig_relationship_mappings(job_id, status);

CREATE TABLE IF NOT EXISTS mig_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_ref TEXT NOT NULL DEFAULT '',
  job_id INTEGER NOT NULL REFERENCES mig_jobs(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  strategy TEXT NOT NULL DEFAULT 'COUNT',
  source_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  successful_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  target_count INTEGER NOT NULL DEFAULT 0,
  variance INTEGER NOT NULL DEFAULT 0,
  reconciliation_percent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','VARIANCE','FAILED')),
  report_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, strategy)
);

CREATE TABLE IF NOT EXISTS mig_reconciliation_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL REFERENCES mig_reconciliations(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES mig_jobs(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  exception_type TEXT NOT NULL DEFAULT 'TARGET_MISSING',
  object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',
  actual TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_recon_exceptions ON mig_reconciliation_exceptions(reconciliation_id, exception_type);

CREATE TABLE IF NOT EXISTS mig_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  job_id INTEGER REFERENCES mig_jobs(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_statistics_job ON mig_statistics(job_id, id);

CREATE TABLE IF NOT EXISTS mig_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  definition_version INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER REFERENCES mig_jobs(id) ON DELETE SET NULL,
  batch_id INTEGER REFERENCES mig_batches(id) ON DELETE SET NULL,
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL DEFAULT '',
  target_object_type TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'MAPPED',
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  error_message TEXT NOT NULL DEFAULT '',
  transformation_version INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_audit_tenant ON mig_audit(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mig_audit_job ON mig_audit(job_id, id);
CREATE INDEX IF NOT EXISTS idx_mig_audit_object ON mig_audit(target_object_type, target_object_id);

CREATE TABLE IF NOT EXISTS mig_configuration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_mig_configuration_tenant ON mig_configuration(tenant_id, key);

CREATE TABLE IF NOT EXISTS mig_source_configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ref TEXT NOT NULL DEFAULT '',
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  adapter_type TEXT NOT NULL DEFAULT 'DATABASE',
  settings_json TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS mig_file_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER REFERENCES mig_projects(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES mig_packages(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES mig_jobs(id) ON DELETE SET NULL,
  source_object_type TEXT NOT NULL DEFAULT '',
  source_object_id TEXT NOT NULL DEFAULT '',
  target_object_id TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  storage_ref TEXT NOT NULL DEFAULT '',
  file_version TEXT NOT NULL DEFAULT '',
  upload_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (upload_status IN ('PENDING','UPLOADED','FAILED','SKIPPED')),
  virus_scan_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','MIGRATED','FAILED','SKIPPED')),
  error_message TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mig_files_job ON mig_file_migrations(job_id, status);
