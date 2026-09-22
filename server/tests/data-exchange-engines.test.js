import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as Transform from "../services/data-exchange/engines/transform.js";
import * as Mapping from "../services/data-exchange/engines/mapping.js";
import * as ValidationRules from "../services/data-exchange/engines/validation.js";
import * as Lookup from "../services/data-exchange/engines/lookup.js";
import * as Duplicate from "../services/data-exchange/engines/duplicate.js";
import * as Schema from "../services/data-exchange/engines/schema.js";
import Engines, {
  Transform as TransformNamespace,
  Mapping as MappingNamespace,
  ValidationRules as ValidationNamespace,
  Lookup as LookupNamespace,
  Duplicate as DuplicateNamespace,
  Schema as SchemaNamespace,
} from "../services/data-exchange/engines/index.js";
import * as Codecs from "../services/data-exchange/connectors/codecs.js";
import * as Registry from "../services/data-exchange/connectors/registry.js";
import {
  ensureConnectors,
  Connectors,
  connectorCatalog,
} from "../services/data-exchange/connectors/index.js";

let db;

before(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedDatabase(db);
  ensureConnectors();
});

after(() => {
  db?.close();
});

const SOURCE = {
  part_number: "P-1",
  part_name: "Pump",
  category: "rotating/pump",
  active: true,
  qty: "5",
  nested: { a: 1, b: 2 },
  list: [{ id: 1 }, { id: 2 }],
};

describe("data-exchange transform engine", () => {
  test("registers every documented transformation type", () => {
    const types = Transform.transformationTypes();
    for (const expected of [
      "TRIM",
      "UPPERCASE",
      "LOWERCASE",
      "SUBSTRING",
      "REPLACE",
      "CONCAT",
      "SPLIT",
      "DATE_CONVERT",
      "UNIT_CONVERT",
      "LOOKUP",
      "DEFAULT",
      "EXPRESSION",
      "MASK",
    ]) {
      assert.ok(types.includes(expected), `missing transformation ${expected}`);
    }
  });

  test("applies TRIM, UPPERCASE and LOWERCASE with empty-value guards", () => {
    assert.equal(Transform.applyTransformation("TRIM", "  pump  "), "pump");
    assert.equal(Transform.applyTransformation("TRIM", null), null);
    assert.equal(Transform.applyTransformation("TRIM", 123), "123");
    assert.equal(Transform.applyTransformation("UPPERCASE", "pump"), "PUMP");
    assert.equal(Transform.applyTransformation("UPPERCASE", undefined), undefined);
    assert.equal(Transform.applyTransformation("LOWERCASE", "PUMP"), "pump");
    assert.equal(Transform.applyTransformation("LOWERCASE", null), null);
  });

  test("applies SUBSTRING and REPLACE with alternate config keys", () => {
    assert.equal(Transform.applyTransformation("SUBSTRING", "abcdef", { start: 1, length: 3 }), "bcd");
    assert.equal(Transform.applyTransformation("SUBSTRING", "abcdef", { start: 2 }), "cdef");
    assert.equal(Transform.applyTransformation("SUBSTRING", "abcdef", {}), "abcdef");
    assert.equal(Transform.applyTransformation("SUBSTRING", null, { start: 0, length: 2 }), "");
    assert.equal(Transform.applyTransformation("REPLACE", "a-b-c", { find: "-", replace: "/" }), "a/b/c");
    assert.equal(Transform.applyTransformation("REPLACE", "a-b", { from: "-", to: "_" }), "a_b");
    assert.equal(Transform.applyTransformation("REPLACE", null, { find: "a", replace: "b" }), "");
  });

  test("applies CONCAT and SPLIT with config fallbacks", () => {
    assert.equal(
      Transform.applyTransformation("CONCAT", "", { fields: ["{{a}}", "{{b}}"], separator: "-" }, { record: { a: "x", b: "y" } }),
      "x-y"
    );
    assert.equal(
      Transform.applyTransformation("CONCAT", "", { parts: ["{{a}}", "{{b}}"], separator: "" }, { record: { a: "x", b: "y" } }),
      "xy"
    );
    assert.equal(Transform.applyTransformation("CONCAT", "", { fields: ["a", "b"], separator: "-" }), "a-b");
    assert.equal(Transform.applyTransformation("CONCAT", "", {}), "");
    assert.equal(Transform.applyTransformation("SPLIT", "a/b/c", { separator: "/", index: 1 }), "b");
    assert.equal(Transform.applyTransformation("SPLIT", "a/b/c"), "a/b/c");
    assert.equal(Transform.applyTransformation("SPLIT", "a", { separator: "/", index: 9, default: "z" }), "z");
    assert.equal(Transform.applyTransformation("SPLIT", null, { separator: "," }), "");
  });

  test("converts dates with parseFlexibleDate and formatDate", () => {
    assert.equal(
      Transform.applyTransformation("DATE_CONVERT", "20240131", { input_format: "YYYYMMDD", output_format: "YYYY-MM-DD" }),
      "2024-01-31"
    );
    assert.equal(
      Transform.applyTransformation("DATE_CONVERT", "31/01/2024", { input_format: "DD/MM/YYYY", output_format: "YYYYMMDD" }),
      "20240131"
    );
    assert.equal(
      Transform.applyTransformation("DATE_CONVERT", "01/02/2024", { from: "MM/DD/YYYY", to: "YYYY-MM-DD" }),
      "2024-01-02"
    );
    assert.equal(
      Transform.applyTransformation("DATE_CONVERT", "2024-01-31", { output_format: "DD/MM/YYYY" }),
      "31/01/2024"
    );
    assert.deepEqual(Transform.DATE_FORMATS, [
      "YYYY-MM-DD",
      "DD/MM/YYYY",
      "MM/DD/YYYY",
      "YYYYMMDD",
      "YYYY-MM-DDTHH:mm:ss",
      "ISO",
      "EPOCH",
    ]);
    assert.equal(Transform.parseFlexibleDate("", "ISO"), null);
    assert.equal(Transform.parseFlexibleDate("not-a-date", "ISO"), null);
    assert.equal(Transform.formatDate(null, "ISO"), null);
    assert.equal(Transform.parseFlexibleDate("20240131", "YYYYMMDD").toISOString(), "2024-01-31T00:00:00.000Z");
    assert.equal(Transform.parseFlexibleDate("01/02/2024", "DD/MM/YYYY").toISOString(), "2024-02-01T00:00:00.000Z");
    assert.equal(Transform.parseFlexibleDate("01/02/2024", "MM/DD/YYYY").toISOString(), "2024-01-02T00:00:00.000Z");
    const epoch = Transform.parseFlexibleDate("1700000000", "EPOCH");
    assert.equal(Transform.formatDate(epoch, "EPOCH"), 1700000000);
    assert.equal(Transform.formatDate(epoch, "YYYYMMDD"), "20231114");
  });

  test("converts units across families and rejects invalid conversions", () => {
    assert.equal(Transform.applyTransformation("UNIT_CONVERT", 100, { from: "cm", to: "m" }), 1);
    assert.equal(Transform.applyTransformation("UNIT_CONVERT", 1, { from: "m", to: "cm" }), 100);
    assert.equal(Transform.applyTransformation("UNIT_CONVERT", 32, { from: "f", to: "c" }), 0);
    assert.equal(Transform.applyTransformation("UNIT_CONVERT", 0, { from: "c", to: "k" }), 273.15);
    assert.equal(Transform.applyTransformation("UNIT_CONVERT", 273.15, { from: "k", to: "c" }), 0);
    assert.throws(() => Transform.applyTransformation("UNIT_CONVERT", "abc", { from: "cm", to: "m" }));
    assert.throws(() => Transform.applyTransformation("UNIT_CONVERT", 5, { from: "kg", to: "m" }));
    assert.throws(() => Transform.applyTransformation("UNIT_CONVERT", 0, { from: "k", to: "f" }));
  });

  test("applies DEFAULT, LOOKUP, EXPRESSION and MASK", () => {
    assert.equal(Transform.applyTransformation("DEFAULT", null, { default: "N/A" }), "N/A");
    assert.equal(Transform.applyTransformation("DEFAULT", "", { value: "V" }), "V");
    assert.equal(Transform.applyTransformation("DEFAULT", 0, { default: "N/A" }), 0);
    assert.equal(Transform.applyTransformation("LOOKUP", "draft", { map: { draft: "DRAFT" }, default: "OTHER" }), "DRAFT");
    assert.equal(Transform.applyTransformation("LOOKUP", "ghost", { map: { draft: "DRAFT" }, default: "OTHER" }), "OTHER");
    assert.equal(Transform.applyTransformation("LOOKUP", "ghost", { map: { draft: "DRAFT" } }), "ghost");
    assert.equal(
      Transform.applyTransformation("LOOKUP", "z", { source: "x" }, { lookup: (value) => value.toUpperCase() }),
      "Z"
    );
    assert.equal(Transform.applyTransformation("EXPRESSION", "abc", { expression: "upper(value)" }), "ABC");
    assert.equal(
      Transform.applyTransformation("EXPRESSION", "", { expression: "upper(part)" }, { record: { part: "pump" } }),
      "PUMP"
    );
    assert.equal(Transform.maskValue("secretvalue"), "*******alue");
    assert.equal(Transform.maskValue("1234567890", { keep_first: 2, keep_last: 2 }), "12******90");
    assert.equal(Transform.maskValue("123", { keep_first: 2, keep_last: 2 }), "***");
    assert.equal(Transform.maskValue("a@b.com", { type: "EMAIL" }), "a***@b.com");
    assert.equal(Transform.maskValue("nodomain", { type: "EMAIL" }), "****");
    assert.equal(Transform.maskValue("secret", { type: "FULL", replacement: "#" }), "#");
    assert.equal(Transform.maskValue("", {}), "");
    assert.equal(Transform.maskValue(null, {}), null);
  });

  test("parses JSON-string transformation config and rejects unknown types", () => {
    assert.equal(
      Transform.applyTransformations([{ transformation_type: "REPLACE", config: '{"find":"-","replace":"_"}' }], "a-b"),
      "a_b"
    );
    assert.equal(
      Transform.applyTransformations([{ transformation_type: "DEFAULT", config_json: { default: "z" } }], null),
      "z"
    );
    assert.equal(Transform.applyTransformations([], "unchanged"), "unchanged");
    assert.throws(() => Transform.applyTransformation("BOGUS", "x"), (error) => error.code === "INVALID_DATA_EXCHANGE_TRANSFORMATION");
  });

  test("registers custom transformation handlers", () => {
    assert.throws(() => Transform.registerTransformationHandler("", () => {}));
    assert.throws(() => Transform.registerTransformationHandler("X", null));
    Transform.registerTransformationHandler("DOUBLE", (value) => Number(value) * 2);
    assert.equal(Transform.applyTransformation("double", "4"), 8);
    assert.ok(Transform.transformationTypes().includes("DOUBLE"));
  });

  test("resolves nested paths via getPath and setPath", () => {
    assert.equal(Transform.getPath({ a: { b: 1 } }, "a.b"), 1);
    assert.equal(Transform.getPath({ a: [{ b: 2 }] }, "a[0].b"), 2);
    assert.equal(Transform.getPath({ a: [9, 8] }, "a.1"), 8);
    assert.equal(Transform.getPath({ a: 1 }, "x.y"), undefined);
    assert.equal(Transform.getPath({ a: [1] }, "a[5]"), undefined);
    assert.deepEqual(Transform.getPath({ a: 1 }, ""), { a: 1 });
    assert.deepEqual(Transform.getPath({ a: 1 }, null), { a: 1 });

    const created = {};
    assert.equal(Transform.setPath(created, "a.b.c", 5), created);
    assert.deepEqual(created, { a: { b: { c: 5 } } });

    const withNull = { a: null };
    Transform.setPath(withNull, "a.b", 3);
    assert.deepEqual(withNull, { a: { b: 3 } });

    const overwritten = { a: 1 };
    Transform.setPath(overwritten, "a.b", 2);
    assert.deepEqual(overwritten, { a: { b: 2 } });
  });

  test("applies template strings and normalizes templates", () => {
    assert.equal(Transform.applyTemplateString("Hi {{user.name}}", { user: { name: "Ada" } }), "Hi Ada");
    assert.equal(Transform.applyTemplateString("{{missing}}", {}), "");
    assert.equal(Transform.normalizeTemplate("  hi  "), "hi");
    assert.equal(Transform.normalizeTemplate(undefined), "");
    assert.equal(Transform.normalizeTemplate("x".repeat(5000)).length, 4000);
  });

  test("applies definition-level FIELD transformations only", () => {
    const record = { name: "  pump  ", nested: { code: " p-1 " } };
    const out = Transform.applyDefinitionTransformations(
      [
        { stage: "RECORD", transformation_type: "UPPERCASE", target_field: "name" },
        { stage: "FIELD", transformation_type: "UPPERCASE" },
        { stage: "FIELD", transformation_type: "TRIM", target_field: "name" },
        { stage: "FIELD", transformation_type: "UPPERCASE", target_field: "nested.code" },
      ],
      record
    );
    assert.equal(out.name, "pump");
    assert.equal(out.nested.code, " P-1 ");
  });
});

