# Document & File Management Design

The Document & File Management module is the business-facing file layer of the
platform. It owns file metadata, folders, versions, check-in/check-out locking,
associations to business objects, collections, file-level access control,
search, processing status and the file event stream. Physical bytes are owned by
a separate **File Storage & Processing Services** module; the Document module
only ever references opaque storage keys.

Related documents: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`,
`docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/AUDIT_DESIGN.md`,
`docs/NOTIFICATIONS_DESIGN.md`, `docs/JOB_EXECUTION_DESIGN.md` and the day-2
guide `docs/FILE_MANAGEMENT_OPERATIONS.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| File metadata, folders, versions, locks, associations, collections | Document & File Management |
| File-level ACLs and permission evaluation | Document module, layered on IAM |
| Physical bytes, buckets/keys, signed URLs | File Storage & Processing Services |
| Virus scanning, previews, renditions | File Storage & Processing Services |
| Background execution of scan/preview jobs | Job Scheduling & Execution Engine |
| Audit trail, notifications, lifecycle, objects | Shared platform modules |

The Document module never exposes storage keys, buckets or paths in API
responses. Downloads are issued as short-lived signed tokens.

## 2. Data model

Defined in `server/schema.sql` (migration marker `017_files`):

| Table | Purpose |
| --- | --- |
| `folders` | Hierarchical, tenant-scoped folders with materialized `path` |
| `files` | File metadata and current status; one row per logical document |
| `file_versions` | Immutable contents; every upload/restore inserts a new row |
| `file_locks` | Active and historical check-out locks |
| `file_uploads` | Upload sessions (single, multipart/chunked, external) |
| `file_associations` | Links between files and business objects |
| `file_collections` | Curated groups of files |
| `file_collection_members` | Collection membership |
| `file_permissions` | Explicit file/folder ACL entries (allow/deny) |
| `file_processing` | Per-version processing state (scan, preview, rendition) |
| `file_events` | Durable domain-event outbox for files |

Key invariants:

- A file belongs to exactly one tenant; all queries are tenant-scoped.
- Versions are immutable. Restoring an old version copies its storage reference
  into a new current version rather than mutating history.
- An active check-out is enforced by the partial unique index
  `idx_file_locks_active`, so a file cannot have two live exclusive locks.
- File status is derived from upload and processing outcomes
  (`pending_scan → scan_in_progress → available | quarantined | scan_failed`).

## 3. Service layout

```
server/services/files/
  validation.js    vocabulary, filename/mime/size validation
  repository.js    row -> DTO mapping, tenant-safe lookups
  events.js        file_events outbox + notifications + audit bridge
  folders.js       folder CRUD, tree, breadcrumb, folder contents
  permissions.js   ACL evaluation layered on IAM checkPermission
  versions.js      version creation, restore, download descriptors
  files.js         metadata CRUD, list/search/filter/sort/facets, lifecycle
  uploads.js       upload sessions: initiate, chunk, complete, abort, expire
  locks.js         check-out/check-in, lock listing, release, expiry sweep
  associations.js  file <-> business object links
  collections.js   file collections and membership
  processing.js    scan/preview pipeline, status, requeue, job handlers
  metrics.js       tenant-scoped operational counters
server/services/file-storage/
  config.js        provider/root/bucket/chunk/signed-url configuration
  provider.js      local and in-memory storage providers
  signing.js       HMAC download tokens
  scanning.js      virus scanning adapter
  previews.js      preview/rendition adapter
  processing.js    processing pipeline primitives
```

`server/services/files.js` and `server/services/file-storage.js` are facades;
`server/platform.js` re-exports the stable in-process surface for other modules.

## 4. Upload flows

All uploads create a `file_uploads` session first. Sessions support:

- **single** — one request completes the upload.
- **multipart** — bytes are appended chunk by chunk to a staging key, then moved
  into the tenant object prefix on completion.
- **external** — bytes already exist in storage (for example a direct-to-storage
  upload); completion verifies the object and records the version.

Upload features:

