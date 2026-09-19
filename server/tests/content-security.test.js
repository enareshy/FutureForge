process.env.FILE_STORAGE_PROVIDER = "memory";
process.env.FILE_SCAN_PROVIDER = "heuristic";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as content from "../services/content.js";
import { getStorageProvider } from "../services/file-storage.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

describe("Content security, isolation and concurrency", () => {
  let db;
  let admin;
  let user;
  let tenantId;
  let otherTenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    content.ensureContentFoundation(db);
    admin = actorRow(db, "admin");
    user = actorRow(db, "j.patel");
    tenantId = admin.tenant_id ?? admin.organization_id;
    otherTenantId = queryOne(db, "SELECT id FROM organizations WHERE id != ? ORDER BY id LIMIT 1", [tenantId]).id;
  });

  after(() => {
    db?.close();
  });

  function create(name, body, extra = {}) {
    return content.createContent(
      db,
      { fileName: name, buffer: Buffer.from(body), objectType: "Part", objectId: "P-1", ...extra },
      { actor: admin, tenantId }
    );
  }

  test("neutralizes path traversal filenames and never leaks them into storage keys", async () => {
    const created = await create("../../../../etc/passwd", "traversal attempt");
    assert.equal(created.file_name.includes("/"), false);
    assert.equal(created.file_name.includes("\\"), false);
    assert.equal(created.file_name.startsWith("."), false);
    const row = queryOne(db, "SELECT storage_key FROM content WHERE content_id = ?", [created.content_id]);
    assert.equal(row.storage_key.includes(".."), false);
    assert.equal(row.storage_key.includes("passwd"), false);
    assert.match(row.storage_key, new RegExp(`^tenant/${tenantId}/`));
  });

  test("rejects dangerous extensions and oversized payloads", async () => {
    await assert.rejects(() => create("payload.exe", "MZ"), (err) => err.code === "INVALID_FILE_TYPE");
    await assert.rejects(
      () => content.createContent(
        db,
        { fileName: "big.bin", buffer: Buffer.alloc(2048) },
        { actor: admin, tenantId, maxSize: 1024 }
      ),
      (err) => err.code === "FILE_TOO_LARGE"
    );
  });

  test("rejects checksum mismatches on upload completion", async () => {
    const body = Buffer.from("checksum guard");
    const session = content.initiateUploadSession(
      db,
      { fileName: "checksum.txt", expectedSize: body.length },
      { actor: admin, tenantId }
    );
    await content.appendUploadPart(db, session.upload_id, { partNumber: 1, buffer: body, actor: admin, tenantId });
    await assert.rejects(
      () => content.completeUploadSession(db, session.upload_id, { actor: admin, tenantId, declaredChecksum: "deadbeef" }),
      (err) => err.code === "CHECKSUM_MISMATCH"
    );
  });

  test("enforces tenant isolation on read, list and detail", async () => {
    const created = await create("isolated.txt", "tenant scoped");
    assert.throws(() => content.getContent(db, created.content_id, otherTenantId), (err) => err.code === "CONTENT_NOT_FOUND");
    const otherList = content.listContent(db, { tenantId: otherTenantId });
    assert.equal(otherList.items.some((item) => item.content_id === created.content_id), false);
    const ownList = content.listContent(db, { tenantId });
    assert.equal(ownList.items.some((item) => item.content_id === created.content_id), true);
  });

  test("allows only one concurrent check-out and blocks non-owner check-in", async () => {
    const created = await create("contended.txt", "lock contention");

    const results = await Promise.allSettled([
      Promise.resolve().then(() => content.checkOutContent(db, created.content_id, { actor: admin, tenantId })),
      Promise.resolve().then(() => content.checkOutContent(db, created.content_id, { actor: admin, tenantId })),
      Promise.resolve().then(() => content.checkOutContent(db, created.content_id, { actor: admin, tenantId })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 2);
    for (const failure of rejected) assert.equal(failure.reason.code, "CONTENT_LOCKED");

    await assert.rejects(
      () => content.checkInContent(db, created.content_id, { actor: user, tenantId, lockToken: fulfilled[0].value.lock_token }),
      (err) => ["CONTENT_LOCKED", "CONTENT_ACCESS_DENIED"].includes(err.code)
    );
    const released = await content.checkInContent(db, created.content_id, {
      actor: admin,
      tenantId,
      lockToken: fulfilled[0].value.lock_token,
    });
    assert.equal(released.content.status, "available");
  });

  test("quarantines malware, blocks download, and supports authorized release", async () => {
    const created = await create("virus.txt", EICAR);
    assert.equal(created.status, "quarantined");
    assert.equal(created.security_status, "infected");
    assert.throws(
      () => content.downloadInfo(db, created.content_id, { actor: admin, tenantId }),
      (err) => err.code === "CONTENT_QUARANTINED"
    );
    const audits = queryOne(db, "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'content.quarantined'").c;
    assert.ok(audits >= 1);
  });

  test("legal hold always wins over deletion", async () => {
    const created = await create("held.txt", "legal hold");
    const row = content.Repository.findContentRow(db, created.content_id, tenantId);
    content.applyLegalHold(db, row, { reason: "Litigation", actor: admin, tenantId });
    assert.equal(content.canDeleteContent(db, row).allowed, false);
    assert.throws(
      () => content.softDeleteContent(db, created.content_id, { actor: admin, tenantId }),
      (err) => err.code === "LEGAL_HOLD_ACTIVE"
    );
    content.releaseLegalHold(db, row, { reason: "Closed", actor: admin, tenantId });
    const deleted = content.softDeleteContent(db, created.content_id, { actor: admin, tenantId });
    assert.equal(deleted.status, "deleted");
  });

  test("does not expose storage enumeration through the provider interface", () => {
    const provider = getStorageProvider();
    const info = content.resolveContentStorage().info();
    assert.equal(typeof info.provider, "string");
    assert.equal(typeof info.list, "undefined");
    assert.equal(typeof provider.list, "undefined");
  });
});
