# Data Catalog & Business Glossary Design

The Data Catalog & Business Glossary capability is the single centralized platform
service for the enterprise's business language: business terms and their
definitions, data domains, cataloged data objects and attributes, data sources
and consumers, classifications, ownership and stewardship, lineage and the
relationships between all of them. Business modules register their metadata with
this service; they never build their own glossary, catalog or lineage model.

The catalog describes **metadata only**. It records where data lives and who is
accountable for it, and it never stores business data, credentials, connection
strings or payloads.

Related documents: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`,
`docs/ORGS_DESIGN.md`, `docs/DATA_SECURITY_DESIGN.md`,
`docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/REFERENCE_DATA_DESIGN.md`,
`docs/SEARCH_FOUNDATION_DESIGN.md`, `docs/EVENTS_DESIGN.md`,
`docs/WORKFLOW_ENGINE_DESIGN.md`, `docs/JOB_EXECUTION_DESIGN.md`,
`docs/AUDIT_DESIGN.md`, `docs/DATA_GOVERNANCE_DESIGN.md` and the HTTP reference
`docs/CATALOG_API.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| Business terms, definitions, synonyms, glossary relations and mappings | Data Catalog & Business Glossary service |
| Data domains | Data Governance domain registry (reused; the catalog references it) |
| Data objects, attributes, sources, consumers, lineage, classifications, ownership | Data Catalog & Business Glossary service |
| Users, groups, roles, permissions, resource catalogue | IAM / Authorization |
| Tenant, organization, plant and site hierarchy | Organization Management |
| Object types, relationship types and typed object metadata | Metadata + Object & Relationship Framework |
| Reference domains and value validation | Enterprise Reference Data |
| Term approval workflow | Workflow Engine |
| Background execution, retries and scheduling | Job Execution Framework |
| Domain events and subscriptions | Event & Messaging framework |
| Audit trail of catalog administration | Audit & History |
| Notifications on catalog changes and ownership gaps | Notifications + Delivery |
| Search over terms, objects, sources and consumers | Search Foundation |

The service never reads another module's tables directly. Domains are read from
the Data Governance service through its public facade, and term approval is
driven by the Workflow service through its public API.

## 2. Data model

All tables use the `dc_` prefix and are tenant scoped. Domains are owned by the
governance module and referenced by id; every other entity is owned here.

| Table | Purpose |
| --- | --- |
| `dc_entries` | Unified metadata registry: one row per cataloged thing (domain, object, attribute, term, source, consumer, classification, lineage) |
| `dc_metadata_versions` | Immutable metadata-change snapshots per entry |
| `dc_catalog_objects` | Cataloged object types, their domain, source and classification |
| `dc_catalog_attributes` | Attributes of an object: data type, mandatory, definition, classification |
| `dc_business_terms` | Glossary terms with lifecycle and approval status |
| `dc_term_definitions` | Typed definitions per term (BUSINESS / TECHNICAL / OPERATIONAL / CALCULATION) |
| `dc_term_synonyms` | Synonyms, abbreviations, acronyms, aliases and deprecated names |
| `dc_term_relations` | Term-to-term relationships (`RELATED_TO`, `BROADER_THAN`, ...) |
| `dc_term_mappings` | Term-to-target mappings (object, attribute, domain, source, consumer) |
| `dc_relationship_types` / `dc_relationships` | Configured relationship types and entity-to-entity relationships |
| `dc_sources` | Data sources with a metadata-only `connection_reference` |
| `dc_source_mappings` | Source-to-object/attribute mappings |
| `dc_consumers` | Data consumers (applications, reports, models, users, ...) |
| `dc_consumer_mappings` | Consumer-to-object/attribute mappings |
| `dc_lineage` | Directed lineage edges between typed endpoints |
| `dc_classifications` | Business/security classifications with an ordered rank |
| `dc_classification_assignments` | Classification assignments to entries |
| `dc_ownership` | Owner/steward assignments with accountable subject and scope |
| `dc_import_runs` | Import bookkeeping (stats, errors, status) |
| `dc_configuration` | Per-tenant catalog configuration |

### Unified registry

Every cataloged item is registered once in `dc_entries` with an `entry_type`
(`DOMAIN`, `OBJECT`, `ATTRIBUTE`, `BUSINESS_TERM`, `SOURCE`, `CONSUMER`,
`CLASSIFICATION`, `LINEAGE`) and an `entry_ref` (for example `DC-OBJECT-CUSTOMER`
or `DC-ATTRIBUTE-CUSTOMER.CUSTOMER.COUNTRY`). Type-specific tables hold the
detail and point back to the entry. This gives the catalog one consistent place
for listing, full-text search, classification, ownership, lineage endpoints and
metadata versioning.

## 3. Business language chain

The catalog models the chain the enterprise asks about:

```
Business Language → Business Terms → Data Domains → Data Objects → Attributes → Sources / Consumers
```

- A **business term** carries definitions, synonyms, relations, an owner and a
  lifecycle, and is mapped to the objects, attributes, domains, sources and
  consumers it describes.
