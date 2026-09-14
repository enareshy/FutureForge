import React, { useEffect, useMemo, useState } from "react";
import { iam } from "../api.js";

function display(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function ConfigurationPage() {
  const [catalog, setCatalog] = useState({ definitions: [], effective: [], system: {} });
  const [tenants, setTenants] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [scope, setScope] = useState("system");
  const [scopeId, setScopeId] = useState("");
  const [effective, setEffective] = useState([]);
  const [values, setValues] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadCatalog() {
    const res = await iam.config();
    setCatalog(res);
    setEffective(res.effective || []);
  }

  useEffect(() => {
    loadCatalog().catch((e) => setError(e.message));
    iam.tenants().then((r) => setTenants(r.items || [])).catch(() => {});
    iam.orgs("?pageSize=200").then((r) => setOrgs(r.items || [])).catch(() => {});
  }, []);

  const definitions = catalog.definitions || [];

  const targetOptions = useMemo(() => {
    if (scope === "tenant") return tenants.map((t) => ({ id: t.id, label: `${t.name} (${t.code})` }));
    if (scope === "organization") return orgs.map((o) => ({ id: o.id, label: `${o.name} (${o.kind})` }));
    return [];
  }, [scope, tenants, orgs]);

  async function pickScope(nextScope, nextId) {
    setError("");
    setNotice("");
    setValues({});
    setScope(nextScope);
    setScopeId(nextId !== undefined ? nextId : scopeId);
    const id = nextId !== undefined ? nextId : scopeId;
    if (nextScope === "tenant" && id) {
      const res = await iam.tenantConfig(id);
      setEffective(res.effective || []);
    } else if (nextScope === "organization" && id) {
      const res = await iam.config(`?organizationId=${id}`);
      setCatalog(res);
      setEffective(res.effective || []);
    } else {
      await loadCatalog();
    }
  }

  const editable = definitions.filter((d) => {
    if (d.system_only) return scope === "system";
    return d.scopes.includes(scope);
  });

  async function save(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    const patch = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === "" || value === undefined) continue;
      patch[key] = value;
    }
    if (!Object.keys(patch).length) {
      setError("No changes to save.");
      return;
    }
    try {
      if (scope === "system") {
        const merged = { ...catalog.system };
        for (const [key, value] of Object.entries(patch)) {
          const def = definitions.find((d) => d.key === key);
          merged[key] = def?.value_type === "boolean" ? value === true || value === "true" : value;
        }
        await iam.updatePlatformSettings({ values: merged });
      } else if (scope === "tenant") {
        await iam.updateTenantConfig(scopeId, patch);
      } else {
        await iam.updateConfig({ scope, scopeId: Number(scopeId), values: patch });
      }
      setValues({});
      setNotice("Configuration saved. Lower scopes override higher ones.");
      await pickScope(scope, scopeId);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Configuration</div>
          <h1>Scoped configuration</h1>
          <p className="sub">Precedence: System → Tenant → Organization. Lower scope overrides higher; unknown keys are rejected and system-only keys cannot be overridden.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub">{notice}</p> : null}

      <div className="panel row">
        <label className="field">
          <span>Scope</span>
          <select value={scope} onChange={(e) => pickScope(e.target.value, "")}>
            <option value="system">System</option>
            <option value="tenant">Tenant</option>
            <option value="organization">Organization</option>
          </select>
        </label>
        {scope !== "system" ? (
          <label className="field grow">
            <span>{scope === "tenant" ? "Tenant" : "Organization"}</span>
            <select value={scopeId} onChange={(e) => pickScope(scope, e.target.value)}>
              <option value="">Select…</option>
              {targetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      <form className="panel" onSubmit={save}>
        <table>
          <thead><tr><th>Key</th><th>Type</th><th>Effective</th><th>Source</th><th>Set value</th></tr></thead>
          <tbody>
            {editable.map((def) => {
              const current = effective.find((e) => e.key === def.key);
              return (
                <tr key={def.key}>
                  <td className="mono">{def.key}</td>
                  <td><span className="badge">{def.value_type}</span></td>
                  <td className="mono">{display(current?.value ?? def.default)}</td>
                  <td><span className="badge">{current?.source || "default"}</span></td>
                  <td>
                    <input
                      placeholder={display(def.default)}
                      value={values[def.key] ?? ""}
                      onChange={(e) => setValues({ ...values, [def.key]: e.target.value })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!editable.length ? <p className="mono">Select a target to view settings.</p> : null}
        <button className="btn" style={{ marginTop: 12 }} disabled={scope !== "system" && !scopeId}>Save</button>
      </form>
    </>
  );
}
