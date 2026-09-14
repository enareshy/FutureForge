import React, { useEffect, useMemo, useState } from "react";
import { iam } from "../api.js";

const ACTIONS = ["create", "read", "update", "delete", "execute"];

function nextEffect(current) {
  if (current === "unset") return "allow";
  if (current === "allow") return "deny";
  return "unset";
}

export default function PermissionsPage() {
  const [matrix, setMatrix] = useState(null);
  const [apps, setApps] = useState([]);
  const [roleId, setRoleId] = useState("");
  const [appId, setAppId] = useState("");
  const [error, setError] = useState("");
  const [permForm, setPermForm] = useState({ resource_id: "", action: "read" });
  const [resourceForm, setResourceForm] = useState({
    application_id: "",
    code: "",
    name: "",
    kind: "object",
    parent_id: "",
  });

  async function load() {
    const qs = new URLSearchParams();
    if (roleId) qs.set("roleId", roleId);
    if (appId) qs.set("applicationId", appId);
    const [m, a] = await Promise.all([
      iam.permissionMatrix(qs.toString() ? `?${qs}` : ""),
      iam.applications(),
    ]);
    setMatrix(m);
    setApps(a.items);
    if (!roleId && m.roles[0]) setRoleId(String(m.roles[0].id));
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [roleId, appId]);

  const selectedRole = useMemo(
    () => matrix?.roles.find((r) => String(r.id) === String(roleId)),
    [matrix, roleId]
  );

  const resources = matrix?.resources || [];
  const permissions = matrix?.permissions || [];
  const cells = matrix?.cells || [];

  function cellEffect(permissionId) {
    const cell = cells.find(
      (c) => String(c.roleId) === String(roleId) && c.permissionId === permissionId
    );
    return cell?.effect || "unset";
  }

  async function cycle(permission) {
    if (!roleId) return;
    const current = cellEffect(permission.id);
    const next = nextEffect(current);
    setError("");
    try {
      if (next === "unset") {
        await iam.revokeRolePermission(roleId, permission.id, 0);
      } else {
        await iam.grantRolePermission(roleId, {
          permission_id: permission.id,
          effect: next,
          organization_id: 0,
        });
      }
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function createResource(e) {
    e.preventDefault();
    setError("");
    try {
      const created = await iam.createResource({
        ...resourceForm,
        application_id: Number(resourceForm.application_id),
        parent_id: resourceForm.parent_id ? Number(resourceForm.parent_id) : null,
      });
      for (const action of ACTIONS) {
        try {
          await iam.createPermission({ resource_id: created.id, action });
        } catch {}
      }
      setResourceForm({ application_id: resourceForm.application_id, code: "", name: "", kind: "object", parent_id: "" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createPermission(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createPermission({
        resource_id: Number(permForm.resource_id),
        action: permForm.action,
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Authorization</div>
          <h1>Permission matrix</h1>
          <p className="sub">Role to permission mapping. Click a cell to cycle unset, allow, deny. Default deny.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel row">
        <label className="field grow">
          <span>Role</span>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {(matrix?.roles || []).map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Application</span>
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">All modules</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="panel matrix">
        <div className="mono" style={{ marginBottom: 10 }}>
          {selectedRole ? `Editing ${selectedRole.code} (global scope)` : "Select a role"}
        </div>
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              {ACTIONS.map((a) => (
                <th key={a} className="action">{a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr key={resource.id}>
                <td>
                  {resource.name}
                  <div className="mono">{resource.code} · {resource.kind}</div>
                </td>
                {ACTIONS.map((action) => {
                  const permission = permissions.find(
                    (p) => p.resource_id === resource.id && p.action === action
                  );
                  if (!permission) {
                    return <td key={action} className="mono">—</td>;
                  }
                  const effect = cellEffect(permission.id);
                  return (
                    <td key={action}>
                      <button
                        type="button"
                        className={`cell-btn ${effect}`}
                        onClick={() => cycle(permission)}
                      >
                        {effect}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="split">
        <form className="panel" onSubmit={createResource}>
          <h3>Register resource</h3>
          <label className="field">
            <span>Application</span>
            <select
              value={resourceForm.application_id}
              onChange={(e) => setResourceForm({ ...resourceForm, application_id: e.target.value })}
              required
            >
              <option value="">Select</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Code</span><input value={resourceForm.code} onChange={(e) => setResourceForm({ ...resourceForm, code: e.target.value })} required /></label>
          <label className="field"><span>Name</span><input value={resourceForm.name} onChange={(e) => setResourceForm({ ...resourceForm, name: e.target.value })} required /></label>
          <label className="field">
            <span>Kind</span>
            <select value={resourceForm.kind} onChange={(e) => setResourceForm({ ...resourceForm, kind: e.target.value })}>
              <option value="module">module</option>
              <option value="object">object</option>
            </select>
          </label>
          <label className="field">
            <span>Parent resource</span>
            <select value={resourceForm.parent_id} onChange={(e) => setResourceForm({ ...resourceForm, parent_id: e.target.value })}>
              <option value="">None</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>{r.code}</option>
              ))}
            </select>
          </label>
          <button className="btn">Create + CRUDX permissions</button>
        </form>
        <form className="panel" onSubmit={createPermission}>
          <h3>Add permission</h3>
          <label className="field">
            <span>Resource</span>
            <select value={permForm.resource_id} onChange={(e) => setPermForm({ ...permForm, resource_id: e.target.value })} required>
              <option value="">Select</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>{r.code}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Action</span>
            <select value={permForm.action} onChange={(e) => setPermForm({ ...permForm, action: e.target.value })}>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button className="btn secondary">Create permission</button>
        </form>
      </div>
    </>
  );
}
