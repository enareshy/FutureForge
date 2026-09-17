# Document & File Management Operations

Day-2 guide for running the Document & File Management module: configuration,
storage, uploads, scanning/previews, locking, access control, maintenance and
troubleshooting. Design and internals are in
`docs/FILE_MANAGEMENT_DESIGN.md`.

## 1. Where to find it

| Page | Route | Audience |
| --- | --- | --- |
| File browser | `/files` | all users |
| File details | `/files/:ref` | all users |
| File administration | `/files/admin` | administrators |

## 2. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILE_STORAGE_PROVIDER` | `local` | Storage backend (`local` or `memory`) |
| `FILE_STORAGE_DIR` | `<repo>/data/files` | Root directory for the local provider |
| `FILE_STORAGE_BUCKET` | `helix-files` | Logical bucket name |
| `FILE_CHUNK_SIZE` | `5242880` (5 MB) | Multipart chunk size |
| `FILE_MAX_SIZE_BYTES` | `5368709120` (5 GB) | Maximum declared file size |
| `FILE_SIGNED_URL_TTL` | `900` | Signed download token lifetime (seconds) |
| `FILE_SIGNING_SECRET` | random per process | HMAC secret for download tokens |
| `FILE_UPLOAD_TTL_HOURS` | `24` | Upload session lifetime |
| `FILE_HTTP_UPLOAD_LIMIT` | `64mb` | Express body limit for HTTP uploads |
| `FILE_MAINTENANCE_MS` | `60000` | Worker housekeeping interval |

Set `FILE_SIGNING_SECRET` in every environment. Without it each process
generates a new secret, so signed links issued before a restart (or by another
worker) stop validating.

```bash
export FILE_SIGNING_SECRET="$(openssl rand -hex 32)"
export FILE_STORAGE_DIR=/var/lib/helix/files
```

## 3. Running the worker

File processing and periodic maintenance run in the job worker. Registering the
file handlers is automatic; run at least one worker per environment:

```bash
# Start a worker (also runs upload/lock expiry sweeps)
npm run worker
```

The worker performs file housekeeping on the `FILE_MAINTENANCE_MS` interval:

- expires abandoned upload sessions and deletes their staging objects;
- releases expired check-out locks.

To run the sweeps manually (for example from an operator console) call the
execution maintenance endpoint:

```bash
curl -s -X POST http://localhost:3001/api/job-execution/maintenance \
  -H "Authorization: Bearer $TOKEN"
```

## 4. Uploading files

In the console, open **Documents → File browser**, choose **Upload files**, pick
one or more files, choose a classification and (optionally) a description, then
upload. Files land in the currently selected folder or the folder root.

Programmatic single-shot upload:

```bash
TOKEN=...   # bearer token from /api/auth/login

curl -s -X POST "http://localhost:3001/api/files/upload?name=report.pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf
```

Large files use the resumable session API: initiate, PUT each chunk, complete.

```bash
# Initiate (returns upload_id, chunk_size, total_chunks)
curl -s -X POST http://localhost:3001/api/files/uploads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"big.bin","size":10485760,"mime_type":"application/octet-stream"}'

# Upload chunk 0, then complete
curl -s -X PUT "http://localhost:3001/api/files/uploads/<upload_id>/chunks/0" \
  -H "Authorization: Bearer $TOKEN" --data-binary @chunk0
curl -s -X POST "http://localhost:3001/api/files/uploads/<upload_id>/complete" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

Uploading against an existing file (pass `file_id`) creates a new immutable
version. You can also upload a revision from the file detail page's **Versions**
tab.

## 5. Downloads

Downloads use short-lived signed tokens. Request a descriptor and then fetch the
signed URL:

```bash
curl -s "http://localhost:3001/api/files/<ref>/download" \
  -H "Authorization: Bearer $TOKEN"
# { "download_url": "/api/files/download/<token>", ... }

curl -s "http://localhost:3001/api/files/download/<token>" \
  -H "Authorization: Bearer $TOKEN" -o download.bin
```

Tokens expire after `FILE_SIGNED_URL_TTL` seconds. If links are rejected across
restarts, confirm `FILE_SIGNING_SECRET` is set consistently.

## 6. Scanning, previews and processing

On completion every version enters the processing pipeline. Status is visible on
the file detail page (**Processing** tab) and in
`/api/files/metrics/processing`:

- `pending` / `in_progress` — work queued or running;
- `failed` — the processing attempt failed;
- `quarantined` — a scan found the content unsafe;
- `blocked` — uploads still awaiting a scan decision.

Files are only downloadable when their status is `available`, `checked_out` or
`processing`. Requeue a failed scan from the detail page or with:

```bash
curl -s -X POST "http://localhost:3001/api/files/<ref>/processing/requeue" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"virus_scan"}'
```

## 7. Check-out and locking

Exclusive locks prevent concurrent edits:

- **Check out** from the file detail page to acquire a lock.
- **Check in** (optionally with a comment) to release it.
- Administrators can **force release** a lock from `/files/admin` or the detail
  page. Force releases are audited.
- Locks can carry an expiry; the worker releases expired locks automatically.

## 8. Access control

Base permissions come from IAM resource grants:

`iam.files.browser`, `iam.files.details`, `iam.files.uploads`,
`iam.files.versions`, `iam.files.locks`, `iam.files.associations`,
`iam.files.folders`, `iam.files.permissions`.

Explicit per-file or per-folder ACLs layer on top:

- explicit **deny** always wins;
- explicit **allow** grants access even without a broad IAM grant;
- the file owner is always allowed;
- otherwise the IAM decision applies.

Manage ACLs from the file detail **Access control** tab or the **Permissions**
tab of `/files/admin`. Granting to `tenant` with a null principal id applies to
the whole tenant.

## 9. Monitoring

`/files/admin` (and the matching endpoints) provide:

- totals: files, bytes, versions, folders, collections, associations, active
  locks, deleted files;
- breakdowns by status, category, classification and extension;
- processing pending/failed/quarantined/blocked counters;
- upload session progress and history;
- file event stream.

```bash
curl -s "http://localhost:3001/api/files/metrics" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/files/metrics/storage" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/files/metrics/processing" -H "Authorization: Bearer $TOKEN"
```

## 10. Troubleshooting

- **Upload rejected as too large** — raise `FILE_MAX_SIZE_BYTES` and, for HTTP
  uploads through Express, `FILE_HTTP_UPLOAD_LIMIT`.
- **Checksum mismatch on complete** — the client-declared checksum disagrees
  with storage; re-upload or omit the declared checksum.
- **Upload session expired** — sessions lapse after `FILE_UPLOAD_TTL_HOURS`;
  start a new session. The worker removes expired staging data.
- **Signed download links stop working after restart** — set
  `FILE_SIGNING_SECRET` so tokens survive restarts.
- **File stuck in `pending_scan`** — ensure a worker is running and that the
  file job handlers are registered (`/api/job-execution/handlers` lists
  `files.virusScan` and `files.previewGeneration`).
- **`EADDRINUSE` when starting** — another process holds the port; stop it or
  change `PORT` and the Vite proxy target.

## 11. Tests

```bash
# Service-level tests (fast, in-memory storage)
FILE_STORAGE_PROVIDER=memory node --test server/tests/files.test.js

# REST API tests
FILE_STORAGE_PROVIDER=memory node --test server/tests/files-api.test.js

# Whole suite
npm test
```
