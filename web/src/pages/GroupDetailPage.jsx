import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { iam } from "../api.js";

export default function GroupDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [group, setGroup] = useState(null);
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [form, setForm] = useState({});
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [orgScope, setOrgScope] = useState("0");
  const [error, setError] = useState("");

  async function load() {
    const [g, u, r, gs, o] = await Promise.all([
      iam.group(id), iam.users("?pageSize=100"), iam.roles("?pageSize=100"), iam.groups("?pageSize=100"), iam.orgs(),
    ]);
    setGroup(g);
    setForm({ name: g.name, code: g.code, description: g.description, parent_id: g.parent_id || "", organization_id: g.organization_id || "" });
    setUsers(u.items); setRoles(r.items); setGroups(gs.items); setOrgs(o.items);
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [id]);

  async function act(fn) {
    setError("");
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }
  if (!group) return error ? <div className="error">{error}</div> : null;

  return (
    <>
      <div className="topbar">
        <div><Link to="/groups">Groups</Link><h1>{group.name}</h1><div className="mono">{group.code}</div></div>
        <button className="btn danger" onClick={() => act(async () => { await iam.deleteGroup(id); nav("/groups"); })}>Delete</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="split">
        <form className="panel" onSubmit={(e) => { e.preventDefault(); act(() => iam.updateGroup(id, { ...form, parent_id: form.parent_id || null, organization_id: form.organization_id || null })); }}>
          <h3>Edit group</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field">
            <span>Parent</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None</option>
              {groups.filter((g) => String(g.id) !== String(id)).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <button className="btn">Save</button>
        </form>
        <div>
          <div className="panel">
            <h3>Members</h3>
            <div className="row">
              <select className="grow" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Add user</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
              <button className="btn secondary" onClick={() => userId && act(() => iam.addMember(id, Number(userId)))}>Add</button>
            </div>
            {group.members.map((m) => (
              <div key={m.id} className="row" style={{ marginTop: 8 }}>
                <Link to={`/users/${m.id}`}>{m.display_name}</Link>
                <button className="btn ghost" onClick={() => act(() => iam.removeMember(id, m.id))}>Remove</button>
              </div>
            ))}
          </div>
          <div className="panel">
            <h3>Roles</h3>
            <div className="row">
              <select className="grow" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Assign role</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select value={orgScope} onChange={(e) => setOrgScope(e.target.value)}>
                <option value="0">Global</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <button className="btn secondary" onClick={() => roleId && act(() => iam.assignGroupRole(id, Number(roleId), Number(orgScope)))}>Add</button>
            </div>
            {group.roles.map((r) => (
              <div key={`${r.id}-${r.assignment_organization_id}`} className="row" style={{ marginTop: 8 }}>
                <span>{r.name}</span>
                <button className="btn ghost" onClick={() => act(() => iam.unassignGroupRole(id, r.id, r.assignment_organization_id))}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
