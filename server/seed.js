import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate, queryOne } from "./db.js";
import * as users from "./services/users.js";
import * as groups from "./services/groups.js";
import * as roles from "./services/roles.js";
import * as orgs from "./services/orgs.js";
import * as catalog from "./services/catalog.js";
import * as grants from "./services/grants.js";
import * as hierarchy from "./services/hierarchy.js";
import * as providers from "./services/providers.js";
import * as tenants from "./services/tenants.js";
import * as config from "./services/config.js";
import { ACTIONS } from "./validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function roleByCode(db, code) {
  return queryOne(db, "SELECT * FROM roles WHERE code = ?", [code]);
}

function orgByCode(db, code) {
  return queryOne(db, "SELECT * FROM organizations WHERE code = ?", [code]);
}

function permissionByCode(db, code) {
  return queryOne(db, "SELECT * FROM permissions WHERE code = ?", [code]);
}

function seedIdentity(db) {
  hierarchy.ensureHierarchy(db);
  const existing = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (existing.c > 0) return { seeded: false };

  const helix = orgs.createOrganization(db, {
    code: "helix",
    name: "Helix",
    kind: "tenant",
    description: "Default Helix tenant",
  });
  const hq = orgs.createOrganization(db, {
    code: "corp-hq",
    name: "Helix Corporate HQ",
    kind: "enterprise",
    parent_id: helix.id,
  });
  const emea = orgs.createOrganization(db, {
    code: "emea",
    name: "Helix EMEA",
    kind: "company",
    parent_id: hq.id,
  });
  const apac = orgs.createOrganization(db, {
    code: "apac",
    name: "Helix APAC",
    kind: "company",
    parent_id: hq.id,
  });
  const emeaOps = orgs.createOrganization(db, {
    code: "emea-ops",
    name: "EMEA Operations",
    kind: "business_unit",
    parent_id: emea.id,
  });
  const apacOps = orgs.createOrganization(db, {
    code: "apac-ops",
    name: "APAC Operations",
    kind: "business_unit",
    parent_id: apac.id,
  });
  const londonPlant = orgs.createOrganization(db, {
    code: "emea-london-plant",
    name: "London Plant",
    kind: "plant",
    parent_id: emeaOps.id,
  });
  const singaporePlant = orgs.createOrganization(db, {
    code: "apac-singapore-plant",
    name: "Singapore Plant",
    kind: "plant",
    parent_id: apacOps.id,
  });
  const london = orgs.createOrganization(db, {
    code: "emea-london",
    name: "London Campus",
    kind: "site",
    parent_id: londonPlant.id,
    description: "EMEA headquarters site",
  });
  const singapore = orgs.createOrganization(db, {
    code: "apac-singapore",
    name: "Singapore Hub",
    kind: "site",
    parent_id: singaporePlant.id,
    description: "APAC operations site",
  });
  orgs.createOrganization(db, {
    code: "emea-london-finance",
    name: "London Finance",
    kind: "department",
    parent_id: london.id,
  });
  orgs.createOrganization(db, {
    code: "emea-london-prod",
    name: "London Production",
    kind: "department",
    parent_id: london.id,
  });
  orgs.createOrganization(db, {
    code: "apac-singapore-logistics",
    name: "Singapore Logistics",
    kind: "department",
    parent_id: singapore.id,
  });

  const rolePlatform = roles.createRole(db, {
    code: "platform.admin",
    name: "Platform Administrator",
    description: "Full control of identity fabric",
  });
  const roleIam = roles.createRole(db, {
    code: "iam.admin",
    name: "IAM Administrator",
    description: "Manage users, groups and roles",
    parent_id: rolePlatform.id,
  });
  const roleAuditor = roles.createRole(db, {
    code: "iam.auditor",
    name: "IAM Auditor",
    description: "Read-only identity review",
  });
  const roleAppReader = roles.createRole(db, {
    code: "app.reader",
    name: "Application Reader",
    description: "Consume identity APIs",
  });
  const roleSiteOps = roles.createRole(db, {
    code: "site.ops",
    name: "Site Operations",
    description: "Site-scoped operations",
  });

  const gEveryone = groups.createGroup(db, {
    code: "everyone",
    name: "Everyone",
    description: "All workforce identities",
    organization_id: hq.id,
  });
  const gIam = groups.createGroup(db, {
    code: "iam-ops",
    name: "IAM Operations",
    description: "Identity operators",
    parent_id: gEveryone.id,
    organization_id: hq.id,
  });
  const gEmea = groups.createGroup(db, {
    code: "emea-staff",
    name: "EMEA Staff",
    description: "Regional workforce",
    parent_id: gEveryone.id,
    organization_id: emea.id,
  });
  const gApac = groups.createGroup(db, {
    code: "apac-staff",
    name: "APAC Staff",
    description: "Regional workforce",
    parent_id: gEveryone.id,
    organization_id: apac.id,
  });

  const admin = users.createUser(db, {
    username: "admin",
    email: "admin@helix.example",
    employee_id: "EMP-0001",
    display_name: "Avery Chen",
    organization_id: hq.id,
    password: "HelixAdmin!42",
  });
  const operator = users.createUser(db, {
    username: "j.patel",
    email: "j.patel@helix.example",
    employee_id: "EMP-0142",
    display_name: "Jordan Patel",
    organization_id: emea.id,
    password: "HelixUser!42",
  });
  const analyst = users.createUser(db, {
    username: "m.okonkwo",
    email: "m.okonkwo@helix.example",
    employee_id: "EMP-0218",
    display_name: "Maya Okonkwo",
    organization_id: apac.id,
    password: "HelixUser!42",
  });
  const contractor = users.createUser(db, {
    username: "c.nielsen",
    email: "c.nielsen@helix.example",
    employee_id: "EMP-0881",
    display_name: "Casey Nielsen",
    organization_id: emea.id,
    password: "HelixUser!42",
  });

  users.setUserStatus(db, contractor.id, "inactive");

  groups.addGroupMember(db, gEveryone.id, admin.id);
  groups.addGroupMember(db, gEveryone.id, operator.id);
  groups.addGroupMember(db, gEveryone.id, analyst.id);
  groups.addGroupMember(db, gEveryone.id, contractor.id);
  groups.addGroupMember(db, gIam.id, admin.id);
  groups.addGroupMember(db, gEmea.id, operator.id);
  groups.addGroupMember(db, gApac.id, analyst.id);

  orgs.addMember(db, london.id, operator.id, false);
  orgs.addMember(db, london.id, admin.id, false);
  orgs.addMember(db, singapore.id, analyst.id, false);
  orgs.addMember(db, singapore.id, admin.id, false);

  roles.assignUserRole(db, admin.id, rolePlatform.id, 0);
  roles.assignGroupRole(db, gIam.id, roleIam.id, 0);
  roles.assignGroupRole(db, gEveryone.id, roleAppReader.id, 0);
  roles.assignGroupRole(db, gEmea.id, roleSiteOps.id, emea.id);
  roles.assignUserRole(db, analyst.id, roleAuditor.id, apac.id);

  return {
    seeded: true,
    organizations: [helix, hq, emea, apac, emeaOps, apacOps, londonPlant, singaporePlant, london, singapore],
    users: [admin, operator, analyst, contractor],
    groups: [gEveryone, gIam, gEmea, gApac],
    roles: [rolePlatform, roleIam, roleAuditor, roleAppReader, roleSiteOps],
  };
}

