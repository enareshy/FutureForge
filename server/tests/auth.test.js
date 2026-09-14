import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as users from "../services/users.js";
import * as authentication from "../services/authentication.js";
import * as providers from "../services/providers.js";
import * as mfa from "../services/mfa.js";
import * as sessions from "../services/sessions.js";
import * as hierarchy from "../services/hierarchy.js";
import { totpCode, decryptSecret, decryptJson } from "../crypto.js";
import { queryOne } from "../db.js";
import { HttpError } from "../validation.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  seedDatabase(database);
  return database;
}

describe("authentication core", () => {
  let database;
  beforeEach(() => {
    database = db();
  });

  test("password login issues opaque session without hashes", () => {
    const res = authentication.login(database, { username: "admin", password: "HelixAdmin!42" }, { ip: "10.0.0.1" });
    assert.ok(res.token);
    assert.equal(res.user.username, "admin");
    assert.equal(res.user.password_hash, undefined);
    assert.ok(res.session.public_id);
    const listed = sessions.listMySessions(database, res.user.id);
    assert.ok(listed.every((s) => s.token === undefined));
    assert.ok(listed.some((s) => s.public_id === res.session.public_id));
  });

  test("rejects invalid password and locks after threshold", () => {
    assert.throws(
      () => authentication.login(database, { username: "j.patel", password: "nope" }),
      (err) => err instanceof HttpError && err.status === 401
    );
    const policy = queryOne(database, "SELECT lockout_threshold FROM password_policy WHERE id = 1");
    for (let i = 1; i < policy.lockout_threshold; i++) {
      try {
        authentication.login(database, { username: "j.patel", password: "nope" }, { ip: `10.0.0.${i + 2}` });
      } catch {
        /* expected */
      }
    }
    assert.throws(
      () => authentication.login(database, { username: "j.patel", password: "nope" }, { ip: "10.0.0.9" }),
      (err) => err instanceof HttpError && err.status === 403
    );
  });

  test("password reset consumes token and enforces policy", () => {
    const asked = authentication.requestPasswordReset(
      database,
      { username: "j.patel" },
      { ip: "10.1.0.1", includeToken: true }
    );
    assert.equal(asked.ok, true);
    assert.ok(asked.token);
    assert.throws(
      () => authentication.completePasswordReset(database, { token: asked.token, password: "short" }),
      HttpError
    );
    authentication.completePasswordReset(database, { token: asked.token, password: "HelixUser!99" }, { ip: "10.1.0.1" });
    const res = authentication.login(database, { username: "j.patel", password: "HelixUser!99" }, { ip: "10.1.0.2" });
    assert.ok(res.token);
    assert.throws(
      () => authentication.completePasswordReset(database, { token: asked.token, password: "HelixUser!98" }),
      HttpError
    );
  });

  test("reset request does not enumerate accounts", () => {
    const missing = authentication.requestPasswordReset(database, { username: "no.such.user" }, { ip: "10.2.0.1" });
    assert.equal(missing.ok, true);
    assert.equal(missing.token, undefined);
  });
});

describe("mfa totp", () => {
  let database;
  beforeEach(() => {
    database = db();
  });

  test("enroll, challenge, recover", () => {
    const admin = users.listUsers(database, { q: "admin" }).items[0];
    const enroll = mfa.enrollTotp(database, admin, "127.0.0.1");
    assert.ok(enroll.secret);
    assert.ok(enroll.otpauth.startsWith("otpauth://totp/"));
    const factor = queryOne(database, "SELECT secret_enc FROM mfa_factors WHERE user_id = ?", [admin.id]);
    assert.notEqual(factor.secret_enc, enroll.secret);
    assert.equal(decryptSecret(factor.secret_enc), enroll.secret);
    const verified = mfa.verifyTotpEnrollment(database, admin, totpCode(enroll.secret), "127.0.0.1");
    assert.equal(verified.verified, true);
    assert.equal(verified.recoveryCodes.length, 10);

    const login = authentication.login(database, { username: "admin", password: "HelixAdmin!42" }, { ip: "10.3.0.1" });
    assert.equal(login.mfaRequired, true);
    assert.ok(login.mfaToken);
    assert.equal(login.token, undefined);

    const done = authentication.completeMfa(
      database,
      { mfaToken: login.mfaToken, code: totpCode(enroll.secret) },
      { ip: "10.3.0.1" }
    );
    assert.ok(done.token);
    assert.equal(done.session.mfa_verified ?? 1, 1);

    const recoveryLogin = authentication.login(database, { username: "admin", password: "HelixAdmin!42" }, { ip: "10.3.0.2" });
    const recovered = authentication.completeMfa(
      database,
      { mfaToken: recoveryLogin.mfaToken, recoveryCode: verified.recoveryCodes[0] },
      { ip: "10.3.0.2" }
    );
    assert.ok(recovered.token);
  });

  test("platform mfa required blocks users without a factor", () => {
    hierarchy.updateSettings(database, { values: { "auth.mfa_required": true } });
    assert.throws(
      () => authentication.login(database, { username: "j.patel", password: "HelixUser!42" }, { ip: "10.4.0.1" }),
      (err) => err instanceof HttpError && err.status === 403
    );
  });
});

