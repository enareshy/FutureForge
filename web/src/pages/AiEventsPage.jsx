import React, { useCallback, useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

export default function AiEventsPage() {
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [deadLetters, setDeadLetters] = useState([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError("");
    setLoading(true);
    Promise.allSettled([ai.events({ limit: 50 }), ai.eventStats(), ai.deadLetters({ limit: 50 })])
      .then(([eventsRes, statsRes, deadRes]) => {
        if (eventsRes.status === "fulfilled") setEvents(eventsRes.value);
        else setError(describe(eventsRes.reason));
        if (statsRes.status === "fulfilled") setStats(statsRes.value);
        if (deadRes.status === "fulfilled") setDeadLetters(deadRes.value);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function replay(eventId) {
    setNote("");
    try {
      const res = await ai.replayEvent(eventId);
      setNote(res.replayed ? `Re-queued ${eventId}.` : `${eventId} could not be replayed.`);
      load();
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Events &amp; observability</h1>
          <p className="sub">
            Durable event log with per-consumer delivery tracking, dead letters and replay.
          </p>
        </div>
        <button className="btn secondary" onClick={load}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {note ? <div className="notice">{note}</div> : null}

      {stats ? (
        <div className="grid">
          <div className="stat">Consumer group<b>{stats.consumer_group}</b></div>
          <div className="stat">Pending<b>{stats.pending}</b></div>
          <div className="stat">Delivered<b>{stats.delivered}</b></div>
          <div className="stat">Failed<b>{stats.failed}</b></div>
          <div className="stat">Dead<b>{stats.dead}</b></div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head"><h3>Recent events</h3></div>
        <table>
          <thead>
            <tr><th>When</th><th>Type</th><th>v</th><th>Tenant</th><th>Subject</th><th>Correlation</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event_id}>
                <td>{new Date(e.occurred_at).toLocaleString()}</td>
                <td className="mono">{e.type}</td>
                <td>{e.version}</td>
                <td>{e.tenant_id}</td>
                <td>{e.subject_type ? `${e.subject_type}${e.subject_id ? `:${e.subject_id}` : ""}` : "—"}</td>
                <td className="mono">{e.correlation_id || "—"}</td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr><td colSpan={6} className="muted">{loading ? "Loading events…" : "No events recorded."}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Dead letters</h3></div>
        <table>
          <thead>
            <tr><th>Event</th><th>Consumer group</th><th>Attempts</th><th>Last error</th><th></th></tr>
          </thead>
          <tbody>
            {deadLetters.map((d) => (
              <tr key={`${d.event_id}-${d.consumer_group}`}>
                <td className="mono">{d.event_id}</td>
                <td>{d.consumer_group}</td>
                <td>{d.attempts}</td>
                <td>{d.last_error || "—"}</td>
                <td>
                  <button className="btn ghost" onClick={() => replay(d.event_id)}>Replay</button>
                </td>
              </tr>
            ))}
            {deadLetters.length === 0 ? (
              <tr><td colSpan={5} className="muted">{loading ? "Loading dead letters…" : "No dead letters."}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
