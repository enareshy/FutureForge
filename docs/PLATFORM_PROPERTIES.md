# Helix IAM — Super Admin feature properties

Every platform feature exposes properties Super Admin can change. Operators use the resulting definition; they do not hard-code hierarchy or policy.

Super Admin is role `platform.admin` (seed user `admin`). APIs are gated by `iam.platform` (`update` to mutate, `read` to inspect). Fail-safe deny applies.

## Features

| Feature | Properties Super Admin can change |
|---------|-----------------------------------|
| Organization & Site Structure | Levels (code, label, order, root, collection path, active), allowed parents |
| Directory | `org.allow_multi_site` — users on more than one site |
| Sessions | `identity.session_hours` |
| Authentication | `auth.mfa_required`, `auth.jit_provision`, `auth.rate_limit_max`, `auth.rate_limit_window_seconds`, `auth.reset_token_minutes`, `auth.revoke_sessions_on_reset` |
| Password policy | Existing `/api/password-policy` (min length, classes, lockout) |

## APIs

- `GET /api/hierarchy` — active levels for consoles (`iam.organizations` read)
- `GET/PUT /api/platform/hierarchy` — Super Admin definition
- `GET/PUT /api/platform/settings` — key/value feature properties
- `GET/PUT /api/password-policy` — unchanged

In-process: `getHierarchy(db)`, `getSettings(db)` from `server/platform.js`.
