import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync, transactionAsync } from "../../db-async.js";
import { HttpError, pagination, validateCode } from "../../validation.js";
import { assertTenantScope, assertTenantScopeAsync } from "../tenants.js";
import { publicCollection, publicFile, assertTenant } from "./repository.js";
import { assertAccess, assertAccessAsync } from "./permissions.js";
import { auditFile, auditFileAsync } from "./events.js";
import { sanitizeFilename } from "./validation.js";

// Logical file collections / saved sets. Membership references files and never
// duplicates bytes; a file may belong to many collections.

function findCollectionRow(db, reference, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM file_collections WHERE id = ? OR code = ?",
    [Number(reference) || -1, String(reference || "")]
  );
  if (!row || row.deleted_at) throw new HttpError(404, "Collection not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Collection not found");
  }
  return row;
}

function memberCount(db, collectionId) {
  return queryOne(db, "SELECT COUNT(*) AS c FROM file_collection_members WHERE collection_id = ?", [collectionId]).c;
}

export function listCollections(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["c.tenant_id = ?", "c.deleted_at IS NULL"];
  const params = [scope];
  if (query.q) { where.push("(c.name ILIKE ? OR c.code ILIKE ? OR c.description ILIKE ?)"); params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
  if (query.ownerId || query.owner_id) { where.push("c.owner_id = ?"); params.push(Number(query.ownerId ?? query.owner_id)); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = queryAll(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM file_collection_members m WHERE m.collection_id = c.id) AS member_count
     FROM file_collections c ${clause} ORDER BY lower(c.name) LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => publicCollection(row, { memberCount: row.member_count }));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM file_collections c ${clause}`, params).c;
  return { items, total, page, pageSize };
}

export function getCollection(db, reference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const row = findCollectionRow(db, reference, scope);
  assertAccess(db, row, actor, "view_metadata", { tenantId: scope });
  const members = queryAll(
    db,
    `SELECT f.*, m.display_order, m.created_at AS added_at
     FROM file_collection_members m JOIN files f ON f.id = m.file_id
     WHERE m.collection_id = ? AND f.deleted_at IS NULL
     ORDER BY m.display_order, m.created_at`,
    [row.id]
  ).map((member) => ({ ...publicFile(member), display_order: member.display_order, added_at: member.added_at }));
  return { collection: publicCollection(row, { memberCount: members.length }), items: members, total: members.length };
}

export function createCollection(db, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const name = sanitizeFilename(body.name, { fallback: "" });
  if (!name) throw new HttpError(400, "Collection name is required");
  const code = String(body.code || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "collection").slice(0, 64);
  validateCode(code, "Collection code");
  const clash = queryOne(db, "SELECT id FROM file_collections WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL", [scope, code]);
  if (clash) throw new HttpError(409, "A collection with that code already exists");
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO file_collections
      (code, name, description, owner_id, tenant_id, organization_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, String(body.description || "").slice(0, 2000), body.owner_id ?? actor?.id ?? null, scope,
      body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = findCollectionRow(db, insert.lastInsertId, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.collection.create",
    objectType: "collection", objectId: row.id, objectName: row.name, details: { code }, ip,
  });
  return publicCollection(row, { memberCount: 0 });
}

export function updateCollection(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findCollectionRow(db, reference, scope);
  assertAccess(db, row, actor, "manage_folder", { tenantId: scope });
  const patch = {};
  if (body.name !== undefined) {
    const name = sanitizeFilename(body.name, { fallback: "" });
    if (!name) throw new HttpError(400, "Collection name is required");
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = String(body.description || "").slice(0, 2000);
  if (body.owner_id !== undefined || body.ownerId !== undefined) patch.owner_id = (body.owner_id ?? body.ownerId) || null;
  if (!Object.keys(patch).length) return publicCollection(row, { memberCount: memberCount(db, row.id) });
  patch.updated_by = actor?.id ?? null;
  patch.updated_at = nowIso();
  run(db, `UPDATE file_collections SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...Object.values(patch), row.id]);
  const next = findCollectionRow(db, row.id, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.collection.update",
    objectType: "collection", objectId: next.id, objectName: next.name, details: { changed_fields: Object.keys(patch) }, ip,
  });
  return publicCollection(next, { memberCount: memberCount(db, next.id) });
}

export function deleteCollection(db, reference, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findCollectionRow(db, reference, scope);
  assertAccess(db, row, actor, "manage_folder", { tenantId: scope });
  run(db, "UPDATE file_collections SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    nowIso(), actor?.id ?? null, nowIso(), row.id,
  ]);
  auditFile(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.collection.delete",
    objectType: "collection", objectId: row.id, objectName: row.name, ip,
  });
  return { deleted: true, id: row.id };
}

