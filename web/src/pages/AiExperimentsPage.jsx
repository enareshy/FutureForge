import React, { useCallback, useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function formatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function parseJsonObject(text, label) {
  if (!text || !text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

const RUN_BADGE = { finished: "active", failed: "inactive", killed: "inactive", running: "unknown" };
const STAGE_BADGE = { production: "active", staging: "unknown", archived: "inactive", none: "unknown" };

export default function AiExperimentsPage() {
  const [status, setStatus] = useState(null);
  const [experiments, setExperiments] = useState([]);
  const [selectedExperiment, setSelectedExperiment] = useState(null);
  const [runs, setRuns] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [versions, setVersions] = useState([]);
  const [evaluations, setEvaluations] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const [experimentForm, setExperimentForm] = useState({ code: "", name: "" });
  const [runForm, setRunForm] = useState({ run_name: "", params: "", metrics: "" });
  const [modelForm, setModelForm] = useState({ code: "", name: "", framework: "scikit-learn" });
  const [versionForm, setVersionForm] = useState({ artifact_uri: "", metrics: "" });
  const [evaluationForm, setEvaluationForm] = useState({ code: "", name: "", kind: "retrieval" });
  const [busy, setBusy] = useState(false);

  const loadExperiments = useCallback(async () => {
    const page = await ai.experiments({ limit: 50 });
    setExperiments(page.items || []);
  }, []);

  const loadModels = useCallback(async () => {
    const page = await ai.mlModels({ limit: 50 });
    setModels(page.items || []);
  }, []);

  const loadEvaluations = useCallback(async () => {
    const page = await ai.mlEvaluations({ limit: 50 });
    setEvaluations(page.items || []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ai.mlStatus(), ai.experiments({ limit: 50 }), ai.mlModels({ limit: 50 }), ai.mlEvaluations({ limit: 50 })])
      .then(([statusRes, expRes, modelRes, evalRes]) => {
        if (cancelled) return;
        setStatus(statusRes);
        setExperiments(expRes.items || []);
        setModels(modelRes.items || []);
        setEvaluations(evalRes.items || []);
      })
      .catch((err) => {
        if (!cancelled) setError(describe(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runAction = useCallback(async (action, successMessage) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (successMessage) setNotice(successMessage);
      return result;
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const selectExperiment = useCallback(async (experiment) => {
    setSelectedExperiment(experiment);
    const page = await runAction(() => ai.runs({ experiment_id: experiment.id, limit: 50 }));
    if (page) setRuns(page.items || []);
  }, [runAction]);

  const selectModel = useCallback(async (model) => {
    setSelectedModel(model);
    const items = await runAction(() => ai.modelVersions(model.id));
    if (items) setVersions(items);
  }, [runAction]);

  const submitExperiment = async (event) => {
    event.preventDefault();
    const created = await runAction(() => ai.createExperiment({ ...experimentForm }), "Experiment created.");
    if (created) {
      setExperimentForm({ code: "", name: "" });
      await loadExperiments();
    }
  };

  const submitRun = async (event) => {
    event.preventDefault();
    if (!selectedExperiment) return;
    const body = {
      run_name: runForm.run_name || null,
      params: parseJsonObject(runForm.params, "Params"),
      metrics: parseJsonObject(runForm.metrics, "Metrics"),
      dataset_ref: { synthetic: true, note: "manual run via console" },
    };
    const created = await runAction(
      () => ai.createRun(selectedExperiment.id, body),
      "Run started.",
    );
    if (created) {
      setRunForm({ run_name: "", params: "", metrics: "" });
      await selectExperiment(selectedExperiment);
    }
  };

  const finishRun = async (run) => {
    const finished = await runAction(
      () => ai.finishRun(run.id, { status: "finished", metrics: {} }),
      `Run #${run.id} finished.`,
    );
    if (finished && selectedExperiment) await selectExperiment(selectedExperiment);
  };

  const submitModel = async (event) => {
    event.preventDefault();
    const created = await runAction(() => ai.registerMlModel({ ...modelForm }), "Model registered.");
    if (created) {
      setModelForm({ code: "", name: "", framework: "scikit-learn" });
      await loadModels();
    }
  };

  const submitVersion = async (event) => {
    event.preventDefault();
    if (!selectedModel) return;
    let metrics;
    try {
      metrics = parseJsonObject(versionForm.metrics, "Metrics");
    } catch (err) {
      setError(err.message);
      return;
    }
    const created = await runAction(
      () => ai.createModelVersion(selectedModel.id, { artifact_uri: versionForm.artifact_uri, metrics }),
      "Model version created.",
    );
    if (created) {
      setVersionForm({ artifact_uri: "", metrics: "" });
      await selectModel(selectedModel);
    }
  };

  const promote = async (version, statusValue) => {
    if (!selectedModel) return;
    const updated = await runAction(
      () => ai.setModelVersionStatus(selectedModel.id, version, { status: statusValue }),
      `Version ${version} set to ${statusValue}.`,
    );
    if (updated) {
      await selectModel(selectedModel);
      await loadModels();
    }
  };

  const submitEvaluation = async (event) => {
    event.preventDefault();
    const created = await runAction(
      () => ai.createMlEvaluation({ ...evaluationForm }),
      "Evaluation suite created.",
    );
    if (created) {
      setEvaluationForm({ code: "", name: "", kind: "retrieval" });
      await loadEvaluations();
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Experiments &amp; models</h1>
          <p className="sub">
            Experiment tracking and a classical-ML model registry. Records are tenant-scoped and
            audited. Metrics and validation values are stored exactly as logged; nothing is scored or
            served automatically.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {status ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Tracking backend</h3>
            <span className={`badge ${status.available ? "active" : "inactive"}`}>
              {status.available ? "available" : "unavailable"}
            </span>
            {status.external ? <span className="badge unknown">external</span> : null}
          </div>
          <div className="grid">
            <div className="stat">
              <div className="result-sub">Backend</div>
              <div>{status.backend}</div>
            </div>
            <div className="stat">
              <div className="result-sub">Registration</div>
              <div>{status.registration_enabled ? "enabled" : "disabled"}</div>
            </div>
            <div className="stat">
              <div className="result-sub">Detail</div>
              <div>{status.detail || "-"}</div>
            </div>
          </div>
          {!status.available && status.external ? (
            <div className="notice">
              The external tracker is unreachable; runs are recorded in the platform registry.
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? <p className="muted">Loading experiment tracking…</p> : null}

      <div className="panel">
        <div className="panel-head"><h3>Experiments</h3></div>
        <form className="row" onSubmit={submitExperiment}>
          <div className="field grow">
            <label>Code</label>
            <input
              value={experimentForm.code}
              placeholder="anomaly-detection"
              onChange={(e) => setExperimentForm((f) => ({ ...f, code: e.target.value }))}
              required
            />
          </div>
          <div className="field grow">
            <label>Name</label>
            <input
              value={experimentForm.name}
              placeholder="Anomaly detection"
              onChange={(e) => setExperimentForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <button className="btn" type="submit" disabled={busy}>Create</button>
        </form>
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Type</th><th>Backend</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {experiments.map((exp) => (
              <tr key={exp.id}>
                <td>{exp.code}</td>
                <td>{exp.name}</td>
                <td>{exp.problem_type}</td>
                <td>{exp.tracking_backend}</td>
                <td>{formatTime(exp.created_at)}</td>
                <td>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => selectExperiment(exp)}>
                    Runs
                  </button>
                </td>
              </tr>
            ))}
            {experiments.length === 0 && !loading ? (
              <tr><td colSpan={6} className="muted">No experiments yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedExperiment ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Runs · {selectedExperiment.code}</h3>
            <button className="btn ghost" type="button" onClick={() => { setSelectedExperiment(null); setRuns([]); }}>
              Close
            </button>
          </div>
          <form className="row" onSubmit={submitRun}>
            <div className="field grow">
              <label>Run name</label>
              <input
                value={runForm.run_name}
                onChange={(e) => setRunForm((f) => ({ ...f, run_name: e.target.value }))}
              />
            </div>
            <div className="field grow">
              <label>Params (JSON)</label>
              <input
                value={runForm.params}
                placeholder='{"n_estimators": 100}'
                onChange={(e) => setRunForm((f) => ({ ...f, params: e.target.value }))}
              />
            </div>
            <div className="field grow">
              <label>Metrics (JSON)</label>
              <input
                value={runForm.metrics}
                placeholder='{"accuracy": 0.9}'
                onChange={(e) => setRunForm((f) => ({ ...f, metrics: e.target.value }))}
              />
            </div>
            <button className="btn" type="submit" disabled={busy}>Start run</button>
          </form>
          <table>
            <thead>
              <tr><th>Run</th><th>Status</th><th>Metrics</th><th>Started</th><th>Finished</th><th /></tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.run_name || `#${run.id}`}</td>
                  <td><span className={`badge ${RUN_BADGE[run.status] || "unknown"}`}>{run.status}</span></td>
                  <td>{Object.keys(run.metrics || {}).length ? JSON.stringify(run.metrics) : "-"}</td>
                  <td>{formatTime(run.created_at)}</td>
                  <td>{formatTime(run.finished_at)}</td>
                  <td>
                    {run.status === "running" ? (
                      <button className="btn secondary" type="button" disabled={busy} onClick={() => finishRun(run)}>
                        Finish
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {runs.length === 0 ? (
                <tr><td colSpan={6} className="muted">No runs yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head"><h3>Model registry</h3></div>
        <form className="row" onSubmit={submitModel}>
          <div className="field grow">
            <label>Code</label>
            <input
              value={modelForm.code}
              onChange={(e) => setModelForm((f) => ({ ...f, code: e.target.value }))}
              required
            />
          </div>
          <div className="field grow">
            <label>Name</label>
            <input
              value={modelForm.name}
              onChange={(e) => setModelForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <div className="field grow">
            <label>Framework</label>
            <input
              value={modelForm.framework}
              onChange={(e) => setModelForm((f) => ({ ...f, framework: e.target.value }))}
            />
          </div>
          <button className="btn" type="submit" disabled={busy}>Register</button>
        </form>
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Framework</th><th>Stage</th><th /></tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={model.id}>
                <td>{model.code}</td>
                <td>{model.name}</td>
                <td>{model.framework}</td>
                <td><span className={`badge ${STAGE_BADGE[model.stage] || "unknown"}`}>{model.stage}</span></td>
                <td>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => selectModel(model)}>
                    Versions
                  </button>
                </td>
              </tr>
            ))}
            {models.length === 0 && !loading ? (
              <tr><td colSpan={5} className="muted">No models registered.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedModel ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Versions · {selectedModel.code}</h3>
            <button className="btn ghost" type="button" onClick={() => { setSelectedModel(null); setVersions([]); }}>
              Close
            </button>
          </div>
          <form className="row" onSubmit={submitVersion}>
            <div className="field grow">
              <label>Artifact URI</label>
              <input
                value={versionForm.artifact_uri}
                placeholder="s3://models/... or file:///..."
                onChange={(e) => setVersionForm((f) => ({ ...f, artifact_uri: e.target.value }))}
              />
            </div>
            <div className="field grow">
              <label>Metrics (JSON)</label>
              <input
                value={versionForm.metrics}
                placeholder='{"f1": 0.88}'
                onChange={(e) => setVersionForm((f) => ({ ...f, metrics: e.target.value }))}
              />
            </div>
            <button className="btn" type="submit" disabled={busy}>Add version</button>
          </form>
          <table>
            <thead>
              <tr><th>Version</th><th>Status</th><th>Metrics</th><th>Artifact</th><th /></tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td><span className={`badge ${STAGE_BADGE[version.status] || "unknown"}`}>{version.status}</span></td>
                  <td>{Object.keys(version.metrics || {}).length ? JSON.stringify(version.metrics) : "-"}</td>
                  <td>{version.artifact_uri || "-"}</td>
                  <td>
                    <button className="btn secondary" type="button" disabled={busy} onClick={() => promote(version.version, "staging")}>
                      Stage
                    </button>{" "}
                    <button className="btn" type="button" disabled={busy} onClick={() => promote(version.version, "production")}>
                      Promote
                    </button>
                  </td>
                </tr>
              ))}
              {versions.length === 0 ? (
                <tr><td colSpan={5} className="muted">No versions yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head"><h3>Evaluation suites</h3></div>
        <form className="row" onSubmit={submitEvaluation}>
          <div className="field grow">
            <label>Code</label>
            <input
              value={evaluationForm.code}
              onChange={(e) => setEvaluationForm((f) => ({ ...f, code: e.target.value }))}
              required
            />
          </div>
          <div className="field grow">
            <label>Name</label>
            <input
              value={evaluationForm.name}
              onChange={(e) => setEvaluationForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <div className="field">
            <label>Kind</label>
            <select
              value={evaluationForm.kind}
              onChange={(e) => setEvaluationForm((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="retrieval">retrieval</option>
              <option value="answer">answer</option>
              <option value="safety">safety</option>
            </select>
          </div>
          <button className="btn" type="submit" disabled={busy}>Create</button>
        </form>
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Kind</th><th>Created</th></tr>
          </thead>
          <tbody>
            {evaluations.map((evaluation) => (
              <tr key={evaluation.id}>
                <td>{evaluation.code}</td>
                <td>{evaluation.name}</td>
                <td>{evaluation.kind}</td>
                <td>{formatTime(evaluation.created_at)}</td>
              </tr>
            ))}
            {evaluations.length === 0 && !loading ? (
              <tr><td colSpan={4} className="muted">No evaluation suites yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
