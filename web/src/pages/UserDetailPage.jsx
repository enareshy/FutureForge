import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { iam } from "../api.js";

export default function UserDetailPage() {
  const { id } = useParams();
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [groups, setGroups] = useState([]);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({});
  const [password, setPassword] = useState("");
  const [groupId, setGroupId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [orgScope, setOrgScope] = useState("0");
  const [siteOrgId, setSiteOrgId] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [u, o, g, r] = await Promise.all([iam.user(id), iam.orgs("?pageSize=100"), iam.groups("?pageSize=100"), iam.roles("?pageSize=100")]);
    setUser(u);
    setForm({ email: u.email, employee_id: u.employee_id, display_name: u.display_name, organization_id: u.organization_id || "" });
    setOrgs(o.items);
    setGroups(g.items);
    setRoles(r.items);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, [id]);

  async function save(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.updateUser(id, { ...form, organization_id: form.organization_id || null });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function act(fn) {
    setError("");
    try { await fn(); await load(); } catch (err) { setError(err.message); }
  }

  if (!user) return error ? <div className="error">{error}</div> : null;

  return (
    <>
      <div className="topbar">
        <div>
          <Link to="/users">Users</Link>
          <h1>{user.display_name}</h1>
          <div className="mono">{user.username} · {user.employee_id}</div>
        </div>
        <span className={`badge ${user.status}`}>{user.status}</span>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn secondary" onClick={() => act(() => iam.activate(id))}>Activate</button>
        <button className="btn secondary" onClick={() => act(() => iam.deactivate(id))}>Deactivate</button>
        <button className="btn danger" onClick={() => act(() => iam.lock(id))}>Lock</button>
        <button className="btn secondary" onClick={() => act(() => iam.unlock(id))}>Unlock</button>
      </div>
      <div className="split">
        <form className="panel" onSubmit={save}>
          <h3>Profile</h3>
          <label className="field"><span>Email</span><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field"><span>Employee ID</span><input value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} /></label>
          <label className="field"><span>Display name</span><input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
          <label className="field">
            <span>Home organization</span>
            <select value={form.organization_id} onChange={(e) => setForm({ ...form, organization_id: e.target.value })}>
              <option value="">None</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
            </select>
          </label>
          <button className="btn">Save profile</button>
          <h3>Reset password</h3>
          <label className="field"><span>New password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button type="button" className="btn secondary" onClick={() => act(async () => { await iam.resetPassword(id, password); setPassword(""); })}>Reset</button>
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={() => act(() => iam.adminResetMfa(id))}>Reset MFA</button>
        </form>
        <div>
          <div className="panel">
            <h3>Sites &amp; organizations</h3>
            <div className="row">
              <select className="grow" value={siteOrgId} onChange={(e) => setSiteOrgId(e.target.value)}>
                <option value="">Assign additional site</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
              </select>
              <button className="btn secondary" onClick={() => siteOrgId && act(() => iam.addUserOrganization(id, { organizationId: Number(siteOrgId) }))}>Add</button>
            </div>
            {(user.organizations || []).map((o) => (
              <div key={o.id} className="row" style={{ marginTop: 8 }}>
                <Link to={`/organizations/${o.id}`}>{o.name}</Link>
                <span className="mono">{o.kind}{o.is_primary ? " · home" : ""}</span>
                <button className="btn ghost" onClick={() => act(() => iam.removeUserOrganization(id, o.id))}>Remove</button>
              </div>
            ))}
            {!(user.organizations || []).length ? <p className="mono">Home org only</p> : null}
          </div>
          <div className="panel">
            <h3>Groups</h3>
            <div className="row">
              <select className="grow" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Assign group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button className="btn secondary" onClick={() => groupId && act(() => iam.addUserGroup(id, Number(groupId)))}>Add</button>
            </div>
            {user.groups.map((g) => (
              <div key={g.id} className="row" style={{ marginTop: 8 }}>
                <Link to={`/groups/${g.id}`}>{g.name}</Link>
                <button className="btn ghost" onClick={() => act(() => iam.removeUserGroup(id, g.id))}>Remove</button>
              </div>
            ))}
          </div>
          <div className="panel">
            <h3>Direct roles</h3>
            <div className="row">
              <select className="grow" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Assign role</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select value={orgScope} onChange={(e) => setOrgScope(e.target.value)}>
                <option value="0">Global</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <button className="btn secondary" onClick={() => roleId && act(() => iam.assignUserRole(id, Number(roleId), Number(orgScope)))}>Add</button>
            </div>
            {user.roles.map((r) => (
              <div key={`${r.id}-${r.assignment_organization_id}`} className="row" style={{ marginTop: 8 }}>
                <span>{r.name} <span className="mono">{r.assignment_organization_id ? `org ${r.assignment_organization_id}` : "global"}</span></span>
                <button className="btn ghost" onClick={() => act(() => iam.unassignUserRole(id, r.id, r.assignment_organization_id))}>Remove</button>
              </div>
            ))}
          </div>
          <div className="panel">
            <h3>Effective access</h3>
            <div className="chips">
              {(user.access?.roles || []).map((r) => (
                <span className="chip" key={`${r.id}-${r.organizationId}`}>{r.code}{r.inherited ? " (inherited)" : ""}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
