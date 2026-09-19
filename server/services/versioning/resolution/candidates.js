// CandidateSelector — gathers revisions/versions and their effectivity evidence
// for an object, evaluates each definition against the context, and produces
// scored candidates. Designed to batch-load for bulk resolution (no N+1).
import { queryAll } from "../../../db.js";
import { safeParse, withinDateRange, withinSerialRange } from "../validation.js";

const DIMENSION_CONTEXT_FIELD = {
  plant: "plantId",
  unit: "unitId",
  site: "siteId",
  organization: "organizationId",
  company: "companyId",
  business_unit: "businessUnitId",
  tenant: "tenantId",
  model: "modelId",
  variant: "variantId",
  revision: "revisionId",
  configuration: "configurationId",
};

function asString(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function valueIncluded(values, actual) {
  const set = new Set(values.map((v) => String(v).toLowerCase()));
  return actual !== null && set.has(String(actual).toLowerCase());
}

export function evaluateDefinition(def, defValues, context, { variantRowId = null, configurationRowId = null } = {}) {
  const reasons = [];
  let matched = false;
  let specificity = 0;

  const dateRange = def.effective_from || def.effective_to;
  if (dateRange) {
    const result = withinDateRange(context.asOfDate, def.effective_from, def.effective_to, def.boundary);
    if (result.valid) {
      matched = true;
      specificity += 1;
      reasons.push({ dimension: "date", reason: "DATE_EFFECTIVITY", from: def.effective_from, to: def.effective_to });
    }
  }

  const serialRange = def.serial_from || def.serial_to;
  if (serialRange) {
    const result = withinSerialRange(context.serialNumber, def.serial_from, def.serial_to, def.serial_mode);
    if (result.valid) {
      matched = true;
      specificity += 1;
      reasons.push({ dimension: "serial", reason: "SERIAL_EFFECTIVITY", from: def.serial_from, to: def.serial_to });
    }
  }

  if (def.dimension === "revision" && context.revisionRowId) {
    const relationTargets = defValues.filter((v) => v.dimension === "revision").map((v) => v.value);
    const direct = String(def.revision_id ?? "") === String(context.revisionRowId);
    const viaValue = valueIncluded(relationTargets, context.revisionId) || valueIncluded(relationTargets, context.revisionRowId);
    if (direct || viaValue) {
      matched = true;
      specificity += 1;
      reasons.push({ dimension: "revision", reason: "REVISION_EFFECTIVITY", revision_id: context.revisionRowId });
    }
  }

  if (def.configuration_context_id) {
    const target = configurationRowId ?? context.configurationContextId ?? null;
    if (target !== null && String(def.configuration_context_id) === String(target)) {
      matched = true;
      specificity += 2;
      reasons.push({
        dimension: "configuration",
        reason: "CONFIGURATION_EFFECTIVITY",
        configuration_context_id: def.configuration_context_id,
      });
    }
  }

  // Generic structured values keyed by dimension (model/plant/unit/variant/...).
  const byDimension = new Map();
  for (const value of defValues) {
    if (!byDimension.has(value.dimension)) byDimension.set(value.dimension, { include: [], exclude: [] });
    byDimension.get(value.dimension)[value.operator].push(value.value);
  }

  for (const [dimension, { include, exclude }] of byDimension.entries()) {
    if (dimension === "revision" || dimension === "configuration") continue;
    const field = DIMENSION_CONTEXT_FIELD[dimension];
    const actual = field ? context[field] : context[dimension];
    const actualStr = asString(actual);
    const inExclude = valueIncluded(exclude, actualStr);
    if (inExclude) {
      reasons.push({ dimension, reason: "EXCLUDED", value: actualStr });
      return { matched: false, specificity: 0, reasons, excluded: true };
    }
    if (include.length) {
      if (valueIncluded(include, actualStr)) {
        matched = true;
        specificity += 1;
        const code = `${dimension.toUpperCase()}_EFFECTIVITY`;
        reasons.push({ dimension, reason: code, value: actualStr });
      }
    } else if (def.dimension === dimension && actualStr !== null) {
      // A value-less definition pinned to a dimension (e.g. configuration) is
      // considered applicable when that dimension is present.
      matched = true;
      reasons.push({ dimension, reason: `${dimension.toUpperCase()}_EFFECTIVITY` });
    }
  }

  // Variant row resolved from context code/id.
  if (!byDimension.has("variant") && variantRowId) {
    if (def.dimension === "variant" || def.configuration_context_id) {
      matched = true;
      reasons.push({ dimension: "variant", reason: "VARIANT_EFFECTIVITY", variant_id: variantRowId });
    }
  }

  if (def.organization_id && context.organizationId !== undefined && context.organizationId !== null) {
    if (String(def.organization_id) === String(context.organizationId)) {
      matched = true;
      specificity += 1;
      reasons.push({ dimension: "organization", reason: "PLANT_EFFECTIVITY", organization_id: def.organization_id });
    }
  }

  return { matched, specificity, reasons, excluded: false };
}

// Load all data needed to resolve a set of objects in a bounded number of
// queries. Reused by both single and bulk resolution.
export function loadCandidateDataset(db, { objectType, objectIds, tenantId = null }) {
  const ids = [...new Set(objectIds.map(String))];
  if (!ids.length) return { revisions: [], assignmentsByObject: new Map(), definitions: new Map(), values: new Map() };
  const placeholders = ids.map(() => "?").join(", ");
  const tenantSql = tenantId === null || tenantId === undefined ? "" : " AND (tenant_id IS NULL OR tenant_id = ?)";
  const tenantParams = tenantId === null || tenantId === undefined ? [] : [Number(tenantId)];
  const assignmentTenantSql = tenantId === null || tenantId === undefined ? "" : " AND (a.tenant_id IS NULL OR a.tenant_id = ?)";
  const revisions = queryAll(
    db,
    `SELECT * FROM versioning_revisions
     WHERE object_type = ? AND object_id IN (${placeholders}) AND status != 'archived'${tenantSql}
     ORDER BY object_id, revision_sequence`,
    [String(objectType), ...ids, ...tenantParams]
  );
  const assignments = queryAll(
    db,
    `SELECT a.*, d.code AS definition_code, d.dimension AS definition_dimension, d.type_code AS definition_type_code,
            d.effective_from, d.effective_to, d.boundary, d.serial_from, d.serial_to, d.serial_mode,
            d.priority AS definition_priority, d.overlap_allowed, d.revision_id AS definition_revision_id,
            d.configuration_context_id, d.organization_id AS definition_organization_id, d.include_json, d.exclude_json
     FROM versioning_effectivity_assignments a
     JOIN versioning_effectivity_definitions d ON d.id = a.definition_id
     WHERE a.object_type = ? AND a.object_id IN (${placeholders}) AND a.status = 'active' AND d.status = 'active'${assignmentTenantSql}`,
    [String(objectType), ...ids, ...tenantParams]
  );
  const definitionIds = [...new Set(assignments.map((a) => a.definition_id))];
  const definitions = new Map();
  for (const assignment of assignments) {
    definitions.set(
      assignment.definition_id,
      Object.assign({}, assignment, {
        id: assignment.definition_id,
        revised: true,
      })
    );
  }
  const values = new Map();
  if (definitionIds.length) {
    const valuePlaceholders = definitionIds.map(() => "?").join(", ");
    for (const row of queryAll(
      db,
      `SELECT * FROM versioning_effectivity_values WHERE definition_id IN (${valuePlaceholders})`,
      definitionIds
    )) {
      if (!values.has(row.definition_id)) values.set(row.definition_id, []);
      values.get(row.definition_id).push(row);
    }
  }
  const assignmentsByObject = new Map();
  for (const assignment of assignments) {
    if (!assignmentsByObject.has(assignment.object_id)) assignmentsByObject.set(assignment.object_id, []);
    assignmentsByObject.get(assignment.object_id).push(assignment);
  }
  return { revisions, assignmentsByObject, definitions, values, assignments };
}

function definitionSummary(assignment, values) {
  return {
    definition_id: assignment.definition_id,
    code: assignment.definition_code,
    dimension: assignment.definition_dimension,
    type_code: assignment.definition_type_code,
    effective_from: assignment.effective_from,
    effective_to: assignment.effective_to,
    serial_from: assignment.serial_from,
    serial_to: assignment.serial_to,
    priority: assignment.definition_priority,
    assignment_priority: assignment.precedence,
    revision_id: assignment.revision_id ?? assignment.definition_revision_id ?? null,
    version_id: assignment.version_id ?? null,
    role: assignment.role,
    values: (values ?? []).map((v) => ({ dimension: v.dimension, value: v.value, operator: v.operator })),
  };
}

// Build candidates for every revision of one object.
export function buildCandidates(db, { objectType, objectId, context, dataset = null }) {
  const data = dataset ?? loadCandidateDataset(db, { objectType, objectIds: [objectId], tenantId: context.tenantId });
  const revisions = data.revisions.filter((r) => String(r.object_id) === String(objectId));
  const assignments = data.assignmentsByObject.get(String(objectId)) ?? data.assignmentsByObject.get(objectId) ?? [];

  const candidateByRevision = new Map();
  for (const revision of revisions) {
    candidateByRevision.set(revision.id, {
      revision,
      versionId: null,
      matchedDimensions: new Set(),
      reasons: [],
      priority: Number.POSITIVE_INFINITY,
      specificity: 0,
      excluded: false,
      matchedDefinitions: [],
    });
  }

  const objectLevelEvidence = [];

  for (const assignment of assignments) {
    const targetRevisionId = assignment.revision_id ?? assignment.definition_revision_id ?? null;
    const defValues = data.values.get(assignment.definition_id) ?? [];
    const evaluation = evaluateDefinition(assignment, defValues, context, {
      configurationRowId: context.configurationContextId ?? null,
      variantRowId: context.variantRowId ?? null,
    });
    const targetRevision = targetRevisionId ? candidateByRevision.get(targetRevisionId) : null;
    if (targetRevisionId && !targetRevision) continue; // foreign revision
    if (!evaluation.matched && !evaluation.excluded) continue;

    const summary = definitionSummary(assignment, defValues);
    const precedence = Math.min(
      Number(assignment.precedence ?? 100),
      Number(assignment.definition_priority ?? 100)
    );

    if (evaluation.excluded || assignment.role === "exclusion") {
      if (targetRevision) targetRevision.excluded = true;
      if (!targetRevision) objectLevelEvidence.push({ ...summary, excluded: true, reasons: evaluation.reasons });
      continue;
    }

    const bucket = {
      ...summary,
      reasons: evaluation.reasons,
      specificity: evaluation.specificity,
    };
    if (targetRevision) {
      for (const reason of evaluation.reasons) targetRevision.matchedDimensions.add(reason.dimension);
      targetRevision.reasons.push(...evaluation.reasons);
      targetRevision.matchedDefinitions.push(bucket);
      targetRevision.priority = Math.min(targetRevision.priority, precedence);
      targetRevision.specificity += evaluation.specificity;
      if (assignment.version_id && targetRevision.versionId === null) targetRevision.versionId = assignment.version_id;
    } else {
      objectLevelEvidence.push(bucket);
    }
  }

  // Intrinsic revision date effectivity (effective_from / effective_to).
  for (const candidate of candidateByRevision.values()) {
    const { revision } = candidate;
    if (revision.effective_from || revision.effective_to) {
      const result = withinDateRange(context.asOfDate, revision.effective_from, revision.effective_to, "inclusive");
      if (result.valid) {
        candidate.matchedDimensions.add("date");
        candidate.reasons.push({
          dimension: "date",
          reason: "DATE_EFFECTIVITY",
          from: revision.effective_from,
          to: revision.effective_to,
          intrinsic: true,
        });
        candidate.specificity += 1;
      } else if (context.asOfDate) {
        candidate.filtered = true;
      }
    }
  }

  // Object-level evidence applies to all revisions; it is used as fallback
  // evidence when no revision-specific match exists.
  const candidates = [...candidateByRevision.values()].filter((c) => !c.excluded && !c.filtered);
  for (const candidate of candidates) {
    if (!candidate.matchedDimensions.size && objectLevelEvidence.some((e) => !e.excluded)) {
      candidate.objectLevel = true;
    }
  }

  return {
    candidates,
    objectLevelEvidence,
    definitionIds: [...data.definitions.keys()],
  };
}
