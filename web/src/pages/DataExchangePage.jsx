import React, { useEffect, useState } from "react";
import { dataExchange } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "connectors", label: "Connectors" },
  { key: "imports", label: "Import definitions" },
  { key: "exports", label: "Export definitions" },
  { key: "jobs", label: "Jobs" },
  { key: "templates", label: "Templates" },
  { key: "history", label: "History" },
  { key: "configuration", label: "Configuration" },
];

const emptyImport = {
  code: "",
  name: "",
  target_object_type: "",
  source_type: "CSV",
  duplicate_strategy: "UPSERT",
  description: "",
};
const emptyExport = {
  code: "",
  name: "",
  object_type: "",
  format: "CSV",
  destination: "DOWNLOAD",
  description: "",
};

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["COMPLETED", "ACTIVE", "AVAILABLE"].includes(status)) return "ok";
  if (["PARTIAL", "RUNNING", "QUEUED", "DRAFT", "VALIDATING"].includes(status)) return "warn";
  if (["FAILED", "CANCELLED", "EXPIRED", "DEPRECATED"].includes(status)) return "danger";
  return undefined;
}

export default function DataExchangePage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [configuration, setConfiguration] = useState({});
  const [importDefs, setImportDefs] = useState([]);
  const [exportDefs, setExportDefs] = useState([]);
  const [importJobs, setImportJobs] = useState([]);
  const [exportJobs, setExportJobs] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);

  const [importForm, setImportForm] = useState(emptyImport);
  const [exportForm, setExportForm] = useState(emptyExport);
  const [importContent, setImportContent] = useState("part_number,part_name,part_category,notes\nPART-1001,Bearing housing,mechanical,first\n");
  const [importPreview, setImportPreview] = useState(null);
  const [selectedImport, setSelectedImport] = useState("");
  const [selectedExport, setSelectedExport] = useState("");
  const [exportPreview, setExportPreview] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, m, h, conn, cfg, imp, exp, iJobs, eJobs, tpl, hist] = await Promise.all([
        dataExchange.meta(),
        dataExchange.metrics(),
        dataExchange.health(),
        dataExchange.connectors(),
        dataExchange.configuration(),
        dataExchange.importDefinitions("?page_size=50"),
        dataExchange.exportDefinitions("?page_size=50"),
        dataExchange.importJobs("?page_size=25"),
        dataExchange.exportJobs("?page_size=25"),
        dataExchange.templates("?page_size=25"),
        dataExchange.history("?page_size=25"),
      ]);
      setMeta(met);
      setMetrics(m);
      setHealth(h);
      setConnectors(conn.items || []);
      setConfiguration(cfg || {});
      setImportDefs(imp.items || []);
      setExportDefs(exp.items || []);
      setImportJobs(iJobs.items || []);
      setExportJobs(eJobs.items || []);
      setTemplates(tpl.items || []);
      setHistory(hist.items || []);
      if (!selectedImport && imp.items?.[0]) setSelectedImport(imp.items[0].code);
      if (!selectedExport && exp.items?.[0]) setSelectedExport(exp.items[0].code);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function bind(setter, form) {
    return (event) => setter({ ...form, [event.target.name]: event.target.value });
  }

  const onChangeImport = bind(setImportForm, importForm);
  const onChangeExport = bind(setExportForm, exportForm);
  const connectorTypes = meta?.capabilities?.connector_types || [];
  const exportFormats = meta?.capabilities?.export_formats || [];
  const exportDestinations = meta?.capabilities?.export_destinations || [];
  const duplicateStrategies = meta?.capabilities?.duplicate_strategies || [];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Data exchange</div>
          <h1>Import &amp; export framework</h1>
          <p className="sub">
            Centralized, connector-based movement of data between the platform and external systems. Business modules
            declare what moves and how; the framework owns transport, parsing, mapping, validation, reconciliation and history.
          </p>
        </div>
        <div className="stack-row">
          <button className="btn ghost" onClick={refresh} disabled={busy}>Refresh</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} type="button" className={`tab ${tab === entry.key ? "active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Import definitions</h3><div className="mono">{metrics?.import_definitions ?? "—"}</div></div>
            <div className="panel grow"><h3>Export definitions</h3><div className="mono">{metrics?.export_definitions ?? "—"}</div></div>
            <div className="panel grow"><h3>Connector configs</h3><div className="mono">{metrics?.connector_configurations ?? "—"}</div></div>
            <div className="panel grow"><h3>Import records</h3><div className="mono">{metrics?.import_records ?? "—"}</div></div>
            <div className="panel grow"><h3>Open errors</h3><div className="mono">{metrics?.import_errors ?? "—"}</div></div>
            <div className="panel grow"><h3>Export results</h3><div className="mono">{metrics?.export_results ?? "—"}</div></div>
          </div>

          <div className="panel">
            <h3>Connector types ({connectorTypes.length})</h3>
            <div className="chips">
              {connectorTypes.map((type) => <Badge key={type}>{type}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Health · {health?.status || "unknown"}</h3>
            {health?.checks?.length ? (
              <div className="chips">
                {health.checks.map((check) => (
                  <Badge key={check.name} tone={check.status === "ok" ? "ok" : "warn"}>{check.name}: {check.status}</Badge>
                ))}
              </div>
            ) : (
              <div className="mono">No health data.</div>
            )}
          </div>
        </>
      ) : null}

      {tab === "connectors" ? (
        <div className="panel">
          <h3>Pluggable connectors ({connectors.length})</h3>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Directions</th><th>Capabilities</th><th>Formats</th></tr></thead>
            <tbody>
              {connectors.map((connector) => (
                <tr key={connector.code}>
                  <td className="mono">{connector.code}</td>
                  <td>{connector.name}</td>
                  <td>{(connector.directions || []).join(", ")}</td>
                  <td className="mono">{(connector.capabilities || []).join(", ")}</td>
                  <td className="mono">{(connector.formats || []).join(", ")}</td>
                </tr>
              ))}
              {!connectors.length ? <tr><td colSpan={5} className="mono">No connectors registered.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "imports" ? (
        <>
          <div className="panel">
            <h3>Create an import definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={importForm.code} onChange={onChangeImport} /></label>
              <label className="field"><span>Name</span><input name="name" value={importForm.name} onChange={onChangeImport} /></label>
              <label className="field"><span>Target object type</span><input name="target_object_type" value={importForm.target_object_type} onChange={onChangeImport} placeholder="product" /></label>
              <label className="field"><span>Source type</span>
                <select name="source_type" value={importForm.source_type} onChange={onChangeImport}>
                  {connectorTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Duplicate strategy</span>
                <select name="duplicate_strategy" value={importForm.duplicate_strategy} onChange={onChangeImport}>
                  {duplicateStrategies.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={importForm.description} onChange={onChangeImport} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => dataExchange.createImportDefinition(importForm), "Import definition created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Preview &amp; run ({importDefs.length})</h3>
            <div className="grid">
              <label className="field"><span>Definition</span>
                <select value={selectedImport} onChange={(event) => setSelectedImport(event.target.value)}>
                  <option value="">Select…</option>
                  {importDefs.map((def) => <option key={def.code} value={def.code}>{def.code} → {def.target_object_type}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Inline CSV content</span>
              <textarea rows={5} value={importContent} onChange={(event) => setImportContent(event.target.value)} />
            </label>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy || !selectedImport}
                onClick={() => run(async () => setImportPreview(await dataExchange.previewImport(selectedImport, { content: importContent })))}>Preview</button>
              <button className="btn" disabled={busy || !selectedImport}
                onClick={() => run(() => dataExchange.runImport(selectedImport, { content: importContent, mode: "IMPORT" }), "Import finished.")}>Run import</button>
            </div>
            {importPreview ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Preview · valid {importPreview.valid} · invalid {importPreview.invalid}</h3>
                <table className="table">
                  <thead><tr><th>#</th><th>Status</th><th>Message</th></tr></thead>
                  <tbody>
                    {(importPreview.rows || []).map((row) => (
                      <tr key={row.record_number}>
                        <td className="mono">{row.record_number}</td>
                        <td><Badge tone={row.valid ? "ok" : "danger"}>{row.valid ? "VALID" : "INVALID"}</Badge></td>
                        <td className="mono">{(row.errors || []).map((e) => e.message).join("; ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "exports" ? (
        <>
          <div className="panel">
            <h3>Create an export definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={exportForm.code} onChange={onChangeExport} /></label>
              <label className="field"><span>Name</span><input name="name" value={exportForm.name} onChange={onChangeExport} /></label>
              <label className="field"><span>Object type</span><input name="object_type" value={exportForm.object_type} onChange={onChangeExport} placeholder="product" /></label>
              <label className="field"><span>Format</span>
                <select name="format" value={exportForm.format} onChange={onChangeExport}>
                  {exportFormats.map((format) => <option key={format} value={format}>{format}</option>)}
                </select>
              </label>
              <label className="field"><span>Destination</span>
                <select name="destination" value={exportForm.destination} onChange={onChangeExport}>
                  {exportDestinations.map((destination) => <option key={destination} value={destination}>{destination}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={exportForm.description} onChange={onChangeExport} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => dataExchange.createExportDefinition(exportForm), "Export definition created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Preview &amp; run ({exportDefs.length})</h3>
            <div className="grid">
              <label className="field"><span>Definition</span>
                <select value={selectedExport} onChange={(event) => setSelectedExport(event.target.value)}>
                  <option value="">Select…</option>
                  {exportDefs.map((def) => <option key={def.code} value={def.code}>{def.code} → {def.object_type}</option>)}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy || !selectedExport}
                onClick={() => run(async () => setExportPreview(await dataExchange.previewExport(selectedExport, {})))}>Preview</button>
              <button className="btn" disabled={busy || !selectedExport}
                onClick={() => run(() => dataExchange.runExport(selectedExport, {}), "Export finished.")}>Run export</button>
            </div>
            {exportPreview ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Preview · {exportPreview.record_count} records · {exportPreview.sample_size} shown</h3>
                <div className="mono">Fields: {(exportPreview.fields || []).join(", ") || "all"}</div>
              </div>
            ) : null}

            <h3 style={{ marginTop: 16 }}>Export results</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Format</th><th>Records</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {exportJobs.flatMap((job) => job.results || []).map((result) => (
                  <tr key={result.result_ref}>
                    <td className="mono">{result.result_ref}</td>
                    <td>{result.format}</td>
                    <td>{result.record_count}</td>
                    <td><Badge tone={toneFor(result.status)}>{result.status}</Badge></td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(async () => {
                          const file = await dataExchange.downloadExportResult(result.result_ref);
                          const url = URL.createObjectURL(file.blob);
                          const anchor = document.createElement("a");
                          anchor.href = url;
                          anchor.download = file.filename;
                          anchor.click();
                          URL.revokeObjectURL(url);
                        }, "Download started.")}>Download</button>
                    </td>
                  </tr>
                ))}
                {!exportJobs.some((job) => (job.results || []).length) ? <tr><td colSpan={5} className="mono">No export results yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "jobs" ? (
        <>
          <div className="panel">
            <h3>Import jobs ({importJobs.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Mode</th><th>Status</th><th>Created</th><th>Failed</th><th></th></tr></thead>
              <tbody>
                {importJobs.map((job) => (
                  <tr key={job.job_ref}>
                    <td className="mono">{job.job_ref}</td>
                    <td>{job.mode}</td>
                    <td><Badge tone={toneFor(job.status)}>{job.status}</Badge></td>
                    <td>{job.created_count}</td>
                    <td>{job.failed_count}</td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => dataExchange.reconcileImportJob(job.job_ref), "Reconciled.")}>Reconcile</button>
                      <button className="chip link-btn" disabled={busy || !job.failed_count}
                        onClick={() => run(() => dataExchange.retryImportJob(job.job_ref), "Retry submitted.")}>Retry</button>
                      <button className="chip link-btn" disabled={busy || ["COMPLETED", "FAILED", "CANCELLED", "PARTIAL"].includes(job.status)}
                        onClick={() => run(() => dataExchange.cancelImportJob(job.job_ref), "Cancelled.")}>Cancel</button>
                    </td>
                  </tr>
                ))}
                {!importJobs.length ? <tr><td colSpan={6} className="mono">No import jobs.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Export jobs ({exportJobs.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Format</th><th>Status</th><th>Exported</th><th>Errors</th></tr></thead>
              <tbody>
                {exportJobs.map((job) => (
                  <tr key={job.job_ref}>
                    <td className="mono">{job.job_ref}</td>
                    <td>{job.format}</td>
                    <td><Badge tone={toneFor(job.status)}>{job.status}</Badge></td>
                    <td>{job.exported_count}</td>
                    <td>{job.error_count}</td>
                  </tr>
                ))}
                {!exportJobs.length ? <tr><td colSpan={5} className="mono">No export jobs.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "templates" ? (
        <div className="panel">
          <h3>Templates ({templates.length})</h3>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Direction</th><th>Format</th><th>Status</th></tr></thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.code}>
                  <td className="mono">{template.code}</td>
                  <td>{template.name}</td>
                  <td>{template.direction}</td>
                  <td>{template.format}</td>
                  <td><Badge tone={toneFor(template.status)}>{template.status}</Badge></td>
                </tr>
              ))}
              {!templates.length ? <tr><td colSpan={5} className="mono">No templates.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="panel">
          <h3>Exchange history ({history.length})</h3>
          <table className="table">
            <thead><tr><th>Direction</th><th>Action</th><th>Status</th><th>Job</th><th>When</th></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.direction}</td>
                  <td className="mono">{entry.action}</td>
                  <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  <td className="mono">{entry.job_ref || entry.job_id || "—"}</td>
                  <td className="mono">{entry.created_at}</td>
                </tr>
              ))}
              {!history.length ? <tr><td colSpan={5} className="mono">No history.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <ConfigRow key={key} name={key} value={value} busy={busy} onSave={(next) => run(() => dataExchange.setConfiguration(key, next), "Configuration updated.")} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function ConfigRow({ name, value, busy, onSave }) {
  const [draft, setDraft] = useState(Array.isArray(value) ? value.join(", ") : String(value));
  const isArray = Array.isArray(value);
  const isBoolean = typeof value === "boolean";
  return (
    <tr>
      <td className="mono">{name}</td>
      <td>
        {isBoolean ? (
          <select value={String(draft)} onChange={(event) => setDraft(event.target.value)}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        )}
      </td>
      <td>
        <button className="chip link-btn" disabled={busy}
          onClick={() => {
            let next = draft;
            if (isBoolean) next = draft === "true";
            else if (isArray) next = draft.split(",").map((part) => part.trim()).filter(Boolean);
            else if (typeof value === "number") next = Number(draft);
            onSave(next);
          }}>Save</button>
      </td>
    </tr>
  );
}
