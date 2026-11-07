# Backup and recovery (SEC-20)

This document describes the implemented backup capability, its measured
limits, and the operator procedure for restoring the AI platform. It replaces
the previous prose-only guidance.

## 1. Scope and inventory

| Component | Authoritative? | Recovery decision | Mechanism |
| --- | --- | --- | --- |
| PostgreSQL `ai` schema | Yes | Back up and restore | Daily encrypted logical dump (`pg_dump --format=custom`) |
| SeaweedFS / S3 bucket (`ai-knowledge`) | Yes, for original documents | Back up and restore | Object bytes plus SHA-256 index, packed into `objects.tar.gz` |
| PostgreSQL `public` schema (enterprise) | Yes, but owned by the enterprise platform | Not copied by this tool by default | Enterprise platform runbook; use `BACKUP_DATABASE_SCOPE=database` only with the owning team's approval |
| OpenSearch indexes | No | Rebuild from PostgreSQL and object storage | Indexer/reconciliation; snapshot is not required at the current scale |
| Kafka topics | No (mirror) | Rebuild/allow replay; database outbox is authoritative | Database outbox (`ai.events` / `ai.event_deliveries`) |
| Redis | No | Recreate cold; never restore leases or cache | Cache/transient state only |
| MLflow store/artifacts | Optional service | Rebuild; not in the AI backup | Use a managed MLflow backend for production persistence |
| Langfuse/ClickHouse | Optional observability | Rebuild; not in the AI backup | Tracing can be lost without affecting correctness |

The backup tool writes only the configured PostgreSQL schema (`AI_DB_SCHEMA`,
default `ai`) and the configured S3 bucket. It does not include the enterprise
identity tables in `public`; authentication remains delegated to the enterprise
IAM and is therefore an external recovery dependency.

## 2. Recovery objectives

No business-approved RPO/RTO existed in the repository. The following are
proposed initial objectives, not a claim of compliance:

| Objective | Proposed value | Basis |
| --- | --- | --- |
| RPO (maximum data-loss window) | 24 hours | One scheduled backup per day. Reduce the interval or add WAL archiving for tighter RPO. |
| RTO (AI layer) | 4 hours | Restore database and objects, rebuild search, restart workers/API. |
| Backup schedule | Daily at 02:15 UTC | Kubernetes CronJob `ai-backup`; Compose is manual. |
| Retention | 14 days, minimum 3 verified artifacts | `BACKUP_RETENTION_DAYS`, `BACKUP_RETENTION_MIN_COUNT`. |
| Restore drill cadence | Every 90 days and before a major release | Alert `AIRestoreDrillStale`. |

Measured drill on 2026-10-25 (development dataset: 86 MB database, 8 objects):

- Artifact creation and verification: 8.4 seconds.
- Database restore and validation: 4.8 seconds.
- Full drill including API and four `--once` workers: 22.4 seconds.

These numbers do **not** establish the 4-hour production RTO. They only prove
the procedure works on the current development data volume.

## 3. What runs

The standalone tool is `scripts/backup_restore.py`. It needs `pg_dump`,
`pg_restore`, `psql`, and Python 3.11+. Object backups additionally need
`boto3`; encryption needs `gpg`. A dedicated image is defined in
`infrastructure/backup/Dockerfile` (`enterprise-ai-platform/ai-backup:0.1.0`).

Commands:

```bash
# Create, verify, record, and apply retention
python scripts/backup_restore.py backup

# Verify the latest artifact (or --artifact <run-id|path>)
python scripts/backup_restore.py verify

# Restore into a clean, explicit target
python scripts/backup_restore.py restore \
  --artifact <run-id> \
  --target-db ai_restore_drill_YYYYMMDD_HHMMSS \
  --confirm-target ai_restore_drill_YYYYMMDD_HHMMSS \
  --restore-objects \
  --target-bucket ai-knowledge-restore-drill-YYYYMMDDHHMMSS

# Full isolated drill, including API readiness and one cycle of each worker
python scripts/backup_restore.py drill --start-app --run-workers
```

