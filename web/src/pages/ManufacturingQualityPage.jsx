import React, { useEffect, useState } from "react";
import { manufacturingQuality as mq, objects } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "issues", label: "Quality issues" },
  { key: "inspections", label: "Inspections" },
  { key: "actions", label: "Corrective actions" },
  { key: "readiness", label: "Release readiness" },
  { key: "summaries", label: "Summaries & metrics" },
  { key: "configuration", label: "Configuration" },
];

const ISSUE_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const ISSUE_STATUSES = ["OPEN", "INVESTIGATING", "CONTAINED", "RESOLVED", "CLOSED", "CANCELLED"];
const ISSUE_DISPOSITIONS = ["USE_AS_IS", "REWORK", "REPAIR", "SCRAP", "RETURN_TO_SUPPLIER", "SORT"];
const INSPECTION_TYPES = ["INCOMING", "IN_PROCESS", "FINAL", "AUDIT", "SUPPLIER", "PERIODIC"];
const INSPECTION_STATUSES = ["PLANNED", "IN_PROGRESS", "PASSED", "FAILED", "WAIVED", "CANCELLED"];
const ACTION_STATUSES = ["OPEN", "IN_PROGRESS", "IMPLEMENTED", "VERIFIED", "CLOSED", "CANCELLED"];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function statusTone(status) {
  if (["PASS", "PASSED", "RESOLVED", "CLOSED", "VERIFIED", "EFFECTIVE", "WAIVED", "NOT_EVALUATED"].includes(status)) {
    return status === "NOT_EVALUATED" ? "warn" : "ok";
  }
  if (["FAIL", "FAILED", "CRITICAL", "HIGH", "NOT_EFFECTIVE"].includes(status)) return "danger";
  if (["OPEN", "INVESTIGATING", "CONTAINED", "PLANNED", "IN_PROGRESS", "WARNING", "IMPLEMENTED"].includes(status)) return "warn";
  return undefined;
}

function resultTone(result) {
  if (result === "PASS") return "ok";
  if (result === "FAIL") return "danger";
  if (result === "NOT_EVALUATED") return "warn";
  return undefined;
}

function fmt(value) {
  return value === null || value === undefined || value === "" ? "–" : value;
}

