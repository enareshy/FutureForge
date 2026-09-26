# File & Content Management Service - Operations

This guide covers configuration, background processing, monitoring and routine
operations for the File & Content Management Service.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILE_STORAGE_PROVIDER` | `local` | Storage backend selected by the shared file-storage layer (`local`, `memory`, S3-compatible, etc.). Content uses it through `ContentStorageProvider`. |
| `FILE_SCAN_PROVIDER` | `heuristic` | Virus-scan provider. `heuristic` detects EICAR and known dangerous executable signatures. Register a real scanner in production via `registerContentScanner`. |
| `CONTENT_HTTP_UPLOAD_LIMIT` | `64mb` | Express raw-body limit for content upload requests (`FILE_HTTP_UPLOAD_LIMIT` is the fallback). |
| `CONTENT_MAINTENANCE_MS` | `60000` | Interval for the content housekeeping sweep in the job worker. |

Service defaults (see `server/services/content/constants.js`):

- `DEFAULT_CHUNK_SIZE` = 5 MiB
- `DEFAULT_MAX_CONTENT_BYTES` = 5 GiB
- `DEFAULT_UPLOAD_TTL_SECONDS` = 24 h
- `DEFAULT_LOCK_TTL_SECONDS` = 30 min
- `MAX_SCAN_BYTES` = 16 MiB (larger objects are scanned in bounded chunks)

## Bootstrapping

`ensureContentFoundation(db)` runs on application boot and is idempotent. It:

1. Ensures all content event types exist in the platform event registry.
2. Registers the `content` Search object type and registers the content search
   source.
3. Ensures default retention policies.
4. Verifies the storage provider and scan provider are resolvable.

Health is exposed at `GET /api/content/health` and included in `GET
/api/content/meta`.

## Background jobs

Content processing is asynchronous. The job worker registers the content
handlers and starts the housekeeping interval.

| Job type code | Job type | Handler | Purpose |
| --- | --- | --- | --- |
| `CONTENT_SECURITY_SCAN` | `content.scan` | `registerContentProcessingHandlers` | Virus scan and quarantine on detection. |
| `CONTENT_RENDITION` | `content.rendition` | `registerContentProcessingHandlers` | Generate PDF/JT/preview/thumbnail renditions. |
| `CONTENT_RETENTION` | `content.retention` | `registerContentHandlers` | Evaluate retention windows and mark eligibility. |
| `CONTENT_MAINTENANCE` | `content.maintenance` | `registerContentHandlers` | Periodic housekeeping. |

`runContentMaintenance(db)` performs:

- Expire abandoned upload sessions and delete their staged bytes.
- Release expired check-out locks.
- Evaluate retention and mark content eligible (never delete).
- Reindex content whose search state is stale.

Run the worker with:

```bash
node scripts/job-worker.js
```

## Monitoring

- `GET /api/content/metrics` - uploads, downloads, check-outs/check-ins, scan
  counts and detections, quarantine counts, renditions and failures, storage
  errors, orphan content, retention processing, legal holds, plus distributions
  by status/security/processing.
- `GET /api/content/storage/summary` - total bytes, object count, distinct
  checksums, dedupe savings and per-provider breakdown.
- `GET /api/content/health` - readiness of event types, search registration,
  retention policies, storage and scan providers.

Operational alarms worth configuring:

- `virus_detection_count` increasing unexpectedly.
- `quarantine_count` sustained above zero without review.
- `upload_failure_count` or `storage_errors` increasing.
- `rendition_failure_count` increasing.
- `orphan_content_count` increasing (storage references not bound to content).
- `legal_hold_count` changes (compliance-relevant).

## Retention and legal holds

1. Retention policies define a code, retention window, start basis and
   disposition (`review`, `archive`, `purge`).
2. When content is created, a retention record is attached based on the
   matching policy.
3. On expiry, maintenance marks the content **eligible**. It is never deleted
   automatically.
4. Deletion is an explicit, permissioned, audited action. `canDeleteContent`
   returns `{ allowed: false, reason: "LEGAL_HOLD_ACTIVE" }` or
   `RETENTION_POLICY_VIOLATION` while blocked.
5. A legal hold always wins, including for platform administrators. Apply with
   `POST /api/content/:ref/legal-hold`, release with
   `POST /api/content/:ref/legal-hold/release`.

## Security operations

- **Quarantine** - infected or suspect content is set to `quarantined` /
  `infected`; downloads return `CONTENT_QUARANTINED` (HTTP 423). Review and
  release with `POST /api/content/:ref/release-quarantine` after investigation.
- **Scanner upgrades** - register a production scanner at boot:
  `registerContentScanner("name", { scan(stream, context) { ... } })`. The
  scanner echoes the stable interface; a `clean`/`infected`/`failed` outcome is
  applied through `applyScanOutcome`.
- **Signed URLs** - short-lived, opaque and bound to a storage key. Do not log
  or persist them.

## Backup and recovery

- Back up the SQLite database (content metadata, versions, associations,
  retention, locks) and the storage backend together; they form one logical
  unit.
- Restore order: storage backend first, database second. Content whose bytes
  cannot be found surfaces as `has_content = false` and can be reconciled
  through the storage-reconciliation job.
- Dedupe is advisory, so restoring a single database snapshot with intact
  storage is always consistent.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `CONTENT_QUARANTINED` on download | Malware detected or manual quarantine. | Inspect `GET /:ref/security`, review, then release quarantine. |
| `CONTENT_LOCKED` on check-out | Another user holds the lease. | Wait for expiry or use `POST /:ref/unlock` with lock-delete permission. |
| `CHECKSUM_MISMATCH` completing an upload | Client-declared checksum wrong or corrupt transfer. | Re-upload the part and complete again. |
| `FILE_TOO_LARGE` | Exceeds `DEFAULT_MAX_CONTENT_BYTES` or `maxSize` override. | Split or raise the limit at the call site. |
| `INVALID_FILE_TYPE` | Dangerous or disallowed extension. | Rename or correct the source; do not weaken the blocklist. |
| `UPLOAD_SESSION_EXPIRED` | TTL elapsed or maintenance expired the session. | Restart the upload session. |
| Renditions stuck `processing` | Worker not running or failing. | Check the job worker, `GET /processing-jobs`, then requeue `POST /:ref/processing`. |
| `CONTENT_DELETION_NOT_ALLOWED` | Retention window or legal hold active. | Check `GET /:ref/retention`. |
| Search misses content | Index state stale. | Maintenance reindexes; force with the content search reindex path. |

## Tests

```bash
# Content service unit/integration suite
node --test server/tests/content.test.js

# REST API suite
node --test server/tests/content-api.test.js

# Security, tenant isolation and concurrency suite
node --test server/tests/content-security.test.js

# Full platform suite
npm test
```
