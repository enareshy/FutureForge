import React, { useCallback, useEffect, useMemo, useState } from "react";
import { iam, metadata as meta } from "../api.js";
import FormRenderer from "../components/FormRenderer.jsx";

const TABS = [
  ["types", "Types"],
  ["attributes", "Attributes"],
  ["lovs", "Lists of values"],
  ["forms", "Forms"],
  ["rules", "Rules"],
  ["records", "Record builder"],
  ["config", "Scoped config"],
];

const DATA_TYPES = ["string", "integer", "decimal", "boolean", "date", "datetime", "reference", "multi_value"];
const RULE_CATEGORIES = ["validation", "visibility", "editability", "default", "dependency", "condition"];
const MODES = ["create", "edit", "view"];
const STATUSES = ["draft", "active", "inactive"];

function StatusBadge({ status }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function pretty(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function MetadataPage() {
  const [tab, setTab] = useState("types");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [types, setTypes] = useState([]);
  const [attributes, setAttributes] = useState([]);
  const [lovs, setLovs] = useState([]);
  const [forms, setForms] = useState([]);
  const [rules, setRules] = useState([]);

  const [selectedLov, setSelectedLov] = useState(null);
  const [selectedForm, setSelectedForm] = useState(null);
  const [lovValues, setLovValues] = useState([]);
  const [formTree, setFormTree] = useState(null);
  const [recordTree, setRecordTree] = useState(null);
  const [recordValues, setRecordValues] = useState({});
  const [recordResult, setRecordResult] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [tenantId, setTenantId] = useState(null);

  const flash = (message) => {
    setNotice(message);
    setError("");
  };

  const fail = (err) => {
    setError(err?.message || String(err));
    setNotice("");
  };

  const loadTypes = useCallback(() => meta.types("?pageSize=200").then((r) => setTypes(r.items || [])), []);
  const loadAttributes = useCallback(() => meta.attributes("?pageSize=200").then((r) => setAttributes(r.items || [])), []);
  const loadLovs = useCallback(() => meta.lovs("?pageSize=200").then((r) => setLovs(r.items || [])), []);
  const loadForms = useCallback(() => meta.forms("?pageSize=200").then((r) => setForms(r.items || [])), []);
  const loadRules = useCallback(() => meta.rules("?pageSize=200").then((r) => setRules(r.items || [])), []);
  const loadCatalog = useCallback(() => meta.effectiveCatalog().then((r) => setCatalog(r.items || [])), []);

  useEffect(() => {
    Promise.all([loadTypes(), loadAttributes(), loadLovs(), loadForms(), loadRules(), loadCatalog()]).catch(fail);
    iam.me().then((res) => setTenantId(res.tenant?.id || null)).catch(() => {});
  }, [loadTypes, loadAttributes, loadLovs, loadForms, loadRules, loadCatalog]);

  const lovOptions = useMemo(() => lovs.map((l) => ({ id: l.id, label: `${l.name} (${l.code})` })), [lovs]);

  async function selectLov(lov) {
    try {
      const full = await meta.lov(lov.id);
      setSelectedLov(full);
      setLovValues(full.values || []);
    } catch (err) {
      fail(err);
    }
  }

  async function selectForm(form) {
    try {
      const full = await meta.form(form.id);
      setSelectedForm(full);
      const tree = await meta.renderForm(form.id, { values: {} });
      setFormTree(tree);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Configuration &amp; Metadata</div>
          <h1>Metadata management</h1>
          <p className="sub">
            Types, attributes, lists of values, dynamic forms, rules and scoped configuration. Global artifacts are
            shared; tenant artifacts are isolated. All changes are versioned and audited.
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "types" ? (
        <TypeManager
          types={types}
          attributes={attributes}
          lovs={lovs}
          onReload={async () => {
            await Promise.all([loadTypes(), loadAttributes()]);
          }}
          flash={flash}
          fail={fail}
        />
      ) : null}

      {tab === "attributes" ? (
        <AttributesTab
          attributes={attributes}
          lovOptions={lovOptions}
          onCreate={async (body) => {
            try {
              await meta.createAttribute(body);
              flash("Attribute created.");
              await loadAttributes();
            } catch (err) {
              fail(err);
            }
          }}
          onStatus={async (attribute, status) => {
            try {
              await meta.setAttributeStatus(attribute.id, status);
              flash(`Attribute ${status}.`);
              await loadAttributes();
            } catch (err) {
              fail(err);
            }
          }}
          onDelete={async (attribute) => {
            try {
              await meta.deleteAttribute(attribute.id);
              flash("Attribute deleted.");
              await loadAttributes();
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}

      {tab === "lovs" ? (
        <LovsTab
          lovs={lovs}
          selected={selectedLov}
          values={lovValues}
          onSelect={selectLov}
          onCreate={async (body) => {
            try {
              await meta.createLov(body);
              flash("List created.");
              await loadLovs();
            } catch (err) {
              fail(err);
            }
          }}
          onAddValue={async (lovId, body) => {
            try {
              await meta.addLovValue(lovId, body);
              flash("Value added.");
              await loadLovs();
              await selectLov({ id: lovId });
            } catch (err) {
              fail(err);
            }
          }}
          onRemoveValue={async (lovId, valueId) => {
            try {
              const res = await meta.removeLovValue(lovId, valueId);
              flash(res.retired ? "Value is in use; it was retired instead of deleted." : "Value deleted.");
              await selectLov({ id: lovId });
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}

      {tab === "forms" ? (
        <FormsTab
          forms={forms}
          types={types}
          selected={selectedForm}
          tree={formTree}
          attributes={attributes}
          onSelect={selectForm}
          onCreate={async (body) => {
            try {
              await meta.createForm(body);
              flash("Form created.");
              await loadForms();
            } catch (err) {
              fail(err);
            }
          }}
          onStatus={async (form, status) => {
            try {
              await meta.setFormStatus(form.id, status);
              flash(`Form ${status}.`);
              await loadForms();
            } catch (err) {
              fail(err);
            }
          }}
          onSaveLayout={async (formId, body) => {
            try {
              await meta.replaceLayout(formId, body);
              flash("Layout saved.");
              await selectForm({ id: formId });
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}

      {tab === "rules" ? (
        <RulesTab
          rules={rules}
          types={types}
          forms={forms}
          onCreate={async (body) => {
            try {
              await meta.createRule(body);
              flash("Rule created.");
              await loadRules();
            } catch (err) {
              fail(err);
            }
          }}
          onStatus={async (rule, status) => {
            try {
              await meta.setRuleStatus(rule.id, status);
              flash(`Rule ${status}.`);
              await loadRules();
            } catch (err) {
              fail(err);
            }
          }}
          onDelete={async (rule) => {
            try {
              await meta.deleteRule(rule.id);
              flash("Rule deleted.");
              await loadRules();
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}

      {tab === "records" ? (
        <RecordTab
          types={types}
          forms={forms}
          tree={recordTree}
          values={recordValues}
          result={recordResult}
          onPick={async (kind, id) => {
            try {
              const tree = kind === "form" ? await meta.renderForm(id, { values: {} }) : await meta.resolveType(id);
              setRecordTree(tree);
              setRecordValues({});
              setRecordResult(null);
            } catch (err) {
              fail(err);
            }
          }}
          onChange={(code, value) => setRecordValues((prev) => ({ ...prev, [code]: value }))}
          onValidate={async () => {
            try {
              const result = await meta.validate({
                typeId: recordTree?.type?.id,
                formId: recordTree?.form?.id,
                values: recordValues,
              });
              setRecordResult(result);
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}

      {tab === "config" ? (
        <ConfigTab
          catalog={catalog}
          onReload={loadCatalog}
          onToggle={async (row) => {
            if (!tenantId) {
              fail(new Error("Select a tenant context before editing scoped configuration."));
              return;
            }
            try {
              await meta.setConfiguration({
                scope: "tenant",
                scopeId: tenantId,
                artifactType: row.artifact_type,
                artifactId: row.artifact_id,
                enabled: !row.config?.enabled,
              });
              await loadCatalog();
              flash("Configuration updated.");
            } catch (err) {
              fail(err);
            }
          }}
        />
      ) : null}
    </>
  );
}

function buildTypeTree(types) {
  const byId = new Map(types.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent_type_id ? byId.get(node.parent_type_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function flattenTypes(nodes, depth = 0, acc = []) {
  for (const node of nodes) {
    acc.push({ ...node, depth });
    flattenTypes(node.children, depth + 1, acc);
  }
  return acc;
}

function TypeListItem({ node, depth, selectedId, onSelect }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div className="type-branch">
      <div className={`type-row ${selectedId === node.id ? "active" : ""}`} style={{ paddingLeft: 6 + depth * 16 }}>
        <button
          type="button"
          className={`tree-toggle ${hasChildren ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((v) => !v);
          }}
        >
          {hasChildren ? (open ? "▾" : "▸") : "•"}
        </button>
        <button type="button" className="type-row-main" onClick={() => onSelect(node.id)}>
          <span className="type-name">{node.name}</span>
          <span className="type-sub mono">{node.code}{node.module ? ` · ${node.module}` : ""}</span>
        </button>
        <StatusBadge status={node.status} />
      </div>
      {hasChildren && open
        ? node.children.map((child) => (
            <TypeListItem key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
          ))
        : null}
    </div>
  );
}

function TypeManager({ types, attributes, lovs, onReload, flash, fail }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [props, setProps] = useState(null);
  const [newType, setNewType] = useState({ code: "", name: "", module: "", parent_type_id: "" });
  const [newAttrOpen, setNewAttrOpen] = useState(false);

  const term = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term) return null;
    return types.filter((t) => `${t.name} ${t.code} ${t.module || ""}`.toLowerCase().includes(term));
  }, [types, term]);
  const tree = useMemo(() => buildTypeTree(types), [types]);
  const flatTree = useMemo(() => flattenTypes(tree), [tree]);

  const loadDetail = useCallback(
    async (id) => {
      if (!id) return;
      setLoading(true);
      try {
        const full = await meta.resolveType(id);
        setDetail(full);
        setProps({
          name: full.name,
          code: full.code,
          module: full.module || "",
          description: full.description || "",
          parent_type_id: full.parent_type_id ? String(full.parent_type_id) : "",
          status: full.status,
        });
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    },
    [fail]
  );

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function saveProps(e) {
    e.preventDefault();
    try {
      await meta.updateType(selectedId, {
        name: props.name,
        code: props.code,
        module: props.module || null,
        description: props.description,
        parent_type_id: props.parent_type_id ? Number(props.parent_type_id) : null,
        status: props.status,
      });
      flash("Type properties saved.");
      await onReload();
      await loadDetail(selectedId);
    } catch (err) {
      fail(err);
    }
  }

  async function toggleStatus() {
    try {
      const next = detail.status === "active" ? "inactive" : "active";
      await meta.setTypeStatus(selectedId, next);
      flash(`Type ${next}.`);
      await onReload();
      await loadDetail(selectedId);
    } catch (err) {
      fail(err);
    }
  }

  async function deleteType() {
    if (!window.confirm(`Delete type "${detail.name}"? This cannot be undone.`)) return;
    try {
      await meta.deleteType(selectedId);
      flash("Type deleted.");
      setSelectedId(null);
      setDetail(null);
      await onReload();
    } catch (err) {
      fail(err);
    }
  }

  async function createType(e) {
    e.preventDefault();
    try {
      const created = await meta.createType({
        code: newType.code,
        name: newType.name,
        module: newType.module || undefined,
        parent_type_id: newType.parent_type_id ? Number(newType.parent_type_id) : undefined,
      });
      setNewType({ code: "", name: "", module: "", parent_type_id: "" });
      flash("Type created.");
      await onReload();
      setSelectedId(created.id);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="type-manager">
      <div className="panel type-list-panel">
        <div className="panel-head">
          <h3>All types</h3>
          <span className="badge">{types.length}</span>
        </div>
        <label className="field search-field">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search type by name, code or module"
          />
        </label>
        <div className="type-list">
          {matches ? (
            matches.length ? (
              matches.map((t) => (
                <TypeListItem key={t.id} node={{ ...t, children: [] }} depth={0} selectedId={selectedId} onSelect={setSelectedId} />
              ))
            ) : (
              <p className="mono">No types match “{search}”.</p>
            )
          ) : flatTree.length ? (
            tree.map((node) => (
              <TypeListItem key={node.id} node={node} depth={0} selectedId={selectedId} onSelect={setSelectedId} />
            ))
          ) : (
            <p className="mono">No types yet.</p>
          )}
        </div>
        <form className="panel type-create" onSubmit={createType}>
          <h3>New type</h3>
          <div className="inline">
            <label className="field grow"><span>Code</span><input value={newType.code} onChange={(e) => setNewType({ ...newType, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} required /></label>
          </div>
          <div className="inline">
            <label className="field grow"><span>Module</span><input value={newType.module} onChange={(e) => setNewType({ ...newType, module: e.target.value })} /></label>
            <label className="field grow">
              <span>Parent type</span>
              <select value={newType.parent_type_id} onChange={(e) => setNewType({ ...newType, parent_type_id: e.target.value })}>
                <option value="">None</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <button className="btn secondary">Create type</button>
        </form>
      </div>

      <div className="panel type-detail-panel">
        {!detail ? (
          <p className="mono">{loading ? "Loading…" : "Select a type to view and edit its properties and attributes."}</p>
        ) : (
          <>
            <div className="topbar">
              <div>
                <div className="brand">Type</div>
                <h1 style={{ fontSize: 22 }}>{detail.name}</h1>
                <p className="mono">{detail.code}{detail.module ? ` · ${detail.module}` : ""}</p>
              </div>
              <div className="inline">
                <StatusBadge status={detail.status} />
                <span className="badge">{detail.tenant_id ? "tenant" : "global"}</span>
                <button type="button" className="btn ghost" onClick={toggleStatus}>
                  {detail.status === "active" ? "Disable" : "Activate"}
                </button>
                <button type="button" className="btn danger" onClick={deleteType}>Delete</button>
              </div>
            </div>

            <form className="panel" onSubmit={saveProps}>
              <h3>Properties</h3>
              <div className="inline">
                <label className="field grow"><span>Name</span><input value={props.name} onChange={(e) => setProps({ ...props, name: e.target.value })} required /></label>
                <label className="field grow"><span>Code</span><input value={props.code} onChange={(e) => setProps({ ...props, code: e.target.value })} required /></label>
              </div>
              <div className="inline">
                <label className="field grow"><span>Module</span><input value={props.module} onChange={(e) => setProps({ ...props, module: e.target.value })} /></label>
                <label className="field grow">
                  <span>Parent type</span>
                  <select value={props.parent_type_id} onChange={(e) => setProps({ ...props, parent_type_id: e.target.value })}>
                    <option value="">None</option>
                    {types.filter((t) => t.id !== detail.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label className="field grow">
                  <span>Status</span>
                  <select value={props.status} onChange={(e) => setProps({ ...props, status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </div>
              <label className="field"><span>Description</span><textarea value={props.description} onChange={(e) => setProps({ ...props, description: e.target.value })} /></label>
              <button className="btn">Save properties</button>
            </form>

            <div className="panel">
              <div className="panel-head">
                <h3>Attributes ({detail.attributes?.length || 0})</h3>
                <div className="inline">
                  <button type="button" className="btn ghost" onClick={() => setNewAttrOpen((v) => !v)}>
                    {newAttrOpen ? "Close" : "New attribute"}
                  </button>
                </div>
              </div>
              <AttributeTable
                type={detail}
                attributes={attributes}
                lovs={lovs}
                onReload={onReload}
                refresh={() => loadDetail(selectedId)}
                flash={flash}
                fail={fail}
              />
              {newAttrOpen ? (
                <NewAttributeForm
                  type={detail}
                  lovs={lovs}
                  onDone={async () => {
                    setNewAttrOpen(false);
                    flash("Attribute created and attached.");
                    await onReload();
                    await loadDetail(selectedId);
                  }}
                  onCancel={() => setNewAttrOpen(false)}
                  fail={fail}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AttributeTable({ type, attributes, lovs, onReload, refresh, flash, fail }) {
  const [editing, setEditing] = useState(null);
  const attached = new Set((type.attributes || []).map((a) => a.id));
  const [attachId, setAttachId] = useState("");

  async function attach(e) {
    e.preventDefault();
    if (!attachId) return;
    try {
      await meta.attachAttribute(type.id, { attribute_id: Number(attachId) });
      setAttachId("");
      flash("Attribute attached.");
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function detach(attribute) {
    try {
      await meta.detachAttribute(type.id, attribute.id);
      flash(attribute.inherited_from ? "Inherited attribute masked for this type." : "Attribute detached.");
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <>
      <table className="attr-table">
        <thead><tr><th>#</th><th>Attribute</th><th>Type</th><th>Required</th><th>Visible</th><th>Editable</th><th>Origin</th><th /></tr></thead>
        <tbody>
          {(type.attributes || []).map((a) => (
            <React.Fragment key={a.id}>
              <tr>
                <td className="mono">{a.sequence ?? "—"}</td>
                <td>
                  <div>{a.name}</div>
                  <div className="mono">{a.code}</div>
                </td>
                <td><span className="badge">{a.data_type}</span></td>
                <td>{a.required ? "yes" : "no"}</td>
                <td>{a.visible === false ? "no" : "yes"}</td>
                <td>{a.editable === false ? "no" : "yes"}</td>
                <td className="mono">{a.inherited_from ? "inherited" : "own"}</td>
                <td className="inline">
                  <button type="button" className="btn ghost" onClick={() => setEditing(editing === a.id ? null : a.id)}>
                    {editing === a.id ? "Close" : "Edit"}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => detach(a)}>
                    {a.inherited_from ? "Mask" : "Detach"}
                  </button>
                </td>
              </tr>
              {editing === a.id ? (
                <tr>
                  <td colSpan={8} className="attr-edit-cell">
                    <AttributeEditor
                      type={type}
                      attribute={a}
                      lovs={lovs}
                      onSaved={async () => {
                        setEditing(null);
                        flash("Attribute updated.");
                        await refresh();
                      }}
                      fail={fail}
                    />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
          {!(type.attributes || []).length ? (
            <tr><td colSpan={8} className="mono">No attributes attached yet.</td></tr>
          ) : null}
        </tbody>
      </table>
      <form className="inline attach-row" onSubmit={attach}>
        <select value={attachId} onChange={(e) => setAttachId(e.target.value)}>
          <option value="">Attach existing attribute…</option>
          {attributes.filter((a) => !attached.has(a.id)).map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({a.data_type})</option>
          ))}
        </select>
        <button className="btn secondary">Attach</button>
      </form>
    </>
  );
}

function AttributeEditor({ type, attribute, lovs, onSaved, fail }) {
  const [def, setDef] = useState({
    name: attribute.name || "",
    description: attribute.description || "",
    data_type: attribute.data_type || "string",
    default_value: attribute.default_value ?? "",
    min_value: attribute.min_value ?? "",
    max_value: attribute.max_value ?? "",
    pattern: attribute.validation?.pattern || "",
    reference_type: attribute.validation?.reference_type || "organization",
    lov_id: attribute.lov_id ? String(attribute.lov_id) : "",
  });
  const baseValidation = attribute.validation || {};
  const [overrides, setOverrides] = useState({
    required: attribute.required === true ? "yes" : attribute.required === false ? "no" : "default",
    visible: attribute.visible !== false,
    editable: attribute.editable !== false,
    sequence: attribute.sequence ?? 0,
  });
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const validation = { ...baseValidation };
      if (def.pattern) validation.pattern = def.pattern;
      else delete validation.pattern;
      if (def.data_type === "reference") validation.reference_type = def.reference_type;
      else delete validation.reference_type;
      await meta.updateAttribute(attribute.id, {
        name: def.name,
        description: def.description,
        data_type: def.data_type,
        default_value: def.default_value === "" ? null : def.default_value,
        min_value: def.min_value === "" ? null : Number(def.min_value),
        max_value: def.max_value === "" ? null : Number(def.max_value),
        lov_id: def.lov_id ? Number(def.lov_id) : null,
        validation: Object.keys(validation).length ? validation : {},
      });
      await meta.updateTypeAttribute(type.id, attribute.id, {
        required_override: overrides.required === "default" ? null : overrides.required === "yes",
        visible: overrides.visible,
        editable: overrides.editable,
        sequence: Number(overrides.sequence) || 0,
      });
      await onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="attr-editor" onSubmit={save}>
      <div className="inline">
        <label className="field grow"><span>Name</span><input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} required /></label>
        <label className="field grow">
          <span>Data type</span>
          <select value={def.data_type} onChange={(e) => setDef({ ...def, data_type: e.target.value })}>
            {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span>List of values</span>
          <select value={def.lov_id} onChange={(e) => setDef({ ...def, lov_id: e.target.value })}>
            <option value="">None</option>
            {lovs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}
          </select>
        </label>
      </div>
      <div className="inline">
        <label className="field grow"><span>Default</span><input value={def.default_value} onChange={(e) => setDef({ ...def, default_value: e.target.value })} /></label>
        {["integer", "decimal"].includes(def.data_type) ? (
          <>
            <label className="field grow"><span>Min</span><input type="number" value={def.min_value} onChange={(e) => setDef({ ...def, min_value: e.target.value })} /></label>
            <label className="field grow"><span>Max</span><input type="number" value={def.max_value} onChange={(e) => setDef({ ...def, max_value: e.target.value })} /></label>
          </>
        ) : null}
        {def.data_type === "string" ? (
          <label className="field grow"><span>Pattern (regex)</span><input value={def.pattern} onChange={(e) => setDef({ ...def, pattern: e.target.value })} /></label>
        ) : null}
        {def.data_type === "reference" ? (
          <label className="field grow">
            <span>Reference target</span>
            <select value={def.reference_type} onChange={(e) => setDef({ ...def, reference_type: e.target.value })}>
              <option value="organization">organization</option>
              <option value="user">user</option>
              <option value="tenant">tenant</option>
            </select>
          </label>
        ) : null}
      </div>
      <div className="inline">
        <label className="field grow">
          <span>Required on this type</span>
          <select value={overrides.required} onChange={(e) => setOverrides({ ...overrides, required: e.target.value })}>
            <option value="default">Use default</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="field grow"><span>Sequence</span><input type="number" value={overrides.sequence} onChange={(e) => setOverrides({ ...overrides, sequence: e.target.value })} /></label>
        <label className="field grow"><span>Visible</span><input type="checkbox" checked={overrides.visible} onChange={(e) => setOverrides({ ...overrides, visible: e.target.checked })} /></label>
        <label className="field grow"><span>Editable</span><input type="checkbox" checked={overrides.editable} onChange={(e) => setOverrides({ ...overrides, editable: e.target.checked })} /></label>
      </div>
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save attribute"}</button>
    </form>
  );
}

function NewAttributeForm({ type, lovs, onDone, onCancel, fail }) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    data_type: "string",
    required: false,
    lov_id: "",
    min_value: "",
    max_value: "",
    pattern: "",
    reference_type: "organization",
  });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const validation = {};
      if (form.pattern) validation.pattern = form.pattern;
      if (form.data_type === "reference") validation.reference_type = form.reference_type;
      const created = await meta.createAttribute({
        code: form.code,
        name: form.name,
        data_type: form.data_type,
        required: form.required,
        lov_id: form.lov_id ? Number(form.lov_id) : undefined,
        min_value: form.min_value === "" ? undefined : Number(form.min_value),
        max_value: form.max_value === "" ? undefined : Number(form.max_value),
        validation: Object.keys(validation).length ? validation : undefined,
      });
      await meta.attachAttribute(type.id, { attribute_id: created.id });
      await onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel new-attr-form" onSubmit={submit}>
      <h3>New attribute for {type.name}</h3>
      <div className="inline">
        <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
        <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field grow">
          <span>Data type</span>
          <select value={form.data_type} onChange={(e) => setForm({ ...form, data_type: e.target.value })}>
            {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <div className="inline">
        <label className="field grow">
          <span>List of values</span>
          <select value={form.lov_id} onChange={(e) => setForm({ ...form, lov_id: e.target.value })}>
            <option value="">None</option>
            {lovs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}
          </select>
        </label>
        {["integer", "decimal"].includes(form.data_type) ? (
          <>
            <label className="field grow"><span>Min</span><input type="number" value={form.min_value} onChange={(e) => setForm({ ...form, min_value: e.target.value })} /></label>
            <label className="field grow"><span>Max</span><input type="number" value={form.max_value} onChange={(e) => setForm({ ...form, max_value: e.target.value })} /></label>
          </>
        ) : null}
        {form.data_type === "string" ? (
          <label className="field grow"><span>Pattern (regex)</span><input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} /></label>
        ) : null}
        {form.data_type === "reference" ? (
          <label className="field grow">
            <span>Reference target</span>
            <select value={form.reference_type} onChange={(e) => setForm({ ...form, reference_type: e.target.value })}>
              <option value="organization">organization</option>
              <option value="user">user</option>
              <option value="tenant">tenant</option>
            </select>
          </label>
        ) : null}
        <label className="field grow"><span>Required</span><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /></label>
      </div>
      <div className="inline">
        <button className="btn" disabled={busy}>{busy ? "Creating…" : "Create & attach"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AttributesTab({ attributes, lovOptions, onCreate, onStatus, onDelete }) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    data_type: "string",
    required: false,
    min_value: "",
    max_value: "",
    pattern: "",
    reference_type: "organization",
    lov_id: "",
  });

  function submit(e) {
    e.preventDefault();
    const validation = {};
    if (form.pattern) validation.pattern = form.pattern;
    if (form.data_type === "reference") validation.reference_type = form.reference_type;
    onCreate({
      code: form.code,
      name: form.name,
      data_type: form.data_type,
      required: form.required,
      min_value: form.min_value === "" ? undefined : Number(form.min_value),
      max_value: form.max_value === "" ? undefined : Number(form.max_value),
      lov_id: form.lov_id ? Number(form.lov_id) : undefined,
      validation: Object.keys(validation).length ? validation : undefined,
    });
  }

  return (
    <div className="split">
      <div className="panel">
        <h3>Attributes</h3>
        <table>
          <thead><tr><th>Code</th><th>Type</th><th>Required</th><th>Status</th><th /></tr></thead>
          <tbody>
            {attributes.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.code}</td>
                <td><span className="badge">{a.data_type}</span></td>
                <td>{a.required ? "yes" : "no"}</td>
                <td><StatusBadge status={a.status} /></td>
                <td className="inline">
                  <button type="button" className="btn ghost" onClick={() => onStatus(a, a.status === "active" ? "inactive" : "active")}>
                    {a.status === "active" ? "Disable" : "Enable"}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => onDelete(a)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="panel" onSubmit={submit}>
        <h3>Create attribute</h3>
        <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field">
          <span>Data type</span>
          <select value={form.data_type} onChange={(e) => setForm({ ...form, data_type: e.target.value })}>
            {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field">
          <span>List of values</span>
          <select value={form.lov_id} onChange={(e) => setForm({ ...form, lov_id: e.target.value })}>
            <option value="">None</option>
            {lovOptions.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        {form.data_type === "reference" ? (
          <label className="field">
            <span>Reference target</span>
            <select value={form.reference_type} onChange={(e) => setForm({ ...form, reference_type: e.target.value })}>
              <option value="organization">organization</option>
              <option value="user">user</option>
              <option value="tenant">tenant</option>
            </select>
          </label>
        ) : null}
        {["string"].includes(form.data_type) ? (
          <label className="field"><span>Pattern (regex)</span><input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} /></label>
        ) : null}
        {["integer", "decimal"].includes(form.data_type) ? (
          <div className="inline">
            <label className="field grow"><span>Min</span><input type="number" value={form.min_value} onChange={(e) => setForm({ ...form, min_value: e.target.value })} /></label>
            <label className="field grow"><span>Max</span><input type="number" value={form.max_value} onChange={(e) => setForm({ ...form, max_value: e.target.value })} /></label>
          </div>
        ) : null}
        <label className="field"><span>Required</span><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /></label>
        <button className="btn secondary">Create</button>
      </form>
    </div>
  );
}

function LovsTab({ lovs, selected, values, onSelect, onCreate, onAddValue, onRemoveValue }) {
  const [form, setForm] = useState({ code: "", name: "", selection_type: "single" });
  const [valueForm, setValueForm] = useState({ code: "", label: "", parent_value_id: "" });

  return (
    <div className="split">
      <div className="panel">
        <h3>Lists of values</h3>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Selection</th><th>Values</th><th /></tr></thead>
          <tbody>
            {lovs.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.code}</td>
                <td>{l.name}</td>
                <td><span className="badge">{l.selection_type}</span></td>
                <td>{l.value_count}</td>
                <td><button type="button" className="btn ghost" onClick={() => onSelect(l)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected ? (
          <>
            <h3 style={{ marginTop: 18 }}>{selected.name} values</h3>
            <table>
              <thead><tr><th>Code</th><th>Label</th><th>Parent</th><th>Active</th><th /></tr></thead>
              <tbody>
                {values.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.code}</td>
                    <td>{v.label}</td>
                    <td className="mono">{v.parent_value_id ? `#${v.parent_value_id}` : "—"}</td>
                    <td>{v.active ? "yes" : "no"}</td>
                    <td><button type="button" className="btn ghost" onClick={() => onRemoveValue(selected.id, v.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form
              className="row"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                onAddValue(selected.id, {
                  code: valueForm.code,
                  label: valueForm.label,
                  parent_value_id: valueForm.parent_value_id ? Number(valueForm.parent_value_id) : undefined,
                });
                setValueForm({ code: "", label: "", parent_value_id: "" });
              }}
            >
              <label className="field grow"><span>Code</span><input value={valueForm.code} onChange={(e) => setValueForm({ ...valueForm, code: e.target.value })} required /></label>
              <label className="field grow"><span>Label</span><input value={valueForm.label} onChange={(e) => setValueForm({ ...valueForm, label: e.target.value })} required /></label>
              <label className="field grow">
                <span>Parent</span>
                <select value={valueForm.parent_value_id} onChange={(e) => setValueForm({ ...valueForm, parent_value_id: e.target.value })}>
                  <option value="">None</option>
                  {values.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              </label>
              <button className="btn secondary">Add value</button>
            </form>
          </>
        ) : null}
      </div>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(form);
          setForm({ code: "", name: "", selection_type: "single" });
        }}
      >
        <h3>Create list</h3>
        <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field">
          <span>Selection type</span>
          <select value={form.selection_type} onChange={(e) => setForm({ ...form, selection_type: e.target.value })}>
            <option value="single">single</option>
            <option value="multi">multi</option>
          </select>
        </label>
        <button className="btn secondary">Create</button>
      </form>
    </div>
  );
}

function FormsTab({ forms, types, selected, tree, attributes, onSelect, onCreate, onStatus, onSaveLayout }) {
  const [form, setForm] = useState({ code: "", name: "", type_id: "", mode: "create" });
  const [fieldForm, setFieldForm] = useState({ attribute_id: "", node_id: "", sequence: 0 });
  const attrById = useMemo(() => new Map(attributes.map((a) => [a.id, a])), [attributes]);

  return (
    <div className="split">
      <div className="panel">
        <h3>Forms</h3>
        <table>
          <thead><tr><th>Code</th><th>Type</th><th>Mode</th><th>Status</th><th /></tr></thead>
          <tbody>
            {forms.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.code}</td>
                <td className="mono">{f.type_code}</td>
                <td><span className="badge">{f.mode}</span></td>
                <td><StatusBadge status={f.status} /></td>
                <td className="inline">
                  <button type="button" className="btn ghost" onClick={() => onSelect(f)}>Open</button>
                  <button type="button" className="btn ghost" onClick={() => onStatus(f, f.status === "active" ? "inactive" : "active")}>
                    {f.status === "active" ? "Disable" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected ? (
          <div style={{ marginTop: 18 }}>
            <h3>{selected.name} layout</h3>
            <table>
              <thead><tr><th>#</th><th>Field</th><th>Type</th><th>Required</th><th>Editable</th></tr></thead>
              <tbody>
                {(selected.fields || []).map((f) => (
                  <tr key={f.id}>
                    <td>{f.sequence}</td>
                    <td className="mono">{f.code}</td>
                    <td><span className="badge">{attrById.get(f.attribute_id)?.data_type || "?"}</span></td>
                    <td>{f.required_override === 1 ? "yes" : f.required_override === 0 ? "no" : "default"}</td>
                    <td>{f.editable ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form
              className="row"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!fieldForm.attribute_id) return;
                const nextFields = (selected.fields || []).map((f) => ({
                  code: f.code,
                  label_override: f.label_override,
                  placeholder: f.placeholder,
                  help_text: f.help_text,
                  node_id: f.node_id,
                  sequence: f.sequence,
                  required_override: f.required_override,
                  default_override: f.default_override,
                  editable: f.editable,
                }));
                const attr = attrById.get(Number(fieldForm.attribute_id));
                nextFields.push({
                  code: attr.code,
                  node_id: fieldForm.node_id ? Number(fieldForm.node_id) : null,
                  sequence: Number(fieldForm.sequence) || nextFields.length,
                  editable: true,
                });
                onSaveLayout(selected.id, { fields: nextFields });
                setFieldForm({ attribute_id: "", node_id: "", sequence: 0 });
              }}
            >
              <label className="field grow">
                <span>Add field</span>
                <select value={fieldForm.attribute_id} onChange={(e) => setFieldForm({ ...fieldForm, attribute_id: e.target.value })}>
                  <option value="">Select attribute…</option>
                  {attributes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Sequence</span><input type="number" value={fieldForm.sequence} onChange={(e) => setFieldForm({ ...fieldForm, sequence: e.target.value })} /></label>
              <button className="btn secondary">Add field</button>
            </form>
          </div>
        ) : null}
        {tree ? (
          <div style={{ marginTop: 18 }}>
            <h3>Render preview</h3>
            <FormRenderer tree={tree} values={{}} onChange={() => {}} />
          </div>
        ) : null}
      </div>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ ...form, type_id: Number(form.type_id) });
          setForm({ code: "", name: "", type_id: "", mode: "create" });
        }}
      >
        <h3>Create form</h3>
        <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field">
          <span>Type</span>
          <select value={form.type_id} onChange={(e) => setForm({ ...form, type_id: e.target.value })} required>
            <option value="">Select</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Mode</span>
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button className="btn secondary">Create</button>
      </form>
    </div>
  );
}

function RulesTab({ rules, types, forms, onCreate, onStatus, onDelete }) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: "validation",
    type_id: "",
    condition: '{"op":"eq","left":{"op":"value","path":"values.status"},"right":"draft"}',
    actions: '[{"type":"error","field":"status","message":"Not allowed"}]',
  });

  function submit(e) {
    e.preventDefault();
    let condition;
    let actions;
    try {
      condition = JSON.parse(form.condition);
      actions = JSON.parse(form.actions);
    } catch {
      return;
    }
    onCreate({
      code: form.code,
      name: form.name,
      category: form.category,
      type_id: form.type_id ? Number(form.type_id) : undefined,
      condition,
      actions,
    });
  }

  return (
    <div className="split">
      <div className="panel">
        <h3>Rules</h3>
        <table>
          <thead><tr><th>Code</th><th>Category</th><th>Target</th><th>Priority</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.code}</td>
                <td><span className="badge">{r.category}</span></td>
                <td className="mono">{r.type_code || r.form_code || "—"}</td>
                <td>{r.priority}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="inline">
                  <button type="button" className="btn ghost" onClick={() => onStatus(r, r.status === "active" ? "inactive" : "active")}>
                    {r.status === "active" ? "Disable" : "Activate"}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => onDelete(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="panel" onSubmit={submit}>
        <h3>Create rule</h3>
        <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field">
          <span>Category</span>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {RULE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={form.type_id} onChange={(e) => setForm({ ...form, type_id: e.target.value })} required>
            <option value="">Select</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Condition (JSON expression)</span>
          <textarea value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} />
        </label>
        <label className="field">
          <span>Actions (JSON array)</span>
          <textarea value={form.actions} onChange={(e) => setForm({ ...form, actions: e.target.value })} />
        </label>
        <p className="mono">Expressions use a whitelisted interpreter; arbitrary code is rejected.</p>
        <button className="btn secondary">Create rule</button>
      </form>
    </div>
  );
}

function RecordTab({ types, forms, tree, values, result, onPick, onChange, onValidate }) {
  const [kind, setKind] = useState("type");
  const [id, setId] = useState("");
  const options = kind === "type" ? types : forms;

  return (
    <>
      <div className="panel row">
        <label className="field">
          <span>Source</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setId(""); }}>
            <option value="type">Type contract</option>
            <option value="form">Form</option>
          </select>
        </label>
        <label className="field grow">
          <span>{kind === "type" ? "Type" : "Form"}</span>
          <select value={id} onChange={(e) => { setId(e.target.value); if (e.target.value) onPick(kind, Number(e.target.value)); }}>
            <option value="">Select…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}
          </select>
        </label>
        <button type="button" className="btn" disabled={!tree} onClick={onValidate}>Validate</button>
      </div>
      <div className="split">
        <div className="panel">
          <h3>Record</h3>
          {tree ? <FormRenderer tree={tree} values={values} onChange={onChange} /> : <p className="mono">Pick a type or form to render its fields.</p>}
        </div>
        <div className="panel">
          <h3>Validation</h3>
          {result ? (
            <>
              <p className={result.valid ? "valid" : "error"}>{result.valid ? "Record is valid." : `${result.errors.length} error(s).`}</p>
              {result.errors?.length ? (
                <ul className="errors">
                  {result.errors.map((e, i) => (
                    <li key={i}><span className="mono">{e.field || "record"}</span> — {e.message || e.code}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="mono">Submit the record to evaluate required fields, LOV membership, references and rules.</p>
          )}
          <h3 style={{ marginTop: 16 }}>Values</h3>
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{pretty(values)}</pre>
        </div>
      </div>
    </>
  );
}

function ConfigTab({ catalog, onReload, onToggle }) {
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Effective catalog</h3>
        <button type="button" className="btn ghost" onClick={onReload}>Refresh</button>
      </div>
      <p className="sub">Precedence: System → Tenant → Organization. Toggling here writes tenant scope for the active tenant.</p>
      <table>
        <thead><tr><th>Artifact</th><th>Code</th><th>Scope</th><th>Enabled</th><th>Source</th><th /></tr></thead>
        <tbody>
          {catalog.map((row) => (
            <tr key={`${row.artifact_type}-${row.artifact_id}`}>
              <td><span className="badge">{row.artifact_type}</span></td>
              <td className="mono">{row.code}</td>
              <td>{row.is_global ? "global" : "tenant"}</td>
              <td>{row.config?.enabled ? "yes" : "no"}</td>
              <td className="mono">{row.config?.source}</td>
              <td><button type="button" className="btn ghost" onClick={() => onToggle(row)}>{row.config?.enabled ? "Disable" : "Enable"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
