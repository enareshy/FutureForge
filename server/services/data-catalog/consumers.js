// Data consumers and consumer mappings.
//
// A consumer is metadata about a system, service or audience that reads
// cataloged data (an application, analytics tool, pipeline, AI service...).
// Consumer mappings record which catalog objects/attributes are consumed, at
// what frequency and for what purpose, so impact analysis can trace downstream
// use without touching the underlying data.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertCatalogStatus,
  assertConsumerType,
  assertSecurityClassification,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireName,
} from "./validation.js";
import { consumerRef } from "./refs.js";
import { publicConsumer, publicConsumerMapping } from "./repository.js";
import { consumerNotFound, consumerConflict, invalidConsumer, mappingNotFound, invalidMapping } from "./errors.js";
import { registerEntry, syncEntry, commitEntryChange, getEntryRow, subjectTableFor } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicConsumer, publicConsumerMapping };

export function getConsumerRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref === "object") return ref;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_consumers WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [numeric]);
  }
  const text = String(ref);
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  return (
    queryOne(db, `SELECT * FROM dc_consumers WHERE consumer_ref = ?${scoped}`, [text, ...(tenantId ? [Number(tenantId)] : [])]) ||
    queryOne(db, `SELECT * FROM dc_consumers WHERE code = ?${scoped}`, [normalizeUpper(text), ...(tenantId ? [Number(tenantId)] : [])]) ||
    null
  );
}

