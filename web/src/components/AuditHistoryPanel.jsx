import React, { useState } from "react";
import { audit } from "../api.js";
import AuditTimeline from "./AuditTimeline.jsx";
import AuditEventDrawer from "./AuditEventDrawer.jsx";

function valueText(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function AuditHistoryPanel() {
  const [form, setForm] = useState({ objectType: "", objectId: "", attribute: "" });
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (form.attribute) {
        setResult({ mode: "attribute", data: await audit.attributeHistory(form.objectType, form.objectId, `?attribute=${encodeURIComponent(form.attribute)}`) });
      } else {
        setResult({ mode: "relationship", data: await audit.relationshipHistory(form.objectType, form.objectId) });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function open(event) {
    setSelected(event);
    setDetail(null);
    try {
      setDetail(await audit.event(event.id));
    } catch {
      setDetail(event);
    }
  }

  return (
    <div className="audit-history">
      <form className="panel" onSubmit={run}>
        <h3 style={{ marginTop: 0 }}>Object history lookup</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Trace a single attribute's values over time, or reconstruct relationship changes for an object.
          Leave the attribute empty to view relationship history.
        </p>
        <div className="row">
          <label className="field grow">
            <span>Object type</span>
            <input value={form.objectType} onChange={(e) => setForm({ ...form, objectType: e.target.value })} placeholder="object, part, document…" required />
          </label>
          <label className="field grow">
            <span>Object id</span>
            <input value={form.objectId} onChange={(e) => setForm({ ...form, objectId: e.target.value })} required />
          </label>
          <label className="field grow">
            <span>Attribute (optional)</span>
            <input value={form.attribute} onChange={(e) => setForm({ ...form, attribute: e.target.value })} placeholder="state, owner_id, revision…" />
          </label>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Loading…" : "Look up"}</button>
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}

      {result?.mode === "attribute" ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>
            Attribute timeline · <span className="mono">{result.data.object_type} #{result.data.object_id}.{result.data.attribute}</span>
          </h3>
          <table className="audit-diff">
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Before</th><th>After</th></tr>
            </thead>
            <tbody>
              {(result.data.items || []).map((row) => (
                <tr key={row.event_id}>
                  <td className="mono">{row.occurred_at}</td>
                  <td>{row.actor_username || "system"}</td>
                  <td className="mono">{row.action}{row.masked ? " (masked)" : ""}</td>
                  <td className="audit-before">{valueText(row.old_value)}</td>
                  <td className="audit-after">{valueText(row.new_value)}</td>
                </tr>
              ))}
              {!result.data.items?.length ? <tr><td colSpan={5} className="muted">No changes recorded for this attribute.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {result?.mode === "relationship" ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Relationship history · <span className="mono">{form.objectType} #{form.objectId}</span></h3>
          <AuditTimeline events={result.data.items || []} selectedId={selected?.id} onSelect={open} />
        </div>
      ) : null}

      {selected ? <AuditEventDrawer event={detail || selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