describe("data-exchange mapping engine", () => {
  test("maps DIRECT, RENAME, DEFAULT and CONSTANT", () => {
    assert.equal(Mapping.mapRecord({ mapping_type: "DIRECT", source_field: "part_number" }, SOURCE), "P-1");
    assert.equal(Mapping.mapRecord({ source_field: "part_name" }, SOURCE), "Pump");
    assert.equal(Mapping.mapRecord({ mapping_type: "RENAME", source_field: "part_name" }, SOURCE), "Pump");
    assert.equal(Mapping.mapRecord({ mapping_type: "DEFAULT", source_field: "missing", default_value: "X" }, SOURCE), "X");
    assert.equal(Mapping.mapRecord({ mapping_type: "DEFAULT", source_field: "qty", default_value: "X" }, SOURCE), "5");
    assert.equal(Mapping.mapRecord({ mapping_type: "CONSTANT", constant_value: 42 }, SOURCE), 42);
  });

  test("maps LOOKUP from static maps, resolvers and defaults", () => {
    assert.equal(
      Mapping.mapRecord({ mapping_type: "LOOKUP", source_field: "category", lookup: { map: { "rotating/pump": "P" } } }, SOURCE),
      "P"
    );
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "LOOKUP", source_field: "category", lookup: { source: "cats", default: "D" } },
        SOURCE,
        { lookupResolver: () => undefined }
      ),
      "D"
    );
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "LOOKUP", source_field: "category", lookup: { source: "cats" } },
        SOURCE,
        { lookupResolver: () => "R" }
      ),
      "R"
    );
    assert.throws(
      () => Mapping.mapRecord({ mapping_type: "LOOKUP", source_field: "category", lookup: { required: true } }, SOURCE),
      (error) => error.code === "DATA_EXCHANGE_INVALID_LOOKUP"
    );
  });

  test("maps CONDITIONAL, CONCAT and SPLIT", () => {
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "CONDITIONAL", source_field: "qty", condition: { expression: "qty > 3", then: "BIG", else: "SMALL" } },
        SOURCE
      ),
      "BIG"
    );
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "CONDITIONAL", source_field: "qty", condition: { when: "qty < 3", then: "SMALL", else: "BIG" } },
        SOURCE
      ),
      "BIG"
    );
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "CONDITIONAL", source_field: "active", condition: { expression: "active", then: "{{part_name}}!" } },
        SOURCE
      ),
      "Pump!"
    );
    assert.equal(
      Mapping.mapRecord({ mapping_type: "CONCAT", concat: ["part_number", "part_name"], condition: { separator: " - " } }, SOURCE),
      "P-1 - Pump"
    );
    assert.equal(
      Mapping.mapRecord({ mapping_type: "CONCAT", concat: ["part_number", { expression: "part_name" }] }, SOURCE),
      "P-1Pump"
    );
    assert.equal(
      Mapping.mapRecord({ mapping_type: "SPLIT", source_field: "category", split: { separator: "/", index: 0 } }, SOURCE),
      "rotating"
    );
    assert.equal(
      Mapping.mapRecord(
        { mapping_type: "SPLIT", source_field: "category", split: { separator: "|", index: 5, default: "fallback" } },
        SOURCE
      ),
      "fallback"
    );
  });

  test("maps EXPRESSION, NESTED and ARRAY", () => {
    assert.equal(
      Mapping.mapRecord({ mapping_type: "EXPRESSION", source_field: "part_number", expression: "lower(value)" }, SOURCE),
      "p-1"
    );
    assert.deepEqual(
      Mapping.mapRecord(
        {
          mapping_type: "NESTED",
          nested: {
            fields: [
              { source_field: "part_number", target_field: "pn" },
              { expression: "part_name", target_field: "nm" },
            ],
          },
        },
        SOURCE
      ),
      { pn: "P-1", nm: "Pump" }
    );
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "NESTED", source_field: "nested" }, SOURCE), { a: 1, b: 2 });
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "ARRAY", nested: { items: ["part_number", "part_name"] } }, SOURCE), [
      "P-1",
      "Pump",
    ]);
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "ARRAY", nested: { items: [{ source_field: "part_number" }] } }, SOURCE), [
      "P-1",
    ]);
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "ARRAY", source_field: "list" }, SOURCE), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "ARRAY", source_field: "qty" }, SOURCE), ["5"]);
    assert.deepEqual(Mapping.mapRecord({ mapping_type: "ARRAY", source_field: "missing" }, SOURCE), []);
    assert.throws(
      () => Mapping.mapRecord({ mapping_type: "BOGUS" }, SOURCE),
      (error) => error.code === "INVALID_DATA_EXCHANGE_MAPPING"
    );
  });

  test("applyMappings orders, filters, transforms and reports errors", () => {
    const mappings = [
      { mapping_type: "DIRECT", source_field: "b", target_field: "second", sequence: 20 },
      { mapping_type: "DIRECT", source_field: "a", target_field: "first", sequence: 10 },
      { mapping_type: "DIRECT", source_field: "a", target_field: "skipped", status: "inactive" },
      { mapping_type: "CONSTANT", target_field: "up", constant_value: "x", sequence: 30, transform: [{ transformation_type: "UPPERCASE" }] },
      { mapping_type: "DIRECT", source_field: "missing", target_field: "required_one", required: true, sequence: 40 },
      { mapping_type: "BOGUS", target_field: "boom", sequence: 50 },
    ];
    const { target, errors } = Mapping.applyMappings(mappings, { a: "A", b: "B" });
    assert.deepEqual(Object.keys(target), ["first", "second", "up"]);
    assert.equal(target.first, "A");
    assert.equal(target.second, "B");
    assert.equal(target.up, "X");
    assert.ok(errors.some((entry) => entry.code === "required" && entry.field === "required_one"));
    assert.ok(errors.some((entry) => entry.code === "INVALID_DATA_EXCHANGE_MAPPING" && entry.field === "boom"));
  });

  test("applyMappings supports nested target paths", () => {
    const { target, errors } = Mapping.applyMappings(
      [{ mapping_type: "DIRECT", source_field: "part_number", target_field: "nested.code" }],
      SOURCE
    );
    assert.equal(errors.length, 0);
    assert.deepEqual(target, { nested: { code: "P-1" } });
  });

  test("validateMappings blocks missing, duplicate and unknown targets", () => {
    const empty = Mapping.validateMappings([]);
    assert.equal(empty.valid, false);
    assert.equal(empty.errors[0].code, "no_mappings");

    const missing = Mapping.validateMappings([{ source_field: "a" }]);
    assert.ok(missing.errors.some((entry) => entry.code === "missing_target"));

    const duplicate = Mapping.validateMappings([
      { source_field: "a", target_field: "name" },
      { source_field: "b", target_field: "name" },
    ]);
    assert.ok(duplicate.errors.some((entry) => entry.code === "duplicate_target"));

    const unknown = Mapping.validateMappings([{ source_field: "a", target_field: "name" }], { targetFields: ["code"] });
    assert.ok(unknown.errors.some((entry) => entry.code === "unknown_target"));

    const nestedAllowed = Mapping.validateMappings([{ mapping_type: "NESTED", source_field: "nested", target_field: "blob" }], {
      targetFields: ["code"],
    });
    assert.equal(nestedAllowed.valid, true);
  });

  test("validateMappings warns on unknown sources and checks expressions/lookups/constants", () => {
    const result = Mapping.validateMappings(
      [
        { source_field: "part_number", target_field: "code" },
        { source_field: "ghost", target_field: "name" },
        { mapping_type: "EXPRESSION", target_field: "expr", expression: "upper(" },
        { mapping_type: "LOOKUP", target_field: "lookup" },
        { mapping_type: "CONSTANT", target_field: "constant" },
      ],
      { sourceFields: ["part_number"], targetFields: ["code", "name", "expr", "lookup", "constant"] }
    );
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some((entry) => entry.code === "unknown_source" && entry.field === "ghost"));
    assert.ok(result.errors.some((entry) => entry.code === "invalid_expression"));
    assert.ok(result.errors.some((entry) => entry.code === "missing_lookup"));
    assert.ok(result.errors.some((entry) => entry.code === "missing_constant"));
  });

  test("validateMappings accepts a custom expression validator", () => {
    const result = Mapping.validateMappings([{ mapping_type: "EXPRESSION", target_field: "x", expression: "anything" }], {
      expressionValidator: () => ({ valid: false, errors: [{ message: "not allowed" }] }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, "invalid_expression");
    assert.equal(result.errors[0].message, "not allowed");
  });

  test("validateMappings flags a missing EXPRESSION expression", () => {
    const result = Mapping.validateMappings([{ mapping_type: "EXPRESSION", target_field: "x" }]);
    assert.ok(result.errors.some((entry) => entry.code === "missing_expression"));
  });
});

