import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

export default function AiUsagePage() {
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState({ items: [], meta: { total: 0, limit: 50, offset: 0 } });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const limit = 50;

  useEffect(() => {
    ai.usage().then(setSummary).catch((e) => setError(describe(e)));
  }, []);

  useEffect(() => {
    setLoading(true);
    ai
      .usageRecords({ limit, offset })
      .then(setRecords)
      .catch((e) => setError(describe(e)))
      .finally(() => setLoading(false));
  }, [offset]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Usage &amp; cost</h1>
          <p className="sub">Token and request quantities recorded per tenant, with cost metadata.</p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {summary ? (
        <div className="grid">
          <div className="stat">Quantity<b>{summary.quantity}</b></div>
          <div className="stat">Total cost<b>{summary.total_cost} {summary.currency}</b></div>
        </div>
      ) : null}

      {summary?.by_kind?.length ? (
        <div className="panel">
          <div className="panel-head"><h3>By kind</h3></div>
          <table>
            <thead>
              <tr><th>Kind</th><th>Quantity</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {summary.by_kind.map((k) => (
                <tr key={k.kind}>
                  <td className="mono">{k.kind}</td>
                  <td>{k.quantity}</td>
                  <td>{k.total_cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head"><h3>Records</h3></div>
        <table>
          <thead>
            <tr><th>When</th><th>Kind</th><th>Provider</th><th>Model</th><th>Quantity</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {records.items.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td className="mono">{r.kind}</td>
                <td>{r.provider_code || "—"}</td>
                <td>{r.model_code || "—"}</td>
                <td>{r.quantity} {r.unit}</td>
                <td>{r.total_cost ?? "—"} {r.currency}</td>
              </tr>
            ))}
            {records.items.length === 0 ? (
              <tr><td colSpan={6} className="muted">{loading ? "Loading usage…" : "No usage recorded yet."}</td></tr>
            ) : null}
          </tbody>
        </table>
        <div className="pager">
          <span>{records.meta.total} records</span>
          <button
            className="btn ghost"
            disabled={offset <= 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Prev
          </button>
          <button
            className="btn ghost"
            disabled={offset + limit >= records.meta.total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
