import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { jobExecution } from "../api.js";
import { QueueStatusBadge, formatDateTime } from "../components/JobEngineBadges.jsx";

export default function JobExecutionPage() {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState(null);
  const [audit, setAudit] = useState([]);
  const [allTenants, setAllTenants] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const scope = allTenants ? "all=true&" : "";

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, a] = await Promise.all([
        jobExecution.metrics(`?${scope}`),
        jobExecution.audit(`?${scope}limit=25`),
      ]);
      setMetrics(m);
      setAudit(a.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  async function act(fn, message) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const totals = metrics?.totals || {};
  const throughput = metrics?.throughput || {};
  const performance = metrics?.performance || {};
  const cards = [
    ["Active", totals.active ?? 0],
    ["Running", totals.running ?? 0],
    ["Queued", totals.queued ?? 0],
    ["Waiting on deps", totals.waiting_for_dependency ?? 0],
    ["Completed (24h)", throughput.completed_last_day ?? 0],
    ["Failed (24h)", throughput.failed_last_day ?? 0],
    ["Failure rate", `${throughput.failure_rate ?? 0}%`],
    ["Avg duration", `${performance.average_duration_ms ?? 0} ms`],
    ["Utilization", `${performance.utilization ?? 0}%`],
    ["Dead letters", totals.open_dead_letters ?? 0],
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Execution dashboard</h1>
          <div className="sub">Live throughput, queue saturation, retries and dead-letter pressure for the execution engine.</div>
        </div>
        <div className="inline">
          <label className="notif-check">
            <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
            <span>All tenants</span>
          </label>
          <button className="btn ghost" type="button" onClick={load}>Refresh</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="grid" style={{ marginBottom: 14 }}>
        {cards.map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="muted">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => act(() => jobExecution.tick({ run: true, limit: 10 }), "Engine ticked and ready work processed.")}
        >
          Run engine tick
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => act(() => jobExecution.maintenance(), "Maintenance sweep complete.")}
        >
          Run maintenance
        </button>
        <button className="btn ghost" type="button" onClick={() => navigate("/jobs/dead-letter")}>Open dead-letter queue</button>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Queues</h3></div>
        <table>
          <thead>
            <tr><th>Queue</th><th>Status</th><th>Priority</th><th>Running</th><th>Depth</th><th>Utilization</th><th>Oldest job</th><th>Timeout</th></tr>
          </thead>
          <tbody>
            {(metrics?.queues || []).map((queue) => (
              <tr key={queue.id}>
                <td className="mono">{queue.code}</td>
                <td><QueueStatusBadge queue={queue} /></td>
                <td>{queue.priority}</td>
                <td>{queue.running}/{queue.max_concurrency}</td>
                <td>{queue.depth}</td>
                <td>{queue.utilization}%</td>
                <td className="mono">{queue.oldest_job_age_seconds}s</td>
                <td className="mono">{queue.timeout_seconds}s</td>
              </tr>
            ))}
            {!metrics?.queues?.length ? <tr><td colSpan={8} className="muted">No queues.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="split" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>Recent engine audit</h3></div>
          <table>
            <thead><tr><th>When</th><th>Entity</th><th>Action</th><th>Actor</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{formatDateTime(entry.created_at)}</td>
                  <td><span className="mono">{entry.entity_type}</span> {entry.entity_code}</td>
                  <td>{entry.action}</td>
                  <td className="mono">{entry.actor_username || entry.actor_id || "system"}</td>
                </tr>
              ))}
              {!audit.length ? <tr><td colSpan={4} className="muted">No configuration changes recorded.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Dead letters by category</h3></div>
          <table>
            <thead><tr><th>Category</th><th>Open</th></tr></thead>
            <tbody>
              {(metrics?.dead_letters?.by_category || []).map((row) => (
                <tr key={row.category}><td className="mono">{row.category}</td><td>{row.c}</td></tr>
              ))}
              {!metrics?.dead_letters?.by_category?.length ? <tr><td colSpan={2} className="muted">No open dead letters.</td></tr> : null}
            </tbody>
          </table>
          <div className="chips" style={{ marginTop: 10 }}>
            <span className="chip">Workers online: {metrics?.workers?.online ?? 0}</span>
            <span className="chip">Busy: {metrics?.workers?.busy ?? 0}</span>
            <span className="chip">Schedules due: {metrics?.schedules?.due_active ?? 0}</span>
            <span className="chip">Retried (24h): {throughput.retried_last_day ?? 0}</span>
          </div>
        </div>
      </div>
    </>
  );
}
