process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { HttpError } from "../validation.js";
import * as constants from "../services/classification/constants.js";
import * as Errors from "../services/classification/errors.js";
import * as Refs from "../services/classification/refs.js";
import * as Validation from "../services/classification/validation.js";
import * as Configuration from "../services/classification/configuration.js";
import * as Units from "../services/classification/units.js";
import * as Foundation from "../services/classification/foundation.js";
import * as Index from "../services/classification/index.js";

const TENANT = 1;

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the function to throw");
}

describe("classification constants", () => {
  test("declares the owning source module", () => {
    assert.equal(constants.SOURCE_MODULE, "classification");
  });

  test("exposes lifecycle vocabularies as arrays", () => {
    assert.ok(constants.CLASSIFICATION_STATUSES.includes("DRAFT"));
    assert.ok(constants.CLASSIFICATION_STATUSES.includes("OBSOLETE"));
    assert.ok(constants.CLASS_STATUSES.includes("ACTIVE"));
    assert.ok(constants.APPROVAL_STATUSES.includes("APPROVED"));
    assert.deepEqual(constants.ASSIGNABLE_STATUSES, ["ACTIVE"]);
    for (const key of ["CLASSIFICATION_STATUSES", "CLASS_STATUSES", "APPROVAL_STATUSES", "CHARACTERISTIC_DATA_TYPES", "CHARACTERISTIC_STATUSES", "CHARACTERISTIC_ORIGINS", "ALLOWED_VALUE_MODES", "RULE_TYPES", "RULE_SEVERITIES", "ASSIGNMENT_STATUSES", "SEARCH_OBJECT_TYPES", "CLASSIFICATION_JOB_TYPES", "CLASSIFICATION_EVENT_TYPES", "SECURITY_ACTIONS"]) {
      assert.ok(Array.isArray(constants[key]), `${key} must be an array`);
    }
  });

  test("exposes the spec's characteristic data types", () => {
    for (const type of ["STRING", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "ENUMERATION", "REFERENCE", "UNIT_NUMERIC"]) {
      assert.ok(constants.CHARACTERISTIC_DATA_TYPES.includes(type), `missing data type ${type}`);
    }
  });

  test("freezes configuration defaults and resources", () => {
    assert.ok(Object.isFrozen(constants.CONFIG_DEFAULTS));
    assert.ok(Object.isFrozen(constants.CLASSIFICATION_RESOURCES));
    assert.ok(Object.isFrozen(constants.CONFIG_BOUNDS));
    assert.equal(constants.CLASSIFICATION_RESOURCES.module, "iam.classification");
    assert.equal(constants.CLASSIFICATION_RESOURCES.admin, "iam.classification.admin");
    assert.equal(constants.CONFIG_DEFAULTS.allow_multiple_classification, true);
    assert.equal(constants.CONFIG_DEFAULTS.duplicate_similarity_threshold, 0.85);
  });

  test("describes CONFIG_BOUNDS consistently with CONFIG_DEFAULTS", () => {
    for (const [key, bounds] of Object.entries(constants.CONFIG_BOUNDS)) {
      assert.equal(typeof bounds.min, "number", key);
      assert.equal(typeof bounds.max, "number", key);
      assert.ok(bounds.max >= bounds.min, key);
      assert.ok(Object.prototype.hasOwnProperty.call(constants.CONFIG_DEFAULTS, key), `${key} has no default`);
    }
  });

  test("declares the four background handlers and search types", () => {
    assert.equal(constants.CLASSIFICATION_HANDLER_CODES.BULK_ASSIGN, "classification.bulkAssign");
    assert.equal(constants.CLASSIFICATION_HANDLER_CODES.BULK_VALIDATE, "classification.bulkValidate");
    assert.equal(constants.CLASSIFICATION_HANDLER_CODES.DUPLICATE_SCAN, "classification.duplicateScan");
    assert.equal(constants.CLASSIFICATION_HANDLER_CODES.MAINTENANCE, "classification.maintenance");
    const codes = constants.CLASSIFICATION_JOB_TYPES.map((job) => job.code);
    assert.deepEqual(codes, ["CLASSIFICATION_BULK_ASSIGN", "CLASSIFICATION_BULK_VALIDATE", "CLASSIFICATION_DUPLICATE_SCAN", "CLASSIFICATION_MAINTENANCE"]);
    const searchTypes = constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code);
    assert.deepEqual(searchTypes, ["classification", "classification_class", "classification_assignment"]);
  });
});

