import React, { useEffect, useState } from "react";
import { reporting } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "reports", label: "Saved reports" },
  { key: "builder", label: "Report builder" },
  { key: "dashboards", label: "Dashboards" },
  { key: "kpis", label: "KPIs" },
  { key: "metrics", label: "Metrics" },
  { key: "sources", label: "Semantic layer" },
  { key: "schedules", label: "Schedules" },
  { key: "exports", label: "Exports" },
  { key: "bi", label: "BI integration" },
  { key: "history", label: "History & usage" },
  { key: "config", label: "Configuration" },
];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["ACTIVE", "COMPLETED", "PUBLISHED", "AVAILABLE", "OK", "CONNECTED", "READY"].includes(status)) return "ok";
  if (["DRAFT", "QUEUED", "RUNNING", "WARNING", "PLANNED", "PARTIAL"].includes(status)) return "warn";
  if (["FAILED", "ERROR", "BLOCKED", "ARCHIVED", "OBSOLETE"].includes(status)) return "danger";
  return undefined;
}

function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

const emptyReport = {
  code: "",
  name: "",
  description: "",
  report_type: "ANALYTICAL",
  data_source: "OBJECT_MODEL",
  visibility: "GLOBAL",
  entity: "object",
  group_by: "object_type",
  aggregation: "COUNT",
  alias: "count",
  visualization: "BAR",
};
const emptyDashboard = { code: "", name: "", description: "", visibility: "GLOBAL" };
const emptyKpi = { code: "", name: "", entity: "object", aggregation: "COUNT", target: 1 };
const emptyMetric = { code: "", name: "", entity: "object", aggregation: "COUNT" };
const emptySchedule = { name: "", target_type: "REPORT", report_code: "OBJECTS_BY_TYPE", frequency: "DAILY", format: "CSV" };
const emptyConnection = { provider: "GENERIC_ODATA", name: "" };

function reportDefinition(form) {
  return {
    entity: form.entity,
    data_source: form.data_source,
    group_by: form.group_by ? String(form.group_by).split(",").map((entry) => entry.trim()).filter(Boolean) : [],
    aggregations: [{ function: form.aggregation || "COUNT", attribute: form.aggregation === "COUNT" ? null : form.group_by, alias: form.alias || "value" }],
    visualization: { type: form.visualization || "BAR" },
  };
}

