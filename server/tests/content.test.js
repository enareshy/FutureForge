process.env.FILE_STORAGE_PROVIDER = "memory";
process.env.FILE_SCAN_PROVIDER = "heuristic";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as content from "../services/content.js";
import * as search from "../services/search.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

function seedTenant() {
  const db = openDatabase(":memory:");
  migrate(db);
  seedDatabase(db);
  return db;
}

describe("Content management foundation", () => {
  let db;
  before(() => {
    db = seedTenant();
  });
  after(() => db?.close());

  test("registers content event types, retention policies and the search resolver", () => {
    const foundation = content.ensureContentFoundation(db);
    assert.equal(foundation.event_types, 0, "event types are created during seeding");
    assert.equal(content.Constants.CONTENT_EVENT_TYPES.length, 21);
    const policies = content.Retention.listRetentionPolicies(db, {}).items;
    assert.ok(policies.length >= 3);
    assert.ok(policies.some((p) => p.policy_code === "content-default"));
    assert.equal(queryOne(db, "SELECT COUNT(*) AS c FROM content_events").c >= 0, true);
  });

  test("foundation is idempotent", () => {
    const before = content.Retention.listRetentionPolicies(db, {}).total;
    content.ensureContentFoundation(db);
    const after = content.Retention.listRetentionPolicies(db, {}).total;
    assert.equal(after, before);
    const registrations = queryOne(
      db,
      "SELECT COUNT(*) AS c FROM search_object_types WHERE code = 'content'"
    ).c;
    assert.ok(registrations >= 1);
  });

  test("exposes a machine-readable error code vocabulary", () => {
    const error = content.Errors.Errors.quarantined();
    assert.equal(error.code, "CONTENT_QUARANTINED");
    assert.equal(error.status, 423);
    assert.ok(error instanceof content.ContentError);
  });
});

describe("Content lifecycle: create, process, version and search", () => {
  let db;
  let actor;
  before(() => {
    db = seedTenant();
    actor = adminActor(db);
  });
  after(() => db?.close());

  async function create(name, payload, extra = {}) {
    return content.createContent(
      db,
      { fileName: name, buffer: Buffer.from(payload), objectType: "Part", objectId: "P-1", ...extra },
      { actor, tenantId: 1 }
    );
  }

  test("creates content, scans it clean and produces supported renditions", async () => {
    const created = await create("drawing.txt", "hello content world");
    assert.equal(created.status, "available");
    assert.equal(created.security_status, "clean");
    assert.equal(created.processing_status, "ready");
    assert.equal(created.version_count, 1);
    assert.match(created.content_key, /^CNT-/);

    const row = content.Repository.findContentRow(db, created.content_id, 1);
    const renditions = content.Renditions.listRenditions(db, row).items;
    const preview = renditions.find((r) => r.rendition_type === "PREVIEW");
    const thumb = renditions.find((r) => r.rendition_type === "THUMBNAIL");
    const text = renditions.find((r) => r.rendition_type === "TEXT");
    const pdf = renditions.find((r) => r.rendition_type === "PDF");
    assert.equal(preview.status, "available");
    assert.equal(thumb.status, "available");
    assert.equal(text.status, "available");
    assert.equal(pdf.status, "skipped", "a text file has no PDF rendition but is not failed");
  });

  test("detects duplicate bytes and records a dedupe reference", async () => {
    const first = await create("dup-a.txt", "duplicate payload value");
    const second = await create("dup-b.txt", "duplicate payload value");
    assert.equal(Number(second.dedupe_of_content_id), Number(first.id));
  });

  test("keeps immutable versions and restores an earlier version as a new version", async () => {
    const created = await create("revision.txt", "version one");
    const before = content.contentDetail(db, created.content_id, { actor, tenantId: 1 });
    assert.equal(before.versions.length, 1);

    const row = content.Repository.findContentRow(db, created.content_id, 1);
    const restored = await content.Versions.restoreVersion(db, row, before.versions[0].version_label, { actor, tenantId: 1 });
    assert.equal(restored.version.version_number, 2);
    assert.equal(Number(restored.version.restored_from_version_id), Number(before.versions[0].id));

    const after = content.contentDetail(db, created.content_id, { actor, tenantId: 1 });
    assert.equal(after.versions.length, 2);
  });

  test("issues a signed, short-lived download URL without exposing storage keys", async () => {
    const created = await create("download.txt", "downloadable bytes");
    const info = content.downloadInfo(db, created.content_id, { actor, tenantId: 1 });
    assert.equal(info.file_name, "download.txt");
    assert.ok(info.url.startsWith("/api/files/download/"));
    assert.equal(info.url.includes(created.storage_key), false);
  });

  test("indexes content metadata into search", async () => {
    const created = await create("searchable-spec.txt", "search me");
    search.drainIndexQueue(db, { limit: 200 });
    const doc = queryOne(db, "SELECT * FROM search_index WHERE object_type = 'content' AND object_id = ?", [String(created.id)]);
    assert.ok(doc, "expected content to be indexed");
  });
});

