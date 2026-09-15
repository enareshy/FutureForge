import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";
import AuditTimeline from "./AuditTimeline.jsx";
import AuditEventDrawer from "./AuditEventDrawer.jsx";

export default function ObjectHistoryPanel({ objectType = "object", objectId }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (!objectId) return;
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const res = await audit.objectHistory(objectType, objectId, "?pageSize=100");
      setData(res);
    } catch (err) {
      if (err.status === 403) {
        setDenied(true);
        setData({ items: [], total: 0 });
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [objectType, objectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function open(event) {
    setSelected(event);
    setDetail(null);
    try {
      const full = await audit.event(event.id);
      setDetail(full);
    } catch {
      setDetail(event);
    }
  }

  if (denied) {
    return (
      <div className="audit-empty">
        You do not have permission to view this object's history. Ask an administrator for the audit history
        permission.
      </div>
    );
  }

  return (
    <div className="audit-history">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Change history</h3>
        <button className="btn ghost" type="button" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {loading && !data.items.length ? <div className="audit-empty">Loading history…</div> : null}
      <AuditTimeline
        events={data.items}
        selectedId={selected?.id}
        onSelect={open}
        emptyText="No history has been recorded for this object yet."
      />
      {selected ? <AuditEventDrawer event={detail || selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