describe("classification errors", () => {
  test("ClassificationError is an HttpError carrying status, code and details", () => {
    const error = Errors.classificationNotFound("CLA_X");
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.code, Errors.CLASSIFICATION_ERROR_CODES.CLASSIFICATION_NOT_FOUND);
    assert.deepEqual(error.details, { ref: "CLA_X" });
  });

  test("key factories produce stable statuses and codes", () => {
    assert.equal(Errors.classificationConflict("A").status, 409);
    assert.equal(Errors.invalidClass("x").status, 400);
    assert.equal(Errors.classCycle({}).status, 409);
    assert.equal(Errors.classDepthExceeded(8).status, 422);
    assert.equal(Errors.characteristicNotFound("X").code, "CLASSIFICATION_CHARACTERISTIC_NOT_FOUND");
    assert.equal(Errors.singleClassOnly("product").code, "CLASSIFICATION_SINGLE_CLASS_ONLY");
    assert.equal(Errors.validationFailed({}).code, "CLASSIFICATION_VALIDATION_FAILED");
    assert.equal(Errors.incompatibleUnit({}).status, 422);
    assert.equal(Errors.invalidConfiguration("bad").status, 400);
  });
});

describe("classification refs", () => {
  test("builds safe human-readable references", () => {
    assert.equal(Refs.classificationRef("MECH_COMPONENTS"), "CLA-MECH_COMPONENTS");
    assert.equal(Refs.classRef("PUMP"), "CLS-PUMP");
    assert.equal(Refs.characteristicRef("flow rate"), "CHR-FLOW_RATE");
    assert.equal(Refs.ruleRef("pressure range"), "CLR-PRESSURE_RANGE");
    assert.match(Refs.assignmentRef("product", "P-1"), /^CLA-ASN-PRODUCT-P-1-[0-9a-f]{12}$/);
  });

  test("slug strips unsafe characters and falls back to a random id", () => {
    assert.equal(Refs.slug("a/b c"), "A_B_C");
    assert.match(Refs.classificationRef(""), /^CLA-[0-9a-f]{12}$/);
    assert.equal(Refs.shortId().length, 12);
  });
});

describe("classification validation helpers", () => {
  test("assertEnum helpers reject unknown vocabulary members", () => {
    assert.equal(Validation.assertClassificationStatus("active"), "ACTIVE");
    assert.equal(Validation.assertClassStatus("draft"), "DRAFT");
    assert.equal(Validation.assertDataType("unit_numeric"), "UNIT_NUMERIC");
    assert.equal(Validation.assertOrigin("inherited"), "INHERITED");
    assert.equal(Validation.assertAllowedValueMode("restrict"), "RESTRICT");
    assert.equal(Validation.assertSeverity("warning"), "WARNING");
    assert.equal(Validation.assertAssignmentStatus("active"), "ACTIVE");
    assert.equal(thrownBy(() => Validation.assertClassificationStatus("NOPE")).status, 400);
    assert.equal(thrownBy(() => Validation.assertDataType("MAGIC")).status, 400);
  });

  test("normalizeCharacteristicInput enforces type-specific requirements", () => {
    const unitNumeric = Validation.normalizeCharacteristicInput({ code: "flow", data_type: "UNIT_NUMERIC", unit: "L/MIN" });
    assert.equal(unitNumeric.code, "FLOW");
    assert.equal(unitNumeric.base_unit, "L/MIN");

    assert.equal(thrownBy(() => Validation.normalizeCharacteristicInput({ code: "x", data_type: "UNIT_NUMERIC" })).status, 400);
    assert.equal(thrownBy(() => Validation.normalizeCharacteristicInput({ code: "x", data_type: "REFERENCE" })).status, 400);
    assert.equal(thrownBy(() => Validation.normalizeCharacteristicInput({ name: "no code" })).status, 400);
    assert.equal(thrownBy(() => Validation.normalizeCharacteristicInput({ code: "x", data_type: "INTEGER", min_value: 10, max_value: 1 })).status, 400);
    assert.equal(thrownBy(() => Validation.normalizeCharacteristicInput({ code: "x", data_type: "STRING", min_value: 1 })).status, 400);

    const reference = Validation.normalizeCharacteristicInput({ code: "ref", data_type: "REFERENCE", reference_type: "part" });
    assert.equal(reference.reference_type, "part");
  });

  test("coerceCharacteristicValue validates type, bounds and allowed values", () => {
    const integer = { data_type: "INTEGER", min_value: 0, max_value: 10, min_inclusive: true, max_inclusive: true };
    assert.equal(Validation.coerceCharacteristicValue(integer, 5).valid, true);
    assert.equal(Validation.coerceCharacteristicValue(integer, 11).valid, false);
    assert.equal(Validation.coerceCharacteristicValue(integer, "abc").valid, false);

    const bool = { data_type: "BOOLEAN" };
    assert.equal(Validation.coerceCharacteristicValue(bool, true).value_boolean, true);
    assert.equal(Validation.coerceCharacteristicValue(bool, "maybe").valid, false);

    const enumeration = { data_type: "ENUMERATION" };
    assert.equal(Validation.coerceCharacteristicValue(enumeration, "RED", { allowedCodes: ["RED", "BLUE"] }).valid, true);
    assert.equal(Validation.coerceCharacteristicValue(enumeration, "GREEN", { allowedCodes: ["RED", "BLUE"] }).valid, false);

    const date = { data_type: "DATE" };
    assert.equal(Validation.coerceCharacteristicValue(date, "2026-02-04").valid, true);
    assert.equal(Validation.coerceCharacteristicValue(date, "not-a-date").valid, false);
  });

  test("orderClause restricts to the allow-list", () => {
    assert.equal(Validation.orderClause("name", { allowed: ["name"], default: "code" }).clause, "name DESC");
    assert.equal(Validation.orderClause("evil", { allowed: ["name"], default: "code" }).clause, "code DESC");
    assert.equal(Validation.orderClause("name", { allowed: ["name"], default: "code", direction: "ASC" }).clause, "name ASC");
  });

  test("vocabulary exposes every editable enumeration", () => {
    const vocab = Validation.vocabulary();
    for (const key of ["classification_statuses", "class_statuses", "approval_statuses", "characteristic_data_types", "characteristic_statuses", "characteristic_origins", "allowed_value_modes", "rule_types", "rule_severities", "assignment_statuses"]) {
      assert.ok(Array.isArray(vocab[key]), key);
    }
  });

  test("assertConfigurationValue enforces known keys and bounds", () => {
    assert.equal(Validation.assertConfigurationValue("allow_multiple_classification", "false"), false);
    assert.equal(Validation.assertConfigurationValue("max_hierarchy_depth", 8), 8);
    assert.equal(thrownBy(() => Validation.assertConfigurationValue("does_not_exist", 1)).status, 400);
    assert.equal(thrownBy(() => Validation.assertConfigurationValue("max_hierarchy_depth", 0)).status, 400);
    assert.equal(thrownBy(() => Validation.assertConfigurationValue("duplicate_similarity_threshold", 2)).status, 400);
  });
});