export default function ReportingAnalyticsPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [metricsInfo, setMetricsInfo] = useState(null);
  const [config, setConfig] = useState({});
  const [entities, setEntities] = useState([]);
  const [dataSources, setDataSources] = useState([]);
  const [reports, setReports] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [kpis, setKpis] = useState([]);
  const [metricList, setMetricList] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [exportsList, setExportsList] = useState([]);
  const [connections, setConnections] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [executions, setExecutions] = useState([]);
  const [history, setHistory] = useState([]);

  const [selectedReport, setSelectedReport] = useState("");
  const [reportResult, setReportResult] = useState(null);
  const [reportVersions, setReportVersions] = useState([]);
  const [selectedDashboard, setSelectedDashboard] = useState("");
  const [dashboardWidgets, setDashboardWidgets] = useState([]);
  const [builderResult, setBuilderResult] = useState(null);

  const [reportForm, setReportForm] = useState(emptyReport);
  const [builderForm, setBuilderForm] = useState({ entity: "object", group_by: "object_type", aggregation: "COUNT", alias: "count" });
  const [dashboardForm, setDashboardForm] = useState(emptyDashboard);
  const [kpiForm, setKpiForm] = useState(emptyKpi);
  const [metricForm, setMetricForm] = useState(emptyMetric);
  const [scheduleForm, setScheduleForm] = useState(emptySchedule);
  const [connectionForm, setConnectionForm] = useState(emptyConnection);
  const [datasetForm, setDatasetForm] = useState({ connection_id: "", name: "", entity: "object" });

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
      const [met, h, m, cfg, ents, sources, reps, dash, kpi, mets, sch, exps, conns, dsets, execs, hist] = await Promise.all([
        reporting.meta(),
        reporting.health(),
        reporting.metrics(),
        reporting.configuration(),
        reporting.semanticEntities(),
        reporting.dataSources(),
        reporting.reports("?page_size=100"),
        reporting.dashboards("?page_size=100"),
        reporting.kpis("?page_size=100"),
        reporting.metricDefinitions("?page_size=100"),
        reporting.schedules("?page_size=100"),
        reporting.exports("?page_size=50"),
        reporting.biConnections("?page_size=100"),
        reporting.biDatasets("?page_size=100"),
        reporting.executions("?page_size=50"),
        reporting.history("?page_size=50"),
      ]);
      setMeta(met);
      setHealth(h);
      setMetricsInfo(m);
      setConfig(cfg || {});
      setEntities(ents.items || []);
      setDataSources(sources.items || []);
      setReports(reps.items || []);
      setDashboards(dash.items || []);
      setKpis(kpi.items || []);
      setMetricList(mets.items || []);
      setSchedules(sch.items || []);
      setExportsList(exps.items || []);
      setConnections(conns.items || []);
      setDatasets(dsets.items || []);
      setExecutions(execs.items || []);
      setHistory(hist.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createReport() {
    const created = await run(
      () => reporting.createReport({ ...reportForm, definition: reportDefinition(reportForm) }),
      "Report created."
    );
    if (created) {
      setReportForm(emptyReport);
      setSelectedReport(created.report_ref || created.code);
      await refresh();
    }
  }

  async function publishReport(ref) {
    await run(() => reporting.publishReport(ref), "Report published.");
    await refresh();
  }

  async function selectReport(ref) {
    setSelectedReport(ref);
    setReportResult(null);
    try {
      const versions = await reporting.reportVersions(ref);
      setReportVersions(versions.items || []);
    } catch {
      setReportVersions([]);
    }
  }

  async function executeReport(ref) {
    const output = await run(() => reporting.executeReport(ref, {}), "Report executed.");
    if (output) setReportResult(output);
    await refresh();
  }

  async function runBuilder() {
    const output = await run(
      () => reporting.executeQuery({ entity: builderForm.entity, group_by: [builderForm.group_by], aggregations: [{ function: builderForm.aggregation, attribute: builderForm.aggregation === "COUNT" ? null : builderForm.group_by, alias: builderForm.alias }] }),
      "Query executed."
    );
    if (output) setBuilderResult(output);
  }

  async function createDashboard() {
    const created = await run(() => reporting.createDashboard(dashboardForm), "Dashboard created.");
    if (created) {
      setDashboardForm(emptyDashboard);
      await refresh();
    }
  }

  async function loadDashboard(ref) {
    setSelectedDashboard(ref);
    const output = await run(() => reporting.refreshDashboard(ref, {}), "Dashboard refreshed.");
    if (output) setDashboardWidgets(output.widgets || []);
  }

  async function createKpi() {
    const created = await run(() => reporting.createKpi(kpiForm), "KPI created.");
    if (created) {
      setKpiForm(emptyKpi);
      await refresh();
    }
  }

  async function evaluateKpi(ref) {
    const output = await run(() => reporting.evaluateKpi(ref, {}), "KPI evaluated.");
    if (output) setNotice(`KPI ${ref}: ${formatValue(output.value)} (${output.status || "n/a"})`);
    await refresh();
  }

  async function createMetric() {
    const created = await run(() => reporting.createMetric(metricForm), "Metric created.");
    if (created) {
      setMetricForm(emptyMetric);
      await refresh();
    }
  }

  async function computeMetric(ref) {
    const output = await run(() => reporting.computeMetric(ref, {}), "Metric computed.");
    if (output) setNotice(`Metric ${ref}: ${formatValue(output.value)}`);
  }

  async function createSchedule() {
    const created = await run(() => reporting.createSchedule(scheduleForm), "Schedule created.");
    if (created) {
      setScheduleForm(emptySchedule);
      await refresh();
    }
  }

  async function runSchedule(ref) {
    const output = await run(() => reporting.runSchedule(ref), "Schedule executed.");
    if (output) setNotice(`Schedule ${ref} produced ${output.rows ?? 0} row(s).`);
    await refresh();
  }

  async function requestExport(ref, format) {
    const output = await run(() => reporting.exportReport(ref, { format }), `Export (${format}) requested.`);
    if (output) await refresh();
    return output;
  }

  async function downloadExport(ref) {
    const file = await run(() => reporting.downloadExport(ref), "Export downloaded.");
    if (file) {
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  }

  async function createConnection() {
    const created = await run(() => reporting.createBiConnection(connectionForm), "BI connection created.");
    if (created) {
      setConnectionForm(emptyConnection);
      await refresh();
    }
    return created;
  }

  async function createDataset() {
    const created = await run(
      () => reporting.createBiDataset({ connection_id: Number(datasetForm.connection_id), name: datasetForm.name, definition: { entity: datasetForm.entity } }),
      "BI dataset created."
    );
    if (created) {
      setDatasetForm({ connection_id: "", name: "", entity: "object" });
      await refresh();
    }
    return created;
  }

  async function publishDataset(ref) {
    const output = await run(() => reporting.publishBiDataset(ref, {}), "Dataset published.");
    if (output) setNotice(`Dataset ${ref}: ${output.status}`);
    await refresh();
  }

  async function saveConfig(key, value) {
    await run(() => reporting.setConfiguration(key, value), "Configuration saved.");
    await reporting.configuration().then(setConfig).catch(() => {});
  }

  async function seedDemo() {
    await run(() => reporting.seed(), "Demonstration assets seeded.");
    await refresh();
  }

  const counts = health?.counts || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Reporting &amp; analytics</h1>
          <p className="subtle">
            Cross-domain reports, dashboards, KPIs and reusable metrics over the semantic layer, with export, scheduling,
            BI integration, versioning, permissions, caching and usage auditing.
          </p>
        </div>
        <div className="stack-row">
          {meta?.source_module ? <Badge tone="ok">{meta.source_module}</Badge> : null}
          {health?.status ? <Badge tone={toneFor(health.status)}>{health.status}</Badge> : null}
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
          <div className="grid">
            <div className="panel"><h3>Reports</h3><div className="mono">{counts.reports ?? reports.length}</div></div>
            <div className="panel"><h3>Dashboards</h3><div className="mono">{counts.dashboards ?? dashboards.length}</div></div>
            <div className="panel"><h3>KPIs</h3><div className="mono">{counts.kpis ?? kpis.length}</div></div>
            <div className="panel"><h3>Metrics</h3><div className="mono">{counts.metrics ?? metricList.length}</div></div>
            <div className="panel"><h3>Executions</h3><div className="mono">{metricsInfo?.executions?.total ?? executions.length}</div></div>
            <div className="panel"><h3>Cache entries</h3><div className="mono">{metricsInfo?.cache?.total ?? 0}</div></div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Semantic entities</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed demonstration</button>
            </div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Data source</th><th>Attributes</th></tr></thead>
              <tbody>
                {entities.map((entity) => (
                  <tr key={entity.code}>
                    <td className="mono">{entity.code}</td>
                    <td>{entity.name}</td>
                    <td className="mono">{entity.data_source || entity.source}</td>
                    <td className="mono">{(entity.attributes || []).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "reports" ? (
        <>
          <div className="panel">
            <h3>Create report</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={reportForm.code} onChange={(e) => setReportForm({ ...reportForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={reportForm.name} onChange={(e) => setReportForm({ ...reportForm, name: e.target.value })} /></label>
              <label className="field"><span>Entity</span>
                <select value={reportForm.entity} onChange={(e) => setReportForm({ ...reportForm, entity: e.target.value })}>
                  {entities.map((entity) => <option key={entity.code} value={entity.code}>{entity.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Group by</span><input value={reportForm.group_by} onChange={(e) => setReportForm({ ...reportForm, group_by: e.target.value })} /></label>
              <label className="field"><span>Aggregation</span>
                <select value={reportForm.aggregation} onChange={(e) => setReportForm({ ...reportForm, aggregation: e.target.value })}>
                  {(meta?.capabilities?.aggregations || ["COUNT", "SUM", "AVG", "MIN", "MAX"]).map((agg) => <option key={agg} value={agg}>{agg}</option>)}
                </select>
              </label>
              <label className="field"><span>Visualization</span>
                <select value={reportForm.visualization} onChange={(e) => setReportForm({ ...reportForm, visualization: e.target.value })}>
                  {(meta?.capabilities?.visualization_types || ["TABLE", "BAR", "LINE", "PIE"]).map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Visibility</span>
                <select value={reportForm.visibility} onChange={(e) => setReportForm({ ...reportForm, visibility: e.target.value })}>
                  {(meta?.capabilities?.visibility_scopes || ["GLOBAL", "PRIVATE"]).map((scope) => <option key={scope} value={scope}>{scope}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !reportForm.code} onClick={createReport}>Create report</button>
          </div>
          <div className="panel">
            <h3>Reports</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Visibility</th><th>Version</th><th>Status</th><th /></tr></thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td className="mono">{report.code}</td>
                    <td>{report.name}</td>
                    <td className="mono">{report.report_type}</td>
                    <td className="mono">{report.visibility}</td>
                    <td className="mono">{report.version}</td>
                    <td><Badge tone={toneFor(report.status)}>{report.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => selectReport(report.report_ref || report.code)}>Select</button>
                      <button className="btn ghost" disabled={busy} onClick={() => executeReport(report.report_ref || report.code)}>Run</button>
                      {report.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => publishReport(report.report_ref || report.code)}>Publish</button> : null}
                      <button className="btn ghost" disabled={busy} onClick={() => requestExport(report.report_ref || report.code, "CSV")}>CSV</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedReport ? (
            <div className="panel">
              <h3>Result: <span className="mono">{selectedReport}</span></h3>
              <p className="subtle">Versions: {reportVersions.length ? reportVersions.map((v) => v.version).join(", ") : "none"}</p>
              {reportResult ? <ResultTable result={reportResult} /> : <p className="subtle">Run the report to see rows.</p>}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "builder" ? (
        <div className="panel">
          <h3>Ad-hoc query</h3>
          <div className="grid">
            <label className="field"><span>Entity</span>
              <select value={builderForm.entity} onChange={(e) => setBuilderForm({ ...builderForm, entity: e.target.value })}>
                {entities.map((entity) => <option key={entity.code} value={entity.code}>{entity.code}</option>)}
              </select>
            </label>
            <label className="field"><span>Group by</span><input value={builderForm.group_by} onChange={(e) => setBuilderForm({ ...builderForm, group_by: e.target.value })} /></label>
            <label className="field"><span>Aggregation</span>
              <select value={builderForm.aggregation} onChange={(e) => setBuilderForm({ ...builderForm, aggregation: e.target.value })}>
                {(meta?.capabilities?.aggregations || ["COUNT", "SUM", "AVG", "MIN", "MAX"]).map((agg) => <option key={agg} value={agg}>{agg}</option>)}
              </select>
            </label>
            <label className="field"><span>Alias</span><input value={builderForm.alias} onChange={(e) => setBuilderForm({ ...builderForm, alias: e.target.value })} /></label>
          </div>
          <button className="btn" disabled={busy} onClick={runBuilder}>Execute query</button>
          {builderResult ? <ResultTable result={builderResult} /> : null}
        </div>
      ) : null}

      {tab === "dashboards" ? (
        <>
          <div className="panel">
            <h3>Create dashboard</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={dashboardForm.code} onChange={(e) => setDashboardForm({ ...dashboardForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={dashboardForm.name} onChange={(e) => setDashboardForm({ ...dashboardForm, name: e.target.value })} /></label>
              <label className="field"><span>Visibility</span>
                <select value={dashboardForm.visibility} onChange={(e) => setDashboardForm({ ...dashboardForm, visibility: e.target.value })}>
                  {(meta?.capabilities?.visibility_scopes || ["GLOBAL", "PRIVATE"]).map((scope) => <option key={scope} value={scope}>{scope}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !dashboardForm.code} onClick={createDashboard}>Create dashboard</button>
          </div>
          <div className="panel">
            <h3>Dashboards</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Visibility</th><th>Version</th><th>Status</th><th /></tr></thead>
              <tbody>
                {dashboards.map((dashboard) => (
                  <tr key={dashboard.id}>
                    <td className="mono">{dashboard.code}</td>
                    <td>{dashboard.name}</td>
                    <td className="mono">{dashboard.visibility}</td>
                    <td className="mono">{dashboard.version}</td>
                    <td><Badge tone={toneFor(dashboard.status)}>{dashboard.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => loadDashboard(dashboard.dashboard_ref || dashboard.code)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedDashboard ? (
            <div className="panel">
              <h3>Widgets: <span className="mono">{selectedDashboard}</span></h3>
              {dashboardWidgets.length ? (
                <table className="table">
                  <thead><tr><th>Ref</th><th>Title</th><th>Type</th><th>Source</th><th>Rows</th></tr></thead>
                  <tbody>
                    {dashboardWidgets.map((widget) => (
                      <tr key={widget.widget_ref}>
                        <td className="mono">{widget.widget_ref}</td>
                        <td>{widget.title}</td>
                        <td className="mono">{widget.widget_type}</td>
                        <td className="mono">{widget.source || "-"}</td>
                        <td className="mono">{widget.total ?? widget.value ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="subtle">No widgets resolved.</p>}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "kpis" ? (
        <>
          <div className="panel">
            <h3>Create KPI</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={kpiForm.code} onChange={(e) => setKpiForm({ ...kpiForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={kpiForm.name} onChange={(e) => setKpiForm({ ...kpiForm, name: e.target.value })} /></label>
              <label className="field"><span>Entity</span>
                <select value={kpiForm.entity} onChange={(e) => setKpiForm({ ...kpiForm, entity: e.target.value })}>
                  {entities.map((entity) => <option key={entity.code} value={entity.code}>{entity.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Target</span><input type="number" value={kpiForm.target} onChange={(e) => setKpiForm({ ...kpiForm, target: Number(e.target.value) })} /></label>
            </div>
            <button className="btn" disabled={busy || !kpiForm.code} onClick={createKpi}>Create KPI</button>
          </div>
          <div className="panel">
            <h3>KPIs</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Entity</th><th>Status</th><th /></tr></thead>
              <tbody>
                {kpis.map((kpi) => (
                  <tr key={kpi.id}>
                    <td className="mono">{kpi.code}</td>
                    <td>{kpi.name}</td>
                    <td className="mono">{kpi.entity}</td>
                    <td><Badge tone={toneFor(kpi.status)}>{kpi.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => evaluateKpi(kpi.kpi_ref || kpi.code)}>Evaluate</button>
                    </td>
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
            <h3>Create metric</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={metricForm.code} onChange={(e) => setMetricForm({ ...metricForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={metricForm.name} onChange={(e) => setMetricForm({ ...metricForm, name: e.target.value })} /></label>
              <label className="field"><span>Entity</span>
                <select value={metricForm.entity} onChange={(e) => setMetricForm({ ...metricForm, entity: e.target.value })}>
                  {entities.map((entity) => <option key={entity.code} value={entity.code}>{entity.code}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !metricForm.code} onClick={createMetric}>Create metric</button>
          </div>
          <div className="panel">
            <h3>Metrics</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Entity</th><th>Status</th><th /></tr></thead>
              <tbody>
                {metricList.map((metric) => (
                  <tr key={metric.id}>
                    <td className="mono">{metric.code}</td>
                    <td>{metric.name}</td>
                    <td className="mono">{metric.entity}</td>
                    <td><Badge tone={toneFor(metric.status)}>{metric.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => computeMetric(metric.metric_ref || metric.code)}>Compute</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "sources" ? (
        <div className="panel">
          <h3>Data sources &amp; semantic layer</h3>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Provider</th><th>Status</th><th>Description</th></tr></thead>
            <tbody>
              {dataSources.map((source) => (
                <tr key={source.code}>
                  <td className="mono">{source.code}</td>
                  <td>{source.name}</td>
                  <td className="mono">{source.provider}</td>
                  <td><Badge tone={toneFor(source.status)}>{source.status}</Badge></td>
                  <td className="subtle">{source.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "schedules" ? (
        <>
          <div className="panel">
            <h3>Create schedule</h3>
            <div className="grid">
              <label className="field"><span>Name</span><input value={scheduleForm.name} onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })} /></label>
              <label className="field"><span>Report</span>
                <select value={scheduleForm.report_code} onChange={(e) => setScheduleForm({ ...scheduleForm, report_code: e.target.value })}>
                  {reports.map((report) => <option key={report.id} value={report.code}>{report.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Frequency</span>
                <select value={scheduleForm.frequency} onChange={(e) => setScheduleForm({ ...scheduleForm, frequency: e.target.value })}>
                  {(meta?.capabilities?.schedule_frequencies || ["DAILY", "WEEKLY", "MONTHLY"]).map((freq) => <option key={freq} value={freq}>{freq}</option>)}
                </select>
              </label>
              <label className="field"><span>Format</span>
                <select value={scheduleForm.format} onChange={(e) => setScheduleForm({ ...scheduleForm, format: e.target.value })}>
                  {(meta?.capabilities?.native_export_formats || ["CSV", "JSON", "EXCEL"]).map((fmt) => <option key={fmt} value={fmt}>{fmt}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !scheduleForm.name} onClick={createSchedule}>Create schedule</button>
          </div>
          <div className="panel">
            <h3>Schedules</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Name</th><th>Target</th><th>Frequency</th><th>Status</th><th>Next run</th><th /></tr></thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td className="mono">{schedule.schedule_ref}</td>
                    <td>{schedule.name}</td>
                    <td className="mono">{schedule.target_type}</td>
                    <td className="mono">{schedule.frequency}</td>
                    <td><Badge tone={toneFor(schedule.status)}>{schedule.status}</Badge></td>
                    <td className="mono">{schedule.next_run_at || "-"}</td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => runSchedule(schedule.schedule_ref)}>Run now</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "exports" ? (
        <div className="panel">
          <h3>Exports</h3>
          <table className="table">
            <thead><tr><th>Ref</th><th>Report</th><th>Format</th><th>Status</th><th>Rows</th><th /></tr></thead>
            <tbody>
              {exportsList.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.export_ref}</td>
                  <td className="mono">{entry.report_code || entry.report_id}</td>
                  <td className="mono">{entry.format}</td>
                  <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  <td className="mono">{entry.row_count ?? "-"}</td>
                  <td><button className="btn ghost" disabled={busy || entry.status !== "COMPLETED"} onClick={() => downloadExport(entry.export_ref)}>Download</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "bi" ? (
        <>
          <div className="panel">
            <h3>BI capabilities</h3>
            <p className="subtle">
              Push: {(meta?.capabilities?.bi?.push_supported || []).join(", ") || "none"} · Planned: {(meta?.capabilities?.bi?.planned || []).join(", ") || "none"}
            </p>
          </div>
          <div className="panel">
            <h3>Create connection &amp; dataset</h3>
            <div className="grid">
              <label className="field"><span>Provider</span>
                <select value={connectionForm.provider} onChange={(e) => setConnectionForm({ ...connectionForm, provider: e.target.value })}>
                  {(meta?.capabilities?.bi_providers || ["GENERIC_ODATA"]).map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                </select>
              </label>
              <label className="field"><span>Name</span><input value={connectionForm.name} onChange={(e) => setConnectionForm({ ...connectionForm, name: e.target.value })} /></label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy || !connectionForm.name} onClick={createConnection}>Create connection</button>
            </div>
            <div className="grid" style={{ marginTop: 12 }}>
              <label className="field"><span>Connection</span>
                <select value={datasetForm.connection_id} onChange={(e) => setDatasetForm({ ...datasetForm, connection_id: e.target.value })}>
                  <option value="">Select…</option>
                  {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Dataset name</span><input value={datasetForm.name} onChange={(e) => setDatasetForm({ ...datasetForm, name: e.target.value })} /></label>
              <label className="field"><span>Entity</span>
                <select value={datasetForm.entity} onChange={(e) => setDatasetForm({ ...datasetForm, entity: e.target.value })}>
                  {entities.map((entity) => <option key={entity.code} value={entity.code}>{entity.code}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !datasetForm.connection_id || !datasetForm.name} onClick={createDataset}>Create dataset</button>
          </div>
          <div className="panel">
            <h3>Datasets</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Name</th><th>Entity</th><th>Status</th><th /></tr></thead>
              <tbody>
                {datasets.map((dataset) => (
                  <tr key={dataset.id}>
                    <td className="mono">{dataset.dataset_ref}</td>
                    <td>{dataset.name}</td>
                    <td className="mono">{dataset.entity}</td>
                    <td><Badge tone={toneFor(dataset.status)}>{dataset.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => publishDataset(dataset.dataset_ref)}>Publish</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "history" ? (
        <>
          <div className="panel">
            <h3>Executions</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Report</th><th>Mode</th><th>Rows</th><th>Cache</th><th>Duration (ms)</th><th>At</th></tr></thead>
              <tbody>
                {executions.map((execution) => (
                  <tr key={execution.id}>
                    <td className="mono">{execution.execution_ref}</td>
                    <td className="mono">{execution.report_code || execution.report_id}</td>
                    <td className="mono">{execution.mode}</td>
                    <td className="mono">{execution.row_count}</td>
                    <td className="mono">{execution.cache_hit ? "hit" : "miss"}</td>
                    <td className="mono">{execution.duration_ms}</td>
                    <td className="mono">{execution.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Change history</h3>
            <table className="table">
              <thead><tr><th>Entity</th><th>Action</th><th>Summary</th><th>At</th></tr></thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.entity_type}</td>
                    <td className="mono">{entry.action}</td>
                    <td>{entry.summary}</td>
                    <td className="mono">{entry.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "config" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th /></tr></thead>
            <tbody>
              {Object.entries(config).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{formatValue(value)}</td>
                  <td className="stack-row">
                    {typeof value === "boolean" ? (
                      <button className="btn ghost" disabled={busy} onClick={() => saveConfig(key, !value)}>Toggle</button>
                    ) : (
                      <input
                        defaultValue={value}
                        onBlur={(e) => {
                          const next = Number(e.target.value);
                          if (!Number.isNaN(next) && next !== value) saveConfig(key, next);
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {metricsInfo?.read_model ? (
            <p className="subtle">
              Read model: {metricsInfo.read_model.entities?.length || 0} entities,{" "}
              {(metricsInfo.read_model.entities || []).reduce((total, entry) => total + (entry.rows || 0), 0)} rows
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ResultTable({ result }) {
  const columns = Object.keys(result.rows?.[0] || {});
  return (
    <>
      <p className="subtle">
        {result.total} row(s) · {result.query_type} · cache {result.cache_hit ? "hit" : "miss"}
      </p>
      {columns.length ? (
        <table className="table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index}>{columns.map((column) => <td key={column} className="mono">{formatValue(row[column])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      ) : <p className="subtle">No rows returned.</p>}
    </>
  );
}
