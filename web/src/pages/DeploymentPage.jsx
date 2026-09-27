import React, { useEffect, useState } from "react";
import { deployment } from "../api.js";

// Human-friendly labels for the feature categories in the entitlement catalog.
const CATEGORY_LABELS = {
  core: "Core platform",
  engineering: "Engineering",
  governance: "Governance & data",
  exchange: "Exchange & integration",
  operations: "Operations",
  topology: "Deployment-specific",
};

const REASON_LABELS = {
  disabled_by_operator: "disabled by operator",
  edition_too_low: "edition too low",
  mode_not_allowed: "topology not allowed",
};

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="muted">{label}</div>
      <div className="mono" style={{ fontSize: 20 }}>{value}</div>
      {hint ? <div className="muted">{hint}</div> : null}
    </div>
  );
}

export default function DeploymentPage() {
  const [meta, setMeta] = useState(null);
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(null);
  const [features, setFeatures] = useState([]);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      const [m, p, f, s, h] = await Promise.all([
        deployment.meta(),
        deployment.profile(),
        deployment.features(),
        deployment.featureSummary(),
        deployment.history("?pageSize=25"),
      ]);
      setMeta(m);
      setProfile(p.profile);
      setForm(p.profile);
      setFeatures(f.items || []);
      setSummary(s);
      setHistory(h.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  function setField(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function changeMode(code) {
    const info = meta?.vocabulary.modes.find((m) => m.code === code);
    setForm((prev) => ({
      ...prev,
      mode: code,
      tenant_strategy: info?.default_tenant_strategy || prev.tenant_strategy,
      self_registration: info ? Boolean(info.default_self_registration) : prev.self_registration,
    }));
  }

  async function saveProfile(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const res = await deployment.updateProfile({
        mode: form.mode,
        edition: form.edition,
        installation_name: form.installation_name,
        tenant_strategy: form.tenant_strategy,
        self_registration: !!form.self_registration,
        telemetry_enabled: !!form.telemetry_enabled,
        support_email: form.support_email,
        notes: form.notes,
      });
      setProfile(res.profile);
      setForm(res.profile);
      setNotice("Deployment profile saved.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleFeature(feature) {
    setError("");
    setNotice("");
    try {
      await deployment.updateFeature(feature.feature_code, { enabled: !feature.enabled });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveFeatureNotes(feature, notes) {
    setError("");
    try {
      await deployment.updateFeature(feature.feature_code, { notes });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!profile || !meta) return error ? <div className="error">{error}</div> : <p className="mono" style={{ padding: 24 }}>Loading deployment…</p>;

  const grouped = features.reduce((acc, feature) => {
    (acc[feature.category] ||= []).push(feature);
    return acc;
  }, {});

  const modeInfo = meta.vocabulary.modes.find((m) => m.code === profile.mode);
  const editionInfo = meta.vocabulary.editions.find((e) => e.code === profile.edition);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Super Admin</div>
          <h1>Deployment &amp; editions</h1>
          <p className="sub">
            Declare how this install is deployed — Cloud SaaS, Private Cloud or Local — and which
            edition it is licensed at. Feature entitlements gate the whole deployment.
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="grid">
        <Stat label="Installation" value={profile.installation_name} hint="Shown across the console" />
        <Stat label="Topology" value={modeInfo?.name || profile.mode} hint={profile.tenant_strategy === "single" ? "Single-tenant" : "Multi-tenant"} />
        <Stat label="Edition" value={editionInfo?.name || profile.edition} hint={editionInfo?.description} />
        <Stat
          label="Effective features"
          value={summary ? `${summary.effective}/${summary.total}` : "—"}
          hint={summary ? `${summary.total - summary.effective} not entitled` : ""}
        />
      </div>

      <form className="panel" onSubmit={saveProfile} style={{ maxWidth: 720 }}>
        <h3>Deployment profile</h3>
        <p className="sub">
          {modeInfo?.description} {editionInfo ? `Licensed at ${editionInfo.name}.` : ""}
        </p>

        <div className="inline">
          <label className="field">
            <span>Installation name</span>
            <input value={form.installation_name} onChange={(e) => setField({ installation_name: e.target.value })} required />
          </label>
          <label className="field">
            <span>Topology</span>
            <select value={form.mode} onChange={(e) => changeMode(e.target.value)}>
              {meta.vocabulary.modes.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Edition</span>
            <select value={form.edition} onChange={(e) => setField({ edition: e.target.value })}>
              {meta.vocabulary.editions.map((ed) => <option key={ed.code} value={ed.code}>{ed.name}</option>)}
            </select>
          </label>
        </div>

        <div className="inline">
          <label className="field">
            <span>Tenant strategy</span>
            <select value={form.tenant_strategy} onChange={(e) => setField({ tenant_strategy: e.target.value })}>
              <option value="multi">Multi-tenant</option>
              <option value="single">Single-tenant</option>
            </select>
          </label>
          <label className="field">
            <span>Support email</span>
            <input value={form.support_email} onChange={(e) => setField({ support_email: e.target.value })} placeholder="support@example.com" />
          </label>
        </div>

        <label className="checkbox">
          <input type="checkbox" checked={!!form.self_registration} onChange={(e) => setField({ self_registration: e.target.checked })} />
          <span>Allow self-service signup / tenant registration</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={!!form.telemetry_enabled} onChange={(e) => setField({ telemetry_enabled: e.target.checked })} />
          <span>Share anonymized usage telemetry with the vendor (unavailable on air-gapped installs)</span>
        </label>

        <label className="field">
          <span>Notes</span>
          <textarea value={form.notes} onChange={(e) => setField({ notes: e.target.value })} placeholder="Contract, region, maintenance window…" />
        </label>

        <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
      </form>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>Feature entitlements</h3>
            <p className="sub">Toggle a feature off to withdraw it deployment-wide. The effective state also reflects the licensed edition and topology.</p>
          </div>
        </div>

        {Object.entries(grouped).map(([category, items]) => (
          <div key={category} style={{ marginTop: 16 }}>
            <h4>{CATEGORY_LABELS[category] || category}</h4>
            <table>
              <thead>
                <tr><th>Feature</th><th>Edition floor</th><th>Topology</th><th>Effective</th><th>Enabled</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {items.map((feature) => (
                  <tr key={feature.feature_code}>
                    <td>
                      <div>{feature.name}</div>
                      <div className="muted mono">{feature.feature_code}</div>
                      {feature.description ? <div className="muted">{feature.description}</div> : null}
                    </td>
                    <td><span className="badge">{feature.required_edition}</span></td>
                    <td className="mono">{feature.allowed_modes.length ? feature.allowed_modes.join(", ") : "all"}</td>
                    <td>
                      <span className={`badge ${feature.effective ? "active" : "locked"}`}>
                        {feature.effective ? "effective" : feature.reasons.map((r) => REASON_LABELS[r] || r).join(", ")}
                      </span>
                    </td>
                    <td>
                      <input type="checkbox" checked={feature.enabled} onChange={() => toggleFeature(feature)} />
                    </td>
                    <td>
                      <FeatureNotes feature={feature} onSave={saveFeatureNotes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>Change history</h3>
        <table>
          <thead>
            <tr><th>When</th><th>Action</th><th>Entity</th><th>Actor</th><th>Details</th></tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.id}>
                <td className="mono">{entry.created_at}</td>
                <td><span className="badge">{entry.action}</span></td>
                <td className="mono">{entry.entity_ref || entry.entity_type}</td>
                <td className="mono">{entry.actor_username || "—"}</td>
                <td className="mono">{summarize(entry.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.length ? <p className="mono">No changes recorded yet.</p> : null}
      </div>
    </>
  );
}

function FeatureNotes({ feature, onSave }) {
  const [value, setValue] = useState(feature.notes || "");
  useEffect(() => { setValue(feature.notes || ""); }, [feature.notes]);
  const dirty = value !== (feature.notes || "");
  return (
    <div className="row">
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="optional" />
      {dirty ? <button className="btn ghost" onClick={() => onSave(feature, value)}>Save</button> : null}
    </div>
  );
}

function summarize(details) {
  if (!details || !Object.keys(details).length) return "—";
  const changed = details.changed;
  if (Array.isArray(changed) && changed.length) return `changed: ${changed.join(", ")}`;
  if (details.reasons?.length) return `reasons: ${details.reasons.join(", ")}`;
  return Object.entries(details)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
    .join(", ");
}
