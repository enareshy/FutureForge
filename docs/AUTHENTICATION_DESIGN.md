# Helix IAM — Authentication, SSO & MFA

Central identity service for every future platform module. Identity, RBAC, and org context already exist; this submodule is the only way a principal obtains a session. Modules must not collect passwords or talk to an IdP directly.

## Existing fabric (extended, not replaced)

| Capability | Already in tree | Extension |
|------------|-----------------|-----------|
| Username/password | `users.authenticate` | Routed through provider `password` |
| Password hashing | scrypt + per-user salt (`server/crypto.js`) | Unchanged |
| Password policy | `password_policy` singleton | Unchanged; also enforced on self-service reset |
| Admin password reset | `POST /api/users/:id/reset-password` | Self-service reset added (`/api/authentication/password-reset/*`) |
| Lockout | `failed_login_attempts` / `locked_until` | Unchanged; fires before MFA |
| Sessions | opaque `sessions.token` | public id, ip, user-agent, provider, MFA flag, revoke |
| Logout | `POST /api/auth/logout` | Plus session list / revoke-all |
| Audit | `audit_logs` | Auth, MFA, SSO, rate-limit actions |
| Console login | `POST /api/auth/login` | Same contract; MFA challenge when enrolled |

Fail-safe: unknown provider, disabled provider, unmatched SSO subject, invalid MFA, expired challenge, and rate-limit overflow are **deny**. Default deny still applies to administration APIs via `requirePermission`.

## Security flow

```
Client
  |  POST /api/authentication/login  { username, password, provider? }
  |  or POST /api/sso/:code/start then /callback
  v
Rate limit (ip + principal, sliding window)
  | exceed -> 429, audit auth.rate_limited, stop
  v
Provider.authenticate | Provider.complete
  password -> users.authenticate (hash verify, lockout, status)
  oidc/saml/ldap -> map auth_identities.subject -> local user
  | fail -> audit, lockout (password only), deny
  v
Account active?
  | inactive/locked -> 403
  v
MFA required? (platform setting auth.mfa_required OR user has verified TOTP)
  | yes -> mfa_challenges row (hashed token), return { mfaRequired, mfaToken }
  |      POST /api/mfa/challenge/verify { mfaToken, code | recoveryCode }
  |      TOTP window +/- 1; recovery codes are single-use scrypt hashes
  v
sessions.create (opaque token once; public_id for APIs)
  | never log token, password, TOTP, recovery, client_secret
  v
Bearer session -> requireAuth -> RBAC
```

Password reset:

```
POST /api/authentication/password-reset/request { username | email }
  always 200 { ok: true }  (no account enumeration)
  if user exists: store sha256(token), expiry from auth.reset_token_minutes
POST /api/authentication/password-reset/complete { token, password }
  policy + history; consume token; revoke other sessions optional via setting
```

## Provider architecture

Providers are rows in `auth_providers`, not compiled IdPs. Type is a plug-in key:

| type | Binding | Login |
|------|---------|-------|
| `password` | Local `users` table | username/password |
| `oidc` | Authorization Code + PKCE | `/api/sso/:code/start` → IdP → `/callback` |
| `saml` | SAML 2.0 SP AuthnRequest | HTTP-Redirect start, POST ACS callback |
| `ldap` | Bind + search filter | username/password against directory (`ldap://stub` in tests) |

Interface (`server/services/providers`):

- `validateConfig(config)`
- `publicMetadata(config)` — never includes secrets
- `start(ctx)` — SSO only
- `complete(ctx)` / `authenticate(ctx)` — returns `{ subject, email, username? }`

Secrets (`client_secret`, IdP certificates used as keys, LDAP bind password, TOTP seeds) are AES-256-GCM at rest (`encryptSecret`). APIs return `configured: true` never the value.

Link table `auth_identities(user_id, provider_id, subject)` maps an external subject to a Helix user. JIT create is **off** by default (`auth.jit_provision` setting).

## MFA

- TOTP (RFC 6238, HMAC-SHA1, 30s, 6 digits). Secret shown once at enroll as `otpauth://` URI.
- Recovery codes: 10 codes, scrypt hashed, one-time.
- `auth.mfa_required`: Super Admin. When 0, MFA runs only if the user enrolled a verified factor (existing `admin` login stays token-returning).
- Admin `POST /api/mfa/admin/:userId/reset` clears factors (`iam.users` execute).

## Sessions

Opaque 32-byte hex token (Bearer). `public_id` is what list/revoke APIs expose. Fields: user, expiry (`identity.session_hours`), ip, user-agent, `provider_code`, `mfa_verified`, `last_seen_at`, `revoked_at`.

`GET /api/sessions` is the caller’s sessions. Admin list/revoke uses `iam.sessions`.

## Rate limiting

`auth_attempts` rows keyed by `ip|action|principal`. Defaults: 10 / 60s (`auth.rate_limit_max`, `auth.rate_limit_window_seconds`). Applies to login, MFA verify, password-reset request, SSO callback.

## RBAC resources

| Resource | Routes |
|----------|--------|
| (public) | login, logout, me, password-reset, SSO start/callback, public provider list |
| `iam.authentication` | provider CRUD, auth settings |
| `iam.sessions` | admin session list/revoke |
| `iam.users` execute | admin MFA reset (existing password reset) |
| `iam.policy` | password policy (unchanged) |

`platform.admin` / `iam.admin` receive full grants. `app.reader` does not.

## HTTP (consumed by modules)

| Area | Routes |
|------|--------|
| Authentication | `POST /api/authentication/login` `POST /api/authentication/logout` `GET /api/authentication/providers` `GET/PUT /api/authentication/settings` `GET/POST /api/authentication/providers` `PUT /api/authentication/providers/:id` |
| Compatibility | `POST /api/auth/login` `GET /api/auth/me` `POST /api/auth/logout` |
| Sessions | `GET /api/sessions` `DELETE /api/sessions/:id` `POST /api/sessions/revoke-all` `GET /api/sessions/admin` |
| MFA | `GET /api/mfa/status` `POST /api/mfa/totp/enroll` `POST /api/mfa/totp/verify` `POST /api/mfa/totp/disable` `POST /api/mfa/recovery/regenerate` `POST /api/mfa/challenge/verify` `POST /api/mfa/admin/:userId/reset` |
| SSO | `GET /api/sso/providers` `POST /api/sso/:code/start` `POST /api/sso/:code/callback` `GET /api/sso/:code/metadata` |
| Recovery | `POST /api/authentication/password-reset/request` `POST /api/authentication/password-reset/complete` |

In-process: `authenticateWithPassword`, `createSession`, `requireActiveSession` from `server/platform.js`.

## Non-goals / constraints

- No extra runtime dependencies (no passport, no speakeasy, no ldapjs).
- Do not hard-code Okta, Entra, Ping, or any vendor. Operators register providers.
- Tokens, passwords, TOTP secrets, recovery codes, and IdP secrets never appear in list APIs, audit `details`, or logs.
