// Variant and configuration applicability.
//
// A line or revision can be scoped to a variant code, a configuration context
// string and/or a set of option selections. Applicability resolution is pure so
// structure, rollup and validation share identical semantics.
import { parseObject, normalizeUpper, normalizeText } from "./validation.js";

export function normalizeContext(context = {}) {
  const options = parseObject(context.options ?? context.selections ?? {}, {});
  const normalizedOptions = {};
  for (const [key, value] of Object.entries(options)) {
    normalizedOptions[normalizeUpper(key, { max: 80 })] = Array.isArray(value)
      ? value.map((entry) => normalizeUpper(entry, { max: 80 }))
      : normalizeUpper(value, { max: 80 });
  }
  return {
    variant_code: normalizeUpper(context.variant_code ?? context.variantCode ?? "", { max: 120 }) || null,
    variant_id: context.variant_id != null ? Number(context.variant_id) : null,
    configuration_context: normalizeText(context.configuration_context ?? context.configurationContext ?? "", { max: 200 }) || null,
    options: normalizedOptions,
  };
}

export function isApplicable(record, context = {}) {
  const ctx = context.__normalized ? context : normalizeContext(context);
  const recordVariant = normalizeUpper(record?.variant_code ?? "", { max: 120 });
  const recordVariantId = record?.variant_id != null ? Number(record.variant_id) : null;
  const recordContext = normalizeText(record?.configuration_context ?? "", { max: 200 });

  if (ctx.variant_code && recordVariant && recordVariant !== ctx.variant_code) return false;
  if (ctx.variant_id != null && recordVariantId != null && recordVariantId !== ctx.variant_id) return false;
  if (ctx.configuration_context && recordContext && recordContext !== ctx.configuration_context) return false;

  const attributes = parseObject(record?.attributes ?? record?.attributes_json, {});
  const required = parseObject(attributes.variant_options ?? attributes.variantOptions ?? null, null);
  if (required && typeof required === "object") {
    for (const [key, expected] of Object.entries(required)) {
      const actual = ctx.options[normalizeUpper(key, { max: 80 })];
      if (actual === undefined) return false;
      const expectedValues = Array.isArray(expected) ? expected.map((value) => normalizeUpper(value, { max: 80 })) : [normalizeUpper(expected, { max: 80 })];
      const actualValues = Array.isArray(actual) ? actual : [actual];
      if (!actualValues.some((value) => expectedValues.includes(value))) return false;
    }
  }
  return true;
}

export function filterByVariant(lines, context = {}) {
  const ctx = normalizeContext(context);
  ctx.__normalized = true;
  return (lines || []).filter((line) => isApplicable(line, ctx));
}