describe("Content validation and security controls", () => {
  let db;
  let actor;
  before(() => {
    db = seedTenant();
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("sanitizes malicious path filenames instead of trusting them", async () => {
    const created = await content.createContent(
      db,
      { fileName: "../../etc/passwd", buffer: Buffer.from("x") },
      { actor, tenantId: 1 }
    );
    assert.equal(created.file_name.includes("/"), false);
    assert.equal(created.file_name.includes("\\"), false);
    assert.equal(created.file_name.startsWith("."), false);
    assert.equal(content.Repository.findContentRow(db, created.content_id, 1).storage_key.includes("passwd"), false);
  });

  test("rejects dangerous executable extensions", async () => {
    await assert.rejects(
      () => content.createContent(db, { fileName: "payload.exe", buffer: Buffer.from("MZ") }, { actor, tenantId: 1 }),
      (err) => err.code === "INVALID_FILE_TYPE"
    );
  });

  test("enforces the maximum content size", async () => {
    await assert.rejects(
      () =>
        content.createContent(
          db,
          { fileName: "big.txt", buffer: Buffer.alloc(64) },
          { actor, tenantId: 1, maxSize: 32 }
        ),
      (err) => err.code === "FILE_TOO_LARGE"
    );
  });

  test("quarantines malware and blocks downloads", async () => {
    const created = await content.createContent(
      db,
      { fileName: "virus.txt", buffer: Buffer.from(EICAR) },
      { actor, tenantId: 1 }
    );
    assert.equal(created.status, "quarantined");
    assert.equal(created.security_status, "infected");
    const row = content.Repository.findContentRow(db, created.content_id, 1);
    assert.equal(content.Security.latestScan(db, row.id).status, "infected");
    assert.throws(
      () => content.downloadInfo(db, created.content_id, { actor, tenantId: 1 }),
      (err) => err.code === "CONTENT_QUARANTINED"
    );
  });

  test("releases a quarantine only through the security workflow", async () => {
    const created = await content.createContent(
      db,
      { fileName: "virus2.txt", buffer: Buffer.from(EICAR) },
      { actor, tenantId: 1 }
    );
    const row = content.Repository.findContentRow(db, created.content_id, 1);
    const released = content.Security.releaseQuarantine(db, row, { actor, reason: "False positive" });
    assert.equal(released.status, "available");
    assert.equal(released.security_status, "clean");
  });
});

describe("Content associations, locks and retention", () => {
  let db;
  let actor;
  before(() => {
    db = seedTenant();
    actor = adminActor(db);
  });
  after(() => db?.close());

  async function create(name) {
    return content.createContent(db, { fileName: name, buffer: Buffer.from(name) }, { actor, tenantId: 1 });
  }

  test("associates content with generic business objects and enforces one primary", async () => {
    const created = await create("assoc.txt");
    const primary = content.createAssociation(
      db,
      { contentId: created.content_id, objectType: "CADDocument", objectId: "DOC-1", contentRole: "PRIMARY", isPrimary: true },
      { actor, tenantId: 1 }
    );
    assert.equal(primary.content_role, "PRIMARY");
    const secondary = content.createAssociation(
      db,
      { contentId: created.content_id, objectType: "CADDocument", objectId: "DOC-1", contentRole: "ATTACHMENT", isPrimary: true },
      { actor, tenantId: 1 }
    );
    assert.equal(secondary.is_primary, true);
    const list = content.Associations.listObjectContent(db, "CADDocument", "DOC-1", { tenantId: 1 });
    assert.equal(list.items.length, 2);
    const primaries = list.items.filter((item) => item.is_primary);
    assert.equal(primaries.length, 1);
  });

  test("prevents concurrent check-out and requires the lock token to check in", async () => {
    const created = await create("lock.txt");
    const lock = content.checkOutContent(db, created.content_id, { actor, tenantId: 1 });
    assert.match(lock.lock_token, /^LCK-/);
    await assert.rejects(
      async () => content.checkOutContent(db, created.content_id, { actor, tenantId: 1 }),
      (err) => err.code === "CONTENT_LOCKED"
    );
    const checkedIn = await content.checkInContent(db, created.content_id, { actor, tenantId: 1, lockToken: lock.lock_token });
    assert.equal(checkedIn.changed, false);
    assert.equal(checkedIn.content.status, "available");
  });

  test("blocks deletion under legal hold and releases it explicitly", async () => {
    const created = await create("hold.txt");
    const row = content.Repository.findContentRow(db, created.content_id, 1);
    content.Retention.applyLegalHold(db, row, { actor, reason: "Litigation", caseRef: "CASE-42" });
    assert.throws(
      () => content.softDeleteContent(db, created.content_id, { actor, tenantId: 1 }),
      (err) => err.code === "LEGAL_HOLD_ACTIVE"
    );
    const released = content.Retention.releaseLegalHold(db, row, { actor, reason: "Case closed" });
    assert.equal(released.status, "released");
    const deleted = content.softDeleteContent(db, created.content_id, { actor, tenantId: 1, reason: "No longer needed" });
    assert.equal(deleted.status, "deleted");
  });

  test("retention evaluation marks content retained and eligible without deleting it", async () => {
    const created = await create("retention.txt");
    const row = content.Repository.findContentRow(db, created.content_id, 1);
    const policy = content.Retention.listRetentionPolicies(db, { tenantId: 1, activeOnly: true }).items[0];
    run(
      db,
      `INSERT INTO content_retention_records (tenant_id, content_id, policy_id, retention_start, retention_end, disposition, status, legal_hold, created_at, updated_at)
       VALUES (?, ?, ?, '2020-01-01 00:00:00', '2020-02-01 00:00:00', 'purge', 'active', 0, ?, ?)`,
      [1, Number(row.id), Number(policy.id), "2020-01-01 00:00:00", "2020-01-01 00:00:00"]
    );
    const summary = content.Retention.evaluateRetention(db, { tenantId: 1 });
    assert.ok(summary.processed >= 1);
    const updated = content.Repository.findContentRow(db, created.content_id, 1);
    assert.equal(updated.status, "retained");
    assert.equal(updated.deleted_at, null);
  });

  test("reports health and metrics for the content estate", async () => {
    const health = content.healthCheck(db);
    assert.equal(health.service, "content");
    assert.ok(["ok", "degraded"].includes(health.status));
    const metrics = content.metrics.metricsSnapshot(db, { tenantId: 1 });
    assert.ok(metrics.metrics.content_total >= 1);
    assert.ok(metrics.storage.total_bytes >= 1);
  });
});
