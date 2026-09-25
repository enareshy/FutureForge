import React, { useCallback, useEffect, useState } from "react";
import { jobs } from "../api.js";
import { useDebouncedValue } from "../hooks.js";

const EMPTY = {
  code: "",
  name: "",
  description: "",
  source_module: "platform",
  handler: "",
  queues: "default",
  max_retries: 0,
  timeout_seconds: 0,
  default_priority: "normal",
};

export default function JobTypesPage() {
  const [list, setList] = useState({ items: [], total: 0 });
  const [draft, setDraft] = useState(EMPTY);
  const [selected, setSelected] = useState(null);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const debouncedQ = useDebouncedValue(q, 300);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ pageSize: "200" });
      if (debouncedQ) params.set("q", debouncedQ);
      setList(await jobs.types(`?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    }
  }, [debouncedQ]);

  useEffect(() => { load(); }, [load]);

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function create() {
    setNotice("");
    setError("");
    try {
      const created = await jobs.createType({
        code: draft.code.trim().toUpperCase(),
        name: draft.name || draft.code.trim().toUpperCase(),
        description: draft.description,
        source_module: draft.source_module,
        handler: draft.handler,
        queues: draft.queues.split(",").map((item) => item.trim()).filter(Boolean),
        max_retries: Number(draft.max_retries) || 0,
        timeout_seconds: Number(draft.timeout_seconds) || 0,
        default_priority: draft.default_priority,
      });
      setNotice(`Created ${created.code}.`);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEdit() {
    setNotice("");
    setError("");
    try {
      const updated = await jobs.updateType(edit.code, {
        name: edit.name,
        description: edit.description,
        source_module: edit.source_module,
        handler: edit.handler,
        queues: Array.isArray(edit.queues) ? edit.queues : String(edit.queues).split(",").map((item) => item.trim()).filter(Boolean),
        max_retries: Number(edit.max_retries) || 0,
        timeout_seconds: Number(edit.timeout_seconds) || 0,
        default_priority: edit.default_priority,
      });
      setNotice(`Updated ${updated.code}.`);
      setSelected(updated);
      setEdit(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(type) {
    setNotice("");
    setError("");
    try {
      const updated = await jobs.setTypeStatus(type.code, !type.active);
      setNotice(`${updated.code} is now ${updated.active ? "active" : "inactive"}.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const priorities = ["low", "normal", "high", "urgent"];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Job type administration</h1>
          <div className="sub">Register the asynchronous work owned by each business module. Handlers execute in the scheduling engine, not here.</div>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <h3>Registered types</h3>
            <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <table>
            <thead><tr><th>Code</th><th>Module</th><th>Priority</th><th>Active</th><th /></tr></thead>
            <tbody>
              {list.items.map((type) => (
                <tr key={type.id}>
                  <td style={{ cursor: "pointer" }} onClick={() => { setSelected(type); setEdit({ ...type }); }}>
                    <div>{type.name}</div>
                    <div className="mono">{type.code}</div>
                  </td>
                  <td className="mono">{type.source_module}</td>
                  <td>{type.default_priority}</td>
                  <td><span className={`badge ${type.active ? "active" : "inactive"}`}>{type.active ? "active" : "inactive"}</span></td>
                  <td className="inline">
                    <button className="btn ghost" type="button" onClick={() => { setSelected(type); setEdit({ ...type }); }}>Edit</button>
                    <button className="btn ghost" type="button" onClick={() => toggle(type)}>{type.active ? "Disable" : "Enable"}</button>
                  </td>
                </tr>
              ))}
              {!list.items.length ? <tr><td colSpan={5} className="muted">No job types.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="panel">
          {edit ? (
            <>
              <div className="panel-head">
                <h3>Edit {edit.code}</h3>
                <button className="btn ghost" type="button" onClick={() => setEdit(null)}>Close</button>
              </div>
              <div className="row">
                <label className="field grow"><span>Name</span>
                  <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </label>
                <label className="field grow"><span>Source module</span>
                  <input value={edit.source_module} onChange={(e) => setEdit({ ...edit, source_module: e.target.value })} />
                </label>
              </div>
              <label className="field"><span>Handler</span>
                <input value={edit.handler || ""} onChange={(e) => setEdit({ ...edit, handler: e.target.value })} />
              </label>
              <div className="row">
                <label className="field grow"><span>Queues (comma separated)</span>
                  <input value={Array.isArray(edit.queues) ? edit.queues.join(", ") : edit.queues || ""} onChange={(e) => setEdit({ ...edit, queues: e.target.value })} />
                </label>
                <label className="field"><span>Default priority</span>
                  <select value={edit.default_priority} onChange={(e) => setEdit({ ...edit, default_priority: e.target.value })}>
                    {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                </label>
              </div>
              <div className="row">
                <label className="field"><span>Max retries</span>
                  <input type="number" min="0" value={edit.max_retries} onChange={(e) => setEdit({ ...edit, max_retries: e.target.value })} />
                </label>
                <label className="field"><span>Timeout (seconds)</span>
                  <input type="number" min="0" value={edit.timeout_seconds} onChange={(e) => setEdit({ ...edit, timeout_seconds: e.target.value })} />
                </label>
              </div>
              <label className="field"><span>Description</span>
                <textarea rows={3} value={edit.description || ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              </label>
              <button className="btn" type="button" onClick={saveEdit}>Save changes</button>
            </>
          ) : selected ? (
            <>
              <div className="panel-head"><h3>{selected.name}</h3></div>
              <div className="chips">
                <span className="chip mono">{selected.code}</span>
                <span className="chip">module: {selected.source_module}</span>
                <span className="chip">priority: {selected.default_priority}</span>
                <span className="chip">retries: {selected.max_retries}</span>
                <span className="chip">timeout: {selected.timeout_seconds}s</span>
              </div>
              <p className="muted" style={{ marginTop: 10 }}>{selected.description || "No description."}</p>
              <div className="mono">handler: {selected.handler || "—"}</div>
              <div className="mono">queues: {(selected.queues || []).join(", ") || "—"}</div>
            </>
          ) : (
            <>
              <div className="panel-head"><h3>Register a job type</h3></div>
              <div className="row">
                <label className="field grow"><span>Code</span>
                  <input value={draft.code} placeholder="MY_JOB" onChange={(e) => patch("code", e.target.value)} />
                </label>
                <label className="field grow"><span>Name</span>
                  <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
                </label>
              </div>
              <div className="row">
                <label className="field grow"><span>Source module</span>
                  <input value={draft.source_module} onChange={(e) => patch("source_module", e.target.value)} />
                </label>
                <label className="field"><span>Default priority</span>
                  <select value={draft.default_priority} onChange={(e) => patch("default_priority", e.target.value)}>
                    {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                </label>
              </div>
              <label className="field"><span>Handler</span>
                <input value={draft.handler} placeholder="jobs.myJob" onChange={(e) => patch("handler", e.target.value)} />
              </label>
              <div className="row">
                <label className="field grow"><span>Queues (comma separated)</span>
                  <input value={draft.queues} onChange={(e) => patch("queues", e.target.value)} />
                </label>
                <label className="field"><span>Max retries</span>
                  <input type="number" min="0" value={draft.max_retries} onChange={(e) => patch("max_retries", e.target.value)} />
                </label>
                <label className="field"><span>Timeout (s)</span>
                  <input type="number" min="0" value={draft.timeout_seconds} onChange={(e) => patch("timeout_seconds", e.target.value)} />
                </label>
              </div>
              <label className="field"><span>Description</span>
                <textarea rows={3} value={draft.description} onChange={(e) => patch("description", e.target.value)} />
              </label>
              <button className="btn" type="button" disabled={!draft.code.trim()} onClick={create}>Create job type</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
