import React, { useState } from "react";
import { integration } from "../../api.js";
import { JsonBlock, Notice, Pager, Section, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

export default function IntegrationEventsPanel() {
  const [tab, setTab] = useState("events");
  return (
    <>
      <div className="tabs">
        {[["events", "Event stream"], ["types", "Event types"], ["subscriptions", "Subscriptions"], ["deliveries", "Deliveries"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "events" ? <Events /> : null}
      {tab === "types" ? <EventTypes /> : null}
      {tab === "subscriptions" ? <Subscriptions /> : null}
      {tab === "deliveries" ? <Deliveries /> : null}
    </>
  );
}

function Events() {
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState("");
  const [payload, setPayload] = useState("{}");
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => integration.events(`?page=${page}&pageSize=25${eventType ? `&event_type_code=${eventType}` : ""}`), [page, eventType]);
  const types = useAsync(() => integration.eventTypes("?pageSize=100"), []);

  async function publish(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      let body = {};
      if (payload.trim()) body = JSON.parse(payload);
      const result = await integration.publishEvent({ event_type_code: eventType, payload: body, source_module: "ui" });
      setNotice(`Event ${result.event_ref} published to ${result.deliveries?.length || 0} subscriber(s).`);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="panel" onSubmit={publish}>
        <div className="row">
          <label className="field grow"><span>Event type</span>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)} required>
              <option value="">Select an event type…</option>
              {(types.data?.items || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Payload (JSON)</span><input value={payload} onChange={(e) => setPayload(e.target.value)} /></label>
          <button className="btn" type="submit" disabled={busy || !eventType}>{busy ? "Publishing…" : "Publish event"}</button>
        </div>
      </form>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={setSelected}
          columns={[
            { key: "event_ref", label: "Event", render: (r) => <span className="mono">{r.event_ref}</span> },
            { key: "event_type_code", label: "Type" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "delivery_count", label: "Deliveries", render: (r) => r.delivery_count ?? r.deliveries?.length ?? "—" },
            { key: "source_module", label: "Source" },
            { key: "occurred_at", label: "Occurred", render: (r) => ts(r.occurred_at || r.created_at) },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>

      {selected ? (
        <div className="panel">
          <div className="panel-head"><h3>Event {selected.event_ref}</h3>
            <div className="inline">
              <button className="btn secondary" type="button" onClick={async () => { try { await integration.replayEvent(selected.event_ref); setNotice(`Event ${selected.event_ref} replayed.`); await list.reload(); } catch (err) { setNotice(err.message); } }}>Replay</button>
              <button className="btn ghost" type="button" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          <JsonBlock value={selected.payload || selected.payload_json || {}} />
        </div>
      ) : null}
    </>
  );
}

function EventTypes() {
  const [form, setForm] = useState({ code: "", category: "domain", description: "" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.eventTypes("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      await integration.createEventType(form);
      setNotice(`Event type ${form.code} created.`);
      setForm({ code: "", category: "domain", description: "" });
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New event type"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field"><span>Category</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {["domain", "integration", "security", "lifecycle", "workflow", "system"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Description</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Create event type</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "category", label: "Category" },
            { key: "direction", label: "Direction", render: (r) => r.direction },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "description", label: "Description" },
            {
              key: "actions",
              label: "",
              render: (r) => (r.system ? <span className="muted">system</span> : (
                <button className="link muted" type="button" onClick={async () => { try { await integration.deleteEventType(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
              )),
            },
          ]}
        />
      </Section>
    </>
  );
}

function Subscriptions() {
  const [form, setForm] = useState({ code: "", event_type_code: "", subscriber_type: "webhook", target_ref: "", filter: "{}" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.subscriptions("?pageSize=100"), []);
  const types = useAsync(() => integration.eventTypes("?pageSize=100"), []);
  const outbound = useAsync(() => integration.outboundWebhooks("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      const filter = form.filter.trim() ? JSON.parse(form.filter) : {};
      await integration.createSubscription({ ...form, filter });
      setNotice(`Subscription ${form.code} created.`);
      setForm({ code: "", event_type_code: "", subscriber_type: "webhook", target_ref: "", filter: "{}" });
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New subscription"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Event type</span>
              <select value={form.event_type_code} onChange={(e) => setForm({ ...form, event_type_code: e.target.value })} required>
                <option value="">Select…</option>
                {(types.data?.items || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
              </select>
            </label>
            <label className="field"><span>Subscriber</span>
              <select value={form.subscriber_type} onChange={(e) => setForm({ ...form, subscriber_type: e.target.value })}>
                {["webhook", "internal", "message_queue", "email", "custom"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Target</span>
              <input value={form.target_ref} onChange={(e) => setForm({ ...form, target_ref: e.target.value })} placeholder={form.subscriber_type === "webhook" ? "outbound webhook code" : "handler / queue name"} list="intg-outbound-hooks" />
              <datalist id="intg-outbound-hooks">
                {(outbound.data?.items || []).map((w) => <option key={w.code} value={w.code} />)}
              </datalist>
            </label>
            <label className="field grow"><span>Filter (JSON)</span><input value={form.filter} onChange={(e) => setForm({ ...form, filter: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Create subscription</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "event_type_code", label: "Event type" },
            { key: "subscriber_type", label: "Subscriber", render: (r) => r.subscriber_type },
            { key: "target_ref", label: "Target", render: (r) => <span className="mono">{r.target_ref || "—"}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={async () => { try { await integration.setSubscriptionStatus(r.code, r.status === "active" ? "paused" : "active"); await list.reload(); } catch (err) { setNotice(err.message); } }}>
                    {r.status === "active" ? "Pause" : "Activate"}
                  </button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteSubscription(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}

function Deliveries() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.deliveries(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);

  return (
    <>
      <Toolbar>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any</option>
            {["pending", "delivered", "failed", "retry", "dead_letter", "skipped"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "id", label: "#" },
            { key: "event_type_code", label: "Event type" },
            { key: "subscriber_type", label: "Subscriber" },
            { key: "target_ref", label: "Target", render: (r) => <span className="mono">{r.target_ref || "—"}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "attempts", label: "Attempts" },
            { key: "last_error", label: "Last error", render: (r) => <span className="muted">{r.last_error || "—"}</span> },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button className="link" type="button" onClick={async () => { setNotice(""); try { await integration.retryDelivery(r.id); setNotice(`Delivery ${r.id} retried.`); await list.reload(); } catch (err) { setNotice(err.message); } }}>Retry</button>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>
    </>
  );
}
