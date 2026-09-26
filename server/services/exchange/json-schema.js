// Bounded JSON Schema validator (§14).
//
// Supports the subset of draft-07 that exchange payloads actually use. It is
// deliberately not a general-purpose validator: unbounded $ref/remote schema
// resolution is not supported, which keeps validation deterministic and safe.
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

export function validateJsonSchema(value, schema, path = "") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  const push = (code, message, at) => errors.push({ code, message, path: at || path || "$" });

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.some((type) => TYPES.has(type)) && !types.some((type) => matchesType(value, type))) {
      push("schema_type", `Expected ${types.join(" | ")}, received ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    push("schema_enum", `Value must be one of: ${schema.enum.join(", ")}`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    push("schema_const", `Value must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < Number(schema.minLength)) push("schema_min_length", `Must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) push("schema_max_length", `Must be at most ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) push("schema_pattern", `Value does not match pattern ${schema.pattern}`);
      } catch {
        push("schema_pattern_invalid", `Schema pattern is invalid: ${schema.pattern}`);
      }
    }
    if (schema.format === "date-time" && Number.isNaN(new Date(value).getTime())) push("schema_format", "Value must be a valid date-time");
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) push("schema_format", "Value must be a valid email");
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < Number(schema.minimum)) push("schema_minimum", `Must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > Number(schema.maximum)) push("schema_maximum", `Must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= Number(schema.exclusiveMinimum)) push("schema_exclusive_minimum", `Must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= Number(schema.exclusiveMaximum)) push("schema_exclusive_maximum", `Must be < ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && Number(schema.multipleOf) > 0 && Math.abs(value / Number(schema.multipleOf) - Math.round(value / Number(schema.multipleOf))) > 1e-9) {
      push("schema_multiple_of", `Must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < Number(schema.minItems)) push("schema_min_items", `Must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) push("schema_max_items", `Must contain at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`)));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null || value[key] === "") push("schema_required", `Missing required property: ${key}`, `${path}.${key}`);
      }
    }
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (properties[key] === undefined) push("schema_additional_properties", `Additional property is not allowed: ${key}`, `${path}.${key}`);
      }
    }
  }

  return errors;
}

export function validateJsonSchemaDefinition(schema) {
  const errors = [];
  if (!schema || typeof schema !== "object") {
    return { valid: false, errors: [{ code: "invalid_schema", message: "A JSON schema must be an object" }] };
  }
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).every((type) => TYPES.has(type))) {
    errors.push({ code: "invalid_schema_type", message: `Unknown schema type: ${JSON.stringify(schema.type)}` });
  }
  if (schema.properties && typeof schema.properties !== "object") {
    errors.push({ code: "invalid_schema_properties", message: "schema.properties must be an object" });
  }
  return { valid: errors.length === 0, errors };
}

export { typeOf };
