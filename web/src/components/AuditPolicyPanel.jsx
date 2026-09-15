import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";

const VISIBILITIES = ["admin", "manager", "user"];

const BLANK = {
  name: "",
  object_type: "*",
  description: "",
  visibility: "admin",
  status: "active",
  record_success: true,
  record_failure: true,
  capture_reads: false,
  capture_views: false,
  capture_downloads: true,
  retention_days: 2555,
  actions: "",
  track_attributes: "",
  masked_attributes: "",
  ignored_attributes: "",
};

function toForm(policy) {
  return {
    name: policy.name || "",
    object_type: policy.object_type || "*",
    description: policy.description || "",
    visibility: policy.visibility || "admin",
    status: policy.status || "active",
    record_success: !!policy.record_success,
    record_failure: !!policy.record_failure,
    capture_reads: !!policy.capture_reads,
    capture_views: !!policy.capture_views,
    capture_downloads: !!policy.capture_downloads,
    retention_days: policy.retention_days ?? 2555,
    actions: (policy.actions || []).join(", "),
    track_attributes: (policy.track_attributes || []).join(", "),
    masked_attributes: (policy.masked_attributes || []).join(", "),
    ignored_attributes: (policy.ignored_attributes || []).join(", "),
  };
}

function toPayload(form) {
  const split = (value) =>
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  return {
    name: form.name,
    object_type: form.object_type,
    description: form.description,
    visibility: form.visibility,
    status: form.status,
    record_success: form.record_success,
    record_failure: form.record_failure,
    capture_reads: form.capture_reads,
    capture_views: form.capture_views,
    capture_downloads: form.capture_downloads,
    retention_days: Number(form.retention_days) || 0,
    actions: split(form.actions),
    track_attributes: split(form.track_attributes),
    masked_attributes: split(form.masked_attributes),
    ignored_attributes: split(form.ignored_attributes),
  };
}

export default function AuditPolicyPanel() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await audit.policies("?includeSystem=true");
      setItems(res.items || []);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function startCreate() {
    setForm(BLANK);
    setEditingId(null);
    setShowForm(true);
    setError("");
    setNotice("");
  }

  function startEdit(policy) {
    setForm(toForm(policy));
    setEditingId(policy.id);
    setShowForm(true);
    setError("");
    setNotice("");
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      if (editingId) await audit.updatePolicy(editingId, toPayload(form));
      else await audit.createPolicy(toPayload(form));
      setShowForm(false);
      setNotice(editingId ? "Policy updated." : "Policy created.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(policy) {
    setError("");
    setNotice("");
    try {
      await audit.deletePolicy(policy.id);
      setNotice("Policy deleted.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (denied) {
    return <div className="audit-empty">You do not have permission to manage audit policies.</div>;
  }

  return (
    <div className="audit-policies">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Audit policies</h3>
        <button className="btn" type="button" onClick={startCreate}>New policy</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      {showForm ? (
        <form className="panel" onSubmit={save}>
          <div className="row">
            <label className="field grow"><span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field grow"><span>Object type</span>
              <input value={form.object_type} onChange={(e) => setForm({ ...form, object_type: e.target.value })} required />
            </label>
            <label className="field"><span>Visibility</span>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Status</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </select>
            </label>
            <label className="field"><span>Retention (days)</span>
              <input type="number" min="0" value={form.retention_days} onChange={(e) => setForm({ ...form, retention_days: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>Description</span>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="row">
            <label className="field grow"><span>Tracked attributes (comma separated)</span>
              <input value={form.track_attributes} onChange={(e) => setForm({ ...form, track_attributes: e.target.value })} />
            </label>
            <label className="field grow"><span>Masked attributes</span>
              <input value={form.masked_attributes} onChange={(e) => setForm({ ...form, masked_attributes: e.target.value })} />
            </label>
            <label className="field grow"><span>Ignored attributes</span>
              <input value={form.ignored_attributes} onChange={(e) => setForm({ ...form, ignored_attributes: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>Allowed actions (blank = all)</span>
            <input value={form.actions} onChange={(e) => setForm({ ...form, actions: e.target.value })} placeholder="object.create, object.update" />
          </label>
          <div className="chips">
            {[
              ["record_success", "Record success"],
              ["record_failure", "Record failure"],
              ["capture_reads", "Capture reads"],
              ["capture_views", "Capture views"],
              ["capture_downloads", "Capture downloads"],
            ].map(([key, label]) => (
              <label key={key} className="chip" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn" type="submit">{editingId ? "Save changes" : "Create policy"}</button>
            <button className="btn ghost" type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Scope</th><th>Object type</th><th>Visibility</th><th>Retention</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.map((policy) => (
              <tr key={policy.id}>
                <td>{policy.tenant_id ? <span className="badge">tenant {policy.tenant_id}</span> : <span className="badge inactive">system</span>}</td>
                <td><b>{policy.object_type}</b><div className="mono">{policy.name}</div></td>
                <td><span className="chip">{policy.visibility}</span></td>
                <td>{policy.retention_days} days</td>
                <td><span className={`badge ${policy.status}`}>{policy.status}</span></td>
                <td>
                  <div className="inline">
                    <button className="btn secondary" type="button" onClick={() => startEdit(policy)}>Edit</button>
                    <button className="btn danger" type="button" onClick={() => remove(policy)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
