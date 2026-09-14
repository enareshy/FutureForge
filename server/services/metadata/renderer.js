import { queryAll, queryOne } from "../../db.js";
import { HttpError } from "../../validation.js";
import { assertReadable } from "./scope.js";
import { effectiveAttributes, getTypeRow } from "./types.js";
import { listValues } from "./lovs.js";
import { evaluate } from "./expression.js";

// Produces a transport-friendly, UI-agnostic render tree for a form. The same
// output drives the React renderer, future mobile clients and previews. Field
// visibility/editability and section conditions are evaluated against the
// supplied context so the renderer never has to interpret rule data itself.
export function renderForm(db, idOrCode, tenantId, { mode, values = {}, context = {} } = {}) {
  const form = queryOne(
    db,
    /^\d+$/.test(String(idOrCode))
      ? "SELECT * FROM metadata_forms WHERE id = ?"
      : "SELECT * FROM metadata_forms WHERE code = ?",
    [/^\d+$/.test(String(idOrCode)) ? Number(idOrCode) : String(idOrCode)]
  );
  assertReadable(form, tenantId, "Form not found");
  const selectedMode = mode || form.mode;
  const type = getTypeRow(db, form.type_id);
  assertReadable(type, tenantId, "Type not found");

  const attributes = new Map(effectiveAttributes(db, type.id, tenantId).map((a) => [a.id, a]));
  const valuesByCode = normalizeValues(values);
  const evalContext = { values: valuesByCode, record: valuesByCode, ...context };

  const nodes = queryAll(
    db,
    "SELECT * FROM metadata_form_nodes WHERE form_id = ? ORDER BY sequence, label",
    [form.id]
  ).map((node) => ({
    id: node.id,
    kind: node.kind,
    code: node.code,
    label: node.label,
    parent_id: node.parent_id,
    sequence: node.sequence,
    visible: node.visible === 1 && conditionsPass(node.conditions_json, evalContext),
    conditions: parseArray(node.conditions_json),
    children: [],
    fields: [],
  }));
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));

  const fields = queryAll(
    db,
    "SELECT * FROM metadata_form_fields WHERE form_id = ? ORDER BY sequence",
    [form.id]
  ).map((field) => buildField(db, field, attributes, evalContext, selectedMode, tenantId));

  for (const field of fields) {
    if (field.node_id && nodeIndex.has(field.node_id)) nodeIndex.get(field.node_id).fields.push(field);
    else field.node_id = null;
  }
  for (const node of nodes) {
    if (node.parent_id && nodeIndex.has(node.parent_id)) nodeIndex.get(node.parent_id).children.push(node);
  }

  const defaultColumn = {
    fields: fields.filter((f) => !f.node_id),
    children: [],
    id: null,
    kind: "section",
    code: "__default__",
    label: "",
    visible: true,
    conditions: [],
  };
  const panelNodes = nodes
    .filter((n) => !n.parent_id)
    .map((node) => serializeNode(node, selectedMode));

  return {
    form: {
      id: form.id,
      code: form.code,
      name: form.name,
      description: form.description,
      mode: selectedMode,
      status: form.status,
      version: form.version,
      tenant_id: form.tenant_id,
    },
    type: {
      id: type.id,
      code: type.code,
      name: type.name,
      module: type.module,
      parent_type_id: type.parent_type_id,
    },
    fields: fields.map((f) => publicFieldForRender(f, selectedMode)),
    nodes: [...panelNodes, ...(defaultColumn.fields.length ? [serializeNode(defaultColumn, selectedMode)] : [])],
    context: { tenantId: tenantId ?? null, values: valuesByCode },
  };
}

export function renderType(db, typeIdOrCode, tenantId, { mode = "create", values = {}, context = {} } = {}) {
  const type = queryOne(
    db,
    /^\d+$/.test(String(typeIdOrCode))
      ? "SELECT * FROM metadata_types WHERE id = ?"
      : "SELECT * FROM metadata_types WHERE code = ?",
    [/^\d+$/.test(String(typeIdOrCode)) ? Number(typeIdOrCode) : String(typeIdOrCode)]
  );
  assertReadable(type, tenantId, "Type not found");
  const valuesByCode = normalizeValues(values);
  const evalContext = { values: valuesByCode, record: valuesByCode, ...context };
  const fields = effectiveAttributes(db, type.id, tenantId).map((attribute, index) => {
    const base = {
      code: attribute.code,
      label: attribute.name,
      data_type: attribute.data_type,
      required: Boolean(attribute.required),
      default: attribute.default_value,
      multi_value: Boolean(attribute.multi_value),
      minimum: attribute.min_value,
      maximum: attribute.max_value,
      min_length: attribute.min_length,
      max_length: attribute.max_length,
      validation: attribute.validation || {},
      visible: Boolean(attribute.visible),
      editable: Boolean(attribute.editable),
      lov_id: attribute.lov_id,
      options: attribute.lov_id ? listValues(db, attribute.lov_id, { activeOnly: true }) : [],
      sequence: index,
      node_id: null,
      conditions: [],
    };
    return base;
  });
  return {
    form: null,
    type: { id: type.id, code: type.code, name: type.name, module: type.module, parent_type_id: type.parent_type_id },
    fields: fields.map((f) => publicFieldForRender(f, mode)),
    nodes: [{ id: null, kind: "section", code: "__default__", label: "", visible: true, conditions: [], children: [], fields: [] }],
    context: { tenantId: tenantId ?? null, values: valuesByCode },
  };
}

