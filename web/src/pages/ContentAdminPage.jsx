import React, { useCallback, useEffect, useState } from "react";
import { content } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "policies", label: "Retention policies" },
  { key: "jobs", label: "Processing jobs" },
  { key: "security", label: "Security" },
];

function fmt(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

function bytes(value) {
  const size = Number(value || 0);
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function tone(status) {
  const value = String(status || "").toLowerCase();
  if (["clean", "completed", "ready", "active", "succeeded"].includes(value)) return "active";
  if (["infected", "failed", "error", "quarantined"].includes(value)) return "danger";
  if (["pending", "running", "processing", "queued", "skipped"].includes(value)) return "locked";
  return "inactive";
}

function Badge({ status }) {
  return <span className={`badge ${tone(status)}`}>{fmt(status)}</span>;
}

const EMPTY_POLICY = { policy_code: "", name: "", retention_days: 365, disposition: "review" };

export default function ContentAdminPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [policyForm, setPolicyForm] = useState(EMPTY_POLICY);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [snapshotRes, policyRes, jobRes] = await Promise.all([
        content.metrics(),
        content.retentionPolicies("?limit=100&active=false"),
        content.processingJobs("?limit=100"),
      ]);
      setSnapshot(snapshotRes);
      setPolicies(policyRes.items || []);
      setJobs(jobRes.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (success) setNotice(success);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitPolicy(event) {
    event.preventDefault();
    await run(() => content.createRetentionPolicy(policyForm), "Retention policy created.");
    setPolicyForm(EMPTY_POLICY);
  }

  const metrics = snapshot?.metrics || {};
  const storage = snapshot?.storage || {};
  const security = snapshot?.security || {};
  const processing = snapshot?.processing || {};

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Content administration</h2>
          <p className="sub">Storage footprint, processing pipelines, security scanning and retention governance.</p>
        </div>
        <button className="btn ghost" type="button" onClick={refresh}>Refresh</button>
      </div>

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.key} type="button" className={`tab ${tab === item.key ? "active" : ""}`} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="grid">
            <div className="stat"><span>Total content</span><b>{fmt(metrics.content_total)}</b></div>
            <div className="stat"><span>Active</span><b>{fmt(metrics.content_active)}</b></div>
            <div className="stat"><span>Quarantined</span><b>{fmt(metrics.quarantine_count)}</b></div>
            <div className="stat"><span>Upload sessions</span><b>{fmt(metrics.upload_sessions_total)}</b></div>
            <div className="stat"><span>Downloads</span><b>{fmt(metrics.download_count)}</b></div>
            <div className="stat"><span>Check-outs</span><b>{fmt(metrics.checkout_count)}</b></div>
            <div className="stat"><span>Check-ins</span><b>{fmt(metrics.checkin_count)}</b></div>
            <div className="stat"><span>Legal holds</span><b>{fmt(metrics.legal_hold_count)}</b></div>
            <div className="stat"><span>Renditions</span><b>{fmt(metrics.rendition_count)}</b></div>
            <div className="stat"><span>Rendition failures</span><b>{fmt(metrics.rendition_failure_count)}</b></div>
            <div className="stat"><span>Scans</span><b>{fmt(metrics.virus_scan_count)}</b></div>
            <div className="stat"><span>Detections</span><b>{fmt(metrics.virus_detection_count)}</b></div>
          </div>

          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Storage footprint</h3></div>
              <div className="grid">
                <div className="stat"><span>Stored bytes</span><b>{bytes(storage.total_bytes)}</b></div>
                <div className="stat"><span>Objects</span><b>{fmt(storage.object_count)}</b></div>
                <div className="stat"><span>Distinct checksums</span><b>{fmt(storage.distinct_checksums)}</b></div>
                <div className="stat"><span>Dedupe savings</span><b>{bytes(storage.dedupe_savings_bytes)}</b></div>
              </div>
              <table className="table">
                <thead><tr><th>Provider</th><th>Objects</th><th>Bytes</th></tr></thead>
                <tbody>
                  {(storage.by_provider || []).map((row) => (
                    <tr key={row.provider}>
                      <td className="mono">{fmt(row.provider)}</td>
                      <td className="mono">{row.objects}</td>
                      <td className="mono">{bytes(row.bytes)}</td>
                    </tr>
                  ))}
                  {!(storage.by_provider || []).length ? <tr><td colSpan="3" className="sub">No stored objects.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Distribution</h3></div>
              <table className="table">
                <thead><tr><th>Status</th><th>Count</th></tr></thead>
                <tbody>
                  {(metrics.by_status || []).map((row) => (
                    <tr key={row.value}><td className="mono">{fmt(row.value)}</td><td className="mono">{row.count}</td></tr>
                  ))}
                  {!(metrics.by_status || []).length ? <tr><td colSpan="2" className="sub">No content.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {tab === "policies" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Retention policies</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Days</th><th>Start basis</th><th>Disposition</th><th>Status</th><th /></tr></thead>
              <tbody>
                {policies.map((row) => (
                  <tr key={row.policy_ref}>
                    <td className="mono">{row.policy_code}</td>
                    <td>{row.name}</td>
                    <td className="mono">{fmt(row.retention_days)}</td>
                    <td className="mono">{fmt(row.retention_start_basis)}</td>
                    <td className="mono">{fmt(row.disposition)}</td>
                    <td><Badge status={row.active ? "active" : "inactive"} /></td>
                    <td className="inline">
                      <button className="btn ghost" type="button" onClick={() => run(() => content.updateRetentionPolicy(row.policy_ref, { active: !row.active }), "Policy updated.")}>
                        {row.active ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!policies.length ? <tr><td colSpan="7" className="sub">No retention policies.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create policy</h3></div>
            <form onSubmit={submitPolicy} className="stack">
              <label className="field"><span>Policy code</span>
                <input value={policyForm.policy_code} onChange={(e) => setPolicyForm({ ...policyForm, policy_code: e.target.value })} required />
              </label>
              <label className="field"><span>Name</span>
                <input value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} />
              </label>
              <label className="field"><span>Retention days</span>
                <input type="number" min="0" value={policyForm.retention_days} onChange={(e) => setPolicyForm({ ...policyForm, retention_days: Number(e.target.value) })} />
              </label>
              <label className="field"><span>Disposition</span>
                <select value={policyForm.disposition} onChange={(e) => setPolicyForm({ ...policyForm, disposition: e.target.value })}>
                  {(snapshot?.dispositions || ["review", "delete", "archive", "retain"]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Create policy</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "jobs" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Processing jobs</h3></div>
            <table className="table">
              <thead><tr><th>Job type</th><th>Status</th><th>Count</th></tr></thead>
              <tbody>
                {(processing.jobs || []).map((row, index) => (
                  <tr key={`${row.job_type}-${row.status}-${index}`}>
                    <td className="mono">{fmt(row.job_type)}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{row.count}</td>
                  </tr>
                ))}
                {!(processing.jobs || []).length ? <tr><td colSpan="3" className="sub">No processing jobs.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Renditions</h3></div>
            <table className="table">
              <thead><tr><th>Type</th><th>Status</th><th>Count</th></tr></thead>
              <tbody>
                {(processing.renditions || []).map((row, index) => (
                  <tr key={`${row.rendition_type}-${row.status}-${index}`}>
                    <td className="mono">{fmt(row.rendition_type)}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{row.count}</td>
                  </tr>
                ))}
                {!(processing.renditions || []).length ? <tr><td colSpan="3" className="sub">No renditions.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Recent jobs</h3></div>
            <table className="table">
              <thead><tr><th>Content</th><th>Type</th><th>Status</th><th>Attempts</th></tr></thead>
              <tbody>
                {jobs.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{fmt(row.content_id)}</td>
                    <td className="mono">{fmt(row.job_type)}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{fmt(row.attempts)}</td>
                  </tr>
                ))}
                {!jobs.length ? <tr><td colSpan="4" className="sub">No jobs recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "security" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Scan outcomes</h3></div>
            <table className="table">
              <thead><tr><th>Status</th><th>Count</th></tr></thead>
              <tbody>
                {(security.by_status || []).map((row, index) => (
                  <tr key={`${row.status}-${index}`}>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{row.count}</td>
                  </tr>
                ))}
                {!(security.by_status || []).length ? <tr><td colSpan="2" className="sub">No scans.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Recent detections</h3></div>
            <table className="table">
              <thead><tr><th>Content</th><th>File</th><th>Signature</th><th>When</th></tr></thead>
              <tbody>
                {(security.recent_infections || []).map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{fmt(row.content_key)}</td>
                    <td>{fmt(row.file_name)}</td>
                    <td className="mono">{fmt(row.signature)}</td>
                    <td className="mono">{fmt(row.created_at)}</td>
                  </tr>
                ))}
                {!(security.recent_infections || []).length ? <tr><td colSpan="4" className="sub">No detections.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
