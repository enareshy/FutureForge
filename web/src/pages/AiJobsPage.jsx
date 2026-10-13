import React, { useCallback, useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

const STATUSES = ["", "queued", "running", "succeeded", "failed"];

export default function AiJobsPage() {
  const [jobs, setJobs] = useState([]);
  const [meta, setMeta] = useState({ total: 0, limit: 20, offset: 0 });
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(null);
  const limit = 20;

  const load = useCallback(() => {
    setError("");
    setLoading(true);
    ai.jobs({ status: statusFilter || undefined, limit, offset })
      .then((page) => {
        setJobs(page.items);
        setMeta(page.meta);
      })
      .catch((e) => setError(describe(e)))
      .finally(() => setLoading(false));
  }, [statusFilter, offset]);

  useEffect(load, [load]);

  async function retry(job) {
    setError("");
    setNote("");
    setRetrying(job.id);
    try {
      const updated = await ai.retryJob(job.id);
      setNote(`Job #${job.id} ${updated.status}.`);
      load();
    } catch (e) {
      setError(describe(e));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Indexing job monitor</h1>
          <p className="sub">Background ingestion/indexing jobs for this tenant.</p>
        </div>
        <button className="btn secondary" onClick={load}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {note ? <div className="notice">{note}</div> : null}

      <div className="panel">
        <div className="row">
          <label className="field">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setOffset(0);
              }}
            >
              {STATUSES.map((s) => (
                <option key={s || "all"} value={s}>{s || "All"}</option>
              ))}
            </select>
          </label>
          <button className="btn secondary" onClick={load}>Apply</button>
        </div>

        <table>
          <thead>
            <tr><th>Job</th><th>Type</th><th>Stage</th><th>Source</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Error</th><th>Created</th><th>Finished</th><th></th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="mono">#{j.id}</td>
                <td>{j.type}</td>
                <td>{j.stage || "—"}</td>
                <td>{j.source_id ?? "—"}</td>
                <td><span className="badge">{j.status}</span></td>
                <td>{(j.progress * 100).toFixed(0)}%</td>
                <td>{j.attempts}{j.max_attempts ? ` / ${j.max_attempts}` : ""}</td>
                <td>{j.error_class ? <span className="badge">{j.error_class}</span> : "—"}</td>
                <td>{new Date(j.created_at).toLocaleString()}</td>
                <td>{j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}</td>
                <td>
                  {j.status === "failed" || j.status === "queued" ? (
                    <button
                      className="btn ghost"
                      disabled={retrying === j.id}
                      onClick={() => retry(j)}
                    >
                      {retrying === j.id ? "Retrying…" : "Retry"}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  {loading ? "Loading jobs…" : "No jobs found."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="pager">
          <span>{meta.total} jobs</span>
          <button className="btn ghost" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>
          <button className="btn ghost" disabled={offset + limit >= meta.total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>
      </div>
    </>
  );
}
