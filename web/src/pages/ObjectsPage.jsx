import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { objects } from "../api.js";
import FormRenderer from "../components/FormRenderer.jsx";

const OBJECT_STATUSES = ["draft", "active", "released", "obsolete", "archived"];

function StatusBadge({ status }) {
  return <span className={`badge ${status === "active" || status === "released" ? "active" : ""}`}>{status}</span>;
}

function seedValues(tree) {
  const next = {};
  for (const field of tree?.fields || []) {
    if (next[field.code] !== undefined) continue;
    if (field.multi_value) next[field.code] = [];
    else if (field.data_type === "boolean") next[field.code] = field.default === true || field.default === "true";
    else next[field.code] = field.default ?? "";
  }
  return next;
}

export default function ObjectsPage() {
  const navigate = useNavigate();
  const pageSize = 20;
  const [types, setTypes] = useState([]);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ type: "", status: "", q: "", includeDeleted: false });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createTypeId, setCreateTypeId] = useState("");
  const [createTree, setCreateTree] = useState(null);
  const [createValues, setCreateValues] = useState({});
  const [createMeta, setCreateMeta] = useState({ code: "", name: "" });
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (filters.type) params.set("type", filters.type);
    if (filters.status) params.set("status", filters.status);
    if (filters.q) params.set("q", filters.q);
    if (filters.includeDeleted) params.set("include_deleted", "true");
    return `?${params.toString()}`;
  }, [page, filters]);

  const load = useCallback(async () => {
    setError("");
    const [typeRes, summaryRes, listRes] = await Promise.all([
      objects.types(),
      objects.summary(),
      objects.list(query),
    ]);
    setTypes(typeRes.items || []);
    setSummary(summaryRes);
    setItems(listRes.items || []);
    setTotal(listRes.total || 0);
  }, [query]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function pickCreateType(id) {
    setCreateTypeId(id);
    setCreateTree(null);
    setCreateValues({});
    if (!id) return;
    try {
      const tree = await objects.typeForm(id, "?mode=create");
      setCreateTree(tree);
      setCreateValues(seedValues(tree));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitCreate(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = { type: createTypeId, data: createValues };
      if (createMeta.code) payload.code = createMeta.code;
      if (createMeta.name) payload.name = createMeta.name;
      const created = await objects.create(payload);
      setNotice(`Object ${created.code} created.`);
      setShowCreate(false);
      setCreateTypeId("");
      setCreateTree(null);
      setCreateValues({});
      setCreateMeta({ code: "", name: "" });
      navigate(`/objects/${created.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Object &amp; Relationship Framework</div>
          <h1>Business objects</h1>
          <p className="sub">
            Metadata-typed instances with lifecycle, revisioning, lock, relationship, reference and dependency
            management. Every record is tenant-isolated.
          </p>
        </div>
        <button className="btn" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Close" : "New object"}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      {summary ? (
        <div className="grid" style={{ marginBottom: 16 }}>
          <div className="stat">
            <span className="mono">Objects</span>
            <b>{summary.total}</b>
          </div>
          <div className="stat">
            <span className="mono">Deleted</span>
            <b>{summary.deleted}</b>
          </div>
          {summary.by_status.slice(0, 4).map((row) => (
            <div className="stat" key={row.status}>
              <span className="mono">{row.status}</span>
              <b>{row.count}</b>
            </div>
          ))}
        </div>
      ) : null}

      {showCreate ? (
        <form className="panel" onSubmit={submitCreate}>
          <div className="panel-head">
            <h3>Create object</h3>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="field grow">
              <span>Object type</span>
              <select value={createTypeId} onChange={(e) => pickCreateType(e.target.value)}>
                <option value="">Select a type…</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>Code (optional, auto-generated)</span>
              <input value={createMeta.code} onChange={(e) => setCreateMeta({ ...createMeta, code: e.target.value })} />
            </label>
            <label className="field grow">
              <span>Name (optional, defaults to code)</span>
              <input value={createMeta.name} onChange={(e) => setCreateMeta({ ...createMeta, name: e.target.value })} />
            </label>
          </div>
          {createTree ? (
            <FormRenderer
              tree={createTree}
              values={createValues}
              onChange={(code, value) => setCreateValues((prev) => ({ ...prev, [code]: value }))}
            />
          ) : (
            <p className="mono">Pick a type to render its attribute contract.</p>
          )}
          <button className="btn" disabled={!createTypeId || busy} style={{ marginTop: 12 }}>
            {busy ? "Creating…" : "Create object"}
          </button>
        </form>
      ) : null}

      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field grow">
            <span>Search code / name / description</span>
            <input
              value={filters.q}
              onChange={(e) => {
                setPage(1);
                setFilters({ ...filters, q: e.target.value });
              }}
            />
          </label>
          <label className="field grow">
            <span>Type</span>
            <select
              value={filters.type}
              onChange={(e) => {
                setPage(1);
                setFilters({ ...filters, type: e.target.value });
              }}
            >
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name} ({t.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(e) => {
                setPage(1);
                setFilters({ ...filters, status: e.target.value });
              }}
            >
              <option value="">All statuses</option>
              {OBJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Include deleted</span>
            <input
              type="checkbox"
              checked={filters.includeDeleted}
              onChange={(e) => {
                setPage(1);
                setFilters({ ...filters, includeDeleted: e.target.checked });
              }}
            />
          </label>
        </div>

        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Rev</th>
              <th>Owner</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/objects/${row.id}`} className="mono">
                    {row.code}
                  </Link>
                </td>
                <td>{row.name}</td>
                <td>{row.type?.name}</td>
                <td>
                  <StatusBadge status={row.status} />
                  {row.deleted ? <span className="badge locked">deleted</span> : null}
                  {row.locked ? <span className="badge locked">locked</span> : null}
                </td>
                <td>{row.revision}</td>
                <td>{row.owner?.display_name || row.owner?.username || "—"}</td>
                <td className="mono">{row.updated_at}</td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td colSpan={7} className="mono">
                  No objects match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div className="pager">
          <button className="btn ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Prev
          </button>
          <span className="mono">
            Page {page} / {totalPages} · {total} objects
          </span>
          <button className="btn ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
    </>
  );
}
