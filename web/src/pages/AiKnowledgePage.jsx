import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AiApiError, ai } from "../aiApi.js";

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
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
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
  }, [selected]);

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
          <div className="panel-head"><h3>{selected ? `Documents — ${selected.code}` : "Documents"}</h3></div>
          {!selected ? (
            <p className="muted">Select a source to view or ingest documents.</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr><th>External ID</th><th>Title</th><th>Status</th><th>Size (bytes)</th></tr>
                </thead>
                <tbody>
                  {documents.map((d) => (
                    <tr
                      key={d.id}
                      className={String(d.id) === String(wantDocument) ? "valid" : ""}
                    >
                      <td className="mono">{d.external_id}</td>
                      <td>{d.title || "—"}</td>
                      <td><span className="badge">{d.status}</span></td>
                      <td>{d.size_bytes ?? "—"}</td>
                    </tr>
                  ))}
                  {documents.length === 0 ? (
                    <tr><td colSpan={4} className="muted">No documents indexed.</td></tr>
                  ) : null}
                </tbody>
              </table>

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
