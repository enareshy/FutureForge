import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { files } from "../api.js";

const TABS = ["metrics", "locks", "uploads", "permissions", "events"];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export default function FileAdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("metrics");
  const [metrics, setMetrics] = useState(null);
  const [storage, setStorage] = useState(null);
  const [processing, setProcessing] = useState(null);
  const [locks, setLocks] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [events, setEvents] = useState([]);
  const [vocabulary, setVocabulary] = useState(null);
  const [grant, setGrant] = useState({ resource_type: "file", resource_id: "", principal_type: "user", principal_id: "", permission: "view_content", effect: "allow" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadMetrics = useCallback(async () => {
    const [summary, breakdown, proc] = await Promise.all([
      files.metrics(),
      files.storageMetrics(),
      files.processingMetrics(),
    ]);
    setMetrics(summary);
    setStorage(breakdown);
    setProcessing(proc);
  }, []);

  const loadTab = useCallback(async () => {
    setError("");
    try {
      if (tab === "metrics") await loadMetrics();
      if (tab === "locks") setLocks((await files.locks()).items || []);
      if (tab === "uploads") setUploads((await files.uploads()).items || []);
      if (tab === "permissions") setPermissions((await files.permissions()).items || []);
      if (tab === "events") setEvents((await files.events()).items || []);
      if (!vocabulary) setVocabulary(await files.meta());
    } catch (err) {
      setError(err.message);
    }
  }, [tab, loadMetrics, vocabulary]);

  useEffect(() => { loadTab(); }, [loadTab]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (success) setNotice(success);
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Documents</div>
          <h1>File administration</h1>
          <div className="sub">Storage, locks, upload sessions, access control and events.</div>
        </div>
        <button className="btn ghost" type="button" onClick={() => navigate("/files")}>Back to browser</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="tabs">
        {TABS.map((value) => (
          <button key={value} className={`tab ${tab === value ? "active" : ""}`} type="button" onClick={() => setTab(value)}>
            {value}
          </button>
        ))}
      </div>

      {tab === "metrics" && metrics ? (
        <>
          <div className="grid">
            <div className="stat"><span>Files</span><b>{metrics.totals.files}</b></div>
            <div className="stat"><span>Storage</span><b>{formatBytes(metrics.totals.bytes)}</b></div>
            <div className="stat"><span>Versions</span><b>{metrics.totals.versions}</b></div>
            <div className="stat"><span>Folders</span><b>{metrics.totals.folders}</b></div>
            <div className="stat"><span>Active locks</span><b>{metrics.totals.active_locks}</b></div>
            <div className="stat"><span>Deleted</span><b>{metrics.totals.deleted_files}</b></div>
          </div>
          {processing ? (
            <div className="grid" style={{ marginTop: 14 }}>
              <div className="stat"><span>Processing pending</span><b>{processing.pending}</b></div>
              <div className="stat"><span>Processing failed</span><b>{processing.failed}</b></div>
              <div className="stat"><span>Quarantined</span><b>{processing.quarantined}</b></div>
              <div className="stat"><span>Scan blocked</span><b>{processing.blocked}</b></div>
            </div>
          ) : null}
          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <h3>By status</h3>
              <table>
                <thead><tr><th>Status</th><th>Count</th></tr></thead>
                <tbody>
                  {metrics.by_status.map((row) => <tr key={row.key}><td>{row.key}</td><td>{row.count}</td></tr>)}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h3>Largest files</h3>
              <table>
                <thead><tr><th>Name</th><th>Size</th></tr></thead>
                <tbody>
                  {(storage?.largest_files || []).map((row) => (
                    <tr key={row.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/files/${encodeURIComponent(row.file_ref)}`)}>
                      <td>{row.name}</td>
                      <td className="mono">{formatBytes(row.size_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <h3>By extension</h3>
            <table>
              <thead><tr><th>Extension</th><th>Files</th><th>Bytes</th></tr></thead>
              <tbody>
                {(storage?.by_extension || []).map((row) => (
                  <tr key={row.key}><td>{row.key || "—"}</td><td>{row.files}</td><td className="mono">{formatBytes(row.bytes)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "locks" ? (
        <div className="panel">
          <h3>Active locks</h3>
          <table>
            <thead><tr><th>File</th><th>Held by</th><th>Type</th><th>Reason</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {locks.map((lock) => (
                <tr key={lock.id}>
                  <td style={{ cursor: "pointer" }} onClick={() => navigate(`/files/${encodeURIComponent(lock.file_id)}`)}>{lock.file_name || lock.file_id}</td>
                  <td className="mono">{lock.locked_by_username || lock.locked_by}</td>
                  <td>{lock.lock_type}</td>
                  <td>{lock.reason || "—"}</td>
                  <td className="mono">{lock.expires_at || "never"}</td>
                  <td><button className="btn ghost" type="button" onClick={() => run(() => files.forceReleaseLock(lock.file_id, { reason: "admin release" }), "Lock force-released.")}>Force release</button></td>
                </tr>
              ))}
              {!locks.length ? <tr><td colSpan={6} className="muted">No active locks.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "uploads" ? (
        <div className="panel">
          <h3>Upload sessions</h3>
          <table>
            <thead><tr><th>Name</th><th>Mode</th><th>Status</th><th>Progress</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {uploads.map((row) => (
                <tr key={row.id}>
                  <td><div>{row.name}</div><div className="mono">{row.upload_id}</div></td>
                  <td>{row.upload_mode}</td>
                  <td>{row.status}</td>
                  <td className="mono">{row.received_chunks}/{row.total_chunks}</td>
                  <td className="mono">{row.expires_at || "—"}</td>
                  <td>
                    {["initiated", "in_progress", "completing"].includes(row.status) ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => files.abortUpload(row.upload_id, {}), "Upload aborted.")}>Abort</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!uploads.length ? <tr><td colSpan={6} className="muted">No upload sessions.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "permissions" ? (
        <div className="panel">
          <h3>Permissions</h3>
          <div className="row">
            <label className="field"><span>Resource</span>
              <select value={grant.resource_type} onChange={(e) => setGrant({ ...grant, resource_type: e.target.value })}>
                <option value="file">file</option>
                <option value="folder">folder</option>
              </select>
            </label>
            <label className="field"><span>Resource id</span>
              <input value={grant.resource_id} onChange={(e) => setGrant({ ...grant, resource_id: e.target.value })} />
            </label>
            <label className="field"><span>Principal</span>
              <select value={grant.principal_type} onChange={(e) => setGrant({ ...grant, principal_type: e.target.value })}>
                {(vocabulary?.principal_types || ["user", "group", "role", "tenant"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Principal id</span>
              <input value={grant.principal_id} onChange={(e) => setGrant({ ...grant, principal_id: e.target.value })} />
            </label>
            <label className="field"><span>Permission</span>
              <select value={grant.permission} onChange={(e) => setGrant({ ...grant, permission: e.target.value })}>
                {(vocabulary?.permissions || ["view_content"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Effect</span>
              <select value={grant.effect} onChange={(e) => setGrant({ ...grant, effect: e.target.value })}>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </label>
            <button className="btn" type="button" onClick={() => run(() => files.grantPermission({ ...grant, resource_id: Number(grant.resource_id) || null, principal_id: grant.principal_id || null }), "Permission granted.")}>Grant</button>
          </div>
          <table>
            <thead><tr><th>Resource</th><th>Principal</th><th>Permission</th><th>Effect</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {permissions.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.resource_type}:{row.resource_id}</td>
                  <td className="mono">{row.principal_type}:{row.principal_id ?? "any"}</td>
                  <td>{row.permission}</td>
                  <td>{row.effect}</td>
                  <td className="mono">{row.expires_at || "—"}</td>
                  <td><button className="btn ghost" type="button" onClick={() => run(() => files.revokePermission(row.id), "Permission revoked.")}>Revoke</button></td>
                </tr>
              ))}
              {!permissions.length ? <tr><td colSpan={6} className="muted">No explicit permissions.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "events" ? (
        <div className="panel">
          <h3>File events</h3>
          <table>
            <thead><tr><th>Event</th><th>File</th><th>Actor</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {events.map((row) => (
                <tr key={row.id}>
                  <td>{row.event_type}</td>
                  <td className="mono">{row.file_id ?? "—"}</td>
                  <td className="mono">{row.actor_id ?? "—"}</td>
                  <td>{row.status}</td>
                  <td className="mono">{row.created_at}</td>
                </tr>
              ))}
              {!events.length ? <tr><td colSpan={5} className="muted">No events recorded.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
