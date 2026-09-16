import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { jobs } from "../api.js";
import { JobStatusBadge, JobProgress } from "../components/JobStatusBadge.jsx";

const ACTIVE = ["created", "queued", "waiting_for_dependency", "scheduled", "running", "paused", "retrying", "cancel_requested"];
const RETRYABLE = ["failed", "timed_out", "cancelled", "skipped"];

export default function JobsPage() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [types, setTypes] = useState([]);
  const [filters, setFilters] = useState({ q: "", status: "", type: "", priority: "", module: "", active: "" });
  const [sort, setSort] = useState({ sort: "created_at", order: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [allTenants, setAllTenants] = useState(false);
  const [draft, setDraft] = useState({ job_type_code: "", name: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const scope = allTenants ? "all=true&" : "";

  useEffect(() => {
    jobs.meta().then(setMeta).catch((err) => setError(err.message));
    jobs.types("?pageSize=100")
      .then((res) => {
        const active = (res.items || []).filter((type) => type.active);
        setTypes(active);
        setDraft((prev) => ({ ...prev, job_type_code: prev.job_type_code || active[0]?.code || "" }));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sort", sort.sort);
      params.set("order", sort.order);
      const res = await jobs.list(`?${scope}${params.toString()}`);
      setList(res);
    } catch (err) {
      setError(err.message);
    }
  }, [filters, page, pageSize, sort, scope]);

  useEffect(() => { load(); }, [load]);

  async function act(fn, success) {
    setNotice("");
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const created = await jobs.submit({ job_type_code: draft.job_type_code, name: draft.name || undefined, source_module: "jobs-console" });
      setNotice(`Submitted ${created.job_ref} (${created.status_label}).`);
      setDraft((prev) => ({ ...prev, name: "" }));
      navigate(`/jobs/${created.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const statuses = meta?.statuses || [];
  const priorities = meta?.priorities || [];
  const modules = [...new Set(list.items.map((job) => job.source_module))];
  const totalPages = Math.max(1, Math.ceil((list.total || 0) / pageSize));

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Jobs</h1>
          <div className="sub">Search, filter and control every asynchronous job in the platform.</div>
        </div>
        <label className="notif-check">
          <input type="checkbox" checked={allTenants} onChange={(e) => { setAllTenants(e.target.checked); setPage(1); }} />
          <span>All tenants</span>
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="panel" style={{ background: "#10192f" }}>
        <h3>Submit a job</h3>
        <div className="row">
          <label className="field grow"><span>Job type</span>
            <select value={draft.job_type_code} onChange={(e) => setDraft({ ...draft, job_type_code: e.target.value })}>
              {types.map((type) => <option key={type.code} value={type.code}>{type.code} — {type.name}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Name (optional)</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <button className="btn" type="button" disabled={busy || !draft.job_type_code} onClick={submit}>
            {busy ? "Submitting…" : "Submit job"}
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <label className="field grow"><span>Search</span>
          <input value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setPage(1); }} />
        </label>
        <label className="field"><span>Status</span>
          <select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}>
            <option value="">Any</option>
            {statuses.map((status) => <option key={status} value={status}>{status.toUpperCase()}</option>)}
          </select>
        </label>
        <label className="field"><span>Type</span>
          <select value={filters.type} onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}>
            <option value="">Any</option>
            {types.map((type) => <option key={type.code} value={type.code}>{type.code}</option>)}
          </select>
        </label>
        <label className="field"><span>Priority</span>
          <select value={filters.priority} onChange={(e) => { setFilters({ ...filters, priority: e.target.value }); setPage(1); }}>
            <option value="">Any</option>
            {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label className="field"><span>Active only</span>
          <select value={filters.active} onChange={(e) => { setFilters({ ...filters, active: e.target.value }); setPage(1); }}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Terminal</option>
          </select>
        </label>
        <label className="field"><span>Sort</span>
          <select value={sort.sort} onChange={(e) => setSort({ ...sort, sort: e.target.value })}>
            <option value="created_at">Created</option>
            <option value="updated_at">Updated</option>
            <option value="status">Status</option>
            <option value="priority">Priority</option>
            <option value="progress">Progress</option>
          </select>
        </label>
        <label className="field"><span>Order</span>
          <select value={sort.order} onChange={(e) => setSort({ ...sort, order: e.target.value })}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <button className="btn" type="button" onClick={load}>Apply</button>
      </div>

      <table>
        <thead>
          <tr><th>Job</th><th>Type</th><th>Status</th><th>Progress</th><th>Priority</th><th>Queue</th><th>Retries</th><th>Created</th><th /></tr>
        </thead>
        <tbody>
          {list.items.map((job) => (
            <tr key={job.id}>
              <td style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${job.id}`)}>
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
              <td>{job.priority}</td>
              <td className="mono">{job.queue}</td>
              <td>{job.retry_count}/{job.max_retries}</td>
              <td className="mono">{job.created_at}</td>
              <td className="inline">
                <button className="btn ghost" type="button" onClick={() => navigate(`/jobs/${job.id}`)}>View</button>
                {RETRYABLE.includes(job.status) ? (
                  <button className="btn ghost" type="button" onClick={() => act(() => jobs.retry(job.id), `Retried ${job.job_ref}.`)}>Retry</button>
                ) : null}
                {["queued", "running", "retrying", "scheduled"].includes(job.status) ? (
                  <button className="btn ghost" type="button" onClick={() => act(() => jobs.pause(job.id), `Paused ${job.job_ref}.`)}>Pause</button>
                ) : null}
                {job.status === "paused" ? (
                  <button className="btn ghost" type="button" onClick={() => act(() => jobs.resume(job.id), `Resumed ${job.job_ref}.`)}>Resume</button>
                ) : null}
                {ACTIVE.includes(job.status) && job.status !== "cancel_requested" ? (
                  <button className="btn ghost" type="button" onClick={() => act(() => jobs.cancel(job.id, "Cancelled from job list"), `Requested cancellation for ${job.job_ref}.`)}>Cancel</button>
                ) : null}
              </td>
            </tr>
          ))}
          {!list.items.length ? <tr><td colSpan={9} className="muted">No jobs match the current filters.</td></tr> : null}
        </tbody>
      </table>

      <div className="pager">
        <span>{(list.total || 0)} jobs · page {list.page || page} of {totalPages}</span>
        <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
        <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {modules.length ? <div className="mono" style={{ marginTop: 8 }}>Modules: {modules.join(", ")}</div> : null}
    </>
  );
}
