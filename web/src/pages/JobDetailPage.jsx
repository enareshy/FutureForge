import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { jobs } from "../api.js";
import { JobStatusBadge, JobProgress } from "../components/JobStatusBadge.jsx";
import JobResultPanel from "../components/JobResultPanel.jsx";

const ACTIVE = ["created", "queued", "waiting_for_dependency", "scheduled", "running", "paused", "retrying", "cancel_requested"];
const RETRYABLE = ["failed", "timed_out", "cancelled", "skipped"];

export default function JobDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [deps, setDeps] = useState(null);
  const [children, setChildren] = useState([]);
  const [result, setResult] = useState(null);
  const [depInput, setDepInput] = useState("");
  const [depBusy, setDepBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [detail, hist, dependency, kids, res] = await Promise.all([
        jobs.get(id),
        jobs.history(id, "?pageSize=200&order=asc"),
        jobs.dependencies(id),
        jobs.children(id),
        jobs.result(id).catch(() => null),
      ]);
      setJob(detail);
      setHistory(hist.items || []);
      setDeps(dependency);
      setChildren(kids.items || []);
      setResult(res);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function act(fn, success) {
    setNotice("");
    setError("");
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addDependency() {
    if (!depInput.trim()) return;
    setDepBusy(true);
    try {
      await jobs.addDependency(job.id, { dependencies: [depInput.trim()] });
      setDepInput("");
      setNotice("Dependency added.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDepBusy(false);
    }
  }

  if (error && !job) return <div className="error">{error}</div>;
  if (!job) return <p className="mono">Loading job…</p>;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Job</div>
          <h1>{job.name}</h1>
          <div className="sub mono">{job.job_ref} · {job.job_type_code} · {job.source_module}</div>
        </div>
        <div className="job-detail-actions">
          <button className="btn ghost" type="button" onClick={() => navigate("/jobs/list")}>Back to list</button>
          {["queued", "running", "retrying", "scheduled"].includes(job.status) ? (
            <button className="btn ghost" type="button" onClick={() => act(() => jobs.pause(job.id, "Paused from detail"), "Job paused.")}>Pause</button>
          ) : null}
          {job.status === "paused" ? (
            <button className="btn ghost" type="button" onClick={() => act(() => jobs.resume(job.id), "Job resumed.")}>Resume</button>
          ) : null}
          {RETRYABLE.includes(job.status) ? (
            <button className="btn secondary" type="button" onClick={() => act(() => jobs.retry(job.id), "Job retried.")}>Retry</button>
          ) : null}
          {ACTIVE.includes(job.status) && job.status !== "cancel_requested" ? (
            <button className="btn danger" type="button" onClick={() => act(() => jobs.cancel(job.id, "Cancelled from detail"), "Cancellation requested.")}>Cancel</button>
          ) : null}
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="panel">
        <div className="chips" style={{ marginBottom: 12 }}>
          <span className="chip"><JobStatusBadge status={job.status} label={job.status_label} /></span>
          <span className="chip">priority: {job.priority}</span>
          <span className="chip">queue: {job.queue}</span>
          <span className="chip">submitted as: {job.submitted_as}</span>
          {job.worker_id ? <span className="chip">worker: {job.worker_id}</span> : null}
          {job.related_object_type ? <span className="chip">object: {job.related_object_type} {job.related_object_id}</span> : null}
          {job.correlation_id ? <span className="chip">correlation: {job.correlation_id}</span> : null}
          {job.idempotency_key ? <span className="chip">idempotency: {job.idempotency_key}</span> : null}
        </div>

        <div className="job-progress-cell" style={{ marginBottom: 10 }}>
          <JobProgress value={job.progress} status={job.status} />
          <span className="mono">{job.progress}%</span>
          {job.stage ? <span className="muted">{job.stage}</span> : null}
        </div>
        {job.message ? <div className="muted">{job.message}</div> : null}

        <table style={{ marginTop: 10 }}>
          <tbody>
            <tr><th style={{ width: 180 }}>Created</th><td className="mono">{job.created_at}</td><th style={{ width: 180 }}>Updated</th><td className="mono">{job.updated_at}</td></tr>
            <tr><th>Started</th><td className="mono">{job.started_at || "—"}</td><th>Completed</th><td className="mono">{job.completed_at || "—"}</td></tr>
            <tr><th>Scheduled</th><td className="mono">{job.scheduled_at || "—"}</td><th>Retries</th><td>{job.retry_count} / {job.max_retries}</td></tr>
            <tr><th>Description</th><td colSpan={3}>{job.description || "—"}</td></tr>
          </tbody>
        </table>

        {job.error_message ? <div className="error" style={{ marginTop: 12 }}>{job.error_code ? `${job.error_code}: ` : ""}{job.error_message}</div> : null}
      </div>

      <div className="split" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>Status timeline</h3></div>
          <ul className="job-timeline">
            {history.map((entry) => (
              <li key={entry.id}>
                <div className="job-timeline-head">
                  <span className="badge">{entry.event_type}</span>
                  {entry.from_status_label || entry.to_status_label ? (
                    <span className="mono">{entry.from_status_label || "—"} → {entry.to_status_label || "—"}</span>
                  ) : null}
                  {entry.progress !== null ? <span className="mono">{entry.progress}%</span> : null}
                  <span className="muted mono">{entry.created_at}</span>
                </div>
                {entry.message ? <div className="job-timeline-body">{entry.message}</div> : null}
                {entry.stage ? <div className="job-timeline-body">stage: {entry.stage}</div> : null}
              </li>
            ))}
            {!history.length ? <li className="muted">No history recorded.</li> : null}
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Dependencies</h3></div>
          <div className="chips" style={{ marginBottom: 10 }}>
            <span className="chip">total: {deps?.state?.total ?? 0}</span>
            <span className="chip">completed: {deps?.state?.completed ?? 0}</span>
            <span className="chip">pending: {deps?.state?.pending ?? 0}</span>
            <span className="chip">failed: {deps?.state?.failed ?? 0}</span>
          </div>

          <div className="mono" style={{ marginBottom: 4 }}>Depends on</div>
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Required</th><th /></tr></thead>
            <tbody>
              {(deps?.depends_on || []).map((entry) => (
                <tr key={entry.id}>
                  <td style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${entry.id}`)}>
                    <div>{entry.name}</div>
                    <div className="mono">{entry.job_ref}</div>
                  </td>
                  <td><JobStatusBadge status={entry.status} label={entry.status_label} /></td>
                  <td>{entry.required ? "yes" : "no"}</td>
                  <td>
                    <button className="btn ghost" type="button" onClick={() => act(() => jobs.removeDependency(job.id, entry.id), "Dependency removed.")}>Remove</button>
                  </td>
                </tr>
              ))}
              {!deps?.depends_on?.length ? <tr><td colSpan={4} className="muted">No dependencies.</td></tr> : null}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 10 }}>
            <label className="field grow"><span>Add dependency (job ID or ref)</span>
              <input value={depInput} onChange={(e) => setDepInput(e.target.value)} />
            </label>
            <button className="btn secondary" type="button" disabled={depBusy || !depInput.trim()} onClick={addDependency}>Add</button>
          </div>

          <div className="mono" style={{ margin: "14px 0 4px" }}>Dependents</div>
          <table>
            <thead><tr><th>Job</th><th>Status</th></tr></thead>
            <tbody>
              {(deps?.dependents || []).map((entry) => (
                <tr key={entry.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${entry.id}`)}>
                  <td>
                    <div>{entry.name}</div>
                    <div className="mono">{entry.job_ref}</div>
                  </td>
                  <td><JobStatusBadge status={entry.status} label={entry.status_label} /></td>
                </tr>
              ))}
              {!deps?.dependents?.length ? <tr><td colSpan={2} className="muted">No dependent jobs.</td></tr> : null}
            </tbody>
          </table>

          {children.length ? (
            <>
              <div className="mono" style={{ margin: "14px 0 4px" }}>Child jobs</div>
              <table>
                <thead><tr><th>Job</th><th>Status</th><th>Progress</th></tr></thead>
                <tbody>
                  {children.map((child) => (
                    <tr key={child.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${child.id}`)}>
                      <td>
                        <div>{child.name}</div>
                        <div className="mono">{child.job_ref}</div>
                      </td>
                      <td><JobStatusBadge status={child.status} label={child.status_label} /></td>
                      <td>{child.progress}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <JobResultPanel result={result} />
      </div>
    </>
  );
}