describe("data-exchange validation engine", () => {
  const record = { code: "P-1", qty: 5, status: "active", email: "a@b.com" };

  test("registers every documented rule type", () => {
    const types = ValidationRules.validationTypes();
    for (const expected of [
      "REQUIRED",
      "TYPE",
      "RANGE",
      "LENGTH",
      "PATTERN",
      "EMAIL",
      "ENUM",
      "EXPRESSION",
      "UNIQUE",
      "LOOKUP_EXISTS",
      "REFERENCE_EXISTS",
      "DATE",
    ]) {
      assert.ok(types.includes(expected), `missing rule type ${expected}`);
    }
  });

  test("REQUIRED passes and fails", () => {
    assert.equal(ValidationRules.evaluateRule({ rule_type: "REQUIRED", target_field: "code" }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "REQUIRED", target_field: "missing" }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "REQUIRED", target_field: "blank" }, { blank: "  " }).passed, false);
  });

  test("TYPE checks each declared data type", () => {
    const pass = (value, dataType) =>
      ValidationRules.evaluateRule({ rule_type: "TYPE", target_field: "v", config: { data_type: dataType } }, { v: value }).passed;
    assert.equal(pass("text", "STRING"), true);
    assert.equal(pass("5", "NUMBER"), true);
    assert.equal(pass("abc", "NUMBER"), false);
    assert.equal(pass("5", "INTEGER"), true);
    assert.equal(pass("5.5", "INTEGER"), false);
    assert.equal(pass("true", "BOOLEAN"), true);
    assert.equal(pass(true, "BOOLEAN"), true);
    assert.equal(pass("maybe", "BOOLEAN"), false);
    assert.equal(pass("2024-01-01", "DATE"), true);
    assert.equal(pass("nope", "DATE"), false);
    assert.equal(pass([1], "ARRAY"), true);
    assert.equal(pass("x", "ARRAY"), false);
    assert.equal(pass({}, "OBJECT"), true);
    assert.equal(pass("x", "OBJECT"), false);
    assert.equal(pass(null, "INTEGER"), true);
    assert.equal(pass("", "INTEGER"), true);
  });

  test("RANGE, LENGTH and PATTERN rules", () => {
    assert.equal(ValidationRules.evaluateRule({ rule_type: "RANGE", target_field: "qty", config: { min: 1, max: 10 } }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "RANGE", target_field: "qty", config: { max: 3 } }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "RANGE", target_field: "qty", config: { min: 9 } }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "RANGE", target_field: "qty", config: { min: 0 } }, { qty: "abc" }).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "RANGE", target_field: "qty", config: { min: 0 } }, { qty: null }).passed, true);

    assert.equal(ValidationRules.evaluateRule({ rule_type: "LENGTH", target_field: "code", config: { min: 2, max: 4 } }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "LENGTH", target_field: "code", config: { max: 2 } }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "LENGTH", target_field: "code", config: { min: 5 } }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "LENGTH", target_field: "missing", config: { max: 0 } }, record).passed, true);

    assert.equal(ValidationRules.evaluateRule({ rule_type: "PATTERN", target_field: "code", config: { pattern: "^P-" } }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "PATTERN", target_field: "code", config: { regex: "^X-" } }, record).passed, false);
    const invalidPattern = ValidationRules.evaluateRule({ rule_type: "PATTERN", target_field: "code", config: { pattern: "(" } }, record);
    assert.equal(invalidPattern.passed, false);
    assert.match(invalidPattern.message, /invalid/i);
  });

  test("EMAIL, ENUM and EXPRESSION rules", () => {
    assert.equal(ValidationRules.evaluateRule({ rule_type: "EMAIL", target_field: "email" }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "EMAIL", target_field: "email" }, { email: "bad" }).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "EMAIL", target_field: "email" }, { email: null }).passed, true);

    assert.equal(ValidationRules.evaluateRule({ rule_type: "ENUM", target_field: "status", config: { values: ["active"] } }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "ENUM", target_field: "status", config: { enum: ["draft"] } }, record).passed, false);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "ENUM", target_field: "status", config: {} }, record).passed, false);

    assert.equal(ValidationRules.evaluateRule({ rule_type: "EXPRESSION", target_field: "qty", config: { expression: "qty > 1" } }, record).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "EXPRESSION", target_field: "qty", config: { expression: "qty > 99" } }, record).passed, false);
  });

  test("UNIQUE, LOOKUP_EXISTS and REFERENCE_EXISTS use injected checkers", () => {
    assert.equal(ValidationRules.evaluateRule({ rule_type: "UNIQUE", target_field: "code" }, record).passed, true);
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "UNIQUE", target_field: "code" }, record, { uniqueChecker: () => false }).passed,
      false
    );
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "UNIQUE", target_field: "code" }, record, { uniqueChecker: () => true }).passed,
      true
    );
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "LOOKUP_EXISTS", target_field: "code" }, record, { lookupChecker: () => false }).passed,
      false
    );
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "REFERENCE_EXISTS", target_field: "code" }, record, { referenceChecker: () => false })
        .passed,
      false
    );
    assert.equal(ValidationRules.evaluateRule({ rule_type: "UNIQUE", target_field: "missing" }, record).passed, true);
  });

  test("DATE rule enforces parseability and reference bounds", () => {
    assert.equal(ValidationRules.evaluateRule({ rule_type: "DATE", target_field: "when" }, { when: "2020-01-01" }).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "DATE", target_field: "when" }, { when: "nope" }).passed, false);
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "DATE", target_field: "when", config: { not_future: true } }, { when: "2999-01-01" }).passed,
      false
    );
    assert.equal(
      ValidationRules.evaluateRule({ rule_type: "DATE", target_field: "when", config: { not_past: true } }, { when: "2000-01-01" }).passed,
      false
    );
    assert.equal(
      ValidationRules.evaluateRule(
        { rule_type: "DATE", target_field: "when", config: { not_past: true, reference: "2030-01-01" } },
        { when: "2040-01-01" }
      ).passed,
      true
    );
  });

  test("evaluateRule reports metadata and unknown rule types", () => {
    const result = ValidationRules.evaluateRule({ rule_type: "REQUIRED", target_field: "code", level: "RECORD", severity: "WARNING" }, record);
    assert.equal(result.rule, "REQUIRED");
    assert.equal(result.field, "code");
    assert.equal(result.level, "RECORD");
    assert.equal(result.severity, "WARNING");
    assert.equal(result.value, "P-1");

    const unknown = ValidationRules.evaluateRule({ rule_type: "NOPE", target_field: "x" }, record);
    assert.equal(unknown.passed, false);
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.severity, "ERROR");
  });

  test("evaluateRules categorizes severities and honors sequence/inactive", () => {
    const rules = [
      { rule_type: "REQUIRED", target_field: "a", severity: "WARNING", sequence: 2 },
      { rule_type: "REQUIRED", target_field: "b", severity: "ERROR", sequence: 1 },
      { rule_type: "REQUIRED", target_field: "c", severity: "INFO", status: "inactive" },
    ];
    const result = ValidationRules.evaluateRules(rules, {});
    assert.equal(result.results.length, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.infos.length, 0);
    assert.equal(result.hasErrors, true);
    assert.equal(result.results[0].field, "b");
  });

  test("validateRule checks definitions without running them", () => {
    assert.equal(ValidationRules.validateRule({ rule_type: "REQUIRED", target_field: "code" }).valid, true);
    assert.ok(ValidationRules.validateRule({ rule_type: "NOPE", target_field: "code" }).errors.some((e) => e.code === "unknown_rule"));
    assert.ok(ValidationRules.validateRule({ rule_type: "REQUIRED" }).errors.some((e) => e.code === "missing_field"));
    assert.ok(ValidationRules.validateRule({ rule_type: "REQUIRED", level: "RECORD" }).errors.some((e) => e.code === "missing_field"));
    assert.ok(
      ValidationRules.validateRule({ rule_type: "EXPRESSION", level: "RECORD", config: {} }).errors.some((e) => e.code === "missing_expression")
    );
    assert.equal(ValidationRules.validateRule({ rule_type: "EXPRESSION", level: "RECORD", config: { expression: "true" } }).valid, true);
    assert.equal(ValidationRules.validateRule({ rule_type: "REQUIRED", level: "FILE" }).valid, true);
  });

  test("registers custom validation handlers", () => {
    assert.throws(() => ValidationRules.registerValidationHandler("", () => {}));
    ValidationRules.registerValidationHandler("EVEN", (value) => (Number(value) % 2 === 0 ? { passed: true } : { passed: false, message: "odd" }));
    assert.ok(ValidationRules.validationTypes().includes("EVEN"));
    assert.equal(ValidationRules.evaluateRule({ rule_type: "even", target_field: "n" }, { n: 2 }).passed, true);
    assert.equal(ValidationRules.evaluateRule({ rule_type: "EVEN", target_field: "n" }, { n: 3 }).passed, false);
  });
});