function serializeNode(node, mode) {
  return {
    id: node.id,
    kind: node.kind,
    code: node.code,
    label: node.label,
    sequence: node.sequence,
    visible: node.visible,
    conditions: node.conditions || [],
    children: (node.children || []).map((child) => serializeNode(child, mode)),
    fields: (node.fields || []).map((field) => publicFieldForRender(field, mode)),
  };
}

function buildField(db, field, attributes, evalContext, mode, tenantId) {
  const attribute = attributes.get(field.attribute_id);
  if (!attribute) {
    return {
      ...field,
      condition_visible: true,
      condition_editable: true,
      is_orphan: true,
    };
  }
  const conditions = parseArray(field.conditions_json);
  const conditionVisible = conditionsPass(field.conditions_json, evalContext);
  const viewMode = mode === "view";
  const required = field.required_override === null || field.required_override === undefined
    ? Boolean(attribute.required)
    : field.required_override === 1;
  const defaultValue =
    field.default_override === null || field.default_override === undefined
      ? attribute.default_value
      : field.default_override;
  const baseEditable = field.editable === 1 && attribute.editable !== false && !viewMode;
  const editableOverride = applyEditabilityConditions(conditions, evalContext, baseEditable);
  return {
    id: field.id,
    code: field.code,
    label: field.label_override || attribute.name,
    label_override: field.label_override,
    placeholder: field.placeholder,
    help_text: field.help_text,
    data_type: attribute.data_type,
    required,
    default: defaultValue,
    default_override: field.default_override,
    multi_value: Boolean(attribute.multi_value),
    minimum: attribute.min_value,
    maximum: attribute.max_value,
    min_length: attribute.min_length,
    max_length: attribute.max_length,
    validation: attribute.validation || {},
    lov_id: attribute.lov_id,
    options: attribute.lov_id ? listValues(db, attribute.lov_id, { activeOnly: true }) : [],
    sequence: field.sequence,
    node_id: field.node_id,
    col_span: field.col_span,
    attribute_id: attribute.id,
    inherited_from: attribute.inherited_from,
    visible: field.visible === 1 && attribute.visible !== false && conditionVisible,
    editable: editableOverride,
    conditions,
  };
}

function publicFieldForRender(field, mode) {
  if (field.is_orphan) {
    return { ...field, visible: false, editable: false, orphan: true };
  }
  const viewMode = mode === "view";
  return {
    code: field.code,
    label: field.label,
    placeholder: field.placeholder,
    help_text: field.help_text,
    data_type: field.data_type,
    required: field.required,
    default: field.default,
    multi_value: field.multi_value,
    minimum: field.minimum,
    maximum: field.maximum,
    min_length: field.min_length,
    max_length: field.max_length,
    validation: field.validation,
    lov_id: field.lov_id,
    options: field.options.map((v) => ({ code: v.code, label: v.label, id: v.id, parent_value_id: v.parent_value_id })),
    sequence: field.sequence,
    node_id: field.node_id,
    col_span: field.col_span,
    attribute_id: field.attribute_id,
    visible: field.visible,
    editable: viewMode ? false : field.editable,
    conditions: field.conditions,
  };
}

// Conditions on a field may carry explicit target `actions`. Visibility uses
// the condition itself; editability uses conditions tagged `affects=editable`.
function applyEditabilityConditions(conditions, context, baseEditable) {
  let editable = baseEditable;
  for (const condition of conditions) {
    const affects = condition.affects || condition.action;
    if (!affects || affects === "editable" || affects === "editability") {
      if (!evaluate(condition, context)) editable = false;
    }
  }
  return editable;
}

function conditionsPass(raw, context) {
  const conditions = parseArray(raw);
  for (const condition of conditions) {
    if (condition.affects === "editable" || condition.affects === "editability") continue;
    if (!evaluate(condition, context)) return false;
  }
  return true;
}

function parseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeValues(values) {
  if (!values) return {};
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new HttpError(400, "values must be an object");
  }
  return values;
}

export function formByTypeAndMode(db, typeId, mode, tenantId) {
  const scope = tenantId
    ? "(tenant_id IS NULL OR tenant_id = ?)"
    : "tenant_id IS NULL";
  const params = tenantId ? [Number(typeId), mode, Number(tenantId)] : [Number(typeId), mode];
  return queryOne(
    db,
    `SELECT * FROM metadata_forms WHERE type_id = ? AND mode = ? AND status = 'active' AND ${scope}
     ORDER BY tenant_id IS NULL LIMIT 1`,
    params
  );
}
