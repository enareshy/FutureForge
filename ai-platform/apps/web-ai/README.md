# web-ai

React + TypeScript + Vite console for the Enterprise AI Platform. This is a new
TypeScript application; the existing platform UI remains untouched.

## Features (Phase 2)

- Vite dev server on port `5174` with a reverse proxy: `/api` -> `http://127.0.0.1:8000`.
- Typed API client (`src/api/client.ts`) with a uniform `ApiError` mapped from the
  backend error envelope, including `request_id` for traceability.
- Dashboard page that renders AI API health and degrades gracefully when the API is down.

## Scripts

```bash
npm install
npm run dev        # dev server with /api proxy on :5174
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build on :5174
npm test           # vitest (jsdom)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (flat config)
npm run format     # prettier
```

## Configuration

Copy `.env.example` to `.env` if you need a non-proxy API base URL:

```
VITE_API_BASE_URL=
```

Leaving it empty routes requests through the dev-server proxy, which keeps a single
public port for previews and avoids CORS.

## Testing

Tests use Vitest with jsdom and Testing Library. `fetch` is stubbed per test; no
network access is required.
