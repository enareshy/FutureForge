import React, { useEffect, useState } from "react";
import { standardsExchange } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "formats", label: "Formats & adapters" },
  { key: "definitions", label: "Definitions" },
  { key: "import", label: "Import" },
  { key: "export", label: "Export" },
  { key: "mappings", label: "Mappings" },
  { key: "transformations", label: "Transformations" },
  { key: "validation", label: "Validation" },
  { key: "transactions", label: "Transactions" },
  { key: "history", label: "History & errors" },
  { key: "config", label: "Configuration" },
];

const SAMPLE_PAYLOAD = `{
  "records": [
    {
      "external_id": "DEMO-1",
      "name": "Demo bracket",
      "attributes": {
        "part.number": "DEMO-1",
        "part.name": "Demo bracket",
        "part.category": "mechanical",
        "part.status": "draft"
      }
    }
  ]
}`;

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["ACTIVE", "COMPLETED", "PASSED", "AVAILABLE", "OK"].includes(status)) return "ok";
  if (["DRAFT", "PREVIEW", "PARTIAL", "WARNING", "RUNNING", "VALIDATING", "QUEUED", "PLANNED"].includes(status)) return "warn";
  if (["FAILED", "ERROR", "UNSUPPORTED", "CANCELLED"].includes(status)) return "danger";
  return undefined;
}

const emptyDefinition = { code: "", name: "", description: "", format_code: "JSON", direction: "IMPORT", target_object_type: "part" };
const emptyMapping = {
  code: "",
  name: "",
  format_code: "JSON",
  direction: "BOTH",
  source_kind: "CANONICAL",
  target_object_type: "part",
  rules: '[{"sequence":10,"target_field":"code","source_field":"external_id","mapping_type":"DIRECT"}]',
};
const emptyTransformation = {
  code: "",
  name: "",
  direction: "IMPORT",
  stage: "FIELD",
  steps: '[{"sequence":10,"target_field":"name","transformation_type":"UPPERCASE"}]',
};
const emptyProfile = {
  code: "",
  name: "",
  format_code: "JSON",
  direction: "BOTH",
  target_object_type: "part",
  levels: "FILE,STANDARDS,ENTERPRISE",
  rules: '[{"sequence":10,"level":"ENTERPRISE","target_field":"external_id","rule_type":"REQUIRED","severity":"ERROR"}]',
};

