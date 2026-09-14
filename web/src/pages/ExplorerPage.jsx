import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { iam, metadata as meta } from "../api.js";
import FormRenderer from "../components/FormRenderer.jsx";

// A single navigable tree: tenants -> organization hierarchy -> metadata
// artifacts (types, attributes, lists of values, forms, rules). Selecting a
// node shows a detail panel; metadata nodes also expose quick status actions.

function buildOrgNodes(nodes) {
  return (nodes || []).map((o) => ({
    id: `org-${o.id}`,
    kind: o.kind === "tenant" ? "tenant" : "org",
    label: o.name,
    code: o.code,
    data: o,
    children: buildOrgNodes(o.children),
  }));
}

function buildTypeNodes(nodes) {
  return (nodes || []).map((t) => ({
    id: `type-${t.id}`,
    kind: "type",
    label: t.name,
    code: t.code,
    data: t,
    children: buildTypeNodes(t.children),
  }));
}

function buildMetaNodes(scopeKey, scopeLabel, bucket) {
  const types = buildTypeNodes(bucket.types);
  const attrs = bucket.attributes.map((a) => ({
    id: `attribute-${scopeKey}-${a.id}`,
    kind: "attribute",
    label: a.name,
    code: a.code,
    data: a,
    children: [],
  }));
  const lovs = bucket.lovs.map((l) => ({
    id: `lov-${l.id}`,
    kind: "lov",
    label: l.name,
    code: l.code,
    data: l,
    children: [],
  }));
  const forms = bucket.forms.map((f) => ({
    id: `form-${f.id}`,
    kind: "form",
    label: f.name,
    code: f.code,
    data: f,
    children: [],
  }));
  const rules = bucket.rules.map((r) => ({
    id: `rule-${r.id}`,
    kind: "rule",
    label: r.name,
    code: r.code,
    data: r,
    children: [],
  }));
  const group = (key, label, children) => ({
    id: `folder-${scopeKey}-${key}`,
    kind: "folder",
    label,
    code: "",
    count: children.length,
    children,
  });
  return {
    id: `meta-${scopeKey}`,
    kind: "folder",
    label: scopeLabel,
    code: "",
    count: types.length + attrs.length + lovs.length + forms.length + rules.length,
    children: [
      group("types", "Types", types),
      group("attributes", "Attributes", attrs),
      group("lovs", "Lists of values", lovs),
      group("forms", "Forms", forms),
      group("rules", "Rules", rules),
    ].filter((g) => g.children.length),
  };
}

function matches(node, term) {
  const text = `${node.label} ${node.code || ""}`.toLowerCase();
  return text.includes(term);
}

function filterTree(nodes, term) {
  if (!term) return nodes;
  const out = [];
  for (const node of nodes) {
    const kids = filterTree(node.children, term);
    if (matches(node, term) || kids.length) out.push({ ...node, children: kids });
  }
  return out;
}

function collectFolderIds(nodes, acc = []) {
  for (const node of nodes) {
    if (node.children?.length) {
      acc.push(node.id);
      collectFolderIds(node.children, acc);
    }
  }
  return acc;
}

