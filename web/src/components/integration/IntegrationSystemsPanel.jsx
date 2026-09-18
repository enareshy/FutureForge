import React, { useState } from "react";
import { integration } from "../../api.js";
import { Drawer, JsonBlock, Notice, Section, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

const EMPTY_SYSTEM = { code: "", name: "", system_type: "erp", environment: "production", base_url: "", description: "" };
const EMPTY_CRED = { code: "", name: "", kind: "api_key", secret: "", description: "" };

export default function IntegrationSystemsPanel() {
  const [tab, setTab] = useState("systems");
  return (
    <>
      <div className="tabs">
        {[["systems", "External systems"], ["credentials", "Credentials"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "systems" ? <Systems /> : null}
      {tab === "credentials" ? <Credentials /> : null}
    </>
  );
}

function Systems() {
  const [form, setForm] = useState(EMPTY_SYSTEM);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const list = useAsync(() => integration.systems("?pageSize=100"), []);
  const health = useAsync(() => (selected ? integration.systemHealth(selected.code) : Promise.resolve(null)), [selected]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      await integration.createSystem(form);
      setNotice(`External system ${form.code} created.`);
      setForm(EMPTY_SYSTEM);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function test(row) {
    setNotice("");
    try {
      const result = await integration.testSystem(row.code);
      setNotice(`Connection test for ${row.code}: ${result.status || result.connection_status || "completed"}.`);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New external system"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Type</span>
              <select value={form.system_type} onChange={(e) => setForm({ ...form, system_type: e.target.value })}>
                {["erp", "crm", "mes", "scada", "plm", "cad", "wms", "hr", "finance", "custom"].map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="field"><span>Environment</span>
              <select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
                {["production", "staging", "test", "development"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Base URL</span><input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://erp.example.com" /></label>
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Creating…" : "Create system"}</button>
        </form>
      ) : null}

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={setSelected}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "name", label: "Name" },
            { key: "system_type", label: "Type", render: (r) => titleCase(r.system_type) },
            { key: "environment", label: "Env", render: (r) => r.environment },
            { key: "connection_status", label: "Connection", render: (r) => <StatusBadge value={r.connection_status} prefix="eng-" /> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={() => test(r)}>Test</button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteSystem(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      {selected ? (
        <Drawer title={selected.name || selected.code} subtitle="External system" onClose={() => setSelected(null)}>
          <div className="audit-meta">
            <div><span>Type</span><b>{titleCase(selected.system_type)}</b></div>
            <div><span>Environment</span><b>{selected.environment}</b></div>
            <div><span>Connection</span><b><StatusBadge value={selected.connection_status} prefix="eng-" /></b></div>
            <div><span>Last checked</span><b>{ts(selected.last_health_at)}</b></div>
          </div>
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={() => test(selected)}>Test connection</button>
          </div>
          <h3>Recent health checks</h3>
          <Table
            rows={health.data?.items || []}
            columns={[
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "latency_ms", label: "Latency", render: (r) => (r.latency_ms != null ? `${r.latency_ms} ms` : "—") },
              { key: "checked_at", label: "Checked", render: (r) => ts(r.checked_at) },
              { key: "message", label: "Message" },
            ]}
            empty="No health checks yet"
          />
        </Drawer>
      ) : null}
    </>
  );
}

function Credentials() {
  const [form, setForm] = useState(EMPTY_CRED);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => integration.credentials("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      await integration.createCredential(form);
      setNotice(`Credential ${form.code} stored (encrypted).`);
      setForm(EMPTY_CRED);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New credential"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field"><span>Kind</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {["api_key", "token", "password", "basic", "oauth2", "jwt", "signature", "certificate", "none"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Secret</span><input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="Never displayed after saving" /></label>
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Store credential"}</button>
        </form>
      ) : null}

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "name", label: "Name" },
            { key: "kind", label: "Kind" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "has_secret", label: "Secret", render: (r) => (r.has_secret ? "stored" : "—") },
            { key: "rotated_at", label: "Rotated", render: (r) => ts(r.rotated_at) },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button className="link muted" type="button" onClick={async () => { try { await integration.deleteCredential(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
