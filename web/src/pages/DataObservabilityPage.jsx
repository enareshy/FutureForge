import React, { useEffect, useState } from "react";
import { observability } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "health", label: "Health" },
  { key: "metrics", label: "Metrics" },
  { key: "freshness", label: "Freshness" },
  { key: "alerts", label: "Alerts" },
  { key: "incidents", label: "Incidents" },
  { key: "slo", label: "SLO / SLA" },
  { key: "dashboards", label: "Dashboards" },
  { key: "providers", label: "Providers" },
  { key: "runs", label: "Collection" },
  { key: "history", label: "History" },
  { key: "config", label: "Configuration" },
];

const HEALTH_TONES = {
  HEALTHY: "ok",
  WARNING: "warn",
  DEGRADED: "warn",
  CRITICAL: "danger",
  MAINTENANCE: "warn",
  UNKNOWN: undefined,
};

const SEVERITY_TONES = { INFO: undefined, WARNING: "warn", HIGH: "danger", CRITICAL: "danger" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["HEALTHY", "RESOLVED", "CLOSED", "COMPLIANT", "AVAILABLE", "COMPLETED", "ACTIVE", "FRESH", "OK"].includes(status)) return "ok";
  if (["WARNING", "DEGRADED", "MAINTENANCE", "OPEN", "ACKNOWLEDGED", "AT_RISK", "PARTIAL", "QUEUED", "RUNNING", "SUPPRESSED", "STALE"].includes(status)) return "warn";
  if (["CRITICAL", "BREACHED", "FAILED", "ERROR", "EXPIRED"].includes(status)) return "danger";
  return undefined;
}

function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

const emptyMetric = {
  code: "",
  name: "",
  provider_code: "OBJECT_MODEL",
  category: "DATA_VOLUME",
  calculation: "COUNT",
  unit: "COUNT",
  direction: "HIGHER_IS_WORSE",
  frequency_seconds: 300,
};

const emptyAlertRule = {
  code: "",
  name: "",
  metric_code: "",
  condition_operator: "GT",
  condition_value: 0,
  severity: "WARNING",
  cooldown_seconds: 300,
};

const emptyIncident = { title: "", severity: "HIGH", description: "", service_code: "" };

