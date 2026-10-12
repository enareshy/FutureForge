# Phase 2 - Application Skeleton (ai-api + web-ai)

Status: complete. This phase establishes the runnable, testable skeletons of the two
AI applications and the working seam between them. No AI features are implemented yet;
the goal is a verified foundation the later phases build on.

## Scope delivered

### `apps/ai-api` (Python 3.11 / FastAPI)

- Layered architecture: `api -> application -> domain`, with `infrastructure`,
  `security`, and `telemetry` as supporting layers. Dependencies point inward.
- Settings via `pydantic-settings` (`config/settings.py`), env-driven with the
  `AI_API_` prefix.
- Structured logging (`structlog`) plus a request-context middleware that assigns or
  echoes `x-request-id`.
- Uniform error envelope + handlers for domain errors, validation errors, and Starlette
  HTTP errors (`api/errors.py`).
- Health endpoints: `/healthz` (liveness) and `/api/v1/ai/health` (readiness detail).
- OpenAPI served at `/docs` and `/openapi.json`.

### `apps/web-ai` (React 19 + TypeScript + Vite 8)

- Typed API client with `ApiError` mapped from the backend envelope.
- Dashboard page with explicit `loading` / `ready` / `error` states.
- Vite dev server reverse proxy: `/api` -> `http://127.0.0.1:8000`, so a single public
  port serves both UI and API (no CORS, matches the deployment topology).
- `allowedHosts` includes `.monkeycode-ai.live` for the preview environment.
- Tooling: Vitest + Testing Library (jsdom), ESLint 10 flat config, Prettier.

### `packages/`

Placeholder directories for `shared-types`, `api-contracts`, and `frontend-components`.
See `packages/README.md`; they are intentionally empty until contracts stabilize.

## Verification evidence

### ai-api

```
ruff check src tests        -> All checks passed
python3 -m pytest           -> 7 passed
```

Endpoints verified against a live uvicorn process:

- `GET /healthz` -> `200`
- `GET /api/v1/ai/health` -> `200` with `{"status":"ok","service":"ai-api",...}` and an
  `x-request-id` response header
- unknown route -> `404` with `{"error":{"code":"not_found",...}}`
- wrong method -> `405` with `{"error":{"code":"method_not_allowed",...}}`

### web-ai

```
npx vitest run              -> 2 passed
npx tsc --noEmit            -> exit 0
npx eslint .                -> clean
npx prettier --check .      -> clean
npx vite build              -> built dist/ (26 modules)
```

### Integration (proxy)

With both dev servers running, requests through the Vite proxy were verified:

- `GET http://127.0.0.1:5174/api/v1/ai/health` -> `200`, body proxied from ai-api,
  `x-request-id` present
- `GET http://127.0.0.1:5174/api/v1/ai/nope` -> proxied `404` error envelope
- `GET http://127.0.0.1:5174/` -> `200` (index.html)

## How to run locally

Terminal 1 - backend:

```bash
cd apps/ai-api
python3 -m uvicorn ai_api.main:app --app-dir src --host 0.0.0.0 --port 8000
```

Terminal 2 - frontend:

```bash
cd apps/web-ai
npm install
npm run dev
```

Open `http://localhost:5174`; the dashboard reports the AI API health.

## Deferred to later phases

- Container images for the two apps (`infrastructure/docker`) - Phase 14.
- Auth/session verification against the enterprise backend - Phase 3/4.
- Real data adapters (Postgres/pgvector, Kafka, object store) - Phase 3+.
- Domain schemas and OpenAPI-consumable contracts - Phase 5+.
