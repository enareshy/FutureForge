import React, { useCallback, useEffect, useState } from "react";
import { jobExecution } from "../api.js";
import { WorkerStatusBadge, formatDateTime } from "../components/JobEngineBadges.jsx";

export default function JobWorkersPage() {
  const [data, setData] = useState({ items: [], total: 0, summary: null });
  const [status, setStatus] = useState("");
  const [cluster, setCluster] = useState(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const [workers, engine] = await Promise.all([
        jobExecution.workers(`?${params.toString()}`),
        jobExecution.status(),
      ]);
      setData(workers);
      setCluster(engine);
    } catch (err) {
      setError(err.message);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const summary = data.summary || {};
  const cards = [
    ["Workers", summary.total ?? 0],
    ["Online", summary.online ?? 0],
    ["Busy", summary.busy ?? 0],
    ["Idle", summary.idle ?? 0],
    ["Capacity", summary.capacity ?? 0],
    ["Active jobs", summary.active_jobs ?? 0],
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Worker monitoring</h1>
          <div className="sub">Registered execution workers, their heartbeat, capacity and processed volume.</div>
        </div>
        <div className="inline">
          <label className="notif-check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Auto refresh</span>
          </label>
          <button className="btn ghost" type="button" onClick={load}>Refresh</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="grid" style={{ marginBottom: 14 }}>
        {cards.map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="muted">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head">
          <h3>Engine status</h3>
          <span className="muted mono">
            running {cluster?.running_jobs ?? 0} · queued {cluster?.queued_jobs ?? 0} · dead-letter {cluster?.open_dead_letters ?? 0}
          </span>
        </div>
        <div className="chips">
          {(cluster?.queues || []).map((code) => <span className="chip mono" key={code}>{code}</span>)}
          {!cluster?.queues?.length ? <span className="muted">No queues.</span> : null}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {["starting", "idle", "busy", "draining", "offline", "stopped"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button className="btn" type="button" onClick={load}>Apply</button>
      </div>

      <table>
        <thead>
          <tr><th>Worker</th><th>Status</th><th>Host</th><th>Concurrency</th><th>Active</th><th>Utilization</th><th>Processed</th><th>Failed</th><th>Last heartbeat</th><th>Queues</th></tr>
        </thead>
        <tbody>
          {(data.items || []).map((worker) => (
            <tr key={worker.id}>
              <td>
                <div>{worker.name}</div>
                <div className="mono">{worker.id}</div>
              </td>
              <td><WorkerStatusBadge status={worker.status} /></td>
              <td className="mono">{worker.hostname || "—"}{worker.pid ? `:${worker.pid}` : ""}</td>
              <td>{worker.concurrency}</td>
              <td>{worker.active_jobs}</td>
              <td>{worker.utilization}%</td>
              <td>{worker.processed_total}</td>
              <td>{worker.failed_total}</td>
              <td className="mono">{formatDateTime(worker.last_heartbeat)}{worker.heartbeat_age_seconds !== null ? ` (${worker.heartbeat_age_seconds}s)` : ""}</td>
              <td className="mono">{(worker.queues || []).join(", ") || "—"}</td>
            </tr>
          ))}
          {!data.items?.length ? <tr><td colSpan={10} className="muted">No workers registered. Start an engine worker to process jobs.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}
