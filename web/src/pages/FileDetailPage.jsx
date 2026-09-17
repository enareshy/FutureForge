import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiDownload, files } from "../api.js";

const TABS = ["overview", "versions", "access", "associations", "processing"];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export default function FileDetailPage() {
  const { ref } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState("overview");
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [edit, setEdit] = useState({ name: "", description: "", file_category: "", security_classification: "" });
  const [versions, setVersions] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [associations, setAssociations] = useState([]);
  const [processing, setProcessing] = useState(null);
  const [events, setEvents] = useState([]);
  const [grant, setGrant] = useState({ principal_type: "user", principal_id: "", permission: "view_content", effect: "allow", expires_at: "" });
  const [assoc, setAssoc] = useState({ business_object_type: "", business_object_id: "", relationship_type: "attachment" });
  const [permVocabulary, setPermVocabulary] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await files.get(ref);
      setDetail(res);
      setEdit({
        name: res.file.name,
        description: res.file.description || "",
        file_category: res.file.file_category,
        security_classification: res.file.security_classification,
      });
    } catch (err) {
      setError(err.message);
    }
  }, [ref]);

  useEffect(() => { load(); }, [load]);

  const loadTab = useCallback(async () => {
    try {
      if (tab === "versions") setVersions((await files.versions(ref)).items || []);
      if (tab === "access") {
        const [perms, meta] = await Promise.all([files.filePermissions(ref), files.meta()]);
        setPermissions(perms.items || []);
        setPermVocabulary(meta);
      }
      if (tab === "associations") setAssociations((await files.fileAssociations(ref)).items || []);
      if (tab === "processing") {
        const [status, evts] = await Promise.all([files.processing(ref), files.fileEvents(ref)]);
        setProcessing(status);
        setEvents(evts.items || []);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [tab, ref]);

  useEffect(() => { if (detail) loadTab(); }, [detail, loadTab]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (success) setNotice(success);
      await load();
      await loadTab();
    } catch (err) {
      setError(err.message);
    }
  }

  async function download(fileRef, version) {
    await run(async () => {
      const info = version
        ? await files.versionDownloadInfo(fileRef, version)
        : await files.downloadInfo(fileRef);
      const result = await apiDownload(info.download_url);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = info.filename || "download";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  }

  async function uploadRevision(fileList) {
    const file = fileList?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const initiated = await files.initiateUpload({
        file_id: ref,
        name: file.name,
        size: file.size,
        mime_type: file.type || "application/octet-stream",
      });
      const id = initiated.upload.upload_id;
      if (initiated.upload.upload_mode === "single") {
        await files.completeUploadBuffer(id, file, file.type || "application/octet-stream");
      } else {
        const chunkSize = initiated.chunk_size || 5 * 1024 * 1024;
        const totalChunks = initiated.total_chunks || Math.ceil(file.size / chunkSize);
        for (let c = 0; c < totalChunks; c += 1) {
          await files.uploadChunk(id, c, file.slice(c * chunkSize, (c + 1) * chunkSize));
        }
        await files.completeUpload(id, {});
      }
      setNotice("New version uploaded.");
      await load();
      await loadTab();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <>
        {error ? <div className="error">{error}</div> : null}
        <div className="muted">Loading file…</div>
      </>
    );
  }

  const file = detail.file;
  const lock = detail.lock;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Document</div>
          <h1>{file.name}</h1>
          <div className="crumbs">{file.file_ref} · {file.file_category} · v{file.version_count}</div>
        </div>
        <div className="inline">
          <button className="btn ghost" type="button" onClick={() => navigate("/files")}>Back to browser</button>
          {file.is_downloadable ? <button className="btn" type="button" onClick={() => download(file.file_ref, null)}>Download</button> : null}
        </div>
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

      {tab === "overview" ? (
        <div className="split">
          <div className="panel">
            <h3>Metadata</h3>
            <div className="row">
              <label className="field grow"><span>Name</span>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
              <label className="field"><span>Category</span>
                <select value={edit.file_category} onChange={(e) => setEdit({ ...edit, file_category: e.target.value })}>
                  {(permVocabulary?.file_categories || [file.file_category]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Classification</span>
                <select value={edit.security_classification} onChange={(e) => setEdit({ ...edit, security_classification: e.target.value })}>
                  {(permVocabulary?.security_classifications || [file.security_classification]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Description</span>
              <input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </label>
            <button className="btn" type="button" disabled={busy} onClick={() => run(() => files.update(file.file_ref, edit), "Metadata saved.")}>Save</button>
          </div>

          <div className="panel">
            <h3>Properties</h3>
            <ul className="detail-list">
              <li>Status: <span className="mono">{file.status_label}</span></li>
              <li>Size: <span className="mono">{formatBytes(file.size_bytes)}</span></li>
              <li>MIME: <span className="mono">{file.mime_type}</span></li>
              <li>Checksum: <span className="mono">{file.checksum || "—"}</span></li>
              <li>Scan: <span className="mono">{file.virus_scan_status}</span></li>
              <li>Preview: <span className="mono">{file.preview_status}</span></li>
              <li>Owner: <span className="mono">{detail.owner?.username || "—"}</span></li>
              <li>Folder: <span className="mono">{file.folder_id ?? "root"}</span></li>
              <li>Created: <span className="mono">{file.created_at}</span></li>
              <li>Updated: <span className="mono">{file.updated_at}</span></li>
            </ul>
            <h3 style={{ marginTop: 16 }}>Lock</h3>
            {lock ? (
              <>
                <ul className="detail-list">
                  <li>Type: <span className="mono">{lock.lock_type}</span></li>
                  <li>Held by: <span className="mono">{lock.locked_by_username || lock.locked_by}</span></li>
                  <li>Reason: <span className="mono">{lock.reason || "—"}</span></li>
                  <li>Expires: <span className="mono">{lock.expires_at || "never"}</span></li>
                </ul>
                <button className="btn ghost" type="button" onClick={() => run(() => files.releaseLock(file.file_ref, {}), "Lock released.")}>Release lock</button>
              </>
            ) : (
              <>
                <div className="muted">Not locked.</div>
                <button className="btn" type="button" style={{ marginTop: 8 }} onClick={() => run(() => files.checkout(file.file_ref, {}), "Checked out.")}>Check out</button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "versions" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Versions</h3>
            <label className="btn ghost" style={{ cursor: "pointer" }}>
              {busy ? "Uploading…" : "Upload new version"}
              <input type="file" style={{ display: "none" }} disabled={busy} onChange={(e) => uploadRevision(e.target.files)} />
            </label>
          </div>
          <table>
            <thead>
              <tr><th>Version</th><th>Status</th><th>Size</th><th>Checksum</th><th>By</th><th>Created</th><th /></tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>{version.version_label}{version.is_current ? " · current" : ""}</td>
                  <td>{version.status}</td>
                  <td className="mono">{formatBytes(version.size_bytes)}</td>
                  <td className="mono">{version.checksum || "—"}</td>
                  <td className="mono">{version.created_by || "—"}</td>
                  <td className="mono">{version.created_at}</td>
                  <td className="inline">
                    {version.has_content ? (
                      <button className="btn ghost" type="button" onClick={() => download(file.file_ref, version.version_number)}>Download</button>
                    ) : null}
                    {!version.is_current ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => files.restoreVersion(file.file_ref, version.version_number, {}), `Restored ${version.version_label}.`)}>Restore</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!versions.length ? <tr><td colSpan={7} className="muted">No versions.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "access" ? (
        <div className="panel">
          <h3>Access control</h3>
          <div className="row">
            <label className="field"><span>Principal</span>
              <select value={grant.principal_type} onChange={(e) => setGrant({ ...grant, principal_type: e.target.value })}>
                {(permVocabulary?.principal_types || ["user", "group", "role", "tenant"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Principal id</span>
              <input value={grant.principal_id} onChange={(e) => setGrant({ ...grant, principal_id: e.target.value })} />
            </label>
            <label className="field"><span>Permission</span>
              <select value={grant.permission} onChange={(e) => setGrant({ ...grant, permission: e.target.value })}>
                {(permVocabulary?.permissions || ["view_content"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Effect</span>
              <select value={grant.effect} onChange={(e) => setGrant({ ...grant, effect: e.target.value })}>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </label>
            <button className="btn" type="button" onClick={() => run(() => files.grantPermission({ ...grant, resource_type: "file", resource_id: file.id, principal_id: grant.principal_id || null }), "Permission granted.")}>Grant</button>
          </div>
          <table>
            <thead><tr><th>Principal</th><th>Permission</th><th>Effect</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {permissions.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.principal_type}:{row.principal_id ?? "any"}</td>
                  <td>{row.permission}</td>
                  <td>{row.effect}</td>
                  <td className="mono">{row.expires_at || "—"}</td>
                  <td><button className="btn ghost" type="button" onClick={() => run(() => files.revokePermission(row.id), "Permission revoked.")}>Revoke</button></td>
                </tr>
              ))}
              {!permissions.length ? <tr><td colSpan={5} className="muted">No explicit permissions.</td></tr> : null}
            </tbody>
          </table>
          <div className="mono" style={{ marginTop: 8 }}>
            Effective: {(detail.effective_permissions?.allowed || []).join(", ") || "—"}
          </div>
        </div>
      ) : null}

      {tab === "associations" ? (
        <div className="panel">
          <h3>Associations</h3>
          <div className="row">
            <label className="field grow"><span>Business object type</span>
              <input value={assoc.business_object_type} onChange={(e) => setAssoc({ ...assoc, business_object_type: e.target.value })} />
            </label>
            <label className="field grow"><span>Business object id</span>
              <input value={assoc.business_object_id} onChange={(e) => setAssoc({ ...assoc, business_object_id: e.target.value })} />
            </label>
            <label className="field"><span>Relationship</span>
              <select value={assoc.relationship_type} onChange={(e) => setAssoc({ ...assoc, relationship_type: e.target.value })}>
                {(permVocabulary?.association_relationship_types || ["attachment", "reference", "other"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button className="btn" type="button" onClick={() => run(() => files.createAssociation(file.file_ref, assoc), "Association created.")}>Associate</button>
          </div>
          <table>
            <thead><tr><th>Object</th><th>Relationship</th><th>Primary</th><th>Created</th><th /></tr></thead>
            <tbody>
              {associations.map((row) => (
                <tr key={row.id}>
                  <td><div>{row.business_object_name || row.business_object_id}</div><div className="mono">{row.business_object_type}</div></td>
                  <td>{row.relationship_type}</td>
                  <td>{row.is_primary ? "yes" : "no"}</td>
                  <td className="mono">{row.created_at}</td>
                  <td><button className="btn ghost" type="button" onClick={() => run(() => files.removeAssociation(row.id), "Association removed.")}>Remove</button></td>
                </tr>
              ))}
              {!associations.length ? <tr><td colSpan={5} className="muted">No associations.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "processing" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Processing</h3>
              <button className="btn ghost" type="button" onClick={() => run(() => files.requeueProcessing(file.file_ref, "virus_scan"), "Requeued virus scan.")}>Requeue scan</button>
            </div>
            <ul className="detail-list">
              <li>Scan status: <span className="mono">{file.virus_scan_status}</span></li>
              <li>Preview status: <span className="mono">{file.preview_status}</span></li>
              <li>Rendition status: <span className="mono">{file.rendition_status}</span></li>
            </ul>
            <table>
              <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Updated</th></tr></thead>
              <tbody>
                {(processing?.items || []).map((row) => (
                  <tr key={row.id}>
                    <td>{row.processing_type}</td>
                    <td>{row.status}</td>
                    <td>{row.attempts}</td>
                    <td className="mono">{row.updated_at}</td>
                  </tr>
                ))}
                {!(processing?.items || []).length ? <tr><td colSpan={4} className="muted">No processing records.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Events</h3>
            <table>
              <thead><tr><th>Event</th><th>Actor</th><th>When</th></tr></thead>
              <tbody>
                {events.map((row) => (
                  <tr key={row.id}>
                    <td>{row.event_type}</td>
                    <td className="mono">{row.actor_id ?? "—"}</td>
                    <td className="mono">{row.created_at}</td>
                  </tr>
                ))}
                {!events.length ? <tr><td colSpan={3} className="muted">No events.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