function grantAll(db, roleId, resource, actions = ACTIONS, organizationId = 0) {
  for (const action of actions) {
    const permission = catalog.ensurePermission(db, resource.id, action);
    grants.grantRolePermission(db, roleId, {
      permission_id: permission.id,
      effect: "allow",
      organization_id: organizationId,
    });
  }
}

function seedAuthz(db) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM applications").get();
  if (existing.c > 0) return { authzSeeded: false };

  const iamApp = catalog.createApplication(db, {
    code: "iam",
    name: "Identity & Access",
    description: "Users, groups, roles and authorization",
  });
  const financeApp = catalog.createApplication(db, {
    code: "finance",
    name: "Finance",
    description: "Ledger and financial operations",
  });
  const siteApp = catalog.createApplication(db, {
    code: "site",
    name: "Site Operations",
    description: "Organization and site workloads",
  });

  const iamRoot = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam",
    name: "IAM module",
    kind: "module",
  });
  const iamUsers = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.users",
    name: "Users",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamGroups = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.groups",
    name: "Groups",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamRoles = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.roles",
    name: "Roles",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamPerms = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.permissions",
    name: "Permissions",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamOrgs = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.organizations",
    name: "Organizations",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamPolicy = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.policy",
    name: "Password policy",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamAudit = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.audit",
    name: "Audit log",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamPlatform = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.platform",
    name: "Platform properties",
    kind: "object",
  });
  const iamAuth = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.authentication",
    name: "Authentication providers",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamSessions = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.sessions",
    name: "Sessions",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamTenants = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.tenants",
    name: "Tenants",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const iamConfig = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.config",
    name: "Configuration",
    kind: "object",
    parent_id: iamRoot.id,
  });
  const financeRoot = catalog.createResource(db, {
    application_id: financeApp.id,
    code: "finance",
    name: "Finance module",
    kind: "module",
  });
  const financeLedger = catalog.createResource(db, {
    application_id: financeApp.id,
    code: "finance.ledger",
    name: "Ledger",
    kind: "object",
    parent_id: financeRoot.id,
  });
  const siteRoot = catalog.createResource(db, {
    application_id: siteApp.id,
    code: "site",
    name: "Site module",
    kind: "module",
  });
  const siteOps = catalog.createResource(db, {
    application_id: siteApp.id,
    code: "site.ops",
    name: "Site operations",
    kind: "object",
    parent_id: siteRoot.id,
  });

  const catalogResources = [
    iamRoot,
    iamUsers,
    iamGroups,
    iamRoles,
    iamPerms,
    iamOrgs,
    iamPolicy,
    iamAudit,
    iamPlatform,
    iamAuth,
    iamSessions,
    iamTenants,
    iamConfig,
    financeRoot,
    financeLedger,
    siteRoot,
    siteOps,
  ];
  for (const resource of catalogResources) {
    for (const action of ACTIONS) {
      catalog.ensurePermission(db, resource.id, action);
    }
  }

  const platform = roleByCode(db, "platform.admin");
  const iamAdmin = roleByCode(db, "iam.admin");
  const auditor = roleByCode(db, "iam.auditor");
  const reader = roleByCode(db, "app.reader");
  const siteRole = roleByCode(db, "site.ops");
  const emea = orgByCode(db, "emea");
  const apac = orgByCode(db, "apac");

  if (platform) {
    grantAll(db, platform.id, iamRoot);
    grantAll(db, platform.id, iamPlatform);
    grantAll(db, platform.id, financeRoot);
    grantAll(db, platform.id, siteRoot);
  }
  if (iamAdmin) {
    grantAll(db, iamAdmin.id, iamRoot);
  }
  if (auditor) {
    grantAll(db, auditor.id, iamRoot, ["read"], apac?.id || 0);
    const delUsers = permissionByCode(db, "iam.users:delete");
    if (delUsers) {
      grants.grantRolePermission(db, auditor.id, {
        permission_id: delUsers.id,
        effect: "deny",
        organization_id: apac?.id || 0,
      });
    }
  }
  if (reader) {
    grantAll(db, reader.id, iamUsers, ["read"]);
    grantAll(db, reader.id, iamGroups, ["read"]);
    grantAll(db, reader.id, iamRoles, ["read"]);
    grantAll(db, reader.id, iamOrgs, ["read"]);
  }
  if (siteRole && emea) {
    grantAll(db, siteRole.id, siteRoot, ["read", "update", "execute"], emea.id);
  }

  return {
    authzSeeded: true,
    applications: [iamApp, financeApp, siteApp],
    resources: catalogResources,
  };
}

