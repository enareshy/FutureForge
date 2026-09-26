// ConfigurationContextService — reusable, named configuration contexts shared by
// BOM, PDM, Manufacturing, Change, Product Configuration, reporting and search.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { writeAudit } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import { publicConfigurationContext, normalizeText, safeParse } from "./validation.js";
import { contextRef } from "./refs.js";
import { invalidConfigurationContext, invalidEffectivity } from "./errors.js";

export function getContextRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE context_ref = ? OR code = ?", [
    String(ref),
    String(ref),
  ]);
}

export function getConfigurationContext(db, ref) {
  const row = getContextRow(db, ref);
  if (!row) throw invalidConfigurationContext(`Configuration context not found: ${ref}`, { notFound: true });
  return publicConfigurationContext(row);
}

export function listConfigurationContexts(db, { status, tenantId, variantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (variantId) {
    clauses.push("variant_id = ?");
    params.push(Number(variantId));
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_configuration_contexts WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(db, `SELECT * FROM versioning_configuration_contexts WHERE ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map(publicConfigurationContext), total, page: Number(page) || 1, page_size: limit };
}

function normalizeContextFields(input) {
  const asOfDate = input.asOfDate ?? input.as_of_date ?? null;
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}/.test(String(asOfDate))) {
    throw invalidConfigurationContext("asOfDate must be an ISO date (YYYY-MM-DD)");
  }
  return {
    configVersion: normalizeText(input.configurationVersion ?? input.configuration_version, "1"),
    variantId: input.variantId ?? input.variant_id ?? null,
    modelId: normalizeText(input.modelId ?? input.model_id) || null,
    plantId: input.plantId ?? input.plant_id ?? null,
    siteId: input.siteId ?? input.site_id ?? null,
    organizationId: input.organizationId ?? input.organization_id ?? null,
    revisionId: input.revisionId ?? input.revision_id ?? null,
    asOfDate: normalizeText(asOfDate) || null,
    serialNumber: normalizeText(input.serialNumber ?? input.serial_number) || null,
  };
}

export function createConfigurationContext(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  if (!code) throw invalidEffectivity("Configuration context code is required");
  const fields = normalizeContextFields(input);
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_configuration_contexts WHERE code = ? AND (tenant_id IS NULL OR ? IS NULL OR tenant_id = ?)",
      [code, tenantId, tenantId]
    );
    if (existing) throw invalidConfigurationContext(`Configuration context ${code} already exists`);
    if (fields.variantId) {
      const variant = queryOne(db, "SELECT id FROM versioning_variants WHERE id = ?", [Number(fields.variantId)]);
      if (!variant) throw invalidConfigurationContext(`Variant not found: ${fields.variantId}`);
    }
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_configuration_contexts
        (context_ref, code, name, description, configuration_version, variant_id, model_id, plant_id, site_id,
         organization_id, revision_id, as_of_date, serial_number, attributes_json, status, tenant_id, version,
         created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        contextRef(code),
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        fields.configVersion,
        fields.variantId,
        fields.modelId,
        fields.plantId,
        fields.siteId,
        fields.organizationId,
        fields.revisionId,
        fields.asOfDate,
        fields.serialNumber,
        JSON.stringify(input.attributes ?? safeParse(input.attributes_json, {})),
        input.status === "inactive" ? "inactive" : "active",
        input.tenantId ?? input.tenant_id ?? tenantId,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    const row = queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.configuration_context.create",
      resourceType: "versioning_configuration_context",
      resourceId: id,
      details: { code, variant_id: fields.variantId, model_id: fields.modelId },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "ConfigurationContextCreated",
        source_module: "versioning",
        source_object_type: "versioning_configuration_context",
        source_object_id: id,
        tenant_id: row.tenant_id,
        payload: { context_id: id, code, variant_id: fields.variantId, model_id: fields.modelId },
      },
      actor
    );
    return publicConfigurationContext(row);
  });
}

export function updateConfigurationContext(db, ref, patch = {}, actor = null, ip = null) {
  const row = getContextRow(db, ref);
  if (!row) throw invalidConfigurationContext(`Configuration context not found: ${ref}`, { notFound: true });
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.configurationVersion !== undefined || patch.configuration_version !== undefined) {
    set("configuration_version", normalizeText(patch.configurationVersion ?? patch.configuration_version, "1"));
  }
  if (patch.variantId !== undefined || patch.variant_id !== undefined) set("variant_id", patch.variantId ?? patch.variant_id ?? null);
  if (patch.modelId !== undefined || patch.model_id !== undefined) set("model_id", normalizeText(patch.modelId ?? patch.model_id) || null);
  if (patch.plantId !== undefined || patch.plant_id !== undefined) set("plant_id", patch.plantId ?? patch.plant_id ?? null);
  if (patch.siteId !== undefined || patch.site_id !== undefined) set("site_id", patch.siteId ?? patch.site_id ?? null);
  if (patch.organizationId !== undefined || patch.organization_id !== undefined) {
    set("organization_id", patch.organizationId ?? patch.organization_id ?? null);
  }
  if (patch.revisionId !== undefined || patch.revision_id !== undefined) set("revision_id", patch.revisionId ?? patch.revision_id ?? null);
  if (patch.asOfDate !== undefined || patch.as_of_date !== undefined) set("as_of_date", normalizeText(patch.asOfDate ?? patch.as_of_date) || null);
  if (patch.serialNumber !== undefined || patch.serial_number !== undefined) {
    set("serial_number", normalizeText(patch.serialNumber ?? patch.serial_number) || null);
  }
  if (patch.attributes !== undefined) set("attributes_json", JSON.stringify(patch.attributes ?? {}));
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (fields.length) {
    set("updated_by", actor?.id ?? null);
    set("version", Number(row.version) + 1);
    set("updated_at", nowIso());
    run(db, `UPDATE versioning_configuration_contexts SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
  }
  const updated = queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.configuration_context.update",
    resourceType: "versioning_configuration_context",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "ConfigurationContextChanged",
      source_module: "versioning",
      source_object_type: "versioning_configuration_context",
      source_object_id: row.id,
      tenant_id: updated.tenant_id,
      payload: { context_id: row.id, code: updated.code },
    },
    actor
  );
  return publicConfigurationContext(updated);
}

export function deleteConfigurationContext(db, ref, actor = null, ip = null) {
  const row = getContextRow(db, ref);
  if (!row) throw invalidConfigurationContext(`Configuration context not found: ${ref}`, { notFound: true });
  run(db, "DELETE FROM versioning_configuration_contexts WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.configuration_context.delete",
    resourceType: "versioning_configuration_context",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}
