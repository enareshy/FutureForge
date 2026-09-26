import React, { useState } from "react";
import { events } from "../../api.js";
import {
  Drawer,
  JsonBlock,
  Notice,
  Pager,
  Section,
  StatGrid,
  StatusBadge,
  Table,
  Toolbar,
  ts,
  titleCase,
  useAsync,
} from "../integration/common.jsx";

function asText(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

export function EventsOverviewPanel() {
  const dashboard = useAsync(() => events.monitoringDashboard(), []);
  const health = useAsync(() => events.monitoringHealth(), []);
  const d = dashboard.data;
  const h = health.data;

  return (
    <>
      <Toolbar>
        <button className="btn secondary" type="button" onClick={() => { dashboard.reload(); health.reload(); }}>Refresh</button>
        <span className="muted mono">Generated {ts(d?.generated_at)}</span>
      </Toolbar>
      {dashboard.error ? <div className="error">{dashboard.error}</div> : null}
      <StatGrid
        items={[
          { label: "Events published", value: d?.events?.published, hint: `${d?.events?.success_rate ?? "—"}% success` },
          { label: "Delivered", value: d?.events?.delivered, hint: `${d?.events?.failed || 0} failed` },
          { label: "Queue depth", value: d?.queue?.depth, hint: `${d?.queue?.due || 0} due` },
          { label: "Dead letters", value: d?.dead_letters?.open, hint: `${d?.dead_letters?.total || 0} in window` },
        ]}
      />
      <div style={{ height: 14 }} />
      <StatGrid
        items={[
          { label: "Outbox pending", value: d?.outbox?.pending, hint: `${d?.outbox?.dead_letter || 0} dead` },
          { label: "Out of order", value: d?.ordering?.buffered, hint: `${d?.ordering?.partitions || 0} partitions` },
          { label: "Replays", value: d?.replays?.total, hint: `${d?.replays?.replayed || 0} replayed` },
          { label: "Handlers seen", value: d?.consumers?.handlers_seen, hint: `${d?.consumers?.handlers_missing?.length || 0} missing` },
        ]}
      />

      <div className="split" style={{ marginTop: 16 }}>
        <Section title="Broker health">
          <Table
            columns={[
              { key: "name", label: "Check" },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            ]}
            rows={h?.checks || []}
            empty="No health data"
          />
          <div className="chips" style={{ marginTop: 12 }}>
            <span className="chip">Provider: {h?.provider || "—"}</span>
            <span className="chip">Queues: {h?.topology?.queues ?? "—"}</span>
            <span className="chip">Unhealthy: {h?.topology?.unhealthy ?? "—"}</span>
          </div>
        </Section>

        <Section title="Failures by category">
          <Table
            columns={[
              { key: "error_category", label: "Category", render: (r) => titleCase(r.error_category) },
              { key: "count", label: "Count" },
            ]}
            rows={d?.failures?.length ? d.failures.map((row) => row) : []}
            empty="No failures recorded"
          />
          <h3 style={{ marginTop: 16 }}>Top event types</h3>
          <Table
            columns={[
              { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
              { key: "count", label: "Count" },
            ]}
            rows={d?.event_types || []}
            empty="No activity"
          />
        </Section>
      </div>
    </>
  );
}

const EMPTY_TYPE = { code: "", category: "product", source_module: "", schema: '{\n  "type": "object",\n  "properties": {}\n}' };

export function EventRegistryPanel() {
  const [page, setPageState] = useState(1);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(EMPTY_TYPE);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [version, setVersion] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const list = useAsync(() => events.eventTypes(`?page=${page}&pageSize=25${q ? `&q=${encodeURIComponent(q)}` : ""}`), [page, q]);
  const detail = useAsync(() => (selected ? events.eventType(selected.code) : Promise.resolve(null)), [selected?.code]);

  async function create() {
    setBusy(true);
    setNotice("");
    try {
      let schema = {};
      try { schema = JSON.parse(form.schema || "{}"); } catch { throw new Error("Schema must be valid JSON"); }
      await events.createEventType({ ...form, schema });
      setNotice(`Event type ${form.code} created.`);
      setForm(EMPTY_TYPE);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addVersion() {
    setBusy(true);
    setNotice("");
    try {
      let schema = {};
      try { schema = JSON.parse(version || "{}"); } catch { throw new Error("Schema must be valid JSON"); }
      const result = await events.addEventTypeVersion(selected.code, { schema });
      setNotice(`Added v${result.version.version} (${result.comparison.compatible ? "compatible" : "breaking"}).`);
      detail.reload();
      list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(code, status) {
    try {
      await events.updateEventType(code, { status });
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <input className="input" placeholder="Search event types" value={q} onChange={(e) => { setQ(e.target.value); setPageState(1); }} />
        <span className="muted">{list.data?.total ?? 0} event types</span>
      </Toolbar>
      <Notice kind={/error|invalid|must|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      <div className="split">
        <Section title="Registry">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "category", label: "Category", render: (r) => titleCase(r.category) },
              { key: "version", label: "v" },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "actions", label: "", render: (r) => (
                <span className="inline">
                  <button className="btn ghost" type="button" onClick={() => setSelected(r)}>View</button>
                  {r.system ? null : (
                    <button className="btn ghost" type="button" onClick={() => setStatus(r.code, r.status === "active" ? "inactive" : "active")}>
                      {r.status === "active" ? "Disable" : "Enable"}
                    </button>
                  )}
                </span>
              ) },
            ]}
            rows={list.data?.items || []}
            empty="No event types"
            loading={list.loading}
          />
          <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
        </Section>

        <Section title="Register event type">
          <label className="field"><span>Code</span><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="ProductCreated" /></label>
          <label className="field"><span>Category</span><input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
          <label className="field"><span>Source module</span><input className="input" value={form.source_module} onChange={(e) => setForm({ ...form, source_module: e.target.value })} /></label>
          <label className="field"><span>Schema (JSON)</span><textarea className="input mono" rows={6} value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })} /></label>
          <button className="btn" type="button" disabled={busy || !form.code} onClick={create}>Create event type</button>
        </Section>
      </div>

      {selected ? (
        <Drawer title={selected.code} subtitle="Event registry" onClose={() => setSelected(null)}>
          {detail.error ? <div className="error">{detail.error}</div> : null}
          <div className="chips">
            <span className="chip">Category: {titleCase(selected.category)}</span>
            <span className="chip">Version: {selected.version}</span>
            <span className="chip">Subscribers: {detail.data?.subscriber_count ?? "—"}</span>
            <span className="chip">Replay: {selected.replay_policy}</span>
          </div>
          <h3>Versions</h3>
          <Table
            columns={[
              { key: "version", label: "v" },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "compatibility", label: "Compatibility", render: (r) => titleCase(r.compatibility) },
              { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
            ]}
            rows={detail.data?.versions || []}
            empty="No versions"
          />
          <h3 style={{ marginTop: 16 }}>Add version</h3>
          <textarea className="input mono" rows={6} value={version} onChange={(e) => setVersion(e.target.value)} />
          <button className="btn" type="button" disabled={busy} onClick={addVersion}>Add version</button>
          <h3 style={{ marginTop: 16 }}>Current schema</h3>
          <JsonBlock value={selected.schema} />
        </Drawer>
      ) : null}
    </>
  );
}

const EMPTY_SUB = { code: "", event_type_code: "", subscriber: "", handler: "", filter: "" };

export function EventSubscriptionsPanel() {
  const [page, setPageState] = useState(1);
  const [status, setStatus] = useState("");
  const [form, setForm] = useState(EMPTY_SUB);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState(null);
  const list = useAsync(() => events.subscriptions(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);
  const tested = useAsync(() => (inspect ? events.testSubscription(inspect.code, {}) : Promise.resolve(null)), [inspect?.code]);
  const meta = useAsync(() => events.meta(), []);

  async function create() {
    setBusy(true);
    setNotice("");
    try {
      let filter = {};
      if (form.filter.trim()) {
        try { filter = JSON.parse(form.filter); } catch { throw new Error("Filter must be valid JSON"); }
      }
      await events.createSubscription({ ...form, filter });
      setNotice(`Subscription ${form.code} created.`);
      setForm(EMPTY_SUB);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function activate(code, next) {
    try {
      await events.setSubscriptionStatus(code, next);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function remove(code) {
    try {
      await events.deleteSubscription(code);
      setNotice(`Subscription ${code} deleted.`);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Toolbar>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPageState(1); }}>
          <option value="">All statuses</option>
          {["draft", "active", "inactive", "suspended"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="muted">{list.data?.total ?? 0} subscriptions</span>
      </Toolbar>
      <Notice kind={/error|must|valid|cannot|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      <div className="split">
        <Section title="Subscriptions">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
              { key: "subscriber", label: "Subscriber" },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "actions", label: "", render: (r) => (
                <span className="inline">
                  <button className="btn ghost" type="button" onClick={() => setInspect(r)}>Test</button>
                  {r.status === "active" ? (
                    <button className="btn ghost" type="button" onClick={() => activate(r.code, "inactive")}>Disable</button>
                  ) : (
                    <button className="btn ghost" type="button" onClick={() => activate(r.code, "active")}>Activate</button>
                  )}
                  <button className="btn ghost" type="button" onClick={() => remove(r.code)}>Delete</button>
                </span>
              ) },
            ]}
            rows={list.data?.items || []}
            empty="No subscriptions"
            loading={list.loading}
          />
          <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
        </Section>

        <Section title="New subscription">
          <label className="field"><span>Code</span><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field"><span>Event type</span>
            <select className="input" value={form.event_type_code} onChange={(e) => setForm({ ...form, event_type_code: e.target.value })}>
              <option value="">Select event type</option>
              {(meta.data?.event_types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
            </select>
          </label>
          <label className="field"><span>Subscriber</span><input className="input" value={form.subscriber} onChange={(e) => setForm({ ...form, subscriber: e.target.value })} /></label>
          <label className="field"><span>Handler</span><input className="input" value={form.handler} onChange={(e) => setForm({ ...form, handler: e.target.value })} placeholder="audit.record" /></label>
          <label className="field"><span>Filter (JSON, optional)</span><textarea className="input mono" rows={3} value={form.filter} onChange={(e) => setForm({ ...form, filter: e.target.value })} placeholder='{ "payload.kind": "release" }' /></label>
          <button className="btn" type="button" disabled={busy || !form.code || !form.event_type_code} onClick={create}>Create subscription</button>
        </Section>
      </div>

      {inspect ? (
        <Drawer title={inspect.code} subtitle="Subscription test" onClose={() => setInspect(null)}>
          {tested.error ? <div className="error">{tested.error}</div> : null}
          <div className="chips">
            <span className="chip">Matched: {asText(tested.data?.matched)}</span>
            <span className="chip">Handler registered: {asText(tested.data?.handler_registered)}</span>
            <span className="chip">Target: {asText(tested.data?.target)}</span>
          </div>
          <h3>Validation</h3>
          <JsonBlock value={tested.data?.validation} />
          <h3 style={{ marginTop: 16 }}>Filter</h3>
          <JsonBlock value={tested.data?.filter} />
        </Drawer>
      ) : null}
    </>
  );
}

export function EventDeliveriesPanel() {
  const [page, setPageState] = useState(1);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const list = useAsync(() => events.deliveries(`?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`), [page, status]);
  const stats = useAsync(() => events.deliveryStats(), []);
  const [selected, setSelected] = useState(null);
  const attempts = useAsync(() => (selected ? events.deliveryAttempts(selected.id) : Promise.resolve(null)), [selected?.id]);

  async function retry(row) {
    try {
      await events.retryDelivery(row.id);
      setNotice(`Delivery ${row.id} requeued.`);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function skip(row) {
    try {
      await events.skipDelivery(row.id, "skipped from console");
      setNotice(`Delivery ${row.id} skipped.`);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  const s = stats.data;

  return (
    <>
      <Toolbar>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPageState(1); }}>
          <option value="">All statuses</option>
          {["pending", "processing", "retry", "out_of_order", "delivered", "failed", "dead_letter", "duplicate", "ignored"].map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <span className="muted">{list.data?.total ?? 0} deliveries</span>
      </Toolbar>
      <Notice kind={/error|fail|already/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <StatGrid
        items={[
          { label: "Total (24h)", value: s?.total },
          { label: "Delivered", value: s?.delivered },
          { label: "Retrying", value: s?.retrying },
          { label: "Duplicate", value: s?.duplicate },
        ]}
      />
      <Section title="Deliveries" className="intg-section">
        <Table
          columns={[
            { key: "id", label: "#" },
            { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
            { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler || "—"}</span> },
            { key: "attempts", label: "Attempts" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            { key: "actions", label: "", render: (r) => (
              <span className="inline">
                <button className="btn ghost" type="button" onClick={() => setSelected(r)}>View</button>
                {r.status !== "delivered" ? <button className="btn ghost" type="button" onClick={() => retry(r)}>Retry</button> : null}
                {r.status !== "delivered" && r.status !== "skipped" ? <button className="btn ghost" type="button" onClick={() => skip(r)}>Skip</button> : null}
              </span>
            ) },
          ]}
          rows={list.data?.items || []}
          empty="No deliveries"
          loading={list.loading}
        />
        <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
      </Section>

      {selected ? (
        <Drawer title={`Delivery ${selected.id}`} subtitle={selected.event_ref} onClose={() => setSelected(null)}>
          <div className="chips">
            <span className="chip">Status: {selected.status}</span>
            <span className="chip">Queue: {selected.queue_code || "—"}</span>
            <span className="chip">Attempts: {selected.attempts}/{selected.max_attempts}</span>
          </div>
          {selected.last_error ? <Notice kind="error">{selected.last_error}</Notice> : null}
          <h3>Attempts</h3>
          <Table
            columns={[
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "step", label: "Step" },
              { key: "duration_ms", label: "ms" },
              { key: "created_at", label: "When", render: (r) => ts(r.created_at) },
            ]}
            rows={attempts.data?.items || []}
            empty="No attempts recorded"
          />
        </Drawer>
      ) : null}
    </>
  );
}

export function EventDeadLetterPanel() {
  const [page, setPageState] = useState(1);
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState({ status: "open", eventTypeCode: "", handler: "", q: "" });
  const [selected, setSelected] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const meta = useAsync(() => events.meta(), []);
  const qs = `?page=${page}&pageSize=25`
    + (filters.status ? `&status=${encodeURIComponent(filters.status)}` : "")
    + (filters.eventTypeCode ? `&eventTypeCode=${encodeURIComponent(filters.eventTypeCode)}` : "")
    + (filters.handler ? `&handler=${encodeURIComponent(filters.handler)}` : "")
    + (filters.q ? `&q=${encodeURIComponent(filters.q)}` : "");
  const list = useAsync(() => events.deadLetters(qs), [qs]);
  const stats = useAsync(() => events.deadLetterStats(), []);
  const detail = useAsync(() => (detailId ? events.deadLetter(detailId) : Promise.resolve(null)), [detailId]);

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat(id)));
  }

  async function resolve(row, action) {
    try {
      await events.resolveDeadLetter(row.id, { action, reason: `${action} from console` });
      setNotice(`Dead letter ${row.id} ${action === "retry" ? "requeued" : "closed"}.`);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function bulkRetry(useSelection) {
    try {
      const body = useSelection
        ? { ids: selected, reason: "bulk retry (selected) from console" }
        : {
          status: filters.status || "open",
          eventTypeCode: filters.eventTypeCode || undefined,
          handler: filters.handler || undefined,
          reason: "bulk retry (matching) from console",
        };
      const result = await events.bulkRetryDeadLetters(body);
      setNotice(`Bulk retry: ${result.retried}/${result.requested} requeued.`);
      setSelected([]);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  const rows = list.data?.items || [];

  return (
    <>
      <Toolbar>
        <input className="input" placeholder="Search ref, error, handler…" value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setPageState(1); }} />
        <select className="input" value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPageState(1); }}>
          <option value="">All statuses</option>
          {["open", "retrying", "resolved", "ignored"].map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <select className="input" value={filters.eventTypeCode} onChange={(e) => { setFilters({ ...filters, eventTypeCode: e.target.value }); setPageState(1); }}>
          <option value="">All event types</option>
          {(meta.data?.event_types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
        </select>
        <input className="input" placeholder="handler" value={filters.handler} onChange={(e) => { setFilters({ ...filters, handler: e.target.value }); setPageState(1); }} />
        <button className="btn" type="button" disabled={!selected.length} onClick={() => bulkRetry(true)}>Retry selected ({selected.length})</button>
        <button className="btn secondary" type="button" onClick={() => bulkRetry(false)}>Retry matching</button>
      </Toolbar>
      <Notice kind={/error|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <StatGrid
        items={[
          { label: "Open", value: stats.data?.open },
          { label: "Retrying", value: stats.data?.retrying },
          { label: "Resolved", value: stats.data?.resolved },
          { label: "Ignored", value: stats.data?.ignored },
        ]}
      />
      <Section title="Dead letters" className="intg-section">
        <Table
          columns={[
            { key: "pick", label: "", render: (r) => (
              <input type="checkbox" className="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} />
            ) },
            { key: "id", label: "#" },
            { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
            { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler || "—"}</span> },
            { key: "error_category", label: "Category", render: (r) => titleCase(r.error_category) },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            { key: "actions", label: "", render: (r) => (
              <span className="inline">
                <button className="btn ghost" type="button" onClick={() => setDetailId(r.id)}>View</button>
                <button className="btn ghost" type="button" onClick={() => resolve(r, "retry")}>Requeue</button>
                <button className="btn ghost" type="button" onClick={() => resolve(r, "ignore")}>Ignore</button>
              </span>
            ) },
          ]}
          rows={rows}
          empty="No dead letters"
          loading={list.loading}
        />
        <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
      </Section>

      {detailId ? (
        <Drawer title={`Dead letter ${detailId}`} subtitle={detail.data?.event_ref} onClose={() => setDetailId(null)}>
          {detail.error ? <Notice kind="error">{detail.error}</Notice> : null}
          {detail.data ? (
            <>
              <div className="chips">
                <span className="chip">Type: {detail.data.event_type_code}</span>
                <span className="chip">Handler: {detail.data.handler || "—"}</span>
                <span className="chip">Category: {titleCase(detail.data.error_category)}</span>
                <span className="chip">Attempts: {detail.data.attempts}</span>
                <span className="chip">Status: {detail.data.status}</span>
              </div>
              {detail.data.error_message ? <Notice kind="error">{detail.data.error_code ? `${detail.data.error_code}: ` : ""}{detail.data.error_message}</Notice> : null}
              <Section title="Payload">
                <JsonBlock value={detail.data.payload ?? {}} />
              </Section>
              <div className="inline">
                <button className="btn" type="button" onClick={() => { resolve(detail.data, "retry"); setDetailId(null); }}>Requeue</button>
                <button className="btn secondary" type="button" onClick={() => { resolve(detail.data, "ignore"); setDetailId(null); }}>Ignore</button>
              </div>
            </>
          ) : null}
        </Drawer>
      ) : null}
    </>
  );
}

export function EventReplayPanel() {
  const [page, setPageState] = useState(1);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ scope_type: "type", event_type_code: "", source_module: "", dry_run: true });
  const [preview, setPreview] = useState(null);
  const list = useAsync(() => events.replays(`?page=${page}&pageSize=25`), [page]);
  const meta = useAsync(() => events.meta(), []);

  async function doPreview() {
    setNotice("");
    try {
      setPreview(await events.previewReplay(form));
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function create() {
    setNotice("");
    try {
      const replay = await events.createReplay(form);
      setNotice(`Replay ${replay.replay_ref} created (${replay.dry_run ? "dry run" : "live"}).`);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function run(ref) {
    try {
      const result = await events.runReplay(ref);
      setNotice(`Replay ${ref} finished with status ${result.status}.`);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function cancel(ref) {
    try {
      await events.cancelReplay(ref);
      setNotice(`Replay ${ref} cancelled.`);
      list.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Notice kind={/error|denied|requires|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <div className="split">
        <Section title="Replays">
          <Table
            columns={[
              { key: "replay_ref", label: "Ref", render: (r) => <span className="mono">{r.replay_ref}</span> },
              { key: "scope_type", label: "Scope", render: (r) => titleCase(r.scope_type) },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "replayed_events", label: "Replayed" },
              { key: "actions", label: "", render: (r) => (
                <span className="inline">
                  {["validated", "pending"].includes(r.status) ? <button className="btn ghost" type="button" onClick={() => run(r.replay_ref)}>Run</button> : null}
                  {!["completed", "cancelled", "failed"].includes(r.status) ? <button className="btn ghost" type="button" onClick={() => cancel(r.replay_ref)}>Cancel</button> : null}
                </span>
              ) },
            ]}
            rows={list.data?.items || []}
            empty="No replays"
            loading={list.loading}
          />
          <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
        </Section>

        <Section title="New replay">
          <label className="field"><span>Scope</span>
            <select className="input" value={form.scope_type} onChange={(e) => setForm({ ...form, scope_type: e.target.value })}>
              {["event", "range", "type", "time", "module", "aggregate", "tenant", "failed", "dead_letter"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="field"><span>Event type</span>
            <select className="input" value={form.event_type_code} onChange={(e) => setForm({ ...form, event_type_code: e.target.value })}>
              <option value="">Select event type</option>
              {(meta.data?.event_types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
            </select>
          </label>
          <label className="field"><span>Source module</span><input className="input" value={form.source_module} onChange={(e) => setForm({ ...form, source_module: e.target.value })} /></label>
          <label className="checkbox"><input type="checkbox" checked={form.dry_run} onChange={(e) => setForm({ ...form, dry_run: e.target.checked })} /> Dry run</label>
          <div className="inline">
            <button className="btn secondary" type="button" onClick={doPreview}>Preview</button>
            <button className="btn" type="button" onClick={create}>Create replay</button>
          </div>
          {preview ? (
            <div style={{ marginTop: 12 }}>
              <div className="chips">
                <span className="chip">Matched: {preview.matched_events}</span>
                <span className="chip">Targets: {preview.target_subscriptions?.length ?? 0}</span>
              </div>
              <JsonBlock value={preview.by_event_type || []} maxHeight={160} />
            </div>
          ) : null}
        </Section>
      </div>
    </>
  );
}

const EMPTY_POLICY = { code: "", event_type_code: "", retention_days: 90, action: "archive" };

export function EventRetentionPanel() {
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(EMPTY_POLICY);
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => events.retentionPolicies("?pageSize=100"), []);
  const stats = useAsync(() => events.retentionStats(), []);
  const meta = useAsync(() => events.meta(), []);

  async function create() {
    setBusy(true);
    setNotice("");
    try {
      await events.createRetentionPolicy({ ...form, event_type_code: form.event_type_code || undefined });
      setNotice(`Policy ${form.code} created.`);
      setForm(EMPTY_POLICY);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply(code, dryRun) {
    try {
      const result = await events.applyRetentionPolicy(code, { dry_run: dryRun });
      setNotice(dryRun ? `Preview: ${result.candidates} candidate(s).` : `Applied: ${result.archived || 0} archived, ${result.deleted || 0} deleted.`);
      list.reload();
      stats.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <Notice kind={/error|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      <StatGrid
        items={[
          { label: "Policies", value: stats.data?.policies },
          { label: "Active", value: stats.data?.active },
          { label: "Archived records", value: stats.data?.archived_records },
        ]}
      />
      <div className="split">
        <Section title="Retention policies">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code || "all"}</span> },
              { key: "retention_days", label: "Days" },
              { key: "action", label: "Action", render: (r) => titleCase(r.action) },
              { key: "actions", label: "", render: (r) => (
                <span className="inline">
                  <button className="btn ghost" type="button" onClick={() => apply(r.code, true)}>Preview</button>
                  <button className="btn ghost" type="button" onClick={() => apply(r.code, false)}>Apply</button>
                </span>
              ) },
            ]}
            rows={list.data?.items || []}
            empty="No retention policies"
            loading={list.loading}
          />
        </Section>

        <Section title="New policy">
          <label className="field"><span>Code</span><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field"><span>Event type (optional)</span>
            <select className="input" value={form.event_type_code} onChange={(e) => setForm({ ...form, event_type_code: e.target.value })}>
              <option value="">All event types</option>
              {(meta.data?.event_types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
            </select>
          </label>
          <label className="field"><span>Retention days</span><input className="input" type="number" min="1" value={form.retention_days} onChange={(e) => setForm({ ...form, retention_days: Number(e.target.value) })} /></label>
          <label className="field"><span>Action</span>
            <select className="input" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              {["archive", "delete", "delete_after_archive"].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button className="btn" type="button" disabled={busy || !form.code} onClick={create}>Create policy</button>
        </Section>
      </div>
    </>
  );
}

export function EventTopologyPanel() {
  const [notice, setNotice] = useState("");
  const [topic, setTopic] = useState({ code: "", name: "" });
  const [queue, setQueue] = useState({ code: "", name: "", consumer_group: "" });
  const [group, setGroup] = useState({ code: "", name: "", topic_code: "", queue_code: "" });
  const topics = useAsync(() => events.topics("?pageSize=50"), []);
  const queues = useAsync(() => events.queues("?pageSize=50"), []);
  const groups = useAsync(() => events.consumerGroups("?pageSize=50"), []);
  const outbox = useAsync(() => events.outbox("?pageSize=25"), []);

  async function createTopic() {
    try { await events.createTopic(topic); setNotice(`Topic ${topic.code} created.`); setTopic({ code: "", name: "" }); topics.reload(); } catch (err) { setNotice(err.message); }
  }
  async function createQueue() {
    try { await events.createQueue(queue); setNotice(`Queue ${queue.code} created.`); setQueue({ code: "", name: "", consumer_group: "" }); queues.reload(); } catch (err) { setNotice(err.message); }
  }
  async function createGroup() {
    try { await events.createConsumerGroup(group); setNotice(`Consumer group ${group.code} created.`); setGroup({ code: "", name: "", topic_code: "", queue_code: "" }); groups.reload(); } catch (err) { setNotice(err.message); }
  }
  async function processOutbox() {
    try { const result = await events.processOutbox({}); setNotice(`Outbox processed: ${result.published} published, ${result.retried} retried.`); outbox.reload(); } catch (err) { setNotice(err.message); }
  }

  return (
    <>
      <Toolbar>
        <button className="btn secondary" type="button" onClick={processOutbox}>Process outbox now</button>
        <span className="muted">{topics.data?.total ?? 0} topics · {queues.data?.total ?? 0} queues · {groups.data?.total ?? 0} groups</span>
      </Toolbar>
      <Notice kind={/error|must|unknown|fail/i.test(notice) ? "error" : "ok"}>{notice}</Notice>

      <div className="split">
        <Section title="Topics">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "name", label: "Name" },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            ]}
            rows={topics.data?.items || []}
            empty="No topics"
          />
          <div className="inline" style={{ marginTop: 10 }}>
            <input className="input" placeholder="code" value={topic.code} onChange={(e) => setTopic({ ...topic, code: e.target.value })} />
            <input className="input" placeholder="name" value={topic.name} onChange={(e) => setTopic({ ...topic, name: e.target.value })} />
            <button className="btn" type="button" disabled={!topic.code} onClick={createTopic}>Add topic</button>
          </div>
        </Section>

        <Section title="Queues">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "consumer_group", label: "Group", render: (r) => <span className="mono">{r.consumer_group || "—"}</span> },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            ]}
            rows={queues.data?.items || []}
            empty="No queues"
          />
          <div className="inline" style={{ marginTop: 10 }}>
            <input className="input" placeholder="code" value={queue.code} onChange={(e) => setQueue({ ...queue, code: e.target.value })} />
            <input className="input" placeholder="group" value={queue.consumer_group} onChange={(e) => setQueue({ ...queue, consumer_group: e.target.value })} />
            <button className="btn" type="button" disabled={!queue.code} onClick={createQueue}>Add queue</button>
          </div>
        </Section>
      </div>

      <div className="split">
        <Section title="Consumer groups">
          <Table
            columns={[
              { key: "code", label: "Code", render: (r) => <span className="mono">{r.code}</span> },
              { key: "topic_code", label: "Topic", render: (r) => <span className="mono">{r.topic_code || "—"}</span> },
              { key: "queue_code", label: "Queue", render: (r) => <span className="mono">{r.queue_code || "—"}</span> },
            ]}
            rows={groups.data?.items || []}
            empty="No consumer groups"
          />
          <div className="inline" style={{ marginTop: 10 }}>
            <input className="input" placeholder="code" value={group.code} onChange={(e) => setGroup({ ...group, code: e.target.value })} />
            <input className="input" placeholder="topic" value={group.topic_code} onChange={(e) => setGroup({ ...group, topic_code: e.target.value })} />
            <input className="input" placeholder="queue" value={group.queue_code} onChange={(e) => setGroup({ ...group, queue_code: e.target.value })} />
            <button className="btn" type="button" disabled={!group.code} onClick={createGroup}>Add group</button>
          </div>
        </Section>

        <Section title="Outbox">
          <Table
            columns={[
              { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
              { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
              { key: "attempts", label: "Attempts" },
              { key: "created_at", label: "Created", render: (r) => ts(r.created_at) },
            ]}
            rows={outbox.data?.items || []}
            empty="Outbox is empty"
            loading={outbox.loading}
          />
        </Section>
      </div>
    </>
  );
}

function Facts({ items }) {
  return (
    <Table
      columns={[
        { key: "label", label: "Field", width: "38%" },
        { key: "value", label: "Value", render: (r) => (r.mono ? <span className="mono">{asText(r.value, "—")}</span> : asText(r.value, "—")) },
      ]}
      rows={items}
      empty="—"
    />
  );
}

export function EventDetailsDrawer({ eventRef, onClose, onOpenEvent, onTrace }) {
  const detail = useAsync(() => events.event(eventRef), [eventRef]);
  const ev = detail.data;
  const related = useAsync(
    () => (ev && (ev.correlation_id || ev.trace_id)
      ? events.monitoringTraceability(ev.correlation_id
        ? `?correlationId=${encodeURIComponent(ev.correlation_id)}`
        : `?traceId=${encodeURIComponent(ev.trace_id)}`)
      : Promise.resolve(null)),
    [ev?.correlation_id, ev?.trace_id]
  );
  const [notice, setNotice] = useState("");

  async function route() {
    try {
      await events.routeEvent(eventRef);
      setNotice("Event routed to current subscribers.");
      detail.reload();
    } catch (err) {
      setNotice(err.message);
    }
  }

  const timelines = related.data?.events || [];

  return (
    <Drawer title={ev?.event_type_code || eventRef} subtitle={ev?.event_ref || eventRef} onClose={onClose}>
      {detail.error ? <Notice kind="error">{detail.error}</Notice> : null}
      <Notice kind={/error|fail|not found/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {ev ? (
        <>
          <div className="chips">
            <span className="chip">Status: {ev.status}</span>
            <span className="chip">Version: {ev.event_version}</span>
            <span className="chip">Classification: {ev.security_classification}</span>
            <span className="chip">Source: {ev.source_module || "—"}</span>
          </div>
          <div className="inline" style={{ margin: "10px 0" }}>
            <button className="btn ghost" type="button" onClick={route}>Route event</button>
            {onTrace ? <button className="btn ghost" type="button" onClick={() => onTrace(ev)}>View trace</button> : null}
          </div>

          <Section title="Identity">
            <Facts items={[
              { label: "Event id", value: ev.event_id, mono: true },
              { label: "Event ref", value: ev.event_ref, mono: true },
              { label: "Event type", value: ev.event_type_code, mono: true },
              { label: "Event version", value: ev.event_version },
              { label: "Status", value: ev.status },
              { label: "Security classification", value: ev.security_classification },
              { label: "Priority", value: ev.priority },
              { label: "Sequence number", value: ev.sequence_number },
              { label: "Partition key", value: ev.partition_key, mono: true },
            ]} />
          </Section>

          <Section title="Source & actor">
            <Facts items={[
              { label: "Source module", value: ev.source_module },
              { label: "Source system", value: ev.source_system },
              { label: "Object type", value: ev.source_object_type },
              { label: "Object id", value: ev.source_object_id, mono: true },
              { label: "Object revision", value: ev.source_object_revision },
              { label: "Actor", value: ev.actor_id, mono: true },
              { label: "Actor type", value: ev.actor_type },
            ]} />
          </Section>

          <Section title="Traceability">
            <Facts items={[
              { label: "Correlation id", value: ev.correlation_id, mono: true },
              { label: "Causation id", value: ev.causation_id, mono: true },
              { label: "Trace id", value: ev.trace_id, mono: true },
              { label: "Parent event id", value: ev.parent_event_id },
            ]} />
          </Section>

          <Section title="Scope">
            <Facts items={[
              { label: "Tenant", value: ev.tenant_id },
              { label: "Organization", value: ev.organization_id },
              { label: "Plant", value: ev.plant_id },
              { label: "Site", value: ev.site_id },
            ]} />
          </Section>

          <Section title="Timing & delivery">
            <Facts items={[
              { label: "Occurred at", value: ts(ev.occurred_at) },
              { label: "Created at", value: ts(ev.created_at) },
              { label: "Updated at", value: ts(ev.updated_at) },
              { label: "Subscribers", value: ev.subscriber_count },
              { label: "Delivered", value: ev.delivered_count },
              { label: "Failed", value: ev.failed_count },
            ]} />
          </Section>

          <Section title="Payload">
            <JsonBlock value={ev.payload ?? {}} />
          </Section>
          <Section title="Metadata">
            <JsonBlock value={ev.metadata ?? {}} maxHeight={160} />
          </Section>

          <Section title="Subscribers">
            <Table
              columns={[
                { key: "id", label: "#" },
                { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler || "—"}</span> },
                { key: "subscriber", label: "Subscriber", render: (r) => <span className="mono">{r.subscriber || "—"}</span> },
                { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
                { key: "attempts", label: "Attempts" },
              ]}
              rows={ev.deliveries || []}
              empty="No subscribers"
            />
          </Section>

          <Section title="Related events">
            <Table
              columns={[
                { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
                { key: "event_ref", label: "Ref", render: (r) => <span className="mono">{r.event_ref}</span> },
                { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
                { key: "created_at", label: "When", render: (r) => ts(r.created_at) },
                { key: "open", label: "", render: (r) => (onOpenEvent && r.event_ref !== ev.event_ref
                  ? <button className="btn ghost" type="button" onClick={() => onOpenEvent(r.event_ref)}>Open</button>
                  : null) },
              ]}
              rows={timelines}
              empty="No correlated events"
            />
          </Section>
        </>
      ) : null}
    </Drawer>
  );
}

export function EventRecordsPanel() {
  const [page, setPageState] = useState(1);
  const [filters, setFilters] = useState({ q: "", status: "", sourceModule: "", eventTypeCode: "" });
  const [selected, setSelected] = useState(null);
  const meta = useAsync(() => events.meta(), []);
  const qs = `?page=${page}&pageSize=25`
    + (filters.q ? `&q=${encodeURIComponent(filters.q)}` : "")
    + (filters.status ? `&status=${encodeURIComponent(filters.status)}` : "")
    + (filters.sourceModule ? `&sourceModule=${encodeURIComponent(filters.sourceModule)}` : "")
    + (filters.eventTypeCode ? `&eventTypeCode=${encodeURIComponent(filters.eventTypeCode)}` : "");
  const list = useAsync(() => events.events(qs), [qs]);

  return (
    <>
      <Toolbar>
        <input className="input" placeholder="Search ref, type, object…" value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setPageState(1); }} />
        <select className="input" value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPageState(1); }}>
          <option value="">All statuses</option>
          {["pending", "published", "routed", "partially_delivered", "delivered", "failed", "dead_letter"].map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <select className="input" value={filters.eventTypeCode} onChange={(e) => { setFilters({ ...filters, eventTypeCode: e.target.value }); setPageState(1); }}>
          <option value="">All event types</option>
          {(meta.data?.event_types || []).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
        </select>
        <input className="input" placeholder="source module" value={filters.sourceModule} onChange={(e) => { setFilters({ ...filters, sourceModule: e.target.value }); setPageState(1); }} />
        <button className="btn secondary" type="button" onClick={() => list.reload()}>Refresh</button>
        <span className="muted">{list.data?.total ?? 0} events</span>
      </Toolbar>
      <Section title="Event records">
        <Table
          columns={[
            { key: "event_ref", label: "Ref", render: (r) => <span className="mono">{r.event_ref}</span> },
            { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
            { key: "event_version", label: "Ver" },
            { key: "source_module", label: "Module" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
            { key: "subscriber_count", label: "Subs" },
            { key: "created_at", label: "When", render: (r) => ts(r.created_at) },
            { key: "open", label: "", render: (r) => <button className="btn ghost" type="button" onClick={() => setSelected(r.event_ref)}>Details</button> },
          ]}
          rows={list.data?.items || []}
          empty="No events"
          loading={list.loading}
          onRow={(r) => setSelected(r.event_ref)}
        />
        <Pager page={page} pageSize={25} total={list.data?.total} onPage={setPageState} />
      </Section>
      {selected ? <EventDetailsDrawer eventRef={selected} onClose={() => setSelected(null)} onOpenEvent={(ref) => setSelected(ref)} /> : null}
    </>
  );
}

export function EventHandlersPanel() {
  const [windowHours, setWindowHours] = useState(24);
  const [selected, setSelected] = useState(null);
  const handlers = useAsync(() => events.handlers(), []);
  const stats = useAsync(() => events.handlerStats(`?windowHours=${windowHours}`), [windowHours]);
  const detail = useAsync(() => (selected ? events.handlerDetail(selected) : Promise.resolve(null)), [selected]);
  const recent = useAsync(() => (selected ? events.deliveries(`?handler=${encodeURIComponent(selected)}&pageSize=10`) : Promise.resolve(null)), [selected]);

  const rows = stats.data?.items || [];
  const totals = rows.reduce(
    (acc, r) => ({
      total: acc.total + (r.total || 0),
      failed: acc.failed + (r.failed || 0),
      retrying: acc.retrying + (r.retrying || 0),
      durations: r.avg_duration_ms !== null && r.avg_duration_ms !== undefined ? acc.durations.concat(r.avg_duration_ms) : acc.durations,
    }),
    { total: 0, failed: 0, retrying: 0, durations: [] }
  );
  const avgLatency = totals.durations.length
    ? Math.round(totals.durations.reduce((a, b) => a + b, 0) / totals.durations.length)
    : null;

  return (
    <>
      <Toolbar>
        <label className="field"><span>Window (hours)</span>
          <select className="input" value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
            {[1, 6, 24, 72, 168].map((h) => <option key={h} value={h}>{h}h</option>)}
          </select>
        </label>
        <button className="btn secondary" type="button" onClick={() => { handlers.reload(); stats.reload(); }}>Refresh</button>
        <span className="muted">{handlers.data?.items?.length ?? 0} registered</span>
      </Toolbar>

      <StatGrid
        items={[
          { label: "Registered handlers", value: handlers.data?.items?.length },
          { label: "Handler/type pairs", value: rows.length },
          { label: "Failed deliveries", value: totals.failed, hint: `${totals.retrying} retrying` },
          { label: "Avg latency", value: avgLatency === null ? "—" : `${avgLatency} ms` },
        ]}
      />

      <Section title="Registered handlers" className="intg-section">
        <Table
          columns={[
            { key: "code", label: "Handler", render: (r) => <span className="mono">{r.code}</span> },
            { key: "module", label: "Module" },
            { key: "builtin", label: "Built-in", render: (r) => (r.builtin ? "yes" : "no") },
            { key: "description", label: "Description" },
            { key: "open", label: "", render: (r) => <button className="btn ghost" type="button" onClick={() => setSelected(r.code)}>Open</button> },
          ]}
          rows={handlers.data?.items || []}
          empty="No handlers registered"
          loading={handlers.loading}
          onRow={(r) => setSelected(r.code)}
        />
      </Section>

      <Section title="Handler activity" className="intg-section">
        <Table
          columns={[
            { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler}</span> },
            { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
            { key: "registered", label: "Reg", render: (r) => (r.registered ? "yes" : "no") },
            { key: "total", label: "Total" },
            { key: "succeeded", label: "OK" },
            { key: "failed", label: "Failed" },
            { key: "retried", label: "Retried" },
            { key: "success_rate", label: "Success %", render: (r) => (r.success_rate === null ? "—" : r.success_rate) },
            { key: "avg_duration_ms", label: "Avg ms" },
            { key: "last_activity_at", label: "Last activity", render: (r) => ts(r.last_activity_at) },
            { key: "open", label: "", render: (r) => <button className="btn ghost" type="button" onClick={() => setSelected(r.handler)}>Open</button> },
          ]}
          rows={rows}
          empty="No handler activity"
          loading={stats.loading}
          onRow={(r) => setSelected(r.handler)}
        />
      </Section>

      <Section title="Slowest handlers" className="intg-section">
        <Table
          columns={[
            { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler}</span> },
            { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
            { key: "avg_duration_ms", label: "Avg ms" },
            { key: "max_duration_ms", label: "Max ms" },
            { key: "total", label: "Total" },
          ]}
          rows={stats.data?.slow || []}
          empty="No latency data"
        />
      </Section>

      {selected ? (
        <Drawer title={detail.data?.registered ? selected : `${selected} (unregistered)`} subtitle="Handler detail" onClose={() => setSelected(null)}>
          {detail.error ? <Notice kind="error">{detail.error}</Notice> : null}
          <div className="chips">
            <span className="chip">Module: {detail.data?.module || "—"}</span>
            <span className="chip">Built-in: {detail.data?.builtin ? "yes" : "no"}</span>
            <span className="chip">Registered: {detail.data?.registered ? "yes" : "no"}</span>
          </div>
          {detail.data?.description ? <p className="muted">{detail.data.description}</p> : null}

          <Section title="Stats by event type">
            <Table
              columns={[
                { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
                { key: "total", label: "Total" },
                { key: "succeeded", label: "OK" },
                { key: "failed", label: "Failed" },
                { key: "success_rate", label: "Success %" },
                { key: "avg_duration_ms", label: "Avg ms" },
              ]}
              rows={detail.data?.stats || []}
              empty="No activity in window"
            />
          </Section>

          <Section title="Recent deliveries">
            <Table
              columns={[
                { key: "event_ref", label: "Event", render: (r) => <span className="mono">{r.event_ref}</span> },
                { key: "event_type_code", label: "Type", render: (r) => <span className="mono">{r.event_type_code}</span> },
                { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
                { key: "attempts", label: "Attempts" },
                { key: "updated_at", label: "When", render: (r) => ts(r.updated_at) },
              ]}
              rows={recent.data?.items || []}
              empty="No recent deliveries"
              loading={recent.loading}
            />
          </Section>
        </Drawer>
      ) : null}
    </>
  );
}

export function EventTracePanel() {
  const [lookup, setLookup] = useState({ correlationId: "", traceId: "" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const trace = useAsync(
    () => (query ? events.monitoringTraceability(query) : Promise.resolve(null)),
    [query]
  );

  function search() {
    if (lookup.correlationId) setQuery(`?correlationId=${encodeURIComponent(lookup.correlationId)}`);
    else if (lookup.traceId) setQuery(`?traceId=${encodeURIComponent(lookup.traceId)}`);
    else setQuery("");
  }

  const events_ = trace.data?.events || [];
  const deliveries = trace.data?.deliveries || [];
  const delivered = deliveries.filter((d) => d.status === "delivered").length;
  const failed = deliveries.filter((d) => d.status === "failed" || d.status === "dead_letter").length;

  return (
    <>
      <Toolbar>
        <input className="input" placeholder="Correlation id" value={lookup.correlationId} onChange={(e) => setLookup({ correlationId: e.target.value, traceId: "" })} />
        <input className="input" placeholder="Trace id" value={lookup.traceId} onChange={(e) => setLookup({ traceId: e.target.value, correlationId: "" })} />
        <button className="btn" type="button" disabled={!lookup.correlationId && !lookup.traceId} onClick={search}>Trace</button>
        {query ? <button className="btn secondary" type="button" onClick={() => trace.reload()}>Refresh</button> : null}
      </Toolbar>

      {!query ? <div className="audit-empty">Enter a correlation id or trace id to follow an event chain across modules.</div> : null}
      {query ? (
        <>
          <StatGrid
            items={[
              { label: "Events", value: events_.length },
              { label: "Deliveries", value: deliveries.length },
              { label: "Delivered", value: delivered },
              { label: "Failed", value: failed },
            ]}
          />
          <div className="split" style={{ marginTop: 16 }}>
            <Section title="Events in trace">
              <Table
                columns={[
                  { key: "event_type_code", label: "Event type", render: (r) => <span className="mono">{r.event_type_code}</span> },
                  { key: "event_ref", label: "Ref", render: (r) => <span className="mono">{r.event_ref}</span> },
                  { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
                  { key: "created_at", label: "When", render: (r) => ts(r.created_at) },
                  { key: "open", label: "", render: (r) => <button className="btn ghost" type="button" onClick={() => setSelected(r.event_ref)}>Details</button> },
                ]}
                rows={events_}
                empty="No events in this trace"
                onRow={(r) => setSelected(r.event_ref)}
              />
            </Section>
            <Section title="Deliveries in trace">
              <Table
                columns={[
                  { key: "handler", label: "Handler", render: (r) => <span className="mono">{r.handler || "—"}</span> },
                  { key: "event_ref", label: "Event", render: (r) => <span className="mono">{r.event_ref}</span> },
                  { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} prefix="eng-" /> },
                  { key: "attempts", label: "Attempts" },
                  { key: "duration_ms", label: "ms" },
                  { key: "updated_at", label: "When", render: (r) => ts(r.updated_at) },
                ]}
                rows={deliveries}
                empty="No deliveries in this trace"
              />
            </Section>
          </div>
        </>
      ) : null}

      {selected ? <EventDetailsDrawer eventRef={selected} onClose={() => setSelected(null)} onOpenEvent={(ref) => setSelected(ref)} /> : null}
    </>
  );
}