export default function StandardsExchangePage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [formats, setFormats] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [transformations, setTransformations] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [history, setHistory] = useState([]);
  const [errors, setErrors] = useState([]);

  const [definitionForm, setDefinitionForm] = useState(emptyDefinition);
  const [mappingForm, setMappingForm] = useState(emptyMapping);
  const [transformationForm, setTransformationForm] = useState(emptyTransformation);
  const [profileForm, setProfileForm] = useState(emptyProfile);
  const [importForm, setImportForm] = useState({ definition_code: "JSON_PART_IMPORT", operation: "EXECUTE", payload: SAMPLE_PAYLOAD });
  const [exportForm, setExportForm] = useState({ definition_code: "JSON_PART_EXPORT", object_type: "part" });
  const [result, setResult] = useState(null);

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
      const [met, h, m, cfg, fmts, defs, maps, trfs, vals, txns, recons, hist, errs] = await Promise.all([
        standardsExchange.meta(),
        standardsExchange.health(),
        standardsExchange.metrics(),
        standardsExchange.configuration(),
        standardsExchange.formats("?page_size=100"),
        standardsExchange.definitions("?page_size=100"),
        standardsExchange.mappings("?page_size=100"),
        standardsExchange.transformations("?page_size=100"),
        standardsExchange.validationProfiles("?page_size=100"),
        standardsExchange.transactions("?page_size=50"),
        standardsExchange.reconciliations("?page_size=50"),
        standardsExchange.history("?page_size=50"),
        standardsExchange.errors("?page_size=50"),
      ]);
      setMeta(met);
      setHealth(h);
      setMetrics(m);
      setConfiguration(cfg || {});
      setFormats(fmts.items || []);
      setDefinitions(defs.items || []);
      setMappings(maps.items || []);
      setTransformations(trfs.items || []);
      setProfiles(vals.items || []);
      setTransactions(txns.items || []);
      setReconciliations(recons.items || []);
      setHistory(hist.items || []);
      setErrors(errs.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function parseJson(value, label) {
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(`${label} must be valid JSON: ${err.message}`);
    }
  }

  async function createDefinition() {
    const created = await run(() => standardsExchange.createDefinition(definitionForm), "Definition created.");
    if (created) {
      setDefinitionForm(emptyDefinition);
      await refresh();
    }
  }

  async function publishDefinition(ref) {
    await run(() => standardsExchange.publishDefinition(ref, { change_summary: "Published from UI" }), "Definition published.");
    await refresh();
  }

  async function createMapping() {
    const rules = await parseJson(mappingForm.rules, "Mapping rules").catch((err) => {
      setError(err.message);
      return null;
    });
    if (!rules) return;
    const created = await run(() => standardsExchange.createMapping({ ...mappingForm, rules }), "Mapping created.");
    if (created) {
      setMappingForm(emptyMapping);
      await refresh();
    }
  }

  async function createTransformation() {
    const steps = await parseJson(transformationForm.steps, "Transformation steps").catch((err) => {
      setError(err.message);
      return null;
    });
    if (!steps) return;
    const created = await run(() => standardsExchange.createTransformation({ ...transformationForm, steps }), "Transformation created.");
    if (created) {
      setTransformationForm(emptyTransformation);
      await refresh();
    }
  }

  async function createProfile() {
    const rules = await parseJson(profileForm.rules, "Validation rules").catch((err) => {
      setError(err.message);
      return null;
    });
    if (!rules) return;
    const levels = String(profileForm.levels || "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const created = await run(() => standardsExchange.createValidationProfile({ ...profileForm, levels, rules }), "Validation profile created.");
    if (created) {
      setProfileForm(emptyProfile);
      await refresh();
    }
  }

  async function runOperation(direction) {
    const form = direction === "IMPORT" ? importForm : exportForm;
    const body =
      direction === "IMPORT"
        ? { direction, operation: form.operation, definition_code: form.definition_code, payload: form.payload }
        : { direction, operation: "EXECUTE", definition_code: form.definition_code, object_type: form.object_type };
    const output = await run(
      () => (direction === "IMPORT" ? standardsExchange.importRun(body) : standardsExchange.exportRun(body)),
      `${direction} submitted.`
    );
    if (output) setResult(output);
    await refresh();
  }

  async function previewOperation(direction) {
    const form = direction === "IMPORT" ? importForm : exportForm;
    const body =
      direction === "IMPORT"
        ? { direction, definition_code: form.definition_code, payload: form.payload }
        : { direction, definition_code: form.definition_code, object_type: form.object_type };
    const output = await run(
      () => (direction === "IMPORT" ? standardsExchange.importPreview(body) : standardsExchange.exportPreview(body)),
      `${direction} preview ready.`
    );
    if (output) setResult(output);
  }

  async function saveConfig(key, value) {
    await run(() => standardsExchange.setConfiguration(key, value), "Configuration saved.");
    await standardsExchange.configuration().then(setConfiguration).catch(() => {});
  }

  async function seedDemo() {
    await run(() => standardsExchange.seed(), "Demonstration seeded.");
    await refresh();
  }

  const counts = metrics?.counts || metrics || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Standards &amp; exchange</h1>
          <p className="subtle">
            Standards-based import and export (STEP, JT, PDF/A, XML, JSON, EDI, BOM and CAD) with detection, mapping,
            transformation, validation, dry-run reconciliation and full exchange history.
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
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Formats</h3><div className="mono">{counts.formats ?? formats.length}</div></div>
            <div className="panel grow"><h3>Definitions</h3><div className="mono">{counts.definitions ?? definitions.length}</div></div>
            <div className="panel grow"><h3>Mappings</h3><div className="mono">{counts.mappings ?? mappings.length}</div></div>
            <div className="panel grow"><h3>Transactions</h3><div className="mono">{counts.transactions ?? transactions.length}</div></div>
            <div className="panel grow"><h3>Errors</h3><div className="mono">{counts.errors ?? errors.length}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Adapters</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed demonstration</button>
            </div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Status</th><th>Capabilities</th></tr></thead>
              <tbody>
                {(meta?.capabilities?.adapters || []).map((adapter) => (
                  <tr key={adapter.code}>
                    <td className="mono">{adapter.code}</td>
                    <td>{adapter.name}</td>
                    <td className="mono">{adapter.category}</td>
                    <td><Badge tone={toneFor(adapter.status)}>{adapter.status}</Badge></td>
                    <td className="mono">{Object.entries(adapter.capabilities || {}).filter(([, value]) => value === true).map(([key]) => key).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Enterprise integrations</h3>
            <div className="chips">
              {(meta?.capabilities?.integrations || []).map((entry) => (
                <Badge key={entry.code}>{entry.code}</Badge>
              ))}
            </div>
            <p className="subtle">Integration is delegated to the owning platform service; Standards &amp; Exchange never re-implements object, BOM or PDM semantics.</p>
          </div>
        </>
      ) : null}

      {tab === "formats" ? (
        <>
          <div className="panel">
            <h3>Registered formats ({formats.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Standard</th><th>Version</th><th>Adapter</th><th>Status</th><th>Detection</th></tr></thead>
              <tbody>
                {formats.map((format) => (
                  <tr key={format.id}>
                    <td className="mono">{format.code}</td>
                    <td>{format.name}</td>
                    <td>{format.standard_name}</td>
                    <td className="mono">{format.standard_version}</td>
                    <td className="mono">{format.adapter_code}</td>
                    <td><Badge tone={toneFor(format.status)}>{format.status}</Badge></td>
                    <td className="mono">{(format.extensions || []).join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "definitions" ? (
        <>
          <div className="panel">
            <h3>Create a definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={definitionForm.code} onChange={(e) => setDefinitionForm({ ...definitionForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={definitionForm.name} onChange={(e) => setDefinitionForm({ ...definitionForm, name: e.target.value })} /></label>
              <label className="field"><span>Format</span>
                <select value={definitionForm.format_code} onChange={(e) => setDefinitionForm({ ...definitionForm, format_code: e.target.value })}>
                  {formats.map((format) => <option key={format.code} value={format.code}>{format.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Direction</span>
                <select value={definitionForm.direction} onChange={(e) => setDefinitionForm({ ...definitionForm, direction: e.target.value })}>
                  {(meta?.capabilities?.directions || ["IMPORT", "EXPORT", "BOTH"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Target type</span><input value={definitionForm.target_object_type} onChange={(e) => setDefinitionForm({ ...definitionForm, target_object_type: e.target.value })} /></label>
              <label className="field"><span>Description</span><input value={definitionForm.description} onChange={(e) => setDefinitionForm({ ...definitionForm, description: e.target.value })} /></label>
            </div>
            <button className="btn" disabled={busy || !definitionForm.code || !definitionForm.name} onClick={createDefinition}>Create definition</button>
          </div>
          <div className="panel">
            <h3>Definitions ({definitions.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Format</th><th>Direction</th><th>Version</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {definitions.map((definition) => (
                  <tr key={definition.id}>
                    <td className="mono">{definition.code}</td>
                    <td>{definition.name}</td>
                    <td className="mono">{definition.format_code}</td>
                    <td className="mono">{definition.direction}</td>
                    <td className="mono">{definition.version}</td>
                    <td><Badge tone={toneFor(definition.status)}>{definition.status}</Badge></td>
                    <td><button className="btn ghost" disabled={definition.status === "ACTIVE"} onClick={() => publishDefinition(definition.id)}>Publish</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "import" ? (
        <>
          <div className="panel">
            <h3>Import a payload</h3>
            <div className="grid">
              <label className="field"><span>Definition</span>
                <select value={importForm.definition_code} onChange={(e) => setImportForm({ ...importForm, definition_code: e.target.value })}>
                  <option value="">(auto-detect)</option>
                  {definitions.map((definition) => <option key={definition.id} value={definition.code}>{definition.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Operation</span>
                <select value={importForm.operation} onChange={(e) => setImportForm({ ...importForm, operation: e.target.value })}>
                  {(meta?.capabilities?.operations || ["PREVIEW", "DRY_RUN", "VALIDATE_ONLY", "EXECUTE"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Payload</span><textarea rows={12} value={importForm.payload} onChange={(e) => setImportForm({ ...importForm, payload: e.target.value })} /></label>
            <div className="stack-row">
              <button className="btn" disabled={busy} onClick={() => runOperation("IMPORT")}>Run import</button>
              <button className="btn secondary" disabled={busy} onClick={() => previewOperation("IMPORT")}>Preview</button>
            </div>
          </div>
          {result && result.direction === "IMPORT" ? <OperationResult result={result} /> : null}
        </>
      ) : null}

      {tab === "export" ? (
        <>
          <div className="panel">
            <h3>Export enterprise objects</h3>
            <div className="grid">
              <label className="field"><span>Definition</span>
                <select value={exportForm.definition_code} onChange={(e) => setExportForm({ ...exportForm, definition_code: e.target.value })}>
                  {definitions.map((definition) => <option key={definition.id} value={definition.code}>{definition.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Object type</span><input value={exportForm.object_type} onChange={(e) => setExportForm({ ...exportForm, object_type: e.target.value })} /></label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy} onClick={() => runOperation("EXPORT")}>Run export</button>
              <button className="btn secondary" disabled={busy} onClick={() => previewOperation("EXPORT")}>Preview</button>
            </div>
          </div>
          {result && result.direction === "EXPORT" ? <OperationResult result={result} /> : null}
        </>
      ) : null}

      {tab === "mappings" ? (
        <>
          <div className="panel">
            <h3>Create a mapping</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={mappingForm.code} onChange={(e) => setMappingForm({ ...mappingForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={mappingForm.name} onChange={(e) => setMappingForm({ ...mappingForm, name: e.target.value })} /></label>
              <label className="field"><span>Source kind</span>
                <select value={mappingForm.source_kind} onChange={(e) => setMappingForm({ ...mappingForm, source_kind: e.target.value })}>
                  {["STANDARD", "CANONICAL", "ENTERPRISE"].map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Target type</span><input value={mappingForm.target_object_type} onChange={(e) => setMappingForm({ ...mappingForm, target_object_type: e.target.value })} /></label>
            </div>
            <label className="field"><span>Rules (JSON)</span><textarea rows={6} value={mappingForm.rules} onChange={(e) => setMappingForm({ ...mappingForm, rules: e.target.value })} /></label>
            <button className="btn" disabled={busy || !mappingForm.code} onClick={createMapping}>Create mapping</button>
          </div>
          <div className="panel">
            <h3>Mappings ({mappings.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Source kind</th><th>Rules</th><th>Version</th><th>Status</th></tr></thead>
              <tbody>
                {mappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <td className="mono">{mapping.code}</td>
                    <td>{mapping.name}</td>
                    <td className="mono">{mapping.source_kind}</td>
                    <td className="mono">{(mapping.rules || []).length}</td>
                    <td className="mono">{mapping.version}</td>
                    <td><Badge tone={toneFor(mapping.status)}>{mapping.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "transformations" ? (
        <>
          <div className="panel">
            <h3>Create a transformation</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={transformationForm.code} onChange={(e) => setTransformationForm({ ...transformationForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={transformationForm.name} onChange={(e) => setTransformationForm({ ...transformationForm, name: e.target.value })} /></label>
              <label className="field"><span>Direction</span>
                <select value={transformationForm.direction} onChange={(e) => setTransformationForm({ ...transformationForm, direction: e.target.value })}>
                  {(meta?.capabilities?.directions || ["IMPORT", "EXPORT", "BOTH"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Steps (JSON)</span><textarea rows={6} value={transformationForm.steps} onChange={(e) => setTransformationForm({ ...transformationForm, steps: e.target.value })} /></label>
            <button className="btn" disabled={busy || !transformationForm.code} onClick={createTransformation}>Create transformation</button>
          </div>
          <div className="panel">
            <h3>Transformations ({transformations.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Stage</th><th>Steps</th><th>Version</th><th>Status</th></tr></thead>
              <tbody>
                {transformations.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.stage}</td>
                    <td className="mono">{(entry.steps || []).length}</td>
                    <td className="mono">{entry.version}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "validation" ? (
        <>
          <div className="panel">
            <h3>Create a validation profile</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={profileForm.code} onChange={(e) => setProfileForm({ ...profileForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} /></label>
              <label className="field"><span>Levels</span><input value={profileForm.levels} onChange={(e) => setProfileForm({ ...profileForm, levels: e.target.value })} /></label>
              <label className="field"><span>Target type</span><input value={profileForm.target_object_type} onChange={(e) => setProfileForm({ ...profileForm, target_object_type: e.target.value })} /></label>
            </div>
            <label className="field"><span>Rules (JSON)</span><textarea rows={6} value={profileForm.rules} onChange={(e) => setProfileForm({ ...profileForm, rules: e.target.value })} /></label>
            <button className="btn" disabled={busy || !profileForm.code} onClick={createProfile}>Create profile</button>
          </div>
          <div className="panel">
            <h3>Validation profiles ({profiles.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Levels</th><th>Rules</th><th>Status</th></tr></thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td className="mono">{profile.code}</td>
                    <td>{profile.name}</td>
                    <td className="mono">{(profile.levels || []).join(", ")}</td>
                    <td className="mono">{(profile.rules || []).length}</td>
                    <td><Badge tone={toneFor(profile.status)}>{profile.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "transactions" ? (
        <>
          <div className="panel">
            <h3>Transactions ({transactions.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Direction</th><th>Operation</th><th>Format</th><th>Status</th><th>Created</th><th>Read</th><th>Created</th><th>Failed</th></tr></thead>
              <tbody>
                {transactions.map((txn) => (
                  <tr key={txn.id}>
                    <td className="mono">{txn.transaction_ref}</td>
                    <td className="mono">{txn.direction}</td>
                    <td className="mono">{txn.operation}</td>
                    <td className="mono">{txn.format_code}</td>
                    <td><Badge tone={toneFor(txn.status)}>{txn.status}</Badge></td>
                    <td className="mono">{txn.created_at}</td>
                    <td className="mono">{txn.counts?.records_read ?? "-"}</td>
                    <td className="mono">{txn.counts?.records_created ?? "-"}</td>
                    <td className="mono">{txn.counts?.records_failed ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Reconciliations ({reconciliations.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Transaction</th><th>Read</th><th>Created</th><th>Updated</th><th>Skipped</th><th>Failed</th></tr></thead>
              <tbody>
                {reconciliations.map((recon) => (
                  <tr key={recon.id}>
                    <td className="mono">{recon.reconciliation_ref}</td>
                    <td className="mono">{recon.transaction_ref}</td>
                    <td className="mono">{recon.records_read}</td>
                    <td className="mono">{recon.records_created}</td>
                    <td className="mono">{recon.records_updated}</td>
                    <td className="mono">{recon.records_skipped}</td>
                    <td className="mono">{recon.records_failed}</td>
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
            <h3>History ({history.length})</h3>
            <table className="table">
              <thead><tr><th>Transaction</th><th>Action</th><th>Direction</th><th>Status</th><th>Summary</th><th>When</th></tr></thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.transaction_ref}</td>
                    <td className="mono">{entry.action}</td>
                    <td className="mono">{entry.direction}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td>{entry.summary}</td>
                    <td className="mono">{entry.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Errors ({errors.length})</h3>
            <table className="table">
              <thead><tr><th>Transaction</th><th>Severity</th><th>Code</th><th>Message</th><th>Status</th></tr></thead>
              <tbody>
                {errors.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.transaction_ref}</td>
                    <td className="mono">{entry.severity}</td>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.message}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
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
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{String(value)}</td>
                  <td>
                    <button
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => {
                        const next = window.prompt(`New value for ${key}`, String(value));
                        if (next !== null) saveConfig(key, next);
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
      ) : null}
    </div>
  );
}

function OperationResult({ result }) {
  return (
    <>
      <div className="stack-row" style={{ flexWrap: "wrap" }}>
        <div className="panel grow"><h3>Status</h3><div><Badge tone={toneFor(result.status)}>{result.status}</Badge></div></div>
        <div className="panel grow"><h3>Records read</h3><div className="mono">{result.counts?.records_read ?? "-"}</div></div>
        <div className="panel grow"><h3>Created</h3><div className="mono">{result.counts?.records_created ?? "-"}</div></div>
        <div className="panel grow"><h3>Failed</h3><div className="mono">{result.counts?.records_failed ?? "-"}</div></div>
        <div className="panel grow"><h3>Warnings</h3><div className="mono">{result.counts?.warnings ?? "-"}</div></div>
      </div>
      <div className="panel">
        <h3>Output</h3>
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result.output ?? result.error ?? {}, null, 2)}</pre>
      </div>
    </>
  );
}
