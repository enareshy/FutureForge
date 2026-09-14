import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

const ACTIONS = ["create", "read", "update", "delete", "execute"];

export default function AuthorizationPage() {
  const [users, setUsers] = useState([]);
  const [resources, setResources] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [userId, setUserId] = useState("");
  const [resource, setResource] = useState("iam.users");
  const [action, setAction] = useState("read");
  const [organizationId, setOrganizationId] = useState("0");
  const [result, setResult] = useState(null);
  const [effective, setEffective] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([iam.users("?pageSize=100"), iam.resources(), iam.orgs()])
      .then(([u, r, o]) => {
        setUsers(u.items);
        setResources(r.items);
        setOrgs(o.items);
        if (u.items[0]) setUserId(String(u.items[0].id));
      })
      .catch((e) => setError(e.message));
  }, []);

  async function runCheck(e) {
    e.preventDefault();
    setError("");
    try {
      const body = {
        userId: Number(userId),
        resource,
        action,
        organizationId: Number(organizationId),
      };
      const [decision, eff] = await Promise.all([
        iam.checkPermission(body),
        iam.effectivePermissions(userId, `?organizationId=${organizationId}`),
      ]);
      setResult(decision);
      setEffective(eff);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Authorization</div>
          <h1>Decision tester</h1>
          <p className="sub">checkPermission(user, resource, action, context). Fail-safe deny unless an allow grant matches and no deny matches.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <form className="panel" onSubmit={runCheck}>
        <div className="row">
          <label className="field grow">
            <span>User</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.username} ({u.status})</option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Resource</span>
            <select value={resource} onChange={(e) => setResource(e.target.value)}>
              {resources.map((r) => (
                <option key={r.id} value={r.code}>{r.code}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Action</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Organization</span>
            <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              <option value="0">Global</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <button className="btn">Evaluate</button>
        </div>
      </form>
      {result ? (
        <div className="panel">
          <h3 className={result.allowed ? "decision-allow" : "decision-deny"}>
            {result.decision.toUpperCase()} — {result.message}
          </h3>
          <p className="mono">reason={result.reason} org={result.organizationId}</p>
          {(result.matches || []).map((m, i) => (
            <div key={i} className="mono">
              {m.effect} {m.permissionCode} via {m.roleCode}
              {m.inheritedResource ? " (resource inheritance)" : ""}
              {m.inheritedRole ? " (role inheritance)" : ""}
            </div>
          ))}
        </div>
      ) : null}
      {effective ? (
        <div className="panel">
          <h3>Effective allow set</h3>
          <div className="chips">
            {effective.permissions.map((p) => (
              <span className="chip" key={p.code}>{p.code}</span>
            ))}
            {effective.permissions.length === 0 ? <span className="mono">None</span> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