describe("data-exchange lookup engine", () => {
  test("manages lookup source registration", () => {
    assert.throws(() => Lookup.registerLookupSource("", () => {}));
    assert.throws(() => Lookup.registerLookupSource("X", null));
    assert.equal(Lookup.hasLookupSource("CATS"), false);
    assert.equal(Lookup.registerLookupSource("CATS", (value) => value.toUpperCase(), { description: "categories" }), "CATS");
    assert.equal(Lookup.hasLookupSource("cats"), true);
    assert.ok(Lookup.listLookupSources().some((entry) => entry.code === "CATS" && entry.description === "categories"));
    assert.equal(Lookup.unregisterLookupSource("cats"), true);
    assert.equal(Lookup.hasLookupSource("CATS"), false);
    assert.equal(Lookup.unregisterLookupSource("CATS"), false);
  });

  test("requiresLookupSource is false only for static maps", () => {
    assert.equal(Lookup.requiresLookupSource({ map: { a: 1 } }), false);
    assert.equal(Lookup.requiresLookupSource({ source: "CATS" }), true);
    assert.equal(Lookup.requiresLookupSource({}), true);
  });

  test("resolveLookup handles static maps and defaults", () => {
    assert.equal(Lookup.resolveLookup("a", { map: { a: "A" } }), "A");
    assert.equal(Lookup.resolveLookup("z", { map: { a: "A" }, default: "D" }), "D");
    assert.equal(Lookup.resolveLookup("z", { map: { a: "A" } }), "z");
  });

  test("createLookupResolver resolves static maps and registered sources", () => {
    const resolver = Lookup.createLookupResolver({ staticMaps: { CATS: { a: "A" } } });
    assert.equal(resolver("a", { source: "cats" }), "A");
    assert.equal(resolver("z", { source: "cats", default: "D" }), "D");
    assert.equal(resolver("z", { source: "cats" }), "z");
    assert.equal(resolver("a", { map: { a: "M" } }), "M");

    Lookup.registerLookupSource("COUNT", (value) => `#${value}`);
    const fromRegistry = Lookup.createLookupResolver();
    assert.equal(fromRegistry("3", { lookup_definition: "count" }), "#3");
    assert.equal(fromRegistry("3", { lookupDefinition: "COUNT" }), "#3");
    Lookup.unregisterLookupSource("COUNT");
  });

  test("createLookupResolver falls back to defaults and throws when unregistered", () => {
    const resolver = Lookup.createLookupResolver();
    assert.equal(resolver("x", { source: "MISSING", default: "FALLBACK" }), "FALLBACK");
    assert.throws(() => resolver("x", { source: "MISSING" }), (error) => error.code === "DATA_EXCHANGE_INVALID_LOOKUP");
  });

  test("createLookupResolver caches per source and value", () => {
    let calls = 0;
    Lookup.registerLookupSource("MEMO", (value) => {
      calls += 1;
      return value;
    });
    const resolver = Lookup.createLookupResolver();
    resolver("a", { source: "MEMO" });
    resolver("a", { source: "MEMO" });
    assert.equal(calls, 1);
    resolver("b", { source: "MEMO" });
    assert.equal(calls, 2);
    Lookup.unregisterLookupSource("MEMO");
  });

  test("createLookupResolver evicts the cache when it reaches the configured size", () => {
    let calls = 0;
    Lookup.registerLookupSource("MEMO_TINY", (value) => {
      calls += 1;
      return value;
    });
    const resolver = Lookup.createLookupResolver({ cacheSize: 1 });
    resolver("a", { source: "MEMO_TINY" });
    resolver("a", { source: "MEMO_TINY" });
    assert.equal(calls, 1);
    resolver("b", { source: "MEMO_TINY" });
    assert.equal(calls, 2);
    resolver("a", { source: "MEMO_TINY" });
    assert.equal(calls, 3);
    Lookup.unregisterLookupSource("MEMO_TINY");
  });
});

