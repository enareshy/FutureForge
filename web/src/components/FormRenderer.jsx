import React from "react";

// Reusable, metadata-driven form renderer. It consumes the UI-agnostic render
// tree produced by /api/metadata/forms/:id/render (or /types/:id/contract via
// renderType) and emits value changes keyed by attribute code. All visibility,
// editability, defaults, required flags and rule effects are already resolved
// server-side, so this component stays a thin, reusable projection layer.

function defaultFor(field) {
  if (field.multi_value) return [];
  if (field.data_type === "boolean") return field.default === true || field.default === "true";
  if (field.default === null || field.default === undefined) return "";
  return field.default;
}

function coerce(field, raw) {
  if (raw === "") return "";
  if (field.data_type === "integer") return Number.parseInt(raw, 10);
  if (field.data_type === "decimal") return Number.parseFloat(raw);
  if (field.data_type === "boolean") return raw === true || raw === "true";
  if (field.data_type === "multi_value") return Array.isArray(raw) ? raw : [raw];
  return raw;
}

function FieldControl({ field, value, onChange, disabled }) {
  const common = { disabled, id: `mf-${field.code}` };
  const options = field.options || [];

  if (field.data_type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value === true || value === "true"}
        onChange={(e) => onChange(coerce(field, e.target.checked))}
        {...common}
      />
    );
  }

  if (field.multi_value && options.length) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <select
        multiple
        value={selected}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
        {...common}
      >
        {options.map((o) => (
          <option key={o.code} value={o.code}>{o.label}</option>
        ))}
      </select>
    );
  }

  if (options.length) {
    return (
      <select value={value ?? ""} onChange={(e) => onChange(coerce(field, e.target.value))} {...common}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>{o.label}</option>
        ))}
      </select>
    );
  }

  if (field.data_type === "reference") {
    const target = field.validation?.reference_type || "reference";
    return (
      <input
        type="number"
        value={value ?? ""}
        placeholder={field.placeholder || `${target} id`}
        onChange={(e) => onChange(coerce(field, e.target.value))}
        {...common}
      />
    );
  }

  if (field.data_type === "date" || field.data_type === "datetime") {
    return (
      <input
        type={field.data_type === "date" ? "date" : "datetime-local"}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        {...common}
      />
    );
  }

  if (field.data_type === "integer" || field.data_type === "decimal") {
    return (
      <input
        type="number"
        step={field.data_type === "integer" ? "1" : field.validation?.scale ? String(10 ** -field.validation.scale) : "any"}
        min={field.minimum ?? undefined}
        max={field.maximum ?? undefined}
        value={value ?? ""}
        placeholder={field.placeholder || ""}
        onChange={(e) => onChange(coerce(field, e.target.value))}
        {...common}
      />
    );
  }

  if ((field.max_length || 0) > 255) {
    return (
      <textarea
        value={value ?? ""}
        placeholder={field.placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        {...common}
      />
    );
  }

  return (
    <input
      type="text"
      value={value ?? ""}
      placeholder={field.placeholder || ""}
      onChange={(e) => onChange(e.target.value)}
      {...common}
    />
  );
}

function Field({ field, value, onChange, readOnly }) {
  if (!field.visible) return null;
  const disabled = readOnly || !field.editable;
  return (
    <label className="field" htmlFor={`mf-${field.code}`}>
      <span>
        {field.label}
        {field.required ? " *" : ""}
        {field.inherited_from ? " (inherited)" : ""}
      </span>
      <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} />
      {field.help_text ? <span>{field.help_text}</span> : null}
    </label>
  );
}

function NodeBlock({ node, values, onChange, readOnly }) {
  if (!node.visible) return null;
  const heading = node.label ? <h3>{node.label}</h3> : null;
  if (node.kind === "group") {
    return (
      <div className="mf-group">
        {heading}
        <div className="mf-fields">
          {(node.fields || []).map((f) => (
            <Field key={f.code} field={f} value={values[f.code]} onChange={(v) => onChange(f.code, v)} readOnly={readOnly} />
          ))}
        </div>
        {(node.children || []).map((child) => (
          <NodeBlock key={child.id ?? child.code} node={child} values={values} onChange={onChange} readOnly={readOnly} />
        ))}
      </div>
    );
  }
  return (
    <section className={node.kind === "tab" ? "mf-section" : "mf-group"}>
      {heading}
      <div className="mf-fields">
        {(node.fields || []).map((f) => (
          <Field key={f.code} field={f} value={values[f.code]} onChange={(v) => onChange(f.code, v)} readOnly={readOnly} />
        ))}
      </div>
      {(node.children || []).map((child) => (
        <NodeBlock key={child.id ?? child.code} node={child} values={values} onChange={onChange} readOnly={readOnly} />
      ))}
    </section>
  );
}

export function useFormValues(tree, initial = {}) {
  const seed = React.useMemo(() => {
    const next = { ...initial };
    for (const field of tree?.fields || []) {
      if (next[field.code] === undefined || next[field.code] === null) {
        next[field.code] = defaultFor(field);
      }
    }
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree?.form?.id ?? tree?.type?.id]);
  const [values, setValues] = React.useState(seed);
  const setValue = React.useCallback((code, value) => {
    setValues((prev) => ({ ...prev, [code]: value }));
  }, []);
  const reset = React.useCallback((next) => setValues({ ...seed, ...(next || {}) }), [seed]);
  return { values, setValue, setValues, reset };
}

export function FormRenderer({ tree, values: controlled, onChange, readOnly = false }) {
  const [internal, setInternal] = React.useState({});
  const values = controlled ?? internal;
  const handle = React.useCallback(
    (code, value) => {
      if (onChange) onChange(code, value);
      else setInternal((prev) => ({ ...prev, [code]: value }));
    },
    [onChange]
  );
  if (!tree) return null;
  const nodes = tree.nodes?.length ? tree.nodes : [{ code: "__all__", kind: "section", label: "", visible: true, fields: tree.fields || [], children: [] }];
  return (
    <div className="form-renderer">
      {nodes.map((node) => (
        <NodeBlock
          key={node.id ?? node.code}
          node={node}
          values={values}
          onChange={handle}
          readOnly={readOnly || tree.form?.mode === "view"}
        />
      ))}
    </div>
  );
}

export default FormRenderer;
