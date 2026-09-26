import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

const CATEGORIES = [
  "object_data",
  "attribute_change",
  "relationship",
  "lifecycle",
  "workflow",
  "approval",
  "document",
  "security",
  "authentication",
  "authorization",
  "configuration",
  "integration",
  "background_job",
  "administration",
  "compliance",
];

const EVENT_TYPES = [
  "CREATE", "UPDATE", "DELETE", "RESTORE", "ARCHIVE", "VIEW", "READ", "DOWNLOAD", "UPLOAD",
  "CHECK_IN", "CHECK_OUT", "LOCK", "UNLOCK", "STATE_CHANGE", "LIFECYCLE_TRANSITION",
  "WORKFLOW_ACTION", "WORKFLOW_STARTED", "WORKFLOW_COMPLETED", "WORKFLOW_REJECTED",
  "WORKFLOW_CANCELLED", "TASK_ASSIGNED", "TASK_COMPLETED", "APPROVED", "REJECTED",
  "RELATIONSHIP_CHANGE", "RELATIONSHIP_CREATED", "RELATIONSHIP_REMOVED", "PERMISSION_CHANGE",
  "ROLE_CHANGED", "ASSIGN", "LOGIN", "LOGIN_FAILED", "LOGOUT", "PASSWORD_CHANGED", "MFA_CHANGED",
  "EXPORT", "IMPORT", "CONFIGURATION_CHANGED", "INTEGRATION_EXECUTED", "JOB_STARTED",
  "JOB_COMPLETED", "JOB_FAILED", "VERSION_CREATED", "ADMIN_ACTION", "ACCESS_DENIED", "ACCESS",
];

const EMPTY = {
  code: "",
  label: "",
  category: "object_data",
  event_type: "UPDATE",
  description: "",
  mandatory: false,
  active: true,
};

export default function AuditActionTypePanel() {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await audit.actionTypes();
      setItems(res.items || []);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (editing) await audit.updateActionType(editing, draft);
      else await audit.createActionType(draft);
      setDraft(EMPTY);
      setEditing(null);
      setNotice("Action type saved.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row) {
    setError("");
    try {
      await audit.deleteActionType(row.code);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (denied) {
    return <div className="audit-empty">You do not have permission to manage action types.</div>;
  }

  return (
    <div className="audit-action-types">
      <form className="panel" onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>{editing ? `Edit action type · ${editing}` : "Register action type"}</h3>
        <div className="row">
          <label className="field grow">
            <span>Code</span>
            <input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              placeholder="object.attribute.updated"
              disabled={!!editing}
              required
            />
          </label>
          <label className="field grow">
            <span>Label</span>
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </label>
          <label className="field">
            <span>Category</span>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Event type</span>
            <select value={draft.event_type} onChange={(e) => setDraft({ ...draft, event_type: e.target.value })}>
              {EVENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={draft.mandatory} onChange={(e) => setDraft({ ...draft, mandatory: e.target.checked })} /> Mandatory
          </label>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <button className="btn" type="submit" disabled={busy}>{editing ? "Save" : "Register"}</button>
          {editing ? (
            <button className="btn ghost" type="button" onClick={() => { setEditing(null); setDraft(EMPTY); }}>Cancel</button>
          ) : null}
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Registered action types</h3>
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Category</th><th>Event type</th><th>Mandatory</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.code}>
                <td className="mono">{row.code}</td>
                <td>{row.label || "—"}</td>
                <td className="mono">{row.category}</td>
                <td className="mono">{row.event_type}</td>
                <td>{row.mandatory ? "yes" : "no"}</td>
                <td><span className={`badge ${row.active ? "active" : "inactive"}`}>{row.active ? "active" : "inactive"}</span></td>
                <td className="inline">
                  <button className="btn ghost" type="button" onClick={() => { setEditing(row.code); setDraft({ ...EMPTY, ...row }); }}>Edit</button>
                  {!row.system ? (
                    <button className="btn ghost" type="button" onClick={() => remove(row)}>Delete</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!items.length ? <tr><td colSpan={7} className="muted">No action types registered.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
