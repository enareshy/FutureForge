// SQL for the Generic Traceability Engine read models (coverage, orphans,
// broken links).
//
// All persistence is owned by the existing frameworks; this module only reads
// `objects`, `object_relationships`, `object_references`, `relationship_types`
// and `metadata_types`. No new tables are introduced. Every query is
// tenant-scoped and soft-delete aware, and both a synchronous and asynchronous
// twin are exported so the route layer can stay fully asynchronous.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { OBSOLETE_STATUSES } from "./constants.js";

function placeholders(values) {
  return values.map(() => "?").join(",");
}

function obsoleteClause() {
  return `s.status NOT IN (${placeholders(OBSOLETE_STATUSES)})`;
}

// Per-rule coverage/denominator query. Returns one row per source-domain object
// with the number of active links it has into the target domain. Link counting
// is done in SQL (no N+1) via a bounded left join.
export function coverageRowsForRule(db, tenantId, options) {
  const { relationshipType } = options;
  const target = placeholders(options.targetTypes);
  const source = placeholders(options.sourceTypes);
  const relFilter = relationshipType
    ? "AND r.relationship_type_id IN (SELECT id FROM relationship_types WHERE code = ?)"
    : "";
  const activeFilter = options.expectedMode === "ACTIVE" ? `AND ${obsoleteClause()}` : "";
  const sql = `
    SELECT s.id, s.code, s.name, s.status, s.organization_id, st.code AS type_code,
           COUNT(r.id) AS link_count
    FROM objects s
    JOIN metadata_types st ON st.id = s.object_type_id
    LEFT JOIN object_relationships r
      ON r.source_object_id = s.id
     AND r.deleted_at IS NULL
     AND r.status = 'active'
     AND r.target_object_id IN (
       SELECT o2.id FROM objects o2
       JOIN metadata_types t2 ON t2.id = o2.object_type_id
       WHERE o2.tenant_id = ? AND o2.deleted_at IS NULL AND t2.code IN (${target})
     )
     ${relFilter}
    WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND st.code IN (${source}) ${activeFilter}
    GROUP BY s.id, s.code, s.name, s.status, s.organization_id, st.code
    ORDER BY s.id
    LIMIT ?
  `;
  const params = [Number(tenantId), ...options.targetTypes];
  if (relationshipType) params.push(String(relationshipType));
  params.push(Number(tenantId), ...options.sourceTypes);
  if (options.expectedMode === "ACTIVE") params.push(...OBSOLETE_STATUSES);
  params.push(Number(options.limit));
  return queryAll(db, sql, params);
}

export async function coverageRowsForRuleAsync(db, tenantId, options) {
  const { relationshipType } = options;
  const target = placeholders(options.targetTypes);
  const source = placeholders(options.sourceTypes);
  const relFilter = relationshipType
    ? "AND r.relationship_type_id IN (SELECT id FROM relationship_types WHERE code = ?)"
    : "";
  const activeFilter = options.expectedMode === "ACTIVE" ? `AND ${obsoleteClause()}` : "";
  const sql = `
    SELECT s.id, s.code, s.name, s.status, s.organization_id, st.code AS type_code,
           COUNT(r.id) AS link_count
    FROM objects s
    JOIN metadata_types st ON st.id = s.object_type_id
    LEFT JOIN object_relationships r
      ON r.source_object_id = s.id
     AND r.deleted_at IS NULL
     AND r.status = 'active'
     AND r.target_object_id IN (
       SELECT o2.id FROM objects o2
       JOIN metadata_types t2 ON t2.id = o2.object_type_id
       WHERE o2.tenant_id = ? AND o2.deleted_at IS NULL AND t2.code IN (${target})
     )
     ${relFilter}
    WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND st.code IN (${source}) ${activeFilter}
    GROUP BY s.id, s.code, s.name, s.status, s.organization_id, st.code
    ORDER BY s.id
    LIMIT ?
  `;
  const params = [Number(tenantId), ...options.targetTypes];
  if (relationshipType) params.push(String(relationshipType));
  params.push(Number(tenantId), ...options.sourceTypes);
  if (options.expectedMode === "ACTIVE") params.push(...OBSOLETE_STATUSES);
  params.push(Number(options.limit));
  return queryAllAsync(db, sql, params);
}

const BROKEN_SELECT = `
  SELECT r.id AS relationship_id, r.status AS relationship_status, r.valid_from, r.valid_to,
         rt.code AS relationship_type, rt.status AS relationship_type_status,
         s.id AS source_id, s.code AS source_code, s.name AS source_name,
         s.status AS source_status, s.deleted_at AS source_deleted, st.code AS source_type,
         t.id AS target_id, t.code AS target_code, t.name AS target_name,
         t.status AS target_status, t.deleted_at AS target_deleted, tt.code AS target_type
  FROM object_relationships r
  JOIN relationship_types rt ON rt.id = r.relationship_type_id
  JOIN objects s ON s.id = r.source_object_id
  JOIN objects t ON t.id = r.target_object_id
  LEFT JOIN metadata_types st ON st.id = s.object_type_id
  LEFT JOIN metadata_types tt ON tt.id = t.object_type_id
`;

const BROKEN_WHERE = `
  WHERE r.tenant_id = ? AND r.deleted_at IS NULL
    AND (
      s.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL
      OR rt.status <> 'active'
      OR r.status <> 'active'
      OR (r.valid_to IS NOT NULL AND r.valid_to <> '' AND r.valid_to < to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS'))
      OR s.status IN ('obsolete','archived') OR t.status IN ('obsolete','archived')
    )
  ORDER BY r.id DESC
  LIMIT ? OFFSET ?
`;

export function brokenRelationshipRows(db, tenantId, { limit, offset }) {
  return queryAll(db, `${BROKEN_SELECT} ${BROKEN_WHERE}`, [Number(tenantId), Number(limit), Number(offset)]);
}

export async function brokenRelationshipRowsAsync(db, tenantId, { limit, offset }) {
  return queryAllAsync(db, `${BROKEN_SELECT} ${BROKEN_WHERE}`, [Number(tenantId), Number(limit), Number(offset)]);
}

// Counts for pagination headers without loading the rows.
export function brokenRelationshipCount(db, tenantId) {
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM object_relationships r
     JOIN relationship_types rt ON rt.id = r.relationship_type_id
     JOIN objects s ON s.id = r.source_object_id
     JOIN objects t ON t.id = r.target_object_id
     WHERE r.tenant_id = ? AND r.deleted_at IS NULL
       AND (s.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL
            OR rt.status <> 'active' OR r.status <> 'active'
            OR (r.valid_to IS NOT NULL AND r.valid_to <> '' AND r.valid_to < to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS'))
            OR s.status IN ('obsolete','archived') OR t.status IN ('obsolete','archived'))`,
    [Number(tenantId)]
  );
  return Number(row?.c || 0);
}

export async function brokenRelationshipCountAsync(db, tenantId) {
  const row = await queryOneAsync(
    db,
    `SELECT COUNT(*) AS c FROM object_relationships r
     JOIN relationship_types rt ON rt.id = r.relationship_type_id
     JOIN objects s ON s.id = r.source_object_id
     JOIN objects t ON t.id = r.target_object_id
     WHERE r.tenant_id = ? AND r.deleted_at IS NULL
       AND (s.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL
            OR rt.status <> 'active' OR r.status <> 'active'
            OR (r.valid_to IS NOT NULL AND r.valid_to <> '' AND r.valid_to < to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS'))
            OR s.status IN ('obsolete','archived') OR t.status IN ('obsolete','archived'))`,
    [Number(tenantId)]
  );
  return Number(row?.c || 0);
}