export function addCollectionMembers(db, reference, fileIds, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const collection = findCollectionRow(db, reference, scope);
  assertAccess(db, collection, actor, "associate", { tenantId: scope });
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds]).map((v) => Number(v)).filter((n) => n > 0))];
  if (!ids.length) throw new HttpError(400, "fileIds must be a non-empty array");
  return transaction(db, () => {
    const ts = nowIso();
    const added = [];
    for (const id of ids) {
      const file = queryOne(db, "SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", [id, scope]);
      if (!file) continue;
      const exists = queryOne(db, "SELECT 1 AS x FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
      if (exists) continue;
      run(db, "INSERT INTO file_collection_members (collection_id, file_id, display_order, added_by, created_at) VALUES (?, ?, ?, ?, ?)", [
        collection.id, id, added.length, actor?.id ?? null, ts,
      ]);
      added.push(id);
    }
    auditFile(db, {
      actor, tenantId: scope, organizationId: collection.organization_id, action: "files.collection.add_members",
      objectType: "collection", objectId: collection.id, objectName: collection.name, details: { added }, ip,
    });
    return { added, added_count: added.length, collection_id: collection.id };
  });
}

export function removeCollectionMember(db, reference, fileId, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const collection = findCollectionRow(db, reference, scope);
  assertAccess(db, collection, actor, "remove_association", { tenantId: scope });
  const id = Number(fileId);
  const exists = queryOne(db, "SELECT 1 AS x FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
  if (!exists) throw new HttpError(404, "File is not a member of this collection");
  run(db, "DELETE FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
  auditFile(db, {
    actor, tenantId: scope, organizationId: collection.organization_id, action: "files.collection.remove_member",
    objectType: "collection", objectId: collection.id, objectName: collection.name, details: { file_id: id }, ip,
  });
  return { removed: true, file_id: id, collection_id: collection.id };
}

export function listCollectionsForFile(db, fileId, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const items = queryAll(
    db,
    `SELECT c.* FROM file_collections c
     JOIN file_collection_members m ON m.collection_id = c.id
     WHERE m.file_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
     ORDER BY lower(c.name)`,
    [Number(fileId) || -1, scope]
  ).map((row) => publicCollection(row));
  return { items, total: items.length };
}

export { memberCount };

// ── Asynchronous twins ──

async function findCollectionRowAsync(db, reference, tenantId = null) {
  const row = await queryOneAsync(
    db,
    "SELECT * FROM file_collections WHERE id = ? OR code = ?",
    [Number(reference) || -1, String(reference || "")]
  );
  if (!row || row.deleted_at) throw new HttpError(404, "Collection not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Collection not found");
  }
  return row;
}

async function memberCountAsync(db, collectionId) {
  return (await queryOneAsync(db, "SELECT COUNT(*) AS c FROM file_collection_members WHERE collection_id = ?", [collectionId])).c;
}

export async function listCollectionsAsync(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["c.tenant_id = ?", "c.deleted_at IS NULL"];
  const params = [scope];
  if (query.q) { where.push("(c.name ILIKE ? OR c.code ILIKE ? OR c.description ILIKE ?)"); params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
  if (query.ownerId || query.owner_id) { where.push("c.owner_id = ?"); params.push(Number(query.ownerId ?? query.owner_id)); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = (
    await queryAllAsync(
      db,
      `SELECT c.*, (SELECT COUNT(*) FROM file_collection_members m WHERE m.collection_id = c.id) AS member_count
       FROM file_collections c ${clause} ORDER BY lower(c.name) LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    )
  ).map((row) => publicCollection(row, { memberCount: row.member_count }));
  const total = (await queryOneAsync(db, `SELECT COUNT(*) AS c FROM file_collections c ${clause}`, params)).c;
  return { items, total, page, pageSize };
}

export async function getCollectionAsync(db, reference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const row = await findCollectionRowAsync(db, reference, scope);
  await assertAccessAsync(db, row, actor, "view_metadata", { tenantId: scope });
  const members = (
    await queryAllAsync(
      db,
      `SELECT f.*, m.display_order, m.created_at AS added_at
       FROM file_collection_members m JOIN files f ON f.id = m.file_id
       WHERE m.collection_id = ? AND f.deleted_at IS NULL
       ORDER BY m.display_order, m.created_at`,
      [row.id]
    )
  ).map((member) => ({ ...publicFile(member), display_order: member.display_order, added_at: member.added_at }));
  return { collection: publicCollection(row, { memberCount: members.length }), items: members, total: members.length };
}

export async function createCollectionAsync(db, body = {}, actor, tenantId, ip) {
  const scope = await assertTenantScopeAsync(db, actor, assertTenant(tenantId));
  const name = sanitizeFilename(body.name, { fallback: "" });
  if (!name) throw new HttpError(400, "Collection name is required");
  const code = String(body.code || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "collection").slice(0, 64);
  validateCode(code, "Collection code");
  const clash = await queryOneAsync(db, "SELECT id FROM file_collections WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL", [scope, code]);
  if (clash) throw new HttpError(409, "A collection with that code already exists");
  const ts = nowIso();
  const insert = await runAsync(
    db,
    `INSERT INTO file_collections
      (code, name, description, owner_id, tenant_id, organization_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, String(body.description || "").slice(0, 2000), body.owner_id ?? actor?.id ?? null, scope,
      body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = await findCollectionRowAsync(db, insert.lastInsertId, scope);
  await auditFileAsync(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.collection.create",
    objectType: "collection", objectId: row.id, objectName: row.name, details: { code }, ip,
  });
  return publicCollection(row, { memberCount: 0 });
}

export async function updateCollectionAsync(db, reference, body = {}, actor, tenantId, ip) {
  const scope = await assertTenantScopeAsync(db, actor, assertTenant(tenantId));
  const row = await findCollectionRowAsync(db, reference, scope);
  await assertAccessAsync(db, row, actor, "manage_folder", { tenantId: scope });
  const patch = {};
  if (body.name !== undefined) {
    const name = sanitizeFilename(body.name, { fallback: "" });
    if (!name) throw new HttpError(400, "Collection name is required");
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = String(body.description || "").slice(0, 2000);
  if (body.owner_id !== undefined || body.ownerId !== undefined) patch.owner_id = (body.owner_id ?? body.ownerId) || null;
  if (!Object.keys(patch).length) return publicCollection(row, { memberCount: await memberCountAsync(db, row.id) });
  patch.updated_by = actor?.id ?? null;
  patch.updated_at = nowIso();
  await runAsync(db, `UPDATE file_collections SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...Object.values(patch), row.id]);
  const next = await findCollectionRowAsync(db, row.id, scope);
  await auditFileAsync(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.collection.update",
    objectType: "collection", objectId: next.id, objectName: next.name, details: { changed_fields: Object.keys(patch) }, ip,
  });
  return publicCollection(next, { memberCount: await memberCountAsync(db, next.id) });
}

export async function deleteCollectionAsync(db, reference, actor, tenantId, ip) {
  const scope = await assertTenantScopeAsync(db, actor, assertTenant(tenantId));
  const row = await findCollectionRowAsync(db, reference, scope);
  await assertAccessAsync(db, row, actor, "manage_folder", { tenantId: scope });
  await runAsync(db, "UPDATE file_collections SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    nowIso(), actor?.id ?? null, nowIso(), row.id,
  ]);
  await auditFileAsync(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.collection.delete",
    objectType: "collection", objectId: row.id, objectName: row.name, ip,
  });
  return { deleted: true, id: row.id };
}

export async function addCollectionMembersAsync(db, reference, fileIds, actor, tenantId, ip) {
  const scope = await assertTenantScopeAsync(db, actor, assertTenant(tenantId));
  const collection = await findCollectionRowAsync(db, reference, scope);
  await assertAccessAsync(db, collection, actor, "associate", { tenantId: scope });
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds]).map((v) => Number(v)).filter((n) => n > 0))];
  if (!ids.length) throw new HttpError(400, "fileIds must be a non-empty array");
  return transactionAsync(db, async () => {
    const ts = nowIso();
    const added = [];
    for (const id of ids) {
      const file = await queryOneAsync(db, "SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", [id, scope]);
      if (!file) continue;
      const exists = await queryOneAsync(db, "SELECT 1 AS x FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
      if (exists) continue;
      await runAsync(db, "INSERT INTO file_collection_members (collection_id, file_id, display_order, added_by, created_at) VALUES (?, ?, ?, ?, ?)", [
        collection.id, id, added.length, actor?.id ?? null, ts,
      ]);
      added.push(id);
    }
    await auditFileAsync(db, {
      actor, tenantId: scope, organizationId: collection.organization_id, action: "files.collection.add_members",
      objectType: "collection", objectId: collection.id, objectName: collection.name, details: { added }, ip,
    });
    return { added, added_count: added.length, collection_id: collection.id };
  });
}

export async function removeCollectionMemberAsync(db, reference, fileId, actor, tenantId, ip) {
  const scope = await assertTenantScopeAsync(db, actor, assertTenant(tenantId));
  const collection = await findCollectionRowAsync(db, reference, scope);
  await assertAccessAsync(db, collection, actor, "remove_association", { tenantId: scope });
  const id = Number(fileId);
  const exists = await queryOneAsync(db, "SELECT 1 AS x FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
  if (!exists) throw new HttpError(404, "File is not a member of this collection");
  await runAsync(db, "DELETE FROM file_collection_members WHERE collection_id = ? AND file_id = ?", [collection.id, id]);
  await auditFileAsync(db, {
    actor, tenantId: scope, organizationId: collection.organization_id, action: "files.collection.remove_member",
    objectType: "collection", objectId: collection.id, objectName: collection.name, details: { file_id: id }, ip,
  });
  return { removed: true, file_id: id, collection_id: collection.id };
}

export async function listCollectionsForFileAsync(db, fileId, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const items = (
    await queryAllAsync(
      db,
      `SELECT c.* FROM file_collections c
       JOIN file_collection_members m ON m.collection_id = c.id
       WHERE m.file_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
       ORDER BY lower(c.name)`,
      [Number(fileId) || -1, scope]
    )
  ).map((row) => publicCollection(row));
  return { items, total: items.length };
}
