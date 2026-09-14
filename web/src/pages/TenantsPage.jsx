import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

const empty = { name: "", code: "", description: "" };

export default function TenantsPage() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [config, setConfig] = useState(null);
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await iam.tenants();
      setItems(res.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function open(tenant) {
    setError("");
    setNotice("");
    setSelected(tenant);
    setContext(null);
    setConfig(null);
    try {
      const [ctx, cfg] = await Promise.all([iam.tenantContext(tenant.id), iam.tenantConfig(tenant.id)]);
      setContext(ctx);
      setConfig(cfg);
      setValues({});
    } catch (err) {
      setError(err.message);
    }
  }

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createTenant(form);
      setForm(empty);
      setNotice("Tenant created.");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setStatus(tenant, active) {
    setError("");
    try {
      if (active) await iam.activateTenant(tenant.id);
      else await iam.deactivateTenant(tenant.id);
      load();
      if (selected?.id === tenant.id) open({ ...tenant, status: active ? "active" : "inactive" });
    } catch (err) {
      setError(err.message);
    }
  }

  async function enter(tenant) {
    setError("");
    try {
      await iam.selectTenant(tenant.id);
      window.location.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveConfig(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const patch = {};
      for (const [key, value] of Object.entries(values)) {
        if (value === "" || value === undefined) continue;
        patch[key] = value;
      }
      if (!Object.keys(patch).length) {
        setError("No overrides to save.");
        return;
      }
      const res = await iam.updateTenantConfig(selected.id, patch);
      setConfig(res);
      setValues({});
      setNotice("Tenant overrides saved.");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Super Admin</div>
          <h1>Tenants</h1>
          <p className="sub">Each tenant is an isolation boundary. Tenant business data requires explicit tenant context; switching context is audited.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub">{notice}</p> : null}

      <div className="split">
        <div className="panel">
          <table>
            <thead>
              <tr><th>Name</th><th>Code</th><th>Status</th><th>Orgs</th><th>Users</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td><a onClick={() => open(t)} style={{ cursor: "pointer" }}>{t.name}</a></td>
                  <td className="mono">{t.code}</td>
                  <td><span className={`badge ${t.status}`}>{t.status}</span></td>
                  <td className="mono">{t.org_count ?? 0}</td>
                  <td className="mono">{t.user_count ?? 0}</td>
                  <td className="row">
                    <button className="btn ghost" onClick={() => enter(t)}>Enter</button>
                    <button className="btn ghost" onClick={() => setStatus(t, t.status !== "active")}>
                      {t.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? <p className="mono">Loading tenants…</p> : null}
          {!loading && !items.length ? <p className="mono">{error || "No tenants"}</p> : null}
        </div>

        <form className="panel" onSubmit={create}>
          <h3>Create tenant</h3>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <button className="btn">Create</button>
        </form>
      </div>

      {selected ? (
        <div className="panel">
          <h3>{selected.name} — tenant administration</h3>
          <p className="sub">
            Tenant context: {context ? `${context.org_count} organizations, ${context.user_count} users` : "loading…"}
          </p>
          {config ? (
            <form onSubmit={saveConfig}>
              <h4>Configuration overrides (tenant scope)</h4>
              <table>
                <thead><tr><th>Key</th><th>Effective</th><th>Source</th><th>Override</th></tr></thead>
                <tbody>
                  {config.effective
                    .filter((item) => item.scopes.includes("tenant") && !item.system_only)
                    .map((item) => (
                      <tr key={item.key}>
                        <td className="mono">{item.key}</td>
                        <td className="mono">{String(item.value)}</td>
                        <td><span className="badge">{item.source}</span></td>
                        <td>
                          <input
                            placeholder={item.type === "boolean" ? "true/false" : "value"}
                            value={values[item.key] ?? ""}
                            onChange={(e) => setValues({ ...values, [item.key]: e.target.value })}
                          />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <button className="btn" style={{ marginTop: 12 }}>Save overrides</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