describe("data-exchange duplicate engine", () => {
  test("computes business, unique and expression keys", () => {
    assert.equal(Duplicate.computeDuplicateKey({ code: "P", rev: "A" }, { fields: ["code", "rev"] }), "P|A");
    assert.equal(Duplicate.computeDuplicateKey({ code: "P", rev: "A" }, { type: "UNIQUE_FIELDS", key_fields: ["code", "rev"] }), "P|A");
    assert.equal(Duplicate.computeDuplicateKey({ code: "P", rev: null }, { fields: ["code", "rev"] }), "P|");
    assert.equal(Duplicate.computeDuplicateKey({ code: "X" }, { expression: "code" }), "X");
    assert.throws(() => Duplicate.computeDuplicateKey({ code: "X" }, {}), (error) => error.code === "INVALID_DATA_EXCHANGE_MAPPING");
  });

  test("computes identity and external-reference keys", () => {
    assert.equal(Duplicate.computeDuplicateKey({ id: 5 }, { type: "OBJECT_ID" }), 5);
    assert.equal(Duplicate.computeDuplicateKey({ objectId: 6 }, { key_type: "OBJECT_ID" }), 6);
    assert.equal(Duplicate.computeDuplicateKey({ external_reference: "ER-1" }, { type: "EXTERNAL_REFERENCE" }), "ER-1");
    assert.equal(Duplicate.computeDuplicateKey({ externalReference: "ER-2" }, { type: "EXTERNAL_REFERENCE" }), "ER-2");
    assert.equal(Duplicate.computeDuplicateKey({ source_external_id: "S-1" }, { type: "SOURCE_EXTERNAL_ID" }), "S-1");
    assert.equal(Duplicate.computeDuplicateKey({}, { type: "OBJECT_ID" }), "");
  });

  test("decideDuplicate covers every strategy", () => {
    assert.equal(Duplicate.decideDuplicate("REJECT", {}).action, "CREATE");
    assert.equal(Duplicate.decideDuplicate("REJECT", { existing: {} }).action, "REJECT");
    assert.equal(Duplicate.decideDuplicate("SKIP", { existing: {} }).action, "SKIP");
    assert.equal(Duplicate.decideDuplicate("UPDATE", { existing: {}, changed: true }).action, "UPDATE");
    assert.equal(Duplicate.decideDuplicate("UPDATE", { existing: {}, changed: false }).action, "SKIP");
    assert.equal(Duplicate.decideDuplicate("UPSERT", { existing: {}, changed: true }).action, "UPDATE");
    assert.equal(Duplicate.decideDuplicate("UPSERT", { existing: {}, changed: false }).action, "SKIP");
    assert.equal(Duplicate.decideDuplicate("CREATE_NEW", { existing: {} }).action, "CREATE");
    assert.equal(Duplicate.decideDuplicate("MERGE", { existing: {} }).action, "MERGE");
    assert.equal(Duplicate.decideDuplicate("upsert", { existing: {}, changed: true }).strategy, "UPSERT");
    assert.throws(() => Duplicate.decideDuplicate("BOGUS", { existing: {} }), (error) => error.code === "INVALID_DATA_EXCHANGE_DUPLICATE_STRATEGY");
  });

  test("mergeRecords keeps non-empty incoming values and merges nested objects", () => {
    const merged = Duplicate.mergeRecords(
      { a: 1, b: 2, nested: { x: 1, y: 2 }, list: [1], keep: "old" },
      { b: 3, nested: { y: 9, z: 3 }, list: [2], keep: null, dropped: "", also: undefined }
    );
    assert.deepEqual(merged, { a: 1, b: 3, nested: { x: 1, y: 9, z: 3 }, list: [2], keep: "old" });
    assert.deepEqual(Duplicate.mergeRecords(null, { a: 1 }), { a: 1 });
    assert.deepEqual(Duplicate.mergeRecords({ a: 1 }, null), { a: 1 });
  });
});

