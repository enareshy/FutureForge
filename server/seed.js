import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate, queryOne, queryAll, run, nowIso } from "./db.js";
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
import * as metadata from "./services/metadata.js";
import * as objects from "./services/objects.js";
import * as lifecycle from "./services/lifecycle.js";
import * as workflow from "./services/workflow.js";
import * as audit from "./services/audit.js";
import * as notifications from "./services/notifications.js";
import * as delivery from "./services/delivery.js";
import * as jobs from "./services/jobs.js";
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
  if (existing.c > 0) {
    // Authorization catalog already exists. Reconcile the idempotent end-user
    // grants so upgraded databases pick up newly introduced permission sets.
    reconcileReaderGrants(db);
    return { authzSeeded: false };
  }

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
  const iamMetadata = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata",
    name: "Metadata & configuration",
    kind: "module",
  });
  const iamMetaTypes = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata.types",
    name: "Metadata types",
    kind: "object",
    parent_id: iamMetadata.id,
  });
  const iamMetaAttributes = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata.attributes",
    name: "Metadata attributes",
    kind: "object",
    parent_id: iamMetadata.id,
  });
  const iamMetaLovs = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata.lovs",
    name: "Metadata LOVs",
    kind: "object",
    parent_id: iamMetadata.id,
  });
  const iamMetaForms = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata.forms",
    name: "Metadata forms",
    kind: "object",
    parent_id: iamMetadata.id,
  });
  const iamMetaRules = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.metadata.rules",
    name: "Metadata rules",
    kind: "object",
    parent_id: iamMetadata.id,
  });
  const iamObjects = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.objects",
    name: "Object & relationship framework",
    kind: "module",
  });
  const iamObjectInstances = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.objects.instances",
    name: "Business objects",
    kind: "object",
    parent_id: iamObjects.id,
  });
  const iamObjectRelationships = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.objects.relationships",
    name: "Object relationships",
    kind: "object",
    parent_id: iamObjects.id,
  });
  const iamObjectReferences = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.objects.references",
    name: "Object references",
    kind: "object",
    parent_id: iamObjects.id,
  });
  const iamObjectDependencies = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.objects.dependencies",
    name: "Object dependencies",
    kind: "object",
    parent_id: iamObjects.id,
  });
  const iamLifecycle = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle",
    name: "Lifecycle management",
    kind: "module",
  });
  const iamLifecycleStatuses = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle.statuses",
    name: "Lifecycle statuses",
    kind: "object",
    parent_id: iamLifecycle.id,
  });
  const iamLifecycleDefinitions = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle.definitions",
    name: "Lifecycle definitions",
    kind: "object",
    parent_id: iamLifecycle.id,
  });
  const iamLifecycleTransitions = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle.transitions",
    name: "Lifecycle states & transitions",
    kind: "object",
    parent_id: iamLifecycle.id,
  });
  const iamLifecycleReleaseRules = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle.release-rules",
    name: "Release rules",
    kind: "object",
    parent_id: iamLifecycle.id,
  });
  const iamLifecycleApprovals = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.lifecycle.approvals",
    name: "Approvals",
    kind: "object",
    parent_id: iamLifecycle.id,
  });
  const iamWorkflow = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow",
    name: "Workflow & process engine",
    kind: "module",
  });
  const iamWorkflowTemplates = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.templates",
    name: "Workflow templates",
    kind: "object",
    parent_id: iamWorkflow.id,
  });
  const iamWorkflowDesigner = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.designer",
    name: "Workflow designer",
    kind: "object",
    parent_id: iamWorkflow.id,
  });
  const iamWorkflowInstances = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.instances",
    name: "Workflow instances",
    kind: "object",
    parent_id: iamWorkflow.id,
  });
  const iamWorkflowTasks = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.tasks",
    name: "Workflow tasks",
    kind: "object",
    parent_id: iamWorkflow.id,
  });
  const iamWorkflowApprovals = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.approvals",
    name: "Workflow approvals",
    kind: "object",
    parent_id: iamWorkflow.id,
  });
  const iamWorkflowConfig = catalog.createResource(db, {
    application_id: iamApp.id,
    code: "iam.workflow.config",
    name: "Workflow configuration",
    kind: "object",
    parent_id: iamWorkflow.id,
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
    iamMetadata,
    iamMetaTypes,
    iamMetaAttributes,
    iamMetaLovs,
    iamMetaForms,
    iamMetaRules,
    iamObjects,
    iamObjectInstances,
    iamObjectRelationships,
    iamObjectReferences,
    iamObjectDependencies,
    iamLifecycle,
    iamLifecycleStatuses,
    iamLifecycleDefinitions,
    iamLifecycleTransitions,
    iamLifecycleReleaseRules,
    iamLifecycleApprovals,
    iamWorkflow,
    iamWorkflowTemplates,
    iamWorkflowDesigner,
    iamWorkflowInstances,
    iamWorkflowTasks,
    iamWorkflowApprovals,
    iamWorkflowConfig,
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
    grantAll(db, platform.id, iamMetadata);
    for (const resource of [iamObjects, iamObjectInstances, iamObjectRelationships, iamObjectReferences, iamObjectDependencies]) {
      grantAll(db, platform.id, resource);
    }
    for (const resource of [iamLifecycle, iamLifecycleStatuses, iamLifecycleDefinitions, iamLifecycleTransitions, iamLifecycleReleaseRules, iamLifecycleApprovals, iamWorkflow, iamWorkflowTemplates, iamWorkflowDesigner, iamWorkflowInstances, iamWorkflowTasks, iamWorkflowApprovals, iamWorkflowConfig]) {
      grantAll(db, platform.id, resource);
    }
    grantAll(db, platform.id, financeRoot);
    grantAll(db, platform.id, siteRoot);
  }
  if (iamAdmin) {
    grantAll(db, iamAdmin.id, iamRoot);
    grantAll(db, iamAdmin.id, iamMetadata);
    for (const resource of [iamObjects, iamObjectInstances, iamObjectRelationships, iamObjectReferences, iamObjectDependencies]) {
      grantAll(db, iamAdmin.id, resource);
    }
    for (const resource of [iamLifecycle, iamLifecycleStatuses, iamLifecycleDefinitions, iamLifecycleTransitions, iamLifecycleReleaseRules, iamLifecycleApprovals, iamWorkflow, iamWorkflowTemplates, iamWorkflowDesigner, iamWorkflowInstances, iamWorkflowTasks, iamWorkflowApprovals, iamWorkflowConfig]) {
      grantAll(db, iamAdmin.id, resource);
    }
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
    { applicationCode: "iam", code: "iam.audit", name: "Audit & history", kind: "module" },
    { applicationCode: "iam", code: "iam.audit.events", name: "Audit events", parentCode: "iam.audit" },
    { applicationCode: "iam", code: "iam.audit.history", name: "Object history", parentCode: "iam.audit" },
    { applicationCode: "iam", code: "iam.audit.policies", name: "Audit policies", parentCode: "iam.audit" },
    { applicationCode: "iam", code: "iam.audit.export", name: "Audit export", parentCode: "iam.audit" },
    { applicationCode: "iam", code: "iam.audit.retention", name: "Audit retention", parentCode: "iam.audit" },
    { applicationCode: "iam", code: "iam.platform", name: "Platform properties" },
    { applicationCode: "iam", code: "iam.authentication", name: "Authentication providers", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.sessions", name: "Sessions", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.tenants", name: "Tenants", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.config", name: "Configuration", parentCode: "iam" },
    { applicationCode: "iam", code: "iam.metadata", name: "Metadata & configuration", kind: "module" },
    { applicationCode: "iam", code: "iam.metadata.types", name: "Metadata types", parentCode: "iam.metadata" },
    { applicationCode: "iam", code: "iam.metadata.attributes", name: "Metadata attributes", parentCode: "iam.metadata" },
    { applicationCode: "iam", code: "iam.metadata.lovs", name: "Metadata LOVs", parentCode: "iam.metadata" },
    { applicationCode: "iam", code: "iam.metadata.forms", name: "Metadata forms", parentCode: "iam.metadata" },
    { applicationCode: "iam", code: "iam.metadata.rules", name: "Metadata rules", parentCode: "iam.metadata" },
    { applicationCode: "iam", code: "iam.objects", name: "Object & relationship framework", kind: "module" },
    { applicationCode: "iam", code: "iam.objects.instances", name: "Business objects", parentCode: "iam.objects" },
    { applicationCode: "iam", code: "iam.objects.relationships", name: "Object relationships", parentCode: "iam.objects" },
    { applicationCode: "iam", code: "iam.objects.references", name: "Object references", parentCode: "iam.objects" },
    { applicationCode: "iam", code: "iam.objects.dependencies", name: "Object dependencies", parentCode: "iam.objects" },
    { applicationCode: "iam", code: "iam.lifecycle", name: "Lifecycle management", kind: "module" },
    { applicationCode: "iam", code: "iam.lifecycle.statuses", name: "Lifecycle statuses", parentCode: "iam.lifecycle" },
    { applicationCode: "iam", code: "iam.lifecycle.definitions", name: "Lifecycle definitions", parentCode: "iam.lifecycle" },
    { applicationCode: "iam", code: "iam.lifecycle.transitions", name: "Lifecycle states & transitions", parentCode: "iam.lifecycle" },
    { applicationCode: "iam", code: "iam.lifecycle.release-rules", name: "Release rules", parentCode: "iam.lifecycle" },
    { applicationCode: "iam", code: "iam.lifecycle.approvals", name: "Approvals", parentCode: "iam.lifecycle" },
    { applicationCode: "iam", code: "iam.workflow", name: "Workflow & process engine", kind: "module" },
    { applicationCode: "iam", code: "iam.workflow.templates", name: "Workflow templates", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.workflow.designer", name: "Workflow designer", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.workflow.instances", name: "Workflow instances", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.workflow.tasks", name: "Workflow tasks", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.workflow.approvals", name: "Workflow approvals", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.workflow.config", name: "Workflow configuration", parentCode: "iam.workflow" },
    { applicationCode: "iam", code: "iam.notifications", name: "Notifications & communication", kind: "module" },
    { applicationCode: "iam", code: "iam.notifications.inbox", name: "Notification inbox", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.notifications.preferences", name: "Notification preferences", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.notifications.templates", name: "Notification templates", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.notifications.rules", name: "Notification rules", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.notifications.providers", name: "Notification providers", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.notifications.history", name: "Notification history", parentCode: "iam.notifications" },
    { applicationCode: "iam", code: "iam.delivery", name: "Communication & delivery", kind: "module" },
    { applicationCode: "iam", code: "iam.delivery.providers", name: "Delivery providers", parentCode: "iam.delivery" },
    { applicationCode: "iam", code: "iam.delivery.requests", name: "Delivery requests", parentCode: "iam.delivery" },
    { applicationCode: "iam", code: "iam.delivery.reminders", name: "Delivery reminders & escalations", parentCode: "iam.delivery" },
    { applicationCode: "iam", code: "iam.delivery.monitoring", name: "Delivery monitoring", parentCode: "iam.delivery" },
    { applicationCode: "iam", code: "iam.jobs", name: "Background job management", kind: "module" },
    { applicationCode: "iam", code: "iam.jobs.list", name: "Job list & submission", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.details", name: "Job details & history", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.control", name: "Job control", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.types", name: "Job type administration", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.results", name: "Job results & artifacts", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.monitoring", name: "Job monitoring", parentCode: "iam.jobs" },
  ];
  const created = extra.map((item) => ensureResource(db, item)).filter(Boolean);
  const platform = roleByCode(db, "platform.admin");
  const platformRes = queryOne(db, "SELECT * FROM resources WHERE code = 'iam.platform'");
  for (const code of ["iam.tenants", "iam.config", "iam.metadata"]) {
    const res = queryOne(db, "SELECT * FROM resources WHERE code = ?", [code]);
    if (platform && res) {
      const grantRes = code === "iam.metadata" ? res : res;
      const existingGrant = queryOne(
        db,
        `SELECT 1 AS x FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'read'`,
        [platform.id, grantRes.id]
      );
      if (!existingGrant) grantAll(db, platform.id, grantRes);
    }
  }
  const iamAdmin = roleByCode(db, "iam.admin");
  const metadataRes = queryOne(db, "SELECT * FROM resources WHERE code = 'iam.metadata'");
  if (iamAdmin && metadataRes) {
    const existing = queryOne(
      db,
      `SELECT 1 AS x FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'read'`,
      [iamAdmin.id, metadataRes.id]
    );
    if (!existing) grantAll(db, iamAdmin.id, metadataRes);
  }
  const objectResourceCodes = [
    "iam.objects",
    "iam.objects.instances",
    "iam.objects.relationships",
    "iam.objects.references",
    "iam.objects.dependencies",
    "iam.lifecycle",
    "iam.lifecycle.statuses",
    "iam.lifecycle.definitions",
    "iam.lifecycle.transitions",
    "iam.lifecycle.release-rules",
    "iam.lifecycle.approvals",
    "iam.workflow",
    "iam.workflow.templates",
    "iam.workflow.designer",
    "iam.workflow.instances",
    "iam.workflow.tasks",
    "iam.workflow.approvals",
    "iam.workflow.config",
    "iam.audit.events",
    "iam.audit.history",
    "iam.audit.policies",
    "iam.audit.export",
    "iam.audit.retention",
  ];
  for (const code of objectResourceCodes) {
    const resource = queryOne(db, "SELECT * FROM resources WHERE code = ?", [code]);
    if (!resource) continue;
    const owners = [platform, iamAdmin].filter(Boolean);
    for (const role of owners) {
      const existing = queryOne(
        db,
        `SELECT 1 AS x FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'read'`,
        [role.id, resource.id]
      );
      if (!existing) grantAll(db, role.id, resource);
    }
  }
  const notificationResourceCodes = [
    "iam.notifications.inbox",
    "iam.notifications.preferences",
    "iam.notifications.templates",
    "iam.notifications.rules",
    "iam.notifications.providers",
    "iam.notifications.history",
  ];
  const deliveryResourceCodes = [
    "iam.delivery.providers",
    "iam.delivery.requests",
    "iam.delivery.reminders",
    "iam.delivery.monitoring",
  ];
  const jobResourceCodes = [
    "iam.jobs.list",
    "iam.jobs.details",
    "iam.jobs.control",
    "iam.jobs.types",
    "iam.jobs.results",
    "iam.jobs.monitoring",
  ];
  for (const code of [...notificationResourceCodes, ...deliveryResourceCodes, ...jobResourceCodes]) {
    const resource = queryOne(db, "SELECT * FROM resources WHERE code = ?", [code]);
    if (!resource) continue;
    const owners = [platform, iamAdmin].filter(Boolean);
    for (const role of owners) {
      const existing = queryOne(
        db,
        `SELECT 1 AS x FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = 'delete'`,
        [role.id, resource.id]
      );
      if (!existing) grantAll(db, role.id, resource);
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
  reconcileReaderGrants(db);
  return created;
}

// Idempotent end-user grants. These are reconciled on every seed so that
// existing databases also receive the permissions the "My tasks & approvals"
// console needs. Administrator-only surfaces (templates authoring, designer,
// configuration) are intentionally excluded, and module-level grants are
// avoided because the authorization layer inherits them into child resources.
function reconcileReaderGrants(db) {
  const reader = roleByCode(db, "app.reader");
  if (!reader) return;
  const grants = [
    ["iam.organizations", ["read"]],
    ["iam.workflow.templates", ["read"]],
    ["iam.workflow.instances", ["read", "create", "execute"]],
    ["iam.workflow.tasks", ["read", "execute", "update"]],
    ["iam.workflow.approvals", ["read", "execute"]],
    ["iam.audit.history", ["read"]],
    ["iam.notifications.inbox", ["read", "update"]],
    ["iam.notifications.preferences", ["read", "update"]],
    ["iam.jobs.list", ["read", "create"]],
    ["iam.jobs.details", ["read"]],
    ["iam.jobs.control", ["execute"]],
    ["iam.jobs.results", ["read"]],
    ["iam.jobs.types", ["read"]],
    ["iam.jobs.monitoring", ["read"]],
  ];
  for (const [code, actions] of grants) {
    const resource = queryOne(db, "SELECT * FROM resources WHERE code = ?", [code]);
    if (!resource) continue;
    for (const action of actions) {
      const existingAction = queryOne(
        db,
        `SELECT 1 AS x FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.resource_id = ? AND p.action = ?`,
        [reader.id, resource.id, action]
      );
      if (!existingAction) grantAll(db, reader.id, resource, [action]);
    }
  }
}

function seedMetadata(db) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM metadata_types").get();
  if (existing.c > 0) return { metadataSeeded: false };
  const helixes = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  if (!helixes) return { metadataSeeded: false };
  const tenantId = helixes.id;
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  const actor = admin ? { id: admin.id, username: admin.username } : null;
  const ip = "seed";
  const created = { types: [], attributes: [], lovs: [], forms: [], rules: [] };

  const categoryLov = metadata.createLov(
    db,
    { code: "part-category", name: "Part category", selection_type: "single", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  const statusLov = metadata.createLov(
    db,
    { code: "lifecycle-status", name: "Lifecycle status", selection_type: "single", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  const docClassLov = metadata.createLov(
    db,
    { code: "document-class", name: "Document class", selection_type: "single", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  created.lovs.push(categoryLov, statusLov, docClassLov);

  const categoryValues = [
    { code: "mechanical", label: "Mechanical" },
    { code: "electrical", label: "Electrical" },
    { code: "hydraulic", label: "Hydraulic" },
    { code: "fastener", label: "Fastener" },
  ];
  const statusValues = [
    { code: "draft", label: "Draft" },
    { code: "review", label: "In review" },
    { code: "released", label: "Released" },
    { code: "obsolete", label: "Obsolete" },
  ];
  const docClassValues = [
    { code: "spec", label: "Specification" },
    { code: "drawing", label: "Drawing" },
    { code: "certificate", label: "Certificate" },
  ];
  for (const value of categoryValues) metadata.addValue(db, categoryLov.id, value, actor, ip, tenantId);
  for (const value of statusValues) metadata.addValue(db, statusLov.id, value, actor, ip, tenantId);
  for (const value of docClassValues) metadata.addValue(db, docClassLov.id, value, actor, ip, tenantId);

  const attributes = [
    {
      code: "part.number",
      name: "Part number",
      data_type: "string",
      required: true,
      max_length: 32,
      validation: { pattern: "^[A-Z0-9-]+$", message: "Part number must be uppercase letters, digits or dashes" },
    },
    { code: "part.name", name: "Description", data_type: "string", required: true, max_length: 120 },
    { code: "part.category", name: "Category", data_type: "string", required: true, lov_id: categoryLov.id },
    { code: "part.status", name: "Status", data_type: "string", required: true, lov_id: statusLov.id, default_value: "draft" },
    { code: "part.weight_kg", name: "Weight (kg)", data_type: "decimal", min_value: 0, max_value: 100000, validation: { scale: 3 } },
    { code: "part.revision", name: "Revision", data_type: "integer", min_value: 1, max_value: 999, default_value: "1" },
    { code: "part.is_critical", name: "Safety critical", data_type: "boolean", default_value: "false" },
    { code: "part.effective_date", name: "Effective date", data_type: "date" },
    { code: "part.released_at", name: "Released at", data_type: "datetime" },
    { code: "part.supplier", name: "Preferred supplier", data_type: "reference", validation: { reference_type: "organization" } },
    { code: "part.tags", name: "Tags", data_type: "multi_value", validation: { min_items: 0, max_items: 5 } },
    { code: "part.notes", name: "Notes", data_type: "string", max_length: 2000, visible: true, editable: true },
  ];
  const attributeRows = {};
  for (const attribute of attributes) {
    attributeRows[attribute.code] = metadata.createAttribute(db, attribute, actor, ip, tenantId);
  }
  created.attributes.push(...Object.values(attributeRows));

  const partType = metadata.createType(
    db,
    { code: "part", name: "Part", module: "plm", status: "active", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  created.types.push(partType);
  let sequence = 0;
  for (const attribute of attributes) {
    metadata.addTypeAttribute(
      db,
      partType.id,
      {
        attribute_id: attributeRows[attribute.code].id,
        sequence: (sequence += 10),
        required_override: attribute.required === undefined ? null : attribute.required ? 1 : 0,
      },
      actor,
      ip,
      tenantId
    );
  }

  const qualityType = metadata.createType(
    db,
    { code: "quality-record", name: "Quality record", module: "qms", status: "active", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  created.types.push(qualityType);
  metadata.addTypeAttribute(db, qualityType.id, { attribute_id: attributeRows["part.number"].id, sequence: 10 }, actor, ip, tenantId);
  metadata.addTypeAttribute(db, qualityType.id, { attribute_id: attributeRows["part.status"].id, sequence: 20 }, actor, ip, tenantId);
  metadata.addTypeAttribute(db, qualityType.id, { attribute_id: attributeRows["part.notes"].id, sequence: 30 }, actor, ip, tenantId);

  const inspectionType = metadata.createType(
    db,
    {
      code: "inspection",
      name: "Inspection",
      module: "qms",
      parent_type_id: qualityType.id,
      status: "active",
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );
  created.types.push(inspectionType);
  metadata.addTypeAttribute(db, inspectionType.id, { attribute_id: attributeRows["part.category"].id, sequence: 15 }, actor, ip, tenantId);
  metadata.addTypeAttribute(db, inspectionType.id, { attribute_id: attributeRows["part.effective_date"].id, sequence: 40 }, actor, ip, tenantId);

  const createForm = metadata.createForm(
    db,
    { code: "part.create", name: "Create part", type_id: partType.id, mode: "create", status: "active", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  metadata.replaceLayout(
    db,
    createForm.id,
    {
      nodes: [
        { code: "identity", kind: "section", label: "Identification", sequence: 10 },
        { code: "classification", kind: "section", label: "Classification", sequence: 20 },
        { code: "physical", kind: "section", label: "Physical", sequence: 30 },
      ],
      fields: [
        { code: "part.number", node_code: "identity", sequence: 10 },
        { code: "part.name", node_code: "identity", sequence: 20 },
        { code: "part.category", node_code: "classification", sequence: 30 },
        { code: "part.status", node_code: "classification", sequence: 40 },
        { code: "part.revision", node_code: "classification", sequence: 50 },
        { code: "part.weight_kg", node_code: "physical", sequence: 60 },
        { code: "part.is_critical", node_code: "physical", sequence: 70 },
        { code: "part.supplier", node_code: "physical", sequence: 80 },
        { code: "part.tags", node_code: "physical", sequence: 90 },
      ],
    },
    actor,
    ip,
    tenantId
  );
  const viewForm = metadata.createForm(
    db,
    { code: "part.view", name: "View part", type_id: partType.id, mode: "view", status: "active", tenant_id: tenantId },
    actor,
    ip,
    tenantId
  );
  metadata.replaceLayout(
    db,
    viewForm.id,
    {
      nodes: [{ code: "summary", kind: "section", label: "Summary", sequence: 10 }],
      fields: attributes.map((attribute, index) => ({ code: attribute.code, node_code: "summary", sequence: (index + 1) * 10 })),
    },
    actor,
    ip,
    tenantId
  );
  created.forms.push(createForm, viewForm);

  const rules = [
    {
      code: "weight.positive",
      name: "Weight must be positive",
      category: "validation",
      type_id: partType.id,
      condition: {
        op: "and",
        args: [
          { op: "is_not_empty", arg: { op: "value", path: "values.part.weight_kg" } },
          { op: "lte", left: { op: "value", path: "values.part.weight_kg" }, right: 0 },
        ],
      },
      actions: [{ type: "error", field: "part.weight_kg", message: "Weight must be greater than zero" }],
    },
    {
      code: "critical.requires.notes",
      name: "Critical parts need notes",
      category: "dependency",
      type_id: partType.id,
      condition: { op: "eq", left: { op: "value", path: "values.part.is_critical" }, right: true },
      actions: [{ type: "require", field: "part.notes" }],
    },
    {
      code: "released.requires.date",
      name: "Released parts need an effective date",
      category: "dependency",
      type_id: partType.id,
      condition: {
        op: "and",
        args: [
          { op: "eq", left: { op: "value", path: "values.part.status" }, right: "released" },
          { op: "is_empty", arg: { op: "value", path: "values.part.effective_date" } },
        ],
      },
      actions: [{ type: "error", field: "part.effective_date", message: "Released parts require an effective date" }],
    },
    {
      code: "obsolete.readonly",
      name: "Obsolete parts are read-only",
      category: "editability",
      type_id: partType.id,
      condition: { op: "eq", left: { op: "value", path: "values.part.status" }, right: "obsolete" },
      actions: [{ type: "set_editable", field: "part.revision", value: false }],
    },
  ];
  for (const rule of rules) {
    created.rules.push(metadata.createRule(db, { ...rule, tenant_id: tenantId }, actor, ip, tenantId));
  }

  return { metadataSeeded: true, metadata: created };
}

// Demo data for the Object & Relationship Framework. Product, revision, BOM,
// document and change-notice are created as ordinary metadata types, proving no
// business object type is hard-coded in the framework itself.
function seedObjects(db) {
  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM relationship_types");
  if (existing.c > 0) return { objectsSeeded: false };
  const helix = orgByCode(db, "helix");
  if (!helix) return { objectsSeeded: false };
  const tenantId = helix.id;
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  const actor = admin ? { id: admin.id, username: admin.username } : null;
  const ip = "seed";

  const ensureType = (body) => {
    const found = queryOne(db, "SELECT * FROM metadata_types WHERE code = ? AND tenant_id = ?", [
      body.code,
      tenantId,
    ]);
    if (found) return found;
    return metadata.createType(db, { ...body, status: body.status || "active" }, actor, ip, tenantId);
  };
  const attributeId = (code) =>
    queryOne(
      db,
      `SELECT id FROM metadata_attributes WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?)
       ORDER BY tenant_id IS NULL LIMIT 1`,
      [code, tenantId]
    )?.id;
  const attach = (typeRow, codes) => {
    let sequence = 0;
    for (const code of codes) {
      const id = attributeId(code);
      if (id) {
        metadata.addTypeAttribute(db, typeRow.id, { attribute_id: id, sequence: (sequence += 10) }, actor, ip, tenantId);
      }
    }
  };

  const productType = ensureType({ code: "product", name: "Product", module: "pim" });
  const revisionType = ensureType({ code: "product-revision", name: "Product revision", module: "pim" });
  const bomType = ensureType({ code: "bom", name: "Bill of materials", module: "pim" });
  const documentType = ensureType({ code: "document", name: "Document", module: "dms" });
  const changeType = ensureType({ code: "change-notice", name: "Change notice", module: "ecm" });
  attach(productType, ["part.number", "part.name", "part.category", "part.status"]);
  attach(revisionType, ["part.number", "part.name", "part.status", "part.revision"]);
  attach(bomType, ["part.number", "part.name", "part.status"]);
  attach(documentType, ["part.number", "part.name", "part.status"]);
  attach(changeType, ["part.number", "part.name", "part.status"]);

  const hasRevision = objects.createRelationshipType(
    db,
    {
      code: "product.has-revision",
      name: "Product has revision",
      module: "pim",
      source_type_id: productType.id,
      target_type_id: revisionType.id,
      cardinality: "1:N",
      semantic: "composition",
      cascade_delete: true,
      status: "active",
      attributes: [{ code: "sequence", name: "Sequence", data_type: "integer", min_value: 0 }],
    },
    actor,
    ip,
    tenantId
  );
  const containsBom = objects.createRelationshipType(
    db,
    {
      code: "revision.contains-bom",
      name: "Revision contains BOM",
      module: "pim",
      source_type_id: revisionType.id,
      target_type_id: bomType.id,
      cardinality: "1:1",
      semantic: "aggregation",
      status: "active",
    },
    actor,
    ip,
    tenantId
  );
  const affects = objects.createRelationshipType(
    db,
    {
      code: "change-notice.affects",
      name: "Change notice affects product",
      module: "ecm",
      source_type_id: changeType.id,
      target_type_id: productType.id,
      cardinality: "N:N",
      semantic: "association",
      status: "active",
    },
    actor,
    ip,
    tenantId
  );
  const documentRef = objects.createRelationshipType(
    db,
    {
      code: "document.references-item",
      name: "Document references item",
      module: "dms",
      source_type_id: documentType.id,
      target_type_id: productType.id,
      cardinality: "N:N",
      semantic: "association",
      status: "active",
    },
    actor,
    ip,
    tenantId
  );

  const make = (typeCode, code, name, data) =>
    objects.createObject(db, { type: typeCode, code, name, data, status: "draft" }, actor, tenantId, ip);

  const product = make("product", "PROD-1000", "Air Compressor", {
    "part.number": "PROD-1000",
    "part.name": "Air Compressor",
    "part.category": "mechanical",
    "part.status": "released",
  });
  const product2 = make("product", "PROD-2000", "Hydraulic Pump", {
    "part.number": "PROD-2000",
    "part.name": "Hydraulic Pump",
    "part.category": "hydraulic",
    "part.status": "draft",
  });
  const revisionA = make("product-revision", "PROD-1000-A", "Air Compressor Rev A", {
    "part.number": "PROD-1000-A",
    "part.name": "Air Compressor Rev A",
    "part.status": "released",
    "part.revision": 1,
  });
  const revisionB = make("product-revision", "PROD-1000-B", "Air Compressor Rev B", {
    "part.number": "PROD-1000-B",
    "part.name": "Air Compressor Rev B",
    "part.status": "draft",
    "part.revision": 2,
  });
  const bom = make("bom", "BOM-1000", "Air Compressor BOM", {
    "part.number": "BOM-1000",
    "part.name": "Air Compressor BOM",
    "part.status": "released",
  });
  const document = make("document", "DOC-1000", "Air Compressor Specification", {
    "part.number": "DOC-1000",
    "part.name": "Air Compressor Specification",
    "part.status": "released",
  });
  const change = make("change-notice", "ECN-1000", "Change oil seal supplier", {
    "part.number": "ECN-1000",
    "part.name": "Change oil seal supplier",
    "part.status": "review",
  });

  objects.createRelationship(
    db,
    { type: hasRevision.id, source: product.id, target: revisionA.id, attributes: { sequence: 1 } },
    actor,
    tenantId,
    ip
  );
  objects.createRelationship(
    db,
    { type: hasRevision.id, source: product.id, target: revisionB.id, attributes: { sequence: 2 } },
    actor,
    tenantId,
    ip
  );
  objects.createRelationship(db, { type: containsBom.id, source: revisionA.id, target: bom.id }, actor, tenantId, ip);
  objects.createRelationship(db, { type: affects.id, source: change.id, target: product.id }, actor, tenantId, ip);
  objects.createRelationship(db, { type: documentRef.id, source: document.id, target: product.id }, actor, tenantId, ip);

  objects.createReference(
    db,
    { source_object_id: document.id, target_object_id: product.id, reference_type: "weak", context: "describes" },
    actor,
    tenantId,
    ip
  );
  objects.createReference(
    db,
    { source_object_id: bom.id, target_object_id: product.id, reference_type: "strong", context: "bom_of" },
    actor,
    tenantId,
    ip
  );
  objects.createReference(
    db,
    {
      source_object_id: revisionA.id,
      target_object_id: product.id,
      reference_type: "strong",
      dependency: true,
      context: "revision_of",
    },
    actor,
    tenantId,
    ip
  );
  objects.createReference(
    db,
    {
      source_object_id: product2.id,
      reference_type: "external",
      external_system: "ERP",
      external_ref: "ERP-PART-2000",
    },
    actor,
    tenantId,
    ip
  );

  return {
    objectsSeeded: true,
    relationshipTypes: [hasRevision.id, containsBom.id, affects.id, documentRef.id],
    objects: [product.id, product2.id, revisionA.id, revisionB.id, bom.id, document.id, change.id],
  };
}

function seedLifecycle(db) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM lifecycle_definitions").get();
  if (existing.c > 0) return { lifecycleSeeded: false };
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  if (!helix || !admin) return { lifecycleSeeded: false };
  const tenantId = helix.id;
  const actor = { id: admin.id, username: admin.username };
  const ip = "seed";

  const statusDefs = [
    { code: "draft", name: "Draft", category: "draft", legacy_status: "draft", display_order: 10, color: "#9ca3af", is_default: true },
    { code: "in-review", name: "In Review", category: "in_review", legacy_status: "active", display_order: 20, color: "#f59e0b" },
    { code: "approved", name: "Approved", category: "approved", legacy_status: "active", display_order: 30, color: "#3b82f6" },
    { code: "released", name: "Released", category: "released", legacy_status: "released", display_order: 40, color: "#10b981" },
    { code: "obsolete", name: "Obsolete", category: "obsolete", legacy_status: "obsolete", display_order: 50, color: "#6b7280" },
    { code: "cancelled", name: "Cancelled", category: "cancelled", legacy_status: "obsolete", display_order: 60, color: "#ef4444" },
  ];
  const statusIds = {};
  for (const def of statusDefs) {
    const row = lifecycle.createStatus(db, { ...def, module: "pdm", tenant_id: tenantId }, actor, ip, tenantId);
    statusIds[def.code] = row.id;
  }

  const created = lifecycle.createDefinition(
    db,
    {
      code: "product-lifecycle",
      name: "Product Lifecycle",
      description: "Draft, review, approval, release and obsolescence for products",
      module: "pdm",
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );
  const versionId = created.version.id;

  const stateDefs = [
    { code: "draft", name: "Draft", status_code: "draft", category: "draft", is_initial: true, display_order: 10, editable: true },
    { code: "in-review", name: "In Review", status_code: "in-review", category: "in_review", display_order: 20 },
    { code: "approved", name: "Approved", status_code: "approved", category: "approved", display_order: 30 },
    { code: "released", name: "Released", status_code: "released", category: "released", display_order: 40 },
    { code: "obsolete", name: "Obsolete", status_code: "obsolete", category: "obsolete", is_terminal: true, display_order: 50 },
    { code: "cancelled", name: "Cancelled", status_code: "cancelled", category: "cancelled", is_terminal: true, display_order: 60 },
  ];
  for (const state of stateDefs) {
    lifecycle.createState(db, { ...state, lifecycle_version_id: versionId, tenant_id: tenantId }, actor, ip, tenantId);
  }

  const transitionDefs = [
    { code: "submit", name: "Submit for review", from_state: "draft", to_state: "in-review", display_order: 10 },
    { code: "approve", name: "Approve", from_state: "in-review", to_state: "approved", requires_approval: true, display_order: 20 },
    { code: "reject", name: "Reject", from_state: "in-review", to_state: "draft", display_order: 30 },
    { code: "release", name: "Release", from_state: "approved", to_state: "released", required_permission: "iam.lifecycle.release-rules:execute", display_order: 40 },
    { code: "obsolete", name: "Mark obsolete", from_state: "released", to_state: "obsolete", display_order: 50 },
    { code: "cancel", name: "Cancel", from_state: "draft", to_state: "cancelled", display_order: 60 },
  ];
  for (const transition of transitionDefs) {
    lifecycle.createTransition(db, { ...transition, lifecycle_version_id: versionId, tenant_id: tenantId }, actor, ip, tenantId);
  }

  const publishReport = lifecycle.publishDefinition(db, created.definition.id, {}, actor, ip, tenantId);

  const draftState = lifecycle.stateByCode(db, versionId, "draft");
  lifecycle.createRule(
    db,
    {
      code: "product-approval",
      name: "Product approval",
      kind: "approval",
      module: "pdm",
      transition: "approve",
      require_all: true,
      min_approvals: 1,
      mandatory_comment_on_reject: true,
      auto_transition: true,
      rollback_state_id: draftState?.id ?? null,
      steps: [
        { code: "engineering", name: "Engineering sign-off", approver_type: "role", approver_id: "iam.admin", approval_mode: "all" },
      ],
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  const productType = metadata.findType(db, "product", tenantId);
  let assigned = 0;
  if (productType) {
    lifecycle.createAssignment(
      db,
      { type: "product", lifecycle: "product-lifecycle", is_default: true, tenant_id: tenantId },
      actor,
      ip,
      tenantId
    );
    const versionRow = queryOne(db, "SELECT * FROM lifecycle_versions WHERE id = ?", [versionId]);
    const initial = lifecycle.initialStateForVersion(db, versionId);
    const objectsWithoutLifecycle = queryAll(
      db,
      "SELECT * FROM objects WHERE object_type_id = ? AND lifecycle_version_id IS NULL AND deleted_at IS NULL",
      [productType.id]
    );
    for (const obj of objectsWithoutLifecycle) {
      lifecycle.assignLifecycle(db, obj, versionRow, initial, actor);
      assigned += 1;
    }
  }

  return {
    lifecycleSeeded: true,
    lifecycleDefinition: created.definition.id,
    lifecycleVersion: publishReport?.version?.version ?? created.version.version,
    lifecycleStatuses: Object.keys(statusIds).length,
    lifecycleObjectsAssigned: assigned,
  };
}

function seedWorkflow(db) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM workflow_definitions").get();
  if (existing.c > 0) return { workflowSeeded: false };
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  if (!helix || !admin) return { workflowSeeded: false };
  const tenantId = helix.id;
  const actor = { id: admin.id, username: admin.username };
  const ip = "seed";

  const approvalRule = lifecycle.createRule(
    db,
    {
      code: "change-approval",
      name: "Change request approval",
      kind: "approval",
      module: "workflow",
      require_all: true,
      min_approvals: 1,
      mandatory_comment_on_reject: true,
      steps: [{ code: "reviewer", name: "Reviewer sign-off", approver_type: "role", approver_id: "iam.admin", approval_mode: "all" }],
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  const graph = {
    nodes: [
      { node_key: "start", type: "start", name: "Start", position_x: 60, position_y: 180, display_order: 0 },
      {
        node_key: "assess",
        type: "task",
        name: "Assess change request",
        description: "Review the change scope and impact",
        position_x: 260,
        position_y: 180,
        display_order: 10,
        config: { assignee_type: "role", assignee_ref: "iam.admin", priority: "high", due_minutes: 2880, escalation_minutes: 1440 },
      },
      {
        node_key: "approve",
        type: "approval",
        name: "Approve change",
        position_x: 500,
        position_y: 180,
        display_order: 20,
        config: { approval_rule_id: approvalRule.id },
      },
      { node_key: "route", type: "decision", name: "High priority?", position_x: 740, position_y: 180, display_order: 30 },
      {
        node_key: "notify",
        type: "notification",
        name: "Notify stakeholders",
        position_x: 960,
        position_y: 80,
        display_order: 40,
        config: { subject: "High priority change approved", body: "Change {{instance_code}} was approved.", recipients: [] },
      },
      { node_key: "end", type: "end", name: "End", position_x: 1200, position_y: 180, display_order: 50 },
    ],
    transitions: [
      { transition_key: "start-assess", from_node_key: "start", to_node_key: "assess", display_order: 0 },
      { transition_key: "assess-approve", from_node_key: "assess", to_node_key: "approve", display_order: 1 },
      { transition_key: "approve-route", from_node_key: "approve", to_node_key: "route", display_order: 2 },
      {
        transition_key: "route-notify",
        from_node_key: "route",
        to_node_key: "notify",
        condition: { field: "priority", operator: "eq", value: "high" },
        display_order: 3,
      },
      { transition_key: "route-end", from_node_key: "route", to_node_key: "end", is_default: true, display_order: 4 },
      { transition_key: "notify-end", from_node_key: "notify", to_node_key: "end", display_order: 5 },
    ],
  };

  const created = workflow.createDefinition(
    db,
    {
      code: "change-request-review",
      name: "Change Request Review",
      description: "Assess, approve and route engineering change requests",
      category: "quality",
      module: "pdm",
      tenant_id: tenantId,
      graph,
    },
    actor,
    ip,
    tenantId
  );
  workflow.publishDefinition(db, created.id, { notes: "Seeded demo workflow" }, actor, ip, tenantId);

  workflow.createRoutingRule(
    db,
    {
      code: "change-high-priority",
      name: "Route high priority changes",
      definition_id: created.id,
      node_type: "task",
      priority: 10,
      condition: { field: "priority", operator: "eq", value: "high" },
      assignee_type: "role",
      assignee_ref: "iam.admin",
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  workflow.createEscalationRule(
    db,
    {
      code: "change-overdue",
      name: "Escalate overdue change tasks",
      definition_id: created.id,
      after_minutes: 1440,
      action: "raise_priority",
      priority: "urgent",
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  workflow.createTemplate(
    db,
    {
      code: "task-assigned",
      name: "Task assigned",
      channel: "in_app",
      subject: "New task: {{title}}",
      body: "Task {{code}} is assigned to you.",
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  workflow.createBinding(
    db,
    {
      code: "release-to-change-review",
      name: "Start change review when a release is approved",
      event: "lifecycle.release.approved",
      definition_id: created.id,
      context_map: { object_code: "object_code", release_id: "release_id" },
      tenant_id: tenantId,
    },
    actor,
    ip,
    tenantId
  );

  const changeObject = queryOne(db, "SELECT id FROM objects WHERE code = 'ECN-1000' AND deleted_at IS NULL");
  let instanceId = null;
  try {
    const instance = workflow.startInstance(
      db,
      {
        definition_id: created.id,
        title: "ECN-1000 engineering change review",
        object_id: changeObject?.id ?? null,
        context: { priority: "high", source: "seed" },
      },
      actor,
      tenantId,
      ip
    );
    instanceId = instance.id;
  } catch {
    /* demo instance is best effort; the template is what matters */
  }

  return {
    workflowSeeded: true,
    workflowDefinition: created.id,
    workflowApprovalRule: approvalRule.id,
    workflowInstance: instanceId,
  };
}

// Audit & History Framework seed: a system policy, a tenant override that
// demonstrates visibility/tracking/masking, and a small set of sample events so
// the console has content on a fresh installation.
function seedAudit(db) {
  audit.ensureDefaultPolicies(db);
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username, display_name FROM users WHERE username = 'admin'");
  const tenantId = helix?.id || null;
  const actor = admin
    ? { id: admin.id, username: admin.username, display_name: admin.display_name, tenant_id: tenantId }
    : { username: "system", tenant_id: tenantId };

  if (tenantId) {
    const existing = queryOne(
      db,
      "SELECT id FROM audit_policies WHERE tenant_id = ? AND object_type = 'part'",
      [tenantId]
    );
    if (!existing) {
      audit.createPolicy(
        db,
        {
          tenant_id: tenantId,
          name: "Part history",
          description: "Full part history visible to object users, with supplier masked.",
          object_type: "part",
          visibility: "user",
          capture_views: true,
          capture_downloads: true,
          track_attributes: [
            "part.name",
            "part.category",
            "part.status",
            "part.revision",
            "part.weight_kg",
            "part.notes",
          ],
          masked_attributes: ["part.supplier"],
          retention_days: 3650,
        },
        admin ? { id: admin.id } : null,
        tenantId
      );
    }
  }

  const marker = queryOne(
    db,
    "SELECT 1 AS x FROM audit_logs WHERE resource_type = 'part' AND resource_id = 'PART-000001' LIMIT 1"
  );
  if (marker) return { auditSeeded: false };

  const common = {
    actor,
    tenant_id: tenantId,
    source: "ui",
    ip: "10.20.30.40",
    device: "Mozilla/5.0 (seed)",
    correlation_id: "seed-correlation-1",
  };

  audit.capture(db, {
    ...common,
    action: "auth.session.create",
    event_type: "LOGIN",
    object_type: "session",
    object_id: "seed-session",
    status: "success",
    details: { provider: "password" },
  });
  audit.capture(db, {
    ...common,
    action: "object.create",
    object_type: "part",
    object_id: "PART-000001",
    object_name: "Hydraulic bracket",
    before: null,
    after: {
      "part.number": "PART-000001",
      "part.name": "Hydraulic bracket",
      "part.category": "mechanical",
      "part.status": "draft",
      "part.revision": 1,
      "part.weight_kg": 2.4,
      "part.supplier": "Acme Metals",
    },
    reason: "Initial part release",
  });
  audit.capture(db, {
    ...common,
    action: "object.update",
    object_type: "part",
    object_id: "PART-000001",
    object_name: "Hydraulic bracket",
    before: { "part.weight_kg": 2.4, "part.notes": null, "part.supplier": "Acme Metals" },
    after: { "part.weight_kg": 2.6, "part.notes": "Tolerance tightened", "part.supplier": "Acme Metals" },
    reason: "Design change after review",
    correlation_id: "seed-correlation-2",
  });
  audit.capture(db, {
    ...common,
    action: "object.status.released",
    event_type: "STATE_CHANGE",
    object_type: "part",
    object_id: "PART-000001",
    object_name: "Hydraulic bracket",
    before: { status: "draft" },
    after: { status: "released" },
    reason: "Approved by engineering",
  });
  audit.capture(db, {
    ...common,
    action: "workflow.task.complete",
    event_type: "WORKFLOW_ACTION",
    object_type: "workflow_instance",
    object_id: "1",
    object_name: "Change request review",
    details: { node: "assess", outcome: "done" },
    source: "workflow",
  });
  audit.capture(db, {
    ...common,
    action: "relationship.create",
    event_type: "RELATIONSHIP_CHANGE",
    object_type: "part",
    object_id: "PART-000001",
    object_name: "Hydraulic bracket",
    related: { relationship_type: "bom-parent", related_object_id: "ASM-000010" },
  });
  audit.capture(db, {
    ...common,
    action: "access.unauthenticated",
    event_type: "ACCESS_DENIED",
    object_type: "http_request",
    object_id: "GET /api/audit/events",
    status: "failure",
    error_message: "Authentication required",
    actor: { username: "anonymous", tenant_id: tenantId },
    ip: "203.0.113.7",
    source: "api",
  });
  audit.capture(db, {
    ...common,
    action: "audit.export",
    event_type: "EXPORT",
    object_type: "audit_event",
    object_id: "csv",
    details: { format: "csv", filters: { objectType: "part" } },
  });
  return { auditSeeded: true };
}

// Default notification configuration: providers, system templates, system rules,
// per-user preferences and a couple of sample notifications so the inbox has
// content in a fresh environment. Idempotent: a global "task.assigned" template
// is used as the presence marker.
function seedNotifications(db) {
  notifications.ensureDefaultProviders(db);

  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const tenantId = helix?.id || null;
  const admin = queryOne(db, "SELECT id, username, display_name, email, organization_id FROM users WHERE username = 'admin'");
  const operator = queryOne(db, "SELECT id, username, display_name, email, organization_id FROM users WHERE username = 'j.patel'");
  const actor = admin
    ? { id: admin.id, username: admin.username, display_name: admin.display_name, tenant_id: tenantId }
    : { username: "system", tenant_id: tenantId };

  const ensurePrefs = () => {
    for (const user of queryAll(db, "SELECT id, tenant_id FROM users")) {
      try {
        notifications.ensureDefaultPreferences(db, user.id, user.tenant_id ?? tenantId);
      } catch {
        /* preferences are best-effort during seeding */
      }
    }
  };

  const marker = queryOne(db, "SELECT id FROM notification_templates WHERE code = 'task.assigned' AND tenant_id IS NULL");
  if (marker) {
    ensurePrefs();
    return { notificationsSeeded: false };
  }

  const templateDefs = [
    {
      code: "task.assigned",
      name: "Task assigned",
      description: "In-app notification when a workflow task is assigned.",
      event_type: "task.assigned",
      channel: "in_app",
      subject: "New task: {{object.name}}",
      html_body:
        '<p>Hi {{recipient.name}} {{recipient.username}},</p><p>You have been assigned <strong>{{object.name}}</strong>.</p><p>Due: {{dueDate}}.</p><p><a href="{{applicationUrl}}{{link}}">Open task</a></p>',
      text_body: "You have been assigned {{object.name}}. Due {{dueDate}}.",
    },
    {
      code: "task.assigned",
      name: "Task assigned (email)",
      description: "Email notification when a workflow task is assigned.",
      event_type: "task.assigned",
      channel: "email",
      subject: "[Action required] {{object.name}}",
      html_body:
        '<p>Hello {{recipient.username}},</p><p>The task <strong>{{object.name}}</strong> has been assigned to you.</p><p>Due: {{dueDate}}.</p>',
      text_body: "The task {{object.name}} has been assigned to you. Due {{dueDate}}.",
    },
    {
      code: "task.overdue",
      name: "Task overdue",
      description: "Reminder when a task passes its due date.",
      event_type: "task.overdue",
      channel: "in_app",
      subject: "Overdue: {{object.name}}",
      html_body: '<p>The task <strong>{{object.name}}</strong> is overdue (due {{dueDate}}).</p>',
      text_body: "The task {{object.name}} is overdue. Due {{dueDate}}.",
    },
    {
      code: "change.request.rejected",
      name: "Change request rejected",
      description: "Notifies the requester when a change request is rejected.",
      event_type: "change.request.rejected",
      channel: "in_app",
      subject: "Change request rejected: {{object.name}}",
      html_body:
        '<p>Your change request <strong>{{object.name}}</strong> was rejected.</p><p>Reason: {{reason}}</p>',
      text_body: "Your change request {{object.name}} was rejected. Reason: {{reason}}",
    },
    {
      code: "bom.released",
      name: "BOM released",
      description: "Notifies stakeholders when a bill of materials is released.",
      event_type: "bom.released",
      channel: "in_app",
      subject: "BOM released: {{object.name}}",
      html_body: '<p>The BOM <strong>{{object.name}}</strong> has been released.</p><p><a href="{{applicationUrl}}{{link}}">View BOM</a></p>',
      text_body: "The BOM {{object.name}} has been released.",
    },
    {
      code: "approval.requested",
      name: "Approval requested",
      description: "Notifies an approver that a decision is required.",
      event_type: "approval.requested",
      channel: "in_app",
      subject: "Approval requested: {{object.name}}",
      html_body:
        '<p>An approval is waiting for you on <strong>{{object.name}}</strong>.</p><p><a href="{{applicationUrl}}{{link}}">Review</a></p>',
      text_body: "An approval is waiting for you on {{object.name}}.",
    },
    {
      code: "lifecycle.state.changed",
      name: "Lifecycle state changed",
      description: "Notifies object stakeholders of a state transition.",
      event_type: "lifecycle.state.changed",
      channel: "in_app",
      subject: "{{object.name}} is now {{status}}",
      html_body: '<p><strong>{{object.name}}</strong> moved to status <strong>{{status}}</strong>.</p>',
      text_body: "{{object.name}} moved to status {{status}}.",
    },
  ];

  for (const def of templateDefs) {
    try {
      const row = notifications.createTemplate(db, { ...def, tenant_id: null }, actor, "seed", null);
      run(db, "UPDATE notification_templates SET is_system = 1 WHERE id = ?", [row.id]);
    } catch (err) {
      if (!String(err.message).includes("already exists")) throw err;
    }
  }

  const ruleDefs = [
    {
      code: "task-assigned",
      name: "Task assigned",
      description: "Notify the assignee in-app and by email, with a due-date reminder.",
      event_type: "task.assigned",
      template_code: "task.assigned",
      channels: ["in_app", "email"],
      priority: "high",
      recipient: { items: [{ type: "event_payload", value: "assignee_id" }] },
      reminder: { enabled: true, offset_minutes: 1440, subject: "Reminder: {{object.name}} is due", repeat_minutes: 1440, max_repeats: 2 },
    },
    {
      code: "task-overdue",
      name: "Task overdue",
      description: "Remind the assignee when a task is overdue.",
      event_type: "task.overdue",
      template_code: "task.overdue",
      channels: ["in_app"],
      priority: "urgent",
      recipient: { items: [{ type: "event_payload", value: "assignee_id" }] },
    },
    {
      code: "change-rejected",
      name: "Change request rejected",
      description: "Notify the requester when a change request is rejected.",
      event_type: "change.request.rejected",
      template_code: "change.request.rejected",
      channels: ["in_app", "email"],
      priority: "high",
      recipient: { items: [{ type: "event_payload", value: "requester_id" }], fallback: [{ type: "initiator" }] },
    },
    {
      code: "bom-released",
      name: "BOM released",
      description: "Notify the object owner and responsible organization when a BOM is released.",
      event_type: "bom.released",
      template_code: "bom.released",
      channels: ["in_app"],
      recipient: {
        items: [{ type: "event_payload", value: "owner_id" }],
        fallback: [{ type: "initiator" }],
      },
    },
    {
      code: "approval-requested",
      name: "Approval requested",
      description: "Notify the approver that a decision is required.",
      event_type: "approval.requested",
      template_code: "approval.requested",
      channels: ["in_app"],
      priority: "high",
      recipient: { items: [{ type: "event_payload", value: "approver_id" }], fallback: [{ type: "initiator" }] },
    },
    {
      code: "lifecycle-state-changed",
      name: "Lifecycle state changed",
      description: "Notify the object owner when a lifecycle state changes.",
      event_type: "lifecycle.state.changed",
      template_code: "lifecycle.state.changed",
      channels: ["in_app"],
      recipient: {
        items: [{ type: "event_payload", value: "owner_id" }],
        fallback: [{ type: "initiator" }],
      },
    },
  ];

  for (const def of ruleDefs) {
    try {
      const row = notifications.createRule(db, { ...def, tenant_id: null }, actor, "seed", null);
      run(db, "UPDATE notification_rules SET is_system = 1 WHERE id = ?", [row.id]);
    } catch (err) {
      if (!String(err.message).includes("already exists")) throw err;
    }
  }

  ensurePrefs();

  if (tenantId && admin) {
    const assigneeId = operator?.id ?? admin.id;
    notifications.publish(
      db,
      {
        event_type: "task.assigned",
        source_module: "workflow",
        tenant_id: tenantId,
        object_type: "task",
        object_id: "TASK-1001",
        object_name: "Inspect hydraulic manifold",
        initiator: { id: admin.id, username: admin.username },
        payload: { assignee_id: assigneeId, due_date: "2026-09-25", link: "/workflow/tasks/1001" },
      },
      { actor }
    );
    notifications.publish(
      db,
      {
        event_type: "approval.requested",
        source_module: "lifecycle",
        tenant_id: tenantId,
        object_type: "part",
        object_id: "PART-000001",
        object_name: "Hydraulic bracket",
        initiator: { id: operator?.id ?? admin.id, username: operator?.username ?? admin.username },
        payload: { approver_id: admin.id, link: "/lifecycle/approvals/1" },
      },
      { actor }
    );
  }

  return { notificationsSeeded: true };
}

// Idempotent delivery-module seed. Ensures the built-in store/email providers
// exist and registers placeholder entries for the future external channels so
// administrators can see and configure them from the delivery console without
// the platform sending anything by default.
function seedDelivery(db) {
  delivery.ensureDefaultProviders(db);
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username, display_name, email FROM users WHERE username = 'admin'");
  const actor = admin
    ? { id: admin.id, username: admin.username, display_name: admin.display_name, tenant_id: helix?.id ?? null }
    : { username: "system", tenant_id: helix?.id ?? null };
  const defs = [
    { code: "teams-webhook", name: "Microsoft Teams (webhook)", channel: "teams", type: "teams", enabled: false, status: "inactive", config: {} },
    { code: "slack-webhook", name: "Slack (webhook)", channel: "slack", type: "slack", enabled: false, status: "inactive", config: {} },
  ];
  for (const def of defs) {
    if (queryOne(db, "SELECT id FROM notification_providers WHERE code = ?", [def.code])) continue;
    try {
      delivery.createDeliveryProvider(db, def, actor, "seed");
    } catch (err) {
      if (!String(err.message).includes("already exists")) throw err;
    }
  }
  return { deliverySeeded: true };
}

// Registers the standard job types every business module exposes and a small,
// representative set of sample jobs so the dashboard is meaningful on a fresh
// install. Idempotent: sample jobs are only created when the table is empty.
function seedJobs(db) {
  jobs.ensureDefaultJobTypes(db);
  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM jobs").c;
  if (existing > 0) return { jobsSeeded: true, jobTypesSeeded: true };
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username, display_name, email FROM users WHERE username = 'admin'");
  const actor = admin
    ? { id: admin.id, username: admin.username, display_name: admin.display_name, tenant_id: helix?.id ?? null, organization_id: helix?.id ?? null }
    : null;
  const context = { actor };
  const hire = queryOne(db, "SELECT id, code, name FROM organizations WHERE code = 'helix' ORDER BY id LIMIT 1");

  const samples = [
    {
      type: "REPORT_GENERATION",
      idempotency_key: "seed:job:report",
      name: "Quarterly cost rollup",
      description: "Roll up approved cost records into the quarterly report.",
      related_object_type: "report",
      related_object_name: "Quarterly cost rollup",
    },
    {
      type: "DATA_SYNC",
      idempotency_key: "seed:job:sync",
      name: "ERP item master sync",
      description: "Synchronize the item master with the ERP system.",
      related_object_type: "integration",
      related_object_name: "ERP item master",
    },
    {
      type: "CAD_PROCESSING",
      idempotency_key: "seed:job:cad",
      name: "Tessellate housing assembly",
      description: "Generate viewable geometry for the housing assembly.",
      related_object_type: "part",
      related_object_name: "Housing assembly",
    },
    {
      type: "BULK_IMPORT",
      idempotency_key: "seed:job:import",
      name: "Supplier contacts import",
      description: "Import 2,400 supplier contacts from a spreadsheet.",
      related_object_type: "import",
      related_object_name: "Supplier contacts",
    },
    {
      type: "SEARCH_INDEXING",
      idempotency_key: "seed:job:index",
      name: "Nightly search reindex",
      description: "Reindex all published documents for full-text search.",
      delay_seconds: 3600,
      related_object_type: "index",
      related_object_name: "Document index",
    },
  ];

  const created = [];
  for (const sample of samples) {
    try {
      const job = jobs.submitJob(
        db,
        { ...sample, job_type_code: sample.type, tenant_id: helix?.id ?? null, organization_id: hire?.id ?? null },
        context
      );
      created.push(job);
    } catch (err) {
      if (!String(err.message).includes("already exists")) throw err;
    }
  }

  const byKey = (key) => created.find((job) => job.idempotency_key === key);
  const report = byKey("seed:job:report");
  if (report) {
    jobs.transitionJob(db, report.id, "running", { actorId: admin?.id ?? null, source: "engine" });
    jobs.updateProgress(db, report.id, { progress: 100, stage: "finalize", message: "Report rendered" }, {});
    jobs.transitionJob(db, report.id, "completed", { actorId: admin?.id ?? null, source: "engine" });
    const row = jobs.getJobRow(db, report.id);
    jobs.setJobResult(db, row, { result: { rows: 1840, duration_seconds: 214 }, result_ref: "doc://reports/quarterly-cost-rollup" }, {});
    jobs.addArtifact(db, report.id, {
      kind: "report",
      name: "Quarterly cost rollup (PDF)",
      filename: "quarterly-cost-rollup.pdf",
      content_type: "application/pdf",
      size: 284113,
      storage_ref: "doc://reports/quarterly-cost-rollup.pdf",
    });
  }

  const sync = byKey("seed:job:sync");
  if (sync) {
    jobs.transitionJob(db, sync.id, "running", { actorId: admin?.id ?? null, source: "engine" });
    jobs.transitionJob(db, sync.id, "failed", {
      actorId: admin?.id ?? null,
      source: "engine",
      errorCode: "erp_timeout",
      errorMessage: "The ERP gateway did not respond within 300 seconds",
    });
  }

  const cad = byKey("seed:job:cad");
  if (cad) {
    jobs.transitionJob(db, cad.id, "running", { actorId: admin?.id ?? null, source: "engine" });
    jobs.updateProgress(db, cad.id, { progress: 42, stage: "tessellate", message: "Processing mesh 3 of 7" }, {});
  }

  return { jobsSeeded: true, jobTypesSeeded: true, sampleJobs: created.length };
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
  seedMetadata(db);
  seedObjects(db);
  seedLifecycle(db);
  seedWorkflow(db);
  seedAudit(db);
  seedNotifications(db);
  seedDelivery(db);
  seedJobs(db);
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
