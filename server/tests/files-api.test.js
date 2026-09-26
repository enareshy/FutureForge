process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { registerFileProcessingHandlers } from "../services/files.js";
import { getStorageProvider } from "../services/file-storage.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, raw, contentType, binary } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
    const payloadBuffer = payload;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payloadBuffer
            ? { "Content-Type": contentType || "application/json", "Content-Length": Buffer.byteLength(payloadBuffer) }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (binary) return resolve({ status: res.statusCode, buffer, headers: res.headers });
          const data = buffer.toString("utf8");
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payloadBuffer) req.write(payloadBuffer);
    req.end();
  });
}

describe("Document & File Management REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let userToken;
  let adminId;
  let userId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    registerFileProcessingHandlers();
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminId = queryOne(db, "SELECT id FROM users WHERE username = 'admin'").id;
    userId = queryOne(db, "SELECT id FROM users WHERE username = 'j.patel'").id;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  async function upload(name, content, token = adminToken, path = "/api/files/upload") {
    const res = await request(port, "POST", `${path}?name=${encodeURIComponent(name)}`, {
      token,
      raw: Buffer.from(content),
      contentType: "text/plain",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  test("meta exposes vocabulary and sortable fields", async () => {
    const res = await request(port, "GET", "/api/files/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.file_statuses.includes("available"));
    assert.ok(res.body.permissions.includes("manage_permissions"));
    assert.ok(res.body.sortable.includes("name"));
  });

  test("upload, list, get and search", async () => {
    const uploaded = await upload("api-notes.txt", "hello api");
    assert.equal(uploaded.file.status, "available");
    assert.equal(uploaded.scan_status, "clean");
    const ref = uploaded.file.file_ref;

    const list = await request(port, "GET", "/api/files?q=api-notes", { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);

    const detail = await request(port, "GET", `/api/files/${ref}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.file.file_ref, ref);
    assert.ok(Array.isArray(detail.body.effective_permissions.allowed));
  });

  test("signed download streams content and rejects tampered tokens", async () => {
    const uploaded = await upload("download-me.txt", "download body");
    const ref = uploaded.file.file_ref;

    const desc = await request(port, "GET", `/api/files/${ref}/download`, { token: adminToken });
    assert.equal(desc.status, 200);
    assert.ok(desc.body.download_url.startsWith("/api/files/download/"));
    assert.equal(desc.body.descriptor, undefined);
    assert.equal(desc.body.filename, "download-me.txt");

    const got = await request(port, "GET", desc.body.download_url, { token: adminToken, binary: true });
    assert.equal(got.status, 200);
    assert.equal(got.buffer.toString("utf8"), "download body");

    const unauth = await request(port, "GET", desc.body.download_url, { binary: true });
    assert.equal(unauth.status, 401);

    const tampered = `${desc.body.download_url.slice(0, -2)}xy`;
    const bad = await request(port, "GET", tampered, { token: adminToken, binary: true });
    assert.equal(bad.status, 403);
  });

  test("version listing/creation/restore via API", async () => {
    const uploaded = await upload("versioned.txt", "v1");
    const ref = uploaded.file.file_ref;
    const key = "objects/1/2026/01/api-version-2";
    await getStorageProvider().putBuffer(key, Buffer.from("v2"));
    const created = await request(port, "POST", `/api/files/${ref}/versions`, {
      token: adminToken,
      body: { storage_key: key, name: "versioned.txt", size: 2 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.version.version_label, "1.1");

    const versions = await request(port, "GET", `/api/files/${ref}/versions`, { token: adminToken });
    assert.equal(versions.body.total, 2);

    const first = versions.body.items.find((v) => v.version_label === "1.0");
    const restored = await request(port, "POST", `/api/files/${ref}/versions/${first.version_number}/restore`, {
      token: adminToken,
      body: {},
    });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.version.version_label, "1.2");
    assert.equal(restored.body.file.version_count, 3);
  });

  test("uploading a revision through an upload session creates a new version", async () => {
    const uploaded = await upload("revision.txt", "rev1");
    const ref = uploaded.file.file_ref;

    const init = await request(port, "POST", "/api/files/uploads", {
      token: adminToken,
      body: { file_id: ref, name: "revision.txt", size: 4, mime_type: "text/plain" },
    });
    assert.equal(init.status, 201, JSON.stringify(init.body));
    assert.equal(init.body.upload.upload_mode, "single");
    const id = init.body.upload.upload_id;

    const done = await request(port, "POST", `/api/files/uploads/${id}/complete`, {
      token: adminToken,
      raw: Buffer.from("rev2"),
      contentType: "text/plain",
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.file.file_ref, ref);
    assert.equal(done.body.file.version_count, 2);
    assert.equal(done.body.version.version_label, "1.1");

    const versions = await request(port, "GET", `/api/files/${ref}/versions`, { token: adminToken });
    assert.equal(versions.body.total, 2);
  });

  test("check-out, check-in and force release endpoints", async () => {
    const uploaded = await upload("lock-api.txt", "lock");
    const ref = uploaded.file.file_ref;

    const checkout = await request(port, "POST", `/api/files/${ref}/checkout`, { token: adminToken, body: { reason: "edit" } });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.lock.lock_type, "exclusive");

    const blocked = await request(port, "POST", `/api/files/${ref}/checkout`, { token: userToken, body: {} });
    assert.equal(blocked.status, 423);

    const lock = await request(port, "GET", `/api/files/${ref}/lock`, { token: adminToken });
    assert.equal(lock.body.lock.file_id, uploaded.file.id);

    const release = await request(port, "POST", `/api/files/${ref}/lock/force-release`, { token: adminToken, body: { reason: "test" } });
    assert.equal(release.body.forced, true);
  });

  test("associations, collections and folders endpoints", async () => {
    const uploaded = await upload("related.txt", "related");
    const ref = uploaded.file.file_ref;

    const assoc = await request(port, "POST", `/api/files/${ref}/associations`, {
      token: adminToken,
      body: { business_object_type: "change_notice", business_object_id: "CN-7", relationship_type: "evidence" },
    });
    assert.equal(assoc.status, 201);
    const byObject = await request(port, "GET", "/api/file-associations?businessObjectType=change_notice&businessObjectId=CN-7", { token: adminToken });
    assert.equal(byObject.body.total, 1);

    const collection = await request(port, "POST", "/api/file-collections", { token: adminToken, body: { name: "API Collection" } });
    assert.equal(collection.status, 201);
    const member = await request(port, "POST", `/api/file-collections/${collection.body.id}/members`, {
      token: adminToken,
      body: { file_ids: [uploaded.file.id] },
    });
    assert.equal(member.body.added_count, 1);

    const folder = await request(port, "POST", "/api/folders", { token: adminToken, body: { name: "API Docs" } });
    assert.equal(folder.status, 201);
    const moved = await request(port, "POST", `/api/folders/${folder.body.id}/files`, {
      token: adminToken,
      body: { file_ids: [uploaded.file.id] },
    });
    assert.equal(moved.body.moved_count, 1);
    const listing = await request(port, "GET", `/api/folders/${folder.body.id}/files`, { token: adminToken });
    assert.equal(listing.body.total, 1);
    const crumbs = await request(port, "GET", `/api/folders/${folder.body.id}/breadcrumb`, { token: adminToken });
    assert.equal(crumbs.body.items.length, 1);
  });

  test("permissions administration is admin-only", async () => {
    const uploaded = await upload("acl-api.txt", "acl");
    const ref = uploaded.file.file_ref;

    const denied = await request(port, "GET", "/api/files/permissions", { token: userToken });
    assert.equal(denied.status, 403);

    const grant = await request(port, "POST", "/api/files/permissions", {
      token: adminToken,
      body: { resource_type: "file", resource_id: uploaded.file.id, principal_type: "user", principal_id: userId, permission: "view_metadata", effect: "allow" },
    });
    assert.equal(grant.status, 201);
    const list = await request(port, "GET", `/api/files/${ref}/permissions`, { token: adminToken });
    assert.equal(list.body.total, 1);
    const revoke = await request(port, "DELETE", `/api/files/permissions/${grant.body.id}`, { token: adminToken });
    assert.equal(revoke.body.revoked, true);
  });

  test("delete, restore, metrics, facets and processing endpoints", async () => {
    const uploaded = await upload("lifecycle-api.txt", "lifecycle");
    const ref = uploaded.file.file_ref;

    const processing = await request(port, "GET", `/api/files/${ref}/processing`, { token: adminToken });
    assert.equal(processing.status, 200);
    assert.equal(processing.body.overall_status, "available");

    const deleted = await request(port, "DELETE", `/api/files/${ref}`, { token: adminToken, body: { reason: "test" } });
    assert.equal(deleted.body.deleted, true);
    const restored = await request(port, "POST", `/api/files/${ref}/restore`, { token: adminToken });
    assert.equal(restored.body.restored, true);

    const metrics = await request(port, "GET", "/api/files/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.totals.files >= 1);
    const facets = await request(port, "GET", "/api/files/facets", { token: adminToken });
    assert.ok(facets.body.total >= 1);
    const events = await request(port, "GET", "/api/files/events", { token: adminToken });
    assert.ok(events.body.total >= 1);
  });

  test("chunked upload through the API", async () => {
    const init = await request(port, "POST", "/api/files/uploads", {
      token: adminToken,
      body: { name: "chunked.bin", size: 8, upload_mode: "multipart" },
    });
    assert.equal(init.status, 201);
    const chunk = await request(port, "PUT", `/api/files/uploads/${init.body.upload.upload_id}/chunks/0`, {
      token: adminToken,
      raw: Buffer.from("chunked!"),
      contentType: "application/octet-stream",
    });
    assert.equal(chunk.status, 200);
    const complete = await request(port, "POST", `/api/files/uploads/${init.body.upload.upload_id}/complete`, {
      token: adminToken,
      body: {},
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.file.size_bytes, 8);
  });

  test("regular user can upload and browse but not modify permissions", async () => {
    const uploaded = await upload("user-api.txt", "user content", userToken);
    assert.equal(uploaded.file.status, "available");
    const list = await request(port, "GET", "/api/files", { token: userToken });
    assert.equal(list.status, 200);
    const forbidden = await request(port, "POST", "/api/files/permissions", { token: userToken, body: {} });
    assert.equal(forbidden.status, 403);
  });

  test("file processing job types are registered", async () => {
    const types = await request(port, "GET", "/api/job-types?source_module=files", { token: adminToken });
    assert.equal(types.status, 200);
    const codes = types.body.items.map((t) => t.code);
    assert.ok(codes.includes("FILE_VIRUS_SCAN"));
    assert.ok(codes.includes("FILE_PREVIEW_GENERATION"));
  });
});
