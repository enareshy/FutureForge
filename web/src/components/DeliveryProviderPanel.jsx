import React, { useCallback, useEffect, useState } from "react";
import { delivery } from "../api.js";

const EMPTY = {
  code: "",
  name: "",
  channel: "email",
  type: "smtp",
  enabled: true,
  status: "active",
  is_default: false,
  priority: 100,
  rate_limit_per_minute: 0,
  max_attempts: 5,
  backoff_seconds: 30,
  timeout_ms: 10000,
  credential_ref: "",
  config: {},
  password: "",
  api_key: "",
  token: "",
  client_secret: "",
};

const CONFIG_FIELDS = [
  ["host", "Host"],
  ["port", "Port"],
  ["from_name", "From name"],
  ["from_email", "From email"],
  ["username", "Username"],
  ["reply_to", "Reply-to"],
  ["region", "Region"],
  ["endpoint", "Endpoint"],
  ["webhook_url", "Webhook URL"],
];

const SECRET_FIELDS = [
  ["password", "Password"],
  ["api_key", "API key"],
  ["token", "Token"],
  ["client_secret", "Client secret"],
];

export default function DeliveryProviderPanel({ meta, scope }) {
  const [items, setItems] = useState([]);
  const [failures, setFailures] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [providers, failureList] = await Promise.all([
        delivery.providers(scope),
        delivery.providerFailures(`?${scope}pageSize=25`),
      ]);
      setItems(providers.items || []);
      setFailures(failureList.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  function edit(provider) {
    setSelected(provider);
    setDraft({
      ...EMPTY,
      ...provider,
      config: { ...(provider.config || {}) },
      password: "",
      api_key: "",
      token: "",
      client_secret: "",
    });
    setTestResult(null);
    setNotice("");
  }

  function createNew() {
    setSelected(null);
    setDraft(EMPTY);
    setTestResult(null);
    setNotice("");
  }

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function patchConfig(key, value) {
    setDraft((prev) => ({ ...prev, config: { ...prev.config, [key]: value } }));
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const config = {};
      for (const [key] of CONFIG_FIELDS) {
        const value = draft.config[key];
        if (value !== undefined && value !== "") config[key] = value;
      }
      const payload = {
        code: draft.code,
        name: draft.name,
        channel: draft.channel,
        type: draft.type,
        enabled: draft.enabled,
        status: draft.status,
        is_default: draft.is_default,
        priority: Number(draft.priority) || 100,
        rate_limit_per_minute: Number(draft.rate_limit_per_minute) || 0,
        max_attempts: Number(draft.max_attempts) || 5,
        backoff_seconds: Number(draft.backoff_seconds) || 30,
        timeout_ms: Number(draft.timeout_ms) || 10000,
        credential_ref: draft.credential_ref,
        config,
      };
      for (const [key] of SECRET_FIELDS) {
        if (draft[key]) payload[key] = draft[key];
      }
      const res = selected
        ? await delivery.updateProvider(selected.id, payload)
        : await delivery.createProvider(payload);
      setNotice(`Provider ${res.code} saved.`);
      setSelected(res);
      setDraft({ ...EMPTY, ...res, config: { ...(res.config || {}) }, password: "", api_key: "", token: "", client_secret: "" });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(provider) {
    try {
      await delivery.setProviderStatus(provider.id, provider.enabled ? "inactive" : "active");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete provider "${selected.code}"?`)) return;
    try {
      await delivery.deleteProvider(selected.id);
      createNew();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function runTest() {
    if (!selected) return;
    setTestResult(null);
    try {
      setTestResult(await delivery.testProvider(selected.id, testTo));
    } catch (err) {
      setError(err.message);
    }
  }

  const channels = meta?.channels || ["in_app", "email"];
  const providerTypes = meta?.provider_types || ["store", "smtp", "sendgrid", "graph", "webhook", "teams", "slack", "twilio", "fcm", "custom"];

  return (
    <div className="type-manager">
      <div className="panel">
        <div className="panel-head">
          <h3>Providers</h3>
          <button className="btn ghost" type="button" onClick={createNew}>New</button>
        </div>
        <div className="type-list">
          {items.map((provider) => (
            <div key={provider.id} className={`type-row ${selected?.id === provider.id ? "active" : ""}`}>
              <button type="button" className="type-row-main" onClick={() => edit(provider)}>
                <span className="type-name">{provider.name}{provider.is_default ? " · default" : ""}</span>
                <span className="type-sub mono">{provider.code} · {provider.channel} · {provider.type} · p{provider.priority}</span>
              </button>
              <button className="btn ghost" type="button" onClick={() => toggleStatus(provider)}>
                {provider.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
          {!items.length ? <div className="muted" style={{ padding: 10 }}>No providers configured.</div> : null}
        </div>
      </div>

      <div className="panel type-detail-panel">
        <div className="panel-head">
          <h3>{selected ? `Edit ${selected.code}` : "New provider"}</h3>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="valid">{notice}</div> : null}

        <div className="row">
          <label className="field grow"><span>Code</span>
            <input value={draft.code} onChange={(e) => patch("code", e.target.value)} placeholder="email-smtp" />
          </label>
          <label className="field grow"><span>Name</span>
            <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field"><span>Channel</span>
            <select value={draft.channel} onChange={(e) => patch("channel", e.target.value)}>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>Type</span>
            <select value={draft.type} onChange={(e) => patch("type", e.target.value)}>
              {providerTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="field"><span>Priority</span>
            <input type="number" value={draft.priority} onChange={(e) => patch("priority", e.target.value)} />
          </label>
          <label className="notif-check" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => patch("enabled", e.target.checked)} />
            <span>Enabled</span>
          </label>
          <label className="notif-check" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={!!draft.is_default} onChange={(e) => patch("is_default", e.target.checked)} />
            <span>Default for channel</span>
          </label>
        </div>
        <div className="row">
          <label className="field"><span>Rate limit / min</span>
            <input type="number" value={draft.rate_limit_per_minute} onChange={(e) => patch("rate_limit_per_minute", e.target.value)} />
          </label>
          <label className="field"><span>Max attempts</span>
            <input type="number" value={draft.max_attempts} onChange={(e) => patch("max_attempts", e.target.value)} />
          </label>
          <label className="field"><span>Backoff (s)</span>
            <input type="number" value={draft.backoff_seconds} onChange={(e) => patch("backoff_seconds", e.target.value)} />
          </label>
          <label className="field"><span>Timeout (ms)</span>
            <input type="number" value={draft.timeout_ms} onChange={(e) => patch("timeout_ms", e.target.value)} />
          </label>
          <label className="field"><span>Credential reference</span>
            <input value={draft.credential_ref} onChange={(e) => patch("credential_ref", e.target.value)} placeholder="vault://email" />
          </label>
        </div>

        <h3 style={{ marginTop: 12 }}>Configuration</h3>
        <div className="mf-fields">
          {CONFIG_FIELDS.map(([key, label]) => (
            <label className="field grow" key={key}><span>{label}</span>
              <input value={draft.config[key] ?? ""} onChange={(e) => patchConfig(key, e.target.value)} />
            </label>
          ))}
        </div>

        <h3 style={{ marginTop: 12 }}>Credentials</h3>
        <p className="sub">Secrets are encrypted at rest and never returned. Leave blank to keep the stored value.</p>
        <div className="mf-fields">
          {SECRET_FIELDS.map(([key, label]) => (
            <label className="field grow" key={key}><span>{label}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={draft[key]}
                placeholder={selected?.secrets_configured?.[key] ? "•••••••• (configured)" : ""}
                onChange={(e) => patch(key, e.target.value)}
              />
            </label>
          ))}
        </div>

        <div className="inline">
          <button className="btn" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          {selected ? <button className="btn danger" type="button" onClick={remove}>Delete</button> : null}
        </div>

        {selected ? (
          <div className="panel" style={{ marginTop: 14, background: "#10192f" }}>
            <h3>Connection test</h3>
            <div className="row">
              <label className="field grow"><span>Optional recipient email</span>
                <input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </label>
              <button className="btn secondary" type="button" onClick={runTest}>Test</button>
            </div>
            {testResult ? (
              <div style={{ marginTop: 8 }}>
                <span className={`badge ${testResult.ok ? "active" : "inactive"}`}>{testResult.ok ? "ok" : "problems"}</span>
                {testResult.problems?.length ? (
                  <ul className="errors">
                    {testResult.problems.map((problem) => <li key={problem}>{problem}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="panel" style={{ gridColumn: "1 / -1" }}>
        <div className="panel-head"><h3>Recent provider failures</h3></div>
        <table>
          <thead><tr><th>Provider</th><th>Channel</th><th>Error</th><th>Permanent</th><th>When</th></tr></thead>
          <tbody>
            {failures.map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.provider_code || "—"}</td>
                <td>{row.channel}</td>
                <td className="muted">{row.error_code}: {row.error_message}</td>
                <td>{row.permanent ? "yes" : "no"}</td>
                <td className="mono">{row.created_at}</td>
              </tr>
            ))}
            {!failures.length ? <tr><td colSpan={5} className="muted">No provider failures recorded.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