export default function ManufacturingQualityPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [productOptions, setProductOptions] = useState([]);
  const [operationOptions, setOperationOptions] = useState([]);

  const [issues, setIssues] = useState([]);
  const [issueForm, setIssueForm] = useState({ code: "", title: "", severity: "HIGH", product_object_id: "", operation_object_id: "" });
  const [issueFilter, setIssueFilter] = useState({ status: "", severity: "" });
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [issueUpdate, setIssueUpdate] = useState({ status: "", disposition: "" });

  const [inspections, setInspections] = useState([]);
  const [inspectionForm, setInspectionForm] = useState({
    code: "",
    title: "",
    inspection_type: "FINAL",
    status: "PLANNED",
    product_object_id: "",
    sample_size: "",
    passed_count: "",
    failed_count: "",
  });

  const [actions, setActions] = useState([]);
  const [actionForm, setActionForm] = useState({ code: "", title: "", quality_issue_id: "", action_type: "CORRECTIVE" });
  const [actionUpdate, setActionUpdate] = useState({});
  const [selectedAction, setSelectedAction] = useState(null);

  const [readinessList, setReadinessList] = useState([]);
  const [readinessForm, setReadinessForm] = useState({ subject_type: "PRODUCT_REVISION", subject_ref: "" });
  const [readinessResult, setReadinessResult] = useState(null);

  const [productSummary, setProductSummary] = useState(null);
  const [summaryRef, setSummaryRef] = useState("");
  const [metrics, setMetrics] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [recurrence, setRecurrence] = useState(null);

  const set = (setter, state) => (event) => setter({ ...state, [event.target.name]: event.target.value });

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (message) setNotice(message);
      return result;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadBase() {
    try {
      const [met, h, cfg, prods, ops] = await Promise.all([
        mq.meta(),
        mq.health(),
        mq.config(),
        objects.list("?type=part&pageSize=200"),
        objects.list("?type=operation&pageSize=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setProductOptions(prods.items || []);
      setOperationOptions(ops.items || []);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function loadIssues() {
    const params = new URLSearchParams({ pageSize: "200" });
    if (issueFilter.status) params.set("status", issueFilter.status);
    if (issueFilter.severity) params.set("severity", issueFilter.severity);
    const res = await mq.issues(`?${params.toString()}`);
    setIssues(res.items || []);
  }

  async function loadInspections() {
    const res = await mq.inspections("?pageSize=200");
    setInspections(res.items || []);
  }

  async function loadActions() {
    const res = await mq.correctiveActions("?pageSize=200");
    setActions(res.items || []);
  }

  async function loadReadiness() {
    const res = await mq.readiness("?pageSize=200");
    setReadinessList(res.items || []);
  }

  async function loadSummaries() {
    const [m, g, r] = await Promise.all([mq.metrics(), mq.gaps(), mq.recurrence("?limit=50")]);
    setMetrics(m);
    setGaps(g);
    setRecurrence(r);
  }

  useEffect(() => {
    loadBase();
  }, []);

  useEffect(() => {
    if (tab === "issues") loadIssues().catch((err) => setError(err.message));
    if (tab === "inspections") loadInspections().catch((err) => setError(err.message));
    if (tab === "actions") loadActions().catch((err) => setError(err.message));
    if (tab === "readiness") loadReadiness().catch((err) => setError(err.message));
    if (tab === "summaries") loadSummaries().catch((err) => setError(err.message));
  }, [tab]);

  async function createIssue() {
    const body = {
      code: issueForm.code.trim(),
      title: issueForm.title.trim(),
      severity: issueForm.severity,
    };
    if (issueForm.product_object_id) body.product_object_id = Number(issueForm.product_object_id);
    if (issueForm.operation_object_id) body.operation_object_id = Number(issueForm.operation_object_id);
    const created = await run(() => mq.createIssue(body), "Quality issue created.");
    if (created) {
      setIssueForm({ code: "", title: "", severity: "HIGH", product_object_id: "", operation_object_id: "" });
      await Promise.all([loadIssues(), loadBase()]);
    }
  }

  function openIssue(entry) {
    setSelectedIssue(entry);
    setIssueUpdate({ status: entry.status, disposition: entry.disposition || "" });
  }

  async function saveIssue() {
    if (!selectedIssue) return;
    const body = { version: selectedIssue.version };
    if (issueUpdate.status) body.status = issueUpdate.status;
    if (issueUpdate.disposition) body.disposition = issueUpdate.disposition;
    const updated = await run(() => mq.updateIssue(selectedIssue.issue_ref, body), "Quality issue updated.");
    if (updated) {
      setSelectedIssue(updated);
      setIssueUpdate({ status: updated.status, disposition: updated.disposition || "" });
      await loadIssues();
    }
  }

  async function createInspection() {
    const body = {
      code: inspectionForm.code.trim(),
      title: inspectionForm.title.trim(),
      inspection_type: inspectionForm.inspection_type,
      status: inspectionForm.status,
    };
    if (inspectionForm.product_object_id) body.product_object_id = Number(inspectionForm.product_object_id);
    if (inspectionForm.sample_size) body.sample_size = Number(inspectionForm.sample_size);
    if (inspectionForm.passed_count) body.passed_count = Number(inspectionForm.passed_count);
    if (inspectionForm.failed_count) body.failed_count = Number(inspectionForm.failed_count);
    const created = await run(() => mq.createInspection(body), "Inspection recorded.");
    if (created) {
      setInspectionForm({ code: "", title: "", inspection_type: "FINAL", status: "PLANNED", product_object_id: "", sample_size: "", passed_count: "", failed_count: "" });
      await Promise.all([loadInspections(), loadBase()]);
    }
  }

  async function createAction() {
    const body = {
      code: actionForm.code.trim(),
      title: actionForm.title.trim(),
      action_type: actionForm.action_type,
      quality_issue_id: actionForm.quality_issue_id,
    };
    const created = await run(() => mq.createCorrectiveAction(body), "Corrective action created.");
    if (created) {
      setActionForm({ code: "", title: "", quality_issue_id: "", action_type: "CORRECTIVE" });
      await Promise.all([loadActions(), loadBase()]);
    }
  }

  async function saveAction() {
    if (!selectedAction) return;
    const body = { version: selectedAction.version, ...actionUpdate };
    const updated = await run(() => mq.updateCorrectiveAction(selectedAction.code, body), "Corrective action updated.");
    if (updated) {
      setSelectedAction(updated);
      setActionUpdate({});
      await loadActions();
    }
  }

  async function evaluateReadiness() {
    const body = { subject_type: readinessForm.subject_type, subject_ref: readinessForm.subject_ref };
    const result = await run(() => mq.evaluateReadiness(body), "Readiness evaluated.");
    if (result) {
      setReadinessResult(result);
      await loadReadiness();
    }
  }

  async function refreshReadiness(ref) {
    const result = await run(() => mq.readinessEvaluation(ref));
    if (result) setReadinessResult({ evaluation: result });
  }

  async function loadProductSummary() {
    if (!summaryRef) return;
    const res = await run(() => mq.productSummary(summaryRef));
    if (res) setProductSummary(res);
  }

  async function setConfigValue(key, value) {
    await run(() => mq.setConfig(key, value), `Updated ${key}.`);
    await loadBase();
  }

  const counts = health?.counts || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Manufacturing &amp; Quality Intelligence</h1>
          <p className="subtle">
            Record non-conformances, inspections and corrective actions, then evaluate deterministic release readiness
            against the authoritative BOM, Object, Content and Approval records. Every evaluation is a projection and
            never mutates the product it assesses.
          </p>
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
            <div className="panel grow"><h3>Quality issues</h3><div className="mono">{counts.issues ?? issues.length}</div></div>
            <div className="panel grow"><h3>Inspections</h3><div className="mono">{counts.inspections ?? inspections.length}</div></div>
            <div className="panel grow"><h3>Corrective actions</h3><div className="mono">{counts.corrective_actions ?? actions.length}</div></div>
            <div className="panel grow"><h3>Readiness evaluations</h3><div className="mono">{counts.readiness_evaluations ?? readinessList.length}</div></div>
          </div>

          <div className="panel">
            <h3>Vocabulary</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              {(meta?.issue_severities || ISSUE_SEVERITIES).map((entry) => <Badge key={entry} tone={statusTone(entry)}>{entry}</Badge>)}
            </div>
            <div className="stack-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {(meta?.readiness?.results || ["PASS", "WARNING", "FAIL", "NOT_EVALUATED"]).map((entry) => (
                <Badge key={entry} tone={resultTone(entry)}>{entry}</Badge>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Readiness checks</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Dimension</th><th>Severity</th><th>Description</th></tr></thead>
              <tbody>
                {(meta?.readiness?.checks || []).map((check) => (
                  <tr key={check.code}>
                    <td className="mono">{check.code}</td>
                    <td className="mono">{check.dimension}</td>
                    <td><Badge tone={statusTone(check.severity)}>{check.severity}</Badge></td>
                    <td className="subtle">{check.description}</td>
                  </tr>
                ))}
                {!(meta?.readiness?.checks || []).length ? <tr><td colSpan={4} className="subtle">No check catalogue available.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "issues" ? (
        <>
          <div className="panel">
            <h3>Create a quality issue</h3>
            <div className="grid">
              <label className="field"><span>Code</span>
                <input name="code" value={issueForm.code} onChange={set(setIssueForm, issueForm)} placeholder="QI-0001" />
              </label>
              <label className="field"><span>Severity</span>
                <select name="severity" value={issueForm.severity} onChange={set(setIssueForm, issueForm)}>
                  {(meta?.issue_severities || ISSUE_SEVERITIES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Title</span>
                <input name="title" value={issueForm.title} onChange={set(setIssueForm, issueForm)} placeholder="Porosity on housing" />
              </label>
              <label className="field grow"><span>Product</span>
                <select name="product_object_id" value={issueForm.product_object_id} onChange={set(setIssueForm, issueForm)}>
                  <option value="">Select a product…</option>
                  {productOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Operation</span>
                <select name="operation_object_id" value={issueForm.operation_object_id} onChange={set(setIssueForm, issueForm)}>
                  <option value="">None</option>
                  {operationOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !issueForm.code || !issueForm.title} onClick={createIssue}>Create issue</button>
          </div>

          <div className="panel">
            <h3>Issues ({issues.length})</h3>
            <div className="stack-row">
              <label className="field"><span>Status</span>
                <select value={issueFilter.status} onChange={(event) => setIssueFilter({ ...issueFilter, status: event.target.value })}>
                  <option value="">All</option>
                  {(meta?.issue_statuses || ISSUE_STATUSES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <label className="field"><span>Severity</span>
                <select value={issueFilter.severity} onChange={(event) => setIssueFilter({ ...issueFilter, severity: event.target.value })}>
                  <option value="">All</option>
                  {(meta?.issue_severities || ISSUE_SEVERITIES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <button className="btn ghost" disabled={busy} onClick={() => loadIssues()}>Apply</button>
            </div>
            <table className="table">
              <thead><tr><th>Code</th><th>Title</th><th>Severity</th><th>Status</th><th>Disposition</th><th></th></tr></thead>
              <tbody>
                {issues.map((entry) => (
                  <tr key={entry.issue_ref} className={selectedIssue?.issue_ref === entry.issue_ref ? "selected" : ""}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.title}</td>
                    <td><Badge tone={statusTone(entry.severity)}>{entry.severity}</Badge></td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{fmt(entry.disposition)}</td>
                    <td><button className="btn ghost" onClick={() => openIssue(entry)}>Edit</button></td>
                  </tr>
                ))}
                {!issues.length ? <tr><td colSpan={6} className="subtle">No quality issues recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {selectedIssue ? (
            <div className="panel">
              <h3>Update — {selectedIssue.code}</h3>
              <div className="grid">
                <label className="field"><span>Status</span>
                  <select value={issueUpdate.status} onChange={(event) => setIssueUpdate({ ...issueUpdate, status: event.target.value })}>
                    {(meta?.issue_statuses || ISSUE_STATUSES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </select>
                </label>
                <label className="field"><span>Disposition</span>
                  <select value={issueUpdate.disposition} onChange={(event) => setIssueUpdate({ ...issueUpdate, disposition: event.target.value })}>
                    <option value="">None</option>
                    {(meta?.issue_dispositions || ISSUE_DISPOSITIONS).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </select>
                </label>
              </div>
              <p className="subtle">A disposition is required before an issue can be resolved or closed.</p>
              <button className="btn" disabled={busy} onClick={saveIssue}>Save</button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "inspections" ? (
        <>
          <div className="panel">
            <h3>Record an inspection</h3>
            <div className="grid">
              <label className="field"><span>Code</span>
                <input name="code" value={inspectionForm.code} onChange={set(setInspectionForm, inspectionForm)} placeholder="IN-0001" />
              </label>
              <label className="field"><span>Type</span>
                <select name="inspection_type" value={inspectionForm.inspection_type} onChange={set(setInspectionForm, inspectionForm)}>
                  {(meta?.inspection_types || INSPECTION_TYPES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <label className="field"><span>Status</span>
                <select name="status" value={inspectionForm.status} onChange={set(setInspectionForm, inspectionForm)}>
                  {(meta?.inspection_statuses || INSPECTION_STATUSES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Title</span>
                <input name="title" value={inspectionForm.title} onChange={set(setInspectionForm, inspectionForm)} placeholder="Final dimensional check" />
              </label>
              <label className="field grow"><span>Product</span>
                <select name="product_object_id" value={inspectionForm.product_object_id} onChange={set(setInspectionForm, inspectionForm)}>
                  <option value="">Select a product…</option>
                  {productOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Sample size</span>
                <input name="sample_size" type="number" min="0" value={inspectionForm.sample_size} onChange={set(setInspectionForm, inspectionForm)} />
              </label>
              <label className="field"><span>Passed</span>
                <input name="passed_count" type="number" min="0" value={inspectionForm.passed_count} onChange={set(setInspectionForm, inspectionForm)} />
              </label>
              <label className="field"><span>Failed</span>
                <input name="failed_count" type="number" min="0" value={inspectionForm.failed_count} onChange={set(setInspectionForm, inspectionForm)} />
              </label>
            </div>
            <button className="btn" disabled={busy || !inspectionForm.code || !inspectionForm.title} onClick={createInspection}>Record inspection</button>
          </div>

          <div className="panel">
            <h3>Inspections ({inspections.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Type</th><th>Status</th><th>Sample</th><th>Passed</th><th>Failed</th></tr></thead>
              <tbody>
                {inspections.map((entry) => (
                  <tr key={entry.inspection_ref}>
                    <td className="mono">{entry.code}</td>
                    <td className="mono">{entry.inspection_type}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{fmt(entry.sample_size)}</td>
                    <td className="mono">{fmt(entry.passed_count)}</td>
                    <td className="mono">{fmt(entry.failed_count)}</td>
                  </tr>
                ))}
                {!inspections.length ? <tr><td colSpan={6} className="subtle">No inspections recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "actions" ? (
        <>
          <div className="panel">
            <h3>Create a corrective action</h3>
            <div className="grid">
              <label className="field"><span>Code</span>
                <input name="code" value={actionForm.code} onChange={set(setActionForm, actionForm)} placeholder="CA-0001" />
              </label>
              <label className="field"><span>Type</span>
                <select name="action_type" value={actionForm.action_type} onChange={set(setActionForm, actionForm)}>
                  {(meta?.action_types || ["CORRECTIVE", "PREVENTIVE", "CONTAINMENT"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Issue</span>
                <select name="quality_issue_id" value={actionForm.quality_issue_id} onChange={set(setActionForm, actionForm)}>
                  <option value="">Select an issue…</option>
                  {issues.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.title}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Title</span>
                <input name="title" value={actionForm.title} onChange={set(setActionForm, actionForm)} placeholder="Adjust mould temperature" />
              </label>
            </div>
            {!issues.length ? <p className="subtle">Load the Issues tab first so an issue can be selected.</p> : null}
            <button className="btn" disabled={busy || !actionForm.code || !actionForm.title || !actionForm.quality_issue_id} onClick={createAction}>Create action</button>
          </div>

          <div className="panel">
            <h3>Corrective actions ({actions.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Status</th><th>Effectiveness</th><th></th></tr></thead>
              <tbody>
                {actions.map((entry) => (
                  <tr key={entry.action_ref} className={selectedAction?.action_ref === entry.action_ref ? "selected" : ""}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.title}</td>
                    <td className="mono">{entry.action_type}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{fmt(entry.effectiveness)}</td>
                    <td><button className="btn ghost" onClick={() => { setSelectedAction(entry); setActionUpdate({ status: entry.status, effectiveness: entry.effectiveness || "" }); }}>Edit</button></td>
                  </tr>
                ))}
                {!actions.length ? <tr><td colSpan={6} className="subtle">No corrective actions recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {selectedAction ? (
            <div className="panel">
              <h3>Update — {selectedAction.code}</h3>
              <div className="grid">
                <label className="field"><span>Status</span>
                  <select value={actionUpdate.status || ""} onChange={(event) => setActionUpdate({ ...actionUpdate, status: event.target.value })}>
                    {(meta?.action_statuses || ACTION_STATUSES).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </select>
                </label>
                <label className="field"><span>Effectiveness</span>
                  <select value={actionUpdate.effectiveness || ""} onChange={(event) => setActionUpdate({ ...actionUpdate, effectiveness: event.target.value })}>
                    <option value="">None</option>
                    {(meta?.action_effectiveness || ["EFFECTIVE", "NOT_EFFECTIVE"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </select>
                </label>
              </div>
              <p className="subtle">Verifying an action requires an effectiveness of EFFECTIVE or NOT_EFFECTIVE.</p>
              <button className="btn" disabled={busy} onClick={saveAction}>Save</button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "readiness" ? (
        <>
          <div className="panel">
            <h3>Evaluate release readiness</h3>
            <div className="grid">
              <label className="field"><span>Subject type</span>
                <select name="subject_type" value={readinessForm.subject_type} onChange={set(setReadinessForm, readinessForm)}>
                  {Object.keys(meta?.subject_types || { PRODUCT_REVISION: 1, OPERATION: 1 }).map((entry) => (
                    <option key={entry} value={entry}>{entry}</option>
                  ))}
                </select>
              </label>
              <label className="field grow"><span>Subject</span>
                {readinessForm.subject_type === "OPERATION" ? (
                  <select name="subject_ref" value={readinessForm.subject_ref} onChange={set(setReadinessForm, readinessForm)}>
                    <option value="">Select an operation…</option>
                    {operationOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                  </select>
                ) : (
                  <select name="subject_ref" value={readinessForm.subject_ref} onChange={set(setReadinessForm, readinessForm)}>
                    <option value="">Select a product…</option>
                    {productOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                  </select>
                )}
              </label>
            </div>
            <button className="btn" disabled={busy || !readinessForm.subject_ref} onClick={evaluateReadiness}>Evaluate</button>
          </div>

          {readinessResult?.evaluation ? (
            <div className="panel">
              <h3>Evaluation — {readinessResult.evaluation.evaluation_ref}</h3>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone={resultTone(readinessResult.evaluation.overall_result)}>{readinessResult.evaluation.overall_result}</Badge>
                <span className="mono">score {fmt(readinessResult.evaluation.score)} / threshold {fmt(readinessResult.evaluation.threshold)}</span>
                {readinessResult.evaluation.stale ? <Badge tone="warn">STALE</Badge> : null}
              </div>
              <table className="table">
                <thead><tr><th>Check</th><th>Severity</th><th>Result</th><th>Message</th></tr></thead>
                <tbody>
                  {(readinessResult.evaluation.checks || []).map((check) => (
                    <tr key={check.code}>
                      <td className="mono">{check.code}</td>
                      <td><Badge tone={statusTone(check.severity)}>{check.severity}</Badge></td>
                      <td><Badge tone={resultTone(check.result)}>{check.result}</Badge></td>
                      <td className="subtle">{check.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="panel">
            <h3>Recent evaluations ({readinessList.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Subject</th><th>Result</th><th>Score</th><th>Stale</th><th></th></tr></thead>
              <tbody>
                {readinessList.map((entry) => (
                  <tr key={entry.evaluation_ref}>
                    <td className="mono">{entry.evaluation_ref}</td>
                    <td className="mono">{entry.subject_type}:{entry.subject_ref}</td>
                    <td><Badge tone={resultTone(entry.overall_result)}>{entry.overall_result}</Badge></td>
                    <td className="mono">{fmt(entry.score)}</td>
                    <td className="mono">{entry.stale ? "yes" : "no"}</td>
                    <td><button className="btn ghost" onClick={() => refreshReadiness(entry.evaluation_ref)}>View</button></td>
                  </tr>
                ))}
                {!readinessList.length ? <tr><td colSpan={6} className="subtle">No readiness evaluations yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "summaries" ? (
        <>
          <div className="panel">
            <h3>Product quality summary</h3>
            <div className="grid">
              <label className="field grow"><span>Product</span>
                <select value={summaryRef} onChange={(event) => setSummaryRef(event.target.value)}>
                  <option value="">Select a product…</option>
                  {productOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !summaryRef} onClick={loadProductSummary}>Load summary</button>
            {productSummary ? (
              <div className="stack-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
                <div className="panel grow"><h4>Issues</h4><div className="mono">{productSummary.issue_summary?.total ?? 0}</div></div>
                <div className="panel grow"><h4>Inspections</h4><div className="mono">{productSummary.inspection_summary?.total ?? 0}</div></div>
                <div className="panel grow"><h4>Passed</h4><div className="mono">{productSummary.inspection_summary?.passed ?? 0}</div></div>
                <div className="panel grow"><h4>Failed</h4><div className="mono">{productSummary.inspection_summary?.failed ?? 0}</div></div>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <h3>Issue metrics</h3>
            <table className="table">
              <thead><tr><th>Severity</th><th>Count</th></tr></thead>
              <tbody>
                {Object.entries(metrics?.issues_by_severity || {}).map(([severity, count]) => (
                  <tr key={severity}><td className="mono">{severity}</td><td className="mono">{count}</td></tr>
                ))}
                {!Object.keys(metrics?.issues_by_severity || {}).length ? <tr><td colSpan={2} className="subtle">No severity data.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Quality gaps</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <Badge tone="warn">Issues without inspection: {gaps?.counts?.issues_without_inspection ?? 0}</Badge>
              <Badge tone="warn">Issues without corrective action: {gaps?.counts?.issues_without_corrective_action ?? 0}</Badge>
            </div>
          </div>

          <div className="panel">
            <h3>Recurrence patterns</h3>
            <table className="table">
              <thead><tr><th>Subject</th><th>Occurrences</th></tr></thead>
              <tbody>
                {(recurrence?.patterns || []).map((pattern, index) => (
                  <tr key={index}><td className="mono">{pattern.product_object_id || pattern.operation_object_id || "-"}</td><td className="mono">{pattern.count ?? pattern.occurrences ?? "-"}</td></tr>
                ))}
                {!(recurrence?.patterns || []).length ? <tr><td colSpan={2} className="subtle">No recurring patterns observed.</td></tr> : null}
              </tbody>
            </table>
            {(recurrence?.limitations || []).length ? <p className="subtle">{recurrence.limitations.join(" ")}</p> : null}
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration || {}).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{typeof value === "object" ? JSON.stringify(value) : String(value)}</td>
                  <td>
                    <button
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => setConfigValue(key, typeof value === "boolean" ? !value : value)}
                    >
                      {typeof value === "boolean" ? "Toggle" : "Reset"}
                    </button>
                  </td>
                </tr>
              ))}
              {!Object.keys(configuration || {}).length ? <tr><td colSpan={3} className="subtle">No configuration available.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