describe("data-exchange schema engine", () => {
  test("exposes built-in object fields", () => {
    assert.equal(Schema.OBJECT_BUILTIN_FIELDS.length, 10);
    const names = Schema.OBJECT_BUILTIN_FIELDS.map((field) => field.name);
    for (const expected of ["code", "name", "description", "external_ref", "status", "revision", "owner_id", "tags"]) {
      assert.ok(names.includes(expected), `missing built-in field ${expected}`);
    }
    assert.ok(Schema.OBJECT_BUILTIN_FIELDS.every((field) => field.system === true));
  });

  test("targetSchema builds a schema from platform metadata", () => {
    const schema = Schema.targetSchema(db, 1, "product");
    assert.equal(schema.object_type, "product");
    assert.equal(schema.name, "Product");
    assert.equal(typeof schema.type_id, "number");
    assert.equal(schema.fields.length, 14);
    assert.deepEqual(schema.required_fields, ["part.number", "part.name", "part.category", "part.status"]);
    for (const name of ["code", "name", "part.number", "part.name", "part.category", "part.status"]) {
      assert.ok(schema.field_names.includes(name), `missing field ${name}`);
    }
    const attr = schema.fields.find((field) => field.name === "part.number");
    assert.equal(attr.system, false);
    assert.equal(attr.required, true);
  });

  test("targetSchema throws for unknown or empty object types", () => {
    assert.throws(() => Schema.targetSchema(db, 1, "does-not-exist"), (error) => error.code === "DATA_EXCHANGE_SCHEMA_DISCOVERY_FAILED");
    assert.throws(() => Schema.targetSchema(db, 1, ""), (error) => error.code === "DATA_EXCHANGE_SCHEMA_DISCOVERY_FAILED");
  });

  test("validateTargetRecord enforces required, unknown and strict fields", () => {
    const schema = Schema.targetSchema(db, 1, "product");
    const complete = { "part.number": "P", "part.name": "N", "part.category": "c", "part.status": "s" };
    assert.equal(Schema.validateTargetRecord(schema, complete).valid, true);

    const missing = Schema.validateTargetRecord(schema, { "part.number": "P" });
    assert.equal(missing.valid, false);
    assert.equal(missing.errors.filter((entry) => entry.code === "required").length, 3);

    const lenient = Schema.validateTargetRecord(schema, { ...complete, extra: 1 });
    assert.equal(lenient.valid, true);
    assert.equal(lenient.warnings[0].code, "unknown_field");

    const strict = Schema.validateTargetRecord(schema, { ...complete, extra: 1 }, { strict: true });
    assert.equal(strict.valid, false);
    assert.equal(strict.errors[0].code, "unknown_field");
  });

  test("validateTargetRecord detects data-type mismatches", () => {
    const schema = {
      fields: [
        { name: "id", data_type: "integer" },
        { name: "price", data_type: "decimal" },
        { name: "flag", data_type: "boolean" },
        { name: "due", data_type: "date" },
        { name: "tags", data_type: "multi_value" },
      ],
      required_fields: [],
    };
    const bad = Schema.validateTargetRecord(schema, { id: "x", price: "abc", flag: "maybe", due: "nope", tags: 5 });
    assert.equal(bad.valid, false);
    assert.equal(bad.errors.filter((entry) => entry.code === "type_mismatch").length, 5);

    const good = Schema.validateTargetRecord(schema, { id: "3", price: "1.5", flag: true, due: "2024-01-01", tags: ["a"] });
    assert.equal(good.valid, true);
  });

  test("inferFields and inferDataType describe sample records", () => {
    assert.equal(Schema.inferDataType("12"), "integer");
    assert.equal(Schema.inferDataType("1.5"), "number");
    assert.equal(Schema.inferDataType("true"), "boolean");
    assert.equal(Schema.inferDataType("2024-01-01"), "datetime");
    assert.equal(Schema.inferDataType([1]), "array");
    assert.equal(Schema.inferDataType({}), "object");
    assert.equal(Schema.inferDataType(""), "string");
    assert.deepEqual(Schema.inferFields([{ a: 1, b: "x" }, { c: true }]), [
      { name: "a", data_type: "integer" },
      { name: "b", data_type: "string" },
      { name: "c", data_type: "boolean" },
    ]);
  });

  test("discoverSourceSchema uses a connector's own discovery", async () => {
    const connector = {
      code: "FAKE",
      capabilities: ["SCHEMA_DISCOVERY"],
      discoverSchema: () => ({
        fields: ["a", { name: "b", sample: "3" }],
        sample: Array.from({ length: 11 }, (_, index) => ({ a: String(index) })),
      }),
    };
    const result = await Schema.discoverSourceSchema(connector, {});
    assert.equal(result.discovered_via, "connector");
    assert.deepEqual(result.fields, [
      { name: "a", data_type: "string" },
      { name: "b", data_type: "integer" },
    ]);
    assert.equal(result.sample.length, 10);
  });

  test("discoverSourceSchema falls back to a bounded read", async () => {
    let receivedLimit = null;
    const connector = {
      code: "FAKEREAD",
      capabilities: [],
      read: (ctx) => {
        receivedLimit = ctx.limit;
        return { records: [{ x: "1", y: "2" }] };
      },
    };
    const result = await Schema.discoverSourceSchema(connector, {});
    assert.equal(receivedLimit, 10);
    assert.equal(result.discovered_via, "read");
    assert.deepEqual(result.fields, [
      { name: "x", data_type: "integer" },
      { name: "y", data_type: "integer" },
    ]);
  });

  test("discoverSourceSchema validates, wraps and rethrows errors", async () => {
    await assert.rejects(() => Schema.discoverSourceSchema(null), (error) => error.code === "DATA_EXCHANGE_SCHEMA_DISCOVERY_FAILED");
    const noRead = { code: "NOREAD", capabilities: [] };
    const emptyFallback = await Schema.discoverSourceSchema(noRead);
    assert.equal(emptyFallback.discovered_via, "read");
    assert.deepEqual(emptyFallback.fields, []);

    const boom = {
      code: "BOOM",
      capabilities: ["SCHEMA_DISCOVERY"],
      discoverSchema: () => {
        throw new Error("kaboom");
      },
    };
    await assert.rejects(
      () => Schema.discoverSourceSchema(boom),
      (error) => error.code === "DATA_EXCHANGE_SCHEMA_DISCOVERY_FAILED" && /kaboom/.test(error.message)
    );

    const coded = {
      code: "CODED",
      capabilities: ["SCHEMA_DISCOVERY"],
      discoverSchema: () => {
        const error = new Error("custom");
        error.code = "CUSTOM_CODE";
        throw error;
      },
    };
    await assert.rejects(() => Schema.discoverSourceSchema(coded), (error) => error.code === "CUSTOM_CODE");
  });

  test("discoverSourceSchema works with a real registered connector", async () => {
    const result = await Schema.discoverSourceSchema(Connectors.get("CSV"), { content: "a,b\n1,2\n3,4\n" });
    assert.equal(result.discovered_via, "connector");
    assert.deepEqual(result.fields, [
      { name: "a", data_type: "integer" },
      { name: "b", data_type: "integer" },
    ]);
  });
});