- **Definitions** are typed and versioned per term. A term can be approved only
  when it has a definition when `require_definition_for_approval` is set.
- **Domains** group cataloged objects and attributes and come from the governance
  domain registry so the two capabilities always agree on the same domains.
- **Objects and attributes** describe the shape of data; attributes inherit the
  object's classification and owner unless overridden.
- **Sources and consumers** describe where data comes from and who uses it. They
  are connected to objects and attributes through mappings, which is what makes
  impact analysis possible.

## 4. Lineage and impact

Lineage edges are directed, typed relationships between catalog endpoints
(`from_type`/`from_id` → `to_type`/`to_id`) with a relationship type
(`DERIVED_FROM`, `POPULATES`, `CONSUMES`, `COPIES`, ...). Traversal is bounded:
`LINEAGE_MAX_DEPTH` (6) and `LINEAGE_MAX_NODES` (200), with a default depth of 2.
Lineage carries metadata about the transformation and job reference, never the
transformation logic or payload itself.

- `lineageGraph` returns a bounded, deduplicated node/edge sub-graph in the
  requested direction (`upstream`, `downstream` or `both`).
- `impact` walks downstream to answer "what is affected if this changes?".
- Traversal stops at the configured bounds and reports truncation instead of
  running unbounded.

## 5. Classifications and ownership

- **Classifications** are tenant-defined, ranked by `rank` and carry a security
  classification. Assigning a classification to an entry sets the entry's
  effective classification to the highest-ranked assignment, so the strongest
  security label always wins.
- **Ownership** assigns an accountable subject (user, group, role or
  organization) to an entry with an ownership kind (`DATA_OWNER`, `DATA_STEWARD`,
  `TECHNICAL_OWNER`, `BUSINESS_OWNER`) and an `owner`/`steward` relationship.
  Ownership gaps report entries without an accountable owner so they can be
  closed, and ownership can be resolved by walking the entry and its parents.

## 6. Multi-tenancy and security

- Every table and query is tenant scoped; tenant identity is always derived
  server-side from the authenticated session and never accepted from the client.
- Counts, metrics and health aggregates are computed only over the caller's
  tenant, so dashboards and messages cannot leak catalog metadata across tenants.
- Access is enforced with the standard IAM permission model. Resource codes are
  `iam.data_catalog.*`; roles are configured through IAM, never hard-coded in the
  service.
- `connection_reference` is metadata only. `assertConnectionReference` rejects
  URLs and connection strings, so a catalog source can never become a credential
  store.

## 7. Platform reuse

| Platform capability | Reuse |
| --- | --- |
| Governance | Domains are read from `data-governance`; there is one domain registry |
| Workflow | Term review/approval runs through the platform Workflow service |
| Events | `BusinessTerm*`, `Catalog*` and `Lineage*` event types registered idempotently |
| Jobs | Four catalog job types + handlers registered on the shared worker |
| Search | Terms, objects, sources and consumers registered as searchable object types |
| Security model | Entries inherit the platform classification vocabulary and enforcement |
| Notifications | Catalog changes and ownership gaps raise platform notifications |
| Audit | Every administration action writes an audit record |
| Reference data | Domains, classifications and definitions reuse platform vocabularies |

## 8. Source layout

```
server/services/data-catalog/
  constants.js        vocabularies, transitions, config defaults, event/job types, IAM resources
  errors.js           typed HttpError subclasses (DATA_CATALOG_*)
  validation.js       normalisation, assertion, pagination, vocabulary()
  refs.js             public reference generators (DC-OBJECT-, DC-TERM-, DC-SRC-, ...)
  repository.js       row -> public DTO mappers
  entries.js          unified registry, metadata versions, entry status
  objects.js          catalog objects and attributes
  glossary.js         business terms, definitions, synonyms, relations, mappings
  sources.js          data sources and source mappings
  consumers.js        data consumers and consumer mappings
  lineage.js          lineage edges, bounded graph traversal and impact
  relationships.js    relationship types and entity relationships
  classifications.js  classifications and assignments
  ownership.js        ownership/stewardship assignments and gap analysis
  configuration.js    per-tenant configuration
  importexport.js     CSV/JSON import/export
  events.js           event type registration and publishing
  jobs.js             background job handlers and submission
  search.js           search registrations
  notifications.js    notification helpers
  metrics.js          metrics and health
  foundation.js       idempotent bootstrap
  seed.js             demonstration estate seed
  index.js            public facade / stable SDK
  router-data-catalog.js  /api/data-catalog REST router
  router-glossary.js      /api/glossary REST router
```

## 9. Facade SDK

`server/services/data-catalog/index.js` exposes a flat SDK used by the routers,
the seed and other modules:

```
constants  errors  Validation  Refs
Entries  Objects  Glossary  Sources  Consumers  Lineage  Relationships
Classifications  Ownership  Configuration  ImportExport  Metrics  Foundation
Seed  registerCatalogHandlers  runCatalogMaintenance
ensureDataCatalogFoundation  ensureDataCatalogSeed
```
