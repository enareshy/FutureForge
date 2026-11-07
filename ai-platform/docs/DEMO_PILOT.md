# Customer Demonstration and Controlled Pilot

This document describes the isolated environment, the single connected business
scenario, and the operating rules for the Step 12 customer demonstration and
controlled pilot. It is written so a second engineer can reproduce the demo from
scratch on a clean host without touching any live or shared system.

> All data in the demo is synthetic and clearly labeled
> `SYNTHETIC DEMO DATA - not a real customer record`. No demo, mock, or synthetic
> value is production data. No production system is contacted at any point.

## 1. What the demo shows

One continuous story, driven through the real product APIs and UI, not a slide
deck:

1. A customer-facing product and its engineering BOM (`EBOM`) exist with a
   released revision.
2. Manufacturing produces from a different `MBOM` that substitutes a component
   (the seal is replaced with the newer `seal-v2` part).
3. The manufacturing process (`DEMO-PROC-PUMP-ASSY`) has operations, a work
   centre, a plant/line, and work instructions.
4. A cluster of quality issues on the pump bearing is open, including a
   repeating `crack` failure across two issues and a critical issue.
5. An engineering change (`ECR-2026-007`, "Switch pump seal to Viton material")
   is linked to the product in the knowledge graph and exposes affected entities.
6. Predictive intelligence turns the open/repeating quality signal into a
   **critical defect-risk** prediction (score 83, rule-based) and generates a
   recommendation.
7. The governed agent (`demo-change-coordinator`) runs on the worker: it
   searches knowledge and looks up the predictive risk, then records the result.
8. A second, controlled agent (`demo-governed-draft`) demonstrates the human
   approval gate: the execution pauses at `waiting_approval`, a reviewer
   approves, and the run resumes to completion with a platform-owned draft
   artifact.
9. Every step above is visible in the audit log.

The console (repo root `web/`) already renders these flows on the real APIs;
the demo does not introduce a parallel frontend.

## 2. Isolated environment

The demo never runs against the shared/live database. It uses a dedicated
PostgreSQL database built by `scripts/setup_demo_db.sh`, seeded by
`scripts/seed_demo.py`, and served by an API container pointed at that database.

### 2.1 Prerequisites

- PostgreSQL 16 with `pgvector`, `citext`, and `pg_trgm` (the repo's `rc2-pg`
  container on port `55432` satisfies this).
- Docker (to run the AI API and the agent worker).
- Python 3.11 for the seed and walkthrough scripts.

### 2.2 Build the demo database

`setup_demo_db.sh` applies the same fresh-install order as production
(`0001..0018` -> provision least-privilege roles -> `0019..0026` -> re-grant).
It refuses to run as a non-superuser, refuses to use a shared database name, and
refuses to drop or overwrite an already-migrated database.

```bash
# Choose a fresh name every time you want a clean environment.
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=test \
  DEMO_DB=step12_demo \
  bash scripts/setup_demo_db.sh
```

Migrations run from a throwaway copy under `/tmp` that contains no `.env`, so
the live connection settings are never inherited.

### 2.3 Start the demo API

The API container only exposes a loopback port. It uses the least-privilege
`ai_api` role and the mock LLM/search providers.

```bash
docker run -d --name step12-api \
  -e AI_ENV=development -e AI_REPOSITORY=postgres -e AI_DB_SCHEMA=ai \
  -e AI_DB_ROLE_PROFILE=api -e AI_DB_EXPECTED_ROLE=ai_api \
  -e AI_RLS_VERIFY=true -e POSTGRES_HOST=host.docker.internal \
  -e POSTGRES_PORT=55432 -e POSTGRES_DB=step12_demo \
  -e POSTGRES_USER=ai_api -e POSTGRES_PASSWORD=api-test \
  -e LLM_PROVIDER=mock -e SEARCH_PROVIDER=postgres \
  -e AI_RATE_LIMIT_PER_MINUTE=600 \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:18021:8000 <ai-api-image>
```

### 2.4 Seed synthetic data

`seed_demo.py` talks only to the public HTTP API, is idempotent, and retries on
`429`/`5xx`.

```bash
AI_DEMO_API_BASE=http://127.0.0.1:18021/api/v1/ai \
AI_DEMO_TOKEN=demo-token \
  python3 scripts/seed_demo.py
```

