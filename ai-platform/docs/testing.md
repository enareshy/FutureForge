# Testing

Test strategy and coverage. Full detail — markers, opt-in flags, what each suite
asserts — is in `PHASE13_TESTING.md`.

## Layers

| Layer | Command | Default | Requires |
| --- | --- | --- | --- |
| Unit + application + API + AI evaluation | `PYTHONPATH=src python3 -m pytest` | yes | nothing (hermetic) |
| End-to-end copilot | included above (`-m e2e`) | yes | nothing |
| Integration | `AI_TEST_POSTGRES=1 … pytest -m integration` | no | opted-in services |
| Live smoke | `AI_E2E=1 … pytest -m live` | no | a running deployment |
| Frontend | `npm run test:web` (repo root) | yes | node |

## Backend

From `ai-platform/apps/ai-api`:

```bash
# Lint.
ruff check src tests scripts

# Hermetic suite (unit + e2e + deterministic AI evaluation).
PYTHONPATH=src python3 -m pytest

# Integration, per service (each `AI_TEST_*` opts one in).
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -m integration
```

The default suite runs against an in-memory repository and the deterministic
mock provider — no database, network or containers.

### AI evaluation

`tests/test_ai_evaluation.py` asserts held properties on the mock provider:
retrieval relevance (recall@k, MRR), citation correctness, groundedness,
insufficient-evidence handling, prompt-injection resistance, no unauthorized
data leakage, and provider-failure recovery. It does not claim real-model
quality; that requires the opt-in `AI_TEST_LIVE_LLM` path.

### Live smoke

```bash
AI_E2E=1 AI_E2E_BASE_URL=http://127.0.0.1:8000 AI_E2E_TOKEN=<token> \
  PYTHONPATH=src python3 -m pytest -m live
```

Checks liveness, readiness, `/metrics`, that protected endpoints require auth,
and authenticated chat/search roundtrips.

## Frontend

From the repository root (vitest + Testing Library):

```bash
npm run test:web
```

Covers the API client (request building, error mapping, SSE parsing, timeouts),
the AI chat page (citations, insufficient evidence, errors, auth state,
streaming), the safe Markdown renderer (injection safety, links) and the error
boundary.

## Results (current)

- Backend: **134 passed, 14 skipped** (skips are opt-in integration/live).
- Frontend: **23 passed** (4 files).
- `ruff check src tests scripts`: clean.

## CI

`.github/workflows/ai-platform-ci.yml` runs the backend suite, both frontend
suites + builds, manifest validation, image builds with Trivy scanning + SBOM,
and dependency scanning. See `deployment.md`.