describe("data-exchange codecs", () => {
  test("infers data types and fields", () => {
    assert.equal(Codecs.inferDataType(null), "string");
    assert.equal(Codecs.inferDataType(undefined), "string");
    assert.equal(Codecs.inferDataType(true), "boolean");
    assert.equal(Codecs.inferDataType(3), "integer");
    assert.equal(Codecs.inferDataType(3.5), "number");
    assert.equal(Codecs.inferDataType([1]), "array");
    assert.equal(Codecs.inferDataType({}), "object");
    assert.equal(Codecs.inferDataType("5"), "integer");
    assert.equal(Codecs.inferDataType("5.5"), "number");
    assert.equal(Codecs.inferDataType("2024-01-01T00:00:00"), "datetime");
    assert.equal(Codecs.inferDataType("TRUE"), "boolean");
    assert.equal(Codecs.inferDataType("abc"), "string");
    assert.deepEqual(Codecs.inferFields([{ a: "1", b: "x" }, { a: "2" }]), [
      { name: "a", data_type: "integer" },
      { name: "b", data_type: "string" },
    ]);
    assert.deepEqual(Codecs.inferFields([]), []);
  });

  test("parses CSV with custom delimiters, no header and quoting", () => {
    assert.deepEqual(Codecs.parseCsv("a;b\n1;2\n", { delimiter: ";" }).records, [{ a: "1", b: "2" }]);
    assert.deepEqual(Codecs.parseCsv("1,2\n3,4\n", { hasHeader: false }).records, [
      { column_1: "1", column_2: "2" },
      { column_1: "3", column_2: "4" },
    ]);
    assert.deepEqual(Codecs.parseCsv('a,b\n"x\ny",2\n').records, [{ a: "x\ny", b: "2" }]);
    assert.deepEqual(Codecs.parseCsv('a,b\n"x""y",2\n').records, [{ a: 'x"y', b: "2" }]);
    assert.deepEqual(Codecs.parseCsv("\uFEFFa,b\n1,2\n").records, [{ a: "1", b: "2" }]);
    assert.deepEqual(Codecs.parseCsv(""), { fields: [], records: [] });
  });

  test("serializes CSV with headers, escaping and object field descriptors", () => {
    const withHeader = Codecs.serializeCsv([{ a: "x,y" }], ["a"]);
    assert.equal(withHeader.content, 'a\n"x,y"');
    assert.equal(withHeader.extension, "csv");
    assert.equal(withHeader.content_type, "text/csv; charset=utf-8");

    const noHeader = Codecs.serializeCsv([{ a: "x", b: "y" }], [{ name: "a" }, { name: "b" }], { includeHeader: false });
    assert.equal(noHeader.content, "x,y");

    const inferred = Codecs.serializeCsv([{ a: "1" }]);
    assert.equal(inferred.content, "a\n1");

    const objectValue = Codecs.serializeCsv([{ a: { b: 1 } }], ["a"], { includeHeader: false });
    assert.equal(objectValue.content, '"{""b"":1}"');
  });

  test("parses JSON arrays, wrapped payloads, recordsPath and NDJSON", () => {
    assert.deepEqual(Codecs.parseJson('[{"a":1}]').records, [{ a: 1 }]);
    assert.deepEqual(Codecs.parseJson('{"meta":{},"items":[{"a":1},{"a":2}]}').records, [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(Codecs.parseJson('{"payload":{"rows":[{"a":1}]}}', { recordsPath: "payload.rows" }).records, [{ a: 1 }]);
    assert.deepEqual(Codecs.parseJson('{"a":1}').records, [{ a: 1 }]);
    assert.deepEqual(Codecs.parseJson('{"a":1}\n{"a":2}\n', { ndjson: true }).records, [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(Codecs.parseJson("  "), { fields: [], records: [] });
  });

  test("serializes JSON and NDJSON", () => {
    assert.equal(Codecs.serializeJson([{ a: 1 }]).content, '[\n  {\n    "a": 1\n  }\n]');
    assert.equal(Codecs.serializeJson([{ a: 1 }], null, { pretty: false }).content, '[{"a":1}]');
    const ndjson = Codecs.serializeJson([{ a: 1 }, { a: 2 }], null, { ndjson: true });
    assert.equal(ndjson.content, '{"a":1}\n{"a":2}');
    assert.equal(ndjson.extension, "ndjson");
    assert.equal(ndjson.content_type, "application/x-ndjson");
  });

  test("escapes and unescapes XML entities", () => {
    assert.equal(Codecs.escapeXml('a<b>&"\''), "a&lt;b&gt;&amp;&quot;&apos;");
    assert.equal(Codecs.unescapeXml("a&lt;b&gt;&amp;&quot;&apos;"), "a<b>&\"'");
    assert.equal(Codecs.escapeXml(null), "");
    assert.equal(Codecs.unescapeXml(null), "");
  });

  test("parses an XML tree with attributes, CDATA and comments", () => {
    const tree = Codecs.parseXmlTree('<root x="1"><item>a</item><!-- note --><item><![CDATA[b<c]]></item></root>');
    assert.equal(tree.name, "#document");
    const root = tree.children[0];
    assert.equal(root.name, "root");
    assert.equal(root.attributes.x, "1");
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1].text, "b<c");
  });

  test("converts XML nodes to values including repeated children", () => {
    const tree = Codecs.parseXmlTree("<root><item>a</item><item>b</item><n>1</n></root>");
    assert.deepEqual(Codecs.xmlNodeToValue(tree.children[0]), { item: ["a", "b"], n: "1" });
    const leaf = Codecs.parseXmlTree("<a>  spaced  </a>").children[0];
    assert.equal(Codecs.xmlNodeToValue(leaf), "spaced");
  });

  test("parses XML records automatically and by recordPath", () => {
    const auto = Codecs.parseXml("<root><item><n>1</n></item><item><n>2</n></item></root>");
    assert.equal(auto.records.length, 2);
    assert.deepEqual(auto.records[0], { n: "1" });

    const single = Codecs.parseXml("<records><record><code>A</code></record></records>");
    assert.equal(single.records.length, 1);
    assert.equal(single.records[0].code, "A");

    const scoped = Codecs.parseXml(
      "<root><groups><item><n>1</n></item></groups><groups><item><n>2</n></item></groups></root>",
      { recordPath: "groups.item" }
    );
    assert.deepEqual(scoped.records, [{ n: "1" }, { n: "2" }]);
  });

  test("serializes XML records and round-trips scalars", () => {
    const xml = Codecs.serializeXml([{ code: "A-1", name: "Pump" }], ["code", "name"]);
    assert.equal(xml.extension, "xml");
    assert.equal(xml.content_type, "application/xml; charset=utf-8");
    const parsed = Codecs.parseXml(xml.content);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].code, "A-1");
    assert.equal(parsed.records[0].name, "Pump");
  });

  test("round-trips the SpreadsheetML codec", () => {
    const sheet = Codecs.serializeSpreadsheet([{ code: "A-1", name: "Pump" }], ["code", "name"]);
    assert.equal(sheet.extension, "xls");
    const parsed = Codecs.parseSpreadsheet(sheet.content);
    assert.deepEqual(parsed.records, [{ code: "A-1", name: "Pump" }]);

    const withEmpty = Codecs.parseSpreadsheet(
      '<Workbook><Worksheet><Table><Row><Cell><Data ss:Type="String">a</Data></Cell><Cell/></Row><Row><Cell><Data ss:Type="String">1</Data></Cell><Cell/></Row></Table></Worksheet></Workbook>'
    );
    assert.deepEqual(withEmpty.records, [{ a: "1", column_2: "" }]);
    assert.deepEqual(Codecs.parseSpreadsheet("<Workbook/>"), { fields: [], records: [] });
  });
});

