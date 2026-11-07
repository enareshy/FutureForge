import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AiApiError, ai, downloadDocument } from "../aiApi.js";

const emptySource = { code: "", name: "", kind: "manual", classification: "internal" };
const emptyDoc = { external_id: "", title: "", text: "" };

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

export default function AiKnowledgePage() {
  const [sources, setSources] = useState([]);
  const [selected, setSelected] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [sourceForm, setSourceForm] = useState(emptySource);
  const [docForm, setDocForm] = useState(emptyDoc);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [docTitle, setDocTitle] = useState("");
  const [docMetadata, setDocMetadata] = useState("");
  const [metadataError, setMetadataError] = useState("");
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const wantSource = searchParams.get("source");
  const wantDocument = searchParams.get("document");
  const appliedDeepLink = useRef(false);

  function loadSources() {
    setLoadingSources(true);
    return ai
      .sources({ limit: 100 })
      .then((page) => setSources(page.items))
      .catch((e) => setError(describe(e)))
      .finally(() => setLoadingSources(false));
  }

  function loadDocuments(sourceId) {
    ai.documents(sourceId, { limit: 100 })
      .then((page) => setDocuments(page.items))
      .catch((e) => setError(describe(e)));
  }

  useEffect(() => {
    loadSources();
  }, []);
  useEffect(() => {
    if (selected) loadDocuments(selected.id);
    else setDocuments([]);
    setSelectedDoc(null);
    setVersions([]);
  }, [selected]);

  function parseMetadata(text) {
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Metadata must be a JSON object");
    }
    return parsed;
  }

  function editDocument(doc) {
    setSelectedDoc(doc);
    setDocTitle(doc.title || "");
    setDocMetadata(JSON.stringify(doc.metadata || {}, null, 2));
    setMetadataError("");
    setVersions([]);
    loadVersions(doc.id);
  }

  function loadVersions(documentId) {
    setVersionsLoading(true);
    ai.documentVersions(documentId, { limit: 20 })
      .then((page) => setVersions(page.items))
      .catch((e) => setMetadataError(describe(e)))
      .finally(() => setVersionsLoading(false));
  }

  async function saveMetadata(e) {
    e.preventDefault();
    if (!selectedDoc) return;
    setError("");
    setNote("");
    setMetadataError("");
    let metadata;
    try {
      metadata = parseMetadata(docMetadata);
    } catch (err) {
      setMetadataError(`Invalid metadata JSON: ${err.message}`);
      return;
    }
    try {
      const updated = await ai.updateDocument(selectedDoc.id, {
        title: docTitle || null,
        metadata,
        expected_version: selectedDoc.version,
      });
      setSelectedDoc(updated);
      setDocTitle(updated.title || "");
      setDocMetadata(JSON.stringify(updated.metadata || {}, null, 2));
      loadDocuments(selected.id);
      loadVersions(updated.id);
      setNote(`Document updated to version ${updated.version}.`);
    } catch (err) {
      setMetadataError(describe(err));
    }
  }

  async function reindexDocument(doc) {
    setError("");
    setNote("");
    try {
      const res = await ai.reindexDocument(doc.id);
      loadDocuments(selected.id);
      setNote(`Reindexed "${doc.title || doc.external_id}" (${res.documents ?? 0} documents).`);
      if (selectedDoc?.id === doc.id) setSelectedDoc(null);
      setVersions([]);
    } catch (err) {
      setError(describe(err));
    }
  }

  useEffect(() => {
    if (appliedDeepLink.current || !wantSource || sources.length === 0) return;
    const match = sources.find((s) => String(s.id) === String(wantSource));
    if (match) {
      setSelected(match);
      appliedDeepLink.current = true;
    }
  }, [sources, wantSource]);

  async function createSource(e) {
    e.preventDefault();
    setError("");
    setNote("");
    try {
      const created = await ai.createSource(sourceForm);
      setSourceForm(emptySource);
      loadSources();
      setSelected(created);
      setNote(`Source "${created.code}" created.`);
    } catch (err) {
      setError(describe(err));
    }
  }

  async function removeSource(source) {
    if (!window.confirm(`Delete source "${source.code}" and its indexed documents?`)) return;
    setError("");
    try {
      await ai.deleteSource(source.id);
      if (selected?.id === source.id) setSelected(null);
      loadSources();
    } catch (err) {
      setError(describe(err));
    }
  }

  async function ingest(e) {
    e.preventDefault();
    if (!selected) return;
    setError("");
    setNote("");
    try {
      const res = await ai.ingest(selected.id, { documents: [docForm] });
      setDocForm(emptyDoc);
      loadDocuments(selected.id);
      loadSources();
      const job = res.job || {};
      setNote(`Index job #${job.id} ${job.status}.`);
    } catch (err) {
      setError(describe(err));
    }
  }

  async function upload(e) {
    e.preventDefault();
    if (!selected || !uploadFile) return;
    setError("");
    setNote("");
    setUploading(true);
    try {
      const res = await ai.uploadDocument(selected.id, uploadFile);
      setUploadFile(null);
      const input = document.getElementById("knowledge-upload-input");
      if (input) input.value = "";
      loadDocuments(selected.id);
      loadSources();
      const job = res.job || {};
      setNote(
        `Uploaded "${res.document?.title || uploadFile.name}" — job #${job.id} ${job.status}.`
      );
    } catch (err) {
      setError(describe(err));
    } finally {
      setUploading(false);
    }
  }

  async function reindex() {
    if (!selected) return;
    setError("");
    setNote("");
    try {
      const res = await ai.reindexSource(selected.id);
      loadDocuments(selected.id);
      setNote(`Reindex queued for "${selected.code}" (${res.result?.documents ?? 0} documents).`);
    } catch (err) {
      setError(describe(err));
    }
  }

  async function removeDocument(doc) {
    if (!window.confirm(`Delete document "${doc.title || doc.external_id}" and its chunks?`)) return;
    setError("");
    try {
      await ai.deleteDocument(doc.id);
      loadDocuments(selected.id);
      loadSources();
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Knowledge sources</h1>
          <p className="sub">
            Register sources and ingest documents. Indexing and retrieval are tenant-scoped and
            access-controlled.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {note ? <div className="notice">{note}</div> : null}

      <div className="split">
        <div className="panel">
          <div className="panel-head"><h3>Sources</h3></div>
          <table>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Kind</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={selected?.id === s.id ? "valid" : ""}>
                  <td>
                    <button className="link-btn" onClick={() => setSelected(s)}>{s.code}</button>
                  </td>
                  <td>{s.name}</td>
                  <td>{s.kind}</td>
                  <td><span className="badge">{s.status}</span></td>
                  <td>
                    <button className="btn ghost" onClick={() => removeSource(s)}>Delete</button>
                  </td>
                </tr>
              ))}
              {sources.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {loadingSources ? "Loading sources…" : "No sources yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <form onSubmit={createSource}>
            <h3>Create source</h3>
            <label className="field">
              <span>Code</span>
              <input
                value={sourceForm.code}
                onChange={(e) => setSourceForm({ ...sourceForm, code: e.target.value })}
                placeholder="lowercase-code"
                required
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input
                value={sourceForm.name}
                onChange={(e) => setSourceForm({ ...sourceForm, name: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Kind</span>
              <select
                value={sourceForm.kind}
                onChange={(e) => setSourceForm({ ...sourceForm, kind: e.target.value })}
              >
                {["manual", "file", "url", "object"].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Classification</span>
              <select
                value={sourceForm.classification}
                onChange={(e) => setSourceForm({ ...sourceForm, classification: e.target.value })}
              >
                {["public", "internal", "confidential", "restricted"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <button className="btn">Create source</button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{selected ? `Documents — ${selected.code}` : "Documents"}</h3>
            {selected ? (
              <button className="btn secondary" onClick={reindex}>Reindex source</button>
            ) : null}
          </div>
          {!selected ? (
            <p className="muted">Select a source to view or ingest documents.</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr><th>External ID</th><th>Title</th><th>Version</th><th>Status</th><th>Search</th><th>Size (bytes)</th><th></th></tr>
                </thead>
                <tbody>
                  {documents.map((d) => (
                    <tr
                      key={d.id}
                      className={String(d.id) === String(wantDocument) ? "valid" : ""}
                    >
                      <td className="mono">{d.external_id}</td>
                      <td>{d.title || "—"}</td>
                      <td className="mono">v{d.version ?? 1}</td>
                      <td><span className="badge">{d.status}</span></td>
                      <td>
                        {d.error_class ? (
                          <span className="badge">{d.error_class}</span>
                        ) : d.search_indexed_at ? (
                          <span className="muted">indexed</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{d.size_bytes ?? "—"}</td>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <button className="btn ghost" onClick={() => editDocument(d)}>
                            Manage
                          </button>
                          <button
                            className="btn ghost"
                            onClick={() => downloadDocument(d).catch((e) => setError(describe(e)))}
                          >
                            Download
                          </button>
                          <button className="btn ghost" onClick={() => reindexDocument(d)}>
                            Reindex
                          </button>
                          <button className="btn ghost" onClick={() => removeDocument(d)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {documents.length === 0 ? (
                    <tr><td colSpan={7} className="muted">No documents indexed.</td></tr>
                  ) : null}
                </tbody>
              </table>

              {selectedDoc ? (
                <div className="panel" style={{ marginTop: 12 }}>
                  <div className="panel-head">
                    <h3>Document — {selectedDoc.external_id}</h3>
                    <button className="btn ghost" onClick={() => setSelectedDoc(null)}>
                      Close
                    </button>
                  </div>
                  {metadataError ? <div className="error">{metadataError}</div> : null}
                  <form onSubmit={saveMetadata}>
                    <label className="field">
                      <span>Title</span>
                      <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Metadata (JSON)</span>
                      <textarea
                        rows={6}
                        className="mono"
                        value={docMetadata}
                        onChange={(e) => setDocMetadata(e.target.value)}
                        placeholder='{"product": "P-100", "part_number": "PN-42", "revision": "B"}'
                      />
                    </label>
                    <p className="sub">
                      Current version v{selectedDoc.version ?? 1}. Saving creates a new version and
                      refreshes the search copy; chunk content is unchanged.
                    </p>
                    <button className="btn">Save metadata</button>
                  </form>

                  <h3>Version history</h3>
                  <table>
                    <thead>
                      <tr><th>Version</th><th>Title</th><th>Reason</th><th>Status</th><th>Superseded</th></tr>
                    </thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={`${v.document_id}-${v.version}`}>
                          <td className="mono">v{v.version}</td>
                          <td>{v.title || "—"}</td>
                          <td><span className="badge">{v.reason}</span></td>
                          <td>{v.status}</td>
                          <td className="muted">
                            {v.superseded_at ? new Date(v.superseded_at).toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))}
                      {versions.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="muted">
                            {versionsLoading ? "Loading versions…" : "No superseded versions yet."}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <form onSubmit={upload}>
                <h3>Upload file</h3>
                <label className="field">
                  <span>File</span>
                  <input
                    id="knowledge-upload-input"
                    type="file"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  />
                </label>
                <button className="btn" disabled={!uploadFile || uploading}>
                  {uploading ? "Uploading…" : "Upload & index"}
                </button>
              </form>

              <form onSubmit={ingest}>
                <h3>Ingest document</h3>
                <label className="field">
                  <span>External ID</span>
                  <input
                    value={docForm.external_id}
                    onChange={(e) => setDocForm({ ...docForm, external_id: e.target.value })}
                    required
                  />
                </label>
                <label className="field">
                  <span>Title</span>
                  <input
                    value={docForm.title}
                    onChange={(e) => setDocForm({ ...docForm, title: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Text</span>
                  <textarea
                    rows={5}
                    value={docForm.text}
                    onChange={(e) => setDocForm({ ...docForm, text: e.target.value })}
                    required
                  />
                </label>
                <button className="btn">Ingest</button>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
