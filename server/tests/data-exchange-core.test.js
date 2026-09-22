process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { getEventTypeRow } from "../services/events/registry.js";
import { createFieldRule } from "../services/security/repository.js";
import * as constants from "../services/data-exchange/constants.js";
import * as Errors from "../services/data-exchange/errors.js";
import * as Refs from "../services/data-exchange/refs.js";
import * as Validation from "../services/data-exchange/validation.js";
import * as Configuration from "../services/data-exchange/configuration.js";
import * as Events from "../services/data-exchange/events.js";
import * as History from "../services/data-exchange/history.js";
import * as Metrics from "../services/data-exchange/metrics.js";
import * as Security from "../services/data-exchange/security.js";
import * as Repository from "../services/data-exchange/repository.js";
import * as Foundation from "../services/data-exchange/foundation.js";
import * as Index from "../services/data-exchange/index.js";

const TENANT = 1;

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the function to throw");
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return { id: row.id, username: row.username };
}

describe("data-exchange constants", () => {
  test("declares the owning source module", () => {
    assert.equal(constants.SOURCE_MODULE, "data-exchange");
  });

  test("exposes the expected vocabulary members as arrays", () => {
    assert.deepEqual(constants.DIRECTIONS, ["IMPORT", "EXPORT"]);
    for (const expected of ["CSV", "EXCEL", "JSON", "XML", "REST", "DATABASE", "FILE", "CLOUD_STORAGE", "LEGACY_PLM", "ERP", "CAD", "MES"]) {
      assert.ok(constants.CONNECTOR_TYPES.includes(expected), `missing connector ${expected}`);
    }
    assert.ok(constants.EXECUTION_MODES.includes("DRY_RUN"));
    assert.ok(constants.DUPLICATE_STRATEGIES.includes("UPSERT"));
    assert.ok(constants.EXPORT_FORMATS.includes("CSV"));
    assert.ok(constants.EXPORT_DESTINATIONS.includes("DOWNLOAD"));
    assert.ok(constants.VALIDATION_LEVELS.includes("SECURITY"));
    assert.ok(constants.TRANSFORMATION_TYPES.includes("EXPRESSION"));
    assert.ok(constants.SECURITY_ACTIONS.includes("EXECUTE_EXPORT"));
    for (const key of ["DIRECTIONS", "CONNECTOR_TYPES", "EXECUTION_MODES", "DUPLICATE_STRATEGIES", "EXPORT_FORMATS", "VALIDATION_LEVELS"]) {
      assert.ok(Array.isArray(constants[key]), `${key} must be an array`);
    }
  });

  test("freezes the tuning/reference objects", () => {
    for (const key of ["CONFIG_DEFAULTS", "CONFIG_BOUNDS", "EXCHANGE_RESOURCES", "EXCHANGE_HANDLER_CODES"]) {
      assert.ok(Object.isFrozen(constants[key]), `${key} must be frozen`);
    }
    assert.equal(constants.EXCHANGE_HANDLER_CODES.IMPORT, "dataExchange.import");
    assert.equal(constants.EXCHANGE_HANDLER_CODES.MAINTENANCE, "dataExchange.maintenance");
    assert.equal(constants.EXCHANGE_RESOURCES.module, "iam.data_exchange");
    assert.equal(constants.EXCHANGE_RESOURCES.admin, "iam.data_exchange.admin");
  });

  test("describes CONFIG_BOUNDS consistently with CONFIG_DEFAULTS", () => {
    assert.deepEqual(constants.CONFIG_BOUNDS.quality_min_score, { min: 0, max: 100 });
    assert.deepEqual(constants.CONFIG_BOUNDS.default_batch_size, { min: 1, max: 50000 });
    for (const [key, bounds] of Object.entries(constants.CONFIG_BOUNDS)) {
      assert.equal(typeof bounds.min, "number", key);
      assert.equal(typeof bounds.max, "number", key);
      assert.ok(bounds.max >= bounds.min, key);
      assert.ok(Object.prototype.hasOwnProperty.call(constants.CONFIG_DEFAULTS, key), `${key} has no default`);
      const value = constants.CONFIG_DEFAULTS[key];
      assert.ok(value >= bounds.min && value <= bounds.max, `${key} default is out of bounds`);
    }
  });

  test("registers job types and event types owned by the module", () => {
    assert.ok(Array.isArray(constants.EXCHANGE_JOB_TYPES));
    assert.ok(constants.EXCHANGE_JOB_TYPES.length >= 1);
    for (const job of constants.EXCHANGE_JOB_TYPES) {
      assert.equal(job.source_module, constants.SOURCE_MODULE);
      assert.equal(typeof job.code, "string");
      assert.ok(Object.values(constants.EXCHANGE_HANDLER_CODES).includes(job.handler));
    }
    assert.ok(constants.EXCHANGE_EVENT_TYPES.some((event) => event.code === "ImportStarted"));
  });
});