describe("data-exchange connector registry", () => {
  test("lists the built-in connector types", () => {
    const types = Registry.connectorTypes();
    assert.equal(types.length, 12);
    assert.equal(Registry.listConnectors().length, 12);
    for (const code of ["CSV", "EXCEL", "JSON", "XML", "REST", "DATABASE", "FILE", "CLOUD_STORAGE", "LEGACY_PLM", "ERP", "CAD", "MES"]) {
      assert.ok(types.includes(code), `missing connector ${code}`);
    }
  });

  test("looks up connectors defensively", () => {
    assert.equal(Registry.getConnector("csv").code, "CSV");
    assert.equal(Registry.getConnector(null), null);
    assert.equal(Registry.getConnector("NOPE"), null);
    assert.throws(() => Registry.requireConnector("NOPE"), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_NOT_FOUND");
    assert.equal(Registry.requireConnector("CSV").code, "CSV");
    assert.equal(Registry.supportsCapability("CSV", "READ"), true);
    assert.equal(Registry.supportsCapability("CSV", "TRANSACTION"), false);
    assert.equal(Registry.supportsCapability("NOPE", "READ"), false);
  });

  test("asserts capabilities and directions", () => {
    assert.equal(Registry.assertConnectorCapability("CSV", "READ").code, "CSV");
    assert.throws(() => Registry.assertConnectorCapability("FILE", "WRITE"), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED");
    assert.equal(Registry.assertConnectorDirection("FILE", "SOURCE").code, "FILE");
    assert.throws(() => Registry.assertConnectorDirection("NOPE", "SOURCE"), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_NOT_FOUND");
  });

  test("registers, replaces and unregisters a custom connector", () => {
    const custom = {
      code: "CUSTOM_X",
      name: "Custom",
      directions: ["BOTH"],
      capabilities: ["READ"],
      formats: ["X"],
      read: () => ({ records: [] }),
    };
    const entry = Registry.registerConnector(custom);
    assert.equal(entry.code, "CUSTOM_X");
    assert.equal(typeof entry.testConnection, "function");
    assert.equal(typeof entry.discoverSchema, "function");
    assert.deepEqual(entry.testConnection(), { ok: true, message: "No connection test implemented" });
    assert.deepEqual(entry.discoverSchema(), { fields: [], sample: [] });
    assert.equal(Registry.assertConnectorDirection("CUSTOM_X", "SOURCE").code, "CUSTOM_X");
    assert.equal(Registry.assertConnectorDirection("CUSTOM_X", "DESTINATION").code, "CUSTOM_X");

    assert.throws(
      () => Registry.registerConnector(custom, { replace: false }),
      (error) => error.code === "INVALID_DATA_EXCHANGE_CONNECTOR"
    );
    assert.equal(Registry.unregisterConnector("CUSTOM_X"), true);
    assert.equal(Registry.getConnector("CUSTOM_X"), null);
    assert.equal(Registry.unregisterConnector("CUSTOM_X"), false);
  });

  test("rejects malformed connector definitions", () => {
    for (const invalid of [
      null,
      {},
      { code: "X" },
      { code: "X", directions: ["SIDEWAYS"], read() {} },
      { code: "X", capabilities: ["MAGIC"], read() {} },
    ]) {
      assert.throws(() => Registry.registerConnector(invalid), (error) => error.code === "INVALID_DATA_EXCHANGE_CONNECTOR");
    }
  });
});

describe("data-exchange built-in connectors", () => {
  test("exposes all twelve connectors with expected metadata", () => {
    const expected = {
      CSV: ["READ", "WRITE", "SCHEMA_DISCOVERY", "STREAMING"],
      JSON: ["READ", "WRITE", "SCHEMA_DISCOVERY", "STREAMING"],
      XML: ["READ", "WRITE", "SCHEMA_DISCOVERY", "STREAMING"],
      EXCEL: ["READ", "WRITE", "SCHEMA_DISCOVERY"],
      FILE: ["READ", "SCHEMA_DISCOVERY", "STREAMING"],
      REST: ["READ", "WRITE", "PAGINATION", "INCREMENTAL", "SCHEMA_DISCOVERY"],
      DATABASE: ["READ", "SCHEMA_DISCOVERY", "PAGINATION", "TRANSACTION"],
      CLOUD_STORAGE: [],
      LEGACY_PLM: [],
      ERP: [],
      CAD: [],
      MES: [],
    };
    const codes = Object.keys(expected);
    assert.equal(codes.length, 12);
    for (const code of codes) {
      const connector = Connectors.get(code);
      assert.ok(connector, `missing built-in connector ${code}`);
      assert.deepEqual(connector.capabilities, expected[code], `capabilities mismatch for ${code}`);
      assert.deepEqual(connector.directions, ["SOURCE", "DESTINATION"]);
    }
    for (const code of ["CSV", "JSON", "XML", "EXCEL", "FILE", "REST", "DATABASE"]) {
      assert.equal(Connectors.get(code).built_in, true);
    }
    for (const code of ["CLOUD_STORAGE", "LEGACY_PLM", "ERP", "CAD", "MES"]) {
      assert.equal(Connectors.get(code).built_in, false);
    }
  });

  test("CSV/JSON/XML/EXCEL connectors read, write and discover", () => {
    const csv = Connectors.get("CSV");
    assert.deepEqual(csv.testConnection({}), { ok: true, message: "CSV is an in-process format connector" });
    assert.deepEqual(csv.read({ content: "a,b\n1,2\n" }).records, [{ a: "1", b: "2" }]);
    const written = csv.write({ records: [{ a: "1" }], fields: ["a"] });
    assert.equal(written.extension, "csv");
    assert.equal(written.records, 1);
    assert.deepEqual(csv.discoverSchema({ content: "a,b\n1,2\n" }).fields, [
      { name: "a", data_type: "integer" },
      { name: "b", data_type: "integer" },
    ]);

    const json = Connectors.get("JSON");
    assert.deepEqual(json.read({ content: '[{"a":1}]' }).records, [{ a: 1 }]);
    assert.equal(json.write({ records: [{ a: 1 }], fields: ["a"] }).extension, "json");

    const xml = Connectors.get("XML");
    assert.equal(xml.read({ content: "<r><i><a>1</a></i><i><a>2</a></i></r>" }).records.length, 2);
    assert.equal(xml.write({ records: [{ a: "1" }], fields: ["a"] }).extension, "xml");

    const excel = Connectors.get("EXCEL");
    assert.equal(excel.write({ records: [{ a: "1" }], fields: ["a"] }).extension, "xls");
  });

  test("FILE delegates to the codec inferred from the format", () => {
    const file = Connectors.get("FILE");
    assert.deepEqual(file.read({ settings: { format: "CSV" }, content: "a,b\n1,2\n" }).records, [{ a: "1", b: "2" }]);
    assert.equal(file.discoverSchema({ settings: { filename: "x.json" }, content: '[{"a":1}]' }).sample.length, 1);
    assert.throws(() => file.write({}));
    assert.throws(() => file.read({ settings: {}, content: "x" }));
  });

  test("DATABASE reads a validated single SELECT only", () => {
    const database = Connectors.get("DATABASE");
    assert.deepEqual(database.read({ settings: { query: "SELECT 1 AS n" }, db }).records, [{ n: 1 }]);
    assert.deepEqual(database.discoverSchema({ settings: { query: "SELECT 1 AS n" }, db }).fields, [{ name: "n", data_type: "integer" }]);
    assert.throws(() => database.read({ settings: { query: "DROP TABLE users" }, db }));
    assert.throws(() => database.read({ settings: { query: "SELECT 1; SELECT 2" }, db }));
    assert.throws(() => database.read({ settings: {}, db }));
    assert.throws(() => database.write({}));
    assert.throws(() => database.testConnection({ settings: { query: "DELETE FROM users" } }));
  });

  test("REST requires a URL and never touches the network here", async () => {
    const rest = Connectors.get("REST");
    assert.ok(rest.capabilities.includes("PAGINATION"));
    await assert.rejects(() => rest.testConnection({}), (error) => error.code === "INVALID_DATA_EXCHANGE_CONNECTOR");
  });

  test("extension-seam connectors fail closed", () => {
    for (const code of ["CLOUD_STORAGE", "LEGACY_PLM", "ERP", "CAD", "MES"]) {
      const connector = Connectors.get(code);
      assert.throws(() => connector.testConnection({}), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED");
      assert.throws(() => connector.read({}), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED");
      assert.throws(() => connector.write({}), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED");
      assert.throws(() => connector.discoverSchema({}), (error) => error.code === "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED");
    }
  });

  test("connectorCatalog returns a stable shape", () => {
    assert.deepEqual(connectorCatalog().connectors, { registered: 0 });
    assert.deepEqual(connectorCatalog().types, [
      "CSV",
      "EXCEL",
      "JSON",
      "XML",
      "REST",
      "DATABASE",
      "FILE",
      "CLOUD_STORAGE",
      "LEGACY_PLM",
      "ERP",
      "CAD",
      "MES",
    ]);
    assert.deepEqual(ensureConnectors(), { registered: 0 });
  });
});

describe("data-exchange engine facade", () => {
  test("re-exports the engine namespaces", () => {
    assert.equal(typeof TransformNamespace.applyTransformation, "function");
    assert.equal(typeof MappingNamespace.mapRecord, "function");
    assert.equal(typeof ValidationNamespace.evaluateRules, "function");
    assert.equal(typeof LookupNamespace.createLookupResolver, "function");
    assert.equal(typeof DuplicateNamespace.decideDuplicate, "function");
    assert.equal(typeof SchemaNamespace.targetSchema, "function");
  });

  test("exposes a flat Engines facade with the public operations", async () => {
    for (const key of [
      "registerTransformation",
      "transformationTypes",
      "applyTransformation",
      "applyTransformations",
      "applyDefinitionTransformations",
      "applyTemplate",
      "getPath",
      "setPath",
      "maskValue",
      "applyMappings",
      "mapRecord",
      "validateMappings",
      "registerValidation",
      "validationTypes",
      "evaluateRules",
      "evaluateRule",
      "validateRule",
      "registerLookupSource",
      "listLookupSources",
      "createLookupResolver",
      "computeDuplicateKey",
      "decideDuplicate",
      "mergeRecords",
      "targetSchema",
      "discoverSourceSchema",
      "validateTargetRecord",
    ]) {
      assert.equal(typeof Engines[key], "function", `missing Engines.${key}`);
    }
    assert.equal(Engines, (await import("../services/data-exchange/engines/index.js")).default);
  });

  test("forwards calls through the facade", () => {
    assert.equal(Engines.applyTransformation("UPPERCASE", "a"), "A");
    assert.equal(Engines.getPath({ a: { b: 1 } }, "a.b"), 1);
    assert.equal(Engines.mapRecord({ mapping_type: "CONSTANT", constant_value: 1 }), 1);
    assert.equal(Engines.decideDuplicate("SKIP", { existing: {} }).action, "SKIP");
    assert.ok(Engines.transformationTypes().includes("TRIM"));
    assert.ok(Engines.validationTypes().includes("REQUIRED"));
    assert.equal(Engines.validateTargetRecord({ fields: [], required_fields: [] }, {}).valid, true);
  });
});