function ensureResource(db, body) {
  const existing = queryOne(db, "SELECT * FROM resources WHERE code = ?", [body.code]);
  if (existing) return existing;
  const app = queryOne(db, "SELECT * FROM applications WHERE code = ?", [body.applicationCode]);
  if (!app) return null;
  const parent = body.parentCode
    ? queryOne(db, "SELECT * FROM resources WHERE code = ?", [body.parentCode])
    : null;
  const resource = catalog.createResource(db, {
    application_id: app.id,
    code: body.code,
    name: body.name,
    kind: body.kind || "object",
    parent_id: parent?.id || null,
    description: body.description || "",
  });
  for (const action of ACTIONS) catalog.ensurePermission(db, resource.id, action);
  return resource;
}

function ensureOrg(db, body) {
  const existing = orgByCode(db, body.code);
  const parent = body.parentCode ? orgByCode(db, body.parentCode) : null;
  if (!existing) {
    return orgs.createOrganization(db, {
      code: body.code,
      name: body.name,
      kind: body.kind,
      parent_id: parent?.id || null,
      description: body.description || "",
    });
  }
  const patch = {};
  if (body.kind && existing.kind !== body.kind) patch.kind = body.kind;
  if (parent && existing.parent_id !== parent.id) patch.parent_id = parent.id;
  if (Object.keys(patch).length) {
    try {
      orgs.updateOrganization(db, existing.id, patch);
    } catch {
      /* keep existing placement if a live tree cannot move yet */
    }
  }
  return orgByCode(db, body.code);
}

