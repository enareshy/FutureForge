import React, { useState } from "react";
import { integration } from "../../api.js";
import { JsonBlock, Notice, Pager, Section, StatGrid, StatusBadge, Table, Toolbar, useAsync, ts, titleCase } from "./common.jsx";

export default function IntegrationOverviewPanel() {
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [usagePage, setUsagePage] = useState(1);
  const overview = useAsync(() => integration.monitoringOverview(), []);
  const systems = useAsync(() => integration.monitoringSystems(), []);
  const usage = useAsync(() => integration.monitoringApiUsage(`?page=${usagePage}&pageSize=10`), [usagePage]);

  async function runHealthChecks() {
    setRunning(true);
    setNotice("");
    try {
      const result = await integration.runHealthChecks({});
      setNotice(`Health checks completed for ${result.checked ?? result.items?.length ?? 0} system(s).`);
      await Promise.all([overview.reload(), systems.reload()]);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setRunning(false);
    }
  }

  const o = overview.data;
  const exec = o?.executions;
  const deliveries = o?.deliveries;

  return (
    <>
      <Toolbar>
        <button className="btn secondary" type="button" disabled={running} onClick={runHealthChecks}>
          {running ? "Running…" : "Run health checks"}
        </button>
        <span className="muted mono">Generated {ts(o?.generated_at)}</span>
      </Toolbar>

      <Notice kind={notice && /fail|error|not/i.test(notice) ? "error" : "ok"}>{notice}</Notice>
      {overview.error ? <div className="error">{overview.error}</div> : null}

      <StatGrid
        items={[
          { label: "Integrations", value: o?.definitions?.total, hint: `${o?.definitions?.by_status?.active || 0} active` },
          { label: "Executions (24h)", value: exec?.totals?.total, hint: `${exec?.success_rate ?? "—"}% success` },
          { label: "Schedules", value: o?.schedules?.total, hint: `${o?.schedules?.active || 0} active` },
          { label: "External systems", value: systems.data?.items?.length, hint: `${o?.systems_health?.healthy || 0} healthy` },
        ]}
      />
      <div style={{ height: 14 }} />
      <StatGrid
        items={[
          { label: "Events", value: deliveries?.events?.total, hint: `${deliveries?.events?.failed || 0} failed` },
          { label: "Queued messages", value: deliveries?.message_queues?.total, hint: `${deliveries?.message_queues?.due || 0} due` },
          { label: "Dead letters", value: deliveries?.dead_letters?.total, hint: `${deliveries?.dead_letters?.open || 0} open` },
          { label: "API requests", value: usage.data?.requests, hint: `${usage.data?.errors || 0} errors` },
        ]}
      />

      <div className="split" style={{ marginTop: 16 }}>
        <Section title="Execution health">
          <div className="chips">
            {Object.entries(exec?.totals || {})
              .filter(([key]) => key !== "total")
              .map(([key, count]) => (
                <span className="chip" key={key}>{titleCase(key)}: {count}</span>
              ))}
            {!exec ? <span className="muted">No data</span> : null}
          </div>
          <h3 style={{ marginTop: 16 }}>Errors by category</h3>
          <Table
            columns={[
              { key: "error_category", label: "Category", render: (r) => titleCase(r.error_category) },
              { key: "count", label: "Count" },
            ]}
            rows={exec?.errors_by_category || []}
            empty="No errors recorded"
          />
          <h3 style={{ marginTop: 16 }}>Top failing integrations</h3>
          <Table
            columns={[
              { key: "integration_code", label: "Integration", render: (r) => <span className="mono">{r.integration_code || "—"}</span> },
              { key: "failures", label: "Failures" },
            ]}
            rows={exec?.top_failing || []}
            empty="No failing integrations"
          />
        </Section>

        <Section title="External system health">
          <Table
            columns={[
              { key: "code", label: "System", render: (r) => <span className="mono">{r.code}</span> },
              { key: "system_type", label: "Type", render: (r) => titleCase(r.system_type) },
              { key: "connection_status", label: "Status", render: (r) => <StatusBadge value={r.connection_status} prefix="eng-" /> },
              { key: "last_health_at", label: "Checked", render: (r) => ts(r.last_health_at) },
            ]}
            rows={systems.data?.items || []}
            empty="No external systems registered"
            loading={systems.loading}
          />
        </Section>
      </div>

      <Section title="API usage" className="intg-section">
        <Table
          columns={[
            { key: "endpoint_code", label: "Endpoint", render: (r) => <span className="mono">{r.endpoint_code || "—"}</span> },
            { key: "requests", label: "Requests" },
            { key: "avg_ms", label: "Avg ms", render: (r) => (r.avg_ms ? Math.round(r.avg_ms) : "—") },
          ]}
          rows={usage.data?.by_endpoint || []}
          empty="No API usage recorded"
          loading={usage.loading}
        />
        {usage.data?.by_endpoint?.length ? (
          <Pager page={usagePage} pageSize={10} total={usage.data.by_endpoint.length} onPage={setUsagePage} />
        ) : null}
        {usage.data?.by_status?.length ? (
          <JsonBlock value={usage.data.by_status} maxHeight={140} />
        ) : null}
      </Section>
    </>
  );
}
