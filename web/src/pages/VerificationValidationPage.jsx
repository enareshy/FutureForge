import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { verificationValidation as vv, requirements, content } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "testCases", label: "Test cases" },
  { key: "procedures", label: "Procedures & steps" },
  { key: "executions", label: "Executions & results" },
  { key: "coverage", label: "Coverage & status" },
  { key: "waivers", label: "Waivers & retest" },
  { key: "failures", label: "Failures & quality" },
  { key: "trace", label: "Traceability & impact" },
  { key: "configuration", label: "Configuration" },
];

const VERIFICATION_KINDS = ["VERIFICATION", "VALIDATION"];
const EXECUTION_FLOW = ["PLANNED", "READY", "IN_PROGRESS", "COMPLETED", "EVALUATED", "REVIEWED"];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function requirementLabel(entry) {
  if (!entry) return "-";
  return `${entry.requirement_number || entry.number || entry.requirement_ref} — ${entry.title || ""}`;
}

function statusTone(status) {
  if (["VERIFIED", "PASS", "COMPLETED", "APPROVED", "REVIEWED", "VALIDATION_COMPLETE", "ACTIVE"].includes(status)) return "ok";
  if (["FAILED", "FAIL", "REJECTED", "REVOKED", "BLOCKED"].includes(status)) return "danger";
  if (["IN_PROGRESS", "PENDING", "PARTIALLY_VERIFIED", "IN_REVIEW", "REQUESTED", "NOT_PLANNED"].includes(status)) return "warn";
  return undefined;
}

