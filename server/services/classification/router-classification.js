// REST router for the Enterprise Classification Framework. Built as a factory so
// it reuses the application's auth, authorization and error middleware. Mounted
// at /api/classification and /api/v1/classification.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
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

export function createClassificationRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => can(R.overview, a);
  const canClassifications = (a) => can(R.classifications, a);
  const canClasses = (a) => can(R.classes, a);
  const canCharacteristics = (a) => can(R.characteristics, a);
  const canGroups = (a) => can(R.groups, a);
  const canValues = (a) => can(R.values, a);
  const canAssignments = (a) => can(R.assignments, a);
  const canValidation = (a) => can(R.validation, a);
  const canSearch = (a) => can(R.search, a);
  const canGovernance = (a) => can(R.governance, a);
  const canAudit = (a) => can(R.auditTrail, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Metrics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.classificationHealth(db, tenantOf(req)) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/coverage",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.coverageReport(db, { tenantId: tenantOf(req), objectType: req.query.object_type || req.query.objectType, totalObjects: req.query.total_objects ?? req.query.totalObjects })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/config",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req))))
  );
  const setConfig = wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Classifications ───────────────────────────────────────────────────────
  router.get(
    "/classifications",
    auth,
    canClassifications("read"),
    wrap((req, res) => res.json(Definitions.listClassifications(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/classifications",
    auth,
    canClassifications("create"),
    wrap((req, res) => res.status(201).json(Definitions.createClassification(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/classifications/:ref",
    auth,
    canClassifications("read"),
    wrap((req, res) => res.json(Definitions.getClassification(db, tenantOf(req), req.params.ref)))
  );
  const updateClassification = wrap((req, res) => res.json(Definitions.updateClassification(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/classifications/:ref", auth, canClassifications("update"), updateClassification);
  router.patch("/classifications/:ref", auth, canClassifications("update"), updateClassification);
  router.post(
    "/classifications/:ref/status",
    auth,
    canClassifications("update"),
    wrap((req, res) => res.json(Definitions.setClassificationStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/classifications/:ref/approve",
    auth,
    canClassifications("update"),
    wrap((req, res) => res.json(Definitions.approveClassification(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.delete(
    "/classifications/:ref",
    auth,
    canClassifications("delete"),
    wrap((req, res) => res.json(Definitions.deleteClassification(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/classifications/:ref/versions",
    auth,
    canClassifications("read"),
    wrap((req, res) => res.json(Definitions.listClassificationVersions(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classifications/:ref/versions",
    auth,
    canClassifications("update"),
    wrap((req, res) => res.status(201).json(Definitions.createClassificationVersion(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || req.body?.changeReason, actor: req.actor })))
  );
  router.get(
    "/classifications/:ref/audit",
    auth,
    canAudit("read"),
    wrap((req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(Definitions.listClassificationAudit(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get(
    "/classifications/:ref/tree",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.classTree(db, tenantOf(req), req.params.ref, { status: req.query.status || null })))
  );
  router.post(
    "/classifications/:ref/reorder-classes",
    auth,
    canClasses("update"),
    wrap((req, res) => res.json(Hierarchy.reorderClasses(db, tenantOf(req), { classificationId: req.params.ref, parentClassId: req.body?.parent_class_id ?? null, orderedIds: req.body?.ordered_ids || req.body?.orderedIds || [] }, req.actor, req.ip)))
  );

  // ── Classes ───────────────────────────────────────────────────────────────
  router.get(
    "/classes",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.listClasses(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/classes",
    auth,
    canClasses("create"),
    wrap((req, res) => res.status(201).json(Hierarchy.createClass(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/classes/:ref",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.getClass(db, tenantOf(req), req.params.ref)))
  );
  const updateClass = wrap((req, res) => res.json(Hierarchy.updateClass(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/classes/:ref", auth, canClasses("update"), updateClass);
  router.patch("/classes/:ref", auth, canClasses("update"), updateClass);
  router.post(
    "/classes/:ref/status",
    auth,
    canClasses("update"),
    wrap((req, res) => res.json(Hierarchy.setClassStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/move",
    auth,
    canClasses("update"),
    wrap((req, res) => res.json(Hierarchy.moveClass(db, tenantOf(req), req.params.ref, { parentClassId: req.body?.parent_class_id ?? req.body?.parentClassId ?? null, sortOrder: req.body?.sort_order ?? req.body?.sortOrder ?? null }, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/copy",
    auth,
    canClasses("create"),
    wrap((req, res) => res.status(201).json(Hierarchy.copyClass(db, tenantOf(req), req.params.ref, { targetClassificationId: req.body?.target_classification_id ?? null, targetParentClassId: req.body?.target_parent_class_id ?? null, codeSuffix: req.body?.code_suffix || "_COPY" }, req.actor, req.ip)))
  );
  router.delete(
    "/classes/:ref",
    auth,
    canClasses("delete"),
    wrap((req, res) => res.json(Hierarchy.deleteClass(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/classes/:ref/children",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.classChildren(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/ancestors",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.classAncestors(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/descendants",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.classDescendants(db, tenantOf(req), req.params.ref, { includeSelf: String(req.query.include_self || "") === "true" })))
  );
  router.get(
    "/classes/:ref/versions",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Hierarchy.listClassVersions(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classes/:ref/versions",
    auth,
    canClasses("update"),
    wrap((req, res) => res.status(201).json(Hierarchy.createClassVersion(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || "", actor: req.actor })))
  );
  router.get(
    "/classes/:ref/effective",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Inheritance.resolveEffectiveCharacteristics(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/classes/:ref/characteristics",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Characteristics.listClassCharacteristics(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/classes/:ref/characteristics",
    auth,
    canClasses("update"),
    wrap((req, res) => res.status(201).json(Characteristics.addClassCharacteristic(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/classes/:ref/validate",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(ValidationService.validateClassValues(db, tenantOf(req), req.params.ref, req.body?.values ?? req.body ?? {}, { partial: req.body?.partial === true })))
  );
  router.get(
    "/classes/:ref/approved-values",
    auth,
    canClasses("read"),
    wrap((req, res) => res.json(Inheritance.validateAllowedValueModes(db, tenantOf(req), req.params.ref)))
  );

  const updateClassCharacteristic = wrap((req, res) => res.json(Characteristics.updateClassCharacteristic(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/class-characteristics/:ref", auth, canClasses("update"), updateClassCharacteristic);
  router.patch("/class-characteristics/:ref", auth, canClasses("update"), updateClassCharacteristic);
  router.delete(
    "/class-characteristics/:ref",
    auth,
    canClasses("update"),
    wrap((req, res) => res.json(Characteristics.removeClassCharacteristic(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Characteristics ───────────────────────────────────────────────────────
  router.get(
    "/characteristics",
    auth,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Characteristics.listCharacteristics(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/characteristics",
    auth,
    canCharacteristics("create"),
    wrap((req, res) => res.status(201).json(Characteristics.createCharacteristic(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/characteristics/:ref",
    auth,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Characteristics.getCharacteristic(db, tenantOf(req), req.params.ref)))
  );
  const updateCharacteristic = wrap((req, res) => res.json(Characteristics.updateCharacteristic(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/characteristics/:ref", auth, canCharacteristics("update"), updateCharacteristic);
  router.patch("/characteristics/:ref", auth, canCharacteristics("update"), updateCharacteristic);
  router.post(
    "/characteristics/:ref/status",
    auth,
    canCharacteristics("update"),
    wrap((req, res) => res.json(Characteristics.setCharacteristicStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.delete(
    "/characteristics/:ref",
    auth,
    canCharacteristics("delete"),
    wrap((req, res) => res.json(Characteristics.deleteCharacteristic(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/characteristics/:ref/versions",
    auth,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Characteristics.listCharacteristicVersions(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/characteristics/:ref/versions",
    auth,
    canCharacteristics("update"),
    wrap((req, res) => res.status(201).json(Characteristics.createCharacteristicVersion(db, tenantOf(req), req.params.ref, { changeReason: req.body?.change_reason || "", actor: req.actor })))
  );
  router.get(
    "/characteristics/:ref/allowed-values",
    auth,
    canValues("read"),
    wrap((req, res) => res.json(Characteristics.listAllowedValues(db, tenantOf(req), req.params.ref, { status: req.query.status || null, q: req.query.q || null })))
  );
  router.post(
    "/characteristics/:ref/allowed-values",
    auth,
    canValues("create"),
    wrap((req, res) => res.status(201).json(Characteristics.createAllowedValue(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  const updateAllowedValue = wrap((req, res) => res.json(Characteristics.updateAllowedValue(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/allowed-values/:ref", auth, canValues("update"), updateAllowedValue);
  router.patch("/allowed-values/:ref", auth, canValues("update"), updateAllowedValue);
  router.delete(
    "/allowed-values/:ref",
    auth,
    canValues("delete"),
    wrap((req, res) => res.json(Characteristics.deleteAllowedValue(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Characteristic groups ─────────────────────────────────────────────────
  router.get(
    "/groups",
    auth,
    canGroups("read"),
    wrap((req, res) => res.json(Characteristics.listGroups(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/groups",
    auth,
    canGroups("create"),
    wrap((req, res) => res.status(201).json(Characteristics.createGroup(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  const updateGroup = wrap((req, res) => res.json(Characteristics.updateGroup(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/groups/:ref", auth, canGroups("update"), updateGroup);
  router.patch("/groups/:ref", auth, canGroups("update"), updateGroup);
  router.delete(
    "/groups/:ref",
    auth,
    canGroups("delete"),
    wrap((req, res) => res.json(Characteristics.deleteGroup(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/groups/:ref/members",
    auth,
    canGroups("read"),
    wrap((req, res) => res.json(Characteristics.listGroupMembers(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/groups/:ref/members",
    auth,
    canGroups("update"),
    wrap((req, res) => res.status(201).json(Characteristics.addGroupMember(db, tenantOf(req), req.params.ref, req.body?.characteristic_id ?? req.body?.characteristicId ?? req.body?.characteristic, { sequence: req.body?.sequence ?? null }, req.actor, req.ip)))
  );
  router.delete(
    "/groups/:ref/members/:characteristicRef",
    auth,
    canGroups("update"),
    wrap((req, res) => res.json(Characteristics.removeGroupMember(db, tenantOf(req), req.params.ref, req.params.characteristicRef)))
  );

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get(
    "/rules",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(Rules.listRules(db, tenantOf(req), { classId: req.query.class_id ?? req.query.classId, characteristicId: req.query.characteristic_id ?? req.query.characteristicId, ruleType: req.query.rule_type ?? req.query.ruleType, status: req.query.status })))
  );
  router.post(
    "/rules",
    auth,
    canValidation("update"),
    wrap((req, res) => res.status(201).json(Rules.createRule(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  const updateRule = wrap((req, res) => res.json(Rules.updateRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", auth, canValidation("update"), updateRule);
  router.patch("/rules/:ref", auth, canValidation("update"), updateRule);
  router.delete(
    "/rules/:ref",
    auth,
    canValidation("update"),
    wrap((req, res) => res.json(Rules.deleteRule(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Assignments ───────────────────────────────────────────────────────────
  router.get(
    "/assignments",
    auth,
    canAssignments("read"),
    wrap((req, res) => res.json(Assignments.listAssignments(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/assignments",
    auth,
    canAssignments("create"),
    wrap((req, res) => res.status(201).json(Assignments.assignClass(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/assignments/:ref",
    auth,
    canAssignments("read"),
    wrap((req, res) => res.json(Assignments.getAssignment(db, tenantOf(req), req.params.ref)))
  );
  router.put(
    "/assignments/:ref/values",
    auth,
    canAssignments("update"),
    wrap((req, res) => res.json(Assignments.setAssignmentValues(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/values",
    auth,
    canAssignments("update"),
    wrap((req, res) => res.json(Assignments.setAssignmentValues(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/status",
    auth,
    canAssignments("update"),
    wrap((req, res) => res.json(Assignments.setAssignmentStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/reclassify",
    auth,
    canAssignments("update"),
    wrap((req, res) => res.json(Assignments.reclassify(db, tenantOf(req), req.params.ref, { classId: req.body?.class_id ?? req.body?.classId, values: req.body?.values, validate: req.body?.validate !== false }, req.actor, req.ip)))
  );
  router.post(
    "/assignments/:ref/validate",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(Assignments.validateAssignment(db, tenantOf(req), req.params.ref)))
  );
  router.delete(
    "/assignments/:ref",
    auth,
    canAssignments("delete"),
    wrap((req, res) => res.json(Assignments.unassign(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Object-centric read/validate contract ─────────────────────────────────
  router.get(
    "/objects/:objectType/:objectId",
    auth,
    canAssignments("read"),
    wrap((req, res) => res.json(Assignments.objectClassifications(db, tenantOf(req), req.params.objectType, req.params.objectId, { includeInactive: String(req.query.include_inactive || "") === "true" })))
  );
  router.get(
    "/objects/:objectType/:objectId/values",
    auth,
    canAssignments("read"),
    wrap((req, res) => res.json(Assignments.resolveObjectValues(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );
  router.get(
    "/objects/:objectType/:objectId/effective",
    auth,
    canAssignments("read"),
    wrap((req, res) => res.json({ items: Assignments.effectiveCharacteristicsForObject(db, tenantOf(req), req.params.objectType, req.params.objectId) }))
  );
  router.post(
    "/objects/:objectType/:objectId/validate",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(ValidationService.validateObject(db, tenantOf(req), { objectType: req.params.objectType, objectId: req.params.objectId })))
  );
  router.post(
    "/objects/:objectType/validate-batch",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(ValidationService.validateBatch(db, tenantOf(req), { objectType: req.params.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [] })))
  );

  // ── Duplicate detection ───────────────────────────────────────────────────
  router.post(
    "/duplicates/scan",
    auth,
    canGovernance("read"),
    wrap((req, res) => res.json(Duplicates.detectClassificationDuplicates(db, { tenantId: tenantOf(req), classRef: req.body?.class_id ?? req.body?.classRef ?? null, objectType: req.body?.object_type ?? null, threshold: req.body?.threshold ?? null, actor: req.actor })))
  );
  router.get(
    "/duplicates/summary",
    auth,
    canGovernance("read"),
    wrap((req, res) => res.json(Duplicates.duplicateSummary(db, { tenantId: tenantOf(req) })))
  );

  // ── Units ─────────────────────────────────────────────────────────────────
  router.get(
    "/units",
    auth,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Units.listUnits(db, { tenantId: tenantOf(req), uomClass: req.query.uom_class ?? null, q: req.query.q || null })))
  );
  router.post(
    "/units/convert",
    auth,
    canCharacteristics("read"),
    wrap((req, res) => res.json(Units.convertValue(req.body?.value, req.body?.from_unit ?? req.body?.fromUnit, req.body?.to_unit ?? req.body?.toUnit, { units: Units.listUnits(db, { tenantId: tenantOf(req), limit: 2000 }) })))
  );

  // ── History & lineage ─────────────────────────────────────────────────────
  router.get(
    "/history",
    auth,
    canAudit("read"),
    wrap((req, res) => res.json(History.listHistory(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/lineage/:objectType/:objectId",
    auth,
    canAudit("read"),
    wrap((req, res) => res.json(History.objectLineage(db, tenantOf(req), req.params.objectType, req.params.objectId)))
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.post(
    "/jobs/bulk-assign",
    auth,
    canAssignments("update"),
    wrap((req, res) => res.status(202).json(Jobs.submitBulkAssignJob(db, { tenantId: tenantOf(req), classId: req.body?.class_id ?? req.body?.classId, objectType: req.body?.object_type ?? req.body?.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [], values: req.body?.values || null, action: req.body?.action || "ASSIGN", actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/bulk-validate",
    auth,
    canValidation("read"),
    wrap((req, res) => res.status(202).json(Jobs.submitBulkValidateJob(db, { tenantId: tenantOf(req), objectType: req.body?.object_type ?? req.body?.objectType, objectIds: req.body?.object_ids || req.body?.objectIds || [], actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/duplicate-scan",
    auth,
    canGovernance("read"),
    wrap((req, res) => res.status(202).json(Jobs.submitDuplicateScanJob(db, { tenantId: tenantOf(req), classRef: req.body?.class_id ?? req.body?.classRef ?? null, objectType: req.body?.object_type ?? null, threshold: req.body?.threshold ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );
  router.post(
    "/jobs/maintenance",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.status(202).json(Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })))
  );

  // ── Seed ──────────────────────────────────────────────────────────────────
  router.post(
    "/seed",
    auth,
    canAdmin("create"),
    wrap((req, res) => res.json(Seed.seedClassification(db, tenantOf(req))))
  );

  return router;
}