describe("classification foundation (db backed)", () => {
  let db;
  let actor;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor = { id: row.id, username: row.username };
  });

  after(() => db?.close());

  test("ensureClassificationFoundation is idempotent and registers platform seams", () => {
    const first = Foundation.ensureClassificationFoundation(db);
    assert.equal(first.source_module, "classification");
    assert.equal(first.units.domain, constants.UNIT_DOMAIN_CODE);
    assert.ok(typeof first.units.created === "number");
    assert.ok(typeof first.job_types === "number");
    assert.ok(first.duplicate_strategies !== undefined);
    assert.equal(typeof first.event_types, "number");

    const jobCodes = constants.CLASSIFICATION_JOB_TYPES.map((def) => def.code);
    const registeredJobs = queryOne(
      db,
      `SELECT COUNT(*) AS c FROM job_types WHERE code IN (${jobCodes.map(() => "?").join(",")})`,
      jobCodes,
    ).c;
    assert.equal(registeredJobs, jobCodes.length);

    const second = Foundation.ensureClassificationFoundation(db);
    assert.equal(second.units.created, 0);
    assert.equal(second.job_types, 0);
  });

  test("classificationHealth reports per-table counts", () => {
    const health = Foundation.classificationHealth(db, TENANT);
    assert.equal(health.source_module, "classification");
    for (const key of ["classifications", "classes", "characteristics", "allowed_values", "assignments", "rules", "history"]) {
      assert.equal(typeof health.counts[key], "number", key);
    }
  });

  test("configuration defaults are installed and settable per tenant", () => {
    const config = Configuration.listConfig(db, TENANT);
    assert.equal(config.max_hierarchy_depth, 64);
    assert.equal(config.duplicate_similarity_threshold, 0.85);

    Configuration.setConfig(db, TENANT, "max_hierarchy_depth", 12, actor);
    assert.equal(Configuration.getConfig(db, TENANT, "max_hierarchy_depth"), 12);
    Configuration.setConfig(db, TENANT, "max_hierarchy_depth", 64, actor);
  });

  test("units live in the shared reference domain and convert within a class", () => {
    const units = Units.listUnits(db, { limit: 2000 });
    assert.ok(units.some((unit) => unit.code === "KG"));
    assert.ok(units.some((unit) => unit.code === "MM"));

    const converted = Units.convertValue(1, "KG", "G", { units });
    assert.equal(converted.compatible, true);
    assert.equal(converted.value, 1000);

    assert.throws(() => Units.convertValue(1, "KG", "M", { units }), (error) => error.status === 422);
  });

  test("the facade exposes the flat SDK surface", () => {
    for (const fn of ["createClassification", "createClass", "createCharacteristic", "assignClass", "validateClassValues", "createRule", "detectDuplicates", "listUnits", "submitBulkAssignJob", "metrics", "health"]) {
      assert.equal(typeof Index.Classification[fn], "function", fn);
    }
    for (const fn of ["ensureClassificationFoundation", "seedClassification", "ensureClassificationJobTypes", "registerClassificationHandlers"]) {
      assert.equal(typeof Index[fn], "function", fn);
    }
  });
});
