# File & Content Management Service - REST API

All endpoints are mounted under `/api/content` (and `/api/v1/content`). Every
request requires a bearer token. Permission checks use the `iam.content.*`
resource family; each endpoint below lists the required resource/action.

Errors use the standard `{ error, code, details }` envelope. Content errors are
stable machine-readable codes (for example `CONTENT_NOT_FOUND`,
`CONTENT_QUARANTINED`, `CONTENT_LOCKED`, `CHECKSUM_MISMATCH`, `FILE_TOO_LARGE`,
`LEGAL_HOLD_ACTIVE`). See `server/services/content/constants.js`
(`CONTENT_ERROR_CODES`) for the full table with HTTP statuses.

## Meta, health and metrics

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/meta` | browser:read | Vocabulary, resource permission map, event types and health. |
| GET | `/health` | auth | Content health/readiness summary. |
| GET | `/metrics` | admin:read | Tenancy-scoped metrics snapshot. |
| GET | `/storage/summary` | admin:read | Storage footprint, per-provider breakdown, dedupe savings. |
| GET | `/facets` | browser:read | Status/security/role/MIME/processing facets. |

## Content

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/` | browser:read | Paged content list. Query: `q`, `status`, `securityStatus`, `contentRole`, `objectType`, `objectId`, `contentType`, `page`, `pageSize`, `sortBy`, `sortDir`. |
| POST | `/` | uploads:create | Direct single-shot upload. Body may be raw bytes (with `?name=` or `x-file-name`) or JSON `{ buffer | data(base64), fileName, objectType, objectId, contentRole, ... }`. |
| GET | `/:ref` | browser:read | Content detail: content, versions, processing status and recent events. |
| PATCH | `/:ref` | details:update | Update metadata/description/classification/role. |
| DELETE | `/:ref` | admin:execute | Soft-delete content. Blocked by retention/legal hold. |
| POST | `/:ref/restore` | admin:execute | Restore soft-deleted content. |
| GET | `/:ref/download` | details:read | Issue a signed, short-lived download URL and record the download. Query: `version`, `expiresIn`, `disposition`. |
| GET | `/:ref/events` | browser:read | Content event history. Query: `type`, `limit`. |
| GET | `/:ref/retention` | retention:read | Retention record and active legal hold for this content. |

## Upload sessions (resumable/multipart)

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/uploads` | uploads:read | List upload sessions. Query: `status`, `limit`. |
| POST | `/uploads` | uploads:create | Initiate a session. Body: `fileName`, `expectedSize`, `objectType`, `objectId`, `contentRole`, `chunkSize`, `idempotencyKey`, `securityClassification`. |
| GET | `/uploads/:uploadId` | uploads:read | Session detail including received parts. |
| PUT | `/uploads/:uploadId/parts/:partNumber` | uploads:create | Append a raw byte part (`application/octet-stream`). Idempotent per part number. |
| POST | `/uploads/:uploadId/complete` | uploads:create | Complete the session: verify checksum, move staged bytes, create content + version. |
| POST | `/uploads/:uploadId/abort` | uploads:create | Abort and remove staged bytes. |

## Versions

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/:ref/versions` | versions:read | List immutable versions. Query: `includeDeleted`, `limit`. |
| POST | `/:ref/versions` | versions:create | Restore an earlier version as a new current version. Body: `{ version }`. |
| GET | `/:ref/versions/:version/download` | details:read | Signed download URL for a specific version. |

## Renditions

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/:ref/renditions` | renditions:read | List renditions. Query: `status`, `type`. |
| POST | `/:ref/renditions` | renditions:create | Request a rendition. Body: `{ rendition_type | type, source_version_id, metadata }`. Unsupported types are recorded as `skipped`. |
| GET | `/:ref/renditions/:renditionRef/download` | renditions:read | Access URL for a ready rendition. |

## Processing

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/:ref/processing` | processing:read | Processing status for the current version. |
| POST | `/:ref/processing` | processing:execute | Requeue processing/renditions. Body: `{ rendition_types }`. |
| GET | `/processing-jobs` | processing:read | List processing jobs. Query: `contentId`, `status`, `limit`. |

