import React from "react";

function JsonBlock({ label, value }) {
  const empty = value === null || value === undefined || (typeof value === "object" && !Object.keys(value).length);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="mono" style={{ marginBottom: 4 }}>{label}</div>
      {empty ? (
        <div className="muted">None</div>
      ) : (
        <pre className="mono" style={{ background: "#10192f", border: "1px solid var(--line)", borderRadius: 8, padding: 10, overflow: "auto", maxHeight: 260 }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function JobResultPanel({ result }) {
  if (!result) return null;
  return (
    <div className="panel" style={{ background: "#10192f" }}>
      <div className="panel-head">
        <h3>Result &amp; error</h3>
      </div>

      <div className="chips" style={{ marginBottom: 6 }}>
        <span className="chip">status: {result.status}</span>
        {result.result_ref ? <span className="chip">ref: <span className="mono">{result.result_ref}</span></span> : null}
        {result.error_code ? <span className="chip">error: {result.error_code}</span> : null}
      </div>

      {result.error_message ? <div className="error">{result.error_code ? `${result.error_code}: ` : ""}{result.error_message}</div> : null}

      <JsonBlock label="Result payload" value={result.result} />
      <JsonBlock label="Error detail" value={result.error} />

      <div className="mono" style={{ marginTop: 14, marginBottom: 4 }}>Artifacts</div>
      <table>
        <thead><tr><th>Kind</th><th>Name</th><th>File</th><th>Size</th><th>Ref</th><th>Created</th></tr></thead>
        <tbody>
          {(result.artifacts || []).map((artifact) => (
            <tr key={artifact.id}>
              <td>{artifact.kind}</td>
              <td>{artifact.name || "—"}</td>
              <td className="mono">{artifact.filename || "—"}</td>
              <td>{artifact.size ? `${artifact.size} B` : "—"}</td>
              <td className="mono">{artifact.storage_ref || artifact.url || "—"}{artifact.secure ? " (secure)" : ""}</td>
              <td className="mono">{artifact.created_at}</td>
            </tr>
          ))}
          {!result.artifacts?.length ? <tr><td colSpan={6} className="muted">No artifacts produced.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
