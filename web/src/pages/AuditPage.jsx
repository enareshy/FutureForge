import React, { useCallback, useEffect, useState } from "react";
import { audit } from "../api.js";
import AuditTimeline from "../components/AuditTimeline.jsx";
import AuditEventDrawer from "../components/AuditEventDrawer.jsx";
import AuditPolicyPanel from "../components/AuditPolicyPanel.jsx";
import AuditRetentionPanel from "../components/AuditRetentionPanel.jsx";
import AuditRetentionPolicyPanel from "../components/AuditRetentionPolicyPanel.jsx";
import AuditCategoryPanel from "../components/AuditCategoryPanel.jsx";
import AuditMetricsPanel from "../components/AuditMetricsPanel.jsx";
import AuditHistoryPanel from "../components/AuditHistoryPanel.jsx";
import AuditExportsPanel from "../components/AuditExportsPanel.jsx";
import AuditActionTypePanel from "../components/AuditActionTypePanel.jsx";

const EMPTY_FILTERS = {
  q: "",
  action: "",
  eventType: "",
  category: "",
  actorType: "",
  securityClassification: "",
  objectType: "",
  actorUsername: "",
  status: "",
  from: "",
  to: "",
};

const TABS = [
  ["events", "Event stream"],
  ["overview", "Overview"],
  ["metrics", "Metrics"],
  ["security", "Security"],
  ["workflow", "Workflow"],
  ["lifecycle", "Lifecycle"],
  ["configuration", "Configuration"],
  ["history", "Object history"],
  ["exports", "Exports"],
  ["retention", "Retention"],
  ["action-types", "Action types"],
  ["policies", "Policies"],
];

function toQuery(filters, page, pageSize = 25) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return `?${params.toString()}`;
}

function dayLabel(day) {
  return day ? String(day).slice(5) : "";
}

