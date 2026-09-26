import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  serializeCsv,
  inferFields,
  parseJson,
  serializeJson,
  parseXml,
  serializeXml,
  parseSpreadsheet,
  serializeSpreadsheet,
} from "../services/data-exchange/connectors/codecs.js";
import { ensureConnectors, Connectors } from "../services/data-exchange/connectors/index.js";
import { applyMappings, validateMappings } from "../services/data-exchange/engines/mapping.js";
import {
  applyTransformation,
  applyTransformations,
  applyDefinitionTransformations,
  getPath,
  setPath,
} from "../services/data-exchange/engines/transform.js";
import { evaluateRules } from "../services/data-exchange/engines/validation.js";
import { computeDuplicateKey, decideDuplicate, mergeRecords } from "../services/data-exchange/engines/duplicate.js";
import { validateTargetRecord } from "../services/data-exchange/engines/schema.js";
import * as Validation from "../services/data-exchange/validation.js";

describe("Data Exchange — dependency-free codecs", () => {
  test("round-trips CSV including quoted delimiters", () => {
    const content = 'code,name\nA-1,"Pump, hydraulic"\nA-2,Valve\n';
    const parsed = parseCsv(content);
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0].name, "Pump, hydraulic");

    const serialized = serializeCsv(parsed.records, ["code", "name"]);
    assert.match(serialized.content.split("\n")[0], /code,name/);
    assert.match(serialized.content, /"Pump, hydraulic"/);
    assert.equal(serialized.extension, "csv");
  });

  test("infers fields from a sample", () => {
    const fields = inferFields([{ a: "1", b: "true" }, { a: "2", b: "false" }]);
    const names = fields.map((f) => f.name);
    assert.ok(names.includes("a"));
    assert.ok(names.includes("b"));
  });

  test("round-trips JSON as array and NDJSON", () => {
    const records = [{ code: "A", qty: 2 }];
    const json = serializeJson(records);
    assert.deepEqual(parseJson(json.content).records, records);
    const ndjson = serializeJson(records, null, { ndjson: true });
    assert.deepEqual(parseJson(ndjson.content, { ndjson: true }).records, records);
  });

  test("round-trips XML records", () => {
    const records = [{ code: "A-1", name: "Pump" }];
    const xml = serializeXml(records, ["code", "name"]);
    const parsed = parseXml(xml.content);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].code, "A-1");
    assert.equal(parsed.records[0].name, "Pump");
  });

  test("round-trips the built-in spreadsheet format", () => {
    const records = [{ code: "A-1", name: "Pump" }];
    const sheet = serializeSpreadsheet(records, ["code", "name"]);
    const parsed = parseSpreadsheet(sheet.content);
    assert.equal(parsed.records[0].code, "A-1");
  });
});

describe("Data Exchange — pluggable connector registry", () => {
  test("registers all built-in connector types", () => {
    ensureConnectors();
    const types = Connectors.types();
    for (const expected of ["CSV", "EXCEL", "JSON", "XML", "REST", "DATABASE", "FILE", "LEGACY_PLM", "ERP", "CAD", "MES"]) {
      assert.ok(types.includes(expected), `missing connector ${expected}`);
    }
    assert.equal(Connectors.list().length, types.length);
  });

  test("exposes capabilities per connector", () => {
    ensureConnectors();
    const csv = Connectors.list().find((c) => c.code === "CSV");
    assert.ok(csv.capabilities.length > 0);
    assert.ok(csv.built_in);
  });
});