export function findConsumerByCode(db, tenantId, code) {
  return queryOne(db, "SELECT * FROM dc_consumers WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(code)]);
}

export function requireConsumer(db, ref, tenantId = null) {
  const row = getConsumerRow(db, ref, tenantId);
  if (!row) throw consumerNotFound(ref);
  return row;
}

export function listConsumers(db, { tenantId, consumerType, status, classification, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (consumerType) {
    clauses.push("consumer_type = ?");
    params.push(assertConsumerType(normalizeUpper(consumerType)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertCatalogStatus(normalizeLower(status)));
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(assertSecurityClassification(normalizeLower(classification)));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(purpose) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_consumers ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_consumers ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicConsumer(row)), total, page: currentPage, page_size: limit };
}

export function listConsumerMappings(db, consumerId, { status = null } = {}) {
  const clauses = ["consumer_id = ?"];
  const params = [Number(consumerId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  return queryAll(db, `SELECT * FROM dc_consumer_mappings WHERE ${clauses.join(" AND ")} ORDER BY id`, params).map(
    publicConsumerMapping
  );
}

export function getConsumer(db, ref, { includeMappings = true, tenantId = null } = {}) {
  const row = requireConsumer(db, ref, tenantId);
  const mappings = includeMappings ? listConsumerMappings(db, row.id) : null;
  return publicConsumer(row, { mappings });
}

export function createConsumer(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(requireName(input.code, "Consumer code"));
  if (findConsumerByCode(db, tenantId, code)) throw consumerConflict(code);
  const name = normalizeText(input.name) || code;
  const status = assertCatalogStatus(normalizeLower(input.status || "active"));
  const consumerType = assertConsumerType(normalizeUpper(input.consumer_type || "APPLICATION"));
  const classification = assertSecurityClassification(normalizeLower(input.classification || "internal"));
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_consumers
      (consumer_ref, tenant_id, code, name, consumer_type, description, owner_user_id, purpose, frequency,
       classification, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      consumerRef(code),
      Number(tenantId),
      code,
      name,
      consumerType,
      normalizeText(input.description),
      input.owner_user_id ?? null,
      normalizeText(input.purpose),
      normalizeText(input.frequency),
      classification,
      status,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [Number(result.lastInsertRowid)]);
  const entry = registerEntry(
    db,
    {
      entry_type: "CONSUMER",
      code,
      name,
      display_name: name,
      description: row.description || row.purpose,
      classification,
      owner_user_id: row.owner_user_id,
      subject_table: subjectTableFor("CONSUMER"),
      subject_id: row.id,
      metadata: parseObject(row.metadata_json, {}),
    },
    actor,
    tenantId
  );
  run(db, "UPDATE dc_consumers SET entry_id = ? WHERE id = ?", [entry.id, row.id]);
  if (Array.isArray(input.mappings)) {
    for (const mapping of input.mappings) addConsumerMapping(db, row.id, mapping, actor, tenantId);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.consumer.create",
    resourceType: "dc_consumer",
    resourceId: row.id,
    details: { code, consumer_type: consumerType, entry_id: entry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "DataConsumerCataloged",
    tenantId: Number(tenantId),
    objectType: "data_consumer",
    objectId: row.id,
    payload: { id: row.id, code, consumer_type: consumerType, entry_id: entry.id, entry_ref: entry.entry_ref },
  }, actor);
  return getConsumer(db, row.id, { tenantId });
}

export function updateConsumer(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireConsumer(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.code !== undefined) {
    const code = normalizeUpper(requireName(patch.code, "Consumer code"));
    const clash = queryOne(db, "SELECT id FROM dc_consumers WHERE tenant_id = ? AND code = ? AND id <> ?", [row.tenant_id, code, row.id]);
    if (clash) throw consumerConflict(code);
    assign("code", code);
  }
  if (patch.name !== undefined)     assign("name", normalizeText(patch.name) || row.code);
  if (patch.consumer_type !== undefined) assign("consumer_type", assertConsumerType(normalizeUpper(patch.consumer_type)));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.purpose !== undefined) assign("purpose", normalizeText(patch.purpose));
  if (patch.frequency !== undefined) assign("frequency", normalizeText(patch.frequency));
  if (patch.classification !== undefined) assign("classification", assertSecurityClassification(normalizeLower(patch.classification)));
  if (patch.status !== undefined) assign("status", assertCatalogStatus(normalizeLower(patch.status)));
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return getConsumer(db, row.id, { tenantId });

  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_consumers SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [row.id]);
  if (row.entry_id) {
    syncEntry(
      db,
      row.entry_id,
      {
        name: updated.name,
        description: updated.description || updated.purpose,
        classification: updated.classification,
        owner_user_id: updated.owner_user_id,
        status: updated.status,
        metadata: parseObject(updated.metadata_json, {}),
      },
      actor
    );
    commitEntryChange(db, row.entry_id, { change_summary: `consumer updated: ${Object.keys(patch).join(", ")}` }, actor);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.consumer.update",
    resourceType: "dc_consumer",
    resourceId: row.id,
    details: { code: updated.code, fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "DataConsumerCataloged",
    tenantId: row.tenant_id,
    objectType: "data_consumer",
    objectId: row.id,
    payload: { id: row.id, code: updated.code, fields: Object.keys(patch) },
  }, actor);
  return publicConsumer(updated);
}

export function setConsumerStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireConsumer(db, ref, tenantId);
  const next = assertCatalogStatus(normalizeLower(status));
  run(db, "UPDATE dc_consumers SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  if (row.entry_id) syncEntry(db, row.entry_id, { status: next }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.consumer.status",
    resourceType: "dc_consumer",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicConsumer(queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [row.id]));
}

export function getConsumerMappingRow(db, id, tenantId = null) {
  return tenantId
    ? queryOne(db, "SELECT * FROM dc_consumer_mappings WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_consumer_mappings WHERE id = ?", [Number(id)]);
}

export function addConsumerMapping(db, consumerRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const consumer = requireConsumer(db, consumerRefValue, tenantId);
  const objectEntry = input.object_id ?? input.object_ref ? getEntryRow(db, input.object_id ?? input.object_ref, { tenantId: consumer.tenant_id, entryType: "OBJECT" }) : null;
  const attributeEntry = input.attribute_id ?? input.attribute_ref ? getEntryRow(db, input.attribute_id ?? input.attribute_ref, { tenantId: consumer.tenant_id, entryType: "ATTRIBUTE" }) : null;
  if (!objectEntry && !attributeEntry) {
    throw invalidMapping("A consumer mapping requires a catalog object or attribute", { input });
  }
  const objectRow = objectEntry ? queryOne(db, "SELECT id FROM dc_catalog_objects WHERE entry_id = ?", [objectEntry.id]) : null;
  const attributeRow = attributeEntry ? queryOne(db, "SELECT id FROM dc_catalog_attributes WHERE entry_id = ?", [attributeEntry.id]) : null;
  const duplicate = queryOne(
    db,
    "SELECT id FROM dc_consumer_mappings WHERE tenant_id = ? AND consumer_id = ? AND COALESCE(object_id, 0) = COALESCE(?, 0) AND COALESCE(attribute_id, 0) = COALESCE(?, 0)",
    [consumer.tenant_id, consumer.id, objectRow?.id ?? null, attributeRow?.id ?? null]
  );
  if (duplicate) throw invalidMapping("This consumer mapping already exists", { mapping_id: duplicate.id });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_consumer_mappings
      (tenant_id, consumer_id, object_id, attribute_id, purpose, frequency, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      consumer.tenant_id,
      consumer.id,
      objectRow?.id ?? null,
      attributeRow?.id ?? null,
      normalizeText(input.purpose) || consumer.purpose,
      normalizeText(input.frequency) || consumer.frequency,
      normalizeLower(input.status || "active") === "inactive" ? "inactive" : "active",
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "data_catalog.consumer.map",
    resourceType: "dc_consumer_mapping",
    resourceId: Number(result.lastInsertRowid),
    details: { consumer_id: consumer.id, object_id: objectRow?.id ?? null, attribute_id: attributeRow?.id ?? null },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "LineageCreated",
    tenantId: consumer.tenant_id,
    objectType: "data_consumer",
    objectId: consumer.id,
    payload: { consumer_id: consumer.id, object_id: objectRow?.id ?? null, attribute_id: attributeRow?.id ?? null },
  }, actor);
  return publicConsumerMapping(queryOne(db, "SELECT * FROM dc_consumer_mappings WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateConsumerMapping(db, mappingId, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = getConsumerMappingRow(db, mappingId, tenantId);
  if (!row) throw mappingNotFound(mappingId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.purpose !== undefined) assign("purpose", normalizeText(patch.purpose));
  if (patch.frequency !== undefined) assign("frequency", normalizeText(patch.frequency));
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (!changes.length) return publicConsumerMapping(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_consumer_mappings SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicConsumerMapping(queryOne(db, "SELECT * FROM dc_consumer_mappings WHERE id = ?", [row.id]));
}

export function removeConsumerMapping(db, mappingId, actor = null, tenantId = null, ip = null) {
  const row = getConsumerMappingRow(db, mappingId, tenantId);
  if (!row) throw mappingNotFound(mappingId);
  run(db, "DELETE FROM dc_consumer_mappings WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.consumer.unmap",
    resourceType: "dc_consumer_mapping",
    resourceId: row.id,
    details: { consumer_id: row.consumer_id },
    ip,
  });
  return { deleted: true, id: row.id };
}

// Reverse lookup: which consumers read a given catalog object/attribute.
export function consumersForObject(db, tenantId, objectId) {
  return queryAll(
    db,
    `SELECT c.* FROM dc_consumer_mappings m JOIN dc_consumers c ON c.id = m.consumer_id
      WHERE m.tenant_id = ? AND m.object_id = ? AND m.status = 'active' ORDER BY c.code`,
    [Number(tenantId), Number(objectId)]
  ).map((row) => publicConsumer(row));
}

export { consumerConflict, invalidConsumer };
