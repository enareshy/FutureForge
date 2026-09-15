import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import {
  WORKFLOW_STATUSES,
  VERSION_STATUSES,
  safeParse,
  assertValidGraph,
} from "./validation.js";
import { readGraph, readNodes, readTransitions, replaceGraph, snapshotGraph, restoreSnapshot } from "./graph.js";

// Workflow template (definition) and version lifecycle. A definition is the
// logical workflow; each version is an immutable snapshot once published and
// instances always pin a specific version id.

export function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    category: row.category || "general",
    module: row.module || "platform",
    current_version: row.current_version ?? 0,
    published_version: row.published_version ?? null,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    version_count: row.version_count ?? undefined,
    node_count: row.node_count ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVersion(row, { withSnapshot = false } = {}) {
  if (!row) return null;
  const version = {
    id: row.id,
    definition_id: row.definition_id,
    definition_code: row.definition_code ?? null,
    version: row.version,
    status: row.status,
    notes: row.notes || "",
    node_count: row.node_count ?? undefined,
    transition_count: row.transition_count ?? undefined,
    published_at: row.published_at || null,
    published_by: row.published_by ?? null,
    published_username: row.published_username ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withSnapshot) version.snapshot = safeParse(row.snapshot, {});
  return version;
}

const DEFINITION_SELECT = `
  SELECT d.*,
    (SELECT COUNT(*) FROM workflow_versions v WHERE v.definition_id = d.id) AS version_count
  FROM workflow_definitions d
`;

const VERSION_SELECT = `
  SELECT v.*, d.code AS definition_code, u.username AS published_username,
    (SELECT COUNT(*) FROM workflow_nodes n WHERE n.version_id = v.id) AS node_count,
    (SELECT COUNT(*) FROM workflow_transitions t WHERE t.version_id = v.id) AS transition_count
  FROM workflow_versions v
  JOIN workflow_definitions d ON d.id = v.definition_id
  LEFT JOIN users u ON u.id = v.published_by
`;

export function getDefinitionRow(db, id) {
  return queryOne(db, `${DEFINITION_SELECT} WHERE d.id = ?`, [Number(id)]);
}

export function findDefinition(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getDefinitionRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Workflow template not found");
      return byId;
    }
  }
  const scope = tenantClause("d", tenantId);
  const byCode = queryOne(db, `${DEFINITION_SELECT} WHERE d.code = ? AND ${scope.sql} ORDER BY d.tenant_id IS NULL LIMIT 1`, [
    text,
    ...scope.params,
  ]);
  if (!byCode) throw new HttpError(404, "Workflow template not found");
  return byCode;
}

export function getDefinition(db, idOrCode, tenantId) {
  const row = findDefinition(db, idOrCode, tenantId);
  const definition = publicDefinition(row);
  const versions = queryAll(db, `${VERSION_SELECT} WHERE v.definition_id = ? ORDER BY v.version DESC`, [row.id]).map((v) =>
    publicVersion(v)
  );
  definition.versions = versions;
  if (row.published_version) {
    definition.published = versions.find((v) => v.version === row.published_version) || null;
  }
  return definition;
}

