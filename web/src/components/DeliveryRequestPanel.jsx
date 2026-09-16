import React, { useCallback, useEffect, useState } from "react";
import { delivery } from "../api.js";

const EMPTY = { channel: "in_app", recipient_address: "", recipient_name: "", subject: "", body: "", priority: "normal" };

export default function DeliveryRequestPanel({ meta, scope }) {
  const [filters, setFilters] = useState({ q: "", status: "", channel: "" });
  const [list, setList] = useState({ items: [], total: 0 });
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      params.set("pageSize", "50");
      const res = await delivery.requests(`?${scope}${params.toString()}`);
      setList(res);
    } catch (err) {
      setError(err.message);
    }
  }, [filters, scope]);

  useEffect(() => { load(); }, [load]);

  async function open(row) {
    try {
      setSelected(await delivery.request(row.id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function retry(id) {
    try {
      await delivery.retryRequest(id);
      await load();
      if (selected?.id === id) await open({ id });
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancel(id) {
    try {
      await delivery.cancelRequest(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function processQueue() {
    setBusy(true);
    setNotice("");
    try {
      const res = await delivery.process(200);
      setNotice(`Processed ${res.processed ?? 0}; sent ${res.sent ?? 0}; retried ${res.retried ?? 0}; failed ${res.failed ?? 0}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setNotice("");
    try {
      const res = await delivery.submitRequest({
        channel: draft.channel,
        recipient_address: draft.recipient_address,
        recipient_name: draft.recipient_name,
        subject: draft.subject,
        body: draft.body,
        priority: draft.priority,
        source_module: "delivery-console",
      });
      setNotice(`Queued request #${res.id} (${res.status}).`);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const statuses = meta?.statuses || [];
  const channels = meta?.channels || [];
  const priorities = meta?.priorities || [];

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Delivery requests</h3>
        <button className="btn secondary" type="button" disabled={busy} onClick={processQueue}>
          {busy ? "Processing…" : "Process queue"}
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="panel" style={{ background: "#10192f" }}>
        <h3>Queue a request</h3>
        <div className="row">
          <label className="field"><span>Channel</span>
            <select value={draft.channel} onChange={(e) => patch("channel", e.target.value)}>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>Priority</span>
            <select value={draft.priority} onChange={(e) => patch("priority", e.target.value)}>
              {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Recipient name</span>
            <input value={draft.recipient_name} onChange={(e) => patch("recipient_name", e.target.value)} />
          </label>
          <label className="field grow"><span>Recipient address</span>
            <input value={draft.recipient_address} onChange={(e) => patch("recipient_address", e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field grow"><span>Subject</span>
            <input value={draft.subject} onChange={(e) => patch("subject", e.target.value)} />
          </label>
        </div>
        <label className="field"><span>Body</span>
          <textarea rows={3} value={draft.body} onChange={(e) => patch("body", e.target.value)} />
        </label>
        <button className="btn" type="button" onClick={submit}>Submit request</button>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <label className="field grow"><span>Search</span>
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        </label>
        <label className="field"><span>Status</span>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Any</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field"><span>Channel</span>
          <select value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })}>
            <option value="">Any</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button className="btn" type="button" onClick={load}>Apply</button>
      </div>

      <table>
        <thead><tr><th>ID</th><th>Recipient</th><th>Channel</th><th>Provider</th><th>Priority</th><th>Status</th><th>Attempts</th><th>Created</th><th /></tr></thead>
        <tbody>
          {list.items.map((row) => (
            <tr key={row.id}>
              <td className="mono">#{row.id}</td>
              <td>{row.recipient_name || row.recipient_address || row.recipient_id || "—"}</td>
              <td>{row.channel}</td>
              <td className="mono">{row.provider_code || "—"}</td>
              <td>{row.priority}</td>
              <td><span className={`badge ${row.dead_letter ? "locked" : ["sent", "delivered"].includes(row.status) ? "active" : ""}`}>{row.status_label || row.status}</span></td>
              <td>{row.attempt}/{row.max_attempts}</td>
              <td className="mono">{row.created_at}</td>
              <td className="inline">
                <button className="btn ghost" type="button" onClick={() => open(row)}>View</button>
                {["failed", "dead_lettered"].includes(row.status) ? (
                  <button className="btn ghost" type="button" onClick={() => retry(row.id)}>Retry</button>
                ) : null}
                {["created", "queued", "retrying", "processing"].includes(row.status) ? (
                  <button className="btn ghost" type="button" onClick={() => cancel(row.id)}>Cancel</button>
                ) : null}
              </td>
            </tr>
          ))}
          {!list.items.length ? <tr><td colSpan={9} className="muted">No delivery requests.</td></tr> : null}
        </tbody>
      </table>

      {selected ? (
        <div className="panel" style={{ marginTop: 14, background: "#10192f" }}>
          <div className="panel-head">
            <h3>Request #{selected.id} · {selected.subject || "(no subject)"}</h3>
            <button className="btn ghost" type="button" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="chips" style={{ marginBottom: 8 }}>
            <span className="chip">channel: {selected.channel}</span>
            <span className="chip">provider: {selected.provider_code || "—"}</span>
            <span className="chip">status: {selected.status_label || selected.status}</span>
            <span className="chip">priority: {selected.priority}</span>
            {selected.dead_letter ? <span className="chip">dead letter</span> : null}
          </div>
          {selected.error_message ? <div className="error">{selected.error_code}: {selected.error_message}</div> : null}
          <table>
            <thead><tr><th>Attempt</th><th>Provider</th><th>Status</th><th>Error</th><th>Duration</th><th>Finished</th></tr></thead>
            <tbody>
              {(selected.attempts || []).map((row) => (
                <tr key={row.id}>
                  <td>{row.attempt}</td>
                  <td className="mono">{row.provider_code || "—"}</td>
                  <td>{row.status}</td>
                  <td className="muted">{row.error_code || ""}</td>
                  <td>{row.duration_ms != null ? `${row.duration_ms} ms` : "—"}</td>
                  <td className="mono">{row.finished_at || "—"}</td>
                </tr>
              ))}
              {!selected.attempts?.length ? <tr><td colSpan={6} className="muted">No attempts recorded.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
