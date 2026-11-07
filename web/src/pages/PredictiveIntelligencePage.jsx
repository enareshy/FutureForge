import React, { useEffect, useState } from "react";
import { predictiveIntelligence as pi, objects, change } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "useCases", label: "Use cases" },
  { key: "predictions", label: "Predictions" },
  { key: "recommendations", label: "Recommendations" },
  { key: "governance", label: "Model governance" },
  { key: "monitoring", label: "Monitoring" },
  { key: "configuration", label: "Configuration" },
];

const SUBJECT_TYPES = ["PRODUCT_REVISION", "CHANGE", "OPERATION", "MBOM_REVISION"];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function riskTone(risk) {
  if (risk === "CRITICAL" || risk === "HIGH") return "danger";
  if (risk === "MEDIUM") return "warn";
  if (risk === "LOW") return "ok";
  return undefined;
}

function statusTone(status) {
  if (["ACTIVE", "ACCEPTED", "OUTCOME_RECORDED", "EXECUTED", "OK", "PASS"].includes(status)) return "ok";
  if (["STALE", "REJECTED", "FAIL", "ALERT", "DISMISSED"].includes(status)) return "danger";
  if (["GENERATED", "PRESENTED", "SUPERSEDED", "UNKNOWN", "WARN"].includes(status)) return "warn";
  return undefined;
}

function fmt(value) {
  return value === null || value === undefined || value === "" ? "–" : value;
}

