import React, { useState } from "react";
import { integration } from "../../api.js";
import { JsonBlock, Notice, Pager, Section, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

export default function IntegrationDataPanel() {
  const [tab, setTab] = useState("transformations");
  return (
    <>
      <div className="tabs">
        {[["transformations", "Transformations"], ["mappings", "Object mappings"], ["transfers", "Import / Export"], ["endpoints", "API endpoints"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "transformations" ? <Transformations /> : null}
      {tab === "mappings" ? <Mappings /> : null}
      {tab === "transfers" ? <Transfers /> : null}
      {tab === "endpoints" ? <Endpoints /> : null}
    </>
  );
}

function Transformations() {
  const [form, setForm] = useState({ code: "", source_format: "json", target_format: "json", mappings: '[{"source":"id","target":"id"}]' });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [testInput, setTestInput] = useState("{}");
  const [testOutput, setTestOutput] = useState(null);
  const list = useAsync(() => integration.transformations("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      const mappings = form.mappings.trim() ? JSON.parse(form.mappings) : [];
      await integration.createTransformation({ ...form, mappings });
      setNotice(`Transformation ${form.code} created.`);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function test(code) {
    setNotice("");
    setTestOutput(null);
    try {
      let input = {};
      if (testInput.trim()) input = JSON.parse(testInput);
      const result = await integration.testTransformation(code, { input });
      setTestOutput(result);
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New transformation"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field"><span>Source format</span>
              <select value={form.source_format} onChange={(e) => setForm({ ...form, source_format: e.target.value })}>
                {["json", "xml", "csv", "text"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Target format</span>
              <select value={form.target_format} onChange={(e) => setForm({ ...form, target_format: e.target.value })}>
                {["json", "xml", "csv", "text"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Mappings (JSON array of {`{source,target,type}`})</span>
            <textarea rows={4} value={form.mappings} onChange={(e) => setForm({ ...form, mappings: e.target.value })} />
          </label>
          <button className="btn" type="submit">Create transformation</button>
        </form>
      ) : null}

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "source_format", label: "From" },
            { key: "target_format", label: "To" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={() => test(r.code)}>Test</button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteTransformation(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Transformation tester" className="intg-section">
        <div className="row">
          <label className="field grow"><span>Input (JSON)</span><input value={testInput} onChange={(e) => setTestInput(e.target.value)} /></label>
          <span className="muted">Pick “Test” on a transformation to run it.</span>
        </div>
        {testOutput ? <JsonBlock value={testOutput.output || testOutput} /> : null}
      </Section>
    </>
  );
}

function Mappings() {
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ external_system_id: "", external_object_type: "", external_object_id: "", internal_object_type: "", internal_object_id: "" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const stats = useAsync(() => integration.mappingStats(), []);
  const list = useAsync(() => integration.mappings(`?page=${page}&pageSize=25`), [page, stats.data]);
  const systems = useAsync(() => integration.systems("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      await integration.createMapping({ ...form, external_system_id: Number(form.external_system_id) || null });
      setNotice("Mapping saved.");
      setShowForm(false);
      await Promise.all([list.reload(), stats.reload()]);
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <span className="muted">Total {stats.data?.total ?? "—"} · Conflicts {stats.data?.conflicts ?? "—"}</span>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New mapping"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>External system</span>
              <select value={form.external_system_id} onChange={(e) => setForm({ ...form, external_system_id: e.target.value })} required>
                <option value="">Select…</option>
                {(systems.data?.items || []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
              </select>
            </label>
            <label className="field grow"><span>External type</span><input value={form.external_object_type} onChange={(e) => setForm({ ...form, external_object_type: e.target.value })} required /></label>
            <label className="field grow"><span>External id</span><input value={form.external_object_id} onChange={(e) => setForm({ ...form, external_object_id: e.target.value })} required /></label>
            <label className="field grow"><span>Internal type</span><input value={form.internal_object_type} onChange={(e) => setForm({ ...form, internal_object_type: e.target.value })} required /></label>
            <label className="field grow"><span>Internal id</span><input value={form.internal_object_id} onChange={(e) => setForm({ ...form, internal_object_id: e.target.value })} required /></label>
          </div>
          <button className="btn" type="submit">Save mapping</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "external_object_type", label: "External", render: (r) => <span className="mono">{r.external_object_type}:{r.external_object_id}</span> },
            { key: "internal_object_type", label: "Internal", render: (r) => <span className="mono">{r.internal_object_type}:{r.internal_object_id}</span> },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "source_of_truth", label: "Source of truth" },
            { key: "last_synced_at", label: "Last synced", render: (r) => ts(r.last_synced_at) },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button className="link muted" type="button" onClick={async () => { try { await integration.deleteMapping(r.id); await Promise.all([list.reload(), stats.reload()]); } catch (err) { setNotice(err.message); } }}>Delete</button>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>
    </>
  );
}

function Transfers() {
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [importForm, setImportForm] = useState({ resource_type: "", format: "csv", content: "" });
  const [exportForm, setExportForm] = useState({ resource_type: "", format: "csv" });
  const list = useAsync(() => integration.transfers(`?page=${page}&pageSize=25`), [page]);
  const handlers = useAsync(() => integration.transferHandlers(), []);

  const handlerOptions = [
    ...(handlers.data?.importers || []),
    ...(handlers.data?.exporters || []),
  ].map((h) => h.resource_type || h.code || h);
  const uniqueHandlers = [...new Set(handlerOptions.filter(Boolean))];

  async function runImport(e) {
    e.preventDefault();
    setNotice("");
    try {
      const result = await integration.importTransfer(importForm);
      setNotice(`Import ${result.transfer_ref || ""} ${result.status || "submitted"}.`);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function runExport(e) {
    e.preventDefault();
    setNotice("");
    try {
      const result = await integration.exportTransfer(exportForm);
      setNotice(`Export ${result.transfer_ref || ""} ${result.status || "submitted"}.`);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function download(ref) {
    setNotice("");
    try {
      const result = await integration.downloadTransfer(ref);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <div className="split">
        <form className="panel" onSubmit={runImport}>
          <h3>Import</h3>
          <div className="row">
            <label className="field grow"><span>Resource type</span>
              <input value={importForm.resource_type} onChange={(e) => setImportForm({ ...importForm, resource_type: e.target.value })} list="intg-handlers" required />
              <datalist id="intg-handlers">{uniqueHandlers.map((h) => <option key={h} value={h} />)}</datalist>
            </label>
            <label className="field"><span>Format</span>
              <select value={importForm.format} onChange={(e) => setImportForm({ ...importForm, format: e.target.value })}>
                {["csv", "json", "xml"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Content</span>
            <textarea rows={5} value={importForm.content} onChange={(e) => setImportForm({ ...importForm, content: e.target.value })} placeholder="code,name&#10;A,Alpha" />
          </label>
          <button className="btn" type="submit">Run import</button>
        </form>

        <form className="panel" onSubmit={runExport}>
          <h3>Export</h3>
          <div className="row">
            <label className="field grow"><span>Resource type</span>
              <input value={exportForm.resource_type} onChange={(e) => setExportForm({ ...exportForm, resource_type: e.target.value })} list="intg-handlers" required />
            </label>
            <label className="field"><span>Format</span>
              <select value={exportForm.format} onChange={(e) => setExportForm({ ...exportForm, format: e.target.value })}>
                {["csv", "json", "xml"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <button className="btn" type="submit">Run export</button>
          <p className="muted">Available handlers: {uniqueHandlers.length ? uniqueHandlers.join(", ") : "none registered"}</p>
        </form>
      </div>

      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      <Section title="Transfer history">
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "transfer_ref", label: "Transfer", render: (r) => <span className="mono">{r.transfer_ref}</span> },
            { key: "direction", label: "Direction", render: (r) => titleCase(r.direction) },
            { key: "resource_type", label: "Resource" },
            { key: "format", label: "Format" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "total_rows", label: "Rows", render: (r) => r.total_rows ?? "—" },
            { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <div className="inline">
                  {["completed", "exported"].includes(r.status) ? (
                    <button className="link" type="button" onClick={() => download(r.transfer_ref)}>Download</button>
                  ) : null}
                  {["pending", "running", "queued"].includes(r.status) ? (
                    <button className="link muted" type="button" onClick={async () => { try { await integration.cancelTransfer(r.transfer_ref); await list.reload(); } catch (err) { setNotice(err.message); } }}>Cancel</button>
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

function Endpoints() {
  const [form, setForm] = useState({ code: "", direction: "inbound", method: "POST", path: "", api_version: "v1", request_format: "json", response_format: "json" });
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useAsync(() => integration.endpoints("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    try {
      await integration.createEndpoint(form);
      setNotice(`Endpoint ${form.code} created.`);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New API endpoint"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field"><span>Direction</span>
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                {["inbound", "outbound", "bidirectional"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Method</span>
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Path</span><input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/v1/orders" /></label>
            <label className="field"><span>Version</span><input value={form.api_version} onChange={(e) => setForm({ ...form, api_version: e.target.value })} /></label>
          </div>
          <button className="btn" type="submit">Create endpoint</button>
        </form>
      ) : null}
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "method", label: "Method" },
            { key: "path", label: "Path", render: (r) => <span className="mono">{r.path}</span> },
            { key: "api_version", label: "Version" },
            { key: "direction", label: "Direction", render: (r) => titleCase(r.direction) },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <button className="link muted" type="button" onClick={async () => { try { await integration.deleteEndpoint(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