- Idempotency via `idempotency_key`, so retried initiations reuse a session.
- Resumable chunk uploads with per-chunk size validation and progress tracking.
- Declared size and checksum verification on completion.
- Expiry (`FILE_UPLOAD_TTL_HOURS`, default 24h) with a worker sweep that drops
  staging data.
- Uploading against an existing `file_id` creates a new **version** of that file
  instead of a new file.

## 5. Storage and download

`server/services/file-storage.js` exposes a provider abstraction. The default
`local` provider stores objects under `data/files`; the `memory` provider is used
by tests. Downloads are never streamed straight from metadata routes. Instead:

1. The caller requests `/api/files/:reference/download` (or a version download).
2. The backend builds a signed, short-lived HMAC token
   (`FILE_SIGNING_SECRET`, TTL `FILE_SIGNED_URL_TTL`, default 900s).
3. The caller fetches `/api/files/download/:token`, which verifies the token,
   re-checks authorization and streams the stored object.

This keeps storage keys internal and lets links expire.

## 6. Security and access control

- **Tenant isolation**: every read and write asserts the tenant scope; cross
  tenant references resolve as 404.
- **IAM + ACL**: `checkPermission` on the `iam.files.*` resources provides the
  baseline. `file_permissions` adds explicit file/folder grants and denials:
  explicit deny wins, explicit allow grants, the owner is always allowed, and
  otherwise the IAM decision applies.
- **Resource codes**: `iam.files.browser`, `details`, `uploads`, `versions`,
  `locks`, `associations`, `folders`, `permissions`.
- **Payload protection**: storage keys, buckets and paths are stripped from
  responses; provider configuration is never returned.
- **Audit**: metadata, permission and lifecycle changes are written to
  `file_events` and to the platform audit trail via `auditFile`.

## 7. Processing pipeline

Virus scanning, previews and renditions are handled by the File Storage &
Processing Services module and driven by the job engine:

- Job types `FILE_VIRUS_SCAN` (`files.virusScan`) and
  `FILE_PREVIEW_GENERATION` (`files.previewGeneration`) are registered in
  `server/services/jobs/types.js`.
- `server/services/files/processing.js` runs the pipeline outside the database
  transaction, then persists all derived state atomically via
  `persistProcessingResult`.
- Handlers are idempotent, so at-least-once delivery is safe.
- Failed or pending processing is visible through `/api/files/:ref/processing`
  and the file administration console, and can be requeued.

## 8. Events and integrations

- Domain events (upload, version, check-out/in, association, delete, scan
  results) are written to `file_events` and re-published best-effort through the
  notification service.
- File processing and scheduled maintenance (upload expiry, lock expiry) run in
  `scripts/job-worker.js`.
- File associations connect documents to metadata-typed business objects without
  duplicating the object framework.

## 9. REST surface

- `/api/files` — list/search/filter/sort, `POST` create via upload; `meta`,
  `metrics`, `metrics/storage`, `metrics/processing`, `facets`, `events`
- `/api/files/:reference` — get, update, delete, `restore`, `move`, `events`,
  `permissions`, `processing` (+ `requeue`), `download`
- `/api/files/:reference/versions` — list, create, get, `restore`, `download`
- `/api/files/:reference/lock` `checkout` `checkin` `lock/release`
  `lock/force-release` — locking
- `/api/files/uploads` — upload session lifecycle
- `/api/files/upload` — single-request convenience upload
- `/api/files/download/:token` — signed object streaming
- `/api/files/permissions` — ACL administration
- `/api/file-associations` — file to business-object links
- `/api/folders` — folder tree, contents, breadcrumb
- `/api/file-collections` — collections and membership
- `/api/file-locks` — tenant-wide active lock view

## 10. Console

- `/files` — file browser: folder navigation, search/filter/sort, upload,
  download, delete/restore.
- `/files/:ref` — file details: metadata, versions, access control,
  associations, processing and events.
- `/files/admin` — administration: storage and processing metrics, active locks,
  upload sessions, permissions and file events.

Client code lives in `web/src/pages/FilesPage.jsx`,
`web/src/pages/FileDetailPage.jsx`, `web/src/pages/FileAdminPage.jsx` and the
`files` namespace in `web/src/api.js`.
