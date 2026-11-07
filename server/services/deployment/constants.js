// Vocabulary, entitlement catalog and platform wiring codes for the
// Deployment & Edition framework.
//
// The platform ships as one codebase that can be installed in three
// topologies — Cloud SaaS, Private Cloud and Local/on-premises — and licensed
// at three editions. This module is the single source of truth for that
// posture: the deployment profile records the installed topology and edition,
// while the feature catalog describes what each topology/edition is entitled
// to. Nothing here duplicates another engine; gating is expressed once and
// consumed by `requireFeature` (see server/middleware.js).
export const SOURCE_MODULE = "deployment";

// ── Deployment topologies ────────────────────────────────────────────────────

export const DEPLOYMENT_MODES = Object.freeze([
  {
    code: "saas",
    name: "Cloud SaaS",
    description:
      "Vendor-hosted multi-tenant cloud. The operator manages a shared fleet; tenants are provisioned and billed centrally.",
    default_tenant_strategy: "multi",
    default_self_registration: 1,
  },
  {
    code: "private_cloud",
    name: "Private Cloud",
    description:
      "Customer-dedicated cloud or VPC. The customer administrator owns the instance; multiple tenants may still be hosted inside it.",
    default_tenant_strategy: "multi",
    default_self_registration: 0,
  },
  {
    code: "local",
    name: "Local / On-premises",
    description:
      "Single-organization install on customer hardware or a laptop. Air-gap friendly, no vendor telemetry by default.",
    default_tenant_strategy: "single",
    default_self_registration: 0,
  },
]);

export const MODE_CODES = Object.freeze(DEPLOYMENT_MODES.map((m) => m.code));

// ── Editions ─────────────────────────────────────────────────────────────────
//
// Ordered by rank: a higher edition unlocks every feature whose `min_edition`
// is at or below it. Community is the entry tier, Enterprise the full platform.

export const EDITIONS = Object.freeze([
  {
    code: "community",
    name: "Community",
    rank: 1,
    description: "Core identity, object framework, documents, search, notifications and audit.",
  },
  {
    code: "standard",
    name: "Standard",
    rank: 2,
    description: "Adds engineering domains: workflow, numbering, versioning, classification, BOM, PDM and change control.",
  },
  {
    code: "enterprise",
    name: "Enterprise",
    rank: 3,
    description: "Full platform: governance, catalog, lifecycle, integration, events, reporting and observability.",
  },
]);

export const EDITION_CODES = Object.freeze(EDITIONS.map((e) => e.code));
export const TENANT_STRATEGIES = Object.freeze(["multi", "single"]);

export function editionRank(code) {
  const found = EDITIONS.find((e) => e.code === code);
  return found ? found.rank : 0;
}

export function findMode(code) {
  return DEPLOYMENT_MODES.find((m) => m.code === code) || null;
}

export function findEdition(code) {
  return EDITIONS.find((e) => e.code === code) || null;
}

// ── Feature entitlement catalog ──────────────────────────────────────────────
//
// `min_edition` is the licence floor; `allowed_modes` (empty = all topologies)
// restricts a feature to particular installs (for example, SaaS-only
// self-service signup). The effective flag is derived at read time from these
// plus the operator's `enabled` toggle so a contract and an override are never
// conflated.

