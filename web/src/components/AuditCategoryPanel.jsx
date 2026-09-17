import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";
import AuditTimeline from "./AuditTimeline.jsx";
import AuditEventDrawer from "./AuditEventDrawer.jsx";

const LOADERS = {
  security: (qs) => audit.security(qs),
  workflow: (qs) => audit.workflow(qs),
  lifecycle: (qs) => audit.lifecycle(qs),
  configuration: (qs) => audit.configuration(qs),
};

const EMPTY = { q: "", status: "", from: "", to: "" };

export default function AuditCategoryPanel({ kind, hint }) {
  const [filters, setFilters] = useState(EMPTY);
  const [draft, setDraft] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pageSize: 25 });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (targetPage) => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ page: String(targetPage), pageSize: "25" });
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      try {
        setData(await LOADERS[kind](`?${params.toString()}`));
      } catch (err) {
        setError(err.message);
        setData({ items: [], total: 0, pageSize: 25 });
      } finally {
        setLoading(false);
      }
    },
    [kind, filters]
  );

  useEffect(() => {
    load(page);
  }, [page, load]);

  async function open(event) {
    setSelected(event);
    setDetail(null);
    try {
      setDetail(await audit.event(event.id));
    } catch {
      setDetail(event);
    }
  }

  function apply(e) {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  }

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 25)));

  return (
    <div className="audit-category">
      {hint ? <p className="muted" style={{ marginTop: 0 }}>{hint}</p> : null}
      <form className="panel" onSubmit={apply}>
        <div className="row">
          <label className="field grow">
            <span>Search</span>
            <input
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              placeholder="actor, object, action, reason…"
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="">Any</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
              <option value="denied">denied</option>
            </select>
          </label>
          <label className="field">
            <span>From</span>
            <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
          <button className="btn" type="submit">Apply</button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setFilters(EMPTY);
              setPage(1);
            }}
          >
            Reset
          </button>
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}

      <div className="panel">
        {loading && !data.items.length ? <div className="audit-empty">Loading events…</div> : null}
        <AuditTimeline events={data.items} selectedId={selected?.id} onSelect={open} />
        {data.total > data.pageSize ? (
          <div className="pager">
            <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>Page {page} of {totalPages} · {data.total} events</span>
            <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        ) : (
          <div className="pager"><span>{data.total} events</span></div>
        )}
      </div>

      {selected ? <AuditEventDrawer event={detail || selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
