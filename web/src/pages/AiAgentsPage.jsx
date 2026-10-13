import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AiApiError, ai } from "../aiApi.js";
import AiMarkdown from "../aiMarkdown.jsx";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function AiAgentsPage() {
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [version, setVersion] = useState(null);
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rated, setRated] = useState(null);

  async function loadExecutions() {
    try {
      const page = await ai.agentExecutions({ limit: 10 });
      setExecutions(page.items || []);
    } catch (err) {
      setError(describe(err));
    }
  }

  useEffect(() => {
    ai.agents().then(setAgents).catch((e) => setError(describe(e)));
    loadExecutions();
  }, []);

  async function select(agent) {
    setSelected(agent);
    setResult(null);
    setVersion(null);
    try {
      const versions = await ai.agentVersions(agent.id);
      setVersion(versions?.[0] || null);
    } catch (err) {
      setError(describe(err));
    }
  }

  async function run(e) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    setRated(null);
    try {
      const res = await ai.executeAgent(selected.id, { input });
      setResult(res);
      await loadExecutions();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function rate(rating) {
    if (!result?.execution_id) return;
    try {
      await ai.createFeedback({ execution_id: result.execution_id, rating });
      setRated(rating);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Agents</h1>
          <p className="sub">
            Registered assistants. V1 agents are read-only and answer only from authorized
            knowledge.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="split">
        <div className="panel">
          <div className="panel-head"><h3>Registry</h3></div>
          <table>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Kind</th><th>Enabled</th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className={selected?.id === a.id ? "valid" : ""}>
                  <td>
                    <button className="link-btn" onClick={() => select(a)}>{a.code}</button>
                  </td>
                  <td>{a.name}</td>
                  <td>{a.kind}</td>
                  <td><span className={`badge ${a.enabled ? "active" : "inactive"}`}>{a.enabled ? "yes" : "no"}</span></td>
                </tr>
              ))}
              {agents.length === 0 ? (
                <tr><td colSpan={4} className="muted">No agents registered.</td></tr>
              ) : null}
            </tbody>
          </table>

          <div className="panel-head"><h3>Recent executions</h3></div>
          <table>
            <thead>
              <tr><th>ID</th><th>Status</th><th>Latency</th><th>Tokens</th><th>When</th></tr>
            </thead>
            <tbody>
              {executions.map((x) => (
                <tr key={x.id}>
                  <td>{x.id}</td>
                  <td><span className={`badge ${x.status}`}>{x.status}</span></td>
                  <td>{x.latency_ms != null ? `${x.latency_ms} ms` : "-"}</td>
                  <td>{x.token_usage?.total_tokens ?? 0}</td>
                  <td className="muted">{formatTime(x.created_at)}</td>
                </tr>
              ))}
              {executions.length === 0 ? (
                <tr><td colSpan={5} className="muted">No executions yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{selected ? `Run ${selected.name}` : "Run agent"}</h3>
            {version ? <span className="badge active">v{version.version} · read-only</span> : null}
          </div>
          {!selected ? (
            <p className="muted">Select an agent to run it.</p>
          ) : (
            <>
              {selected.description ? <p className="sub">{selected.description}</p> : null}
              <form onSubmit={run}>
                <label className="field">
                  <span>Input</span>
                  <textarea
                    rows={4}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask a question grounded in authorized knowledge…"
                    required
                  />
                </label>
                <button className="btn" disabled={busy}>{busy ? "Running…" : "Run"}</button>
              </form>
              {result ? (
                <div className="notice">
                  <div className="result-sub">answer</div>
                  <AiMarkdown text={result.answer} />
                  <div className="result-sub">
                    {result.insufficient_evidence
                      ? "insufficient evidence — no citations"
                      : `${result.citations?.length || 0} citation(s)`}
                    {typeof result.confidence === "number"
                      ? ` · confidence ${result.confidence.toFixed(3)}`
                      : ""}
                    {result.usage?.total_tokens ? ` · ${result.usage.total_tokens} tokens` : ""}
                  </div>
                  {result.citations?.length ? (
                    <ul>
                      {result.citations.map((c) => (
                        <li key={c.chunk_id}>
                          [{c.rank}]{" "}
                          <Link
                            to={`/ai/knowledge?source=${c.source_id}&document=${c.document_id}`}
                          >
                            {c.source_code}#{c.chunk_index}
                          </Link>{" "}
                          — {c.snippet}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {result.trace?.length ? (
                    <>
                      <div className="result-sub">trace</div>
                      <ol>
                        {result.trace.map((t) => (
                          <li key={t.seq}>
                            {t.step}
                            {Object.keys(t.detail || {}).length
                              ? ` (${Object.entries(t.detail)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(", ")})`
                              : ""}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                  {result.execution_id ? (
                    <div className="row" style={{ gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={rated != null}
                        onClick={() => rate(1)}
                      >
                        {rated === 1 ? "Rated helpful" : "Helpful"}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={rated != null}
                        onClick={() => rate(-1)}
                      >
                        {rated === -1 ? "Rated unhelpful" : "Not helpful"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