## Security

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/:ref/security` | security:read | Latest scan plus scan history. Query: `limit`. |
| POST | `/:ref/quarantine` | security:update | Quarantine content. Body: `{ reason }`. |
| POST | `/:ref/release-quarantine` | security:update | Release quarantine after review. Body: `{ reason }`. |

## Lifecycle

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| POST | `/:ref/lifecycle` | admin:execute | Transition status. Body: `{ status, reason }`. Only declared transitions are accepted. |
| POST | `/:ref/archive` | admin:execute | Archive content. Body: `{ reason }`. |

## Locks (check-out / check-in)

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/locks` | locks:read | List locks. Query: `active`, `limit`. |
| GET | `/:ref/lock` | locks:read | Active lock for content. |
| POST | `/:ref/checkout` | locks:create | Acquire an exclusive check-out. Body: `{ reason, ttl_seconds }`. Returns `lock_token`. |
| POST | `/:ref/checkin` | locks:execute | Release the lock; supply edited bytes to create a new version. Body: `{ lock_token, comment, data(base64) }` or raw bytes. |
| POST | `/:ref/unlock` | locks:delete | Privileged force-release. Body: `{ reason }`. |

## Associations

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/associations` | associations:read | List associations. Query: `objectType`, `objectId`, `contentId`, `status`, `contentRole`, `page`, `pageSize`. |
| POST | `/associations` | associations:create | Create association. Body: `{ contentId, objectType, objectId, contentRole, isPrimary, sequence, effective_from, effective_to }`. |
| GET | `/associations/:ref` | associations:read | Association detail. |
| PATCH | `/associations/:ref` | associations:update | Update association. |
| DELETE | `/associations/:ref` | associations:delete | Remove association. |
| POST | `/associations/:ref/primary` | associations:update | Mark as the primary association for its object/role. |
| GET | `/objects/:objectType/:objectId/content` | associations:read | All content attached to an object. Query: `includeInactive`. |
| GET | `/:ref/associations` | associations:read | All associations for a content item. |

## Retention and legal hold

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/retention-policies` | retention:read | List policies. Query: `active`, `limit`. |
| POST | `/retention-policies` | retention:update | Create policy. Body: `{ policy_code, name, retention_days, retention_start_basis, disposition, applies_to_* }`. |
| GET | `/retention-policies/:ref` | retention:read | Policy detail. |
| PATCH | `/retention-policies/:ref` | retention:update | Update policy. |
| POST | `/:ref/legal-hold` | retention:execute | Apply legal hold. Body: `{ reason, case_ref }`. |
| POST | `/:ref/legal-hold/release` | retention:execute | Release legal hold. Body: `{ reason }`. |

## Signed download endpoint

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/download/:token` | auth | Streams bytes for a signed token issued by a `download` endpoint. The token is opaque, expiring and bound to the storage key. |

## Examples

Initiate, upload and complete a resumable upload:

```bash
# Initiate the session
curl -X POST https://host/api/content/uploads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fileName":"drawing.pdf","expectedSize":1048576,"objectType":"Part","objectId":"P-1001"}'

# Append a part
curl -X PUT https://host/api/content/uploads/UPL-XXXX/parts/1 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @part1.bin

# Complete the session
curl -X POST https://host/api/content/uploads/UPL-XXXX/complete \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"checksum":"<sha256>"}'
```

Attach content to any object and read it back:

```bash
# Associate
curl -X POST https://host/api/content/associations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"contentId":"<uuid>","objectType":"BOM","objectId":"BOM-2001","contentRole":"ATTACHMENT","isPrimary":true}'

# List content for the object
curl https://host/api/content/objects/BOM/BOM-2001/content \
  -H "Authorization: Bearer $TOKEN"
```
