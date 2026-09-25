import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDownload, files } from "../api.js";
import { useDebouncedValue } from "../hooks.js";

function StatusBadge({ status, label }) {
  const tone = ["available", "processing", "checked_out"].includes(status)
    ? "active"
    : ["quarantined", "scan_failed", "upload_failed", "deleted"].includes(status)
      ? "locked"
      : "inactive";
  return <span className={`badge ${tone}`}>{label || status}</span>;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export default function FilesPage() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [tree, setTree] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [filters, setFilters] = useState({ q: "", status: "", file_category: "", security_classification: "" });
  const [sort, setSort] = useState({ sortBy: "created_at", sortDir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [list, setList] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [draft, setDraft] = useState({ folderId: "", security_classification: "internal", description: "" });
  const [progress, setProgress] = useState(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadTree = useCallback(async () => {
    try {
      const res = await files.folderTree();
      setTree(res.items || []);
    } catch {
      setTree([]);
    }
  }, []);

  useEffect(() => {
    files.meta().then(setMeta).catch((err) => setError(err.message));
    loadTree();
  }, [loadTree]);

  const appliedFilters = useDebouncedValue(filters, 300);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(appliedFilters)) if (value) params.set(key, value);
      if (currentFolder) params.set("folderId", String(currentFolder.id));
      else params.set("folderId", "root");
      if (includeDeleted) params.set("includeDeleted", "true");
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sortBy", sort.sortBy);
      params.set("sortDir", sort.sortDir);
      const res = await files.list(`?${params.toString()}`);
      setList(res);
    } catch (err) {
      setError(err.message);
    }
  }, [appliedFilters, currentFolder, includeDeleted, page, pageSize, sort]);

  useEffect(() => { load(); }, [load]);

  const flatFolders = useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        out.push({ ...node, depth });
        if (node.children?.length) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree]);

  const childFolders = useMemo(
    () => flatFolders.filter((folder) => (folder.parent_id ?? null) === (currentFolder?.id ?? null)),
    [flatFolders, currentFolder]
  );

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (success) setNotice(success);
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadFiles(fileList) {
    const selected = Array.from(fileList || []);
    if (!selected.length) return;
    setProgress({ name: "", index: 0, total: selected.length, message: "" });
    try {
      for (let i = 0; i < selected.length; i += 1) {
        const file = selected[i];
        setProgress({ name: file.name, index: i + 1, total: selected.length, message: "initiating" });
        const initiated = await files.initiateUpload({
          name: file.name,
          size: file.size,
          mime_type: file.type || "application/octet-stream",
          folder_id: draft.folderId || currentFolder?.id || null,
          security_classification: draft.security_classification,
          description: draft.description,
        });
        const id = initiated.upload.upload_id;
        if (initiated.upload.upload_mode === "single") {
          setProgress({ name: file.name, index: i + 1, total: selected.length, message: "uploading" });
          await files.completeUploadBuffer(id, file, file.type || "application/octet-stream");
        } else {
          const chunkSize = initiated.chunk_size || 5 * 1024 * 1024;
          const totalChunks = initiated.total_chunks || Math.ceil(file.size / chunkSize);
          for (let c = 0; c < totalChunks; c += 1) {
            setProgress({
              name: file.name,
              index: i + 1,
              total: selected.length,
              message: `chunk ${c + 1}/${totalChunks}`,
            });
            await files.uploadChunk(id, c, file.slice(c * chunkSize, (c + 1) * chunkSize));
          }
          await files.completeUpload(id, {});
        }
      }
      setNotice(`Uploaded ${selected.length} file(s).`);
      await load();
      await loadTree();
    } catch (err) {
      setError(err.message);
    } finally {
      setProgress(null);
    }
  }

  async function createFolder() {
    if (!folderDraft.trim()) return;
    await run(async () => {
      await files.createFolder({
        name: folderDraft.trim(),
        parent_id: currentFolder?.id ?? null,
      });
      setFolderDraft("");
      await loadTree();
    }, "Folder created.");
  }

  async function download(file) {
    await run(async () => {
      const info = await files.downloadInfo(file.file_ref);
      const result = await apiDownload(info.download_url);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = info.filename || file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  }

  async function removeFile(file) {
    await run(async () => {
      await files.remove(file.file_ref, {});
      await load();
    }, `Deleted ${file.name}.`);
  }

  const totalPages = Math.max(1, Math.ceil((list.total || 0) / pageSize));

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Documents</div>
          <h1>File browser</h1>
          <div className="sub">Browse, search and manage every document in the tenant.</div>
        </div>
        <div className="inline">
          <label className="notif-check">
            <input type="checkbox" checked={includeDeleted} onChange={(e) => { setIncludeDeleted(e.target.checked); setPage(1); }} />
            <span>Show deleted</span>
          </label>
          <button className="btn" type="button" onClick={() => setUploadOpen((prev) => !prev)}>
            {uploadOpen ? "Close upload" : "Upload files"}
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      {uploadOpen ? (
        <div className="panel" style={{ background: "#10192f" }}>
          <h3>Upload files</h3>
          <div className="row">
            <label className="field grow"><span>Files</span>
              <input type="file" multiple onChange={(e) => uploadFiles(e.target.files)} disabled={Boolean(progress)} />
            </label>
            <label className="field"><span>Classification</span>
              <select value={draft.security_classification} onChange={(e) => setDraft({ ...draft, security_classification: e.target.value })}>
                {(meta?.security_classifications || []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Description</span>
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
          </div>
          <div className="sub">Destination: {currentFolder ? currentFolder.name : "Root"}</div>
          {progress ? (
            <div className="mono">{progress.name} ({progress.index}/{progress.total}) — {progress.message}</div>
          ) : null}
        </div>
      ) : null}

      <div className="split" style={{ marginTop: 14 }}>
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Folders</h3>
              <div className="inline">
                {currentFolder ? (
                  <button className="btn ghost" type="button" onClick={() => { setCurrentFolder(null); setPage(1); }}>Root</button>
                ) : null}
              </div>
            </div>
            {currentFolder ? <div className="crumbs">/{currentFolder.path}</div> : null}
            <div className="type-list">
              {currentFolder ? (
                <button className="type-row" type="button" onClick={() => setCurrentFolder(flatFolders.find((f) => f.id === currentFolder.parent_id) || null)}>
                  <span className="tree-label">.. up</span>
                </button>
              ) : null}
              {childFolders.map((folder) => (
                <button key={folder.id} className="type-row" type="button" onClick={() => { setCurrentFolder(folder); setPage(1); }}>
                  <span className="tree-label">{folder.name}</span>
                  <span className="tree-meta">{folder.file_count ?? 0}</span>
                </button>
              ))}
              {!childFolders.length ? <div className="muted" style={{ padding: 6 }}>No subfolders.</div> : null}
            </div>
            <div className="row">
              <label className="field grow"><span>New folder</span>
                <input value={folderDraft} onChange={(e) => setFolderDraft(e.target.value)} />
              </label>
              <button className="btn secondary" type="button" onClick={createFolder} disabled={!folderDraft.trim()}>Create</button>
            </div>
          </div>
        </div>

        <div>
          <div className="row">
            <label className="field grow"><span>Search</span>
              <input value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setPage(1); }} />
            </label>
            <label className="field"><span>Status</span>
              <select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}>
                <option value="">Any</option>
                {(meta?.file_statuses || []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Category</span>
              <select value={filters.file_category} onChange={(e) => { setFilters({ ...filters, file_category: e.target.value }); setPage(1); }}>
                <option value="">Any</option>
                {(meta?.file_categories || []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Sort</span>
              <select value={sort.sortBy} onChange={(e) => setSort({ ...sort, sortBy: e.target.value })}>
                {(meta?.sortable || ["created_at", "name", "size_bytes"]).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field"><span>Order</span>
              <select value={sort.sortDir} onChange={(e) => setSort({ ...sort, sortDir: e.target.value })}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
          </div>

          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Category</th><th>Size</th><th>Versions</th><th>Classification</th><th>Updated</th><th /></tr>
            </thead>
            <tbody>
              {list.items.map((file) => (
                <tr key={file.id}>
                  <td style={{ cursor: "pointer" }} onClick={() => navigate(`/files/${encodeURIComponent(file.file_ref)}`)}>
                    <div>{file.name}</div>
                    <div className="mono">{file.file_ref}{file.owner_username ? ` · ${file.owner_username}` : ""}</div>
                  </td>
                  <td><StatusBadge status={file.status} label={file.status_label} /></td>
                  <td>{file.file_category}</td>
                  <td className="mono">{formatBytes(file.size_bytes)}</td>
                  <td>{file.version_count}</td>
                  <td>{file.security_classification}</td>
                  <td className="mono">{file.updated_at}</td>
                  <td className="inline">
                    <button className="btn ghost" type="button" onClick={() => navigate(`/files/${encodeURIComponent(file.file_ref)}`)}>Open</button>
                    {file.is_downloadable ? (
                      <button className="btn ghost" type="button" onClick={() => download(file)}>Download</button>
                    ) : null}
                    {file.is_deleted ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => files.restore(file.file_ref).then(load), `Restored ${file.name}.`)}>Restore</button>
                    ) : (
                      <button className="btn ghost" type="button" onClick={() => removeFile(file)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
              {!list.items.length ? <tr><td colSpan={8} className="muted">No files in this folder.</td></tr> : null}
            </tbody>
          </table>

          <div className="pager">
            <span>{list.total || 0} files · page {list.page || page} of {totalPages}</span>
            <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
      </div>
    </>
  );
}
