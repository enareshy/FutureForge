import React, { useCallback, useEffect, useMemo, useState } from "react";
import { content } from "../api.js";

const TABS = [
  { key: "library", label: "Content library" },
  { key: "uploads", label: "Upload sessions" },
  { key: "locks", label: "Check-outs" },
  { key: "associations", label: "Associations" },
  { key: "retention", label: "Retention" },
];

const LIFECYCLE_TARGETS = ["available", "archived", "superseded", "retained"];

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
  if (["available", "clean", "completed", "ready", "active", "created"].includes(value)) return "active";
  if (["quarantined", "infected", "failed", "deleted", "error"].includes(value)) return "danger";
  if (["locked", "pending", "pending_security", "uploading", "initiated", "processing", "partial", "skipped"].includes(value)) return "locked";
  return "inactive";
}

function Badge({ status }) {
  return <span className={`badge ${tone(status)}`}>{fmt(status)}</span>;
}

const EMPTY_UPLOAD = { objectType: "", objectId: "", contentRole: "NATIVE", description: "" };

export default function ContentPage() {
  const [tab, setTab] = useState("library");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null);
  const [facets, setFacets] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ q: "", status: "", security_status: "", content_role: "" });
  const [uploadForm, setUploadForm] = useState(EMPTY_UPLOAD);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [renditions, setRenditions] = useState([]);
  const [security, setSecurity] = useState(null);
  const [lock, setLock] = useState(null);
  const [associations, setAssociations] = useState([]);

  const [uploads, setUploads] = useState([]);
  const [locks, setLocks] = useState([]);
  const [allAssociations, setAllAssociations] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [holdReason, setHoldReason] = useState("");
  const [associationForm, setAssociationForm] = useState({ contentId: "", objectType: "", objectId: "", contentRole: "ATTACHMENT" });
  const [policyForm, setPolicyForm] = useState({ policy_code: "", name: "", retention_days: 365, description: "" });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.status) params.set("status", filters.status);
    if (filters.security_status) params.set("securityStatus", filters.security_status);
    if (filters.content_role) params.set("contentRole", filters.content_role);
    params.set("pageSize", "50");
    return `?${params.toString()}`;
  }, [filters]);

  const loadLibrary = useCallback(async () => {
    const [listRes, facetRes] = await Promise.all([content.list(query), content.facets()]);
    setItems(listRes.items || []);
    setTotal(listRes.total ?? (listRes.items || []).length);
    setFacets(facetRes);
  }, [query]);

  const loadAdminLists = useCallback(async () => {
    const [uploadRes, lockRes, associationRes, policyRes] = await Promise.all([
      content.uploads("?limit=50"),
      content.locks("?active=false&limit=50"),
      content.associations("?pageSize=50"),
      content.retentionPolicies("?limit=50"),
    ]);
    setUploads(uploadRes.items || []);
    setLocks(lockRes.items || []);
    setAllAssociations(associationRes.items || []);
    setPolicies(policyRes.items || []);
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [metaRes] = await Promise.all([content.meta(), loadLibrary(), loadAdminLists()]);
      setMeta(metaRes);
    } catch (err) {
      setError(err.message);
    }
  }, [loadLibrary, loadAdminLists]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await fn();
      if (success) setNotice(success);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(ref) {
    setError("");
    try {
      const [detailRes, renditionRes, securityRes, lockRes, associationRes] = await Promise.all([
        content.get(ref),
        content.renditions(ref),
        content.security(ref),
        content.lock(ref),
        content.contentAssociations(ref, "?pageSize=50"),
      ]);
      setSelected(ref);
      setDetail(detailRes);
      setRenditions(renditionRes.items || []);
      setSecurity(securityRes);
      setLock(lockRes.lock || null);
      setAssociations(associationRes.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitUpload(event) {
    event.preventDefault();
    if (!file) {
      setError("Choose a file to upload");
      return;
    }
    const created = await run(
      () => content.upload(file.name, file, file.type || "application/octet-stream", {
        objectType: uploadForm.objectType,
        objectId: uploadForm.objectId,
        contentRole: uploadForm.contentRole,
        description: uploadForm.description,
      }),
      `${file.name} uploaded.`
    );
    if (created) {
      setFile(null);
      setUploadForm(EMPTY_UPLOAD);
      openDetail(created.content_id);
    }
  }

  async function download(ref, version) {
    setError("");
    try {
      const info = version
        ? await content.versionDownloadInfo(ref, version)
        : await content.downloadInfo(ref);
      window.open(info.url, "_blank", "noopener");
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitAssociation(event) {
    event.preventDefault();
    await run(() => content.createAssociation(associationForm), "Association created.");
    setAssociationForm({ contentId: "", objectType: "", objectId: "", contentRole: "ATTACHMENT" });
  }

  async function submitPolicy(event) {
    event.preventDefault();
    await run(() => content.createRetentionPolicy(policyForm), "Retention policy created.");
    setPolicyForm({ policy_code: "", name: "", retention_days: 365, description: "" });
  }

  const selectedContent = detail?.content;
  const contentRef = selectedContent?.content_id;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>File &amp; content management</h2>
          <p className="sub">
            Provider-independent content storage with uploads, security scanning, renditions, versioning,
            associations, check-out locking and retention.
          </p>
        </div>
        <button className="btn ghost" type="button" onClick={refresh} disabled={busy}>Refresh</button>
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

      {tab === "library" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Content</h3><span className="sub">{total} item(s)</span></div>
            <div className="inline" style={{ marginBottom: 12 }}>
              <label className="field"><span>Search</span>
                <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="name, key, checksum" />
              </label>
              <label className="field"><span>Status</span>
                <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">All</option>
                  {(meta?.content_statuses || []).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Security</span>
                <select value={filters.security_status} onChange={(e) => setFilters({ ...filters, security_status: e.target.value })}>
                  <option value="">All</option>
                  {(meta?.security_statuses || []).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Role</span>
                <select value={filters.content_role} onChange={(e) => setFilters({ ...filters, content_role: e.target.value })}>
                  <option value="">All</option>
                  {(meta?.content_roles || []).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <table className="table">
              <thead><tr><th>Key</th><th>Name</th><th>Type</th><th>Size</th><th>Status</th><th>Security</th><th /></tr></thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.content_id}>
                    <td className="mono">{row.content_key}</td>
                    <td>{row.file_name}</td>
                    <td className="mono">{row.mime_type}</td>
                    <td className="mono">{bytes(row.file_size)}</td>
                    <td><Badge status={row.status} /></td>
                    <td><Badge status={row.security_status} /></td>
                    <td className="inline">
                      <button className="btn ghost" type="button" onClick={() => openDetail(row.content_id)}>Open</button>
                      <button className="btn ghost" type="button" disabled={!row.is_downloadable} onClick={() => download(row.content_id)}>Download</button>
                    </td>
                  </tr>
                ))}
                {!items.length ? <tr><td colSpan="7" className="sub">No content matches the current filters.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Upload content</h3></div>
            <form onSubmit={submitUpload} className="stack">
              <label className="field"><span>File</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
              <label className="field"><span>Object type (optional)</span>
                <input value={uploadForm.objectType} onChange={(e) => setUploadForm({ ...uploadForm, objectType: e.target.value })} placeholder="Part" />
              </label>
              <label className="field"><span>Object id (optional)</span>
                <input value={uploadForm.objectId} onChange={(e) => setUploadForm({ ...uploadForm, objectId: e.target.value })} placeholder="P-1001" />
              </label>
              <label className="field"><span>Content role</span>
                <select value={uploadForm.contentRole} onChange={(e) => setUploadForm({ ...uploadForm, contentRole: e.target.value })}>
                  {(meta?.content_roles || ["NATIVE"]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span>
                <input value={uploadForm.description} onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })} />
              </label>
              <button className="btn" type="submit" disabled={busy || !file}>Upload</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "library" && selected ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>Content detail - {selectedContent?.file_name}</h3>
            <button className="btn ghost" type="button" onClick={() => { setSelected(null); setDetail(null); }}>Close</button>
          </div>
          <div className="grid">
            <div className="stat"><span>Key</span><b className="mono">{fmt(selectedContent?.content_key)}</b></div>
            <div className="stat"><span>Status</span><b><Badge status={selectedContent?.status} /></b></div>
            <div className="stat"><span>Security</span><b><Badge status={selectedContent?.security_status} /></b></div>
            <div className="stat"><span>Processing</span><b><Badge status={selectedContent?.processing_status} /></b></div>
            <div className="stat"><span>Size</span><b>{bytes(selectedContent?.file_size)}</b></div>
            <div className="stat"><span>Versions</span><b>{fmt(selectedContent?.version_count)}</b></div>
          </div>

          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn ghost" type="button" disabled={!selectedContent?.is_downloadable} onClick={() => download(selected, null)}>Download current</button>
            {lock ? (
              <button className="btn ghost" type="button" onClick={() => run(() => content.checkin(selected, { lock_token: lock.lock_token, comment: "Checked in from console" }), "Checked in.").then(() => openDetail(selected))}>Check in</button>
            ) : (
              <button className="btn ghost" type="button" onClick={() => run(() => content.checkout(selected, {}), "Checked out.").then(() => openDetail(selected))}>Check out</button>
            )}
            <button className="btn ghost" type="button" onClick={() => run(() => content.requeueProcessing(selected, {}), "Processing requeued.").then(() => openDetail(selected))}>Requeue processing</button>
            {selectedContent?.status === "quarantined" ? (
              <button className="btn ghost" type="button" onClick={() => run(() => content.releaseQuarantine(selected, { reason: "Reviewed" }), "Quarantine released.").then(() => openDetail(selected))}>Release quarantine</button>
            ) : (
              <button className="btn ghost" type="button" onClick={() => run(() => content.quarantine(selected, { reason: "Manual review" }), "Quarantined.").then(() => openDetail(selected))}>Quarantine</button>
            )}
            <button className="btn ghost" type="button" onClick={() => run(() => content.archive(selected, { reason: "Archived from console" }), "Archived.").then(() => openDetail(selected))}>Archive</button>
          </div>

          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Versions</h3></div>
              <table className="table">
                <thead><tr><th>Version</th><th>Size</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {(detail?.versions || []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.version_label}{row.is_current ? " (current)" : ""}</td>
                      <td className="mono">{bytes(row.file_size)}</td>
                      <td><Badge status={row.status} /></td>
                      <td className="inline">
                        <button className="btn ghost" type="button" onClick={() => download(selected, row.version_label)}>Download</button>
                        <button className="btn ghost" type="button" onClick={() => run(() => content.restoreVersion(selected, { version: row.version_label }), `Restored ${row.version_label}.`).then(() => openDetail(selected))}>Restore</button>
                      </td>
                    </tr>
                  ))}
                  {!(detail?.versions || []).length ? <tr><td colSpan="4" className="sub">No versions.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Renditions</h3></div>
              <table className="table">
                <thead><tr><th>Type</th><th>Status</th><th>Size</th><th /></tr></thead>
                <tbody>
                  {renditions.map((row) => (
                    <tr key={row.rendition_ref}>
                      <td className="mono">{row.rendition_type}</td>
                      <td><Badge status={row.status} /></td>
                      <td className="mono">{bytes(row.file_size)}</td>
                      <td className="inline">
                        <button className="btn ghost" type="button" disabled={row.status !== "ready"} onClick={() => content.renditionDownload(selected, row.rendition_ref).then((info) => window.open(info.url, "_blank", "noopener")).catch((err) => setError(err.message))}>Open</button>
                      </td>
                    </tr>
                  ))}
                  {!renditions.length ? <tr><td colSpan="4" className="sub">No renditions.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Security scan</h3></div>
              <table className="table">
                <thead><tr><th>Scanner</th><th>Status</th><th>Signature</th><th>When</th></tr></thead>
                <tbody>
                  {(security?.items || []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.scanner}</td>
                      <td><Badge status={row.status} /></td>
                      <td className="mono">{fmt(row.signature)}</td>
                      <td className="mono">{fmt(row.created_at)}</td>
                    </tr>
                  ))}
                  {!(security?.items || []).length ? <tr><td colSpan="4" className="sub">No scans recorded.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Association &amp; retention</h3></div>
              <table className="table">
                <thead><tr><th>Object</th><th>Role</th><th>Primary</th><th /></tr></thead>
                <tbody>
                  {associations.map((row) => (
                    <tr key={row.association_ref}>
                      <td className="mono">{row.object_type}/{row.object_id}</td>
                      <td className="mono">{row.content_role}</td>
                      <td className="mono">{row.is_primary ? "yes" : "no"}</td>
                      <td className="inline">
                        <button className="btn ghost" type="button" onClick={() => run(() => content.setPrimaryAssociation(row.association_ref), "Primary set.").then(() => openDetail(selected))}>Make primary</button>
                        <button className="btn ghost" type="button" onClick={() => run(() => content.removeAssociation(row.association_ref), "Association removed.").then(() => openDetail(selected))}>Remove</button>
                      </td>
                    </tr>
                  ))}
                  {!associations.length ? <tr><td colSpan="4" className="sub">Not associated with any object.</td></tr> : null}
                </tbody>
              </table>
              <div className="inline" style={{ marginTop: 12 }}>
                <label className="field"><span>Legal hold reason</span>
                  <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Litigation" />
                </label>
                <button className="btn ghost" type="button" onClick={() => run(() => content.applyLegalHold(selected, { reason: holdReason }), "Legal hold applied.").then(() => openDetail(selected))}>Apply hold</button>
                <button className="btn ghost" type="button" onClick={() => run(() => content.releaseLegalHold(selected, { reason: "Released" }), "Legal hold released.").then(() => openDetail(selected))}>Release hold</button>
              </div>
            </div>
          </div>

          <div className="panel-head" style={{ marginTop: 16 }}><h3>Events</h3></div>
          <table className="table">
            <thead><tr><th>Type</th><th>Actor</th><th>When</th></tr></thead>
            <tbody>
              {(detail?.events || []).map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.event_type}</td>
                  <td className="mono">{fmt(row.actor_id)}</td>
                  <td className="mono">{fmt(row.created_at)}</td>
                </tr>
              ))}
              {!(detail?.events || []).length ? <tr><td colSpan="3" className="sub">No events.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "uploads" ? (
        <div className="panel">
          <div className="panel-head"><h3>Upload sessions</h3></div>
          <table className="table">
            <thead><tr><th>Upload</th><th>Name</th><th>Status</th><th>Received</th><th>Expected</th><th>Expires</th></tr></thead>
            <tbody>
              {uploads.map((row) => (
                <tr key={row.upload_id}>
                  <td className="mono">{row.upload_id}</td>
                  <td>{row.file_name}</td>
                  <td><Badge status={row.status} /></td>
                  <td className="mono">{bytes(row.received_size)}</td>
                  <td className="mono">{bytes(row.expected_size)}</td>
                  <td className="mono">{fmt(row.expires_at)}</td>
                </tr>
              ))}
              {!uploads.length ? <tr><td colSpan="6" className="sub">No upload sessions.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "locks" ? (
        <div className="panel">
          <div className="panel-head"><h3>Check-out locks</h3></div>
          <table className="table">
            <thead><tr><th>Token</th><th>Content</th><th>Locked by</th><th>Expires</th><th>Released</th><th /></tr></thead>
            <tbody>
              {locks.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.lock_token}</td>
                  <td className="mono">{row.content_id}</td>
                  <td className="mono">{fmt(row.locked_by)}</td>
                  <td className="mono">{fmt(row.expires_at)}</td>
                  <td className="mono">{fmt(row.released_at)}</td>
                  <td className="inline">
                    {!row.released_at ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => content.unlock(row.content_id, { reason: "Force released" }), "Lock released.")}>Force release</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!locks.length ? <tr><td colSpan="6" className="sub">No locks.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "associations" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Associations</h3></div>
            <table className="table">
              <thead><tr><th>Object</th><th>Content</th><th>Role</th><th>Primary</th><th>Status</th><th /></tr></thead>
              <tbody>
                {allAssociations.map((row) => (
                  <tr key={row.association_ref}>
                    <td className="mono">{row.object_type}/{row.object_id}</td>
                    <td className="mono">{row.content_id}</td>
                    <td className="mono">{row.content_role}</td>
                    <td className="mono">{row.is_primary ? "yes" : "no"}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="inline">
                      <button className="btn ghost" type="button" onClick={() => run(() => content.removeAssociation(row.association_ref), "Association removed.")}>Remove</button>
                    </td>
                  </tr>
                ))}
                {!allAssociations.length ? <tr><td colSpan="6" className="sub">No associations.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create association</h3></div>
            <form onSubmit={submitAssociation} className="stack">
              <label className="field"><span>Content id</span>
                <input value={associationForm.contentId} onChange={(e) => setAssociationForm({ ...associationForm, contentId: e.target.value })} required />
              </label>
              <label className="field"><span>Object type</span>
                <input value={associationForm.objectType} onChange={(e) => setAssociationForm({ ...associationForm, objectType: e.target.value })} required />
              </label>
              <label className="field"><span>Object id</span>
                <input value={associationForm.objectId} onChange={(e) => setAssociationForm({ ...associationForm, objectId: e.target.value })} required />
              </label>
              <label className="field"><span>Role</span>
                <select value={associationForm.contentRole} onChange={(e) => setAssociationForm({ ...associationForm, contentRole: e.target.value })}>
                  {(meta?.content_roles || ["ATTACHMENT"]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <button className="btn" type="submit" disabled={busy}>Create</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "retention" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Retention policies</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Retention days</th><th>Disposition</th><th>Status</th></tr></thead>
              <tbody>
                {policies.map((row) => (
                  <tr key={row.policy_ref || row.id}>
                    <td className="mono">{fmt(row.policy_code)}</td>
                    <td>{row.name}</td>
                    <td className="mono">{fmt(row.retention_days)}</td>
                    <td className="mono">{fmt(row.disposition)}</td>
                    <td><Badge status={row.active ? "active" : "inactive"} /></td>
                  </tr>
                ))}
                {!policies.length ? <tr><td colSpan="5" className="sub">No retention policies.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create retention policy</h3></div>
            <form onSubmit={submitPolicy} className="stack">
              <label className="field"><span>Policy code</span>
                <input value={policyForm.policy_code} onChange={(e) => setPolicyForm({ ...policyForm, policy_code: e.target.value })} required />
              </label>
              <label className="field"><span>Name</span>
                <input value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} required />
              </label>
              <label className="field"><span>Retention days</span>
                <input type="number" min="0" value={policyForm.retention_days} onChange={(e) => setPolicyForm({ ...policyForm, retention_days: Number(e.target.value) })} />
              </label>
              <label className="field"><span>Description</span>
                <input value={policyForm.description} onChange={(e) => setPolicyForm({ ...policyForm, description: e.target.value })} />
              </label>
              <button className="btn" type="submit" disabled={busy}>Create policy</button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