describe("data-exchange error factories", () => {
  const CASES = [
    ["definitionNotFound", "DEFINITION_NOT_FOUND", 404],
    ["definitionConflict", "DEFINITION_CONFLICT", 409],
    ["invalidDefinition", "INVALID_DEFINITION", 400],
    ["definitionImmutable", "DEFINITION_IMMUTABLE", 409],
    ["connectorNotFound", "CONNECTOR_NOT_FOUND", 404],
    ["connectorUnsupported", "CONNECTOR_UNSUPPORTED", 400],
    ["invalidConnector", "INVALID_CONNECTOR", 400],
    ["connectorFailed", "CONNECTOR_FAILED", 502],
    ["connectionFailed", "CONNECTION_FAILED", 502],
    ["invalidMapping", "INVALID_MAPPING", 400],
    ["mappingBlocked", "MAPPING_BLOCKED", 422],
    ["invalidTransformation", "INVALID_TRANSFORMATION", 400],
    ["transformationFailed", "TRANSFORMATION_FAILED", 422],
    ["invalidExpression", "INVALID_EXPRESSION", 400],
    ["invalidLookup", "INVALID_LOOKUP", 400],
    ["invalidValidation", "INVALID_VALIDATION", 400],
    ["validationFailed", "VALIDATION_FAILED", 422],
    ["jobNotFound", "JOB_NOT_FOUND", 404],
    ["jobConflict", "JOB_CONFLICT", 409],
    ["jobFailed", "JOB_FAILED", 500],
    ["jobNotCancellable", "JOB_NOT_CANCELLABLE", 409],
    ["jobNotRetryable", "JOB_NOT_RETRYABLE", 409],
    ["invalidMode", "INVALID_MODE", 400],
    ["invalidDuplicateStrategy", "INVALID_DUPLICATE_STRATEGY", 400],
    ["duplicateRecord", "DUPLICATE_RECORD", 409],
    ["recordFailed", "RECORD_FAILED", 422],
    ["batchFailed", "BATCH_FAILED", 500],
    ["reconciliationNotFound", "RECONCILIATION_NOT_FOUND", 404],
    ["invalidReconciliation", "INVALID_RECONCILIATION", 400],
    ["resultNotFound", "RESULT_NOT_FOUND", 404],
    ["resultExpired", "RESULT_EXPIRED", 410],
    ["invalidExport", "INVALID_EXPORT", 400],
    ["exportTooLarge", "EXPORT_TOO_LARGE", 422],
    ["invalidDestination", "INVALID_DESTINATION", 400],
    ["invalidFormat", "INVALID_FORMAT", 400],
    ["schemaDiscoveryFailed", "SCHEMA_DISCOVERY_FAILED", 422],
    ["qualityBlocked", "QUALITY_BLOCKED", 422],
    ["lifecycleBlocked", "LIFECYCLE_BLOCKED", 409],
    ["securityBlocked", "SECURITY_BLOCKED", 403],
    ["storageFailed", "STORAGE_FAILED", 502],
    ["invalidTemplate", "INVALID_TEMPLATE", 400],
    ["templateNotFound", "TEMPLATE_NOT_FOUND", 404],
    ["invalidConfiguration", "INVALID_CONFIGURATION", 400],
    ["exchangeConflict", "CONFLICT", 409],
  ];

  test("every factory returns a DataExchangeError with status, stable code and details", () => {
    for (const [name, codeKey, status] of CASES) {
      const factory = Errors[name];
      assert.equal(typeof factory, "function", `${name} is not exported`);
      const error = factory("sample-ref", { extra: true });
      assert.ok(error instanceof Errors.DataExchangeError, name);
      assert.equal(error.status, status, name);
      assert.equal(error.code, Errors.EXCHANGE_ERROR_CODES[codeKey], name);
      assert.ok("details" in error, `${name} has no details property`);
    }
  });

  test("thrown exchange errors carry the code the HTTP layer serializes", () => {
    const expired = thrownBy(() => {
      throw Errors.resultExpired("IE-RES-1");
    });
    assert.equal(expired.status, 410);
    assert.equal(expired.code, "DATA_EXCHANGE_RESULT_EXPIRED");
    assert.deepEqual(expired.details, { ref: "IE-RES-1" });

    const blocked = thrownBy(() => {
      throw Errors.securityBlocked({ action: "read" });
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.code, Errors.EXCHANGE_ERROR_CODES.SECURITY_BLOCKED);
  });
});

describe("data-exchange refs", () => {
  test("shortId produces distinct 12-character hex identifiers", () => {
    assert.match(Refs.shortId(), /^[0-9a-f]{12}$/);
    assert.notEqual(Refs.shortId(), Refs.shortId());
  });

  test("slug normalizes a value into a URL-safe token", () => {
    assert.equal(Refs.slug("Part Master"), "PART_MASTER");
    assert.equal(Refs.slug("a/b!c"), "A_B_C");
    assert.equal(Refs.slug(""), "");
    assert.equal(Refs.slug(null), "");
  });

  test("reference generators use the documented prefixes", () => {
    const cases = [
      ["importDefinitionRef", "IE-IMPDEF-"],
      ["exportDefinitionRef", "IE-EXPDEF-"],
      ["importJobRef", "IE-IMP-"],
      ["exportJobRef", "IE-EXP-"],
      ["templateRef", "IE-TPL-"],
      ["connectorRef", "IE-CON-"],
      ["resultRef", "IE-RES-"],
    ];
    for (const [name, prefix] of cases) {
      const ref = Refs[name]("My Code");
      assert.equal(typeof ref, "string", name);
      assert.ok(ref.startsWith(prefix), `${name} should start with ${prefix}`);
      assert.ok(ref.length > prefix.length, `${name} should be non-empty`);
    }
  });

  test("job refs are unique while definition refs are deterministic per code", () => {
    assert.notEqual(Refs.importJobRef("JOB"), Refs.importJobRef("JOB"));
    assert.notEqual(Refs.exportJobRef("JOB"), Refs.exportJobRef("JOB"));
    assert.equal(Refs.importDefinitionRef("PART"), "IE-IMPDEF-PART");
    assert.equal(Refs.exportDefinitionRef("PART"), "IE-EXPDEF-PART");
    assert.notEqual(Refs.importDefinitionRef("A"), Refs.importDefinitionRef("B"));
    assert.ok(Refs.importDefinitionRef("").startsWith("IE-IMPDEF-"));
  });
});

describe("data-exchange validation helpers", () => {
  test("normalizes text, upper and lower case", () => {
    assert.equal(Validation.normalizeText("  hi  "), "hi");
    assert.equal(Validation.normalizeText(null), "");
    assert.equal(Validation.normalizeText(undefined), "");
    assert.equal(Validation.normalizeText("abcdef", { max: 3 }), "abc");
    assert.equal(Validation.normalizeUpper("  ab "), "AB");
    assert.equal(Validation.normalizeLower("  AB "), "ab");
    assert.equal(Validation.normalizeUpper("abcdef", { max: 2 }), "AB");
  });

  test("parses JSON, objects and arrays with safe fallbacks", () => {
    assert.deepEqual(Validation.parseJson('{"a":1}', null), { a: 1 });
    assert.equal(Validation.parseJson("not json", "fallback"), "fallback");
    assert.equal(Validation.parseJson("", "fallback"), "fallback");
    const ref = { x: 1 };
    assert.equal(Validation.parseJson(ref, null), ref);

    assert.deepEqual(Validation.parseObject('{"a":1}'), { a: 1 });
    assert.deepEqual(Validation.parseObject("[1,2]", { ok: true }), { ok: true });
    assert.deepEqual(Validation.parseObject(null), {});

    assert.deepEqual(Validation.parseArray("[1,2]"), [1, 2]);
    assert.deepEqual(Validation.parseArray('{"a":1}', []), []);
    assert.deepEqual(Validation.parseArray(null), []);
  });

  test("coerces booleans, numbers and integers", () => {
    assert.equal(Validation.toBool("yes"), true);
    assert.equal(Validation.toBool("TRUE"), true);
    assert.equal(Validation.toBool("1"), true);
    assert.equal(Validation.toBool("0"), false);
    assert.equal(Validation.toBool("", true), true);
    assert.equal(Validation.toBool(false, true), false);

    assert.equal(Validation.toNumber("12.5"), 12.5);
    assert.equal(Validation.toNumber("abc", -1), -1);
    assert.equal(Validation.toNumber("", 7), 7);
    assert.equal(Validation.toNumber("abc"), null);

    assert.equal(Validation.toInt("12.9"), 12);
    assert.equal(Validation.toInt("abc", 3), 3);
    assert.equal(Validation.toIntOrNull("5"), 5);
    assert.equal(Validation.toIntOrNull("5.5"), null);
    assert.equal(Validation.toIntOrNull(""), null);
    assert.equal(Validation.toIntOrNull(null), null);
  });

  test("paginates within the configured window", () => {
    assert.deepEqual(Validation.paginate({}), { page: 1, pageSize: 50, limit: 50, offset: 0 });
    assert.deepEqual(Validation.paginate({ page: 3, pageSize: 10 }), { page: 3, pageSize: 10, limit: 10, offset: 20 });
    assert.equal(Validation.paginate({ pageSize: 9999 }).pageSize, 500);
    assert.equal(Validation.paginate({ page: 0 }).page, 1);
    assert.equal(Validation.paginate({ page_size: 25 }).pageSize, 25);
  });

  test("sorts only by allowed columns", () => {
    assert.deepEqual(Validation.sortParams({}, ["a", "b"], "id"), { column: "id", direction: "DESC" });
    assert.deepEqual(Validation.sortParams({ sort: "a", order: "asc" }, ["a", "b"], "id"), { column: "a", direction: "ASC" });
    assert.deepEqual(Validation.sortParams({ sort: "zzz", direction: "asc" }, ["a"], "id"), { column: "id", direction: "ASC" });
    assert.deepEqual(Validation.sortParams({ sort: "b", direction: "DESC" }, ["a", "b"], "id"), { column: "b", direction: "DESC" });
  });

  test("requires a code and a name", () => {
    assert.equal(Validation.requireCode("ab"), "AB");
    assert.equal(Validation.requireCode("part.v1-a"), "PART.V1-A");
    assert.throws(() => Validation.requireCode("a"), /2-64/);
    assert.throws(() => Validation.requireCode("1abc"));
    assert.throws(() => Validation.requireCode(""));
    assert.equal(Validation.requireName("  Pump  "), "Pump");
    assert.throws(() => Validation.requireName("   "), /required/);
  });

  test("enum asserters normalize valid values and reject unknown ones", () => {
    assert.equal(Validation.assertDirection("import"), "IMPORT");
    assert.equal(Validation.assertConnectorType("csv"), "CSV");
    assert.equal(Validation.assertExecutionMode("dry_run"), "DRY_RUN");
    assert.equal(Validation.assertDuplicateStrategy("upsert"), "UPSERT");
    assert.equal(Validation.assertExportFormat("json"), "JSON");
    assert.equal(Validation.assertExportDestination("download"), "DOWNLOAD");
    assert.equal(Validation.assertFilterOperator("CONTAINS"), "contains");
    assert.equal(Validation.assertSeverity("warning"), "WARNING");
    assert.equal(Validation.assertTransformationStage("field"), "FIELD");
    assert.equal(Validation.assertStorageProvider("object_storage"), "OBJECT_STORAGE");
    assert.equal(Validation.assertLookupMode("exact"), "EXACT");

    for (const fn of [
      () => Validation.assertDirection("SIDEWAYS"),
      () => Validation.assertConnectorType("NOPE"),
      () => Validation.assertExecutionMode("NOPE"),
      () => Validation.assertDuplicateStrategy("NOPE"),
      () => Validation.assertExportFormat("NOPE"),
      () => Validation.assertExportDestination("NOPE"),
      () => Validation.assertFilterOperator("like"),
      () => Validation.assertMappingType("NOPE"),
      () => Validation.assertTransformationType("NOPE"),
      () => Validation.assertValidationLevel("NOPE"),
      () => Validation.assertSeverity("NOPE"),
      () => Validation.assertImportStatus("NOPE"),
      () => Validation.assertExportStatus("NOPE"),
      () => Validation.assertErrorStrategy("NOPE"),
      () => Validation.assertReconciliationStrategy("NOPE"),
    ]) {
      assert.throws(fn);
    }

    assert.equal(
      thrownBy(() => Validation.assertExecutionMode("NOPE")).code,
      Errors.EXCHANGE_ERROR_CODES.INVALID_MODE
    );
    assert.equal(
      thrownBy(() => Validation.assertDuplicateStrategy("NOPE")).code,
      Errors.EXCHANGE_ERROR_CODES.INVALID_DUPLICATE_STRATEGY
    );
  });

  test("assertTenantId accepts positive integers only", () => {
    assert.equal(Validation.assertTenantId(1), 1);
    assert.equal(Validation.assertTenantId("2"), 2);
    assert.throws(() => Validation.assertTenantId(0));
    assert.throws(() => Validation.assertTenantId(-1));
    assert.throws(() => Validation.assertTenantId(1.5));
    assert.throws(() => Validation.assertTenantId("abc"));
  });

  test("assertConfigurationValue enforces type and bounds", () => {
    assert.equal(Validation.assertConfigurationValue("quality_min_score", 75), 75);
    assert.equal(Validation.assertConfigurationValue("quality_gate_enabled", "yes"), true);
    assert.deepEqual(Validation.assertConfigurationValue("blocked_lifecycle_states", ["archived", " PURGED "]), ["archived", "PURGED"]);
    assert.equal(Validation.assertConfigurationValue("storage_provider", "file_storage"), "file_storage");

    const outOfBounds = thrownBy(() => Validation.assertConfigurationValue("quality_min_score", 200));
    assert.equal(outOfBounds.status, 400);
    assert.equal(outOfBounds.code, Errors.EXCHANGE_ERROR_CODES.INVALID_CONFIGURATION);
    assert.equal(outOfBounds.details.min, 0);
    assert.equal(outOfBounds.details.max, 100);

    assert.throws(() => Validation.assertConfigurationValue("default_batch_size", 0), /between 1 and 50000/);
    assert.throws(() => Validation.assertConfigurationValue("quality_min_score", "abc"), /must be a number/);
    assert.throws(() => Validation.assertConfigurationValue("blocked_lifecycle_states", "nope"), /must be an array/);
    assert.throws(() => Validation.assertConfigurationValue("storage_provider", ""), /non-empty string/);
    assert.throws(() => Validation.assertConfigurationValue("unknown_key", 1), /Unknown configuration key/);
  });

  test("assertBatchSize clamps within the allowed maximum", () => {
    assert.equal(Validation.assertBatchSize(100), 100);
    assert.equal(Validation.assertBatchSize(undefined), 500);
    assert.equal(Validation.assertBatchSize(0), 500);
    assert.equal(Validation.assertBatchSize(50, { max: 100 }), 50);
    assert.throws(() => Validation.assertBatchSize(-1), /between 1 and/);
    assert.throws(() => Validation.assertBatchSize(99999));
    assert.throws(() => Validation.assertBatchSize(200, { max: 100 }));
  });

  test("date helpers parse, add and compare deterministically", () => {
    const now = Validation.nowIso();
    assert.equal(typeof now, "string");
    assert.ok(!Number.isNaN(Date.parse(now)));

    assert.equal(Validation.parseDate(null), null);
    assert.equal(Validation.parseDate("not-a-date"), null);
    assert.ok(Validation.parseDate("2026-01-01T00:00:00Z") instanceof Date);
    const date = new Date("2020-01-01T00:00:00Z");
    assert.equal(Validation.parseDate(date), date);

    assert.equal(Validation.addDays(null, 1), null);
    assert.equal(Validation.addDays("2026-01-01T00:00:00.000Z", 1), "2026-01-02T00:00:00.000Z");

    assert.equal(Validation.isPast("2000-01-01T00:00:00Z"), true);
    assert.equal(Validation.isPast("2999-01-01T00:00:00Z"), false);
    assert.equal(Validation.isPast("garbage"), false);
    assert.equal(Validation.isPast("2000-01-01T00:00:00Z", "1999-01-01T00:00:00Z"), false);
  });

  test("valuePreview renders objects and truncates strings", () => {
    assert.equal(Validation.valuePreview(null), "");
    assert.equal(Validation.valuePreview(undefined), "");
    assert.equal(Validation.valuePreview("hello"), "hello");
    assert.equal(Validation.valuePreview({ a: 1 }), '{"a":1}');
    assert.equal(Validation.valuePreview("abcdef", 3), "abc");
    const circular = {};
    circular.self = circular;
    assert.equal(typeof Validation.valuePreview(circular), "string");
  });
});

describe("data-exchange expression language", () => {
  test("compiles arithmetic and evaluates paths and literals", () => {
    assert.deepEqual(Validation.compileExpression("1"), { type: "literal", value: 1 });
    assert.equal(Validation.evaluateExpression("1 + 2 * 3", {}), 7);
    assert.equal(Validation.evaluateExpression("(1 + 2) * 3", {}), 9);
    assert.equal(Validation.evaluateExpression("-2 + 1", {}), -1);
    assert.equal(Validation.evaluateExpression("part.number", { part: { number: "P-1" } }), "P-1");
    assert.equal(Validation.evaluateExpression("items[1]", { items: ["a", "b"] }), "b");
    assert.equal(Validation.evaluateExpression("missing", {}), undefined);
    assert.equal(Validation.evaluateExpression("[1, 2, 3]", {}).length, 3);
  });

  test("evaluates boolean logic and ternaries", () => {
    assert.equal(Validation.evaluateExpression("qty >= 5 && qty <= 10", { qty: 7 }), true);
    assert.equal(Validation.evaluateExpression("status == 'active'", { status: "active" }), true);
    assert.equal(Validation.evaluateExpression("status != 'active'", { status: "draft" }), true);
    assert.equal(Validation.evaluateExpression("qty > 5 ? 'high' : 'low'", { qty: 10 }), "high");
    assert.equal(Validation.evaluateExpression("qty > 5 ? 'high' : 'low'", { qty: 1 }), "low");
    assert.equal(Validation.evaluateExpression("!flag", { flag: false }), true);
    assert.equal(Validation.evaluateExpression("enabled || fallback", { enabled: false, fallback: true }), true);
  });

  test("exposes only the allowlisted function set", () => {
    assert.equal(Validation.evaluateExpression("upper(name)", { name: "abc" }), "ABC");
    assert.equal(Validation.evaluateExpression("lower(name)", { name: "ABC" }), "abc");
    assert.equal(Validation.evaluateExpression("trim(name)", { name: "  x  " }), "x");
    assert.equal(Validation.evaluateExpression("concat(first, ' ', last)", { first: "A", last: "B" }), "A B");
    assert.equal(Validation.evaluateExpression("coalesce(a, b)", { a: null, b: 5 }), 5);
    assert.equal(Validation.evaluateExpression("default(a, 'z')", { a: "" }), "z");
    assert.equal(Validation.evaluateExpression("length(name)", { name: "abcd" }), 4);
    assert.equal(Validation.evaluateExpression("split(value, ',', 1)", { value: "x,y" }), "y");
    assert.throws(() => Validation.evaluateExpression("notAFunction(1)", {}));
  });

  test("validateExpression never throws and reports structured errors", () => {
    assert.deepEqual(Validation.validateExpression("1 + 2"), { valid: true, errors: [] });
    const invalid = Validation.validateExpression("1 +");
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors[0].code, "invalid_expression");
    assert.equal(typeof invalid.errors[0].message, "string");
  });

  test("compileExpression rejects empty and malformed input", () => {
    assert.throws(() => Validation.compileExpression(""));
    assert.throws(() => Validation.compileExpression("1 +"));
    assert.throws(() => Validation.compileExpression("'unterminated"));
    assert.throws(() => Validation.compileExpression("a b"));
  });

  test("resolveValueExpression handles literals, templates and callables", () => {
    assert.equal(Validation.resolveValueExpression("{{ upper(name) }}", { name: "ab" }), "AB");
    assert.equal(Validation.resolveValueExpression("name", { name: "x" }), "x");
    assert.equal(Validation.resolveValueExpression(null), undefined);
    assert.equal(Validation.resolveValueExpression(undefined), undefined);
    const ref = { a: 1 };
    assert.equal(Validation.resolveValueExpression(ref), ref);
    const callable = (context) => context.x;
    assert.equal(Validation.resolveValueExpression(callable), callable);
  });

  test("applyTemplate interpolates expressions and blanks missing values", () => {
    assert.equal(Validation.applyTemplate("Hello {{ name }} #{{ 1 + 2 }}", { name: "Bob" }), "Hello Bob #3");
    assert.equal(Validation.applyTemplate("{{ missing }}", {}), "");
    assert.equal(Validation.applyTemplate("no vars", {}), "no vars");
  });

  test("expressionFunctionNames advertises the allowlist", () => {
    const names = Validation.expressionFunctionNames();
    assert.ok(Array.isArray(names));
    for (const fn of ["upper", "lower", "trim", "concat", "split", "coalesce", "default", "round", "to_string"]) {
      assert.ok(names.includes(fn), `missing expression function ${fn}`);
    }
  });

  test("vocabulary surfaces every picker list", () => {
    const vocab = Validation.vocabulary();
    assert.deepEqual(vocab.directions, constants.DIRECTIONS);
    assert.deepEqual(vocab.connector_types, constants.CONNECTOR_TYPES);
    assert.ok(vocab.export_formats.includes("CSV"));
    assert.ok(vocab.expression_functions.includes("upper"));
    assert.equal(vocab.sort_directions.length, 2);
  });
});

