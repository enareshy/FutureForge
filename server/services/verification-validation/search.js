// Search & Discovery integration for the Verification & Validation Engine.
//
// V&V test cases and executions are indexed as read-only search object types
// through the shared Enterprise Search, so they are discoverable with the same
// facets, authorization, saved searches and ranking as every other module.
// Nothing here re-implements search; object types are registered in the shared
// registry and rows are resolved through shared source resolvers (mirrors
// requirements/search.js).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { registerObjectType, registerObjectTypeAsync, tenantIds, tenantIdsAsync } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import {
  getObjectType,
  getObjectTypeAsync,
  registerObjectType as registerSecurityObjectType,
  registerObjectTypeAsync as registerSecurityObjectTypeAsync,
} from "../security/repository.js";
import { VV_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("vv_test_case"),
    source_module: "verification-validation",
    source_table: "vv_test_cases",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "objective", "verification_kind", "method_code", "status"],
    facet_attributes: ["status", "verification_kind", "method_code"],
    filter_attributes: ["status", "verification_kind", "method_code", "organization_id"],
    permission_resource: VV_RESOURCES.testCases,
    display_order: 400,
  },
  {
    ...defFor("vv_test_execution"),
    source_module: "verification-validation",
    source_table: "vv_executions",
    title_attribute: "execution_ref",
    subtitle_attribute: "status",
    summary_attribute: "notes",
    body_attributes: ["execution_ref", "status", "overall_outcome", "test_case_revision", "procedure_revision", "notes"],
    facet_attributes: ["status", "overall_outcome"],
    filter_attributes: ["status", "overall_outcome", "test_case_id", "organization_id"],
    permission_resource: VV_RESOURCES.executions,
    display_order: 401,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

function testCaseDocument(row, tenantId) {
  if (!row) return null;
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "vv_test_case",
    objectId: String(row.id),
    code: row.code,
    title: row.name || row.code,
    subtitle: row.code,
    summary: row.description || "",
    searchableText: joinText([row.code, row.name, row.description, row.objective, row.verification_kind, row.method_code, row.status]),
    status: row.status,
    ownerId: row.owner_user_id ?? null,
    classification: "internal",
    tags: [row.status, row.verification_kind].filter(Boolean),
    attributes: { code: row.code, verification_kind: row.verification_kind, method_code: row.method_code, status: row.status },
    scoreWeight: 1,
  };
}

function executionDocument(row, tenantId) {
  if (!row) return null;
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "vv_test_execution",
    objectId: String(row.id),
    code: row.execution_ref,
    title: row.execution_ref || `Execution ${row.id}`,
    subtitle: row.status,
    summary: row.notes || "",
    searchableText: joinText([row.execution_ref, row.status, row.overall_outcome, row.test_case_revision, row.procedure_revision, row.notes]),
    status: row.status,
    ownerId: row.tester_user_id ?? null,
    classification: "internal",
    tags: [row.status, row.overall_outcome].filter(Boolean),
    attributes: { execution_ref: row.execution_ref, status: row.status, overall_outcome: row.overall_outcome },
    scoreWeight: 1,
  };
}

export function registerVvSources() {
  registerSourceResolver("vv_test_case", {
    code: "vv_test_case",
    table: "vv_test_cases",
    resolve(db, objectId, { tenantId } = {}) {
      return testCaseDocument(queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [Number(objectId)]), tenantId);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM vv_test_cases WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
    async resolveAsync(db, objectId, { tenantId } = {}) {
      return testCaseDocument(await queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ?", [Number(objectId)]), tenantId);
    },
    async listIdsAsync(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAllAsync(db, "SELECT id, tenant_id FROM vv_test_cases WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("vv_test_execution", {
    code: "vv_test_execution",
    table: "vv_executions",
    resolve(db, objectId, { tenantId } = {}) {
      return executionDocument(queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(objectId)]), tenantId);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM vv_executions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
    async resolveAsync(db, objectId, { tenantId } = {}) {
      return executionDocument(await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(objectId)]), tenantId);
    },
    async listIdsAsync(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAllAsync(db, "SELECT id, tenant_id FROM vv_executions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureVvSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}

export async function ensureVvSearchAsync(db) {
  let created = 0;
  for (const tenantId of await tenantIdsAsync(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = await queryOneAsync(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        await registerObjectTypeAsync(db, def, null, tenantId, null);
        created += 1;
      }
      if (!(await getObjectTypeAsync(db, tenantId, def.code))) {
        await registerSecurityObjectTypeAsync(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}