export default function PredictiveIntelligencePage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [useCases, setUseCases] = useState([]);
  const [productOptions, setProductOptions] = useState([]);
  const [operationOptions, setOperationOptions] = useState([]);
  const [changeOptions, setChangeOptions] = useState([]);

  const [predictionFilter, setPredictionFilter] = useState({ use_case: "", status: "" });
  const [predictions, setPredictions] = useState([]);
  const [predictionForm, setPredictionForm] = useState({ use_case: "", subject_type: "PRODUCT_REVISION", subject_ref: "", idempotency_key: "" });
  const [selectedPrediction, setSelectedPrediction] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [feedbackForm, setFeedbackForm] = useState({ outcome: "CONFIRMED", observed_risk_category: "", idempotency_key: "" });

  const [recommendationFilter, setRecommendationFilter] = useState({ status: "" });
  const [recommendations, setRecommendations] = useState([]);
  const [generated, setGenerated] = useState(null);

  const [modelStatus, setModelStatus] = useState(null);
  const [modelRef, setModelRef] = useState("");
  const [evaluations, setEvaluations] = useState([]);
  const [evaluationForm, setEvaluationForm] = useState({
    validated: true,
    accuracy: "",
    precision: "",
    baseline_accuracy: "",
    sample_size: "",
    holdout_size: "",
    leakage_checked: true,
    time_aware: true,
    model_version: "",
    dataset_version: "",
  });

  const [monitoring, setMonitoring] = useState(null);

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
      const [met, h, cfg, ucs, prods, ops, changes] = await Promise.all([
        pi.meta(),
        pi.health(),
        pi.config(),
        pi.useCases("?pageSize=200"),
        objects.list("?type=part&pageSize=200"),
        objects.list("?type=operation&pageSize=200"),
        change.requests("?page_size=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setUseCases(ucs.items || []);
      setProductOptions(prods.items || []);
      setOperationOptions(ops.items || []);
      setChangeOptions(changes.items || []);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function loadPredictions() {
    const params = new URLSearchParams({ pageSize: "200" });
    if (predictionFilter.use_case) params.set("use_case", predictionFilter.use_case);
    if (predictionFilter.status) params.set("status", predictionFilter.status);
    const res = await pi.predictions(`?${params.toString()}`);
    setPredictions(res.items || []);
  }

  async function loadRecommendations() {
    const params = new URLSearchParams({ pageSize: "200" });
    if (recommendationFilter.status) params.set("status", recommendationFilter.status);
    const res = await pi.recommendations(`?${params.toString()}`);
    setRecommendations(res.items || []);
  }

  async function loadMonitoring() {
    const res = await pi.monitoring();
    setMonitoring(res);
  }

  useEffect(() => {
    loadBase();
  }, []);

  useEffect(() => {
    if (tab === "predictions") loadPredictions().catch((err) => setError(err.message));
    if (tab === "recommendations") loadRecommendations().catch((err) => setError(err.message));
    if (tab === "monitoring") loadMonitoring().catch((err) => setError(err.message));
  }, [tab]);

  function subjectOptions(type) {
    if (type === "CHANGE") return changeOptions.map((entry) => ({ id: entry.id, label: `${entry.request_number || entry.request_ref} — ${entry.title}` }));
    if (type === "OPERATION") return operationOptions.map((entry) => ({ id: entry.id, label: `${entry.code} — ${entry.name}` }));
    return productOptions.map((entry) => ({ id: entry.id, label: `${entry.code} — ${entry.name}` }));
  }

  async function seedUseCases() {
    const res = await run(() => pi.seedUseCases(), "Built-in use cases seeded.");
    if (res) await loadBase();
  }

  async function executePrediction() {
    const body = { use_case: predictionForm.use_case, subject_type: predictionForm.subject_type, subject_ref: predictionForm.subject_ref };
    if (predictionForm.idempotency_key) body.idempotency_key = predictionForm.idempotency_key;
    const result = await run(() => pi.executePrediction(body), "Prediction executed.");
    if (result) {
      setSelectedPrediction(result.prediction);
      setExplanation(null);
      await Promise.all([loadPredictions(), loadBase()]);
    }
  }

  async function openPrediction(entry) {
    setSelectedPrediction(entry);
    setExplanation(null);
    setGenerated(null);
    const res = await run(() => pi.explanation(entry.prediction_ref));
    if (res) setExplanation(res);
  }

  async function markStale() {
    if (!selectedPrediction) return;
    const res = await run(() => pi.markPredictionStale(selectedPrediction.prediction_ref, "Source changed"), "Prediction marked stale.");
    if (res) {
      setSelectedPrediction(res.prediction || selectedPrediction);
      await loadPredictions();
    }
  }

  async function sendFeedback() {
    if (!selectedPrediction) return;
    const body = { outcome: feedbackForm.outcome };
    if (feedbackForm.observed_risk_category) body.observed_risk_category = feedbackForm.observed_risk_category;
    if (feedbackForm.idempotency_key) body.idempotency_key = feedbackForm.idempotency_key;
    const res = await run(() => pi.recordFeedback(selectedPrediction.prediction_ref, body), "Feedback recorded.");
    if (res) setFeedbackForm({ outcome: "CONFIRMED", observed_risk_category: "", idempotency_key: "" });
  }

  async function generateRecommendations() {
    if (!selectedPrediction) return;
    const res = await run(() => pi.generateRecommendations({ prediction_ref: selectedPrediction.prediction_ref }), "Recommendations generated.");
    if (res) {
      setGenerated(res);
      await loadRecommendations();
    }
  }

  async function transitionRecommendation(entry, status) {
    const res = await run(() => pi.transitionRecommendation(entry.recommendation_ref, { status }), `Recommendation moved to ${status}.`);
    if (res) await loadRecommendations();
  }

  async function loadModelStatus(ref) {
    setModelRef(ref);
    if (!ref) return;
    const [status, evals] = await Promise.all([
      run(() => pi.modelStatus(ref)),
      run(() => pi.useCaseEvaluations(ref, "?pageSize=200")),
    ]);
    if (status) setModelStatus(status);
    if (evals) setEvaluations(evals.items || []);
  }

  async function createEvaluation() {
    if (!modelRef) return;
    const metrics = {};
    if (evaluationForm.accuracy) metrics.accuracy = Number(evaluationForm.accuracy);
    if (evaluationForm.precision) metrics.precision = Number(evaluationForm.precision);
    const baseline = {};
    if (evaluationForm.baseline_accuracy) baseline.accuracy = Number(evaluationForm.baseline_accuracy);
    const body = {
      validated: Boolean(evaluationForm.validated),
      metrics,
      baseline_metrics: baseline,
      sample_size: Number(evaluationForm.sample_size) || 0,
      holdout_size: Number(evaluationForm.holdout_size) || 0,
      leakage_checked: Boolean(evaluationForm.leakage_checked),
      time_aware: Boolean(evaluationForm.time_aware),
      model_version: evaluationForm.model_version,
      dataset_version: evaluationForm.dataset_version,
    };
    const res = await run(() => pi.createEvaluation(modelRef, body), "Evaluation recorded.");
    if (res) await loadModelStatus(modelRef);
  }

  async function setConfigValue(key, value) {
    await run(() => pi.setConfig(key, value), `Updated ${key}.`);
    await loadBase();
  }

  const counts = health?.counts || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Predictive Intelligence &amp; Recommendations</h1>
          <p className="subtle">
            Explainable risk assessments and advisory recommendations. Rule-based assessments never fabricate a
            calibrated probability; a model is only enabled after a measured, time-aware evaluation with a baseline and
            holdout. Recommendations never mutate authoritative records.
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
            <div className="panel grow"><h3>Use cases</h3><div className="mono">{counts.use_cases ?? useCases.length}</div></div>
            <div className="panel grow"><h3>Predictions</h3><div className="mono">{counts.predictions ?? predictions.length}</div></div>
            <div className="panel grow"><h3>Recommendations</h3><div className="mono">{counts.recommendations ?? recommendations.length}</div></div>
            <div className="panel grow"><h3>Evaluations</h3><div className="mono">{counts.evaluations ?? "-"}</div></div>
          </div>

          <div className="panel">
            <h3>Methods</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              {(meta?.methods || []).map((entry) => (
                <Badge key={entry.method}>{entry.method}: {entry.label}</Badge>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Dataset requirements before a model can be enabled</h3>
            <table className="table">
              <thead><tr><th>Key</th><th>Requirement</th></tr></thead>
              <tbody>
                {Object.entries(meta?.dataset_requirements || {}).map(([key, value]) => (
                  <tr key={key}><td className="mono">{key}</td><td className="subtle">{value}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Built-in use cases</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Method</th><th>Problem</th></tr></thead>
              <tbody>
                {(meta?.built_in_use_cases || []).map((entry) => (
                  <tr key={entry.code}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.method}</td>
                    <td className="mono">{entry.problem_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "useCases" ? (
        <>
          <div className="panel">
            <h3>Registered use cases ({useCases.length})</h3>
            <button className="btn" disabled={busy} onClick={seedUseCases}>Seed built-in use cases</button>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Method</th><th>Status</th><th>Ruleset</th></tr></thead>
              <tbody>
                {useCases.map((entry) => (
                  <tr key={entry.code}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.method}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.ruleset_version}</td>
                  </tr>
                ))}
                {!useCases.length ? <tr><td colSpan={5} className="subtle">No use cases registered yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "predictions" ? (
        <>
          <div className="panel">
            <h3>Execute a prediction</h3>
            <div className="grid">
              <label className="field grow"><span>Use case</span>
                <select name="use_case" value={predictionForm.use_case} onChange={set(setPredictionForm, predictionForm)}>
                  <option value="">Select a use case…</option>
                  {useCases.map((entry) => <option key={entry.code} value={entry.code}>{entry.code} — {entry.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Subject type</span>
                <select
                  name="subject_type"
                  value={predictionForm.subject_type}
                  onChange={(event) => setPredictionForm({ ...predictionForm, subject_type: event.target.value, subject_ref: "" })}
                >
                  {(meta?.subject_types ? Object.keys(meta.subject_types) : SUBJECT_TYPES).map((entry) => (
                    <option key={entry} value={entry}>{entry}</option>
                  ))}
                </select>
              </label>
              <label className="field grow"><span>Subject</span>
                <select name="subject_ref" value={predictionForm.subject_ref} onChange={set(setPredictionForm, predictionForm)}>
                  <option value="">Select a subject…</option>
                  {subjectOptions(predictionForm.subject_type).map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                  ))}
                </select>
              </label>
              <label className="field grow"><span>Idempotency key (optional)</span>
                <input name="idempotency_key" value={predictionForm.idempotency_key} onChange={set(setPredictionForm, predictionForm)} />
              </label>
            </div>
            <button className="btn" disabled={busy || !predictionForm.use_case || !predictionForm.subject_ref} onClick={executePrediction}>Run assessment</button>
          </div>

          <div className="panel">
            <h3>Prediction history ({predictions.length})</h3>
            <div className="stack-row">
              <label className="field"><span>Use case</span>
                <select value={predictionFilter.use_case} onChange={(event) => setPredictionFilter({ ...predictionFilter, use_case: event.target.value })}>
                  <option value="">All</option>
                  {useCases.map((entry) => <option key={entry.code} value={entry.code}>{entry.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Status</span>
                <select value={predictionFilter.status} onChange={(event) => setPredictionFilter({ ...predictionFilter, status: event.target.value })}>
                  <option value="">All</option>
                  {(meta?.prediction_statuses || ["ACTIVE", "STALE", "SUPERSEDED"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
              <button className="btn ghost" disabled={busy} onClick={() => loadPredictions()}>Apply</button>
            </div>
            <table className="table">
              <thead><tr><th>Ref</th><th>Use case</th><th>Subject</th><th>Risk</th><th>Method</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {predictions.map((entry) => (
                  <tr key={entry.prediction_ref} className={selectedPrediction?.prediction_ref === entry.prediction_ref ? "selected" : ""}>
                    <td className="mono">{entry.prediction_ref}</td>
                    <td className="mono">{entry.use_case_code}</td>
                    <td className="mono">{entry.subject_type}:{entry.subject_ref}</td>
                    <td><Badge tone={riskTone(entry.risk_category)}>{entry.risk_category}</Badge></td>
                    <td className="mono">{entry.method}</td>
                    <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => openPrediction(entry)}>Explain</button></td>
                  </tr>
                ))}
                {!predictions.length ? <tr><td colSpan={7} className="subtle">No predictions recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {selectedPrediction ? (
            <>
              <div className="panel">
                <h3>Explanation — {selectedPrediction.prediction_ref}</h3>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <Badge tone={riskTone(selectedPrediction.risk_category)}>{selectedPrediction.risk_category}</Badge>
                  <Badge>{selectedPrediction.method_label}</Badge>
                  <Badge tone={selectedPrediction.calibrated_probability ? "ok" : "warn"}>
                    calibrated probability: {selectedPrediction.calibrated_probability ? "yes" : "no"}
                  </Badge>
                  <span className="mono">confidence {fmt(selectedPrediction.confidence)}</span>
                  <span className="mono">expires {fmt(selectedPrediction.freshness_expires_at)}</span>
                </div>
                <p className="subtle">{selectedPrediction.explanation}</p>
                <div className="stack-row">
                  <button className="btn ghost" disabled={busy} onClick={markStale}>Mark stale</button>
                  <button className="btn" disabled={busy} onClick={generateRecommendations}>Generate recommendations</button>
                </div>
              </div>

              <div className="panel">
                <h3>Evidence</h3>
                <table className="table">
                  <thead><tr><th>Source</th><th>Detail</th><th>Value</th></tr></thead>
                  <tbody>
                    {(explanation?.evidence || selectedPrediction.evidence || []).map((item, index) => (
                      <tr key={index}>
                        <td className="mono">{item.source}</td>
                        <td className="subtle">{item.detail}</td>
                        <td className="mono">{fmt(item.value)}</td>
                      </tr>
                    ))}
                    {!(explanation?.evidence || selectedPrediction.evidence || []).length ? <tr><td colSpan={3} className="subtle">No evidence cited.</td></tr> : null}
                  </tbody>
                </table>
                {selectedPrediction.uncertainty?.statement ? (
                  <p className="subtle">Uncertainty ({selectedPrediction.uncertainty.kind}): {selectedPrediction.uncertainty.statement}</p>
                ) : null}
                {(selectedPrediction.limitations || []).length ? (
                  <p className="subtle">Limitations: {selectedPrediction.limitations.join(" ")}</p>
                ) : null}
              </div>

              <div className="panel">
                <h3>Record observed outcome</h3>
                <div className="grid">
                  <label className="field"><span>Outcome</span>
                    <select name="outcome" value={feedbackForm.outcome} onChange={set(setFeedbackForm, feedbackForm)}>
                      <option value="CONFIRMED">CONFIRMED</option>
                      <option value="REFUTED">REFUTED</option>
                      <option value="PARTIAL">PARTIAL</option>
                      <option value="UNKNOWN">UNKNOWN</option>
                    </select>
                  </label>
                  <label className="field"><span>Observed risk</span>
                    <select name="observed_risk_category" value={feedbackForm.observed_risk_category} onChange={set(setFeedbackForm, feedbackForm)}>
                      <option value="">None</option>
                      {(meta?.risk_categories || ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                    </select>
                  </label>
                  <label className="field grow"><span>Idempotency key</span>
                    <input name="idempotency_key" value={feedbackForm.idempotency_key} onChange={set(setFeedbackForm, feedbackForm)} />
                  </label>
                </div>
                <button className="btn" disabled={busy} onClick={sendFeedback}>Record feedback</button>
              </div>

              {generated ? (
                <div className="panel">
                  <h3>Generated recommendations ({generated.count})</h3>
                  <table className="table">
                    <thead><tr><th>Title</th><th>Priority</th><th>Status</th><th>Reason</th></tr></thead>
                    <tbody>
                      {generated.recommendations.map((entry) => (
                        <tr key={entry.recommendation_ref}>
                          <td>{entry.title}</td>
                          <td className="mono">{entry.priority}</td>
                          <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                          <td className="subtle">{entry.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {tab === "recommendations" ? (
        <div className="panel">
          <h3>Recommendations ({recommendations.length})</h3>
          <div className="stack-row">
            <label className="field"><span>Status</span>
              <select value={recommendationFilter.status} onChange={(event) => setRecommendationFilter({ ...recommendationFilter, status: event.target.value })}>
                <option value="">All</option>
                {(meta?.recommendation_statuses || ["GENERATED", "PRESENTED", "ACCEPTED", "REJECTED", "DISMISSED", "EXECUTED", "OUTCOME_RECORDED"]).map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </select>
            </label>
            <button className="btn ghost" disabled={busy} onClick={() => loadRecommendations()}>Apply</button>
          </div>
          <table className="table">
            <thead><tr><th>Title</th><th>Priority</th><th>Status</th><th>Reason</th><th>Actions</th></tr></thead>
            <tbody>
              {recommendations.map((entry) => (
                <tr key={entry.recommendation_ref}>
                  <td>{entry.title}</td>
                  <td className="mono">{entry.priority}</td>
                  <td><Badge tone={statusTone(entry.status)}>{entry.status}</Badge></td>
                  <td className="subtle">{entry.reason}</td>
                  <td>
                    <div className="stack-row">
                      {(entry.allowed_transitions || []).map((status) => (
                        <button key={status} className="btn ghost" disabled={busy} onClick={() => transitionRecommendation(entry, status)}>{status}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!recommendations.length ? <tr><td colSpan={5} className="subtle">No recommendations yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "governance" ? (
        <>
          <div className="panel">
            <h3>Model status</h3>
            <div className="grid">
              <label className="field grow"><span>Use case</span>
                <select value={modelRef} onChange={(event) => loadModelStatus(event.target.value)}>
                  <option value="">Select a use case…</option>
                  {useCases.map((entry) => <option key={entry.code} value={entry.code}>{entry.code}</option>)}
                </select>
              </label>
            </div>
            {modelStatus ? (
              <div className="stack-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
                <Badge tone={modelStatus.ml_enabled ? "ok" : "warn"}>ML enabled: {String(modelStatus.ml_enabled)}</Badge>
                <Badge tone={modelStatus.validated ? "ok" : "warn"}>validated: {String(modelStatus.validated)}</Badge>
                <span className="subtle">{modelStatus.reason}</span>
              </div>
            ) : null}
          </div>

          {modelRef ? (
            <div className="panel">
              <h3>Record an evaluation — {modelRef}</h3>
              <p className="subtle">
                A model cannot be marked validated without measured metrics, a baseline, a holdout, leakage checking and
                time-awareness. Rule-based use cases remain rule-based even after an evaluation is recorded.
              </p>
              <div className="grid">
                <label className="field"><span>Accuracy</span>
                  <input name="accuracy" type="number" step="0.01" value={evaluationForm.accuracy} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Precision</span>
                  <input name="precision" type="number" step="0.01" value={evaluationForm.precision} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Baseline accuracy</span>
                  <input name="baseline_accuracy" type="number" step="0.01" value={evaluationForm.baseline_accuracy} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Sample size</span>
                  <input name="sample_size" type="number" min="0" value={evaluationForm.sample_size} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Holdout size</span>
                  <input name="holdout_size" type="number" min="0" value={evaluationForm.holdout_size} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Model version</span>
                  <input name="model_version" value={evaluationForm.model_version} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
                <label className="field"><span>Dataset version</span>
                  <input name="dataset_version" value={evaluationForm.dataset_version} onChange={set(setEvaluationForm, evaluationForm)} />
                </label>
              </div>
              <div className="stack-row">
                <label className="field"><span>Leakage checked</span>
                  <input type="checkbox" checked={evaluationForm.leakage_checked} onChange={(event) => setEvaluationForm({ ...evaluationForm, leakage_checked: event.target.checked })} />
                </label>
                <label className="field"><span>Time aware</span>
                  <input type="checkbox" checked={evaluationForm.time_aware} onChange={(event) => setEvaluationForm({ ...evaluationForm, time_aware: event.target.checked })} />
                </label>
              </div>
              <button className="btn" disabled={busy} onClick={createEvaluation}>Record evaluation</button>

              <h4>Evaluations ({evaluations.length})</h4>
              <table className="table">
                <thead><tr><th>Ref</th><th>Validated</th><th>Sample</th><th>Holdout</th><th>Model</th></tr></thead>
                <tbody>
                  {evaluations.map((entry) => (
                    <tr key={entry.evaluation_ref || entry.id}>
                      <td className="mono">{entry.evaluation_ref || entry.id}</td>
                      <td><Badge tone={entry.validated ? "ok" : "warn"}>{String(entry.validated)}</Badge></td>
                      <td className="mono">{fmt(entry.sample_size)}</td>
                      <td className="mono">{fmt(entry.holdout_size)}</td>
                      <td className="mono">{fmt(entry.model_version)}</td>
                    </tr>
                  ))}
                  {!evaluations.length ? <tr><td colSpan={5} className="subtle">No evaluations recorded.</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "monitoring" ? (
        <>
          <div className="panel">
            <h3>Freshness</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <Badge>total: {monitoring?.freshness?.total ?? "-"}</Badge>
              <Badge tone={(monitoring?.freshness?.stale_total || 0) > 0 ? "warn" : "ok"}>stale: {monitoring?.freshness?.stale_total ?? "-"}</Badge>
            </div>
          </div>

          <div className="panel">
            <h3>Drift</h3>
            <div className="stack-row">
              <Badge tone={monitoring?.drift?.status === "ALERT" ? "danger" : monitoring?.drift?.status === "UNKNOWN" ? "warn" : "ok"}>
                {monitoring?.drift?.status || "UNKNOWN"}
              </Badge>
              {monitoring?.drift?.statement ? <span className="subtle">{monitoring.drift.statement}</span> : null}
            </div>
          </div>

          <div className="panel">
            <h3>Models</h3>
            <table className="table">
              <thead><tr><th>Use case</th><th>ML enabled</th><th>Validated</th><th>Reason</th></tr></thead>
              <tbody>
                {(monitoring?.models || []).map((entry) => (
                  <tr key={entry.use_case_code || entry.code}>
                    <td className="mono">{entry.use_case_code || entry.code}</td>
                    <td className="mono">{String(entry.ml_enabled)}</td>
                    <td className="mono">{String(entry.validated)}</td>
                    <td className="subtle">{entry.reason}</td>
                  </tr>
                ))}
                {!(monitoring?.models || []).length ? <tr><td colSpan={4} className="subtle">No models reported.</td></tr> : null}
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
              {Object.entries(configuration || {}).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{String(value)}</td>
                  <td>
                    <button className="btn ghost" disabled={busy} onClick={() => setConfigValue(key, value)}>Reset</button>
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