describe("data-exchange core — database-backed modules", () => {
  let db;
  let actor;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });

  after(() => db?.close());

  test("configuration reads defaults and is tenant-scoped", () => {
    assert.equal(Configuration.getConfig(db, TENANT, "default_batch_size"), 500);
    assert.equal(Configuration.getConfig(db, TENANT, "does_not_exist"), null);
    assert.equal(Configuration.getConfig(db, 999999, "default_batch_size"), 500);
    const all = Configuration.listConfig(db, TENANT);
    assert.equal(Object.keys(all).length, Object.keys(constants.CONFIG_DEFAULTS).length);
    assert.equal(all.default_export_format, "CSV");
    assert.ok(Configuration.getConfigRow(db, TENANT, "preview_limit"));
  });

  test("configuration writes enforce bounds and unknown keys", () => {
    assert.equal(Configuration.setConfig(db, TENANT, "default_batch_size", 250, actor), 250);
    assert.equal(Configuration.getConfig(db, TENANT, "default_batch_size"), 250);
    const outOfBounds = thrownBy(() => Configuration.setConfig(db, TENANT, "quality_min_score", 250, actor));
    assert.equal(outOfBounds.code, Errors.EXCHANGE_ERROR_CODES.INVALID_CONFIGURATION);
    assert.throws(() => Configuration.setConfig(db, TENANT, "unknown_key", 1, actor), /Unknown configuration key/);
  });

  test("configuration writes do not leak across tenants", () => {
    Configuration.setConfig(db, TENANT, "preview_limit", 10, actor);
    Configuration.setConfig(db, 2, "preview_limit", 20, actor);
    assert.equal(Configuration.getConfig(db, TENANT, "preview_limit"), 10);
    assert.equal(Configuration.getConfig(db, 2, "preview_limit"), 20);
  });

  test("ensureExchangeConfig is idempotent", () => {
    assert.deepEqual(Configuration.ensureExchangeConfig(db, TENANT), { created: 0 });
    const fresh = Configuration.ensureExchangeConfig(db, 3);
    assert.equal(fresh.created, Object.keys(constants.CONFIG_DEFAULTS).length);
    assert.equal(Configuration.ensureExchangeConfig(db, 3).created, 0);
  });

  test("events register idempotently and expose a frozen map", () => {
    assert.equal(Events.ensureExchangeEventTypes(db), 0);
    assert.ok(getEventTypeRow(db, "ImportStarted"));
    assert.ok(getEventTypeRow(db, "ExportCompleted"));
    assert.ok(Object.isFrozen(Events.EXCHANGE_EVENT_MAP));
    assert.equal(Events.exchangeEventCode("IMPORT_STARTED"), "ImportStarted");
    assert.equal(Events.exchangeEventCode("NOPE"), null);
  });

  test("publishExchangeEvent persists an envelope and skips empty codes", () => {
    const event = Events.publishExchangeEvent(
      db,
      { eventType: "ImportStarted", payload: { code: "PART_IMPORT" }, objectType: "data_exchange_job", objectId: 42, tenantId: TENANT },
      actor
    );
    assert.ok(event);
    assert.equal(event.event_type_code, "ImportStarted");
    assert.equal(event.source_module, "data-exchange");
    assert.equal(event.source_object_id, "42");
    assert.equal(event.payload.code, "PART_IMPORT");
    assert.equal(event.tenant_id, TENANT);

    const viaCode = Events.publishExchangeEvent(db, { code: "ExportCompleted", tenantId: TENANT }, actor);
    assert.equal(viaCode.event_type_code, "ExportCompleted");
    assert.equal(Events.publishExchangeEvent(db, { payload: {} }, actor), null);
  });

  test("history appends import and export rows and lists them", () => {
    const importRow = History.recordHistory(db, {
      tenantId: TENANT,
      direction: "IMPORT",
      action: "CORE_IMPORT_STARTED",
      status: "RUNNING",
      sourceType: "CSV",
      targetObjectType: "product",
      totalRecords: 5,
      actorId: actor.id,
      details: { marker: "core" },
    });
    assert.equal(importRow.action, "CORE_IMPORT_STARTED");
    assert.equal(importRow.total_records, 5);
    assert.equal(importRow.actor_id, actor.id);
    assert.deepEqual(importRow.details, { marker: "core" });

    const exportRow = History.recordHistory(db, {
      tenantId: TENANT,
      direction: "EXPORT",
      action: "CORE_EXPORT_DONE",
      status: "COMPLETED",
      objectType: "product",
      format: "csv",
      recordCount: 3,
      actorId: actor.id,
    });
    assert.equal(exportRow.format, "CSV");
    assert.equal(exportRow.source_type, "product");
    assert.equal(exportRow.total_records, 3);

    const importList = History.listHistory(db, { tenantId: TENANT, direction: "IMPORT", action: "core_import_started" });
    assert.ok(importList.total >= 1);
    assert.equal(importList.items[0].action, "CORE_IMPORT_STARTED");
    assert.equal(importList.source_module, "data-exchange");

    const combined = History.listHistory(db, { tenantId: TENANT, pageSize: 50 });
    assert.ok(combined.total >= 2);
    assert.ok(combined.items.some((row) => row.action === "CORE_EXPORT_DONE"));

    assert.equal(typeof History.publicHistory, "function");
    assert.throws(() => History.recordHistory(db, { tenantId: TENANT, direction: "SIDEWAYS", action: "X" }), /Unsupported history direction/);
    assert.throws(() => History.listHistory(db, { tenantId: TENANT, direction: "SIDEWAYS" }), /Unsupported history direction/);
  });

  test("metricsSnapshot reports tenant-scoped counters", () => {
    const snapshot = Metrics.metricsSnapshot(db, { tenantId: TENANT });
    assert.equal(snapshot.source_module, "data-exchange");
    assert.ok(!Number.isNaN(Date.parse(snapshot.generated_at)));
    assert.ok(snapshot.import_definitions >= 1);
    assert.ok(snapshot.export_definitions >= 1);
    assert.ok(snapshot.connector_configurations >= 1);
    assert.ok(snapshot.templates >= 1);
    assert.equal(typeof snapshot.import_jobs_by_status, "object");
    assert.equal(typeof snapshot.export_jobs_by_status, "object");
    assert.ok(snapshot.registered_connectors >= 10);

    const empty = Metrics.metricsSnapshot(db, { tenantId: 999999 });
    assert.equal(empty.import_definitions, 0);
    assert.equal(empty.connector_configurations, 0);
  });

  test("healthCheck reports registered resources and healthy table checks", () => {
    const health = Metrics.healthCheck(db, { tenantId: TENANT });
    assert.equal(health.status, "healthy");
    assert.equal(health.source_module, "data-exchange");
    assert.equal(health.resources.module, "iam.data_exchange");
    assert.ok(Array.isArray(health.checks));
    assert.ok(health.checks.length >= 6);
    assert.ok(health.checks.every((check) => check.status === "ok"));
    assert.ok(health.checks.some((check) => check.name === "connectors"));
  });

  test("buildExchangeContext derives identity from the actor", () => {
    const context = Security.buildExchangeContext(db, actor, { tenantId: TENANT });
    assert.equal(context.tenantId, TENANT);
    assert.equal(context.userId, actor.id);
    assert.equal(context.anonymous, false);
  });

  test("fieldDecisionsFor and enforceRecordFields mask sensitive fields", () => {
    createFieldRule(db, { object_type: "exchange_probe", field_name: "secret", action: "read", effect: "mask", masking_strategy: "REDACT" }, actor, TENANT);
    createFieldRule(db, { object_type: "exchange_probe", field_name: "internal_notes", action: "read", effect: "hide" }, actor, TENANT);
    createFieldRule(db, { object_type: "exchange_probe", field_name: "password", action: "read", effect: "deny" }, actor, TENANT);

    const decision = Security.fieldDecisionsFor(db, actor, "exchange_probe", "read", { tenantId: TENANT });
    assert.ok(decision.fields.length >= 3);
    assert.ok(decision.fields.every((field) => typeof field.field === "string"));

    const result = Security.enforceRecordFields(db, actor, {
      objectType: "exchange_probe",
      record: { id: 1, name: "ok", secret: "abc", internal_notes: "x", password: "p" },
      action: "read",
      tenantId: TENANT,
    });
    assert.equal(result.record.name, "ok");
    assert.equal(result.record.secret, "REDACTED");
    assert.ok(!("internal_notes" in result.record));
    assert.ok(!("password" in result.record));
    assert.deepEqual(result.masked, ["secret"]);
    assert.ok(result.denied.includes("internal_notes"));
    assert.ok(result.denied.includes("password"));
  });

  test("enforceRecordFields leaves unruled records untouched", () => {
    const record = { id: 2, name: "plain" };
    const result = Security.enforceRecordFields(db, actor, { objectType: "exchange_unruled", record, action: "read", tenantId: TENANT });
    assert.deepEqual(result.record, record);
    assert.deepEqual(result.masked, []);
    assert.deepEqual(result.denied, []);
  });

  test("authorizeRecord falls back to platform IAM and denies anonymous actors", () => {
    const allowed = Security.authorizeRecord(db, actor, { objectType: "exchange_unruled", objectId: 1, action: "read", tenantId: TENANT });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.fallback, true);
    assert.equal(allowed.reason, "RBAC_ALLOWED");

    const denied = thrownBy(() => Security.authorizeRecord(db, null, { objectType: "exchange_unruled", action: "read", tenantId: TENANT }));
    assert.equal(denied.status, 403);
    assert.equal(denied.code, Errors.EXCHANGE_ERROR_CODES.SECURITY_BLOCKED);
    assert.equal(denied.details.action, "read");
  });

  test("authorizeExchangeAction returns a decision for the exchange resource", () => {
    const decision = Security.authorizeExchangeAction(db, actor, { objectType: "data_exchange_job", action: "execute", tenantId: TENANT });
    assert.equal(typeof decision.allowed, "boolean");
    assert.equal(decision.resource.type, "data_exchange_job");
    assert.equal(typeof Security.maskDocument, "function");
  });

  test("repository mappers omit raw secrets and parse JSON payloads", () => {
    const credentialRow = {
      id: 9,
      tenant_id: TENANT,
      code: "CRM_TOKEN",
      name: "CRM token",
      credential_type: "TOKEN",
      secret_ref: "vault://data-exchange/crm",
      metadata_json: '{"owner":"ops"}',
      status: "active",
      created_at: "t",
      updated_at: "t",
      secret_value: "super-secret",
      password: "hunter2",
    };
    const credential = Repository.publicCredentialReference(credentialRow);
    assert.equal(credential.secret_ref, "vault://data-exchange/crm");
    assert.deepEqual(credential.metadata, { owner: "ops" });
    assert.equal("secret_value" in credential, false);
    assert.equal("password" in credential, false);
    assert.equal(JSON.stringify(credential).includes("super-secret"), false);
    assert.equal(Repository.publicCredentialReference(null), null);
  });

  test("repository maps a persisted connector configuration", () => {
    const row = queryOne(db, "SELECT * FROM ie_connector_configurations WHERE tenant_id = ? AND code = 'PART_CSV'", [TENANT]);
    const config = Repository.publicConnectorConfiguration(row);
    assert.equal(config.code, "PART_CSV");
    assert.equal(config.connector_type, "CSV");
    assert.deepEqual(config.settings, { delimiter: ",", has_header: true });
    assert.ok(Array.isArray(config.capabilities));
    assert.equal("settings_json" in config, false);
    assert.equal("capabilities_json" in config, false);
  });

  test("repository mappers fall back safely for malformed JSON and drop raw blobs", () => {
    const config = Repository.publicConnectorConfiguration({ id: 1, tenant_id: TENANT, code: "X", settings_json: "not-json", capabilities_json: "nope" });
    assert.deepEqual(config.settings, {});
    assert.deepEqual(config.capabilities, []);

    const result = Repository.publicExportResult({
      id: 1,
      job_id: 1,
      tenant_id: TENANT,
      result_ref: "IE-RES-1",
      format: "CSV",
      filename: "part.csv",
      content: "raw-bytes",
      created_at: "t",
    });
    assert.equal(result.filename, "part.csv");
    assert.equal("content" in result, false);
  });

  test("repository maps import definitions and history rows", () => {
    const definition = Repository.publicImportDefinition({
      id: 3,
      tenant_id: TENANT,
      code: "PART_IMPORT",
      name: "Part import",
      target_object_type: "product",
      source_type: "CSV",
      mapping_json: '{"a":1}',
      duplicate_key_json: '{"type":"BUSINESS_KEY"}',
      catalog_refs_json: "[]",
    });
    assert.equal(definition.code, "PART_IMPORT");
    assert.deepEqual(definition.mapping, { a: 1 });
    assert.deepEqual(definition.duplicate_key, { type: "BUSINESS_KEY" });
    assert.deepEqual(definition.catalog_refs, {});

    const importHistory = Repository.publicHistory({
      id: 1,
      tenant_id: TENANT,
      definition_version: 2,
      action: "IMPORT",
      status: "OK",
      source_type: "CSV",
      total_records: 4,
      success_count: 3,
      failed_count: 1,
      details_json: '{"x":1}',
      actor_id: 5,
      created_at: "t",
    });
    assert.equal(importHistory.total_records, 4);
    assert.equal(importHistory.success_count, 3);
    assert.deepEqual(importHistory.details, { x: 1 });

    const exportHistory = Repository.publicHistory({
      id: 2,
      tenant_id: TENANT,
      definition_version: 1,
      action: "EXPORT",
      object_type: "product",
      format: "CSV",
      record_count: 7,
      details_json: "{}",
      created_at: "t",
    });
    assert.equal(exportHistory.source_type, "product");
    assert.equal(exportHistory.total_records, 7);
  });

  test("repository maps configuration values from JSON", () => {
    const configuration = Repository.publicConfiguration({
      id: 1,
      tenant_id: TENANT,
      key: "preview_limit",
      value_json: "50",
      updated_by: null,
      created_at: "t",
      updated_at: "t",
    });
    assert.equal(configuration.value, 50);
    assert.equal(configuration.key, "preview_limit");
  });

  test("foundation bootstraps idempotently and reports health", () => {
    const result = Foundation.ensureExchangeFoundation(db);
    assert.equal(result.source_module, "data-exchange");
    assert.ok(Array.isArray(result.handlers));
    assert.ok(result.handlers.includes("dataExchange.import"));
    assert.equal(typeof result.configuration, "number");
    assert.equal(typeof result.event_types, "number");
    assert.equal(typeof result.search, "number");
    assert.equal(result.tenants, 1);

    const again = Foundation.ensureExchangeFoundation(db);
    assert.equal(again.event_types, 0);
    assert.equal(again.configuration, 0);

    const health = Foundation.exchangeHealth(db, TENANT);
    assert.equal(health.source_module, "data-exchange");
    assert.ok(health.counts.import_definitions >= 1);
    assert.ok(health.counts.export_definitions >= 1);
    assert.ok(health.counts.connector_configurations >= 1);
    assert.ok(health.counts.history >= 1);

    const all = Foundation.exchangeHealth(db);
    assert.equal(all.counts.import_definitions, health.counts.import_definitions);
    assert.equal(typeof all.tenant_count, "number");
  });
});

