import React, { useState } from "react";
import { integration } from "../../api.js";
import { Drawer, JsonBlock, Notice, Section, StatusBadge, Table, Toolbar, ts, useAsync } from "./common.jsx";

export default function IntegrationWebhooksPanel() {
  const [tab, setTab] = useState("inbound");
  return (
    <>
      <div className="tabs">
        {[["inbound", "Inbound"], ["outbound", "Outbound"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "inbound" ? <Inbound /> : null}
      {tab === "outbound" ? <Outbound /> : null}
    </>
  );
}

function Inbound() {
  const [form, setForm] = useState({ code: "", name: "", auth_type: "signature", credential_id: "", event_type_code: "" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null);
  const list = useAsync(() => integration.inboundWebhooks("?pageSize=100"), []);
  const creds = useAsync(() => integration.credentials("?pageSize=100"), []);
  const types = useAsync(() => integration.eventTypes("?pageSize=100"), []);
  const receipts = useAsync(() => (selected ? integration.inboundReceipts(selected.code, "?pageSize=25") : Promise.resolve(null)), [selected]);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      await integration.createInboundWebhook({ ...form, credential_id: form.credential_id ? Number(form.credential_id) : null });
      setNotice(`Inbound webhook ${form.code} created.`);
      setForm({ code: "", name: "", auth_type: "signature", credential_id: "", event_type_code: "" });
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New inbound webhook"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Auth</span>
              <select value={form.auth_type} onChange={(e) => setForm({ ...form, auth_type: e.target.value })}>
                {["signature", "api_key", "basic", "none"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Credential</span>
              <select value={form.credential_id} onChange={(e) => setForm({ ...form, credential_id: e.target.value })}>
                <option value="">None</option>
                {(creds.data?.items || []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Publishes event</span>
              <select value={form.event_type_code} onChange={(e) => setForm({ ...form, event_type_code: e.target.value })}>
                <option value="">None</option>
                {(types.data?.items || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
              </select>
            </label>
          </div>
          <button className="btn" type="submit">Create inbound webhook</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={setSelected}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "auth_type", label: "Auth", render: (r) => r.auth_type },
            { key: "event_type_code", label: "Event type", render: (r) => r.event_type_code || "—" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "failure_count", label: "Failures", render: (r) => r.failure_count ?? 0 },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={async () => { try { await integration.setInboundWebhookStatus(r.code, r.status === "active" ? "inactive" : "active"); await list.reload(); } catch (err) { setNotice(err.message); } }}>
                    {r.status === "active" ? "Disable" : "Activate"}
                  </button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteInboundWebhook(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      {selected ? (
        <Drawer title={selected.name || selected.code} subtitle="Inbound webhook" onClose={() => setSelected(null)}>
          <div className="audit-meta">
            <div><span>Receiver URL</span><b className="mono">/api/v1/integration/webhooks/receive/{selected.code}</b></div>
            <div><span>Auth</span><b>{selected.auth_type}</b></div>
            <div><span>Publishes</span><b>{selected.event_type_code || "—"}</b></div>
            <div><span>Failures</span><b>{selected.failure_count ?? 0}</b></div>
          </div>
          <h3>Recent receipts</h3>
          <Table
            rows={receipts.data?.items || []}
            columns={[
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
              { key: "reason", label: "Reason" },
              { key: "received_at", label: "Received", render: (r) => ts(r.received_at) },
            ]}
            empty="No receipts yet"
          />
        </Drawer>
      ) : null}
    </>
  );
}

function Outbound() {
  const [form, setForm] = useState({ code: "", name: "", url: "", credential_id: "", timeout_seconds: "30", header: "{}" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null);
  const list = useAsync(() => integration.outboundWebhooks("?pageSize=100"), []);
  const creds = useAsync(() => integration.credentials("?pageSize=100"), []);
  const deliveries = useAsync(() => (selected ? integration.outboundDeliveries(selected.code, "?pageSize=25") : Promise.resolve(null)), [selected]);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      let header = {};
      if (form.header.trim()) header = JSON.parse(form.header);
      await integration.createOutboundWebhook({ ...form, header, credential_id: form.credential_id ? Number(form.credential_id) : null, timeout_seconds: Number(form.timeout_seconds) || 30 });
      setNotice(`Outbound webhook ${form.code} created.`);
      setForm({ code: "", name: "", url: "", credential_id: "", timeout_seconds: "30", header: "{}" });
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New outbound webhook"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field grow"><span>URL</span><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://partner.example.com/webhook" required /></label>
            <label className="field"><span>Credential</span>
              <select value={form.credential_id} onChange={(e) => setForm({ ...form, credential_id: e.target.value })}>
                <option value="">None</option>
                {(creds.data?.items || []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
            </label>
            <label className="field"><span>Timeout (s)</span><input value={form.timeout_seconds} onChange={(e) => setForm({ ...form, timeout_seconds: e.target.value })} /></label>
            <label className="field grow"><span>Headers (JSON)</span><input value={form.header} onChange={(e) => setForm({ ...form, header: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Create outbound webhook</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={setSelected}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "url", label: "URL", render: (r) => <span className="mono intg-ellipsis">{r.url}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "failure_count", label: "Failures", render: (r) => r.failure_count ?? 0 },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={async () => { setNotice(""); try { const res = await integration.testOutboundWebhook(r.code); setNotice(`Webhook test: ${res.ok ? "ok" : "failed"} (HTTP ${res.status || 0}).`); } catch (err) { setNotice(err.message); } }}>Test</button>
                  <button className="link" type="button" onClick={async () => { try { await integration.setOutboundWebhookStatus(r.code, r.status === "active" ? "inactive" : "active"); await list.reload(); } catch (err) { setNotice(err.message); } }}>
                    {r.status === "active" ? "Disable" : "Activate"}
                  </button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteOutboundWebhook(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      {selected ? (
        <Drawer title={selected.name || selected.code} subtitle="Outbound webhook" onClose={() => setSelected(null)}>
          <JsonBlock value={selected.header || selected.header_json || {}} maxHeight={120} />
          <h3>Recent deliveries</h3>
          <Table
            rows={deliveries.data?.items || []}
            columns={[
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
              { key: "response_code", label: "HTTP", render: (r) => r.response_code ?? "—" },
              { key: "attempts", label: "Attempts" },
              { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
            ]}
            empty="No deliveries yet"
          />
        </Drawer>
      ) : null}
    </>
  );
}
