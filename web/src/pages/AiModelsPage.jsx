import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function costLabel(value) {
  return value == null ? "-" : `$${Number(value).toFixed(4)}`;
}

function ModelTable({ models }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Kind</th>
          <th>Context</th>
          <th>Max out</th>
          <th>Stream</th>
          <th>Tools</th>
          <th>JSON</th>
          <th>Embed dim</th>
          <th>In /1k</th>
          <th>Out /1k</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.code}>
            <td>
              {m.code} {m.is_mock ? <span className="badge unknown">mock</span> : null}
            </td>
            <td>{m.capability?.kind || "-"}</td>
            <td>{m.capability?.context_window ?? "-"}</td>
            <td>{m.capability?.max_output_tokens ?? "-"}</td>
            <td>{m.capability?.supports_streaming ? "yes" : "no"}</td>
            <td>{m.capability?.supports_tools ? "yes" : "no"}</td>
            <td>{m.capability?.supports_json_mode ? "yes" : "no"}</td>
            <td>{m.capability?.embedding_dimensions ?? "-"}</td>
            <td>{costLabel(m.input_cost_per_1k)}</td>
            <td>{costLabel(m.output_cost_per_1k)}</td>
          </tr>
        ))}
        {models.length === 0 ? (
          <tr>
            <td colSpan={10} className="muted">
              No models registered for this provider.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export default function AiModelsPage() {
  const [providers, setProviders] = useState([]);
  const [capabilities, setCapabilities] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ai.providers(), ai.capabilities()])
      .then(([providerRes, capRes]) => {
        if (cancelled) return;
        setProviders(providerRes.items || []);
        setCapabilities(capRes);
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

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Models &amp; providers</h1>
          <p className="sub">
            Read-only view of the model gateway. Provider availability and model capabilities are
            configured on the server; the console never holds provider credentials.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {capabilities ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Defaults</h3>
            <span className="badge unknown">v{capabilities.version}</span>
          </div>
          <div className="grid">
            <div className="stat">
              <div className="result-sub">Environment</div>
              <div>{capabilities.environment}</div>
            </div>
            <div className="stat">
              <div className="result-sub">Default chat model</div>
              <div>{capabilities.default_chat_model}</div>
            </div>
            <div className="stat">
              <div className="result-sub">Default embedding model</div>
              <div>{capabilities.default_embedding_model}</div>
            </div>
          </div>
          {Object.keys(capabilities.features || {}).length ? (
            <>
              <div className="panel-head"><h3>Features</h3></div>
              <table>
                <thead>
                  <tr><th>Feature</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {Object.entries(capabilities.features).map(([name, status]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>
                        <span className={`badge ${status === "available" ? "active" : status}`}>
                          {status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
      ) : null}

      {loading ? <p className="muted">Loading providers…</p> : null}

      {!loading && providers.length === 0 && !error ? (
        <div className="notice">No providers registered.</div>
      ) : null}

      {providers.map((p) => (
        <div className="panel" key={p.provider}>
          <div className="panel-head">
            <h3>{p.provider}</h3>
            <span className={`badge ${p.available ? "active" : "inactive"}`}>
              {p.available ? "available" : "unavailable"}
            </span>
            {p.is_mock ? <span className="badge unknown">mock</span> : null}
          </div>
          <ModelTable models={p.models || []} />
        </div>
      ))}
    </>
  );
}
