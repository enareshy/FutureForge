# File & Content Management Service - Design

The File & Content Management Service is the platform's single owner of physical
binary content. Business modules (Documents, PDM, BOM, BOP, Requirements,
Quality, Service, etc.) own *business meaning* and metadata; this service owns
*bytes*, storage placement, content versions, security scanning, renditions,
associations, check-out locking and retention. It is object-type agnostic: a
generic `object_type`/`object_id` association lets any module attach content
without coupling the content layer to that module's schema.

## Goals

- Separate the Document Object (business metadata, lifecycle, revision) from
  physical content variants (Native, PDF, JT, Preview, Thumbnail, Rendition,
  Attachment).
- Storage is provider-independent. The service owns only opaque storage keys and
  delegates read/write/sign to a pluggable storage provider.
- A controlled, resumable upload pipeline with MIME detection, size/extension
  validation, checksum verification and virus scanning.
- Immutable content versions that never destroy history, independent of business
  revision numbering.
- Exclusive check-out/check-in locking with lease expiry and privileged
  force-release.
- Expensive processing (PDF/JT/image/thumbnail/preview transpilation) delegated
  to the Background Job engine, never executed inline in the API request.
- Retention policies and legal holds: expiry only marks content eligible, it
  never auto-deletes; a legal hold always wins.
- Reuse of platform foundations - Audit, Events, Jobs, Search, Lifecycle,
  Versioning, Permissions - instead of re-implementing them.

## Architecture

```
                        ┌────────────────── UI (React) ──────────────────┐
                        │  Content library · uploads · check-outs ·       │
                        │  associations · retention · administration      │
                        └───────────────────────┬────────────────────────┘
                                                │ /api/content, /api/v1/content
                        ┌───────────────────────▼────────────────────────┐
                        │ Express router (createContentRouter)           │
                        │ auth + can("iam.content.*")                     │
                        └───────────────────────┬────────────────────────┘
                                                │
   ┌──────────┬──────────┬──────────┬──────────┼──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼          ▼          ▼          ▼
Upload     Content    Versions   Renditions  Locks    Associations Retention  Processing
sessions   lifecycle             processors                 + search              jobs
   │          │          │          │          │          │          │          │
   └──────────┴──────────┴────┬─────┴──────────┴──────────┴──────────┴──────────┘
                              ▼
   Content storage provider (pluggable) · Virus scan provider (pluggable)
   Audit · Event outbox · Search index · Background job engine (shared SQLite)

Business modules depend on the flat SDK in `server/services/content.js`
(`createContent`, `initiateUploadSession`, `completeUploadSession`,
`checkOutContent`, `checkInContent`, `createAssociation`, `listObjectContent`,
`downloadInfo`, `applyLegalHold`, `ContentService`, `ensureContentFoundation`,
`registerContentHandlers`, `runContentMaintenance`, `seedContent`) and never
touch the tables directly.
```

## Module layout

- `server/services/content.js` - public facade, flat SDK and namespace exports.
- `server/services/content/constants.js` - vocabulary, transition map, limits,
  resource permission map, event types and error-code table.
- `server/services/content/errors.js` - `ContentError` / `contentError`, stable
  machine-readable codes.
- `server/services/content/refs.js` - opaque reference generation (`CNT-`, `CAS-`,
  `RND-`, `UPL-`, `LCK-`, `policyRef`, `versionLabel`).
- `server/services/content/validation.js` - MIME resolution, filename
  sanitisation, dangerous-extension detection, public vocabulary.
- `server/services/content/storage.js` - `ContentStorageProvider` wrapper over the
  shared `file-storage` providers; key building and tenant namespacing.
- `server/services/content/repository.js` - data access and public projections.
- `server/services/content/events.js` - content event types and outbox/event
  publishing.
- `server/services/content/security.js` - scan orchestration, outcome
  application, quarantine/release, scan history.
- `server/services/content/versions.js` - immutable version creation,
  storage references, download resolution, restore.
- `server/services/content/renditions.js` - rendition model, pluggable
  processors, request/status/skip handling.
- `server/services/content/processing.js` - processing job types, job handlers,
  requeue, processing status.
- `server/services/content/content.js` - content CRUD, metadata, download info,
  facets, events, soft delete/restore.
- `server/services/content/sessions.js` - upload session lifecycle, parts,
  completion, abort, TTL expiry.
- `server/services/content/locks.js` - check-out/check-in, lease expiry,
  force-release.
- `server/services/content/associations.js` - generic object/content
  associations, primary selection.
- `server/services/content/retention.js` - retention policies, retention records,
  legal holds, delete eligibility.
- `server/services/content/lifecycle.js` - content state machine, transitions,
  archive/supersede/retain.
- `server/services/content/search.js` - Search source registration and indexing.
- `server/services/content/metrics.js` - metrics, storage/security/processing
  summaries.
- `server/services/content/seed.js` - default retention policies and demo seed.
- `server/services/content/foundation.js` - boot foundation and health.
- `server/services/content/jobs.js` - maintenance job handlers.
- `server/services/content/router.js` - REST router factory.

## Domain model

- **content** - one logical piece of content. Holds owner scope
  (`tenant_id`, `organization_id`, `plant_id`, `site_id`, `department_id`),
  bindings (`object_type`, `object_id`, `versioning_revision_id`, `version_id`),
  the current snapshot (`file_name`, `mime_type`, `file_size`, `checksum`,
  `storage_key`), `content_role`, `content_type`, `is_primary`, `status`,
  `security_status`, `processing_status`, `security_classification`,
  `current_version_id`, `version_count`, soft-delete and dedupe reference.
