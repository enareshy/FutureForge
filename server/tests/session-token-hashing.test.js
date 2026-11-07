import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  migrate,
  openTestDatabase,
  queryAll,
  queryOne,
} from "../db.js";
import { seedDatabase } from "../seed.js";
import * as authentication from "../services/authentication.js";
import * as sessions from "../services/sessions.js";
import * as tenants from "../services/tenants.js";
import * as users from "../services/users.js";
import {
  hashSessionToken,
  isSessionTokenHash,
  migrateLegacySessionTable,
} from "../session-tokens.js";

function login(username, password = "HelixAdmin!42", ip = "10.20.0.1") {
  return authentication.login(database, { username, password }, { ip });
}

let database;

before(() => {
  database = openTestDatabase();
  migrate(database);
  seedDatabase(database);
});

after(async () => {
  await database.close();
});

describe("session token hashing", () => {
  test("new sessions persist only a canonical hash", () => {
    const res = login("admin", "HelixAdmin!42", "10.20.0.2");
    const row = queryOne(database, "SELECT * FROM sessions WHERE public_id = ?", [res.session.public_id]);

    assert.ok(row);
    assert.equal(row.token, undefined);
    assert.ok(isSessionTokenHash(row.token_hash));
    assert.equal(row.token_hash, hashSessionToken(res.token));
    assert.notEqual(row.token_hash, res.token);
    assert.equal(row.token_hash.includes(res.token), false);
  });

  test("the raw token authenticates and the wrong token fails closed", async () => {
    const res = login("admin", "HelixAdmin!42", "10.20.0.3");

    const sync = sessions.getSessionByToken(database, res.token);
    assert.equal(sync?.public_id, res.session.public_id);

    const asyncRow = await sessions.getSessionByTokenAsync(database, res.token);
    assert.equal(asyncRow?.public_id, res.session.public_id);

    assert.equal(sessions.getSessionByToken(database, `${res.token}0`), null);
    assert.equal(await sessions.getSessionByTokenAsync(database, "not-a-token"), null);
    assert.equal(sessions.getSessionByToken(database, ""), null);
    assert.equal(sessions.getSessionByToken(database, null), null);
    assert.equal(await sessions.getSessionByTokenAsync(database, undefined), null);
  });

  test("public session representations never expose the hash or the raw token", () => {
    const res = login("j.patel", "HelixUser!42", "10.20.0.4");
    const row = sessions.getSessionByToken(database, res.token);
    const publicRow = sessions.publicSession(row);

    assert.equal(publicRow.token, undefined);
    assert.equal(publicRow.token_hash, undefined);
    assert.equal(publicRow.public_id, res.session.public_id);

    const listed = sessions.listMySessions(database, res.user.id);
    assert.ok(listed.length > 0);
    assert.ok(listed.every((s) => s.token === undefined && s.token_hash === undefined));
  });

  test("logout invalidates the token", async () => {
    const res = login("j.patel", "HelixUser!42", "10.20.0.5");
    sessions.logoutToken(database, res.token, { id: res.user.id, username: res.user.username }, "10.20.0.5");

    assert.equal(sessions.getSessionByToken(database, res.token), null);
    assert.equal(await sessions.getSessionByTokenAsync(database, res.token), null);
  });

  test("administrative revoke invalidates the token", async () => {
    const res = login("j.patel", "HelixUser!42", "10.20.0.6");
    sessions.revokeSession(database, res.session.public_id, { id: res.user.id, username: res.user.username }, "10.20.0.6");

    assert.equal(sessions.getSessionByToken(database, res.token), null);
    assert.equal(await sessions.getSessionByTokenAsync(database, res.token), null);
  });

  test("expired sessions remain rejected and are revoked", () => {
    const res = login("j.patel", "HelixUser!42", "10.20.0.7");
    const hash = hashSessionToken(res.token);
    database
      .prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
      .run("2000-01-01 00:00:00", hash);

    assert.equal(sessions.getSessionByToken(database, res.token), null);
    const row = queryOne(database, "SELECT revoked_at FROM sessions WHERE token_hash = ?", [hash]);
    assert.ok(row.revoked_at);
  });

  test("revoke-all keeps the current token and invalidates the others", async () => {
    const user = users.listUsers(database, { q: "admin" }).items.find((u) => u.username === "admin");
    const first = login("admin", "HelixAdmin!42", "10.20.0.8");
    const second = login("admin", "HelixAdmin!42", "10.20.0.9");

    await sessions.revokeAllSessionsAsync(database, user.id, user, "10.20.0.9", {
      exceptToken: first.token,
    });

    assert.ok(sessions.getSessionByToken(database, first.token));
    assert.equal(await sessions.getSessionByTokenAsync(database, second.token), null);
  });

  test("tenant switching still resolves the hashed session", async () => {
    const res = login("admin", "HelixAdmin!42", "10.20.0.10");
    const actor = queryOne(database, "SELECT * FROM users WHERE id = ?", [res.user.id]);
    const helix = queryOne(database, "SELECT id FROM organizations WHERE code = 'helix' AND kind = 'tenant'");

    await tenants.selectTenantAsync(database, res.token, helix.id, actor, "10.20.0.10");

    const row = sessions.getSessionByToken(database, res.token);
    assert.equal(Number(row.tenant_id), Number(helix.id));
  });

  test("raw tokens are absent from auth audit entries", () => {
    const res = login("admin", "HelixAdmin!42", "10.20.0.11");
    const entries = queryAll(
      database,
      "SELECT details FROM audit_logs WHERE action = 'auth.session.create' AND resource_id = ?",
      [res.session.public_id]
    );
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(entry.details.includes(res.token), false);
      assert.equal(entry.details.includes(hashSessionToken(res.token)), false);
    }
  });

  test("concurrent async lookups are consistent", async () => {
    const res = login("admin", "HelixAdmin!42", "10.20.0.12");
    const rows = await Promise.all(
      Array.from({ length: 8 }, () => sessions.getSessionByTokenAsync(database, res.token))
    );
    assert.ok(rows.every((row) => row?.public_id === res.session.public_id));
  });

  test("legacy plaintext sessions migrate once and never double-hash", () => {
    database.exec(`
      CREATE TABLE sessions_legacy (
        token TEXT PRIMARY KEY,
        user_id bigint NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO sessions_legacy (token, user_id, expires_at) VALUES
        ('${"a".repeat(64)}', 1, '2999-01-01 00:00:00'),
        ('${"b".repeat(64)}', 1, '2000-01-01 00:00:00'),
        ('', 1, '2999-01-01 00:00:00');
    `);

    const first = migrateLegacySessionTable(database, "sessions_legacy");
    assert.equal(first.migrated, 2);
    assert.equal(first.hadLegacyToken, true);

    const columns = queryAll(
      database,
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sessions_legacy'"
    ).map((row) => row.column_name);
    assert.equal(columns.includes("token"), false);
    assert.ok(columns.includes("token_hash"));

    const rows = queryAll(database, "SELECT user_id, expires_at, token_hash FROM sessions_legacy ORDER BY expires_at");
    assert.equal(rows.length, 2, "empty legacy token is discarded");
    assert.ok(rows.every((row) => isSessionTokenHash(row.token_hash)));
    assert.equal(rows.find((row) => row.expires_at.startsWith("2000")).token_hash, hashSessionToken("b".repeat(64)));

    const primaryKey = queryAll(
      database,
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       WHERE tc.table_schema = current_schema()
         AND tc.table_name = 'sessions_legacy'
         AND tc.constraint_type = 'PRIMARY KEY'`
    ).map((row) => row.column_name);
    assert.deepEqual(primaryKey, ["token_hash"]);

    const before = rows.map((row) => row.token_hash).sort();
    const second = migrateLegacySessionTable(database, "sessions_legacy");
    const after = queryAll(database, "SELECT token_hash FROM sessions_legacy").map((row) => row.token_hash).sort();
    assert.equal(second.migrated, 0);
    assert.equal(second.hadLegacyToken, false);
    assert.deepEqual(after, before, "a rerun must not hash hashes again");
  });
});
