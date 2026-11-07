import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

const TABS = [
  "Overview",
  "Predictions",
  "Recommendations",
  "Models",
  "Features",
  "Datasets",
  "Analytics",
  "Schedules",
];

const PREDICTION_TYPES = [
  "defect_risk",
  "repeat_nonconformance_risk",
  "part_quality_risk",
  "supplier_quality_risk",
  "plant_quality_risk",
  "work_centre_quality_risk",
  "capa_overdue_risk",
  "capa_effectiveness",
  "quality_anomaly",
  "process_deviation_risk",
  "operation_quality_risk",
  "work_centre_bottleneck",
  "manufacturing_anomaly",
  "production_trend",
  "resource_risk",
  "bom_inconsistency_risk",
  "product_completeness_risk",
  "component_obsolescence_risk",
  "change_impact_risk",
  "downstream_manufacturing_risk",
  "component_issue_risk",
  "product_quality_exposure",
];

const SUBJECT_TYPES = [
  "product_item",
  "product_revision",
  "bom_header",
  "plant",
  "work_centre",
  "process",
  "operation",
  "quality_issue",
  "supplier",
  "change",
  "component",
];

const ANALYTICS_KINDS = [
  "risk_by_type",
  "risk_register",
  "risk_by_category",
  "risk_by_subject",
  "prediction_history",
  "recommendations_by_status",
  "recommendations_overdue",
  "feature_freshness",
];

const METHOD_LABELS = {
  rule_based: "Rule-based",
  statistical: "Statistical",
  ml: "Machine learning",
  llm_explanation: "LLM explanation",
};

const TONES = {
  active: "succeeded",
  stale: "pending",
  superseded: "deprecated",
  insufficient_data: "disabled",
  accepted: "succeeded",
  completed: "succeeded",
  rejected: "locked",
  deferred: "pending",
  under_review: "pending",
  new: "draft",
  cancelled: "disabled",
  critical: "locked",
  high: "locked",
  medium: "pending",
  low: "succeeded",
  unknown: "draft",
  draft: "draft",
  deprecated: "deprecated",
  retired: "disabled",
  ready: "succeeded",
  archived: "disabled",
};

function toneFor(value) {
  return TONES[value];
}

function Badge({ value }) {
  return (
    <span className={`badge${toneFor(value) ? ` ${toneFor(value)}` : ""}`}>
      {value || "-"}
    </span>
  );
}

