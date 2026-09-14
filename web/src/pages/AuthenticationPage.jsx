import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

const emptyProvider = { code: "", name: "", type: "oidc", enabled: 1, config: {}, client_secret: "" };

export default function AuthenticationPage() {
  const [providers, setProviders] = useState([]);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(emptyProvider);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    const [admin, pub, s] = await Promise.all([
      iam.authProvidersAdmin().catch(() => null),
      iam.authProviders(),
      iam.authSettings().catch(() => null),
    ]);
    setProviders((admin || pub).items || []);
    setSettings(s);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function saveProvider(e) {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const body = {
        code: form.code,
        name: form.name,
        type: form.type,
        enabled: form.enabled,
        config: {
          issuer: form.config.issuer || "",
          client_id: form.config.client_id || "",
          authorization_url: form.config.authorization_url || "",
          token_url: form.config.token_url || "",
          redirect_uri: form.config.redirect_uri || "",
          entity_id: form.config.entity_id || "",
          acs_url: form.config.acs_url || "",
          sso_url: form.config.sso_url || "",
          url: form.config.url || "",
          bind_dn: form.config.bind_dn || "",
          search_base: form.config.search_base || "",
        },
        client_secret: form.client_secret || undefined,
        bind_password: form.bind_password || undefined,
      };
      if (form.id) await iam.updateAuthProvider(form.id, body);
      else await iam.createAuthProvider(body);
      setForm(emptyProvider);
      setSaved("Provider saved. Secrets are stored encrypted and never returned.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const next = await iam.updateAuthSettings(settings);
      setSettings(next);
      setSaved("Authentication settings saved.");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Security</div>
          <h1>Authentication, SSO &amp; MFA</h1>
          <p className="sub">Providers are configuration, not hard-coded IdPs. Password, OIDC, SAML, and LDAP share one login path.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {saved ? <p className="sub">{saved}</p> : null}
      <div className="split">
        <div className="panel">
          <h3>Providers</h3>
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td><button className="btn ghost" type="button" onClick={() => setForm({ ...p, config: p.config || {}, client_secret: "" })}>{p.name}</button></td>
                  <td className="mono">{p.code}</td>
                  <td><span className="badge">{p.type}</span></td>
                  <td><span className={`badge ${p.enabled ? "active" : "inactive"}`}>{p.enabled ? "enabled" : "disabled"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="panel" onSubmit={saveProvider}>
          <h3>{form.id ? "Edit provider" : "Register provider"}</h3>
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required disabled={!!form.id} /></label>
          <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field">
            <span>Type</span>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="password">Password</option>
              <option value="oidc">OAuth 2.0 / OIDC</option>
              <option value="saml">SAML 2.0</option>
              <option value="ldap">LDAP / Active Directory</option>
            </select>
          </label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center" }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked ? 1 : 0 })} />
            <span>Enabled</span>
          </label>
          {form.type === "oidc" ? (
            <>
              <label className="field"><span>Issuer</span><input value={form.config.issuer || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, issuer: e.target.value } })} /></label>
              <label className="field"><span>Client ID</span><input value={form.config.client_id || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, client_id: e.target.value } })} /></label>
              <label className="field"><span>Authorization URL</span><input value={form.config.authorization_url || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, authorization_url: e.target.value } })} /></label>
              <label className="field"><span>Token URL</span><input value={form.config.token_url || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, token_url: e.target.value } })} /></label>
              <label className="field"><span>Client secret</span><input type="password" value={form.client_secret || ""} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} placeholder={form.config?.client_secret_configured ? "configured" : ""} /></label>
            </>
          ) : null}
          {form.type === "saml" ? (
            <>
              <label className="field"><span>Entity ID</span><input value={form.config.entity_id || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, entity_id: e.target.value } })} /></label>
              <label className="field"><span>SSO URL</span><input value={form.config.sso_url || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, sso_url: e.target.value } })} /></label>
              <label className="field"><span>ACS URL</span><input value={form.config.acs_url || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, acs_url: e.target.value } })} /></label>
            </>
          ) : null}
          {form.type === "ldap" ? (
            <>
              <label className="field"><span>Directory URL</span><input value={form.config.url || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, url: e.target.value } })} /></label>
              <label className="field"><span>Bind DN</span><input value={form.config.bind_dn || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, bind_dn: e.target.value } })} /></label>
              <label className="field"><span>Search base</span><input value={form.config.search_base || ""} onChange={(e) => setForm({ ...form, config: { ...form.config, search_base: e.target.value } })} /></label>
              <label className="field"><span>Bind password</span><input type="password" value={form.bind_password || ""} onChange={(e) => setForm({ ...form, bind_password: e.target.value })} placeholder={form.config?.bind_password_configured ? "configured" : ""} /></label>
            </>
          ) : null}
          <button className="btn">{form.id ? "Save provider" : "Create provider"}</button>
          {form.id ? <button type="button" className="btn ghost" style={{ marginLeft: 8 }} onClick={() => setForm(emptyProvider)}>Cancel</button> : null}
        </form>
      </div>
      {settings ? (
        <form className="panel" onSubmit={saveSettings} style={{ maxWidth: 560 }}>
          <h3>Authentication properties</h3>
          <label className="field" style={{ flexDirection: "row", alignItems: "center" }}>
            <input type="checkbox" checked={!!settings.mfaRequired} onChange={(e) => setSettings({ ...settings, mfaRequired: e.target.checked })} />
            <span>Require MFA for every user</span>
          </label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center" }}>
            <input type="checkbox" checked={!!settings.jitProvision} onChange={(e) => setSettings({ ...settings, jitProvision: e.target.checked })} />
            <span>JIT provision unknown SSO subjects</span>
          </label>
          <label className="field"><span>Rate limit max</span><input type="number" value={settings.rateLimitMax} onChange={(e) => setSettings({ ...settings, rateLimitMax: Number(e.target.value) })} /></label>
          <label className="field"><span>Rate limit window (seconds)</span><input type="number" value={settings.rateLimitWindowSeconds} onChange={(e) => setSettings({ ...settings, rateLimitWindowSeconds: Number(e.target.value) })} /></label>
          <label className="field"><span>Reset token minutes</span><input type="number" value={settings.resetTokenMinutes} onChange={(e) => setSettings({ ...settings, resetTokenMinutes: Number(e.target.value) })} /></label>
          <label className="field"><span>Session hours</span><input type="number" value={settings.sessionHours} onChange={(e) => setSettings({ ...settings, sessionHours: Number(e.target.value) })} /></label>
          <button className="btn">Save settings</button>
        </form>
      ) : null}
    </>
  );
}
