process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

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
          ...(payload
            ? { "Content-Type": contentType || "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("async folder writes", () => {
  let database;
  let server;
  let port;
  let token;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  test("create folder audits through the async layer", async () => {
    const created = await request(port, "POST", "/api/folders", { token, body: { name: "Async Docs" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Async Docs");
    const id = created.body.id;

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.folder.create' AND resource_id = ?",
      [String(id)]
    );
    assert.ok(audit, "files.folder.create is audited");

    const duplicate = await request(port, "POST", "/api/folders", { token, body: { name: "Async Docs" } });
    assert.equal(duplicate.status, 409);
  });

  test("rename, move a file in and remove it", async () => {
    const folder = await request(port, "POST", "/api/folders", { token, body: { name: "Async Work" } });
    assert.equal(folder.status, 201);
    const id = folder.body.id;

    const renamed = await request(port, "PUT", `/api/folders/${id}`, { token, body: { name: "Async Work v2" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Async Work v2");

    const uploaded = await request(port, "POST", `/api/files/upload?name=async-folder.txt`, {
      token,
      raw: Buffer.from("hello"),
      contentType: "text/plain",
    });
    assert.equal(uploaded.status, 201);
    const fileId = uploaded.body.file.id;

    const moved = await request(port, "POST", `/api/folders/${id}/files`, { token, body: { file_ids: [fileId] } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.moved_count, 1);

    const listing = await request(port, "GET", `/api/folders/${id}/files`, { token });
    assert.equal(listing.status, 200);
    assert.equal(listing.body.total, 1);

    const removed = await request(port, "DELETE", `/api/folders/${id}/files/${fileId}`, { token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
  });

  test("delete enforces emptiness then force cascades, restore reverses", async () => {
    const folder = await request(port, "POST", "/api/folders", { token, body: { name: "Async Cascade" } });
    assert.equal(folder.status, 201);
    const id = folder.body.id;

    const child = await request(port, "POST", "/api/folders", { token, body: { name: "Async Child", parent_id: id } });
    assert.equal(child.status, 201);

    const blocked = await request(port, "DELETE", `/api/folders/${id}`, { token });
    assert.equal(blocked.status, 409);

    const forced = await request(port, "DELETE", `/api/folders/${id}?force=true`, { token });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.deleted, true);
    assert.equal(forced.body.cascade_children, 1);

    const restored = await request(port, "POST", `/api/folders/${id}/restore`, { token });
    assert.equal(restored.status, 200);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.folder.restore' AND resource_id = ?",
      [String(id)]
    );
    assert.ok(audit, "files.folder.restore is audited");
  });
});

describe("async file core writes", () => {
  let database;
  let server;
  let port;
  let token;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  async function upload(name, content = "hello") {
    const uploaded = await request(port, "POST", `/api/files/upload?name=${name}`, {
      token,
      raw: Buffer.from(content),
      contentType: "text/plain",
    });
    assert.equal(uploaded.status, 201);
    return uploaded.body.file;
  }

  test("update metadata writes audit and a published file event", async () => {
    const file = await upload("async-metadata.txt");
    const updated = await request(port, "PUT", `/api/files/${file.file_ref}`, {
      token,
      body: { description: "async metadata", security_classification: "internal" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.file.description, "async metadata");
    assert.ok(updated.body.changed.includes("description"));

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.metadata.update' AND resource_id = ?",
      [String(file.id)]
    );
    assert.ok(audit, "files.metadata.update is audited");

    const event = queryOne(
      database,
      "SELECT * FROM file_events WHERE file_id = ? AND event_type = 'FileMetadataUpdated'",
      [file.id]
    );
    assert.ok(event, "FileMetadataUpdated is recorded");
    assert.equal(event.status, "published");
  });

  test("move goes through the async layer and audits", async () => {
    const file = await upload("async-move.txt");
    const folder = await request(port, "POST", "/api/folders", { token, body: { name: "Async Move Target" } });
    assert.equal(folder.status, 201);

    const moved = await request(port, "POST", `/api/files/${file.file_ref}/move`, {
      token,
      body: { folder_id: folder.body.id },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.folder_id, folder.body.id);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.move' AND resource_id = ?",
      [String(file.id)]
    );
    assert.ok(audit, "files.move is audited");
  });

  test("delete then restore reverses the lifecycle on the async layer", async () => {
    const file = await upload("async-delete.txt");

    const deleted = await request(port, "DELETE", `/api/files/${file.file_ref}`, { token, body: { reason: "test" } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const deletedRow = queryOne(database, "SELECT * FROM files WHERE id = ?", [file.id]);
    assert.ok(deletedRow.deleted_at, "file is soft deleted");

    const deleteAudit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.delete' AND resource_id = ?",
      [String(file.id)]
    );
    assert.ok(deleteAudit, "files.delete is audited");

    const restored = await request(port, "POST", `/api/files/${file.file_ref}/restore`, { token });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.restored, true);
    const restoredRow = queryOne(database, "SELECT * FROM files WHERE id = ?", [file.id]);
    assert.equal(restoredRow.deleted_at, null);

    const restoreAudit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.restore' AND resource_id = ?",
      [String(file.id)]
    );
    assert.ok(restoreAudit, "files.restore is audited");
  });
});

describe("async file ancillary writes", () => {
  let database;
  let server;
  let port;
  let token;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  async function upload(name, content = "hello") {
    const uploaded = await request(port, "POST", `/api/files/upload?name=${name}`, {
      token,
      raw: Buffer.from(content),
      contentType: "text/plain",
    });
    assert.equal(uploaded.status, 201);
    return uploaded.body.file;
  }

  test("upload sessions initiate, list, get and abort", async () => {
    const initiated = await request(port, "POST", "/api/files/uploads", {
      token,
      body: { name: "async-session.bin", size: 5, mime_type: "application/octet-stream" },
    });
    assert.equal(initiated.status, 201);
    const uploadId = initiated.body.upload.upload_id;

    const fetched = await request(port, "GET", `/api/files/uploads/${uploadId}`, { token });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.upload.upload_id, uploadId);

    const listed = await request(port, "GET", "/api/files/uploads?active=true", { token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((u) => u.upload_id === uploadId), "session appears in the active list");

    const aborted = await request(port, "POST", `/api/files/uploads/${uploadId}/abort`, { token, body: { reason: "test" } });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.aborted, true);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.upload.abort' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(audit, "files.upload.abort is audited");
  });

  test("versions create, list, fetch and restore through the async layer", async () => {
    const file = await upload("async-version.txt");
    const storageKey = queryOne(database, "SELECT storage_key FROM files WHERE id = ?", [file.id]).storage_key;

    const created = await request(port, "POST", `/api/files/${file.file_ref}/versions`, {
      token,
      body: { checkin_comment: "async version", size: 5, checksum: "", storage_key: storageKey },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.version, "a version is returned");

    const versions = await request(port, "GET", `/api/files/${file.file_ref}/versions`, { token });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.items.length >= 1, "version list is populated");

    const versionNumber = versions.body.items[0].version_number;
    const fetched = await request(port, "GET", `/api/files/${file.file_ref}/versions/${versionNumber}`, { token });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.version_number, versionNumber);
  });

  test("checkout then release a lock", async () => {
    const file = await upload("async-lock.txt");

    const checkout = await request(port, "POST", `/api/files/${file.file_ref}/checkout`, { token, body: {} });
    assert.equal(checkout.status, 201);

    const lock = await request(port, "GET", `/api/files/${file.file_ref}/lock`, { token });
    assert.equal(lock.status, 200);
    assert.ok(lock.body.lock, "lock is visible after checkout");

    const released = await request(port, "POST", `/api/files/${file.file_ref}/lock/release`, { token, body: {} });
    assert.equal(released.status, 200);

    const after = await request(port, "GET", `/api/files/${file.file_ref}/lock`, { token });
    assert.equal(after.status, 200);
    assert.equal(after.body.lock, null);

    const locks = await request(port, "GET", "/api/file-locks", { token });
    assert.equal(locks.status, 200);
  });

  test("permissions grant, list and revoke", async () => {
    const file = await upload("async-acl.txt");

    const granted = await request(port, "POST", "/api/files/permissions", {
      token,
      body: { resource_type: "file", resource_id: file.id, principal_type: "tenant", permission: "download", effect: "allow" },
    });
    assert.equal(granted.status, 201);

    const listed = await request(port, "GET", `/api/files/permissions?resourceType=file&resourceId=${file.id}`, { token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((p) => p.id === granted.body.id), "grant appears in the list");

    const revoked = await request(port, "DELETE", `/api/files/permissions/${granted.body.id}`, { token });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
  });

  test("associations create, list by file and remove", async () => {
    const file = await upload("async-assoc.txt");

    const created = await request(port, "POST", `/api/files/${file.file_ref}/associations`, {
      token,
      body: { business_object_type: "part", business_object_id: "PN-1", relationship_type: "attachment" },
    });
    assert.equal(created.status, 201);

    const listed = await request(port, "GET", `/api/files/${file.file_ref}/associations`, { token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.length >= 1, "association is listed for the file");

    const removed = await request(port, "DELETE", `/api/file-associations/${created.body.association.id}`, { token });
    assert.equal(removed.status, 200);
  });

  test("collections create, add members, list for file and delete", async () => {
    const file = await upload("async-collection.txt");

    const collection = await request(port, "POST", "/api/file-collections", {
      token,
      body: { name: "Async Collection", description: "async" },
    });
    assert.equal(collection.status, 201);
    const collectionId = collection.body.id;

    const added = await request(port, "POST", `/api/file-collections/${collectionId}/members`, {
      token,
      body: { file_ids: [file.id] },
    });
    assert.equal(added.status, 200);

    const forFile = await request(port, "GET", `/api/files/${file.file_ref}/collections`, { token });
    assert.equal(forFile.status, 200);
    assert.ok(forFile.body.items.some((c) => c.id === collectionId), "file reports its collection");

    const removed = await request(port, "DELETE", `/api/file-collections/${collectionId}/members/${file.id}`, { token });
    assert.equal(removed.status, 200);

    const deleted = await request(port, "DELETE", `/api/file-collections/${collectionId}`, { token });
    assert.equal(deleted.status, 200);
  });

  test("processing status and requeue go through the async layer", async () => {
    const file = await upload("async-processing.txt");

    const status = await request(port, "GET", `/api/files/${file.file_ref}/processing`, { token });
    assert.equal(status.status, 200);

    const requeued = await request(port, "POST", `/api/files/${file.file_ref}/processing/requeue`, {
      token,
      body: { type: "virus_scan" },
    });
    assert.equal(requeued.status, 200);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'files.processing.requeue' AND resource_id = ?",
      [String(file.id)]
    );
    assert.ok(audit, "files.processing.requeue is audited");
  });
});