The tool exits nonzero on any failure. A successful backup means: `pg_dump`
completed, the custom archive listed, object bytes hashed and packed, payloads
encrypted when configured, every checksum verified, the dump and object archive
opened successfully, and the artifact directory atomically moved into place.
Creating a file is not sufficient for success.

## 4. Artifacts and integrity

Artifacts live under `$BACKUP_DIR/artifacts/<run-id>/`:

```text
manifest.json
postgres.dump.gpg
objects.tar.gz.gpg
```

`manifest.json` records the run id, timestamps, schema, PostgreSQL server
version, installed extensions, migration history and checksums, table row and
tenant counts, document-object-key count/hash, object count/bytes/index hash,
encryption state, and SHA-256 for every payload. It never contains passwords,
passphrases, tenant ids, object keys, document content, or artifact paths.

The metadata queries and `pg_dump` use one exported repeatable-read snapshot,
so the manifest counts and dump describe the same database state even while the
application is serving writes. Because migration 0018 uses `FORCE ROW LEVEL
SECURITY`, the tool sets `PGOPTIONS=-c ai.system_access=on` for its PostgreSQL
sessions and runs `pg_dump --enable-row-security`; without both, the dump aborts
on the first protected table. The restore drill compares tenant counts and
cross-tenant references against the manifest. Object storage is scanned
separately, after the dump; the database and bucket are therefore not one
atomic cross-store snapshot. A document inserted between the two scans can have its row in the
database with its object uploaded shortly afterwards. This affects only the
maximum data-loss window, not artifact integrity; the restore check reports a
missing object instead of silently accepting it.

Verification checks file names for traversal, sizes, SHA-256 checksums, GPG
decryption, `pg_restore --list`, and safe extraction of the object tar. The
checks detect corruption and payload modification. They do not provide
signatures; protection against an attacker who can rewrite both payload and
manifest relies on storage access control and encryption-key custody.

Retention runs only after a new artifact is verified. It never removes the most
recent artifact, never drops below `BACKUP_RETENTION_MIN_COUNT`, and only
removes verified successful artifacts older than `BACKUP_RETENTION_DAYS`.
Interrupted runs leave no final artifact: assembly happens in
`$BACKUP_DIR/tmp/<run-id>` and the final directory is created with an atomic
rename.

Overlap protection uses a `flock`-based advisory lock at
`$BACKUP_DIR/.backup.lock`. The kernel releases the lock if the process dies, so
a killed run does not leave a permanent stale lock. Kubernetes also sets
`concurrencyPolicy: Forbid`.

## 5. Encryption, storage and access control

- Payloads are encrypted with GPG symmetric AES-256. The passphrase comes from
  `BACKUP_ENCRYPTION_PASSPHRASE` or `BACKUP_ENCRYPTION_PASSPHRASE_FILE`; it is
  passed over stdin, never argv, and is not logged.
- Production sets `BACKUP_REQUIRE_ENCRYPTION=true`. A missing key fails the
  backup. This is deliberate: an unencrypted artifact is not a valid production
  backup.
- Keep the passphrase in the organisation's secret manager and keep an offline
  recovery copy. Losing it makes every encrypted artifact unrecoverable. It is
  supplied to the backup Job through `ai-api-secrets` (key
  `BACKUP_ENCRYPTION_PASSPHRASE`).
- Kubernetes stores artifacts on the dedicated `ai-backup-data` PVC, mounted
  only by the CronJob. The Job uses the token-less `ai-backup` ServiceAccount,
  runs as uid 10001, drops all capabilities, has a read-only root filesystem,
  and can reach only PostgreSQL and S3 in the `data` namespace.
- The PVC is not off-site storage and is not immutable. It does not survive loss
  of the cluster or its storage backend. Production must bind it to a
  replicated/snapshot-capable StorageClass and replicate the encrypted
  artifacts off-cluster with the approved backup transport. No object lock,
  immutability, or cross-region copy is implemented here.
