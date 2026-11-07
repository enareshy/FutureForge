# Deployment & Edition API

Base paths: `/api/deployment` and `/api/v1/deployment`. Every route requires a
session (`Authorization: Bearer <token>`). Reading or changing the profile and
entitlements requires an IAM grant on the matching `iam.deployment.*`
resource; `/capabilities` is open to any authenticated caller so the console
can resolve the posture after login. Errors: `{error, details}`.

## Meta / capabilities / health

- `GET /meta` — topology and edition vocabulary, resource map
- `GET /capabilities` — resolved capability map (`mode`, `edition`,
  `features` code→bool, `catalog`, `summary`)
- `GET /health` — foundation health for this deployment

## Profile

- `GET /profile` — `{profile}`
- `PUT /profile` — body `{mode?, edition?, installation_name?,
  tenant_strategy?, self_registration?, telemetry_enabled?, support_email?,
  notes?}`; returns `{profile}`. `mode` ∈ `saas|private_cloud|local`,
  `edition` ∈ `community|standard|enterprise`, `tenant_strategy` ∈
  `multi|single`. Changing `mode` adopts that topology's defaults unless the
  corresponding field is supplied.

## Feature entitlements

- `GET /features` — `{items, summary}`; each item includes `enabled`,
  `min_edition`, `allowed_modes`, derived `effective` and `reasons`
- `GET /features/summary` — totals per category and the disabled features
- `GET /features/:code` — one feature with its evaluation
- `PUT /features/:code` — body `{enabled?: boolean, notes?: string}`; returns
  the updated feature with `effective` and `reasons`

Reasons: `disabled_by_operator`, `edition_too_low`, `mode_not_allowed`.

## History & bootstrap

- `GET /history` — query `action`, `entityType`, `entityRef`, `page`,
  `pageSize`; returns `{items, total, page, page_size}`
- `POST /foundation/ensure` — re-run the idempotent bootstrap

## Enforcement & error shape

Routers gated by `requireFeature` return `403` with
`details.reason = "feature_not_entitled"` and `details.feature = <code>` when
the deployment is not entitled. The denial is audited as
`deployment.feature.denied`.

Design notes: `docs/DEPLOYMENT_DESIGN.md`.
