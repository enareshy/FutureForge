import React, { useCallback, useEffect, useState } from "react";
import { delivery } from "../api.js";

const REMINDER_EMPTY = { recipient_id: "", kind: "due", due_in_minutes: 0, repeat_minutes: 0, max_repeats: 0, subject: "", channel: "in_app", body: "" };
const ESCALATION_EMPTY = { object_type: "", object_id: "", object_name: "", after_minutes: 0, max_level: 3, subject: "", channel: "in_app" };

export default function DeliverySchedulePanel({ meta, scope }) {
  const [tab, setTab] = useState("reminders");
  const [reminders, setReminders] = useState({ items: [], total: 0 });
  const [escalations, setEscalations] = useState({ items: [], total: 0 });
  const [runs, setRuns] = useState([]);
  const [reminderDraft, setReminderDraft] = useState(REMINDER_EMPTY);
  const [escalationDraft, setEscalationDraft] = useState(ESCALATION_EMPTY);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [r, e, runList] = await Promise.all([
        delivery.reminders(`?${scope}pageSize=50`),
        delivery.escalations(`?${scope}pageSize=50`),
        delivery.runs(`?limit=25`),
      ]);
      setReminders(r);
      setEscalations(e);
      setRuns(runList.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  async function sweep() {
    setNotice("");
    try {
      const [r, e] = await Promise.all([delivery.sweepReminders(200), delivery.sweepEscalations(200)]);
      setNotice(`Reminders: fired ${r.fired ?? 0}, escalated ${r.escalated ?? 0}. Escalations: fired ${e.escalated ?? 0}.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createReminder() {
    setNotice("");
    try {
      const res = await delivery.createReminder({
        recipient_id: reminderDraft.recipient_id ? Number(reminderDraft.recipient_id) : null,
        kind: reminderDraft.kind,
        delay_minutes: Number(reminderDraft.due_in_minutes) || 0,
        repeat_minutes: Number(reminderDraft.repeat_minutes) || 0,
        max_repeats: Number(reminderDraft.max_repeats) || 0,
        details: { subject: reminderDraft.subject, channel: reminderDraft.channel, body: reminderDraft.body },
      });
      setNotice(`Reminder #${res.id} scheduled.`);
      setReminderDraft(REMINDER_EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createEscalation() {
    setNotice("");
    try {
      const res = await delivery.createEscalation({
        object_type: escalationDraft.object_type,
        object_id: escalationDraft.object_id,
        object_name: escalationDraft.object_name,
        level: 1,
        max_level: Number(escalationDraft.max_level) || 3,
        after_minutes: Number(escalationDraft.after_minutes) || 0,
        recipient: reminderDraft.recipient_id ? { items: [{ type: "user", id: Number(reminderDraft.recipient_id) }] } : { items: [{ type: "manager" }] },
        details: { subject: escalationDraft.subject, channel: escalationDraft.channel },
      });
      setNotice(`Escalation #${res.id} scheduled.`);
      setEscalationDraft(ESCALATION_EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelReminder(id) {
    try { await delivery.cancelReminder(id); await load(); } catch (err) { setError(err.message); }
  }

  async function cancelEscalation(id) {
    try { await delivery.cancelEscalation(id); await load(); } catch (err) { setError(err.message); }
  }

  const kinds = meta?.reminder_kinds || ["due", "overdue", "repeat"];
  const channels = meta?.channels || ["in_app", "email"];

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Reminders & escalations</h3>
        <button className="btn secondary" type="button" onClick={sweep}>Sweep due schedules</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="tabs">
        <button type="button" className={`tab ${tab === "reminders" ? "active" : ""}`} onClick={() => setTab("reminders")}>Reminders</button>
        <button type="button" className={`tab ${tab === "escalations" ? "active" : ""}`} onClick={() => setTab("escalations")}>Escalations</button>
        <button type="button" className={`tab ${tab === "runs" ? "active" : ""}`} onClick={() => setTab("runs")}>Execution history</button>
      </div>

      {tab === "reminders" ? (
        <>
          <div className="panel" style={{ background: "#10192f" }}>
            <h3>Schedule a reminder</h3>
            <div className="row">
              <label className="field"><span>Recipient id</span>
                <input type="number" value={reminderDraft.recipient_id} onChange={(e) => setReminderDraft({ ...reminderDraft, recipient_id: e.target.value })} />
              </label>
              <label className="field"><span>Kind</span>
                <select value={reminderDraft.kind} onChange={(e) => setReminderDraft({ ...reminderDraft, kind: e.target.value })}>
                  {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="field"><span>Channel</span>
                <select value={reminderDraft.channel} onChange={(e) => setReminderDraft({ ...reminderDraft, channel: e.target.value })}>
                  {channels.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="field"><span>Due in (min)</span>
                <input type="number" value={reminderDraft.due_in_minutes} onChange={(e) => setReminderDraft({ ...reminderDraft, due_in_minutes: e.target.value })} />
              </label>
              <label className="field"><span>Repeat every (min)</span>
                <input type="number" value={reminderDraft.repeat_minutes} onChange={(e) => setReminderDraft({ ...reminderDraft, repeat_minutes: e.target.value })} />
              </label>
              <label className="field"><span>Max repeats</span>
                <input type="number" value={reminderDraft.max_repeats} onChange={(e) => setReminderDraft({ ...reminderDraft, max_repeats: e.target.value })} />
              </label>
              <label className="field grow"><span>Subject</span>
                <input value={reminderDraft.subject} onChange={(e) => setReminderDraft({ ...reminderDraft, subject: e.target.value })} />
              </label>
            </div>
            <button className="btn" type="button" onClick={createReminder}>Schedule reminder</button>
          </div>

          <table style={{ marginTop: 12 }}>
            <thead><tr><th>ID</th><th>Recipient</th><th>Kind</th><th>Next execution</th><th>Repeats</th><th>Status</th><th>Last error</th><th /></tr></thead>
            <tbody>
              {reminders.items.map((row) => (
                <tr key={row.id}>
                  <td className="mono">#{row.id}</td>
                  <td>{row.recipient_id || "—"}</td>
                  <td>{row.kind}</td>
                  <td className="mono">{row.next_execution || "—"}</td>
                  <td>{row.repeat_count}/{row.max_repeats}</td>
                  <td><span className={`badge ${row.status === "pending" ? "" : "active"}`}>{row.status}</span></td>
                  <td className="muted">{row.last_error || ""}</td>
                  <td>{row.status === "pending" ? <button className="btn ghost" type="button" onClick={() => cancelReminder(row.id)}>Cancel</button> : null}</td>
                </tr>
              ))}
              {!reminders.items.length ? <tr><td colSpan={8} className="muted">No reminders scheduled.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}

      {tab === "escalations" ? (
        <>
          <div className="panel" style={{ background: "#10192f" }}>
            <h3>Schedule an escalation</h3>
            <div className="row">
              <label className="field grow"><span>Object type</span>
                <input value={escalationDraft.object_type} onChange={(e) => setEscalationDraft({ ...escalationDraft, object_type: e.target.value })} placeholder="change" />
              </label>
              <label className="field grow"><span>Object id</span>
                <input value={escalationDraft.object_id} onChange={(e) => setEscalationDraft({ ...escalationDraft, object_id: e.target.value })} />
              </label>
              <label className="field grow"><span>Object name</span>
                <input value={escalationDraft.object_name} onChange={(e) => setEscalationDraft({ ...escalationDraft, object_name: e.target.value })} />
              </label>
              <label className="field"><span>After (min)</span>
                <input type="number" value={escalationDraft.after_minutes} onChange={(e) => setEscalationDraft({ ...escalationDraft, after_minutes: e.target.value })} />
              </label>
              <label className="field"><span>Max level</span>
                <input type="number" value={escalationDraft.max_level} onChange={(e) => setEscalationDraft({ ...escalationDraft, max_level: e.target.value })} />
              </label>
              <label className="field grow"><span>Subject</span>
                <input value={escalationDraft.subject} onChange={(e) => setEscalationDraft({ ...escalationDraft, subject: e.target.value })} />
              </label>
            </div>
            <p className="sub">Recipient definition defaults to the object manager; set a reminder recipient id in the Reminders tab to target a specific user.</p>
            <button className="btn" type="button" onClick={createEscalation}>Schedule escalation</button>
          </div>

          <table style={{ marginTop: 12 }}>
            <thead><tr><th>ID</th><th>Object</th><th>Level</th><th>Due</th><th>Status</th><th>Last error</th><th /></tr></thead>
            <tbody>
              {escalations.items.map((row) => (
                <tr key={row.id}>
                  <td className="mono">#{row.id}</td>
                  <td>{row.object_type}{row.object_id ? ` · ${row.object_id}` : ""}</td>
                  <td>{row.level}/{row.max_level}</td>
                  <td className="mono">{row.due_at || "—"}</td>
                  <td><span className={`badge ${row.status === "pending" ? "" : "active"}`}>{row.status}</span></td>
                  <td className="muted">{row.last_error || ""}</td>
                  <td>{row.status === "pending" ? <button className="btn ghost" type="button" onClick={() => cancelEscalation(row.id)}>Cancel</button> : null}</td>
                </tr>
              ))}
              {!escalations.items.length ? <tr><td colSpan={7} className="muted">No escalations scheduled.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}

      {tab === "runs" ? (
        <table>
          <thead><tr><th>Kind</th><th>Source</th><th>Level</th><th>Status</th><th>Request</th><th>Detail</th><th>When</th></tr></thead>
          <tbody>
            {runs.map((row) => (
              <tr key={row.id}>
                <td>{row.kind}</td>
                <td className="mono">{row.reminder_id ? `reminder #${row.reminder_id}` : row.escalation_id ? `escalation #${row.escalation_id}` : "—"}</td>
                <td>{row.level}</td>
                <td>{row.status}</td>
                <td className="mono">{row.request_id ? `#${row.request_id}` : "—"}</td>
                <td className="muted">{row.detail}</td>
                <td className="mono">{row.ran_at}</td>
              </tr>
            ))}
            {!runs.length ? <tr><td colSpan={7} className="muted">No executions recorded.</td></tr> : null}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
