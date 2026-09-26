import React, { useCallback, useEffect, useState } from "react";
import { delivery } from "../api.js";

export default function DeliveryOverviewPanel({ scope, onProcess }) {
  const [metrics, setMetrics] = useState(null);
  const [providerHealth, setProviderHealth] = useState(null);
  const [alerts, setAlerts] = useState({ items: [], open: 0 });
  const [series, setSeries] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, health, alertList, ts] = await Promise.all([
        delivery.metrics(scope),
        delivery.providerHealth(scope),
        delivery.alerts(`?${scope}pageSize=20`),
        delivery.timeseries(scope),
      ]);
      setMetrics(m);
      setProviderHealth(health);
      setAlerts(alertList);
      setSeries(ts.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  async function processQueue() {
    setBusy(true);
    setNotice("");
    try {
      const res = await delivery.process(200);
      setNotice(`Processed ${res.processed ?? 0}; sent ${res.sent ?? 0}; retried ${res.retried ?? 0}; failed ${res.failed ?? 0}.`);
      await load();
      onProcess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(id) {
    try {
      await delivery.acknowledgeAlert(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const cards = [
    ["Total", metrics?.total ?? 0],
    ["Queued", metrics?.queued ?? 0],
    ["Sent", metrics?.sent ?? 0],
    ["Failed", metrics?.failed ?? 0],
    ["Dead letter", metrics?.dead_lettered ?? 0],
    ["Retrying", metrics?.retrying ?? 0],
    ["Attempts", metrics?.attempts ?? 0],
    ["Avg delivery (ms)", metrics?.avg_delivery_ms ?? 0],
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Operational overview</h3>
        <button className="btn secondary" type="button" disabled={busy} onClick={processQueue}>
          {busy ? "Processing…" : "Process queue"}
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="grid" style={{ marginBottom: 12 }}>
        {cards.map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="muted">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>

      <div className="grid" style={{ marginBottom: 12 }}>
        <div className="stat"><span className="muted">Provider availability</span><b>{providerHealth?.availability ?? 0}%</b></div>
        <div className="stat"><span className="muted">Providers available</span><b>{providerHealth?.available ?? 0} / {providerHealth?.total ?? 0}</b></div>
        <div className="stat"><span className="muted">Open alerts</span><b>{alerts.open ?? 0}</b></div>
        <div className="stat"><span className="muted">Avg queue (s)</span><b>{metrics?.avg_queue_seconds ?? 0}</b></div>
      </div>

      <h3>Throughput (last days)</h3>
      <table>
        <thead><tr><th>Day</th><th>Total</th><th>Sent</th><th>Failed</th></tr></thead>
        <tbody>
          {series.map((row) => (
            <tr key={row.day}>
              <td className="mono">{row.day}</td>
              <td>{row.total}</td>
              <td>{row.sent}</td>
              <td>{row.failed}</td>
            </tr>
          ))}
          {!series.length ? <tr><td colSpan={4} className="muted">No delivery history yet.</td></tr> : null}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Provider health</h3>
      <table>
        <thead><tr><th>Provider</th><th>Channel</th><th>Status</th><th>Failures</th><th>Last test</th></tr></thead>
        <tbody>
          {(providerHealth?.items || []).map((row) => (
            <tr key={row.id}>
              <td>{row.name} <span className="mono muted">{row.code}</span></td>
              <td>{row.channel}</td>
              <td><span className={`badge ${row.available ? "active" : "locked"}`}>{row.status}</span></td>
              <td>{row.failures}</td>
              <td className="mono">{row.last_tested_at || "—"}</td>
            </tr>
          ))}
          {!providerHealth?.items?.length ? <tr><td colSpan={5} className="muted">No providers configured.</td></tr> : null}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Recent alerts</h3>
      <table>
        <thead><tr><th>Severity</th><th>Type</th><th>Message</th><th>Status</th><th /></tr></thead>
        <tbody>
          {alerts.items.map((row) => (
            <tr key={row.id}>
              <td><span className={`badge ${row.severity === "critical" ? "locked" : ""}`}>{row.severity}</span></td>
              <td className="mono">{row.type}</td>
              <td className="muted">{row.message}</td>
              <td>{row.status}</td>
              <td>
                {row.status === "open" ? (
                  <button className="btn ghost" type="button" onClick={() => acknowledge(row.id)}>Acknowledge</button>
                ) : null}
              </td>
            </tr>
          ))}
          {!alerts.items.length ? <tr><td colSpan={5} className="muted">No alerts. All providers healthy.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