It prints a summary of the created object ids (product, BOMs, quality issue,
change, prediction, recommendation, agent).

### 2.5 Run the connected scenario

`demo_scenario.py` walks the scenario end to end and prints a pass/fail
transcript (25 checks). It reuses seeded objects and only queues a short-lived
demo execution.

```bash
AI_DEMO_API_BASE=http://127.0.0.1:18021/api/v1/ai \
AI_DEMO_TOKEN=demo-token \
  python3 scripts/demo_scenario.py
```

Expected tail: `25/25 scenario checks passed`.

### 2.6 Point the console at the demo API

The console proxies `/api/v1/ai` to the AI service. The proxy target is
configurable so a demo instance can point at the isolated API without changing
the default for normal development:

```bash
# In the repo root. Defaults to http://127.0.0.1:8000 when unset.
AI_API_PROXY_TARGET=http://127.0.0.1:18021 npm run dev
```

Log in to the console as usual; the AI pages then read the demo tenant.

## 3. Agent execution and the human approval gate

Workflow agents are executed by the leased worker, not by the API process. The
worker must be given the least-privilege worker role:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e AI_ENV=development -e AI_REPOSITORY=postgres -e AI_DB_SCHEMA=ai \
  -e AI_DB_ROLE_PROFILE=worker -e AI_DB_EXPECTED_ROLE=ai_worker \
  -e POSTGRES_HOST=host.docker.internal -e POSTGRES_PORT=55432 \
  -e POSTGRES_DB=step12_demo -e POSTGRES_USER=ai_worker \
  -e POSTGRES_PASSWORD=worker-test \
  -e LLM_PROVIDER=mock -e SEARCH_PROVIDER=postgres \
  --entrypoint python <ai-api-image> -m ai_api.workers.agent --once
```

The approval lifecycle is:

1. An execution whose step uses a tool with `requires_approval: true` pauses at
   `waiting_approval`.
2. `GET /agent-approvals?status=pending` lists the pending item with its
   `operation_hash`.
3. `POST /agent-approvals/{id}/approve` (a reviewer; the requester cannot
   self-approve unless a platform superuser) moves the execution back to
   `queued`.
4. The next worker run resumes and completes it.

## 4. Success criteria

The demo is considered successful when:

- `demo_scenario.py` reports `25/25 scenario checks passed`.
- The agent execution shows both tool steps (`knowledge.search`,
  `predictive.risk_lookup`) `completed`, and a risk result of
  `critical` (score >= 80).
- The governed execution transitions `waiting_approval` -> `completed` after a
  reviewer approval, producing one `draft` artifact.
- The audit log contains the create/run/approval actions for the scenario.
- The console AI pages load and read the demo tenant through the proxy.

## 5. Controlling a pilot

For a controlled pilot with real (authorized) users:

- Keep the isolated database and least-privilege roles; do not reuse demo
  credentials (they are intentionally weak and documented).
- Replace the mock providers with the pilot's approved provider endpoints and
  keys supplied by the operator; never read provider keys from the agent
  environment into project files.
- Replace the development identity provider with the enterprise identity bridge
  so approvals have distinct real reviewers.
- Treat predictions and recommendations as decision support only; they are
  indicators, not confirmed facts, and the UI and API say so.

## 6. Known limitations and open blockers

- **WP-1 (open):** the shared development API process listens on `0.0.0.0:8000`
  and exposes `/metrics`, `/docs`, and `/openapi.json` off-loopback. This
  requires an operator restart and is out of scope for the demo (prohibited to
  change a running service). The demo API is bound to loopback only.
- **WP-2 (blocked):** SEC-19 role separation is not provisioned on the shared
  development database and migration `0019` is unapplied there. The demo proves
  the separated-role path on the isolated database.
- Predictions are rule-based in the demo (mock provider) and are not a
  substitute for engineering judgment.
- The demo currency is synthetic; it does not validate data quality of a real
  customer's source systems.

## 7. Cleanup

Demo resources are disposable. Stop (do not delete shared data) the demo
containers when finished, and leave the isolated database in place for reuse or
drop it only with the operator's explicit approval. Never remove the shared
`rc2-pg` container or the live database.

```bash
docker stop step12-api
```
