# Security

## Identity and authentication

The AI platform does **not** implement its own identity. It reuses the
enterprise IAM:

- The console holds the same opaque enterprise session token used by the rest
  of the platform.
- The AI API presents that token to the enterprise backend to resolve the
  principal (tenant, user, roles, effective permissions).
- Unknown, expired or non-`active` sessions are rejected (`401`).

See `PHASE6_SECURITY_GOVERNANCE.md` for the original design and the
`ENTERPRISE_API_BASE_URL` configuration.

## Authorization

Every route declares a required capability that maps to an enterprise
permission (`security/permissions.py`) — for example `agents.execute` →
`ai.agents:execute`, `retrieval.rag` → `ai.retrieval:query`. Permission checks
fail **closed**: a missing mapping or missing grant denies the request.

Tenant isolation is mandatory: every query and mutation is scoped to the
principal's `tenant_id`. Cross-tenant reads are impossible through the API.

### Retrieval and tool authorization

Authorization is enforced **before** retrieval and again on every result and
agent tool call:

- The retrieval query filters by tenant and by the caller's ACL.
- Results are re-checked; a document the caller cannot access is never returned
  even if it ranks highest.
- Vector similarity is **never** used as an authorization signal.
- Agent tools are individually authorized and each execution is bounded
  (timeout, max iterations, max tool calls) and audited.

## Prompt-injection and untrusted data

- Retrieved document content is treated as **data, not instructions**. Injected
  directives are passed through as text and cannot trigger tools or widen access.
- Model output is untrusted: the console renders it with a small, safe
  Markdown-subset renderer that never uses `dangerouslySetInnerHTML` and shows
  injected HTML/scripts as literal text (`web/src/aiMarkdown.jsx`).
- The default provider is a clearly-labelled mock, so development never sends
  data to a third party.

## Data protection

- Retrieval only ever returns chunks the caller is authorized to see; the
  "insufficient evidence" path returns no citations rather than guessing.
- Prompts, document bodies and personal data are **not** written to logs, metric
  labels or trace attributes. Request/tenant/user identifiers are recorded as
  bounded references only.
- Secrets are held in `Secret` objects / a secret manager and injected as
  environment variables. They are never logged, never serialized into
  responses, and never sent to the browser.
- The audit mirror records actions (who/what/when, with the request id) without
  storing sensitive payloads.

## Network and container hardening

- Only the console is publicly exposed; databases, Kafka, object storage and
  monitoring consoles stay cluster-internal (`deployment.md`).
- `NetworkPolicy` applies default-deny ingress/egress with least-privilege
  allowances.
- Containers run as non-root, with privilege escalation disabled, all Linux
  capabilities dropped, a read-only root filesystem where possible, and the
  `RuntimeDefault` seccomp profile.
- TLS is terminated at the ingress; internal traffic is cluster-scoped.

## Supply chain

- Runtime dependencies are pinned (`requirements.txt`, `package-lock.json`).
- CI builds both images, runs Trivy (fail on HIGH/CRITICAL) and `pip-audit` /
  `npm audit`, and emits CycloneDX SBOMs (`deployment.md`).
- Base images should be pinned by digest for production.

## Reporting

Security issues should be reported through the customer's process. This document
and the code are not a substitute for an independent security review before
production.
