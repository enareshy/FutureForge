import React, { useState } from "react";
import { integration } from "../../api.js";
import { Notice, Pager, Section, StatGrid, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

export default function IntegrationApiPanel() {
  const [tab, setTab] = useState("catalog");
  return (
    <>
      <div className="tabs">
        {[["catalog", "API catalog"], ["clients", "API clients"], ["usage", "Usage"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "catalog" ? <Catalog /> : null}
      {tab === "clients" ? <Clients /> : null}
      {tab === "usage" ? <Usage /> : null}
    </>
  );
}

function Catalog() {
  const [form, setForm] = useState({ code: "", name: "", api_group: "integration", version: "v1", description: "" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.apiCatalog("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      await integration.createApiCatalogEntry(form);
      setNotice(`API ${form.code} added to the catalog.`);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New API"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Group</span><input value={form.api_group} onChange={(e) => setForm({ ...form, api_group: e.target.value })} /></label>
            <label className="field"><span>Version</span><input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
          </div>
          <label className="field"><span>Description</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <button className="btn" type="submit">Add to catalog</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "name", label: "Name" },
            { key: "api_group", label: "Group" },
            { key: "version", label: "Version" },
            { key: "auth_required", label: "Auth", render: (r) => (r.auth_required ? "required" : "public") },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={async () => { try { await integration.setApiCatalogStatus(r.code, r.status === "active" ? "deprecated" : "active"); await list.reload(); } catch (err) { setNotice(err.message); } }}>
                    {r.status === "active" ? "Deprecate" : "Activate"}
                  </button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteApiCatalogEntry(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}

function Clients() {
  const [form, setForm] = useState({ code: "", name: "", client_type: "service_account", scopes: "read" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [apiKey, setApiKey] = useState("");
  const list = useAsync(() => integration.apiClients("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    setApiKey("");
    try {
      const scopes = form.scopes.split(",").map((s) => s.trim()).filter(Boolean);
      const result = await integration.createApiClient({ ...form, scopes });
      setApiKey(result.api_key || "");
      setNotice(`API client ${form.code} created. Store the key now — it is shown only once.`);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New API client"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {apiKey ? (
        <div className="panel">
          <h3>API key</h3>
          <p className="muted">Copy this key now. It cannot be retrieved again.</p>
          <code className="intg-key">{apiKey}</code>
        </div>
      ) : null}
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Type</span>
              <select value={form.client_type} onChange={(e) => setForm({ ...form, client_type: e.target.value })}>
                {["service_account", "partner", "internal", "external"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Scopes (comma separated)</span><input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Issue client</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "client_type", label: "Type", render: (r) => titleCase(r.client_type) },
            { key: "api_key_prefix", label: "Key prefix", render: (r) => <span className="mono">{r.api_key_prefix}…</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "last_used_at", label: "Last used", render: (r) => ts(r.last_used_at) },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={async () => { setNotice(""); setApiKey(""); try { const res = await integration.rotateApiClient(r.code); setApiKey(res.api_key || ""); setNotice(`Key rotated for ${r.code}.`); await list.reload(); } catch (err) { setNotice(err.message); } }}>Rotate</button>
                  {r.status !== "revoked" ? (
                    <button className="link muted" type="button" onClick={async () => { try { await integration.revokeApiClient(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Revoke</button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}

function Usage() {
  const [page, setPage] = useState(1);
  const [hours, setHours] = useState("24");
  const stats = useAsync(() => integration.monitoringApiUsage(`?hours=${hours}`), [hours]);
  const usage = useAsync(() => integration.apiUsage(`?page=${page}&pageSize=25`), [page]);

  return (
    <>
      <Toolbar>
        <label className="field"><span>Window</span>
          <select value={hours} onChange={(e) => setHours(e.target.value)}>
            {["1", "24", "168", "720"].map((v) => <option key={v} value={v}>{v} hours</option>)}
          </select>
        </label>
      </Toolbar>
      <StatGrid
        items={[
          { label: "Requests", value: stats.data?.requests },
          { label: "Errors", value: stats.data?.errors },
          { label: "Avg duration", value: stats.data?.avg_duration_ms != null ? `${stats.data.avg_duration_ms} ms` : "—" },
        ]}
      />
      <div style={{ height: 14 }} />
      <Section title="Recent requests">
        <Table
          loading={usage.loading}
          rows={usage.data?.items || []}
          columns={[
            { key: "endpoint_code", label: "Endpoint", render: (r) => <span className="mono">{r.endpoint_code || "—"}</span> },
            { key: "api_version", label: "Version" },
            { key: "method", label: "Method" },
            { key: "path", label: "Path", render: (r) => <span className="mono intg-ellipsis">{r.path}</span> },
            { key: "status_code", label: "HTTP" },
            { key: "duration_ms", label: "Duration", render: (r) => `${r.duration_ms} ms` },
            { key: "created_at", label: "When", render: (r) => ts(r.created_at) },
          ]}
          empty="No API requests recorded"
        />
        <Pager page={page} pageSize={25} total={usage.data?.total || 0} onPage={setPage} />
      </Section>
    </>
  );
}
