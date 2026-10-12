# Phase 6 - Enterprise security and governance

Phase 6 integrates the **existing enterprise IAM** rather than building a custom
authentication system, and adds configurable governance, prompt-injection
defenses, object-level authorization and secret hygiene.

## Integration decision

The enterprise backend (`/server`, "helix-iam") is authoritative for identity,
roles, permissions and tenants:

- Authentication uses **opaque 64-hex session tokens** stored in the `sessions`
  table (not JWT). A token is sent as `Authorization: Bearer <token>`.
- `GET /api/auth/me` returns the user, effective roles/groups and the session.
- `GET /api/authorization/effective/{userId}` returns the effective enterprise
  permission codes (`<resource>:<action>`).
- A tenant is a row in `organizations` where `kind = 'tenant'`; ids are `bigint`.

The AI API therefore **reuses** this IAM: it verifies the session and reads the
effective permissions from the enterprise backend. It never re-implements login,
password handling, MFA, roles or tenant membership.

## Identity bridge

`security/enterprise_identity.py`:

1. `GET {ENTERPRISE_API_BASE_URL}/api/auth/me` -> user + roles.
2. `GET {ENTERPRISE_API_BASE_URL}/api/authorization/effective/{userId}` -> permissions.

It builds a `Principal` (user id, username, tenant, organization, roles,
permissions) and caches it in-memory for `IDENTITY_CACHE_TTL_SECONDS`, keyed by a
SHA-256 hash of the token (raw tokens are never stored).

Fail-closed guarantees: a missing token, an invalid/expired session, a non-active
user, an unreachable backend, or a malformed response all raise `unauthorized`
(401). The AI API never falls back to anonymous or privileged access.

Provider selection (`IDENTITY_PROVIDER`):

| Value | Behaviour |
| --- | --- |
| `auto` (default) | enterprise in production, development otherwise |
| `enterprise` | always verify against the enterprise IAM |
| `development` | privileged dev principal (refused in production) |

## Authorization model

AI capabilities are gated by **enterprise permission codes**. The mapping is
configurable (`AI_PERMISSION_MAP`, JSON) with these defaults:

| Capability | Enterprise permission |
| --- | --- |
| capabilities/models | `ai.platform:read` |
| chat / summarize | `ai.chat:execute` |
| knowledge read | `ai.knowledge:read` |
| knowledge create | `ai.knowledge:create` |
| knowledge index | `ai.knowledge:execute` |
| usage | `ai.usage:read` |
| audit | `ai.audit:read` |
| agents read / execute | `ai.agents:read` / `ai.agents:execute` |
| retrieval search | `ai.retrieval:execute` |

`Policy` also accepts wildcards (`*:*`, `<resource>:*`) and a configurable
**admin bypass** (`AI_ADMIN_PERMISSIONS`, default `iam.platform:read`) so that the
enterprise platform-admin permission grants unrestricted AI access until granular
`ai.*` resources are seeded in the enterprise IAM.

Authorization is enforced on every route (before any retrieval or action) and is
never delegated to the LLM. Retrieved documents and external content are treated
as untrusted data.

## Governance and retention

`ai.governance_policies` (one row per tenant, `jsonb`) drives configurable,
per-tenant policy:

| Field | Meaning |
| --- | --- |
| `allowed_models` | allow-list of model codes (empty = all) |
| `daily_token_quota` | per-tenant daily token budget (0 = unlimited) |
| `requests_per_minute` | reserved for per-tenant throttling |
| `max_prompt_chars` | maximum request size (default 20000) |
| `retention_days` | data-retention window (consumed by ingestion/retention jobs) |
| `data_classification_ceiling` | maximum classification a tenant may process |
| `block_prompt_injection` | reject requests containing injection signals |
| `features` | per-tenant feature toggles (`{"chat": false}`) |

`application/services/governance_service.py` evaluates policy before an operation
(model allow-list, size, feature toggle, daily quota via usage records) and denies
with `403`/`422`/`429` as appropriate.

## Prompt-injection defenses

`security/prompt_safety.py`:

- `scan_untrusted_text` detects conservative instruction-override / exfiltration
  patterns.
- `PromptGuard.harden_system_prompt` prepends a policy statement instructing the
  model to treat all embedded content as data and to ignore instructions inside
  it. The guard is always applied to chat/summarize.
- When a tenant sets `block_prompt_injection`, suspicious requests are rejected
  and audited (`outcome = denied`).

Detection is heuristic and never the sole control: authorization is enforced
server-side and the LLM is never trusted to enforce it.

## Secret management

Sensitive settings use Pydantic `SecretStr` and are never logged or serialized:
`POSTGRES_PASSWORD`, `LLM_API_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`OPENSEARCH_PASSWORD`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Provider
credentials are only read at the point of use.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `IDENTITY_PROVIDER` | `auto` | Identity provider selection |
| `IDENTITY_CACHE_TTL_SECONDS` | `30` | Identity cache TTL |
| `AI_PERMISSION_MAP` | `` | JSON override of the capability->permission map |
| `AI_ADMIN_PERMISSIONS` | `iam.platform:read` | Permission(s) granting unrestricted AI access |

## Verification (Phase 6)

- `ruff check src tests` clean; `python3 -m pytest` -> **68 passed**.
- Unit tests cover the identity bridge (mapping, caching, fail-closed on
  expired/inactive/unreachable/missing token), the permission map and wildcards,
  governance enforcement (model allow-list, size, feature toggle, quota), and
  prompt-injection detection.
- Migration `0005_ai_governance.sql` applied; repository roundtrip verified
  against the real `ai` schema inside a rolled-back transaction; re-run is
  idempotent.
- **Live end-to-end** against the running enterprise IAM:
  - no token -> `401`; bogus token -> `401` (fail closed);
  - enterprise admin session -> `200` on `capabilities` and DB-backed
    `knowledge/sources`;
  - non-privileged users (`j.patel`, `m.okonkwo`) -> `403`;
  - inactive user -> rejected.
