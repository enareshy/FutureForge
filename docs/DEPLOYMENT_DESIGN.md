# Deployment & Edition Framework - Design

The Deployment domain (`deployment`) is the platform's **commercial and
topological posture**: it records how a given install is deployed and what it
is entitled to. One codebase ships in three topologies — **Cloud SaaS**,
**Private Cloud** and **Local / On-premises** — and is licensed at one of
three ranked editions — **Community**, **Standard**, **Enterprise**. This
module is the single source of truth for that posture; no other engine
re-declares it.

Source of truth: `server/services/deployment/`. Tables: `deployment_profile`,
`deployment_features`, `deployment_history` in `server/schema.sql`, marker
`037_deployment_editions`. REST surface: `/api/deployment` and
`/api/v1/deployment`.

## Why a dedicated framework

The platform has many capability modules (PDM, BOM, Change Management, data
governance, exchange, observability, …). Previously each was always available
to every authenticated caller. A product that is sold as SaaS, private cloud
and air-gapped on-prem needs one governed answer to "is this install allowed
to use this capability?" — derived from the recorded contract, not scattered
feature flags. This framework provides that answer and enforces it in one
place (`requireFeature`).

## Architectural rules

- **Contract and override are separate.** `min_edition` and `allowed_modes`
  describe what the deployment is entitled to *by contract*.
  `deployment_features.enabled` is the operator's *override*. The effective
  flag is derived at read time (`features.js`), so a downgrade or an operator
  toggle can never silently erase the recorded contract.
- **Ranked editions.** `community` (1) < `standard` (2) < `enterprise` (3).
  A feature is edition-satisfied when the licensed rank is at or above its
  `min_edition`.
- **Topology constraints.** `allowed_modes` (empty = all) restricts a feature
  to particular topologies. `self_service_signup` is Cloud-SaaS only;
  `usage_telemetry` and `offline_install` exclude the topologies where they do
  not apply.
- **Derived, cached, invalidated on write.** `resolveCapabilities(db)` builds
  the full capability map once and caches it per database (`cache.js`, a
  `WeakMap`). Every profile/feature write invalidates the cache, so the gate
  stays cheap on hot request paths.
- **One audit engine.** Every change writes the domain ledger
  (`deployment_history`) **and** the centralized Audit & History Framework —
  never a second audit implementation. `requireFeature` denials are audited as
  `deployment.feature.denied`.

## Object model

| Object | Table | Notes |
| --- | --- | --- |
| Deployment profile | `deployment_profile` | Exactly one row (`id = 1`): mode, edition, installation name, tenant strategy, self-registration, telemetry, support email, notes |
| Feature entitlement | `deployment_features` | Catalog of platform features with `min_edition`, `allowed_modes`, operator `enabled` and notes |
| History | `deployment_history` | Append-only ledger of profile/feature changes: before/after/diff JSON + actor + IP |

## The entitlement catalog

`constants.js:FEATURE_CATALOG` is the authoritative list. Features are grouped
into categories:

- **core** — identity, metadata, objects, files, content, search,
  notifications, jobs, audit (Community).
- **engineering** — workflow, numbering, versioning, reference data,
  classification, BOM, PDM, change management (Standard); digital thread and
  standards exchange (Enterprise).
- **governance** — data governance, catalog/glossary, lifecycle, data security
  (Enterprise).
- **exchange** — import/export, migration, integration (Enterprise); events
  (Standard).
- **operations** — reporting, observability (Enterprise).
- **topology** — `self_service_signup` (SaaS-only), `usage_telemetry`
  (SaaS/private cloud), `offline_install` (local/private cloud).

Unknown feature codes are never gated (`isFeatureEnabled` returns `true`), so
the catalog can grow without breaking callers.

## Enforcement

`server/middleware.js:requireFeature(db, code)` gates a router: when the
feature is not effective it audits the denial and rejects with a `403` whose
body names the feature and reason (`feature_not_entitled`), so the console can
explain *why* a module is unavailable. It is applied to the reporting and
observability routers in `server/app.js`.

The web console resolves the posture once after login via `/api/auth/me`
(which embeds `deployment.features`) and hides navigation for unentitled
features; `/api/deployment/capabilities` remains open to any authenticated
caller for the same purpose.

## Profile defaults on topology change

`profile.js:updateProfile` adopts the target topology's recommended defaults
(`default_tenant_strategy`, `default_self_registration`) when the mode changes
and the caller was not explicit — switching to Cloud SaaS does not silently
keep a single-tenant, self-registration-off posture.

## Related

- API reference: `docs/DEPLOYMENT_API.md`
