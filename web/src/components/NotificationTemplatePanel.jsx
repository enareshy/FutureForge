import React, { useCallback, useEffect, useState } from "react";
import { notifications } from "../api.js";

const EMPTY = {
  code: "",
  name: "",
  description: "",
  event_type: "",
  channel: "in_app",
  subject: "",
  html_body: "",
  text_body: "",
  locale: "en",
  status: "active",
};

export default function NotificationTemplatePanel({ meta }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [variables, setVariables] = useState({ roots: [], sample_context: {} });
  const [preview, setPreview] = useState(null);
  const [versions, setVersions] = useState([]);
  const [testTo, setTestTo] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await notifications.templates(channelFilter ? `?channel=${channelFilter}` : "");
      setItems(res.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [channelFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    notifications.templateVariables().then(setVariables).catch(() => {});
  }, []);

  function edit(template) {
    setSelected(template);
    setDraft({ ...EMPTY, ...template });
    setPreview(null);
    setVersions([]);
    setNotice("");
    notifications.templateVersions(template.id).then((res) => setVersions(res.items || [])).catch(() => {});
  }

  function createNew() {
    setSelected(null);
    setDraft(EMPTY);
    setPreview(null);
    setVersions([]);
    setNotice("");
  }

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = selected
        ? await notifications.updateTemplate(selected.id, draft)
        : await notifications.createTemplate(draft);
      setNotice(`Template saved (version ${res.version}).`);
      setSelected(res);
      setDraft({ ...EMPTY, ...res });
      await load();
      notifications.templateVersions(res.id).then((r) => setVersions(r.items || [])).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    if (!selected) return;
    try {
      const next = selected.status === "active" ? "inactive" : "active";
      const res = await notifications.setTemplateStatus(selected.id, next);
      setSelected(res);
      setDraft({ ...EMPTY, ...res });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete template "${selected.code}"?`)) return;
    try {
      await notifications.deleteTemplate(selected.id);
      createNew();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function runPreview() {
    if (!selected) {
      setError("Save the template before previewing.");
      return;
    }
    try {
      setPreview(await notifications.previewTemplate(selected.id, {}));
    } catch (err) {
      setError(err.message);
    }
  }

  async function testSend() {
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await notifications.testSendTemplate(selected.id, { recipient: testTo, channel: draft.channel });
      setNotice(`Test notification #${res.notification_id} queued for ${res.recipient?.username || testTo || "you"}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const channels = meta?.channels || ["in_app", "email"];

  return (
    <div className="type-manager">
      <div className="panel">
        <div className="panel-head">
          <h3>Templates</h3>
          <button className="btn ghost" type="button" onClick={createNew}>New</button>
        </div>
        <label className="field search-field"><span>Channel</span>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
            <option value="">All channels</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div className="type-list">
          {items.map((template) => (
            <div key={template.id} className={`type-row ${selected?.id === template.id ? "active" : ""}`}>
              <button type="button" className="type-row-main" onClick={() => edit(template)}>
                <span className="type-name">{template.name}</span>
                <span className="type-sub mono">{template.code} · {template.channel} · v{template.version}</span>
              </button>
              <span className={`badge ${template.status}`}>{template.status}</span>
            </div>
          ))}
          {!items.length ? <div className="muted" style={{ padding: 10 }}>No templates found.</div> : null}
        </div>
      </div>

      <div className="panel type-detail-panel">
        <div className="panel-head">
          <h3>{selected ? `Edit ${selected.code}` : "New template"}</h3>
          {selected?.is_system ? <span className="badge">system</span> : null}
        </div>
        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="valid">{notice}</div> : null}

        <div className="row">
          <label className="field grow"><span>Code</span>
            <input value={draft.code} onChange={(e) => patch("code", e.target.value)} placeholder="task.assigned" />
          </label>
          <label className="field grow"><span>Name</span>
            <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field grow"><span>Event type</span>
            <input value={draft.event_type} onChange={(e) => patch("event_type", e.target.value)} placeholder="task.assigned" />
          </label>
          <label className="field"><span>Channel</span>
            <select value={draft.channel} onChange={(e) => patch("channel", e.target.value)}>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>Locale</span>
            <input value={draft.locale} onChange={(e) => patch("locale", e.target.value)} />
          </label>
        </div>
        <label className="field"><span>Description</span>
          <input value={draft.description} onChange={(e) => patch("description", e.target.value)} />
        </label>
        <label className="field"><span>Subject</span>
          <input value={draft.subject} onChange={(e) => patch("subject", e.target.value)} placeholder="Task {{task.name}} assigned" />
        </label>
        <label className="field"><span>HTML body</span>
          <textarea rows={6} value={draft.html_body} onChange={(e) => patch("html_body", e.target.value)} />
        </label>
        <label className="field"><span>Text body</span>
          <textarea rows={3} value={draft.text_body} onChange={(e) => patch("text_body", e.target.value)} />
        </label>

        <div className="panel" style={{ background: "#10192f" }}>
          <h3>Variable reference</h3>
          <p className="sub">Use <code>{"{{root.path}}"}</code> placeholders. Allowed roots:</p>
          <div className="chips">
            {(variables.roots || []).map((root) => <span className="chip" key={root}>{root}</span>)}
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="muted">Sample context</summary>
            <pre className="notif-pre">{JSON.stringify(variables.sample_context, null, 2)}</pre>
          </details>
        </div>

        <div className="inline" style={{ marginTop: 8 }}>
          <button className="btn" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          <button className="btn secondary" type="button" onClick={runPreview} disabled={!selected}>Preview</button>
          {selected ? (
            <button className="btn ghost" type="button" onClick={toggleStatus}>
              {selected.status === "active" ? "Deactivate" : "Activate"}
            </button>
          ) : null}
          {selected && !selected.is_system ? (
            <button className="btn danger" type="button" onClick={remove}>Delete</button>
          ) : null}
        </div>

        {preview ? (
          <div className="panel" style={{ marginTop: 14, background: "#10192f" }}>
            <h3>Preview</h3>
            <div className="notif-preview-subject">{preview.rendered?.subject}</div>
            <div className="notif-drawer-body" dangerouslySetInnerHTML={{ __html: preview.rendered?.html || "" }} />
            <details style={{ marginTop: 8 }}>
              <summary className="muted">Text</summary>
              <pre className="notif-pre">{preview.rendered?.text}</pre>
            </details>
          </div>
        ) : null}

        {selected ? (
          <div className="panel" style={{ marginTop: 14, background: "#10192f" }}>
            <h3>Send test notification</h3>
            <div className="row">
              <label className="field grow"><span>Recipient username or id</span>
                <input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </label>
              <button className="btn secondary" type="button" disabled={busy} onClick={testSend}>Send test</button>
            </div>
          </div>
        ) : null}

        {versions.length ? (
          <div style={{ marginTop: 14 }}>
            <h3>Version history</h3>
            <table>
              <thead><tr><th>Version</th><th>Subject</th><th>Changed by</th><th>When</th></tr></thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.version}>
                    <td>v{version.version}</td>
                    <td>{version.subject || "—"}</td>
                    <td>{version.changed_by ?? "system"}</td>
                    <td className="mono">{version.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
