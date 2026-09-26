# Audit & History Operations

Day-2 guide for running the Audit & History & Compliance Framework:
configuration, worker maintenance, retention and legal hold, asynchronous
exports, the action registry, monitoring and troubleshooting. Design and
internals are in `docs/AUDIT_DESIGN.md`.

## 1. Where to find it

| Page | Route | Audience |
| --- | --- | --- |
| Audit console | `/audit` | auditors, administrators |

The console tabs are Event stream, Overview, Metrics, Security, Workflow,
Lifecycle, Configuration, Object history, Exports, Retention, Action types and
Policies.

Permissions are grouped under the `iam.audit.*` resources: `events`, `history`,
`policies`, `export` and `retention`, each with `create`, `read`, `update`,
`delete` and (for retention) `execute` where applicable. Seeded administrator
roles receive the appropriate grants on first start.

## 2. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIT_MAINTENANCE_MS` | `120000` | Worker maintenance interval (expire exports, sweep retention) |
| `AUDIT_EXPORT_RETENTION_DAYS` | `7` | How long completed export artifacts stay downloadable |
| `AUDIT_NOTIFY_EVENTS` | unset | When `true`, mirror audit events into notifications |

Runtime behaviour is configuration-driven through policies, never code:

- **Capture policies** (`audit_policies`) decide whether an event is recorded,
  which attributes are tracked, masked or ignored, visibility, retention days
  and, with migration `019_audit_framework`, the `categories_json`,
  `export_allowed` and `system_mandatory` flags. System-mandatory policies
  cannot be disabled or deleted.
- **Retention policies** (`audit_retention_policies`) are separate and decide
  how long events live and whether they are archived or purged. Default policies
  are created by `ensureDefaultRetentionPolicies()` at seed time.
- **Action types** (`audit_action_types`) classify dotted action codes into a
  category and event type; system action types are seeded by
  `ensureSystemActionTypes()`.

## 3. Running the worker

Retention sweeps, export materialisation and webhook-free publishing run in the
job worker. Handlers are registered automatically:

```bash
# Start a worker (registers audit handlers + maintenance interval)
npm run worker
```

Without a worker, exports stay `queued` and scheduled retention does not run,
although the console can still execute retention synchronously on demand.

## 4. Retention and legal hold

Retention is executed per retention policy. Use the console (**Retention** tab)
or the API:

```bash
# Dry run: report what would be archived or purged
curl -s -X POST http://127.0.0.1:3001/api/audit/retention/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Execute for real
curl -s -X POST http://127.0.0.1:3001/api/audit/retention/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

Rules that always apply:

- Events with `retention_category = 'permanent'` are never archived or purged.
- Policies with `legal_hold = true` are skipped and recorded as `skipped`
  retention runs; lift the hold before the next sweep.
- `archive` moves events to `audit_logs_archive`; `purge` removes them. Both run
  inside the immutability-guarded transaction.
- Every execution writes `audit_retention_runs` and publishes
  `RetentionStarted` / `RetentionCompleted` on the audit bus.

## 5. Asynchronous exports

Exports are first-class, tracked resources rather than a streaming download:

1. Request an export with a format, filters, optional columns and a reason.
2. The `AUDIT_EXPORT` job materialises the file and records the row count.
3. Completed exports are downloaded through a token-authenticated endpoint;
   each download is audited and increments the download counter.
4. Artifacts expire after `AUDIT_EXPORT_RETENTION_DAYS` and are cleaned up by
   the worker.

```bash
# Request an export
curl -s -X POST http://127.0.0.1:3001/api/audit/exports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Q3 security review", "format": "csv", "filters": {"category": "security"}, "reason": "External audit"}'

# List exports and their status
curl -s "http://127.0.0.1:3001/api/audit/exports?limit=50" \
  -H "Authorization: Bearer $TOKEN"

# Download a completed export
curl -s -OJ "http://127.0.0.1:3001/api/audit/exports/42/download" \
  -H "Authorization: Bearer $TOKEN"
```

## 6. Action registry and saved filters

Register module-specific action codes so they classify correctly and, where
required, are treated as mandatory:

```bash
# Register a custom action type
curl -s -X POST http://127.0.0.1:3001/api/audit/action-types \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"code": "invoice.approve", "label": "Invoice approved", "category": "approval", "event_type": "APPROVED"}'
```

Saved filters are owner-scoped and reusable from the Event stream tab. Create
one from the console, or through `/api/audit/filters` with `scope: "events"`.

## 7. Monitoring

The **Metrics** tab (and `GET /api/audit/metrics`) is the operational view:

- Volume: total events, growth over the last 24h / 7d / 30d, oldest and newest.
- Security: sensitive events, failures/denials, login failures, access denials.
- Storage: live vs archived counts and retention-run count.
- Exports: total and completed export requests.

Category and actor-type breakdowns plus a 30-day by-day chart are included.
Router-level failures and denied access are captured automatically, so a spike
in `failure`/`denied` is visible without log digging.

## 8. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Events missing for a module | Capture policy suppresses them | Check `audit_policies`; mandatory categories bypass suppression |
| Export stays `queued` | No worker running | Start `npm run worker` |
| Export download `410`/expired | Past `AUDIT_EXPORT_RETENTION_DAYS` | Re-request the export |
| Retention archived nothing | Policy inactive, legal hold, or no events older than the window | Check the policy and the `audit_retention_runs` reason |
| `403` on a console tab | Missing `iam.audit.*` grant | Grant the matching resource/action |
| Category filter returns nothing | Action not registered / category mismatch | Register the action type or check `categoryOfAction` |

## 9. Routine maintenance

- Confirm at least one worker is healthy in every environment.
- Review the Metrics tab for volume growth and failure spikes.
- Review retention runs and legal holds before compliance windows close.
- Expire stale exports automatically; verify the download audit trail is intact.
- Keep `permanent` retention categories limited to records with a legal
  obligation; everything else should age out through policies.
