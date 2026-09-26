import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

const CATEGORIES = [
  "*",
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

const EMPTY = {
  name: "",
  description: "",
  category: "*",
  object_type: "*",
  retention_days: 365,
  action: "archive",
  legal_hold: false,
  status: "active",
  priority: 100,
};

export default function AuditRetentionPolicyPanel() {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await audit.retentionPolicies("?includeSystem=true");
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
      if (editing) await audit.updateRetentionPolicy(editing, draft);
      else await audit.createRetentionPolicy(draft);
      setDraft(EMPTY);
      setEditing(null);
      setNotice("Retention policy saved.");
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
      await audit.deleteRetentionPolicy(row.id);
      if (editing === row.id) {
        setEditing(null);
        setDraft(EMPTY);
      }
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function execute() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await audit.executeRetention({ dryRun });
      setNotice(
        dryRun
          ? `Dry run: ${result.archived ?? 0} event(s) would be archived, ${result.purged ?? 0} purged across ${result.runs?.length ?? 0} policy run(s).`
          : `Archived ${result.archived ?? 0} event(s), purged ${result.purged ?? 0}.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return <div className="audit-empty">You do not have permission to manage retention policies.</div>;
  }

  return (
    <div className="audit-retention-policies">
      <form className="panel" onSubmit={submit}>
        <div className="inline" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{editing ? `Edit policy #${editing}` : "New retention policy"}</h3>
          <div className="inline">
            <label className="chip" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run
            </label>
            <button className="btn secondary" type="button" onClick={execute} disabled={busy}>Execute retention</button>
          </div>
        </div>
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          </label>
          <label className="field">
            <span>Category</span>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Object type</span>
            <input value={draft.object_type} onChange={(e) => setDraft({ ...draft, object_type: e.target.value })} placeholder="*" />
          </label>
          <label className="field">
            <span>Retention days</span>
            <input type="number" min="1" value={draft.retention_days} onChange={(e) => setDraft({ ...draft, retention_days: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Action</span>
            <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              <option value="archive">archive</option>
              <option value="purge">purge</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
          </label>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={draft.legal_hold} onChange={(e) => setDraft({ ...draft, legal_hold: e.target.checked })} /> Legal hold
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <button className="btn" type="submit" disabled={busy}>{editing ? "Save" : "Create"}</button>
          {editing ? (
            <button className="btn ghost" type="button" onClick={() => { setEditing(null); setDraft(EMPTY); }}>Cancel</button>
          ) : null}
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Retention policies</h3>
        <table>
          <thead>
            <tr><th>Name</th><th>Category</th><th>Object</th><th>Days</th><th>Action</th><th>Legal hold</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td>{row.name}{row.system ? <span className="badge inactive" style={{ marginLeft: 8 }}>system</span> : null}</td>
                <td className="mono">{row.category}</td>
                <td className="mono">{row.object_type}</td>
                <td style={{ textAlign: "right" }}>{row.retention_days}</td>
                <td className="mono">{row.action}</td>
                <td>{row.legal_hold ? "yes" : "no"}</td>
                <td><span className={`badge ${row.status === "active" ? "active" : "inactive"}`}>{row.status}</span></td>
                <td className="inline">
                  <button className="btn ghost" type="button" onClick={() => { setEditing(row.id); setDraft({ ...EMPTY, ...row }); }}>Edit</button>
                  {!row.system ? (
                    <button className="btn ghost" type="button" onClick={() => remove(row)}>Delete</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!items.length ? <tr><td colSpan={8} className="muted">No retention policies.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
