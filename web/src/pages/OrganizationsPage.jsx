import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { iam } from "../api.js";

const empty = { name: "", code: "", kind: "company", parent_id: "", description: "" };

function flatten(nodes, depth = 0, acc = []) {
  for (const node of nodes || []) {
    acc.push({ ...node, depth });
    flatten(node.children, depth + 1, acc);
  }
  return acc;
}

export default function OrganizationsPage() {
  const [tree, setTree] = useState({ items: [], total: 0 });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");
  const [parents, setParents] = useState([]);
  const [levels, setLevels] = useState([]);
  const [path, setPath] = useState("Tenant → Enterprise → Company → Business unit → Plant → Site → Department");
  const [loading, setLoading] = useState(true);

  function load() {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (kind) qs.set("kind", kind);
    if (status) qs.set("status", status);
    const suffix = qs.toString() ? `?${qs}` : "";
    setLoading(true);
    iam.orgTree(suffix)
      .then((data) => setTree({ items: data?.items || [], total: data?.total || 0 }))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    iam.orgs("?pageSize=100").then((r) => setParents(r.items || [])).catch(() => {});
    iam.hierarchy().then((h) => {
      setLevels(h.levels || []);
      if (h.path) setPath(h.path);
      if (h.levels?.length) {
        const codes = h.levels.map((l) => l.code);
        const first = h.levels.find((l) => l.code !== "organization") || h.levels[0];
        setForm((prev) => (codes.includes(prev.kind) ? prev : { ...prev, kind: first.code }));
      }
    }).catch(() => {});
  }

  useEffect(() => { load(); }, [kind, status]);
  const kindOptions = [{ value: "", label: "All levels" }, ...levels.map((l) => ({ value: l.code, label: l.name }))];

  const rows = useMemo(() => flatten(tree.items), [tree]);
  const parentOptions = rows.length ? rows : parents;

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createOrganization({
        ...form,
        parent_id: form.parent_id ? Number(form.parent_id) : null,
      });
      setForm(empty);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Directory</div>
          <h1>Organization &amp; site structure</h1>
          <p className="sub">{path}. Super Admin can change this under Platform properties. Grants on an ancestor apply to descendants.</p>
        </div>
      </div>
      <div className="panel row">
        <label className="field grow"><span>Search</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, code, description" /></label>
        <label className="field">
          <span>Level</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kindOptions.map((k) => <option key={k.value || "all"} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <button className="btn secondary" onClick={load}>Search</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="split">
        <div className="panel">
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Level</th><th>Status</th><th>Children</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td style={{ paddingLeft: 8 + o.depth * 18 }}><Link to={`/organizations/${o.id}`}>{o.name}</Link></td>
                  <td className="mono">{o.code}</td>
                  <td><span className="badge">{o.kind}</span></td>
                  <td><span className={`badge ${o.status}`}>{o.status}</span></td>
                  <td className="mono">{o.child_count ?? (o.children || []).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? <p className="mono">Loading organizations…</p> : null}
          {!loading && !rows.length ? <p className="mono">{error || "No organizations"}</p> : null}
        </div>
        <form className="panel" onSubmit={create}>
          <h3>Create node</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
          <label className="field">
            <span>Level</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {levels.map((k) => <option key={k.code} value={k.code}>{k.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Parent</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None (root)</option>
              {parentOptions.map((o) => (
                <option key={o.id} value={o.id}>{"— ".repeat(o.depth || 0)}{o.name} ({o.kind})</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <button className="btn">Create</button>
        </form>
      </div>
    </>
  );
}