export const FEATURE_CATALOG = Object.freeze([
  // Identity & core platform (Community)
  { feature_code: "iam_core", name: "Identity & access management", category: "core", min_edition: "community", sort_order: 10, description: "Users, groups, roles, organizations, tenants and authorization." },
  { feature_code: "metadata", name: "Metadata & configuration", category: "core", min_edition: "community", sort_order: 20, description: "Types, attributes, LOVs, forms, rules and scoped configuration." },
  { feature_code: "objects", name: "Object & relationship framework", category: "core", min_edition: "community", sort_order: 30, description: "Metadata-typed business objects, relationships, references and dependencies." },
  { feature_code: "files", name: "Document & file management", category: "core", min_edition: "community", sort_order: 40, description: "File browser, versions, locking, uploads and access control." },
  { feature_code: "content", name: "Content management", category: "core", min_edition: "community", sort_order: 50, description: "Provider-independent content, renditions, security scanning and retention." },
  { feature_code: "search", name: "Search & discovery", category: "core", min_edition: "community", sort_order: 60, description: "Global search, enterprise search foundation and index administration." },
  { feature_code: "notifications", name: "Notifications & delivery", category: "core", min_edition: "community", sort_order: 70, description: "In-app inbox, templates, rules, providers and outbound delivery." },
  { feature_code: "jobs", name: "Job management & execution", category: "core", min_edition: "community", sort_order: 80, description: "Background jobs, queues, schedules, workers and dead letters." },
  { feature_code: "audit", name: "Audit & history", category: "core", min_edition: "community", sort_order: 90, description: "Immutable audit event stream, retention and export." },

  // Engineering (Standard)
  { feature_code: "workflow", name: "Workflow engine", category: "engineering", min_edition: "standard", sort_order: 110, description: "Designable workflow templates, instances, tasks and approvals." },
  { feature_code: "numbering", name: "Numbering service", category: "engineering", min_edition: "standard", sort_order: 120, description: "Centralized numbering schemes, tokens, allocation and reservations." },
  { feature_code: "versioning", name: "Effectivity & versioning", category: "engineering", min_edition: "standard", sort_order: 130, description: "Revision/effectivity kernel with as-of resolution and baselines." },
  { feature_code: "reference_data", name: "Enterprise reference data", category: "engineering", min_edition: "standard", sort_order: 140, description: "Governed master/reference values with versioned policies." },
  { feature_code: "classification", name: "Enterprise classification", category: "engineering", min_edition: "standard", sort_order: 150, description: "Classification hierarchies, classes, characteristics and assignments." },
  { feature_code: "bom", name: "BOM engine", category: "engineering", min_edition: "standard", sort_order: 160, description: "Bill-of-materials headers, revisions, structure, rollup and where-used." },
  { feature_code: "pdm", name: "Product data management", category: "engineering", min_edition: "standard", sort_order: 170, description: "Items, revisions, datasets, CAD associations and product structure." },
  { feature_code: "change_management", name: "Change management", category: "engineering", min_edition: "standard", sort_order: 180, description: "Engineering change requests, orders and notices (ECR/ECO/ECN)." },
  { feature_code: "digital_thread", name: "Digital thread", category: "engineering", min_edition: "enterprise", sort_order: 190, description: "Cross-domain traceability, impact analysis and path finding." },
  { feature_code: "standards_exchange", name: "Standards & exchange", category: "engineering", min_edition: "enterprise", sort_order: 200, description: "Standards-based import/export formats and adapters." },

  // Governance & data (Enterprise)
  { feature_code: "data_governance", name: "Data governance & quality", category: "governance", min_edition: "enterprise", sort_order: 210, description: "Data domains, policies, quality rules, exceptions and remediation." },
  { feature_code: "data_catalog", name: "Data catalog & glossary", category: "governance", min_edition: "enterprise", sort_order: 220, description: "Unified metadata registry, business glossary, lineage and impact." },
  { feature_code: "data_lifecycle", name: "Data lifecycle & archival", category: "governance", min_edition: "enterprise", sort_order: 230, description: "Lifecycle states, retention, legal holds, archive and restore." },
  { feature_code: "data_security", name: "Data security & entitlements", category: "governance", min_edition: "enterprise", sort_order: 240, description: "Object-type enforcement, field security, masking and decisions." },

  // Exchange & integration
  { feature_code: "data_exchange", name: "Import & export framework", category: "exchange", min_edition: "enterprise", sort_order: 250, description: "Connector-based import/export definitions, jobs and reconciliation." },
  { feature_code: "migration", name: "Migration & onboarding", category: "exchange", min_edition: "enterprise", sort_order: 260, description: "Source adapters, migration projects, packages and reconciliation." },
  { feature_code: "integration", name: "Integration hub", category: "exchange", min_edition: "enterprise", sort_order: 270, description: "External systems, credentials, adapters, webhooks and API governance." },
  { feature_code: "events", name: "Event & messaging framework", category: "exchange", min_edition: "standard", sort_order: 280, description: "Event backbone, subscriptions, deliveries, replay and retention." },

  // Operations (Enterprise)
  { feature_code: "reporting", name: "Reporting & analytics", category: "operations", min_edition: "enterprise", sort_order: 290, description: "Reports, dashboards, KPIs, metrics and scheduled distribution." },
  { feature_code: "observability", name: "Data observability", category: "operations", min_edition: "enterprise", sort_order: 300, description: "Health, metrics, freshness, quality signals, alerts and SLOs." },

  // Topology-specific entitlements
  { feature_code: "self_service_signup", name: "Self-service tenant signup", category: "topology", min_edition: "enterprise", allowed_modes: "saas", sort_order: 400, description: "Allow new tenants to register and onboard themselves (Cloud SaaS only)." },
  { feature_code: "usage_telemetry", name: "Vendor usage telemetry", category: "topology", min_edition: "community", allowed_modes: "saas,private_cloud", sort_order: 410, description: "Share anonymized usage metrics with the vendor; unavailable on air-gapped local installs." },
  { feature_code: "offline_install", name: "Offline / air-gapped operation", category: "topology", min_edition: "community", allowed_modes: "local,private_cloud", sort_order: 420, description: "Run without outbound internet access or vendor services." },
]);

export const FEATURE_CODES = Object.freeze(FEATURE_CATALOG.map((f) => f.feature_code));

// ── Validation bounds ────────────────────────────────────────────────────────

export const CONFIG_BOUNDS = Object.freeze({
  installation_name: { min: 1, max: 120 },
  support_email: { max: 254 },
  notes: { max: 2000 },
  feature_notes: { max: 1000 },
});

// ── IAM resources ────────────────────────────────────────────────────────────

export const DEPLOYMENT_RESOURCES = Object.freeze({
  module: "iam.deployment",
  profile: "iam.deployment.profile",
  features: "iam.deployment.features",
  history: "iam.deployment.history",
});

// ── Domain events ────────────────────────────────────────────────────────────

export const DEPLOYMENT_EVENT_TYPES = Object.freeze([
  { code: "DeploymentProfileUpdated", description: "The deployment mode, edition or profile was changed." },
  { code: "DeploymentFeatureChanged", description: "A feature entitlement was enabled, disabled or annotated." },
]);
