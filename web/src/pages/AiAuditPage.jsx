import React, { useCallback, useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

export default function AiAuditPage() {
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState({ total: 0, limit: 50, offset: 0 });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const limit = 50;

  const load = useCallback(() => {
    setError("");
    setLoading(true);
    ai.audit({ limit, offset })
      .then((page) => {
        setEvents(page.items);
        setMeta(page.meta);
      })
      .catch((e) => setError(describe(e)))
      .finally(() => setLoading(false));
  }, [offset]);

  useEffect(load, [load]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>AI audit log</h1>
          <p className="sub">Platform audit trail for AI operations, scoped to your tenant.</p>
        </div>
        <button className="btn secondary" onClick={load}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="panel">
        <table>
          <thead>
            <tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Request</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.actor_id ?? "—"}</td>
                <td className="mono">{e.action}</td>
                <td>{e.resource_type ? `${e.resource_type}${e.resource_id ? `:${e.resource_id}` : ""}` : "—"}</td>
                <td><span className={`badge ${e.outcome === "success" ? "active" : ""}`}>{e.outcome}</span></td>
                <td className="mono">{e.request_id || "—"}</td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr><td colSpan={6} className="muted">{loading ? "Loading audit events…" : "No audit events."}</td></tr>
            ) : null}
          </tbody>
        </table>
        <div className="pager">
          <span>{meta.total} events</span>
          <button className="btn ghost" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>
          <button className="btn ghost" disabled={offset + limit >= meta.total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>
      </div>
    </>
  );
}