describe("data-exchange index facade", () => {
  test("exposes every internal namespace", () => {
    for (const key of [
      "constants",
      "Constants",
      "Validation",
      "Errors",
      "Refs",
      "Repository",
      "Configuration",
      "Events",
      "History",
      "Security",
      "ConnectorConfigs",
      "ImportDefinitions",
      "ExportDefinitions",
      "Importer",
      "Exporter",
      "Templates",
      "Jobs",
      "Metrics",
      "Foundation",
      "Seed",
      "Lifecycle",
      "Quality",
      "Catalog",
      "Search",
      "Connectors",
      "Engines",
    ]) {
      assert.ok(Index[key], `missing namespace ${key}`);
    }
  });

  test("exposes the flat SDK surface as functions", () => {
    assert.equal(Index.Constants.SOURCE_MODULE, "data-exchange");
    assert.equal(typeof Index.Validation.normalizeText, "function");
    assert.equal(typeof Index.Errors.invalidDefinition, "function");
    assert.equal(typeof Index.Refs.importDefinitionRef, "function");
    assert.equal(typeof Index.Repository.publicHistory, "function");
    assert.equal(typeof Index.DataExchange, "object");
    for (const key of ["metrics", "health", "listHistory", "getConfig", "setConfig", "listConfig", "createImportDefinition", "createExportDefinition"]) {
      assert.equal(typeof Index.DataExchange[key], "function", `DataExchange.${key} is not a function`);
    }
  });

  test("re-exports bootstrap helpers as named functions", () => {
    for (const key of [
      "ensureDataExchangeFoundation",
      "exchangeHealth",
      "registerDataExchangeSources",
      "ensureDataExchangeSearch",
      "registerExchangeHandlers",
      "runExchangeMaintenance",
      "seedDataExchange",
      "ensureDataExchangeSeed",
      "ensureConnectors",
    ]) {
      assert.equal(typeof Index[key], "function", `${key} is not a function`);
    }
  });
});