export default function VerificationValidationPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [reqItems, setReqItems] = useState([]);

  const [testCases, setTestCases] = useState([]);
  const [tcForm, setTcForm] = useState({ code: "", name: "", verification_kind: "VERIFICATION", method_code: "" });
  const [selectedTc, setSelectedTc] = useState("");
  const [tcRequirements, setTcRequirements] = useState(null);
  const [linkForm, setLinkForm] = useState({ requirement_id: "", relationship_type: "VERIFIED_BY" });

  const [procedures, setProcedures] = useState([]);
  const [procForm, setProcForm] = useState({ code: "", name: "" });
  const [selectedProc, setSelectedProc] = useState("");
  const [steps, setSteps] = useState([]);
  const [stepForm, setStepForm] = useState({ code: "", instruction: "", expected_result: "" });

  const [executions, setExecutions] = useState([]);
  const [execForm, setExecForm] = useState({ test_case_id: "", requirement_id: "" });
  const [selectedExecution, setSelectedExecution] = useState(null);
  const [results, setResults] = useState([]);
  const [resultForm, setResultForm] = useState({ requirement_id: "", actual_value: "", unit: "", operator: "eq", expected_value: "" });
  const [evidenceForm, setEvidenceForm] = useState({ content_id: "" });
  const [contents, setContents] = useState([]);

  const [coverageSummary, setCoverageSummary] = useState(null);
  const [coverageRef, setCoverageRef] = useState(searchParams.get("requirement") || "");
  const [requirementCoverage, setRequirementCoverage] = useState(null);

  const [waivers, setWaivers] = useState([]);
  const [waiverForm, setWaiverForm] = useState({ requirement_id: "", execution_ref: "", justification: "" });
  const [retestChain, setRetestChain] = useState(null);

  const [failures, setFailures] = useState([]);
  const [failureSummary, setFailureSummary] = useState(null);

  const [traceRef, setTraceRef] = useState(searchParams.get("requirement") || "");
  const [impact, setImpact] = useState(null);
  const [trace, setTrace] = useState(null);
  const [traceDirection, setTraceDirection] = useState("DOWNSTREAM");
  const [staleEvidence, setStaleEvidence] = useState(null);

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
      const [met, h, cfg, reqs, tcs, exs, ws, cs, fs, st] = await Promise.all([
        vv.meta(),
        vv.health(),
        vv.config(),
        requirements.list("?page_size=200"),
        vv.testCases("?page_size=200"),
        vv.executions("?page_size=200"),
        vv.waivers("?page_size=200"),
        vv.coverageSummary(),
        vv.failures("?page_size=200"),
        vv.staleEvidence("?page_size=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setReqItems(reqs.items || []);
      setTestCases(tcs.items || []);
      setExecutions(exs.items || []);
      setWaivers(ws.items || []);
      setCoverageSummary(cs);
      setFailures(fs.items || []);
      setStaleEvidence(st);
      const fs2 = await vv.failureSummary();
      setFailureSummary(fs2);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  useEffect(() => {
    loadBase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== "executions") return;
    content
      .list("?page_size=200")
      .then((res) => setContents(res.items || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== "procedures" || !selectedTc) return;
    vv.testCaseProcedures(selectedTc)
      .then((res) => setProcedures(res.items || []))
      .catch((err) => setError(err?.message || String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedTc]);

  async function createTestCase() {
    const created = await run(() => vv.createTestCase(tcForm), "Test case created.");
    if (created) {
      setTcForm({ code: "", name: "", verification_kind: "VERIFICATION", method_code: "" });
      await loadBase();
    }
  }

  async function transitionTestCase(ref, status) {
    await run(() => vv.transitionTestCase(ref, status), `Test case ${status}.`);
    await loadBase();
  }

  async function reviseTestCase(ref) {
    await run(() => vv.reviseTestCase(ref, {}), "Test case revised.");
    await loadBase();
  }

  async function openTestCase(ref) {
    setSelectedTc(ref);
    const [linked] = await Promise.all([vv.testCaseRequirements(ref).catch(() => null)]);
    setTcRequirements(linked);
  }

  async function linkRequirement() {
    if (!selectedTc || !linkForm.requirement_id) return;
    await run(() => vv.linkRequirement(selectedTc, linkForm), "Requirement linked.");
    setLinkForm({ requirement_id: "", relationship_type: "VERIFIED_BY" });
    await openTestCase(selectedTc);
  }

  async function createProcedure() {
    if (!selectedTc) return;
    const created = await run(() => vv.createProcedure(selectedTc, procForm), "Procedure created.");
    if (created) {
      setProcForm({ code: "", name: "" });
      const res = await vv.testCaseProcedures(selectedTc);
      setProcedures(res.items || []);
    }
  }

  async function openProcedure(ref) {
    setSelectedProc(ref);
    const res = await vv.procedureSteps(ref).catch(() => ({ items: [] }));
    setSteps(res.items || res || []);
  }

  async function addStep() {
    if (!selectedProc) return;
    await run(() => vv.addProcedureStep(selectedProc, { ...stepForm, sequence: steps.length + 1 }), "Step added.");
    setStepForm({ code: "", instruction: "", expected_result: "" });
    await openProcedure(selectedProc);
  }

  async function createExecution() {
    const body = { test_case_id: execForm.test_case_id };
    if (execForm.requirement_id) body.requirement_ids = [Number(execForm.requirement_id)];
    const created = await run(() => vv.createExecution(body), "Execution planned.");
    if (created) {
      setExecForm({ test_case_id: "", requirement_id: "" });
      await loadBase();
    }
  }

  async function openExecution(ref) {
    setSelectedExecution(ref);
    const res = await vv.results(`?execution_id=${encodeURIComponent(ref)}&page_size=200`).catch(() => ({ items: [] }));
    setResults(res.items || []);
  }

  async function advanceExecution(ref, status) {
    await run(() => vv.transitionExecution(ref, status), `Execution ${status}.`);
    await loadBase();
    await openExecution(ref);
  }

  async function recordResult() {
    if (!selectedExecution) return;
    const criteria = resultForm.operator && resultForm.expected_value !== "" ? { operator: resultForm.operator, value: resultForm.expected_value } : {};
    const body = {
      requirement_id: resultForm.requirement_id ? Number(resultForm.requirement_id) : undefined,
      actual_value: resultForm.actual_value,
      unit: resultForm.unit || undefined,
      acceptance_criteria: criteria,
    };
    await run(() => vv.recordResult(selectedExecution, body), "Result recorded.");
    setResultForm({ requirement_id: "", actual_value: "", unit: "", operator: "eq", expected_value: "" });
    await openExecution(selectedExecution);
  }

  async function evaluateExecution() {
    if (!selectedExecution) return;
    await run(() => vv.evaluateExecution(selectedExecution, {}), "Execution evaluated.");
    await loadBase();
    await openExecution(selectedExecution);
  }

  async function attachEvidence() {
    if (!selectedExecution || !evidenceForm.content_id) return;
    await run(() => vv.attachEvidence({ execution_ref: selectedExecution, content_id: Number(evidenceForm.content_id) }), "Evidence attached.");
    setEvidenceForm({ content_id: "" });
    await openExecution(selectedExecution);
  }

  async function computeCoverage() {
    if (!coverageRef) return;
    const res = await run(() => vv.requirementCoverage(coverageRef), "Coverage computed.");
    if (res) setRequirementCoverage(res);
  }

  async function recalculateCoverage() {
    if (!coverageRef) return;
    const res = await run(() => vv.recalculateRequirement(coverageRef), "Requirement status recalculated.");
    if (res) setRequirementCoverage(res);
    await loadBase();
  }

  async function createWaiver() {
    const body = { justification: waiverForm.justification };
    if (waiverForm.requirement_id) body.requirement_id = Number(waiverForm.requirement_id);
    if (waiverForm.execution_ref) body.execution_ref = waiverForm.execution_ref;
    const created = await run(() => vv.createWaiver(body), "Waiver requested.");
    if (created) {
      setWaiverForm({ requirement_id: "", execution_ref: "", justification: "" });
      await loadBase();
    }
  }

  async function transitionWaiver(ref, status) {
    await run(() => vv.transitionWaiver(ref, status), `Waiver ${status}.`);
    await loadBase();
  }

  async function showRetestChain(ref) {
    const res = await run(() => vv.retestChain(ref));
    if (res) setRetestChain(res);
  }

  async function raiseQualityException(ref) {
    await run(
      () => vv.raiseQualityException({ execution_ref: ref, severity: "error", summary: `Failure on ${ref}` }),
      "Quality exception raised."
    );
    await loadBase();
  }

  async function analyzeImpact() {
    if (!traceRef) return;
    const res = await run(() => vv.requirementImpact(traceRef));
    if (res) setImpact(res);
  }

  async function runTrace() {
    if (!traceRef) return;
    const res = await run(() => vv.requirementTrace(traceRef, `?direction=${traceDirection}`));
    if (res) setTrace(res);
  }

  async function scanStale() {
    await run(() => vv.scanStaleEvidence({}), "Stale-evidence scan executed.");
    await loadBase();
  }

  async function setConfig(key, value) {
    await run(() => vv.setConfig(key, value), `Updated ${key}.`);
    await loadBase();
  }

  const configEntries = Object.entries(configuration || {});

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Verification &amp; Validation</h1>
          <p className="subtle">
            Plan and execute verification and validation from requirement to method, test case, procedure, execution,
            result and evidence, with coverage, waivers, retest, quality hand-off and change impact — projected onto the
            shared Digital Thread and reusing the platform engines.
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
            <div className="panel grow"><h3>Test cases</h3><div className="mono">{health?.counts?.test_cases ?? testCases.length}</div></div>
            <div className="panel grow"><h3>Executions</h3><div className="mono">{health?.counts?.executions ?? executions.length}</div></div>
            <div className="panel grow"><h3>Results</h3><div className="mono">{health?.counts?.results ?? "-"}</div></div>
            <div className="panel grow"><h3>Waivers</h3><div className="mono">{health?.counts?.waivers ?? waivers.length}</div></div>
          </div>

          <div className="panel">
            <h3>Verification kinds</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              {(meta?.verification_kinds || VERIFICATION_KINDS).map((kind) => <Badge key={kind}>{kind}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Requirement V&amp;V statuses</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              {(meta?.requirement_vnv_statuses || []).map((status) => <Badge key={status} tone={statusTone(status)}>{status}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Recent test cases</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Code</th><th>Kind</th><th>Status</th><th>Rev</th></tr></thead>
              <tbody>
                {testCases.slice(0, 8).map((entry) => (
                  <tr key={entry.test_case_ref}>
                    <td className="mono">{entry.test_case_ref}</td>
                    <td>{entry.code}</td>
                    <td className="mono">{entry.verification_kind}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.revision}</td>
                  </tr>
                ))}
                {!testCases.length ? <tr><td colSpan={5} className="subtle">No test cases yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "testCases" ? (
        <>
          <div className="panel">
            <h3>Create a test case</h3>
            <div className="grid">
              <label className="field"><span>Code</span>
                <input name="code" value={tcForm.code} onChange={set(setTcForm, tcForm)} placeholder="TC-001" />
              </label>
              <label className="field grow"><span>Name</span>
                <input name="name" value={tcForm.name} onChange={set(setTcForm, tcForm)} placeholder="Functional test" />
              </label>
              <label className="field"><span>Kind</span>
                <select name="verification_kind" value={tcForm.verification_kind} onChange={set(setTcForm, tcForm)}>
                  {VERIFICATION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="field"><span>Method</span>
                <input name="method_code" value={tcForm.method_code} onChange={set(setTcForm, tcForm)} placeholder="TEST" />
              </label>
            </div>
            <button className="btn" disabled={busy || !tcForm.code || !tcForm.name} onClick={createTestCase}>Create test case</button>
          </div>

          <div className="panel">
            <h3>Test cases ({testCases.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Code</th><th>Kind</th><th>Status</th><th>Rev</th><th>Actions</th></tr></thead>
              <tbody>
                {testCases.map((entry) => (
                  <tr key={entry.test_case_ref} className={entry.test_case_ref === selectedTc ? "selected" : ""}>
                    <td className="mono">{entry.test_case_ref}</td>
                    <td>{entry.code}</td>
                    <td className="mono">{entry.verification_kind}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.revision}</td>
                    <td>
                      <div className="stack-row">
                        <button className="btn ghost" onClick={() => openTestCase(entry.test_case_ref)}>Requirements</button>
                        {entry.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => transitionTestCase(entry.test_case_ref, "IN_REVIEW")}>Submit</button> : null}
                        {entry.status === "IN_REVIEW" ? <button className="btn ghost" disabled={busy} onClick={() => transitionTestCase(entry.test_case_ref, "APPROVED")}>Approve</button> : null}
                        <button className="btn ghost" disabled={busy} onClick={() => reviseTestCase(entry.test_case_ref)}>Revise</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!testCases.length ? <tr><td colSpan={6} className="subtle">No test cases yet.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {selectedTc ? (
            <div className="panel">
              <h3>Requirement links — {selectedTc}</h3>
              <div className="grid">
                <label className="field grow"><span>Requirement</span>
                  <select name="requirement_id" value={linkForm.requirement_id} onChange={(event) => setLinkForm({ ...linkForm, requirement_id: event.target.value })}>
                    <option value="">Select a requirement…</option>
                    {reqItems.map((entry) => <option key={entry.id} value={entry.id}>{requirementLabel(entry)}</option>)}
                  </select>
                </label>
                <label className="field"><span>Relationship</span>
                  <select name="relationship_type" value={linkForm.relationship_type} onChange={(event) => setLinkForm({ ...linkForm, relationship_type: event.target.value })}>
                    <option value="VERIFIED_BY">VERIFIED_BY</option>
                    <option value="VALIDATED_BY">VALIDATED_BY</option>
                  </select>
                </label>
              </div>
              <button className="btn" disabled={busy || !linkForm.requirement_id} onClick={linkRequirement}>Link requirement</button>

              <h4>Linked requirements ({tcRequirements?.items?.length || 0})</h4>
              <table className="table">
                <thead><tr><th>Requirement</th><th>Type</th><th>Status</th></tr></thead>
                <tbody>
                  {(tcRequirements?.items || []).map((entry) => (
                    <tr key={entry.relationship_ref || entry.id}>
                      <td className="mono">{entry.requirement_ref || entry.target_id}</td>
                      <td className="mono">{entry.relationship_type}</td>
                      <td className="mono">{entry.status || "-"}</td>
                    </tr>
                  ))}
                  {!(tcRequirements?.items || []).length ? <tr><td colSpan={3} className="subtle">No linked requirements.</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "procedures" ? (
        <>
          <div className="panel">
            <h3>Procedures for a test case</h3>
            <div className="grid">
              <label className="field grow"><span>Test case</span>
                <select value={selectedTc} onChange={(event) => setSelectedTc(event.target.value)}>
                  <option value="">Select a test case…</option>
                  {testCases.map((entry) => <option key={entry.test_case_ref} value={entry.test_case_ref}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          {selectedTc ? (
            <>
              <div className="panel">
                <h3>Create a procedure</h3>
                <div className="grid">
                  <label className="field"><span>Code</span>
                    <input name="code" value={procForm.code} onChange={set(setProcForm, procForm)} placeholder="TP-001" />
                  </label>
                  <label className="field grow"><span>Name</span>
                    <input name="name" value={procForm.name} onChange={set(setProcForm, procForm)} placeholder="Procedure name" />
                  </label>
                </div>
                <button className="btn" disabled={busy || !procForm.code || !procForm.name} onClick={createProcedure}>Create procedure</button>
              </div>

              <div className="panel">
                <h3>Procedures ({procedures.length})</h3>
                <table className="table">
                  <thead><tr><th>Ref</th><th>Code</th><th>Status</th><th>Rev</th><th></th></tr></thead>
                  <tbody>
                    {procedures.map((entry) => (
                      <tr key={entry.procedure_ref} className={entry.procedure_ref === selectedProc ? "selected" : ""}>
                        <td className="mono">{entry.procedure_ref}</td>
                        <td>{entry.code}</td>
                        <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                        <td className="mono">{entry.revision}</td>
                        <td><button className="btn ghost" onClick={() => openProcedure(entry.procedure_ref)}>Steps</button></td>
                      </tr>
                    ))}
                    {!procedures.length ? <tr><td colSpan={5} className="subtle">No procedures yet.</td></tr> : null}
                  </tbody>
                </table>
              </div>

              {selectedProc ? (
                <div className="panel">
                  <h3>Steps — {selectedProc}</h3>
                  <div className="grid">
                    <label className="field"><span>Code</span>
                      <input name="code" value={stepForm.code} onChange={set(setStepForm, stepForm)} placeholder="S1" />
                    </label>
                    <label className="field grow"><span>Instruction</span>
                      <input name="instruction" value={stepForm.instruction} onChange={set(setStepForm, stepForm)} />
                    </label>
                    <label className="field grow"><span>Expected result</span>
                      <input name="expected_result" value={stepForm.expected_result} onChange={set(setStepForm, stepForm)} />
                    </label>
                  </div>
                  <button className="btn" disabled={busy || !stepForm.instruction} onClick={addStep}>Add step</button>
                  <table className="table">
                    <thead><tr><th>#</th><th>Code</th><th>Instruction</th><th>Expected</th></tr></thead>
                    <tbody>
                      {steps.map((entry) => (
                        <tr key={entry.id || entry.step_ref}>
                          <td className="mono">{entry.sequence ?? entry.step_number}</td>
                          <td className="mono">{entry.code}</td>
                          <td>{entry.instruction}</td>
                          <td className="subtle">{entry.expected_result}</td>
                        </tr>
                      ))}
                      {!steps.length ? <tr><td colSpan={4} className="subtle">No steps yet.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : <p className="subtle">Select a test case to manage procedures.</p>}
        </>
      ) : null}

      {tab === "executions" ? (
        <>
          <div className="panel">
            <h3>Plan an execution</h3>
            <div className="grid">
              <label className="field grow"><span>Test case</span>
                <select name="test_case_id" value={execForm.test_case_id} onChange={set(setExecForm, execForm)}>
                  <option value="">Select a test case…</option>
                  {testCases.map((entry) => <option key={entry.test_case_ref} value={entry.test_case_ref}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Requirement (optional)</span>
                <select name="requirement_id" value={execForm.requirement_id} onChange={set(setExecForm, execForm)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => <option key={entry.id} value={entry.id}>{requirementLabel(entry)}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !execForm.test_case_id} onClick={createExecution}>Plan execution</button>
          </div>

          <div className="panel">
            <h3>Executions ({executions.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Status</th><th>Outcome</th><th>Actions</th></tr></thead>
              <tbody>
                {executions.map((entry) => (
                  <tr key={entry.execution_ref} className={entry.execution_ref === selectedExecution ? "selected" : ""}>
                    <td className="mono">{entry.execution_ref}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td><Badge tone={statusTone(entry.overall_outcome)}>{entry.overall_outcome || "-"}</Badge></td>
                    <td>
                      <div className="stack-row">
                        <button className="btn ghost" onClick={() => openExecution(entry.execution_ref)}>Results</button>
                        {entry.status === "PLANNED" ? <button className="btn ghost" disabled={busy} onClick={() => advanceExecution(entry.execution_ref, "IN_PROGRESS")}>Start</button> : null}
                        {["IN_PROGRESS", "READY"].includes(entry.status) ? <button className="btn ghost" disabled={busy} onClick={() => advanceExecution(entry.execution_ref, "COMPLETED")}>Complete</button> : null}
                        {entry.status === "COMPLETED" ? <button className="btn ghost" disabled={busy} onClick={() => { setSelectedExecution(entry.execution_ref); evaluateExecution(); }}>Evaluate</button> : null}
                        <button className="btn ghost" disabled={busy} onClick={() => showRetestChain(entry.execution_ref)}>Retest chain</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!executions.length ? <tr><td colSpan={4} className="subtle">No executions yet.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {retestChain ? (
            <div className="panel">
              <h3>Retest chain</h3>
              <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(retestChain, null, 2)}</pre>
            </div>
          ) : null}

          {selectedExecution ? (
            <>
              <div className="panel">
                <h3>Record a result for {selectedExecution}</h3>
                <div className="grid">
                  <label className="field grow"><span>Requirement</span>
                    <select name="requirement_id" value={resultForm.requirement_id} onChange={set(setResultForm, resultForm)}>
                      <option value="">Select a requirement…</option>
                      {reqItems.map((entry) => <option key={entry.id} value={entry.id}>{requirementLabel(entry)}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Actual value</span>
                    <input name="actual_value" value={resultForm.actual_value} onChange={set(setResultForm, resultForm)} />
                  </label>
                  <label className="field"><span>Unit</span>
                    <input name="unit" value={resultForm.unit} onChange={set(setResultForm, resultForm)} placeholder="mm" />
                  </label>
                  <label className="field"><span>Operator</span>
                    <select name="operator" value={resultForm.operator} onChange={set(setResultForm, resultForm)}>
                      {["eq", "ne", "gt", "gte", "lt", "lte", "range", "in", "contains"].map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Expected</span>
                    <input name="expected_value" value={resultForm.expected_value} onChange={set(setResultForm, resultForm)} />
                  </label>
                </div>
                <button className="btn" disabled={busy || !resultForm.actual_value} onClick={recordResult}>Record result</button>
              </div>

              <div className="panel">
                <h3>Attach evidence</h3>
                <div className="grid">
                  <label className="field grow"><span>Content</span>
                    <select value={evidenceForm.content_id} onChange={(event) => setEvidenceForm({ content_id: event.target.value })}>
                      <option value="">Select content…</option>
                      {contents.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || entry.file_name || entry.id}</option>)}
                    </select>
                  </label>
                </div>
                <button className="btn" disabled={busy || !evidenceForm.content_id} onClick={attachEvidence}>Attach evidence</button>
              </div>

              <div className="panel">
                <h3>Results ({results.length})</h3>
                <table className="table">
                  <thead><tr><th>Ref</th><th>Level</th><th>Actual</th><th>Outcome</th><th>Evidence</th></tr></thead>
                  <tbody>
                    {results.map((entry) => (
                      <tr key={entry.result_ref}>
                        <td className="mono">{entry.result_ref}</td>
                        <td className="mono">{entry.result_level}</td>
                        <td className="mono">{entry.actual_value}{entry.unit ? ` ${entry.unit}` : ""}</td>
                        <td><Badge tone={statusTone(entry.outcome)}>{entry.outcome}</Badge></td>
                        <td className="mono">{entry.evidence_count}</td>
                      </tr>
                    ))}
                    {!results.length ? <tr><td colSpan={5} className="subtle">No results yet.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "coverage" ? (
        <>
          <div className="panel">
            <h3>Requirement V&amp;V coverage</h3>
            <div className="grid">
              <label className="field grow"><span>Requirement</span>
                <select value={coverageRef} onChange={(event) => setCoverageRef(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>)}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy || !coverageRef} onClick={computeCoverage}>Compute coverage</button>
              <button className="btn secondary" disabled={busy || !coverageRef} onClick={recalculateCoverage}>Recalculate status</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => vv.submitCoverageJob({}), "Coverage recalculation queued.")}>Queue tenant recalculation</button>
            </div>
          </div>

          {coverageSummary ? (
            <div className="panel">
              <h3>Coverage summary</h3>
              <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(coverageSummary, null, 2)}</pre>
            </div>
          ) : null}

          {requirementCoverage ? (
            <div className="panel">
              <h3>Coverage result</h3>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone={statusTone(requirementCoverage.vnv_status)}>{requirementCoverage.vnv_status}</Badge>
                <Badge>verification: {requirementCoverage.verification_status}</Badge>
                <Badge>validation: {requirementCoverage.validation_status}</Badge>
                <Badge>rule: {requirementCoverage.aggregation_rule}</Badge>
              </div>
              <h4>Gaps ({(requirementCoverage.gaps || []).length})</h4>
              <table className="table">
                <thead><tr><th>Test case</th><th>Kind</th><th>Outcome</th></tr></thead>
                <tbody>
                  {(requirementCoverage.gaps || []).map((entry, idx) => (
                    <tr key={idx}><td className="mono">{entry.test_case_ref}</td><td className="mono">{entry.verification_kind}</td><td className="mono">{entry.outcome}</td></tr>
                  ))}
                  {!(requirementCoverage.gaps || []).length ? <tr><td colSpan={3} className="subtle">No gaps.</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "waivers" ? (
        <>
          <div className="panel">
            <h3>Request a waiver / exception</h3>
            <div className="grid">
              <label className="field grow"><span>Requirement</span>
                <select name="requirement_id" value={waiverForm.requirement_id} onChange={set(setWaiverForm, waiverForm)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => <option key={entry.id} value={entry.id}>{requirementLabel(entry)}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Execution (optional)</span>
                <input name="execution_ref" value={waiverForm.execution_ref} onChange={set(setWaiverForm, waiverForm)} placeholder="EXE-…" />
              </label>
              <label className="field grow"><span>Justification</span>
                <input name="justification" value={waiverForm.justification} onChange={set(setWaiverForm, waiverForm)} />
              </label>
            </div>
            <button className="btn" disabled={busy || !waiverForm.justification} onClick={createWaiver}>Request waiver</button>
          </div>

          <div className="panel">
            <h3>Waivers ({waivers.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Status</th><th>Scope</th><th>Justification</th><th>Actions</th></tr></thead>
              <tbody>
                {waivers.map((entry) => (
                  <tr key={entry.waiver_ref}>
                    <td className="mono">{entry.waiver_ref}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.scope || "-"}</td>
                    <td className="subtle">{entry.justification}</td>
                    <td>
                      <div className="stack-row">
                        {entry.status === "REQUESTED" ? <button className="btn ghost" disabled={busy} onClick={() => transitionWaiver(entry.waiver_ref, "APPROVED")}>Approve</button> : null}
                        {entry.status === "REQUESTED" ? <button className="btn ghost" disabled={busy} onClick={() => transitionWaiver(entry.waiver_ref, "REJECTED")}>Reject</button> : null}
                        {entry.status === "APPROVED" ? <button className="btn ghost" disabled={busy} onClick={() => transitionWaiver(entry.waiver_ref, "REVOKED")}>Revoke</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {!waivers.length ? <tr><td colSpan={5} className="subtle">No waivers yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "failures" ? (
        <>
          <div className="panel">
            <h3>Failure summary</h3>
            <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(failureSummary, null, 2)}</pre>
          </div>
          <div className="panel">
            <h3>Failures ({failures.length})</h3>
            <table className="table">
              <thead><tr><th>Execution</th><th>Result</th><th>Requirement</th><th>Actions</th></tr></thead>
              <tbody>
                {failures.map((entry, idx) => (
                  <tr key={entry.result_ref || idx}>
                    <td className="mono">{entry.execution_ref || entry.execution_id}</td>
                    <td className="mono">{entry.result_ref || "-"}</td>
                    <td className="mono">{entry.requirement_id || "-"}</td>
                    <td>
                      <button className="btn ghost" disabled={busy} onClick={() => raiseQualityException(entry.execution_ref || entry.execution_id)}>Raise quality exception</button>
                    </td>
                  </tr>
                ))}
                {!failures.length ? <tr><td colSpan={4} className="subtle">No failures.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "trace" ? (
        <>
          <div className="panel">
            <h3>Requirement traceability &amp; impact</h3>
            <div className="grid">
              <label className="field grow"><span>Requirement</span>
                <select value={traceRef} onChange={(event) => setTraceRef(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>)}
                </select>
              </label>
              <label className="field"><span>Direction</span>
                <select value={traceDirection} onChange={(event) => setTraceDirection(event.target.value)}>
                  <option value="DOWNSTREAM">DOWNSTREAM</option>
                  <option value="UPSTREAM">UPSTREAM</option>
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy || !traceRef} onClick={runTrace}>Trace</button>
              <button className="btn secondary" disabled={busy || !traceRef} onClick={analyzeImpact}>Impact analysis</button>
              <Link className="btn secondary" to={traceRef ? `/traceability?object_type=requirement&object_id=${encodeURIComponent(traceRef)}` : "/traceability"}>Open Traceability</Link>
            </div>
          </div>

          {trace ? (
            <div className="panel">
              <h3>Trace ({trace.direction}) — {trace.node_count} nodes</h3>
              <table className="table">
                <thead><tr><th>Node</th><th>Type</th><th>Category</th><th>Depth</th></tr></thead>
                <tbody>
                  {(trace.nodes || []).map((entry) => (
                    <tr key={entry.node_ref}>
                      <td className="mono">{entry.node_ref}</td>
                      <td className="mono">{entry.object_type}</td>
                      <td className="mono">{entry.category}</td>
                      <td className="mono">{entry.depth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {impact ? (
            <div className="panel">
              <h3>Impact — {impact.impacted_count} nodes</h3>
              <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(impact.category_totals, null, 2)}</pre>
            </div>
          ) : null}

          <div className="panel">
            <h3>Stale evidence ({staleEvidence?.total ?? 0})</h3>
            <button className="btn ghost" disabled={busy} onClick={scanStale}>Scan stale evidence</button>
            <table className="table">
              <thead><tr><th>Execution</th><th>Status</th><th>Reasons</th></tr></thead>
              <tbody>
                {(staleEvidence?.items || []).map((entry) => (
                  <tr key={entry.execution_ref}>
                    <td className="mono">{entry.execution_ref}</td>
                    <td className="mono">{entry.status}</td>
                    <td className="mono">{(entry.reasons || []).join(", ")}</td>
                  </tr>
                ))}
                {!(staleEvidence?.items || []).length ? <tr><td colSpan={3} className="subtle">No stale evidence.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {configEntries.map(([key, value]) => (
                <ConfigRow key={key} configKey={key} value={value} disabled={busy} onSave={setConfig} />
              ))}
              {!configEntries.length ? <tr><td colSpan={3} className="subtle">No configuration.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ConfigRow({ configKey, value, disabled, onSave }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <tr>
      <td className="mono">{configKey}</td>
      <td><input value={draft} onChange={(event) => setDraft(event.target.value)} /></td>
      <td><button className="btn ghost" disabled={disabled} onClick={() => onSave(configKey, draft)}>Save</button></td>
    </tr>
  );
}