function seedMissingHierarchy(db) {
  ensureOrg(db, { code: "helix", name: "Helix", kind: "tenant", description: "Default Helix tenant" });
  ensureOrg(db, { code: "corp-hq", name: "Helix Corporate HQ", kind: "enterprise", parentCode: "helix" });
  ensureOrg(db, { code: "emea", name: "Helix EMEA", kind: "company", parentCode: "corp-hq" });
  ensureOrg(db, { code: "apac", name: "Helix APAC", kind: "company", parentCode: "corp-hq" });
  ensureOrg(db, {
    code: "emea-ops",
    name: "EMEA Operations",
    kind: "business_unit",
    parentCode: "emea",
  });
  ensureOrg(db, {
    code: "apac-ops",
    name: "APAC Operations",
    kind: "business_unit",
    parentCode: "apac",
  });
  ensureOrg(db, {
    code: "emea-london-plant",
    name: "London Plant",
    kind: "plant",
    parentCode: "emea-ops",
  });
  ensureOrg(db, {
    code: "apac-singapore-plant",
    name: "Singapore Plant",
    kind: "plant",
    parentCode: "apac-ops",
  });
  ensureOrg(db, {
    code: "emea-london",
    name: "London Campus",
    kind: "site",
    parentCode: "emea-london-plant",
    description: "EMEA headquarters site",
  });
  ensureOrg(db, {
    code: "apac-singapore",
    name: "Singapore Hub",
    kind: "site",
    parentCode: "apac-singapore-plant",
    description: "APAC operations site",
  });
  ensureOrg(db, {
    code: "emea-london-finance",
    name: "London Finance",
    kind: "department",
    parentCode: "emea-london",
  });
  ensureOrg(db, {
    code: "emea-london-prod",
    name: "London Production",
    kind: "department",
    parentCode: "emea-london",
  });
  ensureOrg(db, {
    code: "apac-singapore-logistics",
    name: "Singapore Logistics",
    kind: "department",
    parentCode: "apac-singapore",
  });

  const admin = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");
  const operator = queryOne(db, "SELECT id FROM users WHERE username = 'j.patel'");
  const analyst = queryOne(db, "SELECT id FROM users WHERE username = 'm.okonkwo'");
  const london = orgByCode(db, "emea-london");
  const singapore = orgByCode(db, "apac-singapore");
  if (admin && london) orgs.addMember(db, london.id, admin.id, false);
  if (operator && london) orgs.addMember(db, london.id, operator.id, false);
  if (admin && singapore) orgs.addMember(db, singapore.id, admin.id, false);
  if (analyst && singapore) orgs.addMember(db, singapore.id, analyst.id, false);
}

function seedMissingCatalog(db) {
  const extra = [
    { applicationCode: "iam", code: "iam.organizations", name: "Organizations", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.policy", name: "Password policy", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.audit", name: "Audit log", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.platform", name: "Platform properties" },
    { applicationCode: "iam", code: "iam.authentication", name: "Authentication providers", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.sessions", name: "Sessions", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.tenants", name: "Tenants", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.config", name: "Configuration", parentCode: "iam" },
  ];
  const created = extra.map((item) => ensureResource(db, item)).filter(Boolean);
  const platform = roleByCode(db, "platform.admin");
  const platformRes = queryOne(db, "SELECT * FROM resources WHERE code = 'iam.platform'");
  for (const code of ["iam.tenants", "iam.config"]) {
    const res = queryOne(db, "SELECT * FROM resources WHERE code = ?", [code]);
    if (platform && res) {
      const existingGrant = queryOne(
        db,
        `SELECT 1 AS x FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'read'`,
        [platform.id, res.id]
      );
      if (!existingGrant) grantAll(db, platform.id, res);
    }
  }
  if (platform && platformRes) {
    const existingGrant = queryOne(
      db,
      `SELECT 1 AS x FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'update'`,
      [platform.id, platformRes.id]
    );
    if (!existingGrant) grantAll(db, platform.id, platformRes);
  }
  const reader = roleByCode(db, "app.reader");
  const orgsRes = queryOne(db, "SELECT * FROM resources WHERE code = 'iam.organizations'");
  if (reader && orgsRes) {
    const existing = queryOne(
      db,
      `SELECT 1 AS x FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'read'`,
      [reader.id, orgsRes.id]
    );
    if (!existing) grantAll(db, reader.id, orgsRes, ["read"]);
  }
  return created;
}

export function seedDatabase(db) {
  hierarchy.ensureHierarchy(db);
  config.ensureDefinitions(db);
  providers.ensureDefaultProviders(db);
  const identity = seedIdentity(db);
  const authz = seedAuthz(db);
  seedMissingCatalog(db);
  seedMissingHierarchy(db);
  tenants.backfillTenants(db);
  return { ...identity, ...authz };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.IAM_DB || join(__dirname, "..", "data", "iam.db");
  const db = openDatabase(path);
  migrate(db);
  const result = seedDatabase(db);
  console.log(result.seeded || result.authzSeeded ? "Seeded IAM database" : "IAM database already populated");
  db.close();
}
