# Phase 10 — Enterprise Console Integration

Phase 10 makes the AI platform usable from the **existing enterprise console**
(`web/`, React 18 + Vite, served on port `5173`) rather than a separate
application. The console already handles enterprise sign-in, tenant switching
and the rest of the platform's modules; the AI surface is added into that same
shell so users reach it without a second login or a second host.

## Design decisions

- **Keep JavaScript.** The console is plain `.jsx`; the new AI pages match that
  style rather than introducing TypeScript into an existing JS app.
- **Reuse the existing session.** AI requests go to `/api/v1/ai`, which the root
  `vite.config.js` proxies to the AI API on `:8000`. The same enterprise session
  token (`helix_iam_token`) is sent as a bearer token, so the AI API verifies
  the caller against enterprise IAM exactly like the rest of the platform.
- **Minimal backend, honest UI.** The phase adds only what the screens needed —
  feedback capture, a read-only provider view and SSE chat streaming. No
  metrics or scores are fabricated: the evaluation screen states plainly that
  automated evaluation suites are not part of this release and shows only real,
  recorded human feedback.
- **Untrusted model output.** Assistant text is rendered through a small, safe
  Markdown subset renderer (`web/src/aiMarkdown.jsx`) that never uses
  `dangerouslySetInnerHTML`; any HTML or script in model output is shown as
  literal text.

## Backend additions

| Area | Endpoint / change | Notes |
| --- | --- | --- |
| Feedback | `POST /api/v1/ai/feedback`, `GET /api/v1/ai/feedback` | Gated by `ai.feedback:create` / `ai.feedback:read`. A rating or a non-blank comment is required; the check is enforced in the service so validation returns the platform's structured 422 envelope. |
| Providers | `GET /api/v1/ai/providers` | Read-only registry grouped by provider with per-model capabilities. Gated by `ai.models:read`. |
| Streaming | `POST /api/v1/ai/chat/stream` | Server-Sent Events: `delta` frames per chunk, then a terminal `done` (or `error`) frame. Authorization, prompt-injection screening and streaming-support checks run *before* the stream opens, so failures still return a normal JSON error envelope. |

The mock provider now emits real streamed chunks, so the streaming path is
exercised end-to-end without provider credentials.

## Frontend additions

- `web/src/aiApi.js` — the AI client. Adds JSDoc types, request timeouts and
  abort support, `providers()`, `feedback()` / `createFeedback()`, and
  `streamChat()` (an SSE reader that surfaces `delta` / `done` / `error`).
- `web/src/aiMarkdown.jsx` — the safe Markdown subset renderer.
- `web/src/pages/AiModelsPage.jsx` — read-only models and providers view.
- `web/src/pages/AiEvaluationsPage.jsx` — the evaluation & feedback screen with
  an explicit not-enabled notice and a real feedback table.
- `web/src/pages/AiChatPage.jsx` — adds streaming with a cancel button, safe
  rendering, and per-answer feedback capture.
- `web/src/pages/AiAgentsPage.jsx` — renders answers safely and captures
  feedback against the recorded execution id.
- `web/src/App.jsx` — adds the "Models & providers" and "Evaluation & feedback"
  navigation entries and routes. The diagnostic surfaces ("Events &
  observability" and "AI audit log") are restricted to Admin/Super Admin, the
  same way the platform's own audit log is.

Sources are citable end-to-end: every citation (in Copilot RAG answers and in
agent runs) links to the knowledge screen as
`/ai/knowledge?source=<id>&document=<id>`, which preselects the source and
highlights the document row.

Every AI screen implements explicit loading and empty states, paginates its
tables and surfaces the AI API's structured error envelope (code, message and
request id) inline.

## Verification

```bash
# AI API unit + integration tests
cd ai-platform/apps/ai-api
PYTHONPATH=src python3 -m pytest

# Console build
cd web
npx vite build
```

Live check against a running AI API (`:8000`) with an enterprise session token:

```bash
curl -s http://127.0.0.1:8000/api/v1/ai/providers -H "Authorization: Bearer $TOKEN"

curl -s -X POST http://127.0.0.1:8000/api/v1/ai/feedback \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rating":1,"comment":"grounded and clear"}'

curl -s -N -X POST http://127.0.0.1:8000/api/v1/ai/chat/stream \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

## Notes and limitations

- The standalone `apps/web-ai` console from Phase 2 remains in the repository but
  is not the supported surface for the enterprise deployment; the integrated
  console on `:5173` is.
- Automated evaluation suites (golden datasets, scoring harnesses, regression
  gates) are deferred to a later phase; the evaluations screen intentionally
  shows no quality scores.
