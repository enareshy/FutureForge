import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

export default function AuditRetentionPanel() {
  const [runs, setRuns] = useState([]);
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await audit.retentionRuns("?pageSize=50");
      setRuns(res.items || []);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await audit.runRetention({ dryRun });
      setNotice(
        dryRun
          ? `Dry run: ${result.archived ?? 0} event(s) would be archived, ${result.purged ?? 0} purged.`
          : `Archived ${result.archived ?? 0} event(s), purged ${result.purged ?? 0}.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return <div className="audit-empty">You do not have permission to manage audit retention.</div>;
  }

  return (
    <div className="audit-retention">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Retention &amp; archiving</h3>
        <div className="inline">
          <label className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run
          </label>
          <button className="btn" type="button" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run retention"}
          </button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}
      <div className="panel">
        <table>
          <thead>
            <tr><th>When</th><th>Status</th><th>Dry run</th><th>Archived</th><th>Purged</th><th>Cutoff</th></tr>
          </thead>
          <tbody>
            {runs.map((runRow) => (
              <tr key={runRow.id}>
                <td className="mono">{runRow.started_at || runRow.finished_at}</td>
                <td><span className={`badge ${runRow.status === "success" ? "active" : "inactive"}`}>{runRow.status}</span></td>
                <td>{runRow.dry_run ? "yes" : "no"}</td>
                <td>{runRow.archived ?? 0}</td>
                <td>{runRow.purged ?? 0}</td>
                <td className="mono">{runRow.cutoff || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length ? <div className="audit-empty">No retention runs have been recorded yet.</div> : null}
      </div>
    </div>
  );
}
