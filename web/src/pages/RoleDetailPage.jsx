import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { iam } from "../api.js";

export default function RoleDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [role, setRole] = useState(null);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({});
  const [error, setError] = useState("");

  async function load() {
    const [r, all] = await Promise.all([iam.role(id), iam.roles("?pageSize=100")]);
    setRole(r);
    setRoles(all.items);
    setForm({ name: r.name, code: r.code, description: r.description, parent_id: r.parent_id || "" });
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [id]);

  async function save(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.updateRole(id, { ...form, parent_id: form.parent_id || null });
      await load();
    } catch (err) { setError(err.message); }
  }

  if (!role) return error ? <div className="error">{error}</div> : null;

  return (
    <>
      <div className="topbar">
        <div><Link to="/roles">Roles</Link><h1>{role.name}</h1><div className="mono">{role.code}</div></div>
        <button className="btn danger" onClick={async () => { try { await iam.deleteRole(id); nav("/roles"); } catch (e) { setError(e.message); } }}>Delete</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="split">
        <form className="panel" onSubmit={save}>
          <h3>Edit role</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field">
            <span>Inherits from</span>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">None</option>
              {roles.filter((r) => String(r.id) !== String(id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <button className="btn">Save</button>
        </form>
        <div>
          <div className="panel">
            <h3>Assignments</h3>
            <p className="sub">Users</p>
            {(role.assignments?.users || []).map((u) => (
              <div key={`${u.id}-${u.assignment_organization_id}`}><Link to={`/users/${u.id}`}>{u.username}</Link> <span className="mono">{u.assignment_organization_id ? `org ${u.assignment_organization_id}` : "global"}</span></div>
            ))}
            <p className="sub">Groups</p>
            {(role.assignments?.groups || []).map((g) => (
              <div key={`${g.id}-${g.assignment_organization_id}`}><Link to={`/groups/${g.id}`}>{g.name}</Link></div>
            ))}
          </div>
          <div className="panel">
            <h3>Permissions</h3>
            {(role.permissions || []).map((p) => (
              <div key={`${p.permission_id}-${p.organization_id}`} className="row" style={{ marginTop: 8 }}>
                <span>
                  <span className={`badge ${p.effect === "allow" ? "active" : "locked"}`}>{p.effect}</span>{" "}
                  {p.permission_code}{" "}
                  <span className="mono">{p.organization_id ? `org ${p.organization_id}` : "global"}</span>
                </span>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={async () => {
                    try {
                      await iam.revokeRolePermission(id, p.permission_id, p.organization_id);
                      await load();
                    } catch (e) { setError(e.message); }
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
            {(role.permissions || []).length === 0 ? <p className="mono">No direct grants. Fail-safe deny.</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}