describe("sso providers", () => {
  let database;
  beforeEach(() => {
    database = db();
  });

  test("oidc start and assertion callback maps to linked user", () => {
    const oidc = providers.createProvider(database, {
      code: "corp-oidc",
      name: "Corporate OIDC",
      type: "oidc",
      client_secret: "super-secret-value",
      config: {
        issuer: "https://idp.example",
        client_id: "helix",
        authorization_url: "https://idp.example/authorize",
        token_url: "https://idp.example/token",
      },
    });
    assert.equal(oidc.config.client_secret, undefined);
    assert.equal(oidc.config.client_secret_configured, true);
    const raw = queryOne(database, "SELECT secrets_enc FROM auth_providers WHERE id = ?", [oidc.id]);
    assert.notEqual(raw.secrets_enc, "super-secret-value");
    assert.equal(decryptJson(raw.secrets_enc).client_secret, "super-secret-value");

    const admin = users.listUsers(database, { q: "admin" }).items[0];
    providers.linkIdentity(database, admin.id, oidc.id, "admin-sub", "admin@helix.example");
    const start = authentication.startSso(database, "corp-oidc", {}, { ip: "10.5.0.1" });
    assert.ok(start.authorizationUrl.includes("state="));
    const done = authentication.completeSso(
      database,
      "corp-oidc",
      { state: start.state, assertion: { subject: "admin-sub", email: "admin@helix.example" } },
      { ip: "10.5.0.1" }
    );
    assert.ok(done.token);
    assert.equal(done.user.username, "admin");
  });

  test("saml callback with NameID", () => {
    const saml = providers.createProvider(database, {
      code: "corp-saml",
      name: "Corporate SAML",
      type: "saml",
      config: { entity_id: "helix-iam", sso_url: "https://idp.example/sso", acs_url: "/api/sso/corp-saml/callback" },
    });
    const admin = users.listUsers(database, { q: "admin" }).items[0];
    providers.linkIdentity(database, admin.id, saml.id, "admin@helix.example", "admin@helix.example");
    const start = authentication.startSso(database, "corp-saml", {}, { ip: "10.6.0.1" });
    const xml = `<Response><Assertion><NameID>admin@helix.example</NameID></Assertion></Response>`;
    const done = authentication.completeSso(
      database,
      "corp-saml",
      { RelayState: start.state, SAMLResponse: Buffer.from(xml).toString("base64") },
      { ip: "10.6.0.1" }
    );
    assert.ok(done.token);
  });

  test("ldap bind against encrypted directory", () => {
    providers.createProvider(database, {
      code: "corp-ldap",
      name: "Corporate LDAP",
      type: "ldap",
      directory: [{ username: "admin", password: "LdapPass!42", subject: "uid=admin", email: "admin@helix.example" }],
    });
    const res = authentication.login(
      database,
      { username: "admin", password: "LdapPass!42", provider: "corp-ldap" },
      { ip: "10.7.0.1" }
    );
    assert.ok(res.token);
    const listed = providers.listProviders(database);
    const ldap = listed.find((p) => p.code === "corp-ldap");
    assert.equal(ldap.config.directory, undefined);
    assert.equal(ldap.config.directory_configured, true);
  });
});

describe("rate limit", () => {
  test("returns 429 after window max", () => {
    const database = db();
    hierarchy.updateSettings(database, { values: { "auth.rate_limit_max": 3, "auth.rate_limit_window_seconds": 60 } });
    for (let i = 0; i < 3; i++) {
      try {
        authentication.login(database, { username: "admin", password: "wrong" }, { ip: "10.8.0.1" });
      } catch (err) {
        assert.notEqual(err.status, 429);
      }
    }
    assert.throws(
      () => authentication.login(database, { username: "admin", password: "wrong" }, { ip: "10.8.0.1" }),
      (err) => err instanceof HttpError && err.status === 429
    );
  });
});
