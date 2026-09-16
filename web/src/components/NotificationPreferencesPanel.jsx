import React, { useEffect, useState } from "react";
import { notifications } from "../api.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function rowsFromEventPreferences(prefs = {}) {
  return Object.entries(prefs).map(([event_type, value]) => ({
    event_type,
    in_app: value?.in_app !== false,
    email: value?.email !== false,
  }));
}

export default function NotificationPreferencesPanel({ meta }) {
  const [prefs, setPrefs] = useState(null);
  const [eventRows, setEventRows] = useState([]);
  const [quiet, setQuiet] = useState({ enabled: false, start: "18:00", end: "08:00", days: [] });
  const [mandatory, setMandatory] = useState([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    notifications.preferences()
      .then((res) => {
        setPrefs(res);
        setEventRows(rowsFromEventPreferences(res.event_preferences));
        const qh = res.quiet_hours || {};
        setQuiet({
          enabled: qh.enabled ?? Boolean(qh.start || qh.end),
          start: qh.start || "18:00",
          end: qh.end || "08:00",
          days: Array.isArray(qh.days) ? qh.days : [],
        });
      })
      .catch((err) => setError(err.message));
    notifications.mandatoryEvents().then((res) => setMandatory(res.items || [])).catch(() => {});
  }, []);

  function patch(key, value) {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    setSaved("");
  }

  function patchRow(index, key, value) {
    setEventRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }

  function addRow() {
    setEventRows((prev) => [...prev, { event_type: "", in_app: true, email: true }]);
  }

  function removeRow(index) {
    setEventRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const event_preferences = {};
      for (const row of eventRows) {
        if (!row.event_type.trim()) continue;
        event_preferences[row.event_type.trim()] = { in_app: row.in_app, email: row.email };
      }
      const payload = {
        in_app: prefs.in_app,
        email: prefs.email,
        frequency: prefs.frequency,
        language: prefs.language,
        reminders: prefs.reminders,
        escalations: prefs.escalations,
        self_notify: prefs.self_notify,
        quiet_hours: quiet.enabled
          ? { start: quiet.start, end: quiet.end, days: quiet.days }
          : {},
        event_preferences,
      };
      const res = await notifications.updatePreferences(payload);
      setPrefs(res);
      setEventRows(rowsFromEventPreferences(res.event_preferences));
      setSaved("Preferences saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!prefs) return <div className="panel">{error ? <div className="error">{error}</div> : "Loading preferences…"}</div>;

  return (
    <div className="split">
      <div className="panel">
        <h3>Delivery preferences</h3>
        <p className="sub">Choose how the platform reaches you. Mandatory notifications ignore opt-outs.</p>
        <label className="notif-check">
          <input type="checkbox" checked={prefs.in_app} onChange={(e) => patch("in_app", e.target.checked)} />
          <span>In-app inbox</span>
        </label>
        <label className="notif-check">
          <input type="checkbox" checked={prefs.email} onChange={(e) => patch("email", e.target.checked)} />
          <span>Email</span>
        </label>
        <label className="notif-check">
          <input type="checkbox" checked={prefs.reminders} onChange={(e) => patch("reminders", e.target.checked)} />
          <span>Allow reminders</span>
        </label>
        <label className="notif-check">
          <input type="checkbox" checked={prefs.escalations} onChange={(e) => patch("escalations", e.target.checked)} />
          <span>Allow escalations</span>
        </label>
        <label className="notif-check">
          <input type="checkbox" checked={prefs.self_notify} onChange={(e) => patch("self_notify", e.target.checked)} />
          <span>Notify me about my own actions</span>
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <label className="field grow"><span>Frequency</span>
            <select value={prefs.frequency} onChange={(e) => patch("frequency", e.target.value)}>
              {(meta?.frequencies || ["immediate", "daily", "weekly", "off"]).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="field grow"><span>Language</span>
            <input value={prefs.language} onChange={(e) => patch("language", e.target.value)} />
          </label>
        </div>

        <h3 style={{ marginTop: 18 }}>Quiet hours (email)</h3>
        <label className="notif-check">
          <input type="checkbox" checked={quiet.enabled} onChange={(e) => setQuiet({ ...quiet, enabled: e.target.checked })} />
          <span>Pause email during quiet hours</span>
        </label>
        <div className="row">
          <label className="field"><span>From</span>
            <input type="time" value={quiet.start} disabled={!quiet.enabled} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} />
          </label>
          <label className="field"><span>To</span>
            <input type="time" value={quiet.end} disabled={!quiet.enabled} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
          </label>
        </div>
        <div className="chips">
          {DAYS.map((day) => (
            <button
              type="button"
              key={day}
              className={`chip ${quiet.days.includes(day) ? "chip-on" : ""}`}
              disabled={!quiet.enabled}
              onClick={() =>
                setQuiet({
                  ...quiet,
                  days: quiet.days.includes(day) ? quiet.days.filter((d) => d !== day) : [...quiet.days, day],
                })
              }
            >
              {day}
            </button>
          ))}
          {!quiet.days.length ? <span className="muted">Applies every day when none selected</span> : null}
        </div>

        {error ? <div className="error">{error}</div> : null}
        {saved ? <div className="valid" style={{ marginTop: 10 }}>{saved}</div> : null}
        <button className="btn" type="button" style={{ marginTop: 14 }} disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save preferences"}
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Per-event overrides</h3>
          <button className="btn ghost" type="button" onClick={addRow}>Add override</button>
        </div>
        {mandatory.length ? (
          <>
            <p className="sub" style={{ marginTop: 4 }}>Mandatory event types always deliver regardless of these settings:</p>
            <div className="chips">
              {mandatory.map((type) => <span className="chip" key={type}>{type}</span>)}
            </div>
          </>
        ) : null}
        <table>
          <thead>
            <tr><th>Event type</th><th>In-app</th><th>Email</th><th /></tr>
          </thead>
          <tbody>
            {eventRows.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    value={row.event_type}
                    placeholder="task.assigned"
                    onChange={(e) => patchRow(index, "event_type", e.target.value)}
                  />
                </td>
                <td><input type="checkbox" checked={row.in_app} onChange={(e) => patchRow(index, "in_app", e.target.checked)} /></td>
                <td><input type="checkbox" checked={row.email} onChange={(e) => patchRow(index, "email", e.target.checked)} /></td>
                <td><button className="btn ghost" type="button" onClick={() => removeRow(index)}>Remove</button></td>
              </tr>
            ))}
            {!eventRows.length ? (
              <tr><td colSpan={4} className="muted">No per-event overrides.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
