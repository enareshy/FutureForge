import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { jobExecution } from "../api.js";
import { DeadLetterStatusBadge, formatDateTime } from "../components/JobEngineBadges.jsx";

export default function JobDeadLetterPage() {
  const navigate = useNavigate();
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState({ status: "open", category: "", queue: "" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [allTenants, setAllTenants] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const scope = allTenants ? "all=true&" : "";

  useEffect(() => { jobExecution.meta().then(setMeta).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      setList(await jobExecution.deadLetters(`?${scope}${params.toString()}`));
    } catch (err) {
      setError(err.message);
    }
  }, [filters, page, pageSize, scope]);

  useEffect(() => { load(); }, [load]);

  async function act(fn, message) {
    setNotice("");
    setError("");
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const totalPages = Math.max(1, Math.ceil((list.total || 0) / pageSize));

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Dead-letter management</h1>
          <div className="sub">Jobs that exhausted retries or failed permanently. Requeue them or record a resolution.</div>
        </div>
        <label className="notif-check">
          <input type="checkbox" checked={allTenants} onChange={(e) => { setAllTenants(e.target.checked); setPage(1); }} />
          <span>All tenants</span>
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field"><span>Status</span>
          <select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}>
            <option value="">Any</option>
            {(meta?.dead_letter_statuses || ["open", "requeued", "discarded"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field"><span>Category</span>
          <select value={filters.category} onChange={(e) => { setFilters({ ...filters, category: e.target.value }); setPage(1); }}>
            <option value="">Any</option>
            {(meta?.error_categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>Queue</span>
          <input value={filters.queue} onChange={(e) => { setFilters({ ...filters, queue: e.target.value }); setPage(1); }} />
        </label>
        <label className="field grow"><span>Resolution note</span>
          <input value={note} placeholder="optional note recorded with the action" onChange={(e) => setNote(e.target.value)} />
        </label>
        <button className="btn" type="button" onClick={load}>Apply</button>
      </div>

      <table>
        <thead>
          <tr><th>Job</th><th>Category</th><th>Reason</th><th>Queue</th><th>Attempts</th><th>Status</th><th>Recorded</th><th /></tr>
        </thead>
        <tbody>
          {(list.items || []).map((letter) => (
            <tr key={letter.id}>
              <td>
                <div>{letter.job_type_code || "job"}</div>
                <div className="mono">{letter.job_ref || `#${letter.job_id}`}</div>
              </td>
              <td className="mono">{letter.category}</td>
              <td className="muted">{letter.reason || letter.error_message || "—"}</td>
              <td className="mono">{letter.queue}</td>
              <td>{letter.attempts}</td>
              <td><DeadLetterStatusBadge status={letter.status} /></td>
              <td className="mono">{formatDateTime(letter.created_at)}</td>
              <td className="inline">
                <button className="btn ghost" type="button" onClick={() => navigate(`/jobs/${letter.job_id}`)}>View job</button>
                {letter.status === "open" ? (
                  <>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => act(() => jobExecution.retryDeadLetter(letter.id, { note }), `Requeued ${letter.job_ref || letter.id}.`)}
                    >
                      Retry
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => act(() => jobExecution.discardDeadLetter(letter.id, { note }), `Discarded dead letter ${letter.id}.`)}
                    >
                      Discard
                    </button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
          {!list.items?.length ? <tr><td colSpan={8} className="muted">No dead letters match the current filters.</td></tr> : null}
        </tbody>
      </table>

      <div className="pager">
        <span>{list.total || 0} entries · page {list.page || page} of {totalPages}</span>
        <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
        <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </>
  );
}
