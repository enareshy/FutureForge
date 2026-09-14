import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { iam } from "../api.js";

const empty = { name: "", code: "", description: "", parent_id: "", organization_id: "" };

export default function GroupsPage() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [orgs, setOrgs] = useState([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");

  function load() {
    const qs = q ? `?q=${encodeURIComponent(q)}&pageSize=100` : "?pageSize=100";
    iam.groups(qs).then(setData).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); iam.orgs().then((r) => setOrgs(r.items)); }, []);

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createGroup({
        ...form,
        parent_id: form.parent_id ? Number(form.parent_id) : null,
        organization_id: form.organization_id ? Number(form.organization_id) : null,
      });
      setForm(empty);
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="topbar"><div><div className="brand">Directory</div><h1>Groups</h1></div></div>
      <div className="panel row">
        <label className="field grow"><span>Search</span><input value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn secondary" onClick={load}>Search</button>
      </div>
      <div className="split">
        <div className="panel">
          {error ? <div className="error">{error}</div> : null}
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Members</th></tr></thead>
            <tbody>
              {data.items.map((g) => (
                <tr key={g.id}>
                  <td><Link to={`/groups/${g.id}`}>{g.name}</Link></td>
                  <td className="mono">{g.code}</td>
                  <td>{g.member_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="panel" onSubmit={create}>
          <h3>Create group</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field">
            <span>Parent group</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None</option>
              {data.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Organization</span>
            <select value={form.organization_id} onChange={(e) => setForm({ ...form, organization_id: e.target.value })}>
              <option value="">None</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <button className="btn">Create</button>
        </form>
      </div>
    </>
  );
}