function TreeNode({ node, depth, expanded, onToggle, selectedId, onSelect, filterTerm }) {
  const hasChildren = (node.children || []).length > 0;
  const isOpen = expanded.has(node.id) || Boolean(filterTerm);
  const active = selectedId === node.id;
  return (
    <div className="tree-branch">
      <div
        className={`tree-row ${active ? "active" : ""} ${node.kind}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node)}
      >
        <button
          type="button"
          className={`tree-toggle ${hasChildren ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (isOpen ? "▾" : "▸") : "•"}
        </button>
        <span className="tree-label">{node.label}</span>
        <span className="tree-meta">
          {node.code ? `· ${node.code}` : ""}
          {typeof node.count === "number" ? ` · ${node.count}` : ""}
        </span>
      </div>
      {hasChildren && isOpen
        ? node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              filterTerm={filterTerm}
            />
          ))
        : null}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export default function ExplorerPage() {
  const [orgRoots, setOrgRoots] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tenantContext, setTenantContext] = useState(null);
  const [bucket, setBucket] = useState({ types: [], attributes: [], lovs: [], forms: [], rules: [] });
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lovValues, setLovValues] = useState({});
  const [filterTerm, setFilterTerm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fail = (err) => setError(err?.message || String(err));
  const flash = (msg) => {
    setNotice(msg);
    setError("");
  };

  const load = useCallback(async () => {
    try {
      const [tree, types, attributes, lovs, forms, rules] = await Promise.all([
        iam.orgTree(),
        meta.typeTree(),
        meta.attributes("?pageSize=500"),
        meta.lovs("?pageSize=500"),
        meta.forms("?pageSize=500"),
        meta.rules("?pageSize=500"),
      ]);
      setOrgRoots(tree.items || []);
      setBucket({
        types: types.items || [],
        attributes: attributes.items || [],
        lovs: lovs.items || [],
        forms: forms.items || [],
        rules: rules.items || [],
      });
      iam.tenants().then((r) => setTenants(r.items || [])).catch(() => {});
      iam.me().then((r) => setTenantContext(r.tenant || null)).catch(() => {});
    } catch (err) {
      fail(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const globalBucket = useMemo(
    () => ({
      types: bucket.types.filter((t) => t.tenant_id === null),
      attributes: bucket.attributes.filter((a) => a.tenant_id === null),
      lovs: bucket.lovs.filter((l) => l.tenant_id === null),
      forms: bucket.forms.filter((f) => f.tenant_id === null),
      rules: bucket.rules.filter((r) => r.tenant_id === null),
    }),
    [bucket]
  );
  const tenantBucket = useMemo(
    () => ({
      types: bucket.types.filter((t) => t.tenant_id !== null),
      attributes: bucket.attributes.filter((a) => a.tenant_id !== null),
      lovs: bucket.lovs.filter((l) => l.tenant_id !== null),
      forms: bucket.forms.filter((f) => f.tenant_id !== null),
      rules: bucket.rules.filter((r) => r.tenant_id !== null),
    }),
    [bucket]
  );

  const roots = useMemo(() => {
    const nodes = buildOrgNodes(orgRoots);
    for (const node of nodes) {
      if (node.kind !== "tenant") continue;
      const metaChildren = [];
      const global = buildMetaNodes("global", "Global metadata", globalBucket);
      const local = buildMetaNodes("tenant", "Tenant metadata", tenantBucket);
      if (global.children.length) metaChildren.push(global);
      if (local.children.length) metaChildren.push(local);
      if (metaChildren.length) {
        node.children = [
          ...node.children,
          {
            id: `metadata-${node.id}`,
            kind: "folder",
            label: "Metadata",
            code: "",
            count: metaChildren.reduce((sum, c) => sum + c.count, 0),
            children: metaChildren,
          },
        ];
      }
    }
    const extra = tenants
      .filter((t) => !nodes.some((n) => n.code === t.code))
      .map((t) => ({
        id: `tenant-${t.id}`,
        kind: "tenant",
        label: t.name,
        code: t.code,
        data: t,
        inactiveContext: true,
        children: [],
      }));
    return [...nodes, ...extra];
  }, [orgRoots, tenants, globalBucket, tenantBucket]);

  useEffect(() => {
    if (!roots.length) return;
    const seeds = new Set();
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.kind === "tenant") {
          seeds.add(node.id);
          for (const child of node.children) {
            if (child.label === "Metadata") seeds.add(child.id);
          }
        }
        walk(node.children);
      }
    };
    walk(roots);
    setExpanded((prev) => new Set([...prev, ...seeds]));
  }, [roots]);

  const visibleRoots = useMemo(() => filterTree(roots, filterTerm.trim().toLowerCase()), [roots, filterTerm]);

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expandAll = () => setExpanded(new Set(collectFolderIds(roots)));
  const collapseAll = () => setExpanded(new Set());

  async function selectNode(node) {
    setSelected(node);
    setDetail(null);
    setNotice("");
    if (node.children?.length) toggle(node.id);
    try {
      if (node.kind === "type") {
        setDetailLoading(true);
        setDetail(await meta.resolveType(node.data.id));
      } else if (node.kind === "lov") {
        setDetailLoading(true);
        const full = await meta.lov(node.data.id);
        setLovValues((prev) => ({ ...prev, [node.data.id]: full.values || [] }));
        setDetail(full);
      } else if (node.kind === "form") {
        setDetailLoading(true);
        setDetail(await meta.renderForm(node.data.id, { values: {} }));
      }
    } catch (err) {
      fail(err);
    } finally {
      setDetailLoading(false);
    }
  }

  async function setStatus(node, status) {
    try {
      if (node.kind === "type") await meta.setTypeStatus(node.data.id, status);
      else if (node.kind === "attribute") await meta.setAttributeStatus(node.data.id, status);
      else if (node.kind === "lov") await meta.setLovStatus(node.data.id, status);
      else if (node.kind === "form") await meta.setFormStatus(node.data.id, status);
      else if (node.kind === "rule") await meta.setRuleStatus(node.data.id, status);
      flash(`${node.label} set to ${status}.`);
      await load();
      const refreshed = { ...node.data, status };
      setSelected({ ...node, data: refreshed });
      if (node.kind === "type") setDetail((d) => (d ? { ...d, status } : d));
    } catch (err) {
      fail(err);
    }
  }

  const lovsForNode = useMemo(() => {
    const values = {};
    for (const [lovId, list] of Object.entries(lovValues)) {
      values[lovId] = list;
    }
    return values;
  }, [lovValues]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Unified data explorer</div>
          <h1>Tenants, organizations &amp; metadata</h1>
          <p className="sub">
            One navigable hierarchy. {tenantContext ? `Active tenant: ${tenantContext.name}. ` : ""}
            Expand a tenant to reach its organization tree and metadata artifacts.
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      <div className="panel row">
        <label className="field grow">
          <span>Filter</span>
          <input
            value={filterTerm}
            onChange={(e) => setFilterTerm(e.target.value)}
            placeholder="Filter by name or code"
          />
        </label>
        <button className="btn ghost" onClick={expandAll}>Expand all</button>
        <button className="btn ghost" onClick={collapseAll}>Collapse all</button>
        <button className="btn secondary" onClick={load}>Reload</button>
      </div>

      <div className="explorer">
        <div className="panel explorer-tree">
          {visibleRoots.length ? (
            visibleRoots.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                selectedId={selected?.id}
                onSelect={selectNode}
                filterTerm={filterTerm.trim()}
              />
            ))
          ) : (
            <p className="mono">No matching nodes.</p>
          )}
        </div>
        <div className="panel explorer-detail">
          <ExplorerDetail
            node={selected}
            detail={detail}
            loading={detailLoading}
            lovValues={lovsForNode}
            onStatus={setStatus}
          />
        </div>
      </div>
    </>
  );
}

