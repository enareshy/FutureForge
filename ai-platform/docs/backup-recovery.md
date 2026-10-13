# Backup and recovery

## What to back up

| Tier | Data | Why it matters | Loss impact |
| --- | --- | --- | --- |
| PostgreSQL (shared `helix` DB, `ai` schema) | AI metadata, vectors, configuration, audit mirror, event log (when `EVENT_BUS_PROVIDER=database`) | Authorization/source of truth for retrieval and every AI record | Critical — unrecoverable without a backup |
| Object storage (S3-compatible) | Uploaded source documents | Required to re-ingest/re-embed knowledge | High — documents can be re-uploaded by users, but history is lost |
| Kafka (optional) | `ai.platform.events` topics | Cross-service event propagation when Kafka is enabled | Medium — the DB outbox retains pending events; Kafka can be rebuilt |
| Redis | Cache only | Never authoritative | None |
| Secrets | `ai-api-secrets` | Credentials | Restore from the secret manager |

The enterprise platform's own PostgreSQL objects are backed up by the existing
platform runbook; the AI layer adds the `ai` schema and its objects.

## Schedule (recommendation)

- **PostgreSQL**: WAL archiving (continuous, enables point-in-time recovery)
  plus a nightly base backup. Retention per the customer's compliance policy.
- **Object storage**: daily incremental + weekly full, versioning enabled.
- **Kafka**: not required for correctness; rely on the database outbox.

## Backup commands

PostgreSQL base backup and dump:

```bash
# Logical dump of just the AI schema (portable, safe for small/medium data).
pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --schema="$AI_DB_SCHEMA" --format=custom --file="ai-schema-$(date +%F).dump"

# Physical base backup (larger; pair with WAL archiving for PITR).
pg_basebackup -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -D /backup/base -Ft -z -P
```

Object storage (rclone example against the S3-compatible endpoint):

```bash
rclone sync :s3:ai-knowledge /backup/objectstore/ai-knowledge
```

## Restore

PostgreSQL:

```bash
# Into a clean database/schema.
pg_restore -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --schema="$AI_DB_SCHEMA" --clean --if-exists ai-schema-YYYY-MM-DD.dump

# For point-in-time recovery, restore the base backup and replay WAL to the
# target timestamp, then start PostgreSQL.
```

Object storage:

```bash
rclone sync /backup/objectstore/ai-knowledge :s3:ai-knowledge
```

After restoring PostgreSQL, re-run the migration Job to confirm the schema is
current (it is idempotent and skips already-applied versions).

## Verify a restore

1. `GET /readyz` returns 200.
2. A knowledge/RAG query returns the expected citation for a known document.
3. An audit record for a recent request is present.
4. Vector counts match: `SELECT count(*) FROM ai.document_chunks;` matches the
   pre-restore value.

## Recovery scenarios

- **Bad image release (no schema change)** — roll back the Deployment
  (`kubectl rollout undo`); no data action needed.
- **Bad release with a schema migration** — roll back the image and, if the
  migration is not backward compatible, restore from the pre-release base
  backup and replay to the cut-over point.
- **Accidental data deletion** — point-in-time recovery to just before the
  event, then restore object storage if documents were also removed.
- **Region loss** — restore PostgreSQL and object-storage backups into the
  recovery region, redeploy from `overlays/production` with updated endpoints,
  and verify with the checklist above.

Never run destructive recovery (clean restore) against production without an
operator holding the pre-recovery backup and a maintenance window.
