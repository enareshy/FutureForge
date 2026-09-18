import React, { useState } from "react";
import { integration } from "../../api.js";
import { Drawer, JsonBlock, Notice, Pager, Section, StatGrid, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

export default function IntegrationMessagesPanel() {
  const [tab, setTab] = useState("messages");
  return (
    <>
      <div className="tabs">
        {[["messages", "Messages"], ["queues", "Queues"], ["dead-letters", "Dead letters"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "messages" ? <Messages /> : null}
      {tab === "queues" ? <Queues /> : null}
      {tab === "dead-letters" ? <DeadLetters /> : null}
    </>
  );
}

function Messages() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ message_type: "integration.message", queue: "default", priority: "normal", payload: "{}" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.messages(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      let payload = {};
      if (form.payload.trim()) payload = JSON.parse(form.payload);
      await integration.createMessage({ ...form, payload });
      setNotice("Message enqueued.");
      setForm({ message_type: "integration.message", queue: "default", priority: "normal", payload: "{}" });
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any</option>
            {["pending", "processing", "retry", "delivered", "failed", "dead_letter", "cancelled", "duplicate"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "Enqueue message"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Message type</span><input value={form.message_type} onChange={(e) => setForm({ ...form, message_type: e.target.value })} /></label>
            <label className="field"><span>Queue</span>
              <select value={form.queue} onChange={(e) => setForm({ ...form, queue: e.target.value })}>
                {["default", "integration", "integration.outbound", "integration.inbound"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Priority</span>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {["low", "normal", "high", "critical"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Payload (JSON)</span><input value={form.payload} onChange={(e) => setForm({ ...form, payload: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Enqueue</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "message_ref", label: "Message", render: (r) => <span className="mono">{r.message_ref}</span> },
            { key: "message_type", label: "Type" },
            { key: "queue", label: "Queue" },
            { key: "priority", label: "Priority", render: (r) => titleCase(r.priority) },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "attempts", label: "Attempts", render: (r) => `${r.attempts ?? 0}/${r.max_attempts ?? "—"}` },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={async () => { setNotice(""); try { await integration.retryMessage(r.message_ref); setNotice(`Message ${r.message_ref} requeued.`); await list.reload(); } catch (err) { setNotice(err.message); } }}>Retry</button>
                  {["pending", "retry", "processing"].includes(r.status) ? (
                    <button className="link muted" type="button" onClick={async () => { try { await integration.cancelMessage(r.message_ref); await list.reload(); } catch (err) { setNotice(err.message); } }}>Cancel</button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>
    </>
  );
}

function Queues() {
  const queues = useAsync(() => integration.queues(), []);
  return (
    <Section title="Queue depth">
      <Table
        loading={queues.loading}
        rows={queues.data?.items || []}
        columns={[
          { key: "queue", label: "Queue", render: (r) => <span className="mono">{r.queue}</span> },
          { key: "total", label: "Total" },
          { key: "pending", label: "Pending" },
          { key: "processing", label: "Processing" },
          { key: "retry", label: "Retry" },
          { key: "dead_letter", label: "Dead letter" },
          { key: "delivered", label: "Delivered" },
        ]}
        empty="No queued messages"
      />
    </Section>
  );
}

function DeadLetters() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("open");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const stats = useAsync(() => integration.deadLetterStats(), []);
  const list = useAsync(() => integration.deadLetters(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);

  async function inspect(row) {
    setSelected(row);
    setDetail(null);
    try {
      setDetail(await integration.inspectDeadLetter(row.id));
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <StatGrid
        items={[
          { label: "Total", value: stats.data?.total },
          { label: "Open", value: stats.data?.open },
        ]}
      />
      <div style={{ height: 14 }} />
      <Toolbar>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any</option>
            {["open", "retrying", "resolved", "closed", "discarded"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={inspect}
          columns={[
            { key: "id", label: "#" },
            { key: "message_type", label: "Message type" },
            { key: "error_category", label: "Category", render: (r) => titleCase(r.error_category) },
            { key: "error_code", label: "Code", render: (r) => <span className="mono">{r.error_code}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "attempts", label: "Attempts" },
            { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={async () => { setNotice(""); try { await integration.retryDeadLetter(r.id); setNotice(`Dead letter ${r.id} requeued.`); await Promise.all([list.reload(), stats.reload()]); } catch (err) { setNotice(err.message); } }}>Retry</button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.resolveDeadLetter(r.id, { status: "closed", resolution: "Resolved from console" }); await Promise.all([list.reload(), stats.reload()]); } catch (err) { setNotice(err.message); } }}>Resolve</button>
                </div>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>

      {selected ? (
        <Drawer title={`Dead letter #${selected.id}`} subtitle={titleCase(selected.error_category)} onClose={() => { setSelected(null); setDetail(null); }}>
          <div className="audit-meta">
            <div><span>Error code</span><b className="mono">{selected.error_code}</b></div>
            <div><span>Status</span><b><StatusBadge value={selected.status} /></b></div>
            <div><span>Attempts</span><b>{selected.attempts}</b></div>
            <div><span>Created</span><b>{ts(selected.created_at)}</b></div>
          </div>
          {selected.error_message ? <div className="error" style={{ marginTop: 12 }}>{selected.error_message}</div> : null}
          <h3>Payload</h3>
          <JsonBlock value={detail?.payload || detail?.message?.payload || selected.payload || {}} />
        </Drawer>
      ) : null}
    </>
  );
}