function ExplorerDetail({ node, detail, loading, lovValues, onStatus }) {
  if (!node) return <p className="mono">Select a node to inspect it.</p>;
  if (loading) return <p className="mono">Loading…</p>;

  if (node.kind === "folder") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="mono">{node.children.length} item(s)</p>
      </>
    );
  }

  if (node.kind === "tenant") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="mono">{node.code}</p>
        {node.inactiveContext ? (
          <p className="sub">Not the active tenant context. Switch tenant from the sidebar to browse its data.</p>
        ) : (
          <ul className="detail-list">
            <li>Organization children: {node.children?.length || 0}</li>
            <li>Status: <StatusBadge status={node.data?.status || "active"} /></li>
            <li><Link to={`/tenants/${node.data?.id}`}>Open tenant administration</Link></li>
          </ul>
        )}
      </>
    );
  }

  if (node.kind === "org") {
    const o = node.data;
    return (
      <>
        <h3>{o.name}</h3>
        <p className="mono">{o.code}</p>
        <ul className="detail-list">
          <li>Level: <span className="badge">{o.kind}</span></li>
          <li>Status: <StatusBadge status={o.status} /></li>
          <li>Children: {o.child_count ?? (o.children || []).length}</li>
          <li>Users: {o.user_count ?? 0} · Members: {o.member_count ?? 0}</li>
          <li><Link to={`/organizations/${o.id}`}>Open organization</Link></li>
        </ul>
      </>
    );
  }

  if (node.kind === "type") {
    const t = detail || node.data;
    return (
      <>
        <h3>{t.name}</h3>
        <p className="mono">{t.code} · {t.module || "no module"}</p>
        <div className="inline" style={{ marginBottom: 10 }}>
          <StatusBadge status={t.status} />
          <span className="badge">{t.tenant_id ? "tenant" : "global"}</span>
          <button type="button" className="btn ghost" onClick={() => onStatus(node, t.status === "active" ? "inactive" : "active")}>
            {t.status === "active" ? "Disable" : "Activate"}
          </button>
          <Link className="btn ghost" to="/metadata">Manage in metadata</Link>
        </div>
        <h3>Attributes ({t.attributes?.length || 0})</h3>
        <table>
          <thead><tr><th>Code</th><th>Type</th><th>Required</th><th>Origin</th></tr></thead>
          <tbody>
            {(t.attributes || []).map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.code}</td>
                <td><span className="badge">{a.data_type}</span></td>
                <td>{a.required ? "yes" : "no"}</td>
                <td className="mono">{a.inherited_from ? `inherited #${a.inherited_from}` : "own"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.parent_type_id ? <p className="sub">Inherits from type #{t.parent_type_id}.</p> : null}
      </>
    );
  }

  if (node.kind === "attribute") {
    const a = node.data;
    return (
      <>
        <h3>{a.name}</h3>
        <p className="mono">{a.code}</p>
        <div className="inline" style={{ marginBottom: 10 }}>
          <StatusBadge status={a.status} />
          <button type="button" className="btn ghost" onClick={() => onStatus(node, a.status === "active" ? "inactive" : "active")}>
            {a.status === "active" ? "Disable" : "Activate"}
          </button>
        </div>
        <ul className="detail-list">
          <li>Data type: <span className="badge">{a.data_type}</span></li>
          <li>Required: {a.required ? "yes" : "no"}</li>
          <li>Multi value: {a.multi_value ? "yes" : "no"}</li>
          {a.lov_id ? <li>List of values: #{a.lov_id}</li> : null}
          {a.min_value !== null && a.min_value !== undefined ? <li>Min: {a.min_value}</li> : null}
          {a.max_value !== null && a.max_value !== undefined ? <li>Max: {a.max_value}</li> : null}
          {a.validation?.pattern ? <li>Pattern: <span className="mono">{a.validation.pattern}</span></li> : null}
        </ul>
      </>
    );
  }

  if (node.kind === "lov") {
    const l = detail || node.data;
    const values = lovValues[l.id] || l.values || [];
    return (
      <>
        <h3>{l.name}</h3>
        <p className="mono">{l.code}</p>
        <div className="inline" style={{ marginBottom: 10 }}>
          <StatusBadge status={l.status} />
          <span className="badge">{l.selection_type}</span>
          <button type="button" className="btn ghost" onClick={() => onStatus(node, l.status === "active" ? "inactive" : "active")}>
            {l.status === "active" ? "Disable" : "Activate"}
          </button>
        </div>
        <h3>Values ({values.length})</h3>
        <table>
          <thead><tr><th>Code</th><th>Label</th><th>Parent</th><th>Active</th></tr></thead>
          <tbody>
            {values.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.code}</td>
                <td>{v.label}</td>
                <td className="mono">{v.parent_value_id ? `#${v.parent_value_id}` : "—"}</td>
                <td>{v.active ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  if (node.kind === "form") {
    const f = node.data;
    return (
      <>
        <h3>{f.name}</h3>
        <p className="mono">{f.code} · {f.type_code} · {f.mode}</p>
        <div className="inline" style={{ marginBottom: 10 }}>
          <StatusBadge status={f.status} />
          <button type="button" className="btn ghost" onClick={() => onStatus(node, f.status === "active" ? "inactive" : "active")}>
            {f.status === "active" ? "Disable" : "Activate"}
          </button>
        </div>
        {detail ? (
          <>
            <h3>Render preview</h3>
            <FormRenderer tree={detail} values={{}} onChange={() => {}} />
          </>
        ) : null}
      </>
    );
  }

  if (node.kind === "rule") {
    const r = node.data;
    let condition = r.condition;
    let actions = r.actions;
    if (typeof condition === "string") {
      try { condition = JSON.parse(condition); } catch { /* keep raw */ }
    }
    if (typeof actions === "string") {
      try { actions = JSON.parse(actions); } catch { /* keep raw */ }
    }
    return (
      <>
        <h3>{r.name}</h3>
        <p className="mono">{r.code}</p>
        <div className="inline" style={{ marginBottom: 10 }}>
          <StatusBadge status={r.status} />
          <span className="badge">{r.category}</span>
          <button type="button" className="btn ghost" onClick={() => onStatus(node, r.status === "active" ? "inactive" : "active")}>
            {r.status === "active" ? "Disable" : "Activate"}
          </button>
        </div>
        <h3>Condition</h3>
        <pre className="mono json">{JSON.stringify(condition, null, 2)}</pre>
        <h3>Actions</h3>
        <pre className="mono json">{JSON.stringify(actions, null, 2)}</pre>
      </>
    );
  }

  return <p className="mono">Unsupported node.</p>;
}
