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
import * as jobExecution from "./services/job-execution.js";
import * as search from "./services/search.js";
import * as integration from "./services/integration.js";
import * as events from "./services/events.js";
import { withEventSuppression } from "./services/events/emit.js";
import * as numbering from "./services/numbering.js";
import * as versioning from "./services/versioning.js";
import * as reference from "./services/reference.js";
import * as content from "./services/content.js";
import * as dataGovernance from "./services/data-governance/index.js";
import * as dataCatalog from "./services/data-catalog/index.js";
import * as dataLifecycle from "./services/data-lifecycle/index.js";
import * as dataExchange from "./services/data-exchange/index.js";
import * as migration from "./services/migration/index.js";
import * as classification from "./services/classification/index.js";
import * as bom from "./services/bom/index.js";
import * as pdm from "./services/pdm/index.js";
import * as thread from "./services/thread/index.js";
import * as exchange from "./services/exchange/index.js";
import * as reporting from "./services/reporting/index.js";
import * as observability from "./services/observability/index.js";
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
    grants.grantRolePermission(
      db,
      roleId,
      {
        permission_id: permission.id,
        effect: "allow",
        organization_id: organizationId,
      },
      undefined,
      undefined,
      { returnList: false }
    );
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
      grants.grantRolePermission(
        db,
        auditor.id,
        {
          permission_id: delUsers.id,
          effect: "deny",
          organization_id: apac?.id || 0,
        },
        undefined,
        undefined,
        { returnList: false }
      );
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
    { applicationCode: "iam", code: "iam.jobs.queues", name: "Job queue administration", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.schedules", name: "Job schedule administration", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.jobs.execution", name: "Job execution monitoring & dead-letter", parentCode: "iam.jobs" },
    { applicationCode: "iam", code: "iam.files", name: "Document & file management", kind: "module" },
    { applicationCode: "iam", code: "iam.files.browser", name: "File browser & search", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.details", name: "File details, metadata & download", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.uploads", name: "File uploads", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.versions", name: "File versions", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.locks", name: "Check-out/check-in locks", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.associations", name: "File associations", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.folders", name: "Folders & collections", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.files.permissions", name: "File access control", parentCode: "iam.files" },
    { applicationCode: "iam", code: "iam.search", name: "Search & discovery", kind: "module" },
    { applicationCode: "iam", code: "iam.search.global", name: "Global search", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.advanced", name: "Advanced search", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.saved", name: "Saved searches", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.history", name: "Search history", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.indexes", name: "Search index administration", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.configuration", name: "Search configuration", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.search.export", name: "Search result exports", parentCode: "iam.search" },
    { applicationCode: "iam", code: "iam.security", name: "Data security & entitlements", kind: "module" },
    { applicationCode: "iam", code: "iam.security.console", name: "Security console & overview", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.policies", name: "Security policy administration", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.entitlements", name: "Entitlement administration", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.fields", name: "Field security & masking", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.classifications", name: "Classification security", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.organizations", name: "Organization & plant security", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.objecttypes", name: "Security object type registration", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.security.decisions", name: "Authorization decision inspector", parentCode: "iam.security" },
    { applicationCode: "iam", code: "iam.integration", name: "Integration & API framework", kind: "module" },
    { applicationCode: "iam", code: "iam.integration.systems", name: "External systems & credentials", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.endpoints", name: "Integration endpoints", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.transforms", name: "Transformation & mapping definitions", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.mappings", name: "External object mapping", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.schedules", name: "Scheduled integrations", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.events", name: "Events & subscriptions", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.webhooks", name: "Webhooks", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.messages", name: "Message queues", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.deadletters", name: "Dead-letter queues", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.transfers", name: "Import & export", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.monitoring", name: "Integration monitoring", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.integration.api", name: "API catalog & clients", parentCode: "iam.integration" },
    { applicationCode: "iam", code: "iam.events", name: "Event & messaging framework", kind: "module" },
    { applicationCode: "iam", code: "iam.events.registry", name: "Event type & schema registry", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.publish", name: "Event publishing", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.subscriptions", name: "Event subscriptions", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.topology", name: "Topics, queues & consumer groups", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.deliveries", name: "Event deliveries & consumers", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.deadletters", name: "Event dead letters", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.replay", name: "Event replay", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.retention", name: "Event retention", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.events.monitoring", name: "Event monitoring & traceability", parentCode: "iam.events" },
    { applicationCode: "iam", code: "iam.numbering", name: "Numbering & identifier service", kind: "module" },
    { applicationCode: "iam", code: "iam.numbering.schemes", name: "Numbering scheme administration", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.objecttypes", name: "Numbering object types", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.sequences", name: "Sequence administration & reset", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.allocations", name: "Allocation history & export", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.generate", name: "Generate & preview identifiers", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.reserve", name: "Reserve identifiers", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.consume", name: "Consume identifiers", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.release", name: "Release & cancel identifiers", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.manual", name: "Manual numbering", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.numbering.metrics", name: "Numbering monitoring & metrics", parentCode: "iam.numbering" },
    { applicationCode: "iam", code: "iam.versioning", name: "Effectivity & versioning kernel", kind: "module" },
    { applicationCode: "iam", code: "iam.versioning.revisions", name: "Revision management", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.versions", name: "Version management", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.effectivities", name: "Effectivity definitions & assignments", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.resolve", name: "As-of effectivity resolution", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.baselines", name: "Baseline management", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.snapshots", name: "Historical snapshots", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.variants", name: "Variant & option management", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.configurations", name: "Configuration context management", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.policies", name: "Resolution policy administration", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.versioning.metrics", name: "Versioning monitoring & metrics", parentCode: "iam.versioning" },
    { applicationCode: "iam", code: "iam.reference", name: "Enterprise reference data management", kind: "module" },
    { applicationCode: "iam", code: "iam.reference.domains", name: "Reference domains & ownership", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.items", name: "Reference data items & lifecycle", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.codes", name: "Reference codes", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.aliases", name: "Reference aliases", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.translations", name: "Reference translations", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.hierarchy", name: "Reference hierarchy", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.relationships", name: "Reference relationships", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.scopes", name: "Reference scope policies", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.versions", name: "Reference data versions", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.approvals", name: "Reference approvals", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.governance", name: "Reference governance & change requests", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.import", name: "Reference data import", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.export", name: "Reference data export", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.resolve", name: "Reference data resolution & validation", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.reference.metrics", name: "Reference data monitoring & metrics", parentCode: "iam.reference" },
    { applicationCode: "iam", code: "iam.content", name: "File & content management service", kind: "module" },
    { applicationCode: "iam", code: "iam.content.browser", name: "Content browser & search", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.details", name: "Content details, metadata & download", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.uploads", name: "Content uploads", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.versions", name: "Content versions", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.locks", name: "Content check-out/check-in locks", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.associations", name: "Object-content associations", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.renditions", name: "Content renditions & previews", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.processing", name: "Content processing & pipelines", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.security", name: "Content security & quarantine", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.retention", name: "Content retention & legal hold", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.content.admin", name: "Content administration", parentCode: "iam.content" },
    { applicationCode: "iam", code: "iam.data_governance", name: "Data governance & data quality service", kind: "module" },
    { applicationCode: "iam", code: "iam.data_governance.domains", name: "Data domains & hierarchy", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.catalog", name: "Data catalogue & attributes", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.ownership", name: "Ownership & stewardship", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.policies", name: "Governance policies & lifecycle", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.configuration", name: "Governance configuration & scoring", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.dimensions", name: "Quality dimensions & scoring bands", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.jobs", name: "Governance & quality background jobs", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_governance.metrics", name: "Governance metrics & health", parentCode: "iam.data_governance" },
    { applicationCode: "iam", code: "iam.data_quality", name: "Data quality rules & evaluation", kind: "module" },
    { applicationCode: "iam", code: "iam.data_quality.rules", name: "Quality rules & validation", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_quality.evaluation", name: "Quality evaluation & execution modes", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_quality.results", name: "Quality results, scores & dashboards", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_quality.exceptions", name: "Quality exceptions & workflow", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_quality.duplicates", name: "Duplicate detection", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_quality.remediation", name: "Quality remediation", parentCode: "iam.data_quality" },
    { applicationCode: "iam", code: "iam.data_catalog", name: "Data catalog & business glossary service", kind: "module" },
    { applicationCode: "iam", code: "iam.data_catalog.overview", name: "Unified catalog registry & overview", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.domains", name: "Catalog domains", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.objects", name: "Catalog data objects", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.attributes", name: "Catalog attributes", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.glossary", name: "Business glossary", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.terms", name: "Business terms & definitions", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.sources", name: "Data sources", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.consumers", name: "Data consumers", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.mappings", name: "Source & consumer mappings", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.lineage", name: "Data lineage & impact analysis", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.relationships", name: "Catalog relationships", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.classifications", name: "Catalog classifications", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.ownership", name: "Catalog ownership & stewardship", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.import_export", name: "Catalog metadata import & export", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.admin", name: "Catalog administration & configuration", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.jobs", name: "Catalog background jobs", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_catalog.metrics", name: "Catalog metrics & health", parentCode: "iam.data_catalog" },
    { applicationCode: "iam", code: "iam.data_lifecycle", name: "Data lifecycle & archival service", kind: "module" },
    { applicationCode: "iam", code: "iam.data_lifecycle.overview", name: "Lifecycle overview & registry", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.states", name: "Lifecycle states & transitions", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.policies", name: "Retention policies", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.objects", name: "Tracked object lifecycles", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.eligibility", name: "Lifecycle eligibility engine", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.archive", name: "Archive & cold storage", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.restore", name: "Restore operations", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.recovery", name: "Recovery operations", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.purge", name: "Purge operations", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.legal_holds", name: "Legal holds", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.dependencies", name: "Lifecycle dependencies", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.jobs", name: "Lifecycle background jobs", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.metrics", name: "Lifecycle metrics & health", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_lifecycle.admin", name: "Lifecycle administration & configuration", parentCode: "iam.data_lifecycle" },
    { applicationCode: "iam", code: "iam.data_exchange", name: "Import & export framework service", kind: "module" },
    { applicationCode: "iam", code: "iam.data_exchange.overview", name: "Data exchange overview & catalogue", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.imports", name: "Data imports", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.import_definitions", name: "Import definitions & mappings", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.exports", name: "Data exports", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.export_definitions", name: "Export definitions & field selection", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.connectors", name: "Connector configurations & credentials", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.mapping", name: "Field mapping engine", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.validation", name: "Import validation engine", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.reconciliation", name: "Import reconciliation", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.templates", name: "Import & export templates", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.history", name: "Data exchange history", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.jobs", name: "Data exchange background jobs", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.metrics", name: "Data exchange metrics & health", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.data_exchange.admin", name: "Data exchange administration & configuration", parentCode: "iam.data_exchange" },
    { applicationCode: "iam", code: "iam.migration", name: "Migration & onboarding framework service", kind: "module" },
    { applicationCode: "iam", code: "iam.migration.overview", name: "Migration overview & registry", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.projects", name: "Migration projects", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.packages", name: "Migration packages", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.definitions", name: "Migration definitions & mappings", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.sources", name: "Migration source configurations & adapters", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.mapping", name: "Migration mapping & transformation engine", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.validation", name: "Migration validation engine", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.dependencies", name: "Migration dependency resolution", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.planning", name: "Migration planning & readiness", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.execution", name: "Migration execution & jobs", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.reconciliation", name: "Migration reconciliation", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.identifiers", name: "Source identifier mapping", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.relationships", name: "Relationship migration", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.files", name: "File & binary migration", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.audit", name: "Migration audit trail & lineage", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.statistics", name: "Migration statistics", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.metrics", name: "Migration metrics & health", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.migration.admin", name: "Migration administration & configuration", parentCode: "iam.migration" },
    { applicationCode: "iam", code: "iam.classification", name: "Enterprise classification framework service", kind: "module" },
    { applicationCode: "iam", code: "iam.classification.overview", name: "Classification overview & registry", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.classifications", name: "Classification definitions", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.classes", name: "Classification classes & hierarchy", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.characteristics", name: "Classification characteristics", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.groups", name: "Characteristic groups", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.values", name: "Allowed values", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.assignments", name: "Classification assignments", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.validation", name: "Classification validation & rules", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.search", name: "Classification search & discovery", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.governance", name: "Classification duplicate detection", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.migration", name: "Classification migration & bulk load", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.audit", name: "Classification audit trail & lineage", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.metrics", name: "Classification metrics & health", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.classification.admin", name: "Classification administration & configuration", parentCode: "iam.classification" },
    { applicationCode: "iam", code: "iam.bom", name: "BOM engine service", kind: "module" },
    { applicationCode: "iam", code: "iam.bom.overview", name: "BOM overview & registry", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.boms", name: "BOM headers", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.revisions", name: "BOM revisions", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.lines", name: "BOM lines, attributes & substitutes", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.structure", name: "BOM structure & units", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.compare", name: "BOM comparison", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.whereused", name: "BOM where-used analysis", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.rollup", name: "BOM quantity rollup", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.transformation", name: "BOM transformation (EBOM/MBOM)", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.validation", name: "BOM validation & rules", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.baseline", name: "BOM baselines", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.search", name: "BOM search & discovery", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.audit", name: "BOM audit trail & lineage", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.metrics", name: "BOM metrics & health", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.bom.admin", name: "BOM administration & configuration", parentCode: "iam.bom" },
    { applicationCode: "iam", code: "iam.pdm", name: "PDM domain service", kind: "module" },
    { applicationCode: "iam", code: "iam.pdm.overview", name: "PDM overview & registry", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.items", name: "PDM items", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.revisions", name: "PDM item revisions", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.parts", name: "PDM parts & assemblies", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.products", name: "PDM products", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.datasets", name: "PDM datasets", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.representations", name: "PDM representations", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.design-data", name: "PDM design data", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.cad", name: "PDM CAD associations", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.revision-rules", name: "PDM revision rules", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.configuration-rules", name: "PDM configuration rules", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.baselines", name: "PDM baselines", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.whereused", name: "PDM where-used analysis", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.wherereferenced", name: "PDM where-referenced analysis", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.structure", name: "PDM structure resolution", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.validation", name: "PDM validation & rules", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.search", name: "PDM search & discovery", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.audit", name: "PDM audit trail & lineage", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.metrics", name: "PDM metrics & health", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.pdm.admin", name: "PDM administration & configuration", parentCode: "iam.pdm" },
    { applicationCode: "iam", code: "iam.change", name: "Change Management service", kind: "module" },
    { applicationCode: "iam", code: "iam.change.overview", name: "Change Management overview & registry", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.requests", name: "Change requests (ECR)", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.orders", name: "Change orders (ECO)", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.notices", name: "Change notices (ECN)", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.affected-items", name: "Change order affected items", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.ccb", name: "CCB screening, approval & decisions", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.change.admin", name: "Change Management administration & configuration", parentCode: "iam.change" },
    { applicationCode: "iam", code: "iam.thread", name: "Digital Thread service", kind: "module" },
    { applicationCode: "iam", code: "iam.thread.overview", name: "Digital Thread overview & registry", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.explorer", name: "Digital Thread explorer & traversal", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.traceability", name: "Digital Thread traceability & matrices", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.impact", name: "Digital Thread impact analysis", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.dependency", name: "Digital Thread dependency analysis", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.paths", name: "Digital Thread path finding", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.completeness", name: "Digital Thread completeness", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.snapshots", name: "Digital Thread snapshots", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.baselines", name: "Digital Thread baselines", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.compare", name: "Digital Thread comparison", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.definitions", name: "Digital Thread definitions & rules", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.search", name: "Digital Thread search & discovery", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.audit", name: "Digital Thread audit trail & lineage", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.metrics", name: "Digital Thread metrics & health", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.thread.admin", name: "Digital Thread administration & configuration", parentCode: "iam.thread" },
    { applicationCode: "iam", code: "iam.exchange", name: "Standards & Exchange service", kind: "module" },
    { applicationCode: "iam", code: "iam.exchange.dashboard", name: "Standards & Exchange overview & dashboard", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.formats", name: "Standards & Exchange formats & adapters", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.definitions", name: "Standards & Exchange definitions & versions", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.import", name: "Standards & Exchange import execution", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.export", name: "Standards & Exchange export execution", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.mappings", name: "Standards & Exchange field mappings", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.transformations", name: "Standards & Exchange transformations", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.validation", name: "Standards & Exchange validation profiles", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.jobs", name: "Standards & Exchange background jobs", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.history", name: "Standards & Exchange history & reconciliation", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.search", name: "Standards & Exchange search & discovery", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.metrics", name: "Standards & Exchange metrics & health", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.audit", name: "Standards & Exchange audit trail", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.exchange.admin", name: "Standards & Exchange administration & configuration", parentCode: "iam.exchange" },
    { applicationCode: "iam", code: "iam.reporting", name: "Reporting & Analytics service", kind: "module" },
    { applicationCode: "iam", code: "iam.reporting.home", name: "Reporting & Analytics overview & home", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.reports", name: "Saved reports & report builder", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.builder", name: "Ad-hoc query builder & preview", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.dashboards", name: "Dashboards", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.dashboard_builder", name: "Dashboard & widget builder", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.kpis", name: "KPIs & targets", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.metrics", name: "Reusable metric definitions", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.data_sources", name: "Data sources & semantic layer", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.schedules", name: "Scheduled reports & distribution", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.exports", name: "Report exports & downloads", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.bi", name: "BI integration & datasets", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.jobs", name: "Reporting background jobs", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.history", name: "Reporting execution & change history", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.search", name: "Reporting search & discovery", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.observability", name: "Reporting metrics, cache & read model", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.audit", name: "Reporting audit trail", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.reporting.admin", name: "Reporting administration & configuration", parentCode: "iam.reporting" },
    { applicationCode: "iam", code: "iam.observability", name: "Data Observability service", kind: "module" },
    { applicationCode: "iam", code: "iam.observability.home", name: "Data Observability overview & home", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.overview", name: "Platform observability overview", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.health", name: "Health checks, snapshots & status", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.metrics", name: "Metric definitions & observations", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.data_volume", name: "Data volume & growth", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.freshness", name: "Data freshness & assets", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.quality", name: "Data quality signals", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.pipelines", name: "Pipeline throughput & latency", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.failures", name: "API, import, export & event failures", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.alerts", name: "Alert rules, alerts & lifecycle", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.incidents", name: "Incident tracking", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.slo", name: "SLO & SLA management", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.dashboards", name: "Observability dashboards", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.providers", name: "Telemetry providers", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.jobs", name: "Observability background jobs", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.history", name: "Observability change history", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.search", name: "Observability search & discovery", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.audit", name: "Observability audit trail", parentCode: "iam.observability" },
    { applicationCode: "iam", code: "iam.observability.admin", name: "Observability administration & configuration", parentCode: "iam.observability" },
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
    "iam.jobs.queues",
    "iam.jobs.schedules",
    "iam.jobs.execution",
  ];
  const fileResourceCodes = [
    "iam.files.browser",
    "iam.files.details",
    "iam.files.uploads",
    "iam.files.versions",
    "iam.files.locks",
    "iam.files.associations",
    "iam.files.folders",
    "iam.files.permissions",
  ];
  const searchResourceCodes = [
    "iam.search.global",
    "iam.search.advanced",
    "iam.search.saved",
    "iam.search.history",
    "iam.search.indexes",
    "iam.search.configuration",
    "iam.search.export",
  ];
  const securityResourceCodes = [
    "iam.security.console",
    "iam.security.policies",
    "iam.security.entitlements",
    "iam.security.fields",
    "iam.security.classifications",
    "iam.security.organizations",
    "iam.security.objecttypes",
    "iam.security.decisions",
  ];
  const integrationResourceCodes = [
    "iam.integration",
    "iam.integration.systems",
    "iam.integration.endpoints",
    "iam.integration.transforms",
    "iam.integration.mappings",
    "iam.integration.schedules",
    "iam.integration.events",
    "iam.integration.webhooks",
    "iam.integration.messages",
    "iam.integration.deadletters",
    "iam.integration.transfers",
    "iam.integration.monitoring",
    "iam.integration.api",
  ];
  const eventResourceCodes = [
    "iam.events",
    "iam.events.registry",
    "iam.events.publish",
    "iam.events.subscriptions",
    "iam.events.topology",
    "iam.events.deliveries",
    "iam.events.deadletters",
    "iam.events.replay",
    "iam.events.retention",
    "iam.events.monitoring",
  ];
  const numberingResourceCodes = [
    "iam.numbering",
    "iam.numbering.schemes",
    "iam.numbering.objecttypes",
    "iam.numbering.sequences",
    "iam.numbering.allocations",
    "iam.numbering.generate",
    "iam.numbering.reserve",
    "iam.numbering.consume",
    "iam.numbering.release",
    "iam.numbering.manual",
    "iam.numbering.metrics",
  ];
  const versioningResourceCodes = [
    "iam.versioning",
    "iam.versioning.revisions",
    "iam.versioning.versions",
    "iam.versioning.effectivities",
    "iam.versioning.resolve",
    "iam.versioning.baselines",
    "iam.versioning.snapshots",
    "iam.versioning.variants",
    "iam.versioning.configurations",
    "iam.versioning.policies",
    "iam.versioning.metrics",
  ];
  const referenceResourceCodes = [
    "iam.reference",
    "iam.reference.domains",
    "iam.reference.items",
    "iam.reference.codes",
    "iam.reference.aliases",
    "iam.reference.translations",
    "iam.reference.hierarchy",
    "iam.reference.relationships",
    "iam.reference.scopes",
    "iam.reference.versions",
    "iam.reference.approvals",
    "iam.reference.governance",
    "iam.reference.import",
    "iam.reference.export",
    "iam.reference.resolve",
    "iam.reference.metrics",
  ];
  const contentResourceCodes = [
    "iam.content",
    "iam.content.browser",
    "iam.content.details",
    "iam.content.uploads",
    "iam.content.versions",
    "iam.content.locks",
    "iam.content.associations",
    "iam.content.renditions",
    "iam.content.processing",
    "iam.content.security",
    "iam.content.retention",
    "iam.content.admin",
  ];
  const dataGovernanceResourceCodes = [
    "iam.data_governance",
    "iam.data_governance.domains",
    "iam.data_governance.catalog",
    "iam.data_governance.ownership",
    "iam.data_governance.policies",
    "iam.data_governance.configuration",
    "iam.data_governance.dimensions",
    "iam.data_governance.jobs",
    "iam.data_governance.metrics",
    "iam.data_quality",
    "iam.data_quality.rules",
    "iam.data_quality.evaluation",
    "iam.data_quality.results",
    "iam.data_quality.exceptions",
    "iam.data_quality.duplicates",
    "iam.data_quality.remediation",
  ];
  const dataCatalogResourceCodes = [
    "iam.data_catalog",
    "iam.data_catalog.overview",
    "iam.data_catalog.domains",
    "iam.data_catalog.objects",
    "iam.data_catalog.attributes",
    "iam.data_catalog.glossary",
    "iam.data_catalog.terms",
    "iam.data_catalog.sources",
    "iam.data_catalog.consumers",
    "iam.data_catalog.mappings",
    "iam.data_catalog.lineage",
    "iam.data_catalog.relationships",
    "iam.data_catalog.classifications",
    "iam.data_catalog.ownership",
    "iam.data_catalog.import_export",
    "iam.data_catalog.admin",
    "iam.data_catalog.jobs",
    "iam.data_catalog.metrics",
  ];
  const dataLifecycleResourceCodes = [
    "iam.data_lifecycle",
    "iam.data_lifecycle.overview",
    "iam.data_lifecycle.states",
    "iam.data_lifecycle.policies",
    "iam.data_lifecycle.objects",
    "iam.data_lifecycle.eligibility",
    "iam.data_lifecycle.archive",
    "iam.data_lifecycle.restore",
    "iam.data_lifecycle.recovery",
    "iam.data_lifecycle.purge",
    "iam.data_lifecycle.legal_holds",
    "iam.data_lifecycle.dependencies",
    "iam.data_lifecycle.jobs",
    "iam.data_lifecycle.metrics",
    "iam.data_lifecycle.admin",
  ];
  const dataExchangeResourceCodes = [
    "iam.data_exchange",
    "iam.data_exchange.overview",
    "iam.data_exchange.imports",
    "iam.data_exchange.import_definitions",
    "iam.data_exchange.exports",
    "iam.data_exchange.export_definitions",
    "iam.data_exchange.connectors",
    "iam.data_exchange.mapping",
    "iam.data_exchange.validation",
    "iam.data_exchange.reconciliation",
    "iam.data_exchange.templates",
    "iam.data_exchange.history",
    "iam.data_exchange.jobs",
    "iam.data_exchange.metrics",
    "iam.data_exchange.admin",
  ];
  const dataMigrationResourceCodes = [
    "iam.migration",
    "iam.migration.overview",
    "iam.migration.projects",
    "iam.migration.packages",
    "iam.migration.definitions",
    "iam.migration.sources",
    "iam.migration.mapping",
    "iam.migration.validation",
    "iam.migration.dependencies",
    "iam.migration.planning",
    "iam.migration.execution",
    "iam.migration.reconciliation",
    "iam.migration.identifiers",
    "iam.migration.relationships",
    "iam.migration.files",
    "iam.migration.audit",
    "iam.migration.statistics",
    "iam.migration.metrics",
    "iam.migration.admin",
  ];
  const classificationResourceCodes = [
    "iam.classification",
    "iam.classification.overview",
    "iam.classification.classifications",
    "iam.classification.classes",
    "iam.classification.characteristics",
    "iam.classification.groups",
    "iam.classification.values",
    "iam.classification.assignments",
    "iam.classification.validation",
    "iam.classification.search",
    "iam.classification.governance",
    "iam.classification.migration",
    "iam.classification.audit",
    "iam.classification.metrics",
    "iam.classification.admin",
  ];
  const bomResourceCodes = [
    "iam.bom",
    "iam.bom.overview",
    "iam.bom.boms",
    "iam.bom.revisions",
    "iam.bom.lines",
    "iam.bom.structure",
    "iam.bom.compare",
    "iam.bom.whereused",
    "iam.bom.rollup",
    "iam.bom.transformation",
    "iam.bom.validation",
    "iam.bom.baseline",
    "iam.bom.search",
    "iam.bom.audit",
    "iam.bom.metrics",
    "iam.bom.admin",
  ];
  const pdmResourceCodes = [
    "iam.pdm",
    "iam.pdm.overview",
    "iam.pdm.items",
    "iam.pdm.revisions",
    "iam.pdm.parts",
    "iam.pdm.products",
    "iam.pdm.datasets",
    "iam.pdm.representations",
    "iam.pdm.design-data",
    "iam.pdm.cad",
    "iam.pdm.revision-rules",
    "iam.pdm.configuration-rules",
    "iam.pdm.baselines",
    "iam.pdm.whereused",
    "iam.pdm.wherereferenced",
    "iam.pdm.structure",
    "iam.pdm.validation",
    "iam.pdm.search",
    "iam.pdm.audit",
    "iam.pdm.metrics",
    "iam.pdm.admin",
  ];
  const changeResourceCodes = [
    "iam.change",
    "iam.change.overview",
    "iam.change.requests",
    "iam.change.orders",
    "iam.change.notices",
    "iam.change.affected-items",
    "iam.change.ccb",
    "iam.change.admin",
  ];
  const threadResourceCodes = [
    "iam.thread",
    "iam.thread.overview",
    "iam.thread.explorer",
    "iam.thread.traceability",
    "iam.thread.impact",
    "iam.thread.dependency",
    "iam.thread.paths",
    "iam.thread.completeness",
    "iam.thread.snapshots",
    "iam.thread.baselines",
    "iam.thread.compare",
    "iam.thread.definitions",
    "iam.thread.search",
    "iam.thread.audit",
    "iam.thread.metrics",
    "iam.thread.admin",
  ];
  const exchangeResourceCodes = [
    "iam.exchange",
    "iam.exchange.dashboard",
    "iam.exchange.formats",
    "iam.exchange.definitions",
    "iam.exchange.import",
    "iam.exchange.export",
    "iam.exchange.mappings",
    "iam.exchange.transformations",
    "iam.exchange.validation",
    "iam.exchange.jobs",
    "iam.exchange.history",
    "iam.exchange.search",
    "iam.exchange.metrics",
    "iam.exchange.audit",
    "iam.exchange.admin",
  ];
  const reportingResourceCodes = [
    "iam.reporting",
    "iam.reporting.home",
    "iam.reporting.reports",
    "iam.reporting.builder",
    "iam.reporting.dashboards",
    "iam.reporting.dashboard_builder",
    "iam.reporting.kpis",
    "iam.reporting.metrics",
    "iam.reporting.data_sources",
    "iam.reporting.schedules",
    "iam.reporting.exports",
    "iam.reporting.bi",
    "iam.reporting.jobs",
    "iam.reporting.history",
    "iam.reporting.search",
    "iam.reporting.observability",
    "iam.reporting.audit",
    "iam.reporting.admin",
  ];
  const observabilityResourceCodes = [
    "iam.observability",
    "iam.observability.home",
    "iam.observability.overview",
    "iam.observability.health",
    "iam.observability.metrics",
    "iam.observability.data_volume",
    "iam.observability.freshness",
    "iam.observability.quality",
    "iam.observability.pipelines",
    "iam.observability.failures",
    "iam.observability.alerts",
    "iam.observability.incidents",
    "iam.observability.slo",
    "iam.observability.dashboards",
    "iam.observability.providers",
    "iam.observability.jobs",
    "iam.observability.history",
    "iam.observability.search",
    "iam.observability.audit",
    "iam.observability.admin",
  ];
  for (const code of [...notificationResourceCodes, ...deliveryResourceCodes, ...jobResourceCodes, ...fileResourceCodes, ...searchResourceCodes, ...securityResourceCodes, ...integrationResourceCodes, ...eventResourceCodes, ...numberingResourceCodes, ...versioningResourceCodes, ...referenceResourceCodes, ...contentResourceCodes, ...dataGovernanceResourceCodes, ...dataCatalogResourceCodes, ...dataLifecycleResourceCodes, ...dataExchangeResourceCodes, ...dataMigrationResourceCodes, ...classificationResourceCodes, ...bomResourceCodes, ...pdmResourceCodes, ...changeResourceCodes, ...threadResourceCodes, ...exchangeResourceCodes, ...reportingResourceCodes, ...observabilityResourceCodes]) {
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
    ["iam.jobs.queues", ["read"]],
    ["iam.jobs.schedules", ["read"]],
    ["iam.jobs.execution", ["read"]],
    ["iam.files.browser", ["read"]],
    ["iam.files.details", ["read", "update", "delete"]],
    ["iam.files.uploads", ["create"]],
    ["iam.files.versions", ["read", "create"]],
    ["iam.files.locks", ["read", "execute"]],
    ["iam.files.associations", ["read", "create", "delete"]],
    ["iam.files.folders", ["read", "create", "update"]],
    ["iam.search.global", ["read"]],
    ["iam.search.advanced", ["read"]],
    ["iam.search.saved", ["read", "create", "update", "delete"]],
    ["iam.search.history", ["read", "delete"]],
    ["iam.search.export", ["read", "create"]],
    ["iam.numbering.generate", ["read", "create"]],
    ["iam.numbering.reserve", ["read", "create"]],
    ["iam.numbering.consume", ["execute"]],
    ["iam.numbering.release", ["execute"]],
    ["iam.numbering.schemes", ["read"]],
    ["iam.numbering.allocations", ["read"]],
    ["iam.numbering.sequences", ["read"]],
    ["iam.numbering.objecttypes", ["read"]],
    ["iam.numbering.metrics", ["read"]],
    ["iam.versioning.revisions", ["read"]],
    ["iam.versioning.versions", ["read"]],
    ["iam.versioning.effectivities", ["read"]],
    ["iam.versioning.resolve", ["read", "execute"]],
    ["iam.versioning.baselines", ["read"]],
    ["iam.versioning.snapshots", ["read"]],
    ["iam.versioning.variants", ["read"]],
    ["iam.versioning.configurations", ["read"]],
    ["iam.versioning.metrics", ["read"]],
    ["iam.reference.domains", ["read"]],
    ["iam.reference.items", ["read"]],
    ["iam.reference.codes", ["read"]],
    ["iam.reference.aliases", ["read"]],
    ["iam.reference.translations", ["read"]],
    ["iam.reference.hierarchy", ["read"]],
    ["iam.reference.relationships", ["read"]],
    ["iam.reference.scopes", ["read"]],
    ["iam.reference.versions", ["read"]],
    ["iam.reference.resolve", ["read", "execute"]],
    ["iam.reference.metrics", ["read"]],
    ["iam.content.browser", ["read"]],
    ["iam.content.details", ["read"]],
    ["iam.content.uploads", ["read", "create"]],
    ["iam.content.versions", ["read"]],
    ["iam.content.locks", ["read", "execute"]],
    ["iam.content.associations", ["read"]],
    ["iam.content.renditions", ["read"]],
    ["iam.content.processing", ["read"]],
    ["iam.content.security", ["read"]],
    ["iam.content.retention", ["read"]],
    ["iam.data_governance", ["read"]],
    ["iam.data_governance.domains", ["read"]],
    ["iam.data_governance.catalog", ["read"]],
    ["iam.data_governance.ownership", ["read"]],
    ["iam.data_governance.policies", ["read"]],
    ["iam.data_governance.configuration", ["read"]],
    ["iam.data_governance.dimensions", ["read"]],
    ["iam.data_governance.jobs", ["read", "execute"]],
    ["iam.data_governance.metrics", ["read"]],
    ["iam.data_quality", ["read"]],
    ["iam.data_quality.rules", ["read"]],
    ["iam.data_quality.evaluation", ["read", "execute"]],
    ["iam.data_quality.results", ["read"]],
    ["iam.data_quality.exceptions", ["read", "create", "update", "execute"]],
    ["iam.data_quality.duplicates", ["read", "execute"]],
    ["iam.data_quality.remediation", ["read", "execute"]],
    ["iam.observability.home", ["read"]],
    ["iam.observability.overview", ["read"]],
    ["iam.observability.health", ["read"]],
    ["iam.observability.metrics", ["read"]],
    ["iam.observability.data_volume", ["read"]],
    ["iam.observability.freshness", ["read"]],
    ["iam.observability.quality", ["read"]],
    ["iam.observability.pipelines", ["read"]],
    ["iam.observability.failures", ["read"]],
    ["iam.observability.alerts", ["read", "execute"]],
    ["iam.observability.incidents", ["read"]],
    ["iam.observability.slo", ["read"]],
    ["iam.observability.dashboards", ["read"]],
    ["iam.observability.providers", ["read"]],
    ["iam.observability.jobs", ["read"]],
    ["iam.observability.history", ["read"]],
    ["iam.observability.search", ["read"]],
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
  audit.ensureSystemActionTypes(db);
  audit.ensureDefaultRetentionPolicies(db);
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

// Ensures the logical execution queues and a representative set of recurring
// schedules exist. Queues are system configuration and are only created when
// missing; admin edits are never overwritten.
function seedJobEngine(db) {
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const admin = queryOne(db, "SELECT id, username, display_name, email FROM users WHERE username = 'admin'");
  const actor = admin
    ? { id: admin.id, username: admin.username, display_name: admin.display_name, tenant_id: helix?.id ?? null, organization_id: helix?.id ?? null }
    : null;
  jobExecution.ensureDefaultQueues(db, actor);

  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM job_schedules").c;
  if (existing > 0) return { jobEngineSeeded: true, queuesSeeded: jobExecution.LOGICAL_QUEUES.length };

  const samples = [
    {
      code: "NIGHTLY_SEARCH_REINDEX",
      name: "Nightly search reindex",
      description: "Rebuild the full-text search index every night at 02:00 UTC.",
      job_type_code: "SEARCH_INDEXING",
      queue: "SEARCH_INDEXING",
      schedule_type: "cron",
      cron_expression: "0 2 * * *",
      timezone: "UTC",
      catchup_policy: "skip",
    },
    {
      code: "HOURLY_ERP_SYNC",
      name: "Hourly ERP sync",
      description: "Synchronize the item master with the ERP system every hour.",
      job_type_code: "DATA_SYNC",
      queue: "INTEGRATION",
      schedule_type: "interval",
      interval_seconds: 3600,
      failure_policy: "continue",
    },
    {
      code: "WEEKLY_COST_ROLLUP",
      name: "Weekly cost rollup",
      description: "Roll up approved cost records into the weekly report on Mondays.",
      job_type_code: "REPORT_GENERATION",
      queue: "REPORTING",
      schedule_type: "weekly",
      weekdays: [1],
      daily_time: "06:00",
      timezone: "UTC",
      max_retries: 2,
    },
  ];
  let created = 0;
  for (const sample of samples) {
    try {
      jobExecution.createSchedule(db, { ...sample, tenant_id: helix?.id ?? null }, actor, "seed");
      created += 1;
    } catch (err) {
      if (!String(err.message).includes("already exists")) throw err;
    }
  }
  return { jobEngineSeeded: true, queuesSeeded: jobExecution.LOGICAL_QUEUES.length, schedulesSeeded: created };
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
  seedJobEngine(db);
  const searchResult = seedSearch(db);
  const integrationResult = seedIntegration(db);
  const eventsResult = seedEvents(db);
  const numberingResult = withEventSuppression(() => seedNumbering(db));
  const versioningResult = withEventSuppression(() => seedVersioning(db));
  const referenceResult = withEventSuppression(() => seedReference(db));
  const contentResult = withEventSuppression(() => seedContent(db));
  const dataGovernanceResult = withEventSuppression(() => seedDataGovernance(db));
  const dataCatalogResult = withEventSuppression(() => seedDataCatalog(db));
  const dataLifecycleResult = withEventSuppression(() => seedDataLifecycle(db));
  const dataExchangeResult = withEventSuppression(() => seedDataExchange(db));
  const migrationResult = withEventSuppression(() => seedMigrationFramework(db));
  const classificationResult = withEventSuppression(() => seedClassificationFramework(db));
  const bomResult = withEventSuppression(() => seedBomEngine(db));
  const pdmResult = withEventSuppression(() => seedPdmDomain(db));
  const threadResult = withEventSuppression(() => seedThreadDomain(db));
  const exchangeResult = withEventSuppression(() => seedExchangeDomain(db));
  const reportingResult = withEventSuppression(() => seedReportingDomain(db));
  const observabilityResult = withEventSuppression(() => seedObservabilityDomain(db));
  return { ...identity, ...authz, ...searchResult, ...integrationResult, ...eventsResult, ...numberingResult, ...versioningResult, ...referenceResult, ...contentResult, ...dataGovernanceResult, ...dataCatalogResult, ...dataLifecycleResult, ...dataExchangeResult, ...migrationResult, ...classificationResult, ...bomResult, ...pdmResult, ...threadResult, ...exchangeResult, ...reportingResult, ...observabilityResult };
}

// Installs the centralized Data Governance & Data Quality foundation (default
// dimensions, scoring bands, event types, job handlers, search registrations)
// plus a small demo estate so dashboards are not empty on a fresh install.
function seedDataGovernance(db) {
  try {
    const result = dataGovernance.ensureDataGovernanceSeed(db);
    return { dataGovernanceSeeded: true, ...result };
  } catch (err) {
    return { dataGovernanceSeeded: false, dataGovernanceError: err.message };
  }
}

// Installs the centralized Data Catalog & Business Glossary foundation (default
// relationship types, event types, job handlers, search registrations) plus a
// small demo estate so catalog dashboards are not empty on a fresh install.
function seedDataCatalog(db) {
  try {
    const result = dataCatalog.ensureDataCatalogSeed(db);
    return { dataCatalogSeeded: true, ...result };
  } catch (err) {
    return { dataCatalogSeeded: false, dataCatalogError: err.message };
  }
}

// Installs the centralized Data Lifecycle & Archival foundation (default states,
// transitions, tier mappings, event types, job handlers, search registrations)
// plus a small demo estate so lifecycle dashboards are not empty on a fresh
// install.
function seedDataLifecycle(db) {
  try {
    const result = dataLifecycle.ensureDataLifecycleSeed(db);
    return { dataLifecycleSeeded: true, ...result };
  } catch (err) {
    return { dataLifecycleSeeded: false, dataLifecycleError: err.message };
  }
}

// Installs the centralized Import & Export Framework foundation (built-in
// connectors, event types, job handlers, configuration) plus a small demo
// estate so exchange dashboards are not empty on a fresh install.
function seedDataExchange(db) {
  try {
    const result = dataExchange.ensureDataExchangeSeed(db);
    return { dataExchangeSeeded: true, ...result };
  } catch (err) {
    return { dataExchangeSeeded: false, dataExchangeError: err.message };
  }
}

// Installs the centralized Migration & Onboarding Framework foundation (source
// adapters, event types, job types/handlers, search registrations) plus a small
// demo onboarding estate so migration dashboards are not empty on a fresh install.
function seedMigrationFramework(db) {
  try {
    const result = migration.ensureMigrationSeed(db);
    return { migrationSeeded: true, ...result };
  } catch (err) {
    return { migrationSeeded: false, migrationError: err.message };
  }
}

// Installs the centralized Enterprise Classification Framework foundation
// (units, event types, job types/handlers, search registrations, duplicate
// strategy, per-tenant configuration) plus a small demo classification estate.
function seedClassificationFramework(db) {
  try {
    const result = classification.ensureClassificationSeed(db);
    return { classificationSeeded: true, ...result };
  } catch (err) {
    return { classificationSeeded: false, classificationError: err.message };
  }
}

// Installs the P1 BOM Engine foundation (units, event types, job types/handlers,
// search registrations, per-tenant configuration and default validation rules)
// plus a small demo EBOM estate so BOM dashboards are not empty on a fresh install.
function seedBomEngine(db) {
  try {
    const result = bom.ensureBomSeed(db);
    return { bomSeeded: true, ...result };
  } catch (err) {
    return { bomSeeded: false, bomError: err.message };
  }
}

// Installs the P1 PDM domain foundation (event types, job types/handlers, search
// registrations, per-tenant configuration and default validation rules) plus a
// small demo product structure so PDM screens are not empty on a fresh install.
function seedPdmDomain(db) {
  try {
    const result = pdm.ensurePdmSeed(db);
    return { pdmSeeded: true, ...result };
  } catch (err) {
    return { pdmSeeded: false, pdmError: err.message };
  }
}

// Installs the P1 Digital Thread foundation (providers, event/job types, search
// registrations, default definition and rules, configuration) plus a demo
// snapshot and released baseline so the capability is visible on a fresh install.
function seedThreadDomain(db) {
  try {
    const result = thread.ensureThreadSeed(db);
    return { threadSeeded: true, ...result };
  } catch (err) {
    return { threadSeeded: false, threadError: err.message };
  }
}

// Installs the P2 Standards & Exchange foundation (formats/adapters, event and
// job types, search registrations, default JSON exchange definitions, mappings,
// transformations and validation profiles) plus a demo transaction so the
// capability is visible on a fresh install. Reuses the Import/Export framework.
function seedExchangeDomain(db) {
  try {
    const result = exchange.ensureExchangeSeed(db);
    return { exchangeSeeded: true, ...result };
  } catch (err) {
    return { exchangeSeeded: false, exchangeError: err.message };
  }
}

// Installs the P2 Reporting & Analytics foundation (event and job types, search
// registrations, semantic layer, configuration) plus curated KPI definitions, a
// demo report and an operations dashboard so the capability is visible on a
// fresh install. Modules 20 is a platform service consumed by every domain.
function seedReportingDomain(db) {
  try {
    const result = reporting.ensureReportingSeed(db);
    return { reportingSeeded: true, ...result };
  } catch (err) {
    return { reportingSeeded: false, reportingError: err.message };
  }
}

function seedObservabilityDomain(db) {
  try {
    const result = observability.ensureObservabilitySeed(db);
    return { observabilitySeeded: true, ...result };
  } catch (err) {
    return { observabilitySeeded: false, observabilityError: err.message };
  }
}

function seedSearch(db) {
  try {
    const result = search.initializeSearch(db);
    return { searchSeeded: true, ...result };
  } catch (err) {
    return { searchSeeded: false, searchError: err.message };
  }
}
// Registers the platform's default domain event types so business modules can
// publish/subscribe without any manual catalogue maintenance.
function seedIntegration(db) {
  try {
    const result = integration.Events.ensureDefaultEventTypes(db);
    return { integrationSeeded: true, eventTypes: result.total };
  } catch (err) {
    return { integrationSeeded: false, integrationError: err.message };
  }
}

// Installs the Event & Messaging Framework foundation: the event type catalogue,
// the default topic/queue/consumer-group topology and default retention policies.
function seedEvents(db) {
  try {
    const result = events.ensureEventFoundation(db);
    return {
      eventsSeeded: true,
      eventTypesRegistry: result.event_types.total,
      eventTopology: result.topology,
      eventRetentionPolicies: result.retention_policies.total,
      eventSubscriptions: result.subscriptions.total,
    };
  } catch (err) {
    return { eventsSeeded: false, eventsError: err.message };
  }
}

// Installs the Numbering & Identifier Service foundation: object types, token
// catalogue, scope registry, event types, search resolver and a set of example
// schemes that demonstrate the standard enterprise identifier patterns.
function seedNumbering(db) {
  try {
    const foundation = numbering.ensureNumberingFoundation(db);
    const schemes = seedNumberingSchemes(db);
    return { numberingSeeded: true, ...foundation, schemes };
  } catch (err) {
    return { numberingSeeded: false, numberingError: err.message };
  }
}

function seedNumberingSchemes(db) {
  const helixes = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  const tenantId = helixes?.id ?? null;
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  const actor = admin ? { id: admin.id, username: admin.username } : null;
  const definitions = [
    { code: "PART_STANDARD", name: "Part standard", object_type_code: "PART", pattern: "{TYPE}-{YYYY}-{SEQ}", padding: 6, reset_policy: "yearly", is_default: true, priority: 100 },
    { code: "PRODUCT_STANDARD", name: "Product standard", object_type_code: "PRODUCT", pattern: "{TYPE}-{SEQ}", padding: 6, is_default: true, priority: 100 },
    { code: "DOCUMENT_CONTROLLED", name: "Controlled document", object_type_code: "DOCUMENT", pattern: "{TYPE}-{YYYY}-{SEQ}", padding: 5, reset_policy: "yearly", sequence_scope: "organization", is_default: true, priority: 100 },
    { code: "BOM_STANDARD", name: "BOM standard", object_type_code: "BOM", pattern: "{TYPE}-{YYYY}-{SEQ}", padding: 6, reset_policy: "yearly", is_default: true, priority: 100 },
    { code: "DRAWING_STANDARD", name: "Drawing standard", object_type_code: "DRAWING", pattern: "{TYPE}-{YY}-{SEQ}", padding: 5, is_default: true, priority: 100 },
    { code: "SPECIFICATION_STANDARD", name: "Specification standard", object_type_code: "SPECIFICATION", pattern: "{TYPE}-{SEQ}", padding: 5, is_default: true, priority: 100 },
    { code: "CHANGE_REQUEST", name: "Engineering change", object_type_code: "CHANGE", pattern: "ECN-{YYYY}-{SEQ}", padding: 4, reset_policy: "yearly", is_default: true, priority: 100 },
    { code: "SUPPLIER_STANDARD", name: "Supplier standard", object_type_code: "SUPPLIER", pattern: "{TYPE}-{SEQ}", padding: 5, is_default: true, priority: 100 },
    { code: "CUSTOMER_STANDARD", name: "Customer standard", object_type_code: "CUSTOMER", pattern: "{TYPE}-{SEQ}", padding: 5, is_default: true, priority: 100 },
    { code: "MATERIAL_STANDARD", name: "Material standard", object_type_code: "MATERIAL", pattern: "{TYPE}-{SEQ}", padding: 6, is_default: true, priority: 100 },
  ];
  let created = 0;
  const codes = [];
  for (const def of definitions) {
    const existing = queryOne(
      db,
      "SELECT id FROM numbering_schemes WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
      [def.code, tenantId]
    );
    if (existing) continue;
    try {
      numbering.Schemes.createScheme(db, { ...def, status: "active" }, actor, tenantId, "seed");
      created += 1;
      codes.push(def.code);
    } catch {
      /* a missing object type in an older database must not fail seeding */
    }
  }
  return { created, codes };
}

// Installs the Effectivity & Versioning Kernel foundation: effectivity types,
// the default resolution policy, event types, search registrations and a small
// set of demonstration objects covering date/serial/plant/model effectivity.
function seedVersioning(db) {
  try {
    const foundation = versioning.ensureVersioningFoundation(db);
    const sample = versioning.seedVersioning(db);
    return { versioningSeeded: true, ...foundation, sample };
  } catch (err) {
    return { versioningSeeded: false, versioningError: err.message };
  }
}

// Installs the Enterprise Reference Data Management foundation: the canonical
// domain catalogue (UoM, currency, country, ...), default governance policies,
// scope precedence and a demonstration set of governed master values.
function seedReference(db) {
  try {
    const foundation = reference.ensureReferenceFoundation(db);
    const sample = reference.seedReference(db);
    return { referenceSeeded: true, referenceFoundation: foundation.domains?.created ?? 0, referenceSample: sample.items_created ?? 0 };
  } catch (err) {
    return { referenceSeeded: false, referenceError: err.message };
  }
}

// Installs the File & Content Management foundation: content event types, search
// registration and the baseline retention policy set.
function seedContent(db) {
  try {
    const foundation = content.ensureContentFoundation(db);
    const sample = content.seedContent(db);
    return { contentSeeded: true, contentEventTypes: foundation.event_types, contentRetentionPolicies: sample.retention_policies };
  } catch (err) {
    return { contentSeeded: false, contentError: err.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.IAM_DB || join(__dirname, "..", "data", "iam.db");
  const db = openDatabase(path);
  migrate(db);
  const result = seedDatabase(db);
  console.log(result.seeded || result.authzSeeded ? "Seeded IAM database" : "IAM database already populated");
  db.close();
}