- **content_versions** - immutable historical snapshots. Each has
  `version_number`, `version_label`, its own storage key, checksum, security
  state and optional restore lineage. The current snapshot lives on `content`;
  versions are never destroyed.
- **content_storage_references** - every storage key owned by a version or
  rendition, with `status` (`active`/`orphaned`) for reconciliation.
- **content_renditions** - derived artifacts (PDF, JT, PREVIEW, THUMBNAIL,
  IMAGE, TEXT), each with generator metadata and `requested`/`processing`/
  `available`/`failed`/`skipped`/`outdated` states.
- **content_upload_sessions** / **content_upload_parts** - resumable upload
  state: staging key, chunk size, expected/received size, received chunks,
  declared/actual checksum, idempotency key and TTL.
- **content_locks** - exclusive check-out leases (`lock_token`, `locked_by`,
  `expires_at`, release lineage).
- **content_associations** - generic joins from any object to content with
  `content_role`, `is_primary`, `sequence`, `effective_from/to` and status.
- **content_security_scans** - scan history per version with scanner, status,
  signature and severity.
- **content_processing_jobs** - processing work items and their outcomes.
- **content_retention_policies** - reusable retention rules (code, days, start
  basis, disposition, applies-to filters).
- **content_retention_records** - per-content retention window and legal-hold
  flag.
- **content_legal_holds** - active/released legal holds with case reference.
- **content_events** - transactional event outbox for content domain events.

## Content roles and lifecycle

Roles (`NATIVE`, `PRIMARY`, `SECONDARY`, `PDF`, `JT`, `PREVIEW`, `THUMBNAIL`,
`RENDITION`, `ATTACHMENT`) are extensible. Lifecycle states are:

```
initiated → pending_security → scanning → processing → available
                                                  ↘ quarantined
available ↔ locked → available
available → superseded | archived | retained | deleted
archived ↔ retained ↔ available
quarantined → available | failed | deleted
```

Transitions are declared in `CONTENT_TRANSITIONS` and enforced by
`Lifecycle.transitionContent`; an undeclared transition is rejected. Only
`available`, `locked`, `processing`, `retained` and `archived` content is
downloadable, and only when `security_status = clean`.

## Upload pipeline

Direct (single shot) uploads and multipart/resumable uploads share one pipeline:

```
initiate session → append parts (staging) → complete
  → checksum verification → MIME detection → virus scan
  → rendition/metadata processing → secure storage move
  → content + version + storage reference + association
```

- Filenames are sanitised and dangerous extensions rejected before any bytes are
  persisted.
- The service never trusts the client MIME type; it detects the effective type
  from name and content header.
- `declaredChecksum` is compared against the stored checksum; mismatch rejects
  the upload.
- Oversize payloads are rejected at both session initiation and completion.
- Sessions expire after a TTL and staged bytes are removed by the maintenance
  job.

## Security

- Provider-independent virus scanning. The heuristic provider detects the EICAR
  test signature and dangerous executable signatures; production deployments
  register a real scanner through `registerContentScanner`.
- Infected content is quarantined: status `quarantined`, security status
  `infected`, download blocked, audit recorded and a security event emitted.
- Download authorization is evaluated per request; signed URLs are short-lived
  and opaque.
- Cross-tenant isolation is enforced by every `findContentRow`/list call
  accepting and checking `tenantId`.
- Storage keys are generated server-side from tenant + object + content + date
  and a random UUID. Client input never reaches a storage path.
- The content storage provider exposes no enumeration API: callers can only
  operate on keys they already hold.

## Integration with platform foundations

- **Audit** - every content mutation, download, quarantine and hold is written
  through `recordObjectChange` / `writeAudit`.
- **Events** - content domain events are written to `content_events` and
  published through the platform event framework (category `content`).
- **Jobs** - virus scanning, rendition generation, retention evaluation and
  maintenance run as background jobs; the API stays responsive.
- **Search** - content is registered as a Search object type and indexed through
  the shared search hooks.
- **Lifecycle** - content has its own transition map but participates in the
  platform lifecycle model; it does not build an independent engine.
- **Versioning** - content versions are independent of business revision
  numbering but can carry `versioning_revision_id`/`version_id` bindings.

## Key decisions

1. **Bytes never live in business tables.** Content is referenced by opaque id;
   physical storage is tracked only in content tables.
2. **Content versions are immutable.** Check-in creates a new version; the
   previous version's bytes remain addressable.
3. **Retention never deletes implicitly.** Expiry marks eligible; deletion is an
   explicit, permissioned, audited action. A legal hold always blocks deletion,
   including for platform administrators.
4. **Deduplication is advisory.** A matching checksum+size is recorded as
   `dedupe_of_content_id`; storage keys remain per-content so authorization and
   lifecycle stay simple.
5. **Processing is asynchronous.** The API records intent; job handlers do the
   work and update content, version, rendition and processing state.

## Related documents

- `docs/CONTENT_MANAGEMENT_API.md` - REST API reference.
- `docs/CONTENT_MANAGEMENT_OPERATIONS.md` - configuration and operations.
- `docs/FILE_MANAGEMENT_DESIGN.md` - the Document & File module that consumes
  this capability.
