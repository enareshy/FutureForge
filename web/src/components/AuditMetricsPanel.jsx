import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

function Bars({ rows, labelKey, countKey = "count" }) {
  const max = Math.max(...rows.map((row) => row[countKey] || 0), 1);
  if (!rows.length) return <p className="muted">No data</p>;
  return (
    <div className="audit-bars">
      {rows.map((row) => (
        <div className="audit-bar" key={row[labelKey] || "none"} title={`${row[labelKey] || "none"}: ${row[countKey]}`}>
          <span style={{ height: `${Math.round(((row[countKey] || 0) / max) * 100)}%` }} />
          <i>{String(row[labelKey] || "none").slice(0, 8)}</i>
        </div>
      ))}
    </div>
  );
}

export default function AuditMetricsPanel() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setMetrics(await audit.metrics());
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (denied) {
    return <div className="audit-empty">You do not have permission to view audit metrics.</div>;
  }

  return (
    <div className="audit-metrics">
      {error ? <div className="error">{error}</div> : null}
      <div className="grid">
        <div className="stat"><span className="muted">Total events</span><b>{metrics?.total ?? "—"}</b></div>
        <div className="stat"><span className="muted">Sensitive events</span><b>{metrics?.sensitive ?? "—"}</b></div>
        <div className="stat"><span className="muted">Failures / denied</span><b>{metrics?.failed ?? "—"}</b></div>
        <div className="stat"><span className="muted">Login failures</span><b>{metrics?.login_failures ?? "—"}</b></div>
        <div className="stat"><span className="muted">Access denials</span><b>{metrics?.access_denials ?? "—"}</b></div>
        <div className="stat"><span className="muted">Export events</span><b>{metrics?.export_events ?? "—"}</b></div>
        <div className="stat"><span className="muted">Last 24h</span><b>{metrics?.growth?.last_24h ?? "—"}</b></div>
        <div className="stat"><span className="muted">Last 7d</span><b>{metrics?.growth?.last_7d ?? "—"}</b></div>
        <div className="stat"><span className="muted">Last 30d</span><b>{metrics?.growth?.last_30d ?? "—"}</b></div>
      </div>

      <div className="split" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3>Events by category</h3>
          <Bars rows={metrics?.by_category || []} labelKey="category" />
          <h3 style={{ marginTop: 16 }}>Events by actor type</h3>
          <Bars rows={metrics?.by_actor_type || []} labelKey="actor_type" />
        </div>
        <div className="panel">
          <h3>Storage &amp; retention</h3>
          <table>
            <tbody>
              <tr><td>Live events</td><td style={{ textAlign: "right" }}>{metrics?.archive?.live ?? "—"}</td></tr>
              <tr><td>Archived events</td><td style={{ textAlign: "right" }}>{metrics?.archive?.archived ?? "—"}</td></tr>
              <tr><td>Retention runs</td><td style={{ textAlign: "right" }}>{metrics?.retention_runs ?? "—"}</td></tr>
              <tr><td>Export requests</td><td style={{ textAlign: "right" }}>{metrics?.exports?.total ?? "—"}</td></tr>
              <tr><td>Completed exports</td><td style={{ textAlign: "right" }}>{metrics?.exports?.completed ?? "—"}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginBottom: 0 }}>
            Oldest: {metrics?.oldest || "—"} · Newest: {metrics?.newest || "—"}
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>Volume (last 30 days)</h3>
        <Bars rows={metrics?.by_day || []} labelKey="day" />
      </div>
    </div>
  );
}