function Table({ columns, rows, empty, keyField = "id" }) {
  if (!rows?.length) return <p className="subtle">{empty || "No rows."}</p>;
  return (
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row[keyField] ?? index}>
            {columns.map((col) => (
              <td key={col.key} className={col.mono ? "mono" : undefined}>
                {col.render ? col.render(row) : row[col.key] ?? "-"}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function AiPredictiveIntelligencePage() {
  const [tab, setTab] = useState("Overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState(null);
  const [performance, setPerformance] = useState(null);

  const [predictions, setPredictions] = useState([]);
  const [predictionFilters, setPredictionFilters] = useState({
    prediction_type: "",
    subject_type: "",
    subject_id: "",
    risk_category: "",
    status: "",
  });
  const [selectedPrediction, setSelectedPrediction] = useState(null);
  const [explanation, setExplanation] = useState(null);

  const [runForm, setRunForm] = useState({
    prediction_type: "defect_risk",
    subject_type: "product_item",
    subject_id: "",
    subject_key: "",
    model_key: "",
    observation_window_days: "90",
  });

  const [recommendations, setRecommendations] = useState([]);
  const [recommendationFilters, setRecommendationFilters] = useState({
    status: "",
    severity: "",
    priority: "",
    overdue_only: false,
  });
  const [selectedRecommendation, setSelectedRecommendation] = useState(null);
  const [feedback, setFeedback] = useState([]);
  const [reviewNote, setReviewNote] = useState("");

  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelVersions, setModelVersions] = useState([]);
  const [modelPerfKey, setModelPerfKey] = useState("");
  const [modelPerf, setModelPerf] = useState(null);

  const [features, setFeatures] = useState([]);
  const [featureValues, setFeatureValues] = useState([]);
  const [featureStatus, setFeatureStatus] = useState(null);
  const [featureKeyFilter, setFeatureKeyFilter] = useState("");

  const [datasets, setDatasets] = useState([]);
  const [selectedDataset, setSelectedDataset] = useState(null);
  const [datasetVersions, setDatasetVersions] = useState([]);

  const [analyticsKind, setAnalyticsKind] = useState("risk_by_type");
  const [analytics, setAnalytics] = useState(null);

  const [schedules, setSchedules] = useState([]);
  const [scheduleForm, setScheduleForm] = useState({
    schedule_key: "",
    prediction_type: "defect_risk",
    subject_type: "product_item",
    interval_seconds: "86400",
  });

  async function guard(fn) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadOverview() {
    const [statsData, perfData] = await Promise.all([
      guard(() => ai.predictiveStats()),
      guard(() => ai.predictiveModelPerformance()),
    ]);
    if (statsData) setStats(statsData);
    if (perfData) setPerformance(perfData);
  }

  async function loadPredictions() {
    const params = { limit: 50 };
    Object.entries(predictionFilters).forEach(([key, value]) => {
      if (value !== "") params[key] = key === "subject_id" ? Number(value) : value;
    });
    const page = await guard(() => ai.predictions(params));
    if (page) setPredictions(page.items || []);
  }

  async function selectPrediction(prediction) {
    setSelectedPrediction(prediction);
    setExplanation(null);
  }

  async function explainPrediction() {
    if (!selectedPrediction) return;
    const data = await guard(() =>
      ai.predictionExplanation(selectedPrediction.id),
    );
    if (data) setExplanation(data);
  }

  async function runPrediction(e) {
    e.preventDefault();
    const subjectId = toNumber(runForm.subject_id);
    if (!subjectId) {
      setError("A numeric subject id is required.");
      return;
    }
    const body = {
      prediction_type: runForm.prediction_type,
      subject_type: runForm.subject_type,
      subject_id: subjectId,
      observation_window_days: toNumber(runForm.observation_window_days) || 90,
    };
    if (runForm.subject_key) body.subject_key = runForm.subject_key;
    if (runForm.model_key) body.model_key = runForm.model_key;
    const data = await guard(() => ai.runPrediction(body));
    if (data) {
      setSelectedPrediction(data);
      setExplanation(null);
      await loadPredictions();
    }
  }

  async function markStale() {
    const data = await guard(() => ai.markPredictionsStale({ limit: 200 }));
    if (data) {
      await loadPredictions();
      await loadOverview();
    }
  }

  async function loadRecommendations() {
    const params = { limit: 50 };
    if (recommendationFilters.status) params.status = recommendationFilters.status;
    if (recommendationFilters.severity) params.severity = recommendationFilters.severity;
    if (recommendationFilters.priority) params.priority = recommendationFilters.priority;
    if (recommendationFilters.overdue_only) params.overdue_only = true;
    const page = await guard(() => ai.recommendations(params));
    if (page) setRecommendations(page.items || []);
  }

  async function selectRecommendation(recommendation) {
    setSelectedRecommendation(recommendation);
    setFeedback([]);
    setReviewNote("");
    const rows = await guard(() =>
      ai.recommendationFeedback(recommendation.id, { limit: 100 }),
    );
    if (rows) setFeedback(rows);
  }

  async function review(decision) {
    if (!selectedRecommendation) return;
    const body = { decision, comment: reviewNote };
    const updated = await guard(() =>
      ai.addRecommendationFeedback(selectedRecommendation.id, body),
    );
    if (updated) {
      setReviewNote("");
      const rows = await guard(() =>
        ai.recommendationFeedback(selectedRecommendation.id, { limit: 100 }),
      );
      if (rows) setFeedback(rows);
      await loadRecommendations();
      const refreshed = await guard(() =>
        ai.recommendation(selectedRecommendation.id),
      );
      if (refreshed) setSelectedRecommendation(refreshed);
      await loadOverview();
    }
  }

  async function generateRecommendations() {
    const rows = await guard(() =>
      ai.generateRecommendations({ max_recommendations: 10 }),
    );
    if (rows) {
      await loadRecommendations();
      await loadOverview();
    }
  }

  async function loadModels() {
    const page = await guard(() => ai.predictiveModels({ limit: 50 }));
    if (page) setModels(page.items || []);
  }

  async function selectModel(model) {
    setSelectedModel(model);
    setModelVersions([]);
    const rows = await guard(() => ai.predictiveModelVersions(model.id));
    if (rows) setModelVersions(rows);
  }

  async function loadModelPerformance() {
    const params = {};
    if (modelPerfKey) params.model_key = modelPerfKey;
    const data = await guard(() => ai.predictiveModelPerformance(params));
    if (data) setModelPerf(data);
  }

  async function loadFeatures() {
    const params = { limit: 50 };
    if (featureKeyFilter) params.entity_type = featureKeyFilter;
    const page = await guard(() => ai.predictiveFeatures(params));
    if (page) setFeatures(page.items || []);
    const values = await guard(() =>
      ai.predictiveFeatureValues(
        featureKeyFilter ? { feature_key: featureKeyFilter, limit: 50 } : { limit: 50 },
      ),
    );
    if (values) setFeatureValues(values.items || []);
  }

  async function inspectFeature(feature) {
    const status = await guard(() =>
      ai.predictiveFeatureStatus(feature.feature_key),
    );
    if (status) setFeatureStatus(status);
  }

  async function loadDatasets() {
    const page = await guard(() => ai.predictiveDatasets({ limit: 50 }));
    if (page) setDatasets(page.items || []);
  }

  async function selectDataset(dataset) {
    setSelectedDataset(dataset);
    setDatasetVersions([]);
    const rows = await guard(() =>
      ai.predictiveDatasetVersions(dataset.id),
    );
    if (rows) setDatasetVersions(rows);
  }

  async function loadAnalytics() {
    const data = await guard(() => ai.predictionAnalytics(analyticsKind));
    if (data) setAnalytics(data);
  }

  async function loadSchedules() {
    const page = await guard(() => ai.predictiveSchedules({ limit: 50 }));
    if (page) setSchedules(page.items || []);
  }

  async function createSchedule(e) {
    e.preventDefault();
    if (!scheduleForm.schedule_key) {
      setError("A schedule key is required.");
      return;
    }
    const body = {
      schedule_key: scheduleForm.schedule_key,
      prediction_type: scheduleForm.prediction_type,
      subject_type: scheduleForm.subject_type,
      interval_seconds: toNumber(scheduleForm.interval_seconds) || 86400,
    };
    const created = await guard(() => ai.upsertPredictiveSchedule(body));
    if (created) {
      setScheduleForm({
        schedule_key: "",
        prediction_type: "defect_risk",
        subject_type: "product_item",
        interval_seconds: "86400",
      });
      await loadSchedules();
    }
  }

  async function toggleSchedule(schedule) {
    const updated = await guard(() =>
      ai.updatePredictiveSchedule(schedule.id, { enabled: !schedule.enabled }),
    );
    if (updated) await loadSchedules();
  }

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "Predictions" && !predictions.length) loadPredictions();
    if (tab === "Recommendations" && !recommendations.length) loadRecommendations();
    if (tab === "Models" && !models.length) loadModels();
    if (tab === "Features") loadFeatures();
    if (tab === "Datasets" && !datasets.length) loadDatasets();
    if (tab === "Schedules" && !schedules.length) loadSchedules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Predictive intelligence &amp; recommendations</h1>
          <p className="sub">
            Tenant-scoped risk predictions, recommendation review lifecycle and
            prediction schedules. Every prediction records the method that
            produced it and is never presented as a confirmed fact; results
            without sufficient evidence are marked insufficient data.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {stats ? (
        <div className="row" style={{ gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
          <div><span className="muted">Feature values</span> <strong>{stats.feature_values}</strong></div>
          <div><span className="muted">Stale values</span> <strong>{stats.stale_feature_values}</strong></div>
          <div><span className="muted">Models</span> <strong>{stats.models}</strong></div>
          <div><span className="muted">Predictions</span> <strong>{stats.predictions}</strong></div>
          <div><span className="muted">Active</span> <strong>{stats.active_predictions}</strong></div>
          <div><span className="muted">Insufficient data</span> <strong>{stats.insufficient_data_predictions}</strong></div>
          <div><span className="muted">Open recommendations</span> <strong>{stats.open_recommendations}</strong></div>
          <div><span className="muted">Risk reduced</span> <strong>{stats.reduced_risk_recommendations}</strong></div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "" : "ghost"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Platform summary</h3>
              <button className="btn ghost" onClick={loadOverview} disabled={busy}>
                Refresh
              </button>
            </div>
            {stats ? (
              <ul className="detail-list">
                <li>Feature definitions: {stats.feature_definitions}</li>
                <li>Feature values: {stats.feature_values}</li>
                <li>Stale feature values: {stats.stale_feature_values}</li>
                <li>Datasets: {stats.datasets}</li>
                <li>Models: {stats.models}</li>
                <li>Predictions: {stats.predictions}</li>
                <li>Active predictions: {stats.active_predictions}</li>
                <li>Insufficient data: {stats.insufficient_data_predictions}</li>
                <li>Recommendations: {stats.recommendations}</li>
                <li>Open recommendations: {stats.open_recommendations}</li>
                <li>Accepted recommendations: {stats.accepted_recommendations}</li>
                <li>Risk reduced: {stats.reduced_risk_recommendations}</li>
                <li>Schedules: {stats.schedules}</li>
              </ul>
            ) : (
              <p className="subtle">Load summary statistics.</p>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Model performance</h3>
              <button className="btn ghost" onClick={loadOverview} disabled={busy}>
                Refresh
              </button>
            </div>
            {performance ? (
              <>
                <ul className="detail-list">
                  <li>Predictions considered: {performance.prediction_count}</li>
                  <li>Active: {performance.active_count}</li>
                  <li>Stale: {performance.stale_count}</li>
                  <li>Insufficient data: {performance.insufficient_data_count}</li>
                  <li>
                    Monitored metrics:{" "}
                    {performance.monitored_metrics ? "yes" : "no"}
                  </li>
                </ul>
                {performance.note ? (
                  <p className="subtle">{performance.note}</p>
                ) : null}
                <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                  {Object.entries(performance.risk_distribution || {}).map(
                    ([risk, count]) => (
                      <span key={risk} className="muted">
                        <Badge value={risk} /> {count}
                      </span>
                    ),
                  )}
                </div>
              </>
            ) : (
              <p className="subtle">Load model performance.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Predictions" ? (
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Run a prediction</h3></div>
            <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={runPrediction}>
              <select
                value={runForm.prediction_type}
                onChange={(e) =>
                  setRunForm({ ...runForm, prediction_type: e.target.value })
                }
              >
                {PREDICTION_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <select
                value={runForm.subject_type}
                onChange={(e) =>
                  setRunForm({ ...runForm, subject_type: e.target.value })
                }
              >
                {SUBJECT_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <input
                placeholder="Subject id"
                value={runForm.subject_id}
                onChange={(e) => setRunForm({ ...runForm, subject_id: e.target.value })}
                style={{ width: 120 }}
              />
              <input
                placeholder="Subject key (optional)"
                value={runForm.subject_key}
                onChange={(e) => setRunForm({ ...runForm, subject_key: e.target.value })}
              />
              <input
                placeholder="Model key (optional)"
                value={runForm.model_key}
                onChange={(e) => setRunForm({ ...runForm, model_key: e.target.value })}
              />
              <input
                placeholder="Window days"
                value={runForm.observation_window_days}
                onChange={(e) =>
                  setRunForm({ ...runForm, observation_window_days: e.target.value })
                }
                style={{ width: 110 }}
              />
              <button className="btn" disabled={busy}>Predict</button>
            </form>
            <p className="subtle" style={{ marginTop: 8 }}>
              Predictions are advisory. The response records its method,
              uncertainty and, when evidence is insufficient, an explicit
              insufficient data status.
            </p>
          </div>

          <div className="split">
            <div className="panel">
              <div className="panel-head">
                <h3>Predictions</h3>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn ghost" onClick={loadPredictions} disabled={busy}>
                    Refresh
                  </button>
                  <button className="btn ghost" onClick={markStale} disabled={busy}>
                    Mark stale
                  </button>
                </div>
              </div>
              <form
                className="row"
                style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  loadPredictions();
                }}
              >
                <select
                  value={predictionFilters.prediction_type}
                  onChange={(e) =>
                    setPredictionFilters({
                      ...predictionFilters,
                      prediction_type: e.target.value,
                    })
                  }
                >
                  <option value="">All types</option>
                  {PREDICTION_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <select
                  value={predictionFilters.subject_type}
                  onChange={(e) =>
                    setPredictionFilters({
                      ...predictionFilters,
                      subject_type: e.target.value,
                    })
                  }
                >
                  <option value="">All subjects</option>
                  {SUBJECT_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  placeholder="Subject id"
                  value={predictionFilters.subject_id}
                  onChange={(e) =>
                    setPredictionFilters({
                      ...predictionFilters,
                      subject_id: e.target.value,
                    })
                  }
                  style={{ width: 110 }}
                />
                <select
                  value={predictionFilters.risk_category}
                  onChange={(e) =>
                    setPredictionFilters({
                      ...predictionFilters,
                      risk_category: e.target.value,
                    })
                  }
                >
                  <option value="">Any risk</option>
                  {["unknown", "low", "medium", "high", "critical"].map((risk) => (
                    <option key={risk} value={risk}>{risk}</option>
                  ))}
                </select>
                <select
                  value={predictionFilters.status}
                  onChange={(e) =>
                    setPredictionFilters({
                      ...predictionFilters,
                      status: e.target.value,
                    })
                  }
                >
                  <option value="">Any status</option>
                  {["active", "stale", "superseded", "insufficient_data"].map(
                    (status) => (
                      <option key={status} value={status}>{status}</option>
                    ),
                  )}
                </select>
                <button className="btn ghost" disabled={busy}>Filter</button>
              </form>
              {!predictions.length ? (
                <p className="subtle">No predictions.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Key</th><th>Type</th><th>Risk</th><th>Method</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {predictions.map((row) => (
                      <tr
                        key={row.id}
                        className={selectedPrediction?.id === row.id ? "valid" : ""}
                      >
                        <td>
                          <button
                            className="link-btn"
                            onClick={() => selectPrediction(row)}
                          >
                            {row.prediction_key}
                          </button>
                        </td>
                        <td className="mono">{row.prediction_type}</td>
                        <td><Badge value={row.risk_category} /></td>
                        <td>{METHOD_LABELS[row.method] || row.method}</td>
                        <td><Badge value={row.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <div className="panel-head">
                <h3>Prediction detail</h3>
                <button
                  className="btn ghost"
                  onClick={explainPrediction}
                  disabled={busy || !selectedPrediction}
                >
                  Explain
                </button>
              </div>
              {!selectedPrediction ? (
                <p className="subtle">Select a prediction to inspect it.</p>
              ) : (
                <>
                  <ul className="detail-list">
                    <li>Key: <span className="mono">{selectedPrediction.prediction_key}</span></li>
                    <li>Type: <span className="mono">{selectedPrediction.prediction_type}</span></li>
                    <li>Subject: {selectedPrediction.subject_type} #{selectedPrediction.subject_id ?? "-"}</li>
                    <li>Risk: <Badge value={selectedPrediction.risk_category} /></li>
                    <li>Score: {selectedPrediction.score ?? "-"}</li>
                    <li>Severity: <Badge value={selectedPrediction.severity} /></li>
                    <li>Method: {METHOD_LABELS[selectedPrediction.method] || selectedPrediction.method}</li>
                    <li>Model version: {selectedPrediction.model_version || "-"}</li>
                    <li>Ruleset version: {selectedPrediction.ruleset_version || "-"}</li>
                    <li>Confidence: {selectedPrediction.confidence ?? "-"}</li>
                    <li>Status: <Badge value={selectedPrediction.status} /></li>
                    <li>Stale: {selectedPrediction.stale ? "yes" : "no"}</li>
                    <li>Generated: {selectedPrediction.generated_at ?? "-"}</li>
                  </ul>
                  {selectedPrediction.uncertainty?.kind ? (
                    <p className="subtle">
                      Uncertainty: {selectedPrediction.uncertainty.kind}
                      {selectedPrediction.uncertainty.note
                        ? ` — ${selectedPrediction.uncertainty.note}`
                        : ""}
                    </p>
                  ) : null}
                  {selectedPrediction.explanation ? (
                    <p>{selectedPrediction.explanation}</p>
                  ) : (
                    <p className="subtle">No explanation recorded.</p>
                  )}
                  {selectedPrediction.limitations?.length ? (
                    <ul className="detail-list">
                      {selectedPrediction.limitations.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {explanation ? (
                    <>
                      <h4>Explanation</h4>
                      <p>{explanation.summary || "No summary."}</p>
                      {explanation.contributing_factors?.length ? (
                        <Table
                          rows={explanation.contributing_factors}
                          keyField="factor"
                          columns={[
                            { key: "factor", label: "Factor", mono: true },
                            { key: "value", label: "Value" },
                            { key: "contribution", label: "Contribution" },
                          ]}
                        />
                      ) : null}
                      {explanation.limitations?.length ? (
                        <ul className="detail-list">
                          {explanation.limitations.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Recommendations" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Recommendations</h3>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn ghost" onClick={loadRecommendations} disabled={busy}>
                  Refresh
                </button>
                <button className="btn ghost" onClick={generateRecommendations} disabled={busy}>
                  Generate
                </button>
              </div>
            </div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                loadRecommendations();
              }}
            >
              <select
                value={recommendationFilters.status}
                onChange={(e) =>
                  setRecommendationFilters({
                    ...recommendationFilters,
                    status: e.target.value,
                  })
                }
              >
                <option value="">Any status</option>
                {[
                  "new",
                  "under_review",
                  "accepted",
                  "rejected",
                  "deferred",
                  "completed",
                  "cancelled",
                ].map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <select
                value={recommendationFilters.severity}
                onChange={(e) =>
                  setRecommendationFilters({
                    ...recommendationFilters,
                    severity: e.target.value,
                  })
                }
              >
                <option value="">Any severity</option>
                {["unknown", "low", "medium", "high", "critical"].map((sev) => (
                  <option key={sev} value={sev}>{sev}</option>
                ))}
              </select>
              <select
                value={recommendationFilters.priority}
                onChange={(e) =>
                  setRecommendationFilters({
                    ...recommendationFilters,
                    priority: e.target.value,
                  })
                }
              >
                <option value="">Any priority</option>
                {["unknown", "low", "medium", "high", "critical"].map((prio) => (
                  <option key={prio} value={prio}>{prio}</option>
                ))}
              </select>
              <label className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={recommendationFilters.overdue_only}
                  onChange={(e) =>
                    setRecommendationFilters({
                      ...recommendationFilters,
                      overdue_only: e.target.checked,
                    })
                  }
                />
                <span className="muted">Overdue only</span>
              </label>
              <button className="btn ghost" disabled={busy}>Filter</button>
            </form>
            {!recommendations.length ? (
              <p className="subtle">No recommendations.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Title</th><th>Severity</th><th>Priority</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recommendations.map((row) => (
                    <tr
                      key={row.id}
                      className={selectedRecommendation?.id === row.id ? "valid" : ""}
                    >
                      <td>
                        <button
                          className="link-btn"
                          onClick={() => selectRecommendation(row)}
                        >
                          {row.title || row.recommendation_key}
                        </button>
                      </td>
                      <td><Badge value={row.severity} /></td>
                      <td><Badge value={row.priority} /></td>
                      <td><Badge value={row.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Review lifecycle</h3></div>
            {!selectedRecommendation ? (
              <p className="subtle">Select a recommendation to review it.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>Key: <span className="mono">{selectedRecommendation.recommendation_key}</span></li>
                  <li>Title: {selectedRecommendation.title || "-"}</li>
                  <li>Status: <Badge value={selectedRecommendation.status} /></li>
                  <li>Priority: <Badge value={selectedRecommendation.priority} /></li>
                  <li>Prediction: {selectedRecommendation.prediction_id ?? "-"}</li>
                  <li>Owner role: {selectedRecommendation.owner_role || "-"}</li>
                  <li>Reviewed by: {selectedRecommendation.reviewed_by || "-"}</li>
                  <li>Risk before: {selectedRecommendation.risk_before ?? "-"}</li>
                  <li>Risk after: {selectedRecommendation.risk_after ?? "-"}</li>
                  <li>Risk reduced: {selectedRecommendation.risk_reduced == null ? "-" : selectedRecommendation.risk_reduced ? "yes" : "no"}</li>
                </ul>
                {selectedRecommendation.rationale ? (
                  <p>{selectedRecommendation.rationale}</p>
                ) : null}
                {selectedRecommendation.suggested_action ? (
                  <p className="subtle">
                    Suggested action: {selectedRecommendation.suggested_action}
                  </p>
                ) : null}
                <form
                  className="stack"
                  style={{ gap: 8, marginTop: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    review("comment");
                  }}
                >
                  <textarea
                    placeholder="Review note"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    rows={3}
                  />
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <button className="btn" disabled={busy}>Comment</button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => review("accept")}
                      disabled={busy}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => review("defer")}
                      disabled={busy}
                    >
                      Defer
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => review("complete")}
                      disabled={busy}
                    >
                      Complete
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => review("reject")}
                      disabled={busy}
                    >
                      Reject
                    </button>
                  </div>
                </form>
                <h4>Feedback</h4>
                <Table
                  rows={feedback}
                  columns={[
                    { key: "decision", label: "Decision", render: (row) => <Badge value={row.decision} /> },
                    { key: "reviewer", label: "Reviewer" },
                    { key: "comment", label: "Comment" },
                    { key: "created_at", label: "At" },
                  ]}
                  empty="No feedback yet."
                />
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Models" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Registered prediction models</h3>
              <button className="btn ghost" onClick={loadModels} disabled={busy}>
                Refresh
              </button>
            </div>
            {!models.length ? (
              <p className="subtle">No models registered.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Key</th><th>Type</th><th>Method</th><th>Lifecycle</th></tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr
                      key={model.id}
                      className={selectedModel?.id === model.id ? "valid" : ""}
                    >
                      <td>
                        <button className="link-btn" onClick={() => selectModel(model)}>
                          {model.model_key}
                        </button>
                      </td>
                      <td className="mono">{model.prediction_type}</td>
                      <td>{METHOD_LABELS[model.method] || model.method}</td>
                      <td><Badge value={model.lifecycle_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="panel-head" style={{ marginTop: 16 }}>
              <h3>Model performance</h3>
              <div className="row" style={{ gap: 8 }}>
                <input
                  placeholder="Model key"
                  value={modelPerfKey}
                  onChange={(e) => setModelPerfKey(e.target.value)}
                />
                <button className="btn ghost" onClick={loadModelPerformance} disabled={busy}>
                  Load
                </button>
              </div>
            </div>
            {modelPerf ? (
              <>
                <ul className="detail-list">
                  <li>Predictions: {modelPerf.prediction_count}</li>
                  <li>Active: {modelPerf.active_count}</li>
                  <li>Stale: {modelPerf.stale_count}</li>
                  <li>Insufficient data: {modelPerf.insufficient_data_count}</li>
                  <li>Monitored metrics: {modelPerf.monitored_metrics ? "yes" : "no"}</li>
                </ul>
                {modelPerf.note ? <p className="subtle">{modelPerf.note}</p> : null}
              </>
            ) : (
              <p className="subtle">Load model performance.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Model versions</h3></div>
            {!selectedModel ? (
              <p className="subtle">Select a model to inspect its versions.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>Key: <span className="mono">{selectedModel.model_key}</span></li>
                  <li>Type: <span className="mono">{selectedModel.prediction_type}</span></li>
                  <li>Method: {METHOD_LABELS[selectedModel.method] || selectedModel.method}</li>
                  <li>Lifecycle: <Badge value={selectedModel.lifecycle_status} /></li>
                  <li>Version counter: {selectedModel.version}</li>
                </ul>
                <Table
                  rows={modelVersions}
                  columns={[
                    { key: "version", label: "Version", mono: true },
                    { key: "method", label: "Method" },
                    { key: "ruleset_version", label: "Ruleset" },
                    { key: "lifecycle_status", label: "Lifecycle", render: (row) => <Badge value={row.lifecycle_status} /> },
                  ]}
                  empty="No versions."
                />
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Features" ? (
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>Feature definitions</h3>
              <div className="row" style={{ gap: 8 }}>
                <input
                  placeholder="Entity type filter"
                  value={featureKeyFilter}
                  onChange={(e) => setFeatureKeyFilter(e.target.value)}
                />
                <button className="btn ghost" onClick={loadFeatures} disabled={busy}>
                  Load
                </button>
              </div>
            </div>
            <Table
              rows={features}
              columns={[
                { key: "feature_key", label: "Key", mono: true },
                { key: "entity_type", label: "Entity" },
                { key: "data_type", label: "Data type" },
                { key: "freshness_ttl_hours", label: "TTL (h)" },
                { key: "lifecycle_status", label: "Lifecycle", render: (row) => <Badge value={row.lifecycle_status} /> },
                {
                  key: "actions",
                  label: "",
                  render: (row) => (
                    <button className="link-btn" onClick={() => inspectFeature(row)}>
                      Status
                    </button>
                  ),
                },
              ]}
              empty="No feature definitions."
            />
            {featureStatus ? (
              <ul className="detail-list" style={{ marginTop: 12 }}>
                <li>Feature: <span className="mono">{featureStatus.feature_key}</span></li>
                <li>Defined: {featureStatus.defined ? "yes" : "no"}</li>
                <li>Values: {featureStatus.value_count}</li>
                <li>Stale values: {featureStatus.stale_count}</li>
                <li>Latest observed: {featureStatus.latest_observed_at ?? "-"}</li>
                <li>Status: <Badge value={featureStatus.status} /></li>
              </ul>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Feature values</h3></div>
            <Table
              rows={featureValues}
              columns={[
                { key: "feature_key", label: "Feature", mono: true },
                { key: "entity_type", label: "Entity" },
                { key: "entity_id", label: "Entity id" },
                { key: "value", label: "Value", render: (row) => JSON.stringify(row.value) },
                { key: "stale", label: "Stale", render: (row) => (row.stale ? "yes" : "no") },
                { key: "observed_at", label: "Observed" },
              ]}
              empty="No feature values."
            />
          </div>
        </div>
      ) : null}

      {tab === "Datasets" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Datasets</h3>
              <button className="btn ghost" onClick={loadDatasets} disabled={busy}>
                Refresh
              </button>
            </div>
            {!datasets.length ? (
              <p className="subtle">No datasets.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Key</th><th>Type</th><th>Lifecycle</th><th>Version</th></tr>
                </thead>
                <tbody>
                  {datasets.map((dataset) => (
                    <tr
                      key={dataset.id}
                      className={selectedDataset?.id === dataset.id ? "valid" : ""}
                    >
                      <td>
                        <button className="link-btn" onClick={() => selectDataset(dataset)}>
                          {dataset.dataset_key}
                        </button>
                      </td>
                      <td className="mono">{dataset.prediction_type || "-"}</td>
                      <td><Badge value={dataset.lifecycle_status} /></td>
                      <td>{dataset.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Dataset versions</h3></div>
            {!selectedDataset ? (
              <p className="subtle">Select a dataset to inspect its versions.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>Key: <span className="mono">{selectedDataset.dataset_key}</span></li>
                  <li>Type: {selectedDataset.prediction_type || "-"}</li>
                  <li>Lifecycle: <Badge value={selectedDataset.lifecycle_status} /></li>
                  <li>Features: {selectedDataset.feature_keys?.length ?? 0}</li>
                </ul>
                <Table
                  rows={datasetVersions}
                  columns={[
                    { key: "version", label: "Version" },
                    { key: "split", label: "Split" },
                    { key: "row_count", label: "Rows" },
                    { key: "lifecycle_status", label: "Lifecycle", render: (row) => <Badge value={row.lifecycle_status} /> },
                  ]}
                  empty="No versions."
                />
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Analytics" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Prediction analytics</h3>
            <div className="row" style={{ gap: 8 }}>
              <select
                value={analyticsKind}
                onChange={(e) => setAnalyticsKind(e.target.value)}
              >
                {ANALYTICS_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </select>
              <button className="btn ghost" onClick={loadAnalytics} disabled={busy}>
                Load
              </button>
            </div>
          </div>
          {analytics ? (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="muted">Rows: <strong>{analytics.total}</strong></span>
                {analytics.truncated ? <span className="badge pending">truncated</span> : null}
              </div>
              <Table
                rows={analytics.rows}
                keyField="key"
                columns={[
                  { key: "key", label: "Key", mono: true },
                  { key: "label", label: "Label" },
                  { key: "count", label: "Count" },
                  { key: "risk_category", label: "Risk", render: (row) => (row.risk_category ? <Badge value={row.risk_category} /> : "-") },
                ]}
              />
            </>
          ) : (
            <p className="subtle">Load analytics.</p>
          )}
        </div>
      ) : null}

      {tab === "Schedules" ? (
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Create a schedule</h3></div>
            <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={createSchedule}>
              <input
                placeholder="Schedule key"
                value={scheduleForm.schedule_key}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, schedule_key: e.target.value })
                }
              />
              <select
                value={scheduleForm.prediction_type}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, prediction_type: e.target.value })
                }
              >
                {PREDICTION_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <select
                value={scheduleForm.subject_type}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, subject_type: e.target.value })
                }
              >
                {SUBJECT_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <input
                placeholder="Interval seconds"
                value={scheduleForm.interval_seconds}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, interval_seconds: e.target.value })
                }
                style={{ width: 150 }}
              />
              <button className="btn" disabled={busy}>Create</button>
            </form>
            <p className="subtle" style={{ marginTop: 8 }}>
              Schedules are claimed and executed by the existing worker cadence;
              this page does not start any new daemon.
            </p>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Schedules</h3>
              <button className="btn ghost" onClick={loadSchedules} disabled={busy}>
                Refresh
              </button>
            </div>
            <Table
              rows={schedules}
              columns={[
                { key: "schedule_key", label: "Key", mono: true },
                { key: "prediction_type", label: "Type" },
                { key: "subject_type", label: "Subject" },
                { key: "interval_seconds", label: "Interval (s)" },
                { key: "enabled", label: "Enabled", render: (row) => (row.enabled ? "yes" : "no") },
                { key: "next_run_at", label: "Next run" },
                { key: "last_run_at", label: "Last run" },
                {
                  key: "actions",
                  label: "",
                  render: (row) => (
                    <button
                      className="link-btn"
                      onClick={() => toggleSchedule(row)}
                      disabled={busy}
                    >
                      {row.enabled ? "Disable" : "Enable"}
                    </button>
                  ),
                },
              ]}
              empty="No schedules."
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
