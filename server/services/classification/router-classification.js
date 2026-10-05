// REST router for the Enterprise Classification Framework. Built as a factory so
// it reuses the application's auth, authorization and error middleware. Mounted
// at /api/classification and /api/v1/classification.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization. The DB-backed surface runs on
// the asynchronous pool; only the pure vocabulary, unit conversion and seed
// routes stay synchronous.
import {
  constants,
  Validation,
  Units,
  Configuration,
  Definitions,
  Hierarchy,
  Characteristics,
  Inheritance,
  Assignments,
  Rules,
  ValidationService,
  Duplicates,
  Metrics,
  Jobs,
  History,
  Foundation,
  Seed,
} from "./index.js";

const R = constants.CLASSIFICATION_RESOURCES;

export function createClassificationRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => canAsync(R.overview, a);
  const canClassifications = (a) => canAsync(R.classifications, a);
  const canClasses = (a) => canAsync(R.classes, a);
  const canCharacteristics = (a) => canAsync(R.characteristics, a);
  const canGroups = (a) => canAsync(R.groups, a);
  const canValues = (a) => canAsync(R.values, a);
  const canAssignments = (a) => canAsync(R.assignments, a);
  const canValidation = (a) => canAsync(R.validation, a);
  const canSearch = (a) => canAsync(R.search, a);
  const canGovernance = (a) => canAsync(R.governance, a);
  const canAudit = (a) => canAsync(R.auditTrail, a);
  const canMetrics = (a) => canAsync(R.metrics, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        security_actions: constants.SECURITY_ACTIONS,
        resources: R,
        capabilities: {
          classification_statuses: constants.CLASSIFICATION_STATUSES,
          class_statuses: constants.CLASS_STATUSES,
          approval_statuses: constants.APPROVAL_STATUSES,
          characteristic_data_types: constants.CHARACTERISTIC_DATA_TYPES,
          allowed_value_modes: constants.ALLOWED_VALUE_MODES,
          rule_types: constants.RULE_TYPES,
          rule_severities: constants.RULE_SEVERITIES,
          assignment_statuses: constants.ASSIGNMENT_STATUSES,
          search_types: constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
          job_types: constants.CLASSIFICATION_JOB_TYPES.map((job) => job.code),
          config_defaults: constants.CONFIG_DEFAULTS,
        },
      });
    })
  );

  router.get(
    "/health",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json({ ...(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })), ...(await Foundation.classificationHealthAsync(db, tenantOf(req))) }))
  );

  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/coverage",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.coverageReportAsync(db, { tenantId: tenantOf(req), objectType: req.query.object_type || req.query.objectType, totalObjects: req.query.total_objects ?? req.query.totalObjects })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/config",
    authAsync,
    canAdmin("read"),
    wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req))))
  );
  const setConfig = wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", authAsync, canAdmin("update"), setConfig);
  router.patch("/config/:key", authAsync, canAdmin("update"), setConfig);

  // ── Classifications ───────────────────────────────────────────────────────
  router.get(
    "/classifications",
    authAsync,
    canClassifications("read"),
    wrap(async (req, res) => res.json(await Definitions.listClassificationsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/classifications",
    authAsync,
    canClassifications("create"),
    wrap(async (req, res) => res.status(201).json(await Definitions.createClassificationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/classifications/:ref",
    authAsync,
    canClassifications("read"),
    wrap(async (req, res) => res.json(await Definitions.getClassificationAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateClassification = wrap(async (req, res) => res.json(await Definitions.updateClassificationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/classifications/:ref", authAsync, canClassifications("update"), updateClassification);
  router.patch("/classifications/:ref", authAsync, canClassifications("update"), updateClassification);
  router.post(
    "/classifications/:ref/status",
    authAsync,
    canClassifications("update"),
    wrap(async (req, res) => res.json(await Definitions.setClassificationStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/classifications/:ref/approve",
    authAsync,
    canClassifications("update"),
    wrap(async (req, res) => res.json(await Definitions.approveClassificationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.delete(
    "/classifications/:ref",
    authAsync,
    canClassifications("delete"),
    wrap(async (req, res) => res.json(await Definitions.deleteClassificationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/classifications/:ref/versions",
    authAsync,
    canClassifications("read"),
    wrap(async (req, res) => res.json(await Definitions.listClassificationVersionsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classifications/:ref/versions",
    authAsync,
    canClassifications("update"),
    wrap(async (req, res) => res.status(201).json(await Definitions.createClassificationVersionAsync(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || req.body?.changeReason, actor: req.actor })))
  );
  router.get(
    "/classifications/:ref/audit",
    authAsync,
    canAudit("read"),
    wrap(async (req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(await Definitions.listClassificationAuditAsync(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get(
    "/classifications/:ref/tree",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.classTreeAsync(db, tenantOf(req), req.params.ref, { status: req.query.status || null })))
  );
  router.post(
    "/classifications/:ref/reorder-classes",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.json(await Hierarchy.reorderClassesAsync(db, tenantOf(req), { classificationId: req.params.ref, parentClassId: req.body?.parent_class_id ?? null, orderedIds: req.body?.ordered_ids || req.body?.orderedIds || [] }, req.actor, req.ip)))
  );

  // ── Classes ───────────────────────────────────────────────────────────────
  router.get(
    "/classes",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.listClassesAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/classes",
    authAsync,
    canClasses("create"),
    wrap(async (req, res) => res.status(201).json(await Hierarchy.createClassAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/classes/:ref",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.getClassAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateClass = wrap(async (req, res) => res.json(await Hierarchy.updateClassAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/classes/:ref", authAsync, canClasses("update"), updateClass);
  router.patch("/classes/:ref", authAsync, canClasses("update"), updateClass);
  router.post(
    "/classes/:ref/status",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.json(await Hierarchy.setClassStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/move",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.json(await Hierarchy.moveClassAsync(db, tenantOf(req), req.params.ref, { parentClassId: req.body?.parent_class_id ?? req.body?.parentClassId ?? null, sortOrder: req.body?.sort_order ?? req.body?.sortOrder ?? null }, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/copy",
    authAsync,
    canClasses("create"),
    wrap(async (req, res) => res.status(201).json(await Hierarchy.copyClassAsync(db, tenantOf(req), req.params.ref, { targetClassificationId: req.body?.target_classification_id ?? null, targetParentClassId: req.body?.target_parent_class_id ?? null, codeSuffix: req.body?.code_suffix || "_COPY" }, req.actor, req.ip)))
  );
  router.delete(
    "/classes/:ref",
    authAsync,
    canClasses("delete"),
    wrap(async (req, res) => res.json(await Hierarchy.deleteClassAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/classes/:ref/children",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.classChildrenAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/ancestors",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.classAncestorsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/descendants",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.classDescendantsAsync(db, tenantOf(req), req.params.ref, { includeSelf: String(req.query.include_self || "") === "true" })))
  );
  router.get(
    "/classes/:ref/versions",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Hierarchy.listClassVersionsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classes/:ref/versions",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.status(201).json(await Hierarchy.createClassVersionAsync(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || "", actor: req.actor })))
  );
  router.get(
    "/classes/:ref/effective",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Inheritance.resolveEffectiveCharacteristicsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/characteristics",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Characteristics.listClassCharacteristicsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classes/:ref/characteristics",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.addClassCharacteristicAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/validate",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.json(await ValidationService.validateClassValuesAsync(db, tenantOf(req), req.params.ref, req.body?.values ?? req.body ?? {}, { partial: req.body?.partial === true })))
  );
  router.get(
    "/classes/:ref/approved-values",
    authAsync,
    canClasses("read"),
    wrap(async (req, res) => res.json(await Inheritance.validateAllowedValueModesAsync(db, tenantOf(req), req.params.ref)))
  );

  const updateClassCharacteristic = wrap(async (req, res) => res.json(await Characteristics.updateClassCharacteristicAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/class-characteristics/:ref", authAsync, canClasses("update"), updateClassCharacteristic);
  router.patch("/class-characteristics/:ref", authAsync, canClasses("update"), updateClassCharacteristic);
  router.delete(
    "/class-characteristics/:ref",
    authAsync,
    canClasses("update"),
    wrap(async (req, res) => res.json(await Characteristics.removeClassCharacteristicAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Characteristics ───────────────────────────────────────────────────────
  router.get(
    "/characteristics",
    authAsync,
    canCharacteristics("read"),
    wrap(async (req, res) => res.json(await Characteristics.listCharacteristicsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/characteristics",
    authAsync,
    canCharacteristics("create"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.createCharacteristicAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/characteristics/:ref",
    authAsync,
    canCharacteristics("read"),
    wrap(async (req, res) => res.json(await Characteristics.getCharacteristicAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateCharacteristic = wrap(async (req, res) => res.json(await Characteristics.updateCharacteristicAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/characteristics/:ref", authAsync, canCharacteristics("update"), updateCharacteristic);
  router.patch("/characteristics/:ref", authAsync, canCharacteristics("update"), updateCharacteristic);
  router.post(
    "/characteristics/:ref/status",
    authAsync,
    canCharacteristics("update"),
    wrap(async (req, res) => res.json(await Characteristics.setCharacteristicStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.delete(
    "/characteristics/:ref",
    authAsync,
    canCharacteristics("delete"),
    wrap(async (req, res) => res.json(await Characteristics.deleteCharacteristicAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/characteristics/:ref/versions",
    authAsync,
    canCharacteristics("read"),
    wrap(async (req, res) => res.json(await Characteristics.listCharacteristicVersionsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/characteristics/:ref/versions",
    authAsync,
    canCharacteristics("update"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.createCharacteristicVersionAsync(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || "", actor: req.actor })))
  );
  router.get(
    "/characteristics/:ref/allowed-values",
    authAsync,
    canValues("read"),
    wrap(async (req, res) => res.json(await Characteristics.listAllowedValuesAsync(db, tenantOf(req), req.params.ref, { status: req.query.status || null, q: req.query.q || null })))
  );
  router.post(
    "/characteristics/:ref/allowed-values",
    authAsync,
    canValues("create"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.createAllowedValueAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  const updateAllowedValue = wrap(async (req, res) => res.json(await Characteristics.updateAllowedValueAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/allowed-values/:ref", authAsync, canValues("update"), updateAllowedValue);
  router.patch("/allowed-values/:ref", authAsync, canValues("update"), updateAllowedValue);
  router.delete(
    "/allowed-values/:ref",
    authAsync,
    canValues("delete"),
    wrap(async (req, res) => res.json(await Characteristics.deleteAllowedValueAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Characteristic groups ─────────────────────────────────────────────────
  router.get(
    "/groups",
    authAsync,
    canGroups("read"),
    wrap(async (req, res) => res.json(await Characteristics.listGroupsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/groups",
    authAsync,
    canGroups("create"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.createGroupAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  const updateGroup = wrap(async (req, res) => res.json(await Characteristics.updateGroupAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/groups/:ref", authAsync, canGroups("update"), updateGroup);
  router.patch("/groups/:ref", authAsync, canGroups("update"), updateGroup);
  router.delete(
    "/groups/:ref",
    authAsync,
    canGroups("delete"),
    wrap(async (req, res) => res.json(await Characteristics.deleteGroupAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/groups/:ref/members",
    authAsync,
    canGroups("read"),
    wrap(async (req, res) => res.json(await Characteristics.listGroupMembersAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/groups/:ref/members",
    authAsync,
    canGroups("update"),
    wrap(async (req, res) => res.status(201).json(await Characteristics.addGroupMemberAsync(db, tenantOf(req), req.params.ref, req.body?.characteristic_id ?? req.body?.characteristicId ?? req.body?.characteristic, { sequence: req.body?.sequence ?? null }, req.actor, req.ip)))
  );
  router.delete(
    "/groups/:ref/members/:characteristicRef",
    authAsync,
    canGroups("update"),
    wrap(async (req, res) => res.json(await Characteristics.removeGroupMemberAsync(db, tenantOf(req), req.params.ref, req.params.characteristicRef)))
  );

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get(
    "/rules",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.json(await Rules.listRulesAsync(db, tenantOf(req), { classId: req.query.class_id ?? req.query.classId, characteristicId: req.query.characteristic_id ?? req.query.characteristicId, ruleType: req.query.rule_type ?? req.query.ruleType, status: req.query.status })))
  );
  router.post(
    "/rules",
    authAsync,
    canValidation("update"),
    wrap(async (req, res) => res.status(201).json(await Rules.createRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  const updateRule = wrap(async (req, res) => res.json(await Rules.updateRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", authAsync, canValidation("update"), updateRule);
  router.patch("/rules/:ref", authAsync, canValidation("update"), updateRule);
  router.delete(
    "/rules/:ref",
    authAsync,
    canValidation("update"),
    wrap(async (req, res) => res.json(await Rules.deleteRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Assignments ───────────────────────────────────────────────────────────
  router.get(
    "/assignments",
    authAsync,
    canAssignments("read"),
    wrap(async (req, res) => res.json(await Assignments.listAssignmentsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/assignments",
    authAsync,
    canAssignments("create"),
    wrap(async (req, res) => res.status(201).json(await Assignments.assignClassAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/assignments/:ref",
    authAsync,
    canAssignments("read"),
    wrap(async (req, res) => res.json(await Assignments.getAssignmentAsync(db, tenantOf(req), req.params.ref)))
  );
  router.put(
    "/assignments/:ref/values",
    authAsync,
    canAssignments("update"),
    wrap(async (req, res) => res.json(await Assignments.setAssignmentValuesAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/values",
    authAsync,
    canAssignments("update"),
    wrap(async (req, res) => res.json(await Assignments.setAssignmentValuesAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/status",
    authAsync,
    canAssignments("update"),
    wrap(async (req, res) => res.json(await Assignments.setAssignmentStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/reclassify",
    authAsync,
    canAssignments("update"),
    wrap(async (req, res) => res.json(await Assignments.reclassifyAsync(db, tenantOf(req), req.params.ref, { classId: req.body?.class_id ?? req.body?.classId, values: req.body?.values, validate: req.body?.validate !== false }, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/validate",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.json(await Assignments.validateAssignmentAsync(db, tenantOf(req), req.params.ref)))
  );
  router.delete(
    "/assignments/:ref",
    authAsync,
    canAssignments("delete"),
    wrap(async (req, res) => res.json(await Assignments.unassignAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Object-centric read/validate contract ─────────────────────────────────
  router.get(
    "/objects/:objectType/:objectId",
    authAsync,
    canAssignments("read"),
    wrap(async (req, res) => res.json(await Assignments.objectClassificationsAsync(db, tenantOf(req), req.params.objectType, req.params.objectId, { includeInactive: String(req.query.include_inactive || "") === "true" })))
  );
  router.get(
    "/objects/:objectType/:objectId/values",
    authAsync,
    canAssignments("read"),
    wrap(async (req, res) => res.json(await Assignments.resolveObjectValuesAsync(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );
  router.get(
    "/objects/:objectType/:objectId/effective",
    authAsync,
    canAssignments("read"),
    wrap(async (req, res) => res.json({ items: await Assignments.effectiveCharacteristicsForObjectAsync(db, tenantOf(req), req.params.objectType, req.params.objectId) }))
  );
  router.post(
    "/objects/:objectType/:objectId/validate",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.json(await ValidationService.validateObjectAsync(db, tenantOf(req), { objectType: req.params.objectType, objectId: req.params.objectId })))
  );
  router.post(
    "/objects/:objectType/validate-batch",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.json(await ValidationService.validateBatchAsync(db, tenantOf(req), { objectType: req.params.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [] })))
  );

  // ── Duplicate detection ───────────────────────────────────────────────────
  router.post(
    "/duplicates/scan",
    authAsync,
    canGovernance("read"),
    wrap(async (req, res) => res.json(await Duplicates.detectClassificationDuplicatesAsync(db, { tenantId: tenantOf(req), classRef: req.body?.class_id ?? req.body?.classRef ?? null, objectType: req.body?.object_type ?? null, threshold: req.body?.threshold ?? null, actor: req.actor })))
  );
  router.get(
    "/duplicates/summary",
    authAsync,
    canGovernance("read"),
    wrap(async (req, res) => res.json(await Duplicates.duplicateSummaryAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Units ─────────────────────────────────────────────────────────────────
  router.get(
    "/units",
    authAsync,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Units.listUnits(db, { tenantId: tenantOf(req), uomClass: req.query.uom_class ?? null, q: req.query.q || null })))
  );
  router.post(
    "/units/convert",
    authAsync,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Units.convertValue(req.body?.value, req.body?.from_unit ?? req.body?.fromUnit, req.body?.to_unit ?? req.body?.toUnit, { units: Units.listUnits(db, { tenantId: tenantOf(req), limit: 2000 }) })))
  );

  // ── History & lineage ─────────────────────────────────────────────────────
  router.get(
    "/history",
    authAsync,
    canAudit("read"),
    wrap(async (req, res) => res.json(await History.listHistoryAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/lineage/:objectType/:objectId",
    authAsync,
    canAudit("read"),
    wrap(async (req, res) => res.json(await History.objectLineageAsync(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.post(
    "/jobs/bulk-assign",
    authAsync,
    canAssignments("update"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitBulkAssignJobAsync(db, { tenantId: tenantOf(req), classId: req.body?.class_id ?? req.body?.classId, objectType: req.body?.object_type ?? req.body?.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [], values: req.body?.values || null, action: req.body?.action || "ASSIGN", actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/bulk-validate",
    authAsync,
    canValidation("read"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitBulkValidateJobAsync(db, { tenantId: tenantOf(req), objectType: req.body?.object_type ?? req.body?.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [], actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/duplicate-scan",
    authAsync,
    canGovernance("read"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitDuplicateScanJobAsync(db, { tenantId: tenantOf(req), classRef: req.body?.class_id ?? req.body?.classRef ?? null, objectType: req.body?.object_type ?? null, threshold: req.body?.threshold ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/maintenance",
    authAsync,
    canAdmin("update"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );

  // ── Seed ──────────────────────────────────────────────────────────────────
  router.post(
    "/seed",
    authAsync,
    canAdmin("create"),
    wrap((req, res) => res.json(Seed.seedClassification(db, tenantOf(req))))
  );

  return router;
}
