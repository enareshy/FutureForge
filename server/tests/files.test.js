process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as files from "../services/files.js";
import { getStorageProvider } from "../services/file-storage.js";

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

describe("Document & File Management services", () => {
  let db;
  let admin;
  let user;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = actorRow(db, "admin");
    user = actorRow(db, "j.patel");
    tenantId = admin.tenant_id ?? admin.organization_id;
  });

  after(() => {
    db?.close();
  });

  async function upload(name, content, extra = {}) {
    const init = files.initiateUpload(
      db,
      { name, size: Buffer.byteLength(content), ...extra },
      admin,
      tenantId,
      "test"
    );
    return files.completeUpload(db, init.upload.upload_id, { buffer: Buffer.from(content) }, admin, tenantId, "test");
  }

  test("single upload creates an available file with an immutable first version", async () => {
    const result = await upload("requirements.txt", "hello world");
    assert.equal(result.file.status, "available");
    assert.equal(result.file.version_count, 1);
    assert.equal(result.scan_status, "clean");
    assert.equal(result.version.version_label, "1.0");
    assert.match(result.file.file_ref, /^FILE-[A-F0-9]+$/);

    const versions = files.listVersions(db, result.file.file_ref, {}, tenantId);
    assert.equal(versions.total, 1);

    const events = files.listFileEvents(db, { fileId: result.file.id });
    const types = events.items.map((e) => e.event_type);
    assert.ok(types.includes("FileUploaded"));
    assert.ok(types.includes("FileScanCompleted"));
  });

  test("list/search/filter/sort and facets work", async () => {
    const all = files.listFiles(db, {}, admin, tenantId);
    assert.ok(all.total >= 1);
    const filtered = files.listFiles(db, { fileCategory: "text", sortBy: "name", sortDir: "asc" }, admin, tenantId);
    assert.ok(filtered.items.every((f) => f.file_category === "text"));
    const facets = files.fileFacets(db, {}, admin, tenantId);
    assert.ok(facets.total >= 1);
    assert.ok(facets.by_status.some((row) => row.key === "available"));
  });

  test("metadata can be updated and folder moves are audited", async () => {
    const { file } = await upload("draft.docx", "content");
    const folder = files.createFolder(db, { name: "Specs" }, admin, tenantId, "test");
    const updated = files.updateFileMetadata(
      db,
      file.file_ref,
      { name: "final.docx", description: "final spec", security_classification: "confidential", folder_id: folder.id },
      admin,
      tenantId,
      "test"
    );
    assert.equal(updated.file.name, "final.docx");
    assert.equal(updated.file.extension, "docx");
    assert.equal(updated.file.security_classification, "confidential");
    assert.equal(updated.file.folder_id, folder.id);
    const moved = files.moveFile(db, file.file_ref, null, admin, tenantId, "test");
    assert.equal(moved.folder_id, null);
  });

  test("versions are immutable and restoring creates a new version", async () => {
    const first = await upload("model.step", "v1");
    await getStorageProvider().putBuffer("objects/1/2026/01/r2", Buffer.from("v2"));
    const v2 = await files.createVersion(
      db,
      first.file.file_ref,
      { storage_key: "objects/1/2026/01/r2", name: "model.step", size: 2, checksum: "abc" },
      { actor: admin, tenantId, ip: "test", source: "upload" }
    );
    assert.equal(v2.version.version_label, "1.1");

    const restored = await files.restoreVersion(db, first.file.file_ref, "1.0", {}, { actor: admin, tenantId, ip: "test" });
    assert.equal(restored.version.version_label, "1.2");
    assert.equal(restored.file.version_count, 3);
    const versions = files.listVersions(db, first.file.file_ref, {}, tenantId);
    assert.equal(versions.total, 3);
    // Original version is untouched.
    const original = files.getVersion(db, first.file.file_ref, "1.0", tenantId);
    assert.equal(original.version_number, 1);
    assert.equal(original.is_current, false);
  });

  test("check-out is exclusive and check-in with content creates a version", async () => {
    const { file } = await upload("locked.txt", "locked content");
    const first = files.checkOutFile(db, file.file_ref, { reason: "editing" }, admin, tenantId, "test");
    assert.equal(first.lock.lock_type, "exclusive");

    // A second user cannot check out the same file (even with upload rights).
    assert.throws(
      () => files.checkOutFile(db, file.file_ref, {}, user, tenantId, "test"),
      (err) => err.status === 423
    );

    const before = files.listVersions(db, file.file_ref, {}, tenantId).total;
    const checkedIn = await files.checkInFile(
      db,
      file.file_ref,
      { buffer: Buffer.from("locked content v2"), checkin_comment: "save" },
      admin,
      tenantId,
      "test"
    );
    assert.equal(checkedIn.checked_in, true);
    assert.equal(checkedIn.version.version_label, "1.1");
    assert.equal(files.listVersions(db, file.file_ref, {}, tenantId).total, before + 1);
    assert.equal(files.getLock(db, file.file_ref, admin, tenantId).lock, null);
  });

  test("force release removes another user's lock", async () => {
    const { file } = await upload("shared.txt", "shared");
    files.checkOutFile(db, file.file_ref, {}, user, tenantId, "test");
    const released = files.forceReleaseLock(db, file.file_ref, { reason: "admin override" }, admin, tenantId, "test");
    assert.equal(released.released, true);
    assert.equal(released.forced, true);
    assert.equal(files.getLock(db, file.file_ref, admin, tenantId).lock, null);
  });

  test("associations are created once and can be removed", async () => {
    const { file } = await upload("assoc.txt", "assoc");
    const created = files.createAssociation(
      db,
      file.file_ref,
      { business_object_type: "product_revision", business_object_id: "PR-100", relationship_type: "specification" },
      admin,
      tenantId,
      "test"
    );
    assert.ok(created.association.id);
    const duplicate = files.createAssociation(
      db,
      file.file_ref,
      { business_object_type: "product_revision", business_object_id: "PR-100", relationship_type: "specification" },
      admin,
      tenantId,
      "test"
    );
    assert.equal(duplicate.already_exists, true);
    const byObject = files.listObjectAssociations(
      db,
      { businessObjectType: "product_revision", businessObjectId: "PR-100" },
      admin,
      tenantId
    );
    assert.equal(byObject.total, 1);
    const removed = files.removeAssociation(db, created.association.id, admin, tenantId, "test");
    assert.equal(removed.removed, true);
  });

  test("collections group files without duplicating bytes", async () => {
    const { file } = await upload("collect.txt", "collect");
    const collection = files.createCollection(db, { name: "Release Docs" }, admin, tenantId, "test");
    const added = files.addCollectionMembers(db, collection.id, [file.id], admin, tenantId, "test");
    assert.equal(added.added_count, 1);
    const detail = files.getCollection(db, collection.code, admin, tenantId);
    assert.equal(detail.total, 1);
    assert.equal(detail.items[0].id, file.id);
    assert.equal(files.listCollectionsForFile(db, file.id, admin, tenantId).total, 1);
    files.removeCollectionMember(db, collection.id, file.id, admin, tenantId, "test");
    assert.equal(files.listCollectionsForFile(db, file.id, admin, tenantId).total, 0);
  });

  test("file ACL denies win and allows grant access", async () => {
    const { file } = await upload("acl.txt", "acl");
    const row = files.getFile(db, file.file_ref, admin, tenantId).file;
    // Baseline: reader role grants tenant-wide metadata read.
    assert.equal(files.canAccess(db, row, user, "view_metadata", { tenantId }).valueOf(), true);

    const deny = files.grantPermission(
      db,
      { resource_type: "file", resource_id: file.id, principal_type: "user", principal_id: user.id, permission: "view_metadata", effect: "deny" },
      admin,
      tenantId,
      "test"
    );
    assert.equal(files.canAccess(db, row, user, "view_metadata", { tenantId }), false);
    files.revokePermission(db, deny.id, admin, tenantId, "test");

    const allow = files.grantPermission(
      db,
      { resource_type: "file", resource_id: file.id, principal_type: "user", principal_id: user.id, permission: "view_metadata", effect: "allow" },
      admin,
      tenantId,
      "test"
    );
    assert.equal(files.canAccess(db, row, user, "view_metadata", { tenantId }), true);
    // Download still requires the details permission.
    assert.equal(files.canAccess(db, row, user, "manage_permissions", { tenantId }), false);
    files.revokePermission(db, allow.id, admin, tenantId, "test");
  });

  test("restricted files are not visible to non-owners without an explicit grant", async () => {
    const { file } = await upload("secret.txt", "secret", { security_classification: "restricted" });
    const row = files.getFile(db, file.file_ref, admin, tenantId).file;
    assert.equal(files.canAccess(db, row, user, "view_metadata", { tenantId }), false);
  });

  test("multipart uploads finalize from staged chunks", async () => {
    const init = files.initiateUpload(
      db,
      { name: "large.bin", size: 10, upload_mode: "multipart" },
      admin,
      tenantId,
      "test"
    );
    assert.ok(init.total_chunks >= 1);
    await files.uploadChunk(db, init.upload.upload_id, 0, Buffer.from("0123456789"), admin, tenantId);
    const done = await files.completeUpload(db, init.upload.upload_id, {}, admin, tenantId, "test");
    assert.equal(done.file.status, "available");
    assert.equal(done.file.size_bytes, 10);
  });

  test("uploads support idempotency keys and abort", async () => {
    const first = files.initiateUpload(db, { name: "idem.txt", size: 3, idempotency_key: "key-1" }, admin, tenantId, "test");
    const second = files.initiateUpload(db, { name: "idem.txt", size: 3, idempotency_key: "key-1" }, admin, tenantId, "test");
    assert.equal(first.upload.upload_id, second.upload.upload_id);
    assert.equal(second.existing, true);

    const aborted = files.initiateUpload(db, { name: "abort.txt", size: 3 }, admin, tenantId, "test");
    const result = files.abortUpload(db, aborted.upload.upload_id, {}, admin, tenantId, "test");
    assert.equal(result.aborted, true);
  });

  test("files soft-delete and restore, and metrics reflect state", async () => {
    const { file } = await upload("lifecycle.txt", "lifecycle");
    const deleted = files.deleteFile(db, file.file_ref, { reason: "obsolete" }, admin, tenantId, "test");
    assert.equal(deleted.deleted, true);
    assert.equal(files.listFiles(db, {}, admin, tenantId).items.some((f) => f.id === file.id), false);
    assert.equal(files.listFiles(db, { includeDeleted: "true" }, admin, tenantId).items.some((f) => f.id === file.id), true);
    const restored = files.restoreFile(db, file.file_ref, admin, tenantId, "test");
    assert.equal(restored.restored, true);

    const metrics = files.fileMetrics(db, admin, tenantId);
    assert.ok(metrics.totals.files >= 1);
    assert.ok(Array.isArray(metrics.by_status));
  });

  test("processing status is visible and can be requeued", async () => {
    const { file } = await upload("process.txt", "process");
    const status = files.getProcessingStatus(db, file.file_ref, admin, tenantId);
    assert.equal(status.overall_status, "available");
    assert.ok(status.items.some((item) => item.processing_type === "virus_scan"));
    const requeued = await files.requeueProcessing(db, file.file_ref, "virus_scan", admin, tenantId, "test");
    assert.equal(requeued.scan_status, "clean");
  });

  test("folder tree, breadcrumb and file listing are consistent", async () => {
    const parent = files.createFolder(db, { name: "Projects" }, admin, tenantId, "test");
    const child = files.createFolder(db, { name: "Designs", parent_id: parent.id }, admin, tenantId, "test");
    assert.equal(child.path, "/Projects/Designs");
    const crumbs = files.folderBreadcrumb(db, child.id, tenantId);
    assert.equal(crumbs.items.length, 2);
    const tree = files.folderTree(db, tenantId);
    const node = tree.items.find((f) => f.id === parent.id);
    assert.ok(node);
    assert.equal(node.children.length, 1);
  });

  test("signed download descriptors never expose physical paths", async () => {
    const { file } = await upload("download.txt", "download");
    const dl = files.versionDownload(db, file.file_ref, null, admin, tenantId);
    assert.ok(dl.descriptor.key.startsWith("objects/"));
    assert.equal(dl.descriptor.filename, "download.txt");
    // A different tenant cannot resolve the file.
    assert.throws(() => files.getFile(db, file.file_ref, admin, 99999));
  });
});
