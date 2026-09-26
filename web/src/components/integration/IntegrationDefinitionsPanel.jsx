import React, { useState } from "react";
import { integration } from "../../api.js";
import { Drawer, JsonBlock, Notice, Pager, Section, StatusBadge, Table, Toolbar, ts, titleCase, useAsync } from "./common.jsx";

const EMPTY_DEF = { code: "", name: "", integration_type: "api", direction: "inbound", adapter_type: "rest", status: "draft", config: "{}" };
const EMPTY_SCHEDULE = { code: "", integration_id: "", schedule_type: "interval", interval_seconds: "3600", cron_expression: "", status: "active" };

export default function IntegrationDefinitionsPanel() {
  const [tab, setTab] = useState("definitions");
  return (
    <>
      <div className="tabs">
        {[["definitions", "Definitions"], ["executions", "Executions"], ["schedules", "Schedules"]].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "definitions" ? <Definitions /> : null}
      {tab === "executions" ? <Executions /> : null}
      {tab === "schedules" ? <Schedules /> : null}
    </>
  );
}

function Definitions() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(EMPTY_DEF);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [versions, setVersions] = useState(null);

  const list = useAsync(() => integration.definitions(`?page=${page}&pageSize=20${q ? `&q=${encodeURIComponent(q)}` : ""}`), [page, q]);
  const meta = useAsync(() => integration.meta(), []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      let config = {};
      if (form.config.trim()) config = JSON.parse(form.config);
      await integration.createDefinition({ ...form, config });
      setNotice(`Integration ${form.code} created.`);
      setForm(EMPTY_DEF);
      setShowForm(false);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function run(code) {
    setNotice("");
    try {
      const result = await integration.runDefinition(code, { payload: {} });
      const status = result.execution?.status || "submitted";
      setNotice(`Execution ${result.execution?.execution_ref || ""} ${status}.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function toggleStatus(row) {
    setNotice("");
    try {
      const next = row.status === "active" ? "inactive" : "active";
      await integration.setDefinitionStatus(row.code, next);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function remove(code) {
    setNotice("");
    try {
      await integration.deleteDefinition(code);
      await list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function openVersions(row) {
    setSelected(row);
    setVersions(null);
    try {
      setVersions(await integration.definitionVersions(row.code));
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search integrations…" />
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New integration"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </label>
            <label className="field grow"><span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field"><span>Type</span>
              <select value={form.integration_type} onChange={(e) => setForm({ ...form, integration_type: e.target.value })}>
                {(meta.data?.integration_types || ["api", "file", "message"]).map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
              </select>
            </label>
            <label className="field"><span>Direction</span>
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                {(meta.data?.directions || ["inbound", "outbound", "bidirectional"]).map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
              </select>
            </label>
            <label className="field"><span>Adapter</span>
              <select value={form.adapter_type} onChange={(e) => setForm({ ...form, adapter_type: e.target.value })}>
                {(meta.data?.adapter_types || ["rest", "internal", "file", "message"]).map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
              </select>
            </label>
            <label className="field"><span>Status</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {(meta.data?.definition_statuses || ["draft", "active", "inactive"]).map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Configuration (JSON — e.g. {`{"handler_code":"my.handler","url":"https://…"}`})</span>
            <textarea rows={4} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} />
          </label>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Creating…" : "Create integration"}</button>
        </form>
      ) : null}

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={openVersions}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "name", label: "Name" },
            { key: "integration_type", label: "Type", render: (r) => titleCase(r.integration_type) },
            { key: "direction", label: "Direction", render: (r) => titleCase(r.direction) },
            { key: "adapter_type", label: "Adapter", render: (r) => r.adapter_type },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "last_run_at", label: "Last run", render: (r) => ts(r.last_run_at) },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={() => run(r.code)}>Run</button>
                  <button className="link" type="button" onClick={() => toggleStatus(r)}>{r.status === "active" ? "Deactivate" : "Activate"}</button>
                  <button className="link muted" type="button" onClick={() => remove(r.code)}>Delete</button>
                </div>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={20} total={list.data?.total || 0} onPage={setPage} />
      </Section>

      {selected ? (
        <Drawer title={selected.name || selected.code} subtitle="Integration version history" onClose={() => { setSelected(null); setVersions(null); }}>
          <JsonBlock value={selected.config || selected.config_json || {}} maxHeight={160} />
          <h3>Versions</h3>
          {versions ? (
            <Table
              columns={[
                { key: "version", label: "Version" },
                { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
                { key: "change_reason", label: "Reason" },
              ]}
              rows={versions.items || versions || []}
              empty="No versions"
            />
          ) : <div className="muted">Loading…</div>}
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={() => run(selected.code)}>Run now</button>
            <button className="btn secondary" type="button" onClick={async () => {
              try { const v = (versions?.items || versions || [])[0]; if (v) { await integration.restoreDefinitionVersion(selected.code, v.version); setNotice("Version restored."); await list.reload(); } } catch (err) { setNotice(err.message); }
            }}>Restore latest</button>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

function Executions() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const list = useAsync(() => integration.executions(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);
  const detail = useAsync(() => (selected ? integration.execution(selected.execution_ref || selected.id) : Promise.resolve(null)), [selected]);

  return (
    <>
      <Toolbar>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any</option>
            {["running", "succeeded", "failed", "partial", "cancelled", "timed_out"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </Toolbar>
      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          onRow={setSelected}
          columns={[
            { key: "execution_ref", label: "Execution", render: (r) => <span className="mono">{r.execution_ref || r.ref}</span> },
            { key: "integration_code", label: "Integration" },
            { key: "trigger_type", label: "Trigger", render: (r) => titleCase(r.trigger_type) },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
            { key: "duration_ms", label: "Duration", render: (r) => (r.duration_ms != null ? `${r.duration_ms} ms` : "—") },
            { key: "started_at", label: "Started", render: (r) => ts(r.started_at || r.created_at) },
            {
              key: "actions",
              label: "",
              render: (r) => (
                <div className="inline" onClick={(e) => e.stopPropagation()}>
                  <button className="link" type="button" onClick={async () => { try { await integration.retryExecution(r.execution_ref || r.ref); await list.reload(); } catch (err) { /* noop */ } }}>Retry</button>
                  {r.status === "running" ? (
                    <button className="link muted" type="button" onClick={async () => { try { await integration.cancelExecution(r.execution_ref || r.ref); await list.reload(); } catch (err) { /* noop */ } }}>Cancel</button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={setPage} />
      </Section>

      {selected ? (
        <Drawer title={selected.execution_ref || selected.ref} subtitle="Execution detail" onClose={() => setSelected(null)}>
          <div className="audit-meta">
            <div><span>Status</span><b><StatusBadge value={selected.status} /></b></div>
            <div><span>Integration</span><b>{selected.integration_code || "—"}</b></div>
            <div><span>Trigger</span><b>{titleCase(selected.trigger_type)}</b></div>
            <div><span>Duration</span><b>{selected.duration_ms != null ? `${selected.duration_ms} ms` : "—"}</b></div>
          </div>
          {selected.error_message ? <div className="error" style={{ marginTop: 12 }}>{selected.error_message}</div> : null}
          <h3>Steps</h3>
          <Table
            rows={detail.data?.steps || selected.steps || []}
            columns={[
              { key: "step_name", label: "Step", render: (r) => r.step_name || r.name || r.step_type },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
              { key: "duration_ms", label: "ms", render: (r) => r.duration_ms ?? "—" },
            ]}
            empty="No steps recorded"
          />
          {detail.data ? <><h3>Payload</h3><JsonBlock value={detail.data.request || detail.data.input || {}} /></> : null}
        </Drawer>
      ) : null}
    </>
  );
}

function Schedules() {
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(EMPTY_SCHEDULE);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => integration.schedules(`?page=${page}&pageSize=25`), [page]);
  const definitions = useAsync(() => integration.definitions("?pageSize=100"), []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      await integration.createSchedule({
        ...form,
        integration_id: form.integration_id ? Number(form.integration_id) : null,
        interval_seconds: Number(form.interval_seconds) || 0,
      });
      setNotice(`Schedule ${form.code} created.`);
      setForm(EMPTY_SCHEDULE);
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
        <button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "New schedule"}</button>
      </Toolbar>
      <Notice kind={notice && /fail|error|not|invalid/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      {showForm ? (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></label>
            <label className="field grow"><span>Integration</span>
              <select value={form.integration_id} onChange={(e) => setForm({ ...form, integration_id: e.target.value })}>
                <option value="">None</option>
                {(definitions.data?.items || []).map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
              </select>
            </label>
            <label className="field"><span>Type</span>
              <select value={form.schedule_type} onChange={(e) => setForm({ ...form, schedule_type: e.target.value })}>
                {["interval", "cron", "daily", "weekly", "monthly", "once"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Interval (s)</span><input value={form.interval_seconds} onChange={(e) => setForm({ ...form, interval_seconds: e.target.value })} /></label>
            <label className="field grow"><span>Cron</span><input value={form.cron_expression} onChange={(e) => setForm({ ...form, cron_expression: e.target.value })} placeholder="0 */6 * * *" /></label>
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Creating…" : "Create schedule"}</button>
        </form>
      ) : null}

      <Section>
        <Table
          loading={list.loading}
          rows={list.data?.items || []}
          columns={[
            { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
            { key: "schedule_type", label: "Type", render: (r) => r.schedule_type },
            { key: "interval_seconds", label: "Interval", render: (r) => (r.interval_seconds ? `${r.interval_seconds}s` : r.cron_expression || "—") },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="sched-" /> },
            { key: "next_run_at", label: "Next run", render: (r) => ts(r.next_run_at) },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="inline">
                  <button className="link" type="button" onClick={async () => { try { await integration.runSchedule(r.code); setNotice(`Schedule ${r.code} triggered.`); } catch (err) { setNotice(err.message); } }}>Run</button>
                  <button className="link" type="button" onClick={async () => { try { await integration.setScheduleStatus(r.code, r.status === "active" ? "paused" : "active"); await list.reload(); } catch (err) { setNotice(err.message); } }}>
                    {r.status === "active" ? "Pause" : "Activate"}
                  </button>
                  <button className="link muted" type="button" onClick={async () => { try { await integration.deleteSchedule(r.code); await list.reload(); } catch (err) { setNotice(err.message); } }}>Delete</button>
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