describe("Data Exchange — mapping and transformation engines", () => {
  test("maps direct, constant, concatenated and split fields", () => {
    const mappings = [
      { source_field: "part_number", target_field: "code", mapping_type: "DIRECT" },
      { source_field: "part_name", target_field: "name", mapping_type: "DIRECT" },
      { target_field: "origin", mapping_type: "CONSTANT", constant_value: "IMPORT" },
      { target_field: "label", mapping_type: "CONCAT", concat: ["part_number", "part_name"], condition: { separator: " - " } },
      { source_field: "category", target_field: "family", mapping_type: "SPLIT", split: { separator: "/", index: 1 } },
    ];
    const { target, errors } = applyMappings(mappings, { part_number: "P-1", part_name: "Pump", category: "rotating/pump" });
    assert.equal(errors.length, 0);
    assert.equal(target.code, "P-1");
    assert.equal(target.name, "Pump");
    assert.equal(target.origin, "IMPORT");
    assert.equal(target.label, "P-1 - Pump");
    assert.equal(target.family, "pump");
  });

  test("flags missing and duplicate targets during validation", () => {
    const { valid, errors } = validateMappings([
      { source_field: "a" },
      { source_field: "b", target_field: "name" },
      { source_field: "c", target_field: "name" },
    ]);
    assert.equal(valid, false);
    assert.ok(errors.some((i) => i.code === "missing_target"));
    assert.ok(errors.some((i) => i.code === "duplicate_target"));
  });

  test("applies transform pipelines and field-stage definition transforms", () => {
    assert.equal(applyTransformation("UPPERCASE", "pump"), "PUMP");
    assert.equal(applyTransformations([{ transformation_type: "TRIM" }, { transformation_type: "UPPERCASE" }], "  pump "), "PUMP");
    assert.equal(applyTransformation("LOOKUP", "draft", { map: { draft: "DRAFT" }, default: "OTHER" }), "DRAFT");
    assert.equal(applyTransformation("DEFAULT", "", { default: "N/A" }), "N/A");

    const out = applyDefinitionTransformations(
      [{ stage: "FIELD", transformation_type: "TRIM", target_field: "name" }],
      { name: "  pump a  " }
    );
    assert.equal(out.name, "pump a");
    assert.equal(getPath({ a: { b: 1 } }, "a.b"), 1);
    const nested = {};
    setPath(nested, "a.b", 5);
    assert.equal(nested.a.b, 5);
  });
});

describe("Data Exchange — validation engine", () => {
  test("enforces required, range, enum and pattern rules", () => {
    const rules = [
      { rule_type: "REQUIRED", target_field: "code" },
      { rule_type: "RANGE", target_field: "qty", config: { min: 1, max: 10 } },
      { rule_type: "ENUM", target_field: "status", config: { values: ["active", "draft"] } },
      { rule_type: "PATTERN", target_field: "code", config: { pattern: "^P-" } },
    ];
    const good = evaluateRules(rules, { code: "P-1", qty: 5, status: "active" });
    assert.equal(good.hasErrors, false);

    const bad = evaluateRules(rules, { code: "X-1", qty: 99, status: "gone" });
    assert.equal(bad.hasErrors, true);
    assert.ok(bad.errors.length >= 3);
  });
});

describe("Data Exchange — duplicate handling", () => {
  test("computes keys, decides and merges on UPSERT/MERGE", () => {
    const key = computeDuplicateKey({ code: "P-1" }, { fields: ["code"] });
    assert.equal(key, "P-1");
    assert.equal(decideDuplicate("SKIP", { existing: {} }).action, "SKIP");
    assert.equal(decideDuplicate("UPSERT", { existing: {}, changed: true }).action, "UPDATE");
    assert.equal(decideDuplicate("REJECT", { existing: {} }).action, "REJECT");
    assert.equal(decideDuplicate("MERGE", { existing: {} }).action, "MERGE");
    assert.deepEqual(mergeRecords({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
  });
});

describe("Data Exchange — schema validation", () => {
  test("validates required metadata attributes", () => {
    const schema = {
      fields: [
        { name: "part.number", required: true },
        { name: "part.name", required: true },
      ],
      required_fields: ["part.number", "part.name"],
    };
    assert.equal(validateTargetRecord(schema, { "part.number": "P-1", "part.name": "Pump" }).valid, true);
    assert.equal(validateTargetRecord(schema, { "part.number": "P-1" }).valid, false);
  });

  test("records unknown fields as warnings unless strict", () => {
    const schema = { fields: [{ name: "name" }], required_fields: [] };
    const lenient = validateTargetRecord(schema, { name: "x", extra: 1 });
    assert.equal(lenient.valid, true);
    assert.equal(lenient.warnings[0].code, "unknown_field");

    const strict = validateTargetRecord(schema, { name: "x", extra: 1 }, { strict: true });
    assert.equal(strict.valid, false);
  });
});

describe("Data Exchange — vocabulary & validation guards", () => {
  test("exposes a stable vocabulary", () => {
    const vocab = Validation.vocabulary();
    assert.ok(vocab.connector_types.length >= 10);
    assert.ok(vocab.export_formats.includes("CSV"));
    assert.ok(vocab.duplicate_strategies.includes("UPSERT"));
  });

  test("rejects unsupported enum values", () => {
    assert.throws(() => Validation.assertExportFormat("NOPE"));
    assert.throws(() => Validation.assertExecutionMode("NOPE"));
    assert.throws(() => Validation.assertDuplicateStrategy("NOPE"));
    assert.equal(Validation.assertExecutionMode("dry_run"), "DRY_RUN");
    assert.equal(Validation.assertExportFormat("csv"), "CSV");
  });
});