export function listDefinitions(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("d", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("d.status = ?");
    params.push(query.status);
  }
  if (query.module) {
    where.push("d.module = ?");
    params.push(query.module);
  }
  if (query.category) {
    where.push("d.category = ?");
    params.push(query.category);
  }
  if (query.q) {
    where.push("(d.code LIKE ? OR d.name LIKE ? OR d.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_definitions d ${clause}`, params).c;
  const items = queryAll(db, `${DEFINITION_SELECT} ${clause} ORDER BY d.name LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    publicDefinition
  );
  return { items, total, page, pageSize };
}

export function createDefinition(db, body, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Workflow code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO workflow_definitions
        (code, name, description, category, module, current_version, published_version, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.category || "general",
        body.module || "platform",
        body.status || "draft",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Workflow code already exists in this scope");
    throw err;
  }
  const definitionId = result.lastInsertRowid;
  const graphProvided = body.graph && (Array.isArray(body.graph.nodes) || Array.isArray(body.graph.transitions));
  const version = transaction(db, () => {
    const versionId = insertVersion(db, definitionId, { notes: body.notes || "Initial draft", created_by: actor?.id ?? null });
    if (graphProvided) {
      replaceGraph(db, versionId, body.graph);
      // When no explicit graph is supplied we seed a minimal start/end draft so
      // the designer opens with a valid canvas.
    } else {
      replaceGraph(db, versionId, defaultGraph());
    }
    return versionId;
  });
  writeAudit(db, {
    actor,
    action: "workflow.definition.create",
    resourceType: "workflow_definition",
    resourceId: definitionId,
    details: { code: body.code, version_id: version },
    ip,
  });
  return getDefinition(db, definitionId, tenantId);
}

export function updateDefinition(db, id, body, actor = null, ip = null, tenantId = null) {
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Workflow template not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Workflow code");
  try {
    run(
      db,
      `UPDATE workflow_definitions SET
         code = ?, name = ?, description = ?, category = ?, module = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.category ?? row.category,
        body.module ?? row.module,
        body.status ?? row.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Workflow code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.definition.update", resourceType: "workflow_definition", resourceId: row.id, details: { code: row.code }, ip });
  return getDefinition(db, row.id, tenantId);
}

export function setDefinitionStatus(db, id, status, actor = null, ip = null, tenantId = null) {
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Workflow template not found");
  if (!WORKFLOW_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${WORKFLOW_STATUSES.join(", ")}`);
  }
  run(db, "UPDATE workflow_definitions SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, { actor, action: "workflow.definition.status", resourceType: "workflow_definition", resourceId: row.id, details: { status }, ip });
  return getDefinition(db, row.id, tenantId);
}

export function deleteDefinition(db, id, actor = null, ip = null, tenantId = null) {
  const row = getDefinitionRow(db, id);
  assertMutable(db, row, tenantId, actor, "Workflow template not found");
  const running = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_instances WHERE definition_id = ? AND status IN ('pending','running','paused')",
    [row.id]
  ).c;
  if (running) throw new HttpError(409, "Cannot delete a workflow with running instances");
  run(db, "DELETE FROM workflow_definitions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "workflow.definition.delete", resourceType: "workflow_definition", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

export function defaultGraph() {
  return {
    nodes: [
      { node_key: "start", type: "start", name: "Start", position_x: 80, position_y: 120, display_order: 0 },
      { node_key: "review", type: "task", name: "Review", position_x: 340, position_y: 120, display_order: 1, config: { assignee_type: "role", assignee_ref: "" } },
      { node_key: "end", type: "end", name: "End", position_x: 600, position_y: 120, display_order: 2 },
    ],
    transitions: [
      { transition_key: "start-review", from_node_key: "start", to_node_key: "review", display_order: 0 },
      { transition_key: "review-end", from_node_key: "review", to_node_key: "end", display_order: 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function getVersionRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_versions WHERE id = ?", [Number(id)]);
}

export function getVersionByNumber(db, definitionId, version) {
  return queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND version = ?", [Number(definitionId), Number(version)]);
}

export function publishedVersionRow(db, definitionId) {
  const definition = getDefinitionRow(db, definitionId);
  if (definition?.published_version) {
    const row = getVersionByNumber(db, definitionId, definition.published_version);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
    [Number(definitionId)]
  );
}

function insertVersion(db, definitionId, body = {}) {
  const current = queryOne(db, "SELECT COALESCE(MAX(version), 0) AS m FROM workflow_versions WHERE definition_id = ?", [Number(definitionId)]);
  const version = Number(body.version ?? (current?.m ?? 0) + 1);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO workflow_versions
      (definition_id, version, status, notes, snapshot, created_by, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, '{}', ?, ?, ?)`,
    [Number(definitionId), version, body.notes || "", body.created_by ?? null, ts, ts]
  );
  run(db, "UPDATE workflow_definitions SET current_version = MAX(current_version, ?), updated_at = ? WHERE id = ?", [
    version,
    ts,
    Number(definitionId),
  ]);
  return result.lastInsertRowid;
}

export function listVersions(db, definitionId, tenantId) {
  const definition = getDefinitionRow(db, definitionId);
  assertReadable(definition, tenantId, "Workflow template not found");
  return queryAll(db, `${VERSION_SELECT} WHERE v.definition_id = ? ORDER BY v.version DESC`, [definition.id]).map((v) =>
    publicVersion(v)
  );
}

export function getVersion(db, definitionId, version, tenantId, { withSnapshot = true } = {}) {
  const definition = getDefinitionRow(db, definitionId);
  assertReadable(definition, tenantId, "Workflow template not found");
  const row = /^\d+$/.test(String(version))
    ? getVersionByNumber(db, definition.id, Number(version))
    : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [
        definition.id,
        String(version || "published"),
      ]);
  if (!row) throw new HttpError(404, "Workflow version not found");
  const result = publicVersion(row, { withSnapshot });
  result.graph = readGraph(db, row.id);
  result.definition = publicDefinition(definition);
  return result;
}

export function createVersion(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const sourceRef = body.from_version ?? body.fromVersion ?? body.source_version;
  let sourceRow = null;
  if (body.from_definition_id || body.fromDefinitionId) {
    sourceRow = publishedVersionRow(db, Number(body.from_definition_id ?? body.fromDefinitionId));
  } else if (sourceRef !== undefined && sourceRef !== null && sourceRef !== "") {
    sourceRow = /^\d+$/.test(String(sourceRef))
      ? getVersionByNumber(db, definition.id, Number(sourceRef)) || getVersionRow(db, Number(sourceRef))
      : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [
          definition.id,
          String(sourceRef),
        ]);
  } else if (body.copy_published !== false && body.copyPublished !== false) {
    sourceRow = publishedVersionRow(db, definition.id) || queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? ORDER BY version DESC LIMIT 1", [definition.id]);
  }
  const versionId = transaction(db, () => {
    const id = insertVersion(db, definition.id, { notes: body.notes || "", created_by: actor?.id ?? null, version: body.version });
    if (Array.isArray(body.graph?.nodes) || Array.isArray(body.graph?.transitions) || Array.isArray(body.nodes)) {
      replaceGraph(db, id, body.graph || body);
    } else if (sourceRow) {
      restoreSnapshot(db, id, sourceRow.snapshot);
      if (!safeParse(sourceRow.snapshot, {}).nodes?.length) {
        const graph = readGraph(db, sourceRow.id);
        replaceGraph(db, id, graph);
      }
    } else {
      replaceGraph(db, id, defaultGraph());
    }
    return id;
  });
  writeAudit(db, {
    actor,
    action: "workflow.version.create",
    resourceType: "workflow_definition",
    resourceId: definition.id,
    details: { version_id: versionId, source_version_id: sourceRow?.id ?? null },
    ip,
  });
  return getVersion(db, definition.id, getVersionRow(db, versionId).version, tenantId);
}

export function validateDefinition(db, definitionId, tenantId, options = {}) {
  const definition = getDefinitionRow(db, definitionId);
  assertReadable(definition, tenantId, "Workflow template not found");
  const versionRow = options.version
    ? getVersionByNumber(db, definition.id, Number(options.version)) || getVersionRow(db, Number(options.version))
    : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? ORDER BY version DESC LIMIT 1", [definition.id]);
  if (!versionRow) throw new HttpError(404, "Workflow version not found");
  const graph = readGraph(db, versionRow.id);
  const result = assertValidGraph(graph);
  return { definition: publicDefinition(definition), version: publicVersion(versionRow), graph, ...result };
}

export function publishDefinition(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const versionRow = body.version
    ? getVersionByNumber(db, definition.id, Number(body.version)) || getVersionRow(db, Number(body.version))
    : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? ORDER BY version DESC LIMIT 1", [definition.id]);
  if (!versionRow || Number(versionRow.definition_id) !== Number(definition.id)) {
    throw new HttpError(404, "Workflow version not found");
  }
  const graph = readGraph(db, versionRow.id);
  const validation = assertValidGraph(graph);
  const ts = nowIso();
  transaction(db, () => {
    run(db, "UPDATE workflow_versions SET status = 'archived', updated_at = ? WHERE definition_id = ? AND status = 'published'", [
      ts,
      definition.id,
    ]);
    const snapshot = snapshotGraph(db, versionRow.id);
    run(
      db,
      `UPDATE workflow_versions SET status = 'published', published_at = ?, published_by = ?, snapshot = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [ts, actor?.id ?? null, JSON.stringify(snapshot), body.notes ?? versionRow.notes ?? "", ts, versionRow.id]
    );
    run(db, "UPDATE workflow_definitions SET published_version = ?, status = 'published', updated_at = ? WHERE id = ?", [
      versionRow.version,
      ts,
      definition.id,
    ]);
  });
  writeAudit(db, {
    actor,
    action: "workflow.definition.publish",
    resourceType: "workflow_definition",
    resourceId: definition.id,
    details: { version: versionRow.version, nodes: graph.nodes.length, transitions: graph.transitions.length },
    ip,
  });
  return {
    definition: publicDefinition(getDefinitionRow(db, definition.id)),
    version: publicVersion(getVersionRow(db, versionRow.id)),
    validation,
  };
}

export function cloneDefinition(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const source = getDefinitionRow(db, definitionId);
  assertReadable(source, tenantId, "Workflow template not found");
  const code = body.code || `${source.code}-copy`;
  validateCode(code, "Workflow code");
  const created = createDefinition(
    db,
    {
      code,
      name: body.name || `${source.name} (copy)`,
      description: body.description ?? source.description,
      category: source.category,
      module: source.module,
      tenantId: body.tenantId ?? body.tenant_id,
    },
    actor,
    ip,
    tenantId
  );
  const published = publishedVersionRow(db, source.id);
  if (published) {
    const targetVersionId = queryOne(db, "SELECT id FROM workflow_versions WHERE definition_id = ? ORDER BY version LIMIT 1", [created.id]).id;
    transaction(db, () => {
      run(db, "DELETE FROM workflow_transitions WHERE version_id = ?", [targetVersionId]);
      run(db, "DELETE FROM workflow_nodes WHERE version_id = ?", [targetVersionId]);
      const snapshot = safeParse(published.snapshot, {});
      replaceGraph(db, targetVersionId, snapshot.nodes?.length ? snapshot : readGraph(db, published.id));
    });
  }
  writeAudit(db, {
    actor,
    action: "workflow.definition.clone",
    resourceType: "workflow_definition",
    resourceId: created.id,
    details: { source_id: source.id, code },
    ip,
  });
  return getDefinition(db, created.id, tenantId);
}

export function readDefinitionTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}
