import React, { useCallback, useEffect, useState } from "react";
import { search } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "types", label: "Object types" },
  { key: "indexes", label: "Index health" },
  { key: "configuration", label: "Configuration" },
];

function StatusBadge({ status }) {
  const tone = status === "active" || status === "succeeded" ? "active" : status === "disabled" || status === "inactive" ? "inactive" : "locked";
  return <span className={`badge ${tone}`}>{status}</span>;
}

export default function SearchAdminPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [health, setHealth] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [status, setStatus] = useState(null);
  const [failures, setFailures] = useState([]);
  const [types, setTypes] = useState([]);
  const [config, setConfig] = useState(null);
  const [typeForm, setTypeForm] = useState({ code: "", name: "", source_module: "", permission_resource: "", sensitivity: "internal" });

  const loadOverview = useCallback(async () => {
    const [healthRes, metricsRes] = await Promise.all([search.health(), search.metrics()]);
    setHealth(healthRes);
    setMetrics(metricsRes);
  }, []);

  const loadIndexes = useCallback(async () => {
    const [statusRes, failuresRes] = await Promise.all([search.indexStatus(), search.indexFailures()]);
    setStatus(statusRes);
    setFailures(failuresRes.items || []);
  }, []);

  const loadTypes = useCallback(async () => {
    const res = await search.objectTypes();
    setTypes(res.items || []);
  }, []);

  const loadConfig = useCallback(async () => {
    setConfig(await search.configuration());
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadOverview(), loadIndexes(), loadTypes(), loadConfig()]);
    } catch (err) {
      setError(err.message);
    }
  }, [loadOverview, loadIndexes, loadTypes, loadConfig]);

  useEffect(() => { refresh(); }, [refresh]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (success) setNotice(success);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createType(e) {
    e.preventDefault();
    await run(async () => {
      await search.createObjectType({
        code: typeForm.code,
        name: typeForm.name || typeForm.code,
        source_module: typeForm.source_module,
        permission_resource: typeForm.permission_resource,
        sensitivity: typeForm.sensitivity,
      });
      setTypeForm({ code: "", name: "", source_module: "", permission_resource: "", sensitivity: "internal" });
      await loadTypes();
    }, `Registered ${typeForm.code}.`);
  }

  async function toggleType(type) {
    const next = type.status === "active" ? "disabled" : "active";
    await run(() => search.setObjectTypeStatus(type.code, next).then(loadTypes), `${type.code} → ${next}.`);
  }

  async function removeType(type) {
    await run(() => search.deleteObjectType(type.code).then(loadTypes), `Removed ${type.code}.`);
  }

  async function saveConfig(e) {
    e.preventDefault();
    await run(async () => {
      const updated = await search.updateConfiguration({
        enabled: config.enabled,
        default_scope: config.default_scope,
        default_sort: config.default_sort,
        page_size: Number(config.page_size),
        max_results: Number(config.max_results),
        min_query_length: Number(config.min_query_length),
        max_query_length: Number(config.max_query_length),
        highlight: config.highlight,
        fuzzy: config.fuzzy,
        index_files: config.index_files,
        history_retention_days: Number(config.history_retention_days),
      });
      setConfig(updated);
    }, "Configuration saved.");
  }

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Search administration</h1>
          <div className="crumbs">Manage index registrations, health, configuration and telemetry.</div>
        </div>
        <button className="btn ghost" type="button" onClick={refresh}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="badge active" style={{ marginBottom: 12 }}>{notice}</div> : null}

      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`tab ${tab === item.key ? "active" : ""}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="grid">
            <div className="stat"><span>Documents indexed</span><b>{health?.documents_indexed ?? "–"}</b></div>
            <div className="stat"><span>Registered types</span><b>{health?.registered_object_types ?? "–"}</b></div>
            <div className="stat"><span>Enabled tenants</span><b>{health?.enabled_tenants ?? "–"}</b></div>
            <div className="stat"><span>Searches (30d)</span><b>{metrics?.searches?.total ?? "–"}</b></div>
            <div className="stat"><span>Avg duration</span><b>{metrics?.searches?.avg_duration_ms ?? 0} ms</b></div>
            <div className="stat"><span>Zero-result rate</span><b>{((metrics?.searches?.zero_result_rate || 0) * 100).toFixed(1)}%</b></div>
          </div>

          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Queue</h3></div>
              <ul className="detail-list">
                <li>pending: <span className="mono">{health?.queue?.pending ?? 0}</span></li>
                <li>processing: <span className="mono">{health?.queue?.processing ?? 0}</span></li>
                <li>failed: <span className="mono">{health?.queue?.failed ?? 0}</span></li>
                <li>dead letter: <span className="mono">{health?.queue?.dead_letter ?? 0}</span></li>
                <li>last indexed: <span className="mono">{health?.last_indexed_at || "never"}</span></li>
              </ul>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Top queries</h3></div>
              {metrics?.top_queries?.length ? (
                <div className="stack">
                  {metrics.top_queries.map((row) => (
                    <div className="stack-row" key={row.query}>
                      <span>{row.query}</span>
                      <span className="mono">{row.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sub">No searches recorded yet.</p>
              )}
            </div>
          </div>
        </>
      ) : null}

      {tab === "types" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Registered types</h3></div>
            <div className="stack">
              {types.map((type) => (
                <div className="stack-row" key={type.code}>
                  <div>
                    <div className="type-name">{type.name || type.code} <span className="mono">{type.code}</span></div>
                    <div className="mono">{type.source_module || "module"} · {type.permission_resource || "unscoped"}</div>
                  </div>
                  <div className="inline">
                    <StatusBadge status={type.status} />
                    <button className="btn ghost" type="button" onClick={() => toggleType(type)}>
                      {type.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => removeType(type)}>Delete</button>
                  </div>
                </div>
              ))}
              {!types.length ? <p className="sub">No object types registered.</p> : null}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Register object type</h3></div>
            <form onSubmit={createType}>
              <label className="field">
                <span>Code</span>
                <input value={typeForm.code} onChange={(e) => setTypeForm({ ...typeForm, code: e.target.value })} required />
              </label>
              <label className="field">
                <span>Name</span>
                <input value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Source module</span>
                <input value={typeForm.source_module} onChange={(e) => setTypeForm({ ...typeForm, source_module: e.target.value })} />
              </label>
              <label className="field">
                <span>Permission resource</span>
                <input
                  value={typeForm.permission_resource}
                  onChange={(e) => setTypeForm({ ...typeForm, permission_resource: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Sensitivity</span>
                <select value={typeForm.sensitivity} onChange={(e) => setTypeForm({ ...typeForm, sensitivity: e.target.value })}>
                  {["public", "internal", "confidential", "restricted"].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <button className="btn" type="submit">Register</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "indexes" ? (
        <>
          <div className="grid">
            <div className="stat"><span>Documents</span><b>{status?.documents_total ?? "–"}</b></div>
            <div className="stat"><span>Pending</span><b>{status?.queue?.pending ?? 0}</b></div>
            <div className="stat"><span>Failed</span><b>{status?.queue?.failed ?? 0}</b></div>
            <div className="stat"><span>Dead letter</span><b>{status?.queue?.dead_letter ?? 0}</b></div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3>Index operations</h3>
              <div className="inline">
                <button className="btn ghost" type="button" onClick={() => run(() => search.drainIndex({}).then(loadIndexes), "Queue drained.")}>Drain queue</button>
                <button className="btn ghost" type="button" onClick={() => run(() => search.retryFailures({}).then(loadIndexes), "Failures retried.")}>Retry failures</button>
                <button className="btn ghost" type="button" onClick={() => run(() => search.reindex({}).then(loadIndexes), "Reindex started.")}>Reindex tenant</button>
                <button className="btn ghost" type="button" onClick={() => run(() => search.pruneIndex({}).then(loadIndexes), "Stale entries pruned.")}>Prune</button>
                <button className="btn ghost" type="button" onClick={() => run(() => search.indexJob({}), "Index job queued.")}>Queue maintenance job</button>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Documents</th>
                </tr>
              </thead>
              <tbody>
                {(status?.documents_by_type || []).map((row) => (
                  <tr key={row.object_type}>
                    <td>{row.object_type}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head"><h3>Recent failures</h3></div>
            {failures.length ? (
              <div className="matrix">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Object</th>
                      <th>Operation</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map((row) => (
                      <tr key={row.id}>
                        <td>{row.object_type}</td>
                        <td className="mono">{row.object_id}</td>
                        <td>{row.operation}</td>
                        <td><StatusBadge status={row.status} /></td>
                        <td>{row.attempts}/{row.max_attempts}</td>
                        <td className="mono">{row.last_error || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="sub">No index failures.</p>
            )}
          </div>
        </>
      ) : null}

      {tab === "configuration" && config ? (
        <div className="panel">
          <div className="panel-head"><h3>Search configuration</h3></div>
          <form onSubmit={saveConfig}>
            <div className="mf-fields">
              <label className="field">
                <span>Enabled</span>
                <select value={config.enabled ? "yes" : "no"} onChange={(e) => setConfig({ ...config, enabled: e.target.value === "yes" })}>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
              <label className="field">
                <span>Default scope</span>
                <select value={config.default_scope} onChange={(e) => setConfig({ ...config, default_scope: e.target.value })}>
                  {["tenant", "organization", "global"].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Default sort</span>
                <select value={config.default_sort} onChange={(e) => setConfig({ ...config, default_sort: e.target.value })}>
                  {["relevance", "modified", "created", "title", "type", "owner"].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Page size</span>
                <input type="number" value={config.page_size} onChange={(e) => setConfig({ ...config, page_size: e.target.value })} />
              </label>
              <label className="field">
                <span>Max results</span>
                <input type="number" value={config.max_results} onChange={(e) => setConfig({ ...config, max_results: e.target.value })} />
              </label>
              <label className="field">
                <span>Min query length</span>
                <input type="number" value={config.min_query_length} onChange={(e) => setConfig({ ...config, min_query_length: e.target.value })} />
              </label>
              <label className="field">
                <span>Max query length</span>
                <input type="number" value={config.max_query_length} onChange={(e) => setConfig({ ...config, max_query_length: e.target.value })} />
              </label>
              <label className="field">
                <span>History retention (days)</span>
                <input
                  type="number"
                  value={config.history_retention_days}
                  onChange={(e) => setConfig({ ...config, history_retention_days: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Highlight</span>
                <select value={config.highlight ? "yes" : "no"} onChange={(e) => setConfig({ ...config, highlight: e.target.value === "yes" })}>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
              <label className="field">
                <span>Fuzzy matching</span>
                <select value={config.fuzzy ? "yes" : "no"} onChange={(e) => setConfig({ ...config, fuzzy: e.target.value === "yes" })}>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
              <label className="field">
                <span>Index files</span>
                <select value={config.index_files ? "yes" : "no"} onChange={(e) => setConfig({ ...config, index_files: e.target.value === "yes" })}>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
            </div>
            <button className="btn" type="submit" style={{ marginTop: 8 }}>Save configuration</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
