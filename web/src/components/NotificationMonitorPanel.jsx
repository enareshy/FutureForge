import React, { useCallback, useEffect, useState } from "react";
import { notifications } from "../api.js";

const SUB_TABS = [
  ["history", "History"],
  ["deliveries", "Deliveries"],
  ["reminders", "Reminders"],
  ["events", "Events"],
];

const EMPTY_EVENT = {
  event_type: "",
  source_module: "platform",
  object_type: "",
  object_id: "",
  object_name: "",
  payload: "{}",
};

export default function NotificationMonitorPanel({ meta }) {
  const [tab, setTab] = useState("history");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [allTenants, setAllTenants] = useState(false);

  const [history, setHistory] = useState({ items: [], total: 0, by_status: [] });
  const [historyFilters, setHistoryFilters] = useState({ q: "", status: "", channel: "" });

  const [stats, setStats] = useState(null);
  const [deliveries, setDeliveries] = useState({ items: [], total: 0 });
  const [reminders, setReminders] = useState({ items: [], total: 0 });
  const [events, setEvents] = useState({ items: [], total: 0 });
  const [eventDraft, setEventDraft] = useState(EMPTY_EVENT);

  const scope = allTenants ? "all=true&" : "";

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(historyFilters)) if (value) params.set(key, value);
      const res = await notifications.history(`?${scope}${params.toString()}`);
      setHistory(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFilters, allTenants]);

  const loadTab = useCallback(async () => {
    setError("");
    try {
      if (tab === "deliveries") {
        const [s, list] = await Promise.all([
          notifications.deliveryStats(`?${scope}`),
          notifications.deliveries(`?${scope}pageSize=50`),
        ]);
        setStats(s);
        setDeliveries(list);
      } else if (tab === "reminders") {
        setReminders(await notifications.reminders(`?${scope}pageSize=50`));
      } else if (tab === "events") {
        setEvents(await notifications.events(`?${scope}pageSize=50`));
      } else {
        await loadHistory();
      }
    } catch (err) {
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, allTenants]);

  useEffect(() => { loadTab(); }, [loadTab]);

  async function processQueue() {
    setNotice("");
    try {
      const res = await notifications.processDeliveries(100);
      setNotice(`Processed ${res.processed ?? 0}; sent ${res.sent ?? 0}; failed ${res.failed ?? 0}.`);
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  async function retry(id) {
    try {
      await notifications.retryDelivery(id);
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  async function sweep() {
    setNotice("");
    try {
      const res = await notifications.sweepReminders(100);
      setNotice(`Swept reminders: fired ${res.fired ?? 0}; escalated ${res.escalated ?? 0}; skipped ${res.skipped ?? 0}.`);
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  async function publish() {
    setNotice("");
    try {
      const payload = JSON.parse(eventDraft.payload || "{}");
      const res = await notifications.publishEvent({
        event_type: eventDraft.event_type,
        source_module: eventDraft.source_module,
        object_type: eventDraft.object_type,
        object_id: eventDraft.object_id,
        object_name: eventDraft.object_name,
        payload,
      });
      setNotice(`Event published with ${res.notification_count ?? 0} notification(s).`);
      setEventDraft(EMPTY_EVENT);
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  function eventPatch(key, value) {
    setEventDraft((prev) => ({ ...prev, [key]: value }));
  }

  const channels = meta?.channels || [];
  const statuses = meta?.statuses || [];

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Delivery monitor</h3>
        <div className="inline">
          <label className="notif-check">
            <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
            <span>All tenants (platform admin)</span>
          </label>
        </div>
      </div>

      <div className="tabs">
        {SUB_TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      {tab === "history" ? (
        <>
          <div className="row">
            <label className="field grow"><span>Search</span>
              <input value={historyFilters.q} onChange={(e) => setHistoryFilters({ ...historyFilters, q: e.target.value })} />
            </label>
            <label className="field"><span>Status</span>
              <select value={historyFilters.status} onChange={(e) => setHistoryFilters({ ...historyFilters, status: e.target.value })}>
                <option value="">Any</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Channel</span>
              <select value={historyFilters.channel} onChange={(e) => setHistoryFilters({ ...historyFilters, channel: e.target.value })}>
                <option value="">Any</option>
                {channels.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button className="btn" type="button" onClick={loadHistory}>Apply</button>
          </div>
          <div className="chips" style={{ marginBottom: 10 }}>
            {(history.by_status || []).map((row) => <span className="chip" key={row.status}>{row.status}: {row.count}</span>)}
          </div>
          <table>
            <thead><tr><th>Subject</th><th>Recipient</th><th>Event</th><th>Channel</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {history.items.map((row) => (
                <tr key={row.id}>
                  <td>{row.subject || "—"}</td>
                  <td>{row.recipient_username || row.recipient_id}</td>
                  <td className="mono">{row.event_type || "—"}</td>
                  <td>{row.channel}</td>
                  <td><span className={`badge ${row.status === "failed" || row.status === "dead_letter" ? "locked" : row.read ? "active" : ""}`}>{row.status}</span></td>
                  <td className="mono">{row.created_at}</td>
                </tr>
              ))}
              {!history.items.length && !loading ? <tr><td colSpan={6} className="muted">No notifications.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}

      {tab === "deliveries" ? (
        <>
          <div className="grid" style={{ marginBottom: 12 }}>
            <div className="stat"><span className="muted">Total</span><b>{stats?.total ?? 0}</b></div>
            <div className="stat"><span className="muted">Queued</span><b>{stats?.queued ?? 0}</b></div>
            <div className="stat"><span className="muted">Sent</span><b>{stats?.sent ?? 0}</b></div>
            <div className="stat"><span className="muted">Failed</span><b>{stats?.failed ?? 0}</b></div>
            <div className="stat"><span className="muted">Dead letter</span><b>{stats?.dead_letter ?? 0}</b></div>
          </div>
          <button className="btn secondary" type="button" onClick={processQueue} style={{ marginBottom: 10 }}>Process queue</button>
          <table>
            <thead><tr><th>Notification</th><th>Channel</th><th>Provider</th><th>Status</th><th>Attempts</th><th>Error</th><th /></tr></thead>
            <tbody>
              {deliveries.items.map((row) => (
                <tr key={row.id}>
                  <td>#{row.notification_id} {row.subject || ""}</td>
                  <td>{row.channel}</td>
                  <td className="mono">{row.provider_code || "—"}</td>
                  <td><span className={`badge ${row.dead_letter ? "locked" : ""}`}>{row.status}</span></td>
                  <td>{row.attempt}/{row.max_attempts}</td>
                  <td className="muted">{row.error || ""}</td>
                  <td>
                    {row.dead_letter || row.status === "failed" ? (
                      <button className="btn ghost" type="button" onClick={() => retry(row.id)}>Retry</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!deliveries.items.length ? <tr><td colSpan={7} className="muted">No deliveries.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}

      {tab === "reminders" ? (
        <>
          <button className="btn secondary" type="button" onClick={sweep} style={{ marginBottom: 10 }}>Sweep due reminders</button>
          <table>
            <thead><tr><th>Recipient</th><th>Level</th><th>Status</th><th>Due</th><th>Fired</th><th>Attempts</th></tr></thead>
            <tbody>
              {reminders.items.map((row) => (
                <tr key={row.id}>
                  <td>{row.recipient_username || row.recipient_id}</td>
                  <td>{row.level}</td>
                  <td><span className={`badge ${row.status === "pending" ? "" : "active"}`}>{row.status}</span></td>
                  <td className="mono">{row.due_at}</td>
                  <td className="mono">{row.fired_at || "—"}</td>
                  <td>{row.attempts}</td>
                </tr>
              ))}
              {!reminders.items.length ? <tr><td colSpan={6} className="muted">No reminders.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}

      {tab === "events" ? (
        <>
          <div className="panel" style={{ background: "#10192f" }}>
            <h3>Publish event</h3>
            <div className="row">
              <label className="field grow"><span>Event type</span>
                <input value={eventDraft.event_type} onChange={(e) => eventPatch("event_type", e.target.value)} placeholder="task.assigned" />
              </label>
              <label className="field grow"><span>Source module</span>
                <input value={eventDraft.source_module} onChange={(e) => eventPatch("source_module", e.target.value)} />
              </label>
              <label className="field grow"><span>Object type</span>
                <input value={eventDraft.object_type} onChange={(e) => eventPatch("object_type", e.target.value)} placeholder="part" />
              </label>
              <label className="field grow"><span>Object id</span>
                <input value={eventDraft.object_id} onChange={(e) => eventPatch("object_id", e.target.value)} />
              </label>
            </div>
            <label className="field"><span>Object name</span>
              <input value={eventDraft.object_name} onChange={(e) => eventPatch("object_name", e.target.value)} />
            </label>
            <label className="field"><span>Payload (JSON)</span>
              <textarea rows={4} value={eventDraft.payload} onChange={(e) => eventPatch("payload", e.target.value)} />
            </label>
            <button className="btn" type="button" onClick={publish}>Publish</button>
          </div>
          <table>
            <thead><tr><th>Event type</th><th>Source</th><th>Object</th><th>Rules</th><th>Notifications</th><th>Status</th><th>Occurred</th></tr></thead>
            <tbody>
              {events.items.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.event_type}</td>
                  <td>{row.source_module}</td>
                  <td>{row.object_type}{row.object_id ? ` · ${row.object_id}` : ""}</td>
                  <td>{row.rule_count}</td>
                  <td>{row.notification_count}</td>
                  <td><span className={`badge ${row.status === "failed" ? "locked" : ""}`}>{row.status}</span></td>
                  <td className="mono">{row.occurred_at}</td>
                </tr>
              ))}
              {!events.items.length ? <tr><td colSpan={7} className="muted">No events.</td></tr> : null}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