export default function AuditPage() {
  const [tab, setTab] = useState("events");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [summary, setSummary] = useState(null);
  const [facets, setFacets] = useState({ actions: [], event_types: [], sources: [] });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [exporting, setExporting] = useState("");
  const [savedFilters, setSavedFilters] = useState([]);
  const [filterName, setFilterName] = useState("");

  const loadSavedFilters = useCallback(async () => {
    try {
      const res = await audit.filters("?scope=events");
      setSavedFilters(res.items || []);
    } catch {
      /* saved filters are best-effort */
    }
  }, []);

  useEffect(() => {
    loadSavedFilters();
  }, [loadSavedFilters]);

  async function saveFilter() {
    if (!filterName.trim()) return;
    setError("");
    try {
      await audit.createFilter({ name: filterName.trim(), scope: "events", filters });
      setFilterName("");
      await loadSavedFilters();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteFilter(id) {
    try {
      await audit.deleteFilter(id);
      await loadSavedFilters();
    } catch (err) {
      setError(err.message);
    }
  }

  const loadEvents = useCallback(async (targetPage = page) => {
    setLoading(true);
    setError("");
    try {
      const res = await audit.events(toQuery(filters, targetPage));
      setData(res);
      setDenied(false);
    } catch (err) {
      if (err.status === 403) {
        setDenied(true);
        setData({ items: [], total: 0, page: 1, pageSize: 25 });
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  const loadSummary = useCallback(async () => {
    try {
      const [summaryRes, facetRes] = await Promise.all([
        audit.summary(toQuery(filters, 1, 1)),
        audit.facets(toQuery(filters, 1, 1)),
      ]);
      setSummary(summaryRes);
      setFacets(facetRes);
    } catch {
      /* summary is best-effort */
    }
  }, [filters]);

  useEffect(() => {
    loadEvents(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filters]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  async function open(event) {
    setSelected(event);
    setDetail(null);
    try {
      setDetail(await audit.event(event.id));
    } catch {
      setDetail(event);
    }
  }

  function applyFilters(e) {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  async function exportAs(format) {
    setExporting(format);
    setError("");
    try {
      const result = await audit.exportEvents({ format, filters, q: filters.q });
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting("");
    }
  }

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 25)));

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Compliance</div>
          <h1>Audit &amp; history</h1>
          <div className="sub">Immutable record of who did what, when, and to which object.</div>
        </div>
        {!denied ? (
          <div className="inline">
            <button className="btn secondary" type="button" disabled={!!exporting} onClick={() => exportAs("csv")}>
              {exporting === "csv" ? "Exporting…" : "Export CSV"}
            </button>
            <button className="btn secondary" type="button" disabled={!!exporting} onClick={() => exportAs("excel")}>
              {exporting === "excel" ? "Exporting…" : "Export Excel"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {denied ? (
        <div className="panel audit-empty">
          You do not have permission to read audit events. Ask an administrator for the audit event permission.
        </div>
      ) : null}

      {!denied && tab === "overview" ? (
        <>
          <div className="grid">
            <div className="stat"><span className="muted">Total events</span><b>{summary?.total ?? "—"}</b></div>
            <div className="stat"><span className="muted">Success</span><b>{summary?.success ?? "—"}</b></div>
            <div className="stat"><span className="muted">Failures</span><b>{summary?.failure ?? "—"}</b></div>
            <div className="stat"><span className="muted">Denied</span><b>{summary?.denied ?? "—"}</b></div>
          </div>

          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <h3>Events by type</h3>
              <div className="chips">
                {(summary?.by_type || []).map((row) => (
                  <span className="chip" key={row.event_type || "none"}>{row.event_type || "none"}: {row.count}</span>
                ))}
                {!summary?.by_type?.length ? <span className="muted">No data</span> : null}
              </div>
              <h3 style={{ marginTop: 16 }}>Activity by day</h3>
              <div className="audit-bars">
                {(summary?.by_day || []).map((row) => {
                  const max = Math.max(...(summary.by_day || []).map((d) => d.count), 1);
                  return (
                    <div className="audit-bar" key={row.day} title={`${row.day}: ${row.count}`}>
                      <span style={{ height: `${Math.round((row.count / max) * 100)}%` }} />
                      <i>{dayLabel(row.day)}</i>
                    </div>
                  );
                })}
                {!summary?.by_day?.length ? <span className="muted">No data</span> : null}
              </div>
            </div>
            <div className="panel">
              <h3>Top actors</h3>
              <table>
                <tbody>
                  {(summary?.top_actors || []).map((row) => (
                    <tr key={`${row.actor_id}-${row.actor_username}`}>
                      <td>{row.actor_username || "system"}</td>
                      <td style={{ textAlign: "right" }}>{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 style={{ marginTop: 16 }}>Top objects</h3>
              <table>
                <tbody>
                  {(summary?.top_objects || []).map((row) => (
                    <tr key={`${row.resource_type}-${row.resource_id}`}>
                      <td className="mono">{row.resource_type} #{row.resource_id}</td>
                      <td style={{ textAlign: "right" }}>{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {!denied && tab === "events" ? (
        <>
          <form className="panel" onSubmit={applyFilters}>
            <div className="row">
              <label className="field grow"><span>Search</span>
                <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="actor, object, action, details…" />
              </label>
              <label className="field"><span>Action</span>
                <input value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="object.update" list="audit-actions" />
                <datalist id="audit-actions">
                  {(facets.actions || []).map((row) => <option key={row.action} value={row.action} />)}
                </datalist>
              </label>
              <label className="field"><span>Event type</span>
                <select value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })}>
                  <option value="">Any</option>
                  {(facets.event_types || []).filter((r) => r.event_type).map((row) => (
                    <option key={row.event_type} value={row.event_type}>{row.event_type}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Status</span>
                <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                  <option value="">Any</option>
                  <option value="success">success</option>
                  <option value="failure">failure</option>
                  <option value="denied">denied</option>
                </select>
              </label>
              <label className="field"><span>Category</span>
                <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                  <option value="">Any</option>
                  {(facets.categories || []).filter((r) => r.category).map((row) => (
                    <option key={row.category} value={row.category}>{row.category}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Actor type</span>
                <select value={draft.actorType} onChange={(e) => setDraft({ ...draft, actorType: e.target.value })}>
                  <option value="">Any</option>
                  {(facets.actor_types || []).filter((r) => r.actor_type).map((row) => (
                    <option key={row.actor_type} value={row.actor_type}>{row.actor_type}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Classification</span>
                <select value={draft.securityClassification} onChange={(e) => setDraft({ ...draft, securityClassification: e.target.value })}>
                  <option value="">Any</option>
                  <option value="public">public</option>
                  <option value="internal">internal</option>
                  <option value="confidential">confidential</option>
                  <option value="restricted">restricted</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field grow"><span>Object type</span>
                <input value={draft.objectType} onChange={(e) => setDraft({ ...draft, objectType: e.target.value })} placeholder="object, part, user…" />
              </label>
              <label className="field grow"><span>Actor</span>
                <input value={draft.actorUsername} onChange={(e) => setDraft({ ...draft, actorUsername: e.target.value })} />
              </label>
              <label className="field"><span>From</span>
                <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </label>
              <label className="field"><span>To</span>
                <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </label>
              <button className="btn" type="submit">Apply</button>
              <button className="btn ghost" type="button" onClick={resetFilters}>Reset</button>
            </div>
          </form>

          <div className="panel audit-saved-filters">
            <div className="row" style={{ alignItems: "flex-end", marginBottom: 0 }}>
              <label className="field grow">
                <span>Saved filters</span>
                <input value={filterName} onChange={(e) => setFilterName(e.target.value)} placeholder="Name this filter…" />
              </label>
              <button className="btn secondary" type="button" onClick={saveFilter} disabled={!filterName.trim()}>Save current</button>
            </div>
            {savedFilters.length ? (
              <div className="chips" style={{ marginTop: 8 }}>
                {savedFilters.map((row) => (
                  <span className="chip" key={row.id}>
                    <button
                      className="link"
                      type="button"
                      onClick={() => {
                        setDraft({ ...EMPTY_FILTERS, ...row.filters });
                        setFilters({ ...EMPTY_FILTERS, ...row.filters });
                        setPage(1);
                      }}
                    >
                      {row.name}
                    </button>
                    <button className="link muted" type="button" onClick={() => deleteFilter(row.id)} title="Delete">remove</button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="panel">
            {loading && !data.items.length ? <div className="audit-empty">Loading events…</div> : null}
            <AuditTimeline events={data.items} selectedId={selected?.id} onSelect={open} />
            {data.total > data.pageSize ? (
              <div className="pager">
                <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span>Page {page} of {totalPages} · {data.total} events</span>
                <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            ) : (
              <div className="pager"><span>{data.total} events</span></div>
            )}
          </div>
        </>
      ) : null}

      {!denied && tab === "policies" ? <AuditPolicyPanel /> : null}
      {!denied && tab === "retention" ? (
        <>
          <AuditRetentionPolicyPanel />
          <AuditRetentionPanel />
        </>
      ) : null}
      {!denied && tab === "metrics" ? <AuditMetricsPanel /> : null}
      {!denied && tab === "security" ? (
        <AuditCategoryPanel kind="security" hint="Authentication, authorization, access denials and sensitive security events." />
      ) : null}
      {!denied && tab === "workflow" ? (
        <AuditCategoryPanel kind="workflow" hint="Workflow starts, approvals, rejections, task assignment and completion." />
      ) : null}
      {!denied && tab === "lifecycle" ? (
        <AuditCategoryPanel kind="lifecycle" hint="Lifecycle transitions and state changes across managed objects." />
      ) : null}
      {!denied && tab === "configuration" ? (
        <AuditCategoryPanel kind="configuration" hint="Configuration, administration and integration changes." />
      ) : null}
      {!denied && tab === "history" ? <AuditHistoryPanel /> : null}
      {!denied && tab === "exports" ? <AuditExportsPanel /> : null}
      {!denied && tab === "action-types" ? <AuditActionTypePanel /> : null}

      {selected ? <AuditEventDrawer event={detail || selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
