process.env.FILE_STORAGE_PROVIDER = "memory";
process.env.FILE_SCAN_PROVIDER = "heuristic";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, raw, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload !== null
            ? { "Content-Type": contentType || "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("File & Content Management REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let userToken;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  async function singleShot(name, content, token = adminToken) {
    const res = await request(port, "POST", `/api/content?name=${encodeURIComponent(name)}`, {
      token,
      raw: Buffer.from(content),
      contentType: "text/plain",
    });
    return res;
  }

  async function startSession(name, size, token = adminToken) {
    return request(port, "POST", "/api/content/uploads", {
      token,
      body: { fileName: name, expectedSize: size, objectType: "Part", objectId: "P-API-1" },
    });
  }

  test("meta exposes vocabulary, permissions and health", async () => {
    const res = await request(port, "GET", "/api/content/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.content_roles.includes("NATIVE"));
    assert.ok(res.body.resource_permissions.upload);
    assert.equal(res.body.health.service, "content");
  });

  test("rejects unauthenticated access", async () => {
    const res = await request(port, "GET", "/api/content/");
    assert.equal(res.status, 401);
  });

  test("creates content with a single-shot upload and returns it in listings", async () => {
    const created = await singleShot("api-single.txt", "hello api content");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, "available");
    const ref = created.body.content_id;

    const list = await request(port, "GET", "/api/content/?q=api-single", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);

    const detail = await request(port, "GET", `/api/content/${ref}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.content.content_id, ref);
    assert.ok(Array.isArray(detail.body.versions));
  });

  test("supports resumable chunked uploads end to end", async () => {
    const content = Buffer.from("chunked content over multiple parts");
    const session = await startSession("api-chunked.bin", content.length);
    assert.equal(session.status, 201, JSON.stringify(session.body));
    const uploadId = session.body.upload_id;

    const partA = content.subarray(0, 10);
    const partB = content.subarray(10);
    const putA = await request(port, "PUT", `/api/content/uploads/${uploadId}/parts/1`, {
      token: adminToken,
      raw: partA,
      contentType: "application/octet-stream",
    });
    assert.equal(putA.status, 200, JSON.stringify(putA.body));
    const putB = await request(port, "PUT", `/api/content/uploads/${uploadId}/parts/2`, {
      token: adminToken,
      raw: partB,
      contentType: "application/octet-stream",
    });
    assert.equal(putB.status, 200);

    const complete = await request(port, "POST", `/api/content/uploads/${uploadId}/complete`, {
      token: adminToken,
      body: {},
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.content.status, "available");
    assert.equal(complete.body.content.file_size, content.length);
  });

  test("rejects dangerous extensions at upload initiation", async () => {
    const res = await startSession("malicious.exe", 4);
    assert.equal(res.status, 415);
    assert.equal(res.body.code, "INVALID_FILE_TYPE");
  });

  test("quarantines malware and blocks its download", async () => {
    const created = await singleShot("api-virus.txt", EICAR);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "quarantined");
    const denied = await request(port, "GET", `/api/content/${created.body.content_id}/download`, { token: adminToken });
    assert.equal(denied.status, 423);
    assert.equal(denied.body.code, "CONTENT_QUARANTINED");
  });

  test("issues a signed download and streams the bytes", async () => {
    const created = await singleShot("api-download.txt", "download me");
    const info = await request(port, "GET", `/api/content/${created.body.content_id}/download`, { token: adminToken });
    assert.equal(info.status, 200);
    assert.ok(info.body.url);
    const streamed = await request(port, "GET", info.body.url, { token: adminToken });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.body, "download me");
  });

  test("check-out, status lock and check-in round trip", async () => {
    const created = await singleShot("api-lock.txt", "lockable");
    const ref = created.body.content_id;
    const checkout = await request(port, "POST", `/api/content/${ref}/checkout`, { token: adminToken, body: {} });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    assert.match(checkout.body.lock_token, /^LCK-/);

    const conflict = await request(port, "POST", `/api/content/${ref}/checkout`, { token: adminToken, body: {} });
    assert.equal(conflict.status, 423);
    assert.equal(conflict.body.code, "CONTENT_LOCKED");

    const checkin = await request(port, "POST", `/api/content/${ref}/checkin`, { token: adminToken, body: { lock_token: checkout.body.lock_token } });
    assert.equal(checkin.status, 200, JSON.stringify(checkin.body));
    assert.equal(checkin.body.content.status, "available");
  });

  test("creates and lists generic object associations", async () => {
    const created = await singleShot("api-assoc.txt", "associate");
    const association = await request(port, "POST", "/api/content/associations", {
      token: adminToken,
      body: { contentId: created.body.content_id, objectType: "BOM", objectId: "BOM-1", contentRole: "ATTACHMENT", isPrimary: true },
    });
    assert.equal(association.status, 201, JSON.stringify(association.body));
    const list = await request(port, "GET", "/api/content/objects/BOM/BOM-1/content", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 1);
  });

  test("lists renditions for a processed content item", async () => {
    const created = await singleShot("api-rendition.txt", "rendition source");
    const res = await request(port, "GET", `/api/content/${created.body.content_id}/renditions`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.items.some((item) => item.rendition_type === "PREVIEW"));
  });

  test("enforces retention and legal hold over deletion", async () => {
    const created = await singleShot("api-hold.txt", "hold me");
    const ref = created.body.content_id;
    const hold = await request(port, "POST", `/api/content/${ref}/legal-hold`, { token: adminToken, body: { reason: "Litigation" } });
    assert.equal(hold.status, 201);
    const blocked = await request(port, "DELETE", `/api/content/${ref}`, { token: adminToken });
    assert.equal(blocked.status, 423);
    const release = await request(port, "POST", `/api/content/${ref}/legal-hold/release`, { token: adminToken, body: { reason: "Closed" } });
    assert.equal(release.status, 200);
    const deleted = await request(port, "DELETE", `/api/content/${ref}`, { token: adminToken });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.status, "deleted");
  });

  test("restricts admin-only surfaces and metadata updates by permission", async () => {
    const created = await singleShot("api-perm.txt", "permission checks");
    const ref = created.body.content_id;

    const metrics = await request(port, "GET", "/api/content/metrics", { token: userToken });
    assert.equal(metrics.status, 403);

    const patch = await request(port, "PATCH", `/api/content/${ref}`, { token: userToken, body: { description: "nope" } });
    assert.equal(patch.status, 403);

    const readable = await request(port, "GET", `/api/content/${ref}`, { token: userToken });
    assert.equal(readable.status, 200);

    const adminPatch = await request(port, "PATCH", `/api/content/${ref}`, { token: adminToken, body: { description: "updated by admin" } });
    assert.equal(adminPatch.status, 200);
    assert.equal(adminPatch.body.description, "updated by admin");
  });

  test("exposes processing status and security scan history", async () => {
    const created = await singleShot("api-security.txt", "scan history");
    const processing = await request(port, "GET", `/api/content/${created.body.content_id}/processing`, { token: adminToken });
    assert.equal(processing.status, 200);
    assert.equal(processing.body.content_id, created.body.content_id);

    const security = await request(port, "GET", `/api/content/${created.body.content_id}/security`, { token: adminToken });
    assert.equal(security.status, 200);
    assert.ok(security.body.latest);
    assert.equal(security.body.latest.status, "clean");
  });

  test("records audit events for content operations", async () => {
    await singleShot("api-audit.txt", "audit trail");
    const count = queryOne(
      db,
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'content.uploaded'"
    ).c;
    assert.ok(count >= 1);
  });
});
