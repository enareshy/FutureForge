import React, { useCallback, useEffect, useState } from "react";
import { notifications } from "../api.js";

const EMPTY = {
  code: "",
  name: "",
  description: "",
  event_type: "",
  source_module: "",
  priority: "normal",
  delivery_mode: "immediate",
  delay_minutes: 0,
  channels: ["in_app"],
  template_code: "",
  condition_json: "{}",
  recipient_json: '{\n  "items": [{ "type": "initiator" }],\n  "include_initiator": true\n}',
  reminder_json: "{}",
  escalation_json: "{}",
  mandatory: false,
  status: "active",
};

function toDraft(rule) {
  return {
    ...EMPTY,
    ...rule,
    condition_json: JSON.stringify(rule.condition ?? {}, null, 2),
    recipient_json: JSON.stringify(rule.recipient ?? {}, null, 2),
    reminder_json: JSON.stringify(rule.reminder ?? {}, null, 2),
    escalation_json: JSON.stringify(rule.escalation ?? {}, null, 2),
  };
}

export default function NotificationRulePanel({ meta }) {
  const [items, setItems] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [simulation, setSimulation] = useState(null);
  const [simulatePayload, setSimulatePayload] = useState('{\n  "task": { "id": 1, "name": "Approve bracket" },\n  "object": { "type": "part", "id": "PART-1", "name": "Bracket" }\n}');
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await notifications.rules();
      setItems(res.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    notifications.templates().then((res) => setTemplates(res.items || [])).catch(() => {});
  }, []);

  function edit(rule) {
    setSelected(rule);
    setDraft(toDraft(rule));
    setSimulation(null);
    setNotice("");
  }

  function createNew() {
    setSelected(null);
    setDraft(EMPTY);
    setSimulation(null);
    setNotice("");
  }

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function toggleChannel(channel) {
    setDraft((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  }

  function parseJson(value, label) {
    try {
      return JSON.parse(value || "{}");
    } catch {
      throw new Error(`${label} must be valid JSON`);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        code: draft.code,
        name: draft.name,
        description: draft.description,
        event_type: draft.event_type,
        source_module: draft.source_module,
        priority: draft.priority,
        delivery_mode: draft.delivery_mode,
        delay_minutes: Number(draft.delay_minutes) || 0,
        channels: draft.channels,
        template_code: draft.template_code,
        condition: parseJson(draft.condition_json, "Condition"),
        recipient: parseJson(draft.recipient_json, "Recipient"),
        reminder: parseJson(draft.reminder_json, "Reminder"),
        escalation: parseJson(draft.escalation_json, "Escalation"),
        mandatory: draft.mandatory,
        status: draft.status,
      };
      const res = selected
        ? await notifications.updateRule(selected.id, payload)
        : await notifications.createRule(payload);
      setNotice(`Rule ${res.code} saved.`);
      setSelected(res);
      setDraft(toDraft(res));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    if (!selected) return;
    try {
      const res = await notifications.setRuleStatus(selected.id, selected.status === "active" ? "inactive" : "active");
      setSelected(res);
      setDraft(toDraft(res));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete rule "${selected.code}"?`)) return;
    try {
      await notifications.deleteRule(selected.id);
      createNew();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function simulate() {
    if (!selected) {
      setError("Save the rule before simulating.");
      return;
    }
    setBusy(true);
    setError("");
    setSimulation(null);
    try {
      const payload = parseJson(simulatePayload, "Simulation payload");
      setSimulation(await notifications.simulateRule(selected.id, { payload }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const channels = meta?.channels || ["in_app", "email"];
  const priorities = meta?.priorities || ["low", "normal", "high", "urgent"];
  const deliveryModes = ["immediate", "delayed", "digest"];

  return (
    <div className="type-manager">
      <div className="panel">
        <div className="panel-head">
          <h3>Rules</h3>
          <button className="btn ghost" type="button" onClick={createNew}>New</button>
        </div>
        <div className="type-list">
          {items.map((rule) => (
            <div key={rule.id} className={`type-row ${selected?.id === rule.id ? "active" : ""}`}>
              <button type="button" className="type-row-main" onClick={() => edit(rule)}>
                <span className="type-name">{rule.name}</span>
                <span className="type-sub mono">{rule.event_type} · {rule.channels.join(", ")}</span>
              </button>
              <span className={`badge ${rule.status}`}>{rule.status}</span>
            </div>
          ))}
          {!items.length ? <div className="muted" style={{ padding: 10 }}>No rules found.</div> : null}
        </div>
      </div>

      <div className="panel type-detail-panel">
        <div className="panel-head">
          <h3>{selected ? `Edit ${selected.code}` : "New rule"}</h3>
          <div className="inline">
            {selected?.mandatory ? <span className="badge inactive">mandatory</span> : null}
            {selected?.is_system ? <span className="badge">system</span> : null}
          </div>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="valid">{notice}</div> : null}

        <div className="row">
          <label className="field grow"><span>Code</span>
            <input value={draft.code} onChange={(e) => patch("code", e.target.value)} placeholder="notify-task-assignee" />
          </label>
          <label className="field grow"><span>Name</span>
            <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field grow"><span>Event type</span>
            <input value={draft.event_type} onChange={(e) => patch("event_type", e.target.value)} placeholder="task.assigned or *" />
          </label>
          <label className="field grow"><span>Source module</span>
            <input value={draft.source_module} onChange={(e) => patch("source_module", e.target.value)} placeholder="workflow" />
          </label>
          <label className="field grow"><span>Template code</span>
            <input value={draft.template_code} onChange={(e) => patch("template_code", e.target.value)} list="notif-template-codes" />
            <datalist id="notif-template-codes">
              {templates.map((t) => <option key={t.id} value={t.code}>{t.channel}</option>)}
            </datalist>
          </label>
        </div>
        <div className="row">
          <label className="field"><span>Priority</span>
            <select value={draft.priority} onChange={(e) => patch("priority", e.target.value)}>
              {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="field"><span>Delivery mode</span>
            <select value={draft.delivery_mode} onChange={(e) => patch("delivery_mode", e.target.value)}>
              {deliveryModes.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field"><span>Delay (minutes)</span>
            <input type="number" min="0" value={draft.delay_minutes} onChange={(e) => patch("delay_minutes", e.target.value)} />
          </label>
          <label className="field"><span>Status</span>
            <select value={draft.status} onChange={(e) => patch("status", e.target.value)}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
        </div>

        <div className="field">
          <span>Channels</span>
          <div className="chips">
            {channels.map((channel) => (
              <button
                key={channel}
                type="button"
                className={`chip ${draft.channels.includes(channel) ? "chip-on" : ""}`}
                onClick={() => toggleChannel(channel)}
              >
                {channel}
              </button>
            ))}
          </div>
        </div>

        <label className="notif-check">
          <input type="checkbox" checked={draft.mandatory} onChange={(e) => patch("mandatory", e.target.checked)} />
          <span>Mandatory (ignore user opt-outs)</span>
        </label>

        <div className="split" style={{ marginTop: 10 }}>
          <label className="field"><span>Condition (JSON)</span>
            <textarea rows={5} value={draft.condition_json} onChange={(e) => patch("condition_json", e.target.value)} />
          </label>
          <label className="field"><span>Recipient definition (JSON)</span>
            <textarea rows={5} value={draft.recipient_json} onChange={(e) => patch("recipient_json", e.target.value)} />
          </label>
        </div>
        <div className="split">
          <label className="field"><span>Reminder (JSON)</span>
            <textarea rows={4} value={draft.reminder_json} onChange={(e) => patch("reminder_json", e.target.value)} />
          </label>
          <label className="field"><span>Escalation (JSON)</span>
            <textarea rows={4} value={draft.escalation_json} onChange={(e) => patch("escalation_json", e.target.value)} />
          </label>
        </div>

        <div className="inline">
          <button className="btn" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          {selected ? (
            <button className="btn ghost" type="button" onClick={toggleStatus}>
              {selected.status === "active" ? "Deactivate" : "Activate"}
            </button>
          ) : null}
          {selected && !selected.is_system ? (
            <button className="btn danger" type="button" onClick={remove}>Delete</button>
          ) : null}
        </div>

        {selected ? (
          <div className="panel" style={{ marginTop: 14, background: "#10192f" }}>
            <h3>Simulate</h3>
            <p className="sub">Evaluate this rule against a sample event payload without publishing to other rules.</p>
            <label className="field"><span>Event payload (JSON)</span>
              <textarea rows={5} value={simulatePayload} onChange={(e) => setSimulatePayload(e.target.value)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy} onClick={simulate}>Run simulation</button>
            {simulation ? (
              <div style={{ marginTop: 10 }}>
                <div className="chips">
                  <span className="chip">created: {simulation.created}</span>
                  <span className="chip">skipped: {simulation.skipped?.length || 0}</span>
                </div>
                <pre className="notif-pre">{JSON.stringify(simulation.notifications, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
