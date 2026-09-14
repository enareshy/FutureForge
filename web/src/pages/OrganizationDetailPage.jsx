import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { iam } from "../api.js";

export default function OrganizationDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [org, setOrg] = useState(null);
  const [all, setAll] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({});
  const [child, setChild] = useState({ code: "", name: "", kind: "site" });
  const [memberId, setMemberId] = useState("");
  const [error, setError] = useState("");
  const [levels, setLevels] = useState([]);

  async function load() {
    const [detail, list, people, h] = await Promise.all([
      iam.organization(id),
      iam.orgs("?pageSize=100"),
      iam.users("?pageSize=100"),
      iam.hierarchy().catch(() => ({ levels: [] })),
    ]);
    setLevels(h.levels || []);
    setOrg(detail);
    setAll(list.items || []);
    setUsers(people.items || []);
    setForm({
      name: detail.name,
      code: detail.code,
      kind: detail.kind,
      description: detail.description || "",
      parent_id: detail.parent_id || "",
    });
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, [id]);

  async function act(fn) {
    setError("");
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }

  if (!org) return error ? <div className="error">{error}</div> : <p className="mono">Loading organization…</p>;
  const crumbs = (Array.isArray(org.path) ? org.path : [org]).slice(0, -1);

  return (
    <>
      <div className="topbar">
        <div>
          <Link to="/organizations">Organizations</Link>
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? " / " : null}
                <Link to={`/organizations/${c.id}`}>{c.name}</Link>
              </span>
            ))}
          </div>
          <h1>{org.name}</h1>
          <div className="mono">{org.code} · {org.kind}</div>
        </div>
        <span className={`badge ${org.status}`}>{org.status}</span>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn secondary" onClick={() => act(() => iam.activateOrganization(id))}>Activate</button>
        <button className="btn secondary" onClick={() => act(() => iam.deactivateOrganization(id))}>Deactivate</button>
        <button className="btn danger" onClick={() => act(async () => { await iam.deleteOrganization(id); nav("/organizations"); })}>Delete</button>
      </div>
      <div className="split">
        <form className="panel" onSubmit={(e) => { e.preventDefault(); act(() => iam.updateOrganization(id, { ...form, parent_id: form.parent_id || null })); }}>
          <h3>Edit / move</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field">
            <span>Level</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {(levels.length ? levels : [{ code: form.kind, name: form.kind }]).map((k) => (
                <option key={k.code} value={k.code}>{k.name || k.code}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Parent (move)</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None (root)</option>
              {all.filter((o) => String(o.id) !== String(id)).map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <button className="btn">Save</button>
        </form>
        <div>
          <div className="panel">
            <h3>Children</h3>
            {(org.children || []).map((c) => (
              <div key={c.id}><Link to={`/organizations/${c.id}`}>{c.name}</Link> <span className="mono">{c.kind}</span></div>
            ))}
            {(org.children || []).length === 0 ? <p className="mono">None</p> : null}
          </div>
          <form className="panel" onSubmit={(e) => { e.preventDefault(); act(async () => { await iam.createOrganization({ ...child, parent_id: Number(id) }); setChild({ code: "", name: "", kind: child.kind }); }); }}>
            <h3>Add child</h3>
            <label className="field"><span>Name</span><input value={child.name} onChange={(e) => setChild({ ...child, name: e.target.value })} required /></label>
            <label className="field"><span>Code</span><input value={child.code} onChange={(e) => setChild({ ...child, code: e.target.value })} required /></label>
            <label className="field">
              <span>Level</span>
              <select value={child.kind} onChange={(e) => setChild({ ...child, kind: e.target.value })}>
                {(levels.length ? levels : [{ code: child.kind, name: child.kind }]).map((k) => (
                  <option key={k.code} value={k.code}>{k.name || k.code}</option>
                ))}
              </select>
            </label>
            <button className="btn secondary">Create child</button>
          </form>
          <div className="panel">
            <h3>Assigned people</h3>
            <div className="row">
              <select className="grow" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">Assign user</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}
              </select>
              <button className="btn secondary" onClick={() => memberId && act(() => iam.addOrgMember(id, { userId: Number(memberId) }))}>Add</button>
            </div>
            {(org.members || []).map((m) => (
              <div key={m.id} className="row" style={{ marginTop: 8 }}>
                <Link to={`/users/${m.id}`}>{m.display_name}</Link>
                <span className="mono">{m.is_primary ? "primary" : "site"}</span>
                <button className="btn ghost" onClick={() => act(() => iam.removeOrgMember(id, m.id))}>Remove</button>
              </div>
            ))}
            {!(org.members || []).length ? <p className="mono">None</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}
