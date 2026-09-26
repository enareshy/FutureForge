# Enterprise Reference Data Management (ERDM) — Design

Enterprise Reference Data Management is the platform's single source of truth for
governed, reusable master and reference values: units of measure, currencies,
countries, languages, time zones, plant types, product categories, material
types, document types, industry codes, standards, status codes and reason codes.
It is a distinct capability from Metadata & Configuration: Metadata LOVs remain
lightweight UI/configuration value lists, while ERDM owns the enterprise-governed
values that business modules consume (and that Metadata can optionally reference).

ERDM reuses the platform foundations rather than re-implementing them: the
Background Job engine runs maintenance sweeps, the Audit service records every
mutation, the Event & Messaging Framework publishes domain events through the
transactional outbox, Search & Discovery indexes reference items, and the
authorization layer protects every operation through the `iam.reference.*`
permission resources.

## Goals

- A canonical domain catalogue where new domains are configuration, not code.
- A generic governed item model: domain-specific attributes live in
  `attributes_json`; core tables never grow domain-specific columns.
- Explicit ownership and stewardship with an ownership-history trail.
- Versioned governance policies per domain (approval, alias, hierarchy, effective
  dating, versioning, code-reuse and lifecycle rules).
- Multi-scope values (Global, Tenant, Organization, Company, Business Unit, Plant,
  Site) with configurable precedence and deterministic conflict resolution.
- Rich value metadata: alternate codes, aliases, translations, hierarchy,
  cross-domain relationships, effective dates and full version history.
- Consumption through a stable SDK (`resolveValue`, `listValues`, `searchValues`,
  `validateValue`) instead of direct table access by business modules.
- Import/export, search, metrics, dashboard and health for operations.

## Architecture

```
        Reference data console (/reference-data)   Business modules / SDK
                        │                                   │
                        │  /api/reference-data, /api/v1/reference-data
                        ▼                                   ▼
             Express router (auth + can("iam.reference.*"))
                        │
                        ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ server/services/reference/*  (facade: server/services/reference.js) │
   │  domains · governance · items · codes · aliases · translations │
   │  hierarchy · relationships · versions · scope · resolution     │
   │  approvals · importexport · search · metrics · jobs · seed     │
   └───────────────────────────────────────────────────────────────┘
                        │
   ┌────────────┬───────┴────────┬──────────────┬───────────────┐
   │ Audit      │ Events (outbox)│ Jobs         │ Search         │
   └────────────┴────────────────┴──────────────┴───────────────┘
                        │
                        ▼
         reference_* tables (SQLite / node:sqlite)
```

## Domain model

- `reference_domains` — one row per governed domain, scoped by tenant (NULL =
  global). Carries category, status, scope type, ownership and stewardship.
- `reference_governance_policies` — append-only versioned policy rows per domain.
  The highest `version` with `status = active` is the effective policy. Missing
  rows fall back to `defaultGovernanceShape()`.
- `reference_data_items` — governed values. Holds the core identity (`item_ref`,
  `code`, `name`), lifecycle `status`, `scope_type`/`scope_key`, effective dates,
  `current_version_number`, hierarchy pointers and the generic `attributes_json`.
- `reference_data_versions` — immutable snapshots of an item as it changes.
- `reference_codes` — alternate/external codes (`code_system`, `code_type`).
- `reference_aliases` — synonyms, symbols and historic names with language.
- `reference_translations` — localized name/description per language.
- `reference_hierarchy` — parent/child edges with cycle detection and materialized
  `hierarchy_path`/`hierarchy_level` on the item.
- `reference_relationships` — typed cross-domain associations.
- `reference_scope_policies` — configurable precedence per tenant.
- `reference_approvals` — approval requests and decisions for item lifecycle.
- `reference_ownership_history` — ownership/stewardship change log.
- `reference_change_requests` — proposed changes routed through governance.
- `reference_imports` / `reference_exports` — staged import validation and export
  artifacts.
- `reference_cache_epoch` — monotonic epoch used to invalidate the read cache.

## Governance policies

Each domain carries a versioned policy that controls:

- `approval_required` — activation requires an approved approval record.
- `alias_enabled`, `hierarchy_enabled`, `translation_required`.
- `effective_dating_enabled`, `versioning_enabled`.
- `code_reuse_policy` (`never_reuse`, `reuse_after_retire`, `always`).
- `code_case_sensitive`, `code_pattern`.
- `default_language` and an ordered `lifecycle`.

Policies are published as new versions; existing behaviour is never mutated in
place, so the active policy is always reproducible by version.

## Scope precedence and resolution

Scope keys are built from the item scope type and context (`GLOBAL`, `TENANT:<id>`,
`ORGANIZATION:<id>`, `PLANT:<id>`, ...). Each tenant has a default scope policy
with precedence `PLANT -> ORGANIZATION -> TENANT -> GLOBAL`. Resolution:

1. Build the candidate scope keys from the precedence list and the request context.
2. Query active, effective items in those scopes (plus GLOBAL fallback).
3. Score by precedence and choose the most specific; ties are broken by
   `conflict_strategy` (`error`, `highest_precedence`, `latest_version`).
4. Cache the result keyed by `(epoch, tenant, request)`. Every governed mutation
   bumps `reference_cache_epoch`, so stale entries are never returned.

## Lifecycle

Item statuses are `draft`, `submitted`, `under_review`, `approved`, `active`,
`inactive`, `retired`, `rejected`, `returned`. Allowed transitions live in a
single transition graph (`reference/validation.js`) and are enforced for every
status change. When a domain requires approval, activation is blocked until an
approval decision is recorded.

## Consuming reference data

Business modules must call the SDK, never read reference tables directly:

```js
import { resolveValue, listValues, searchValues, ReferenceData } from "../services/reference.js";

const uom = resolveValue(db, { domain_code: "UNIT_OF_MEASURE", code: "EA" }, { tenantId });
const values = listValues(db, { domain_code: "COUNTRY", language: "de" }, { tenantId });
const hits = searchValues(db, { text: "kilogram" }, { tenantId });
```

Resolution applies scope precedence, effective dating, language and caching on
every call so consumers behave identically everywhere.

## Integration points

- **Audit** — every domain, governance, item, code, alias, translation, hierarchy,
  relationship, approval and import/export mutation writes an audit entry.
- **Events** — 19 `Reference*` domain event types are registered and emitted
  through the transactional outbox.
- **Search** — reference items are registered as the `reference_item` object type
  and indexed through the platform search framework.
- **Jobs** — `REFERENCE_MAINTENANCE` converges the search index and prunes expired
  export artifacts.

## Design notes

- ERDM is intentionally separate from Metadata LOVs. Reuse is by integration, not
  by extension: Metadata can reference ERDM domains without ERDM inheriting LOV
  semantics.
- The item model is generic by design; new domain fields are configuration, and
  new mandatory domains are seeded, not coded into tables.
- `item_ref` includes the scope slug for non-global items so values with the same
  code can coexist across scopes.
