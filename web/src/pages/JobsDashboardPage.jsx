import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { jobs } from "../api.js";
import { JobStatusBadge, JobProgress, formatDuration } from "../components/JobStatusBadge.jsx";

export default function JobsDashboardPage() {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState(null);
  const [series, setSeries] = useState([]);
  const [active, setActive] = useState([]);
  const [allTenants, setAllTenants] = useState(false);
  const [error, setError] = useState("");

  const scope = allTenants ? "all=true&" : "";

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, ts, list] = await Promise.all([
        jobs.metrics(`?${scope}`),
        jobs.timeseries(`?${scope}days=14`),
        jobs.list(`?${scope}active=true&pageSize=8&sort=created_at&order=desc`),
      ]);
      setMetrics(m);
      setSeries(ts.items || []);
      setActive(list.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const cards = [
    ["Total jobs", metrics?.total ?? 0],
    ["Active", metrics?.active ?? 0],
    ["Finished", metrics?.finished ?? 0],
    ["Success rate", metrics?.success_rate === null || metrics?.success_rate === undefined ? "—" : `${metrics.success_rate}%`],
    ["Retries", metrics?.retries ?? 0],
    ["Avg duration", formatDuration(metrics?.avg_duration_seconds)],
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Job dashboard</h1>
          <div className="sub">Centralized monitoring for asynchronous work across the platform.</div>
        </div>
        <label className="notif-check">
          <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
          <span>All tenants</span>
        </label>
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

      <div className="panel">
        <div className="panel-head"><h3>Status breakdown</h3></div>
        <div className="chips">
          {(metrics?.by_status || []).map((entry) => (
            <span className="chip" key={entry.status}>
              <JobStatusBadge status={entry.status} label={entry.status_label} /> <b>{entry.count}</b>
            </span>
          ))}
          {!metrics?.by_status?.length ? <span className="muted">No jobs recorded yet.</span> : null}
        </div>
      </div>

      <div className="split" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>Queue depth</h3></div>
          <table>
            <thead><tr><th>Queue</th><th>Depth</th></tr></thead>
            <tbody>
              {(metrics?.queue_depth || []).map((row) => (
                <tr key={row.queue}><td className="mono">{row.queue}</td><td>{row.depth}</td></tr>
              ))}
              {!metrics?.queue_depth?.length ? <tr><td colSpan={2} className="muted">No queued or running jobs.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>By type</h3></div>
          <table>
            <thead><tr><th>Type</th><th>Total</th><th>Completed</th><th>Failed</th></tr></thead>
            <tbody>
              {(metrics?.by_type || []).map((row) => (
                <tr key={row.type}>
                  <td className="mono">{row.type}</td>
                  <td>{row.total}</td>
                  <td>{row.completed}</td>
                  <td>{row.failed}</td>
                </tr>
              ))}
              {!metrics?.by_type?.length ? <tr><td colSpan={4} className="muted">No jobs yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <h3>Active jobs</h3>
          <button className="btn ghost" type="button" onClick={() => navigate("/jobs/list")}>Open job list</button>
        </div>
        <table>
          <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Progress</th><th>Stage</th><th>Created</th></tr></thead>
          <tbody>
            {active.map((job) => (
              <tr key={job.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${job.id}`)}>
                <td>
                  <div>{job.name}</div>
                  <div className="mono">{job.job_ref}</div>
                </td>
                <td className="mono">{job.job_type_code}</td>
                <td><JobStatusBadge status={job.status} label={job.status_label} /></td>
                <td>
                  <div className="job-progress-cell">
                    <JobProgress value={job.progress} status={job.status} />
                    <span className="mono">{job.progress}%</span>
                  </div>
                </td>
                <td className="muted">{job.stage || "—"}</td>
                <td className="mono">{job.created_at}</td>
              </tr>
            ))}
            {!active.length ? <tr><td colSpan={6} className="muted">No active jobs.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="split" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>Throughput (14 days)</h3></div>
          <table>
            <thead><tr><th>Day</th><th>Total</th><th>Completed</th><th>Failed</th></tr></thead>
            <tbody>
              {series.map((row) => (
                <tr key={row.day}><td className="mono">{row.day}</td><td>{row.total}</td><td>{row.completed}</td><td>{row.failed}</td></tr>
              ))}
              {!series.length ? <tr><td colSpan={4} className="muted">No job history yet.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Recent failures</h3></div>
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Error</th><th /></tr></thead>
            <tbody>
              {(metrics?.recent_failures || []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <div>{row.name}</div>
                    <div className="mono">{row.job_ref}</div>
                  </td>
                  <td><JobStatusBadge status={row.status} label={row.status_label} /></td>
                  <td className="muted">{row.error_code || row.error_message || "—"}</td>
                  <td><button className="btn ghost" type="button" onClick={() => navigate(`/jobs/${row.id}`)}>View</button></td>
                </tr>
              ))}
              {!metrics?.recent_failures?.length ? <tr><td colSpan={4} className="muted">No failures. All clear.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
