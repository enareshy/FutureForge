import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { iam } from "../api.js";

const empty = { name: "", code: "", description: "", parent_id: "" };

export default function RolesPage() {
  const [data, setData] = useState({ items: [] });
  const [q, setQ] = useState("");
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");

  function load() {
    const qs = q ? `?q=${encodeURIComponent(q)}&pageSize=100` : "?pageSize=100";
    iam.roles(qs).then(setData).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createRole({ ...form, parent_id: form.parent_id ? Number(form.parent_id) : null });
      setForm(empty);
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="topbar"><div><div className="brand">Authorization</div><h1>Roles</h1></div></div>
      <div className="panel row">
        <label className="field grow"><span>Search</span><input value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn secondary" onClick={load}>Search</button>
      </div>
      <div className="split">
        <div className="panel">
          {error ? <div className="error">{error}</div> : null}
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Assignments</th></tr></thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/roles/${r.id}`}>{r.name}</Link></td>
                  <td className="mono">{r.code}</td>
                  <td>{r.user_assignment_count + r.group_assignment_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="panel" onSubmit={create}>
          <h3>Create role</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field">
            <span>Inherits from</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None</option>
              {(data.items || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <button className="btn">Create</button>
        </form>
      </div>
    </>
  );
}
