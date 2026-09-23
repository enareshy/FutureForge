// Search & Discovery integration. Classifications, classes and assignments are
// indexed as read-only search object types through the shared Enterprise Search,
// so classification content is discoverable with the same facets, authorization
// and saved searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { tenantIds } from "../search/registry.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { CLASSIFICATION_RESOURCES } from "./constants.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "classification",
    name: "Classifications",
    description: "Enterprise classification definitions and their lifecycle status",
    source_module: "classification",
    source_table: "cla_classifications",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "status", "approval_status"],
    facet_attributes: ["status", "approval_status"],
    filter_attributes: ["status", "approval_status"],
    permission_resource: CLASSIFICATION_RESOURCES.classifications,
    display_order: 120,
  },
  {
    code: "classification_class",
    name: "Classification classes",
    description: "Classification classes, their hierarchy path and status",
    source_module: "classification",
    source_table: "cla_classes",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "path", "status"],
    facet_attributes: ["status", "level"],
    filter_attributes: ["status", "classification_id", "parent_class_id"],
    permission_resource: CLASSIFICATION_RESOURCES.classes,
    display_order: 121,
  },
  {
    code: "classification_assignment",
    name: "Classification assignments",
    description: "Objects classified against a classification class",
    source_module: "classification",
    source_table: "cla_assignments",
    title_attribute: "object_id",
    subtitle_attribute: "object_type",
    summary_attribute: "assignment_ref",
    body_attributes: ["assignment_ref", "object_type", "object_id", "status"],
    facet_attributes: ["status", "object_type"],
    filter_attributes: ["status", "object_type", "class_id", "classification_id"],
    permission_resource: CLASSIFICATION_RESOURCES.assignments,
    display_order: 122,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerClassificationSources() {
  registerSourceResolver("classification", {
    code: "classification",
    table: "cla_classifications",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "classification",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.status, row.approval_status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.status, row.approval_status].filter(Boolean),
        attributes: { code: row.code, status: row.status, approval_status: row.approval_status },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM cla_classifications WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("classification_class", {
    code: "classification_class",
    table: "cla_classes",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "classification_class",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.path || row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.path, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.status, row.path].filter(Boolean),
        attributes: { code: row.code, status: row.status, path: row.path, level: row.level, classification_id: row.classification_id, parent_class_id: row.parent_class_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM cla_classes WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("classification_assignment", {
    code: "classification_assignment",
    table: "cla_assignments",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      const classRow = queryOne(db, "SELECT code, name, path FROM cla_classes WHERE id = ?", [row.class_id]);
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "classification_assignment",
        objectId: String(row.id),
        code: row.assignment_ref,
        title: `${row.object_type}:${row.object_id}`,
        subtitle: classRow ? classRow.code : "",
        summary: classRow ? classRow.name : "",
        searchableText: joinText([row.assignment_ref, row.object_type, row.object_id, row.status, classRow?.code, classRow?.name, classRow?.path]),
        status: row.status,
        ownerId: row.assigned_by ?? null,
        classification: "internal",
        tags: [row.object_type, row.status, classRow?.code].filter(Boolean),
        attributes: { object_type: row.object_type, object_id: row.object_id, status: row.status, class_id: row.class_id, classification_id: row.classification_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM cla_assignments WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureClassificationSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(
          db,
          { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource },
          null,
          tenantId
        );
      }
    }
  }
  return { created };
}