- Volume-level encryption is not guaranteed by this repository. Application
  encryption protects artifact contents regardless of the volume.
- Ordinary tenants and application users have no route to backup artifacts.
  There is no download API; access is through the operations identity that can
  read the PVC or backup destination.

## 6. Scheduling

### Kubernetes

`infrastructure/kubernetes/base/backup-cronjob.yaml` runs daily at 02:15 UTC.
The schedule is configurable by patching the CronJob. It uses
`concurrencyPolicy: Forbid`, a two-hour active deadline, bounded Job history,
and a dedicated PVC. The Job is not exposed through Ingress.

### Docker Compose

Compose does not schedule backups. The `backup` profile is a manual runner:

```bash
docker compose --profile backup run --rm backup backup
```

Use a host scheduler (systemd timer or the organisation's job scheduler) if a
development environment needs recurring backups. The profile itself is not a
scheduler and does not imply that backups run automatically.

## 7. Restore procedure

Restore never targets the configured source database. The target must be named
explicitly, must be different from `POSTGRES_DB`, and must be confirmed with
`--confirm-target`. The tool refuses `postgres`, `template0`, `template1`, and
non-empty AI schemas unless `--allow-nonempty` is explicitly supplied for a
controlled recovery.

Order:

1. Select and verify an artifact: `verify --artifact <run-id>`.
2. Ensure the decryption key is available from the secret manager.
3. Create a clean target database. The tool can do this with
   `--create-database`; the target must be owned by the restore role.
4. Ensure `vector`, `citext`, and `pg_trgm` are available. The tool attempts
   `CREATE EXTENSION IF NOT EXISTS` and fails with `extension_missing` if one is
   unavailable. `citext` and `pg_trgm` are trusted extensions and the restore
   role can create them. `vector` (pgvector) is **not** trusted on PostgreSQL 16:
   creating it requires a superuser. A least-privilege `ai_restore` therefore
   cannot create it, so on a brand-new target an operator (or an init container
   running as a superuser) must pre-create it once:

   ```bash
   psql -d <target_db> -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

   The documented `--create-database` path still needs this superuser step for
   `vector`; it is the only extension the restore role cannot create itself.
   For the automated restore-drill CronJob, the simplest operator setup is to
   install `vector` once in `template1` so every newly created drill database
   inherits it:

   ```bash
   psql -d template1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

   Without one of these two steps the drill fails with `extension_missing` on a
   fresh cluster even though the dump and the restore role are correct.
5. Restore the dump with `pg_restore --exit-on-error --no-owner
   --no-privileges --single-transaction`.
6. Compare migration history, critical row counts, tenant counts, and
   document-object-key counts with the manifest.
7. Restore objects into a different bucket. The tool creates the bucket if
   needed, uploads every blob, checks object sizes, and verifies that every
   document row's object key exists.
8. Start the API against the target and check `/readyz` and `/healthz`.
9. Run each worker once (`event_consumer`, `indexer`, `reconciler`, `agent`) to
   prove it can start and reach the restored database.
10. Record the drill report and elapsed time. Do not run migrations
    automatically on a restored production database.

Migration policy: the backup includes `ai.schema_migrations` and the schema it
describes. After restore, compare `ai.schema_migrations` with the application's
expected version. If the restored version is behind, apply migrations only as
an explicit, documented recovery decision with the pre-recovery artifact still
preserved. If it is ahead, deploy the matching application version rather than
rolling the schema backwards.

Restore order for a full environment:

1. PostgreSQL.
2. Object storage.
3. Verify document rows point at restored object keys.
4. Rebuild OpenSearch indexes if `SEARCH_PROVIDER=opensearch` (the platform
   default is PostgreSQL search).
5. Resume the database outbox consumers and workers.
6. Start the API and console.
7. Redis may be started empty; do not copy leases.

## 8. Event, queue and search recovery

- **Database outbox**: `ai.events` and `ai.event_deliveries` are in the dump.
  Delivered rows suppress redelivery; pending rows resume. Idempotency is
  enforced by `UNIQUE (event_id, consumer_group)` and the event replay path.
  Restoring a database older than the event mirror can re-emit events that were
  already processed elsewhere; consumers re-read authoritative rows and must
  remain idempotent. Do not restore Kafka state over a newer database.
- **Kafka**: not backed up. It mirrors the database outbox. Recreate topics and
  let reconciliation/consumers catch up. Replaying old events is safe only
  because consumers re-read authoritative state and use idempotent keys; this
  property is covered by existing event tests.
- **Redis**: cache only. Do not restore old keys, leases, or locks. A cold
  restart is the recovery strategy.
- **OpenSearch**: reconstructible. The deployed base config uses
  `SEARCH_PROVIDER=postgres`, so a restore does not require an index snapshot.
  If OpenSearch is enabled, enqueue reindexing for the affected tenants and
  wait for jobs to finish before exposing search. Deleted/unauthorized content
  must not be re-indexed from stale snapshots; rebuilding from the restored
  authoritative rows is the safer path.

## 9. Recovery validation checklist

- [ ] Artifact checksum and decryption verified.
- [ ] Restored database reachable and owned by the application role.
- [ ] `ai.schema_migrations` matches the manifest.
- [ ] Critical tables and tenant counts match.
- [ ] No cross-tenant document/chunk/embedding references.
- [ ] Document object keys exist in the restored bucket.
- [ ] Vector search returns results (or the backup has no embeddings).
- [ ] Event delivery uniqueness constraint exists; no duplicate delivery rows.
- [ ] API `/readyz` and `/healthz` pass against the target.
- [ ] Event consumer, indexer, reconciler, and agent start.
- [ ] No credentials, tenant ids, object keys, or document content appear in the
      report.
- [ ] Scratch database and bucket cleanup is scheduled or performed by an
      authorised operator.

## 10. Restore-drill report

Every drill writes
`$BACKUP_DIR/restore-drills/drill-<timestamp>.json` and a row in
`ai.backup_runs` with `kind='restore_drill'`. Required fields:

```json
{
  "drill_version": 1,
  "drill_id": "20261025T080325Z-82f76b",
  "drill_timestamp": "2026-10-25T07:28:00Z",
  "backup": {"run_id": "...", "created_at": "...", "checksum": "...", "encrypted": true},
  "target": {"database": "ai_restore_drill_...", "bucket": "ai-knowledge-restore-drill-..."},
  "components": [],
  "checks": [],
  "result": "success",
  "elapsed_seconds": 22.446,
  "data_loss": {"expected_window": "up to 14d retention; RPO target <= 24h", "observed": "none beyond the backup point"},
  "deviations": [],
  "follow_up_actions": [],
  "cleanup": {"status": "deferred"}
}
```

The 2026-10-25 drill report is preserved at
`docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json`. It records a real
restore into `ai_restore_drill_20261025_080325`, a real object restore into
`ai-knowledge-restore-drill-20261025080325`, API readiness, all four workers,
tenant checks, vector search, and document-object links.

## 11. Observability and alerts

The API's `/metrics` endpoint refreshes these low-cardinality gauges from
`ai.backup_runs`:

- `ai_backup_last_run_status{kind="backup|restore_drill"}` (1 success, 0 failure)
- `ai_backup_last_success_timestamp_seconds{kind}`
- `ai_backup_last_duration_seconds{kind}`
- `ai_backup_last_artifact_size_bytes{kind}`
- `ai_backup_last_integrity_ok{kind}`
- `ai_backup_last_encrypted{kind}`

Labels are only `kind`; no tenant, artifact path, database, document id, or
credential is a label. `/metrics` retains the existing bearer-token protection.

`infrastructure/monitoring/prometheus/backup-alerts.yml` defines alerts for
failed backups, stale backups (36 hours), integrity failure, unencrypted
successful backups, and stale restore drills (90 days). The Compose Prometheus
service loads the file; `promtool check rules` reports 5 rules, and the
Kubernetes stack in `infrastructure/kubernetes/monitoring/` loads the same file
via the `ai-prometheus-rules` ConfigMap. **Alert delivery is still OPEN**: the
shipped `alertmanager.yml` receiver has no integration, so alerts reach
Alertmanager but no human is notified until an operator adds a real receiver and
captures a receipt.

Two cluster facts to keep in mind:

- The monitoring stack is opt-in, not part of `overlays/production`. It has its
  own namespace, PVC and credentials. `scripts/k8s-monitoring-config.sh` builds
  its ConfigMaps from the canonical files and copies `AI_METRICS_AUTH_TOKEN`
  into an `ai-metrics-token` Secret. Applying the production overlay alone does
  not deploy it.
- The drill is now scheduled. `ai-restore-drill` runs monthly (06:00 UTC, day 1)
  with the `ai_restore` credential from the separate `ai-restore-secret`, and
  records a `restore_drill` row that feeds `AIRestoreDrillStale`. It does not
  clean up after itself; an operator runs `cleanup --execute` after review. The
  job skips `--start-app`/`--run-workers` because the backup image has no
  application package.

See `docs/kubernetes-rollout.md` Sections 7.1, 7.2 and 8 for the executable steps.

Failed backups:
- If the tool can reach PostgreSQL, it writes a failed row (`error_code`,
  bounded `details`) and exits nonzero.
- If PostgreSQL is unreachable, the backup cannot be created and no row can be
  written; the CronJob failure and the stale metric/alerts are the signals.
- A failed run never replaces the last verified artifact. Temporary files are
  removed; the previous artifact remains.

## 12. Troubleshooting

| Symptom | Check |
| --- | --- |
| `backup_locked` | Another run is active. Inspect CronJob pods and the lock timestamp; do not delete artifacts. |
| `encryption_required` | Set the passphrase in the secret manager and restart the Job. Do not disable encryption in production to work around it. |
| `missing_tool` | The backup image is missing `pg_dump`/`pg_restore`/`psql`/`gpg`; rebuild the pinned image. |
| `object_backup_failed` | Check S3 endpoint, credentials, bucket policy, and NetworkPolicy egress. |
| `artifact_corrupt` / `artifact_incomplete` | Do not use the artifact. Restore the previous verified run; preserve the bad artifact for investigation. |
| `target_confirmation_required` | Pass the exact target database name to `--confirm-target`. |
| `target_not_empty` | Choose a clean database. Do not force overwrite production. |
| `extension_missing` | The restore role cannot create trusted extensions or the server lacks the extension; fix the cluster image/role before retrying. `vector` specifically needs a superuser: pre-create it in the target database or in `template1` (see section 7). |
| `/metrics` has no `ai_backup_*` series | The API cannot read `ai.backup_runs`, or no run has completed. Check `/readyz` and migration 0017. |

## 13. Known limitations

- The restore drill used a separate database on the same PostgreSQL server, not
  a separate physical instance or cluster.
- Enterprise IAM authentication was not exercised; it is external to the AI
  schema. Tenant boundaries were checked directly against restored rows.
- No live Kubernetes cluster was available. CronJob, PVC, NetworkPolicy, and
  kustomize output were validated statically, not applied.
- The dedicated backup image was not built in this environment; its build file
  is included and pinned but image publication remains an operational step.
- No off-site replication, object lock, or immutable retention is implemented.
  The PVC is a single local recovery point.
- No Alertmanager destination exists, so alert delivery is not verified. The
  in-cluster Alertmanager has an inert receiver by design.
- The drill scratch database and bucket were left in place because destructive
  cleanup requires an authorised operator. Use the `cleanup` subcommand with
  explicit confirmations when approved; it refuses non-drill names.

## 14. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DIR` | `/backup` | Root for artifacts, temporary files, drill reports, and the lock. |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | localhost / 5432 / helix / helix / empty | Source database. The password is also read from `PGPASSWORD`. Provisioned deployments use `ai_backup` here. |
| `AI_DB_ROLE_PROFILE` | empty | Set to `backup` to verify the source role before dumping; rejects owner, superuser, `BYPASSRLS`, `CREATEDB`, and non-member roles. |
| `AI_DB_EXPECTED_ROLE` | empty | Exact source role name, normally `ai_backup`. |
| `RESTORE_TARGET_USER` / `RESTORE_TARGET_PASSWORD` | empty | Isolated restore/drill login, normally `ai_restore`; the password must be supplied separately (no fallback to the source password when the user differs). |
| `RESTORE_TARGET_ROLE_PROFILE` / `RESTORE_TARGET_EXPECTED_ROLE` | empty | Set to `restore` / `ai_restore` to verify the target role, including `CREATEDB` when creating a database. |
| `POSTGRES_SSLMODE` | `prefer` | PostgreSQL TLS mode. Use `require` or stronger in production. |
| `AI_DB_SCHEMA` | `ai` | Schema included in the logical dump. Must be a safe identifier. |
| `BACKUP_DATABASE_SCOPE` | `schema` | `schema` (AI only) or `database` (whole database, coordinated with the enterprise owner). |
| `S3_ENDPOINT` | `http://127.0.0.1:8333` | S3-compatible endpoint. |
| `S3_REGION` | `us-east-1` | Signing region. |
| `S3_BUCKET` | `ai-knowledge` | Source bucket. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | empty | Empty uses unsigned access (development SeaweedFS only). |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing for SeaweedFS/MinIO. |
| `BACKUP_OBJECTS` | `true` | Include object bytes. |
| `BACKUP_OBJECT_PREFIX` | empty | Restrict the object backup to one prefix; empty means the whole bucket. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | empty | GPG passphrase. Prefer the file variant in production. |
| `BACKUP_ENCRYPTION_PASSPHRASE_FILE` | empty | File containing the passphrase; overrides the inline variable. |
| `BACKUP_REQUIRE_ENCRYPTION` | `false` | Production must set `true`. |
| `BACKUP_RETENTION_DAYS` | `14` | Age threshold for retention. |
| `BACKUP_RETENTION_MIN_COUNT` | `3` | Never retain fewer than this many verified artifacts. |
| `PG_DUMP_BIN` / `PG_RESTORE_BIN` / `PSQL_BIN` / `GPG_BIN` | tool names | Override client binary paths. |

The production Deployment/ConfigMap sets `BACKUP_DIR=/backup`,
`BACKUP_REQUIRE_ENCRYPTION=true`, `BACKUP_RETENTION_DAYS=14`,
`BACKUP_RETENTION_MIN_COUNT=3`, and object storage enabled. The passphrase is a
Secret value, never a ConfigMap value.

## 15. Validation evidence

- Unit/integration tests: `apps/ai-api/tests/test_backup_restore.py`, including
  live PostgreSQL/object-storage coverage gated by `AI_TEST_BACKUP=1`.
- Real encrypted backup, verification, and isolated restore drill on
  2026-10-25: `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json`.
  This drill predates the split-role provisioning; it validates the RLS
  `PGOPTIONS`/row-security path, not yet the `ai_backup`/`ai_restore` roles.
- Split-role verification: `scripts/verify-db-roles.sh` (requires
  `AI_TEST_ROLE_DB=1` and the five `AI_ROLE_*_DSN` values). Pending operator run.
- Kubernetes manifests: `python scripts/validate-k8s.py` (static validation).
- Compose: `docker compose config -q`.
- Lint: `ruff check scripts/backup_restore.py apps/ai-api/tests/test_backup_restore.py apps/ai-api/src/ai_api/telemetry/backup_metrics.py`.

The 2026-10-25 drill is development-scale evidence. It does not prove
production RTO, off-site recoverability, or that a live Kubernetes CronJob
runs; those remain operational prerequisites listed in section 13.
