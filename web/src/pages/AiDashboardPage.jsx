import React, { useEffect, useState } from "react";
import { ai } from "../aiApi.js";

export default function AiDashboardPage() {
  const [state, setState] = useState({ loading: true, error: "" });
  const [caps, setCaps] = useState(null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([ai.capabilities(), ai.usage()]).then(([capsRes, usageRes]) => {
      if (cancelled) return;
      if (capsRes.status === "rejected") {
        setState({ loading: false, error: capsRes.reason?.message || "AI API unavailable" });
        return;
      }
      setCaps(capsRes.value);
      if (usageRes.status === "fulfilled") setUsage(usageRes.value);
      setState({ loading: false, error: "" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) return <p className="muted">Loading AI platform status…</p>;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>AI control plane</h1>
          <p className="sub">
            Governance-first AI services. Every read and action is authorized server-side against
            your enterprise permissions.
          </p>
        </div>
      </div>

      {state.error ? <div className="error">AI API unavailable ({state.error})</div> : null}

      {caps ? (
        <>
          <div className="grid">
            <div className="stat">Environment<b>{caps.environment}</b></div>
            <div className="stat">Version<b>{caps.version}</b></div>
            <div className="stat">Chat model<b>{caps.default_chat_model}</b></div>
            <div className="stat">Embedding model<b>{caps.default_embedding_model}</b></div>
          </div>

          <div className="split">
            <div className="panel">
              <div className="panel-head"><h3>Providers</h3></div>
              <table>
                <thead>
                  <tr><th>Provider</th><th>Availability</th></tr>
                </thead>
                <tbody>
                  {caps.providers.map((p) => (
                    <tr key={p.provider}>
                      <td>{p.provider}</td>
                      <td>
                        <span className={`badge ${p.available ? "active" : "inactive"}`}>
                          {p.available ? "available" : "unavailable"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel">
              <div className="panel-head"><h3>Features</h3></div>
              <table>
                <thead>
                  <tr><th>Capability</th><th>State</th></tr>
                </thead>
                <tbody>
                  {Object.entries(caps.features).map(([code, value]) => (
                    <tr key={code}>
                      <td className="mono">{code}</td>
                      <td>
                        <span className={`badge ${value === "available" ? "active" : "inactive"}`}>
                          {value}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Models</h3></div>
            <table>
              <thead>
                <tr>
                  <th>Model</th><th>Provider</th><th>Kind</th><th>Context</th>
                  <th>Streaming</th><th>Tools</th><th>JSON</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {caps.models.map((m) => (
                  <tr key={m.code}>
                    <td className="mono">{m.code}</td>
                    <td>{m.provider}</td>
                    <td>{m.capability.kind}</td>
                    <td>{m.capability.context_window ?? "—"}</td>
                    <td>{m.capability.supports_streaming ? "yes" : "no"}</td>
                    <td>{m.capability.supports_tools ? "yes" : "no"}</td>
                    <td>{m.capability.supports_json_mode ? "yes" : "no"}</td>
                    <td>{m.is_mock ? <span className="badge inactive">mock</span> : "configured"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {usage ? (
            <div className="panel">
              <div className="panel-head"><h3>Usage</h3></div>
              <div className="grid">
                <div className="stat">Requests &amp; tokens<b>{usage.quantity}</b></div>
                <div className="stat">Total cost<b>{usage.total_cost} {usage.currency}</b></div>
              </div>
              {usage.by_kind?.length ? (
                <table>
                  <thead>
                    <tr><th>Kind</th><th>Quantity</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {usage.by_kind.map((k) => (
                      <tr key={k.kind}>
                        <td className="mono">{k.kind}</td>
                        <td>{k.quantity}</td>
                        <td>{k.total_cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