export default function DataObservabilityPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [overview, setOverview] = useState(null);
  const [health, setHealth] = useState(null);
  const [providers, setProviders] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [freshness, setFreshness] = useState(null);
  const [pipelines, setPipelines] = useState(null);
  const [failures, setFailures] = useState(null);
  const [runs, setRuns] = useState([]);
  const [alertRules, setAlertRules] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [alertSummary, setAlertSummary] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [sloSummary, setSloSummary] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [history, setHistory] = useState([]);
  const [config, setConfig] = useState({ config: {}, retention: [] });

  const [selectedMetric, setSelectedMetric] = useState("");
  const [metricHistory, setMetricHistory] = useState(null);
  const [metricForm, setMetricForm] = useState(emptyMetric);
  const [alertRuleForm, setAlertRuleForm] = useState(emptyAlertRule);
  const [incidentForm, setIncidentForm] = useState(emptyIncident);

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const output = await action();
      if (message) setNotice(message);
      return output;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setError("");
    try {
      const [met, ov, hl, provs, mets, fresh, pipes, fails, runList, rules, alertList, alertSum, incs, slo, dash, hist, cfg] = await Promise.all([
        observability.meta(),
        observability.overview(),
        observability.health(),
        observability.providers(),
        observability.metrics("?page_size=200"),
        observability.freshness(),
        observability.pipelines(),
        observability.failures(),
        observability.runs("?page_size=50"),
        observability.alertRules("?page_size=100"),
        observability.alerts("?page_size=50"),
        observability.alertSummary(),
        observability.incidents("?page_size=50"),
        observability.sloSummary(),
        observability.defaultDashboard(),
        observability.history("?page_size=50"),
        observability.config(),
      ]);
      setMeta(met);
      setOverview(ov);
      setHealth(hl);
      setProviders(provs.items || []);
      setMetrics(mets.items || []);
      setFreshness(fresh);
      setPipelines(pipes);
      setFailures(fails);
      setRuns(runList.items || []);
      setAlertRules(rules.items || []);
      setAlerts(alertList.items || []);
      setAlertSummary(alertSum);
      setIncidents(incs.items || []);
      setSloSummary(slo);
      setDashboard(dash);
      setHistory(hist.items || []);
      setConfig(cfg || { config: {}, retention: [] });
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function collect(trigger = "UI") {
    await run(() => observability.collect({ trigger }), "Collection completed.");
    await refresh();
  }

  async function evaluateFreshness() {
    const output = await run(() => observability.evaluateFreshness(), "Freshness evaluated.");
    if (output) setNotice(`Freshness evaluated for ${output.items?.length ?? 0} assets.`);
    await refresh();
  }

  async function createMetric() {
    const created = await run(() => observability.createMetric(metricForm), "Metric created.");
    if (created) {
      setMetricForm(emptyMetric);
      await refresh();
    }
  }

  async function selectMetric(ref) {
    setSelectedMetric(ref);
    setMetricHistory(null);
    const output = await run(() => observability.metricHistory(ref, "?window_seconds=604800"), null);
    if (output) setMetricHistory(output);
  }

  async function createAlertRule() {
    const created = await run(
      () =>
        observability.createAlertRule({
          code: alertRuleForm.code,
          name: alertRuleForm.name,
          metric_code: alertRuleForm.metric_code,
          severity: alertRuleForm.severity,
          cooldown_seconds: Number(alertRuleForm.cooldown_seconds),
          condition: { operator: alertRuleForm.condition_operator, value: Number(alertRuleForm.condition_value) },
        }),
      "Alert rule created."
    );
    if (created) {
      setAlertRuleForm(emptyAlertRule);
      await refresh();
    }
  }

  async function alertAction(action, ref, message) {
    await run(() => action(ref), message);
    await refresh();
  }

  async function createIncident() {
    const created = await run(() => observability.createIncident(incidentForm), "Incident created.");
    if (created) {
      setIncidentForm(emptyIncident);
      await refresh();
    }
  }

  async function resolveIncident(ref) {
    await run(() => observability.updateIncident(ref, { status: "RESOLVED" }), "Incident resolved.");
    await refresh();
  }

  async function evaluateSlos() {
    const output = await run(() => observability.evaluateSlos(), "SLOs evaluated.");
    if (output) setNotice(`Evaluated ${output.total ?? 0} SLO(s); ${output.breached ?? 0} breached.`);
    await refresh();
  }

  async function setConfigValue(key, value) {
    await run(() => observability.setConfig(key, value), `Updated ${key}.`);
    await refresh();
  }

  async function setRetention(tier) {
    const days = Number(window.prompt(`Retain ${tier} observations for how many days?`, "90"));
    if (!Number.isFinite(days) || days <= 0) return;
    await run(() => observability.setRetention(tier, days), `Retention for ${tier} set to ${days} days.`);
    await refresh();
  }

  const counts = health?.counts || {};
  const overall = health?.current?.overall || overview?.health?.overall || "UNKNOWN";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Data observability</h1>
          <p className="subtle">Platform-wide telemetry from every capability: volume, freshness, quality, throughput, failures, alerts, incidents and SLOs. This workspace consumes telemetry; it is never a source of truth.</p>
        </div>
        <div className="stack-row">
          {meta?.source_module ? <Badge tone="ok">{meta.source_module}</Badge> : null}
          <Badge tone={HEALTH_TONES[overall] ?? toneFor(overall)}>{overall}</Badge>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} className={`tab${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="stack-row">
            <button className="btn" disabled={busy} onClick={() => collect("UI")}>Collect now</button>
            <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
          </div>
          <div className="grid">
            <div className="panel"><h3>Metrics</h3><div className="mono">{counts.metrics ?? metrics.length}</div></div>
            <div className="panel"><h3>Observations</h3><div className="mono">{counts.observations ?? 0}</div></div>
            <div className="panel"><h3>Open alerts</h3><div className="mono">{alertSummary?.open ?? counts.alerts ?? 0}</div></div>
            <div className="panel"><h3>Incidents</h3><div className="mono">{counts.incidents ?? incidents.length}</div></div>
            <div className="panel"><h3>SLO breaches</h3><div className="mono">{overview?.slo?.breached ?? 0}</div></div>
            <div className="panel"><h3>Providers</h3><div className="mono">{providers.length}</div></div>
          </div>
          <div className="panel">
            <h3>Metric bands</h3>
            <div className="stack-row">
              {Object.entries(overview?.metric_bands || {}).map(([band, value]) => (
                <Badge key={band} tone={toneFor(band)}>{band}: {value}</Badge>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Signals by category</h3>
              {overview?.last_run ? <span className="subtle">Last run {overview.last_run.run_ref} ({overview.last_run.status})</span> : null}
            </div>
            <table className="table">
              <thead><tr><th>Category</th><th>Metric</th><th>Provider</th><th>Value</th><th>Band</th><th>Observed</th></tr></thead>
              <tbody>
                {Object.entries(overview?.categories || {}).flatMap(([category, entries]) =>
                  (entries || []).map((entry) => (
                    <tr key={`${category}-${entry.metric_code}`}>
                      <td className="mono">{category}</td>
                      <td className="mono">{entry.metric_code}</td>
                      <td className="mono">{entry.provider_code}</td>
                      <td className="mono">{formatValue(entry.value)} {entry.unit}</td>
                      <td><Badge tone={toneFor(entry.band)}>{entry.band}</Badge></td>
                      <td className="mono">{entry.observed_at || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "health" ? (
        <>
          <div className="stack-row">
            <button className="btn" disabled={busy} onClick={async () => { await run(() => observability.runHealthCheck(), "Health check submitted."); await refresh(); }}>Run health check</button>
            <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
          </div>
          <div className="grid">
            <div className="panel"><h3>Overall</h3><div><Badge tone={HEALTH_TONES[overall]}>{overall}</Badge></div></div>
            <div className="panel"><h3>Health checks</h3><div className="mono">{counts.health_checks ?? 0}</div></div>
            <div className="panel"><h3>Snapshots</h3><div className="mono">{counts.health_snapshots ?? 0}</div></div>
            <div className="panel"><h3>Freshness</h3><div className="mono">{freshness?.summary?.total ?? 0}</div></div>
          </div>
          <div className="panel">
            <h3>Service health</h3>
            <table className="table">
              <thead><tr><th>Service</th><th>Status</th><th>Signals</th></tr></thead>
              <tbody>
                {(health?.services || []).map((service) => (
                  <tr key={service.code || service.service_code}>
                    <td className="mono">{service.code || service.service_code}</td>
                    <td><Badge tone={HEALTH_TONES[service.status] ?? toneFor(service.status)}>{service.status}</Badge></td>
                    <td className="mono">{(service.checks || []).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "metrics" ? (
        <>
          <div className="panel">
            <h3>Create metric definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={metricForm.code} onChange={(e) => setMetricForm({ ...metricForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={metricForm.name} onChange={(e) => setMetricForm({ ...metricForm, name: e.target.value })} /></label>
              <label className="field"><span>Provider</span>
                <select value={metricForm.provider_code} onChange={(e) => setMetricForm({ ...metricForm, provider_code: e.target.value })}>
                  {providers.map((provider) => <option key={provider.code} value={provider.code}>{provider.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Category</span>
                <select value={metricForm.category} onChange={(e) => setMetricForm({ ...metricForm, category: e.target.value })}>
                  {(meta?.capabilities?.signal_categories || []).map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label className="field"><span>Calculation</span>
                <select value={metricForm.calculation} onChange={(e) => setMetricForm({ ...metricForm, calculation: e.target.value })}>
                  {(meta?.capabilities?.calculations || []).map((calc) => <option key={calc} value={calc}>{calc}</option>)}
                </select>
              </label>
              <label className="field"><span>Direction</span>
                <select value={metricForm.direction} onChange={(e) => setMetricForm({ ...metricForm, direction: e.target.value })}>
                  {(meta?.capabilities?.metric_directions || []).map((direction) => <option key={direction} value={direction}>{direction}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !metricForm.code || !metricForm.name} onClick={createMetric}>Create metric</button>
          </div>
          <div className="panel">
            <h3>Metric catalogue</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Provider</th><th>Category</th><th>Unit</th><th>Status</th><th /></tr></thead>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={metric.id}>
                    <td className="mono">{metric.code}</td>
                    <td>{metric.name}</td>
                    <td className="mono">{metric.provider_code}</td>
                    <td className="mono">{metric.category}</td>
                    <td className="mono">{metric.unit}</td>
                    <td><Badge tone={toneFor(metric.status)}>{metric.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => selectMetric(metric.metric_ref)}>History</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedMetric ? (
            <div className="panel">
              <h3>History: <span className="mono">{selectedMetric}</span></h3>
              <p className="subtle">
                {metricHistory?.summary
                  ? `${metricHistory.summary.count} points | min ${formatValue(metricHistory.summary.min)} | max ${formatValue(metricHistory.summary.max)} | avg ${formatValue(metricHistory.summary.avg)} | last ${formatValue(metricHistory.summary.last)}`
                  : "Loading..."}
              </p>
              <table className="table">
                <thead><tr><th>Observed at</th><th>Value</th></tr></thead>
                <tbody>
                  {(metricHistory?.points || []).slice(-25).map((point, index) => (
                    <tr key={index}><td className="mono">{point.observed_at}</td><td className="mono">{formatValue(point.value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "freshness" ? (
        <>
          <div className="stack-row">
            <button className="btn" disabled={busy} onClick={evaluateFreshness}>Evaluate freshness</button>
            <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
          </div>
          <div className="grid">
            {Object.entries(freshness?.summary?.buckets || {}).map(([band, value]) => (
              <div className="panel" key={band}><h3>{band}</h3><div className="mono">{value}</div></div>
            ))}
          </div>
          <div className="panel">
            <h3>Freshness definitions</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Asset</th><th>Provider</th><th>Max age (s)</th><th>Status</th></tr></thead>
              <tbody>
                {(freshness?.definitions?.items || []).map((definition) => (
                  <tr key={definition.id}>
                    <td className="mono">{definition.code}</td>
                    <td className="mono">{definition.asset_code || definition.asset_ref}</td>
                    <td className="mono">{definition.provider_code}</td>
                    <td className="mono">{definition.max_age_seconds}</td>
                    <td><Badge tone={toneFor(definition.status)}>{definition.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Pipelines & failures</h3>
            <div className="grid">
              <div className="panel"><h3>Throughput</h3><div className="mono">{formatValue(pipelines?.total ?? pipelines?.throughput ?? 0)}</div></div>
              <div className="panel"><h3>Failures</h3><div className="mono">{formatValue(failures?.total ?? failures?.failures ?? 0)}</div></div>
            </div>
          </div>
        </>
      ) : null}

      {tab === "alerts" ? (
        <>
          <div className="panel">
            <h3>Create alert rule</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={alertRuleForm.code} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={alertRuleForm.name} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, name: e.target.value })} /></label>
              <label className="field"><span>Metric</span>
                <select value={alertRuleForm.metric_code} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, metric_code: e.target.value })}>
                  <option value="">Select metric</option>
                  {metrics.map((metric) => <option key={metric.code} value={metric.code}>{metric.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Operator</span>
                <select value={alertRuleForm.condition_operator} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, condition_operator: e.target.value })}>
                  {(meta?.capabilities?.threshold_operators || ["GT", "GTE", "LT", "LTE", "EQ", "NE"]).map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
              </label>
              <label className="field"><span>Value</span><input type="number" value={alertRuleForm.condition_value} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, condition_value: e.target.value })} /></label>
              <label className="field"><span>Severity</span>
                <select value={alertRuleForm.severity} onChange={(e) => setAlertRuleForm({ ...alertRuleForm, severity: e.target.value })}>
                  {(meta?.capabilities?.severities || ["INFO", "WARNING", "HIGH", "CRITICAL"]).map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !alertRuleForm.code || !alertRuleForm.metric_code} onClick={createAlertRule}>Create rule</button>
          </div>
          <div className="grid">
            <div className="panel"><h3>Open</h3><div className="mono">{alertSummary?.open ?? alerts.length}</div></div>
            <div className="panel"><h3>Critical</h3><div className="mono">{alertSummary?.by_severity?.CRITICAL ?? 0}</div></div>
            <div className="panel"><h3>Rules</h3><div className="mono">{alertRules.length}</div></div>
          </div>
          <div className="panel">
            <h3>Alerts</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Metric</th><th>Severity</th><th>Status</th><th>Value</th><th /></tr></thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td className="mono">{alert.alert_ref}</td>
                    <td className="mono">{alert.metric_code}</td>
                    <td><Badge tone={SEVERITY_TONES[alert.severity] ?? toneFor(alert.severity)}>{alert.severity}</Badge></td>
                    <td><Badge tone={toneFor(alert.status)}>{alert.status}</Badge></td>
                    <td className="mono">{formatValue(alert.value)}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => alertAction((ref) => observability.acknowledgeAlert(ref, {}), alert.alert_ref, "Alert acknowledged.")}>Ack</button>
                      <button className="btn ghost" disabled={busy} onClick={() => alertAction((ref) => observability.resolveAlert(ref, {}), alert.alert_ref, "Alert resolved.")}>Resolve</button>
                      <button className="btn ghost" disabled={busy} onClick={() => alertAction((ref) => observability.closeAlert(ref, {}), alert.alert_ref, "Alert closed.")}>Close</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Alert rules</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Status</th></tr></thead>
              <tbody>
                {alertRules.map((ruleRow) => (
                  <tr key={ruleRow.id}>
                    <td className="mono">{ruleRow.code}</td>
                    <td className="mono">{ruleRow.metric_code}</td>
                    <td className="mono">{ruleRow.condition?.operator} {formatValue(ruleRow.condition?.value)}</td>
                    <td><Badge tone={SEVERITY_TONES[ruleRow.severity] ?? toneFor(ruleRow.severity)}>{ruleRow.severity}</Badge></td>
                    <td><Badge tone={toneFor(ruleRow.status)}>{ruleRow.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "incidents" ? (
        <>
          <div className="panel">
            <h3>Create incident</h3>
            <div className="grid">
              <label className="field"><span>Title</span><input value={incidentForm.title} onChange={(e) => setIncidentForm({ ...incidentForm, title: e.target.value })} /></label>
              <label className="field"><span>Service</span><input value={incidentForm.service_code} onChange={(e) => setIncidentForm({ ...incidentForm, service_code: e.target.value })} /></label>
              <label className="field"><span>Severity</span>
                <select value={incidentForm.severity} onChange={(e) => setIncidentForm({ ...incidentForm, severity: e.target.value })}>
                  {(meta?.capabilities?.severities || ["INFO", "WARNING", "HIGH", "CRITICAL"]).map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input value={incidentForm.description} onChange={(e) => setIncidentForm({ ...incidentForm, description: e.target.value })} /></label>
            </div>
            <button className="btn" disabled={busy || !incidentForm.title} onClick={createIncident}>Create incident</button>
          </div>
          <div className="panel">
            <h3>Incidents</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Title</th><th>Severity</th><th>Status</th><th /></tr></thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident.id}>
                    <td className="mono">{incident.incident_ref}</td>
                    <td>{incident.title}</td>
                    <td><Badge tone={SEVERITY_TONES[incident.severity] ?? toneFor(incident.severity)}>{incident.severity}</Badge></td>
                    <td><Badge tone={toneFor(incident.status)}>{incident.status}</Badge></td>
                    <td>{incident.status !== "RESOLVED" && incident.status !== "CLOSED" ? <button className="btn ghost" disabled={busy} onClick={() => resolveIncident(incident.incident_ref)}>Resolve</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "slo" ? (
        <>
          <div className="stack-row">
            <button className="btn" disabled={busy} onClick={evaluateSlos}>Evaluate SLOs</button>
            <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
          </div>
          <div className="grid">
            <div className="panel"><h3>Total</h3><div className="mono">{sloSummary?.total ?? 0}</div></div>
            <div className="panel"><h3>Compliant</h3><div className="mono">{sloSummary?.compliant ?? 0}</div></div>
            <div className="panel"><h3>At risk</h3><div className="mono">{sloSummary?.at_risk ?? 0}</div></div>
            <div className="panel"><h3>Breached</h3><div className="mono">{sloSummary?.breached ?? 0}</div></div>
            <div className="panel"><h3>No data</h3><div className="mono">{sloSummary?.no_data ?? 0}</div></div>
          </div>
          <div className="panel">
            <h3>Service level objectives</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Metric</th><th>Target</th><th>Kind</th><th>Status</th></tr></thead>
              <tbody>
                {(sloSummary?.evaluations || []).map((slo) => (
                  <tr key={slo.id || slo.code}>
                    <td className="mono">{slo.code}</td>
                    <td className="mono">{slo.metric_code}</td>
                    <td className="mono">{formatValue(slo.target)}</td>
                    <td className="mono">{slo.kind}</td>
                    <td><Badge tone={toneFor(slo.status)}>{slo.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "dashboards" ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>{dashboard?.dashboard?.name || "Default dashboard"}</h3>
              <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
            </div>
            <div className="grid">
              {(dashboard?.widgets || []).map((widget) => (
                <div className="panel" key={widget.widget_ref || widget.title}>
                  <h3>{widget.title}</h3>
                  <p className="subtle mono">{widget.type}</p>
                  <div className="mono">{widget.data ? formatValue(widget.data.value ?? widget.data.status ?? JSON.stringify(widget.data)) : "-"}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {tab === "providers" ? (
        <div className="panel">
          <h3>Telemetry providers</h3>
          <p className="subtle">Read-only adapters over existing platform stores. Observability never duplicates them.</p>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Description</th></tr></thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.code}>
                  <td className="mono">{provider.code}</td>
                  <td>{provider.name}</td>
                  <td><Badge tone={toneFor(provider.status)}>{provider.status}</Badge></td>
                  <td className="subtle">{provider.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Collection runs</h3>
            <button className="btn" disabled={busy} onClick={() => collect("UI")}>Collect now</button>
          </div>
          <table className="table">
            <thead><tr><th>Run</th><th>Trigger</th><th>Status</th><th>Metrics</th><th>Observations</th><th>Alerts</th><th>Started</th></tr></thead>
            <tbody>
              {runs.map((runRow) => (
                <tr key={runRow.id}>
                  <td className="mono">{runRow.run_ref}</td>
                  <td className="mono">{runRow.trigger_type}</td>
                  <td><Badge tone={toneFor(runRow.status)}>{runRow.status}</Badge></td>
                  <td className="mono">{runRow.metric_count}</td>
                  <td className="mono">{runRow.observation_count}</td>
                  <td className="mono">{runRow.alerts_created}</td>
                  <td className="mono">{runRow.started_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="panel">
          <h3>Observability history</h3>
          <table className="table">
            <thead><tr><th>Action</th><th>Entity</th><th>Ref</th><th>Summary</th><th>At</th></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.action}</td>
                  <td className="mono">{entry.entity_type}</td>
                  <td className="mono">{entry.entity_ref}</td>
                  <td>{entry.summary}</td>
                  <td className="mono">{entry.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "config" ? (
        <>
          <div className="panel">
            <h3>Configuration</h3>
            <table className="table">
              <thead><tr><th>Key</th><th>Value</th><th /></tr></thead>
              <tbody>
                {Object.entries(config?.config || {}).map(([key, value]) => (
                  <tr key={key}>
                    <td className="mono">{key}</td>
                    <td className="mono">{formatValue(value)}</td>
                    <td>
                      <button
                        className="btn ghost"
                        disabled={busy || typeof value === "boolean"}
                        onClick={() => {
                          const next = window.prompt(`New value for ${key}`, String(value));
                          if (next === null || next === "") return;
                          setConfigValue(key, Number.isNaN(Number(next)) ? next : Number(next));
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Retention policies</h3>
            <table className="table">
              <thead><tr><th>Tier</th><th>Retain days</th><th>Status</th><th /></tr></thead>
              <tbody>
                {(config?.retention || []).map((policy) => (
                  <tr key={policy.tier}>
                    <td className="mono">{policy.tier}</td>
                    <td className="mono">{policy.retain_days}</td>
                    <td><Badge tone={toneFor(policy.status)}>{policy.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => setRetention(policy.tier)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
