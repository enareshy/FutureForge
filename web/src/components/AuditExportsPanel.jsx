import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

const EMPTY = { name: "", format: "csv", reason: "" };

export default function AuditExportsPanel() {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await audit.exports("?limit=50");
      setItems(res.items || []);
      setDenied(false);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pending = items.some((row) => ["queued", "running"].includes(row.status));
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [pending, load]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await audit.createExport(draft);
      setDraft(EMPTY);
      setNotice("Export request queued.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(row) {
    setError("");
    try {
      const result = await audit.downloadExport(row.id);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (denied) {
    return <div className="audit-empty">You do not have permission to manage audit exports.</div>;
  }

  return (
    <div className="audit-exports">
      <form className="panel" onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>Request export</h3>
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Q3 security review" />
          </label>
          <label className="field">
            <span>Format</span>
            <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="excel">Excel</option>
            </select>
          </label>
          <label className="field grow">
            <span>Reason</span>
            <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} placeholder="Requested by auditor" />
          </label>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Queuing…" : "Request"}</button>
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Export requests</h3>
        <table>
          <thead>
            <tr><th>Name</th><th>Format</th><th>Status</th><th>Rows</th><th>Requested</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td>{row.name || `Export #${row.id}`}</td>
                <td className="mono">{row.format}</td>
                <td><span className={`badge ${row.status === "completed" ? "active" : row.status === "failed" ? "locked" : "inactive"}`}>{row.status}</span></td>
                <td style={{ textAlign: "right" }}>{row.row_count || 0}</td>
                <td className="mono">{row.created_at || "—"}</td>
                <td className="mono">{row.expires_at || "—"}</td>
                <td>
                  {row.status === "completed" ? (
                    <button className="btn ghost" type="button" onClick={() => download(row)}>Download</button>
                  ) : row.error ? (
                    <span className="muted" title={row.error}>error</span>
                  ) : (
                    <span className="muted">…</span>
                  )}
                </td>
              </tr>
            ))}
            {!items.length && !loading ? (
              <tr><td colSpan={7} className="muted">No export requests yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
