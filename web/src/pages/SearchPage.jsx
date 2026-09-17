import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { search } from "../api.js";

const EMPTY_FILTERS = {
  object_types: [],
  statuses: [],
  lifecycle_states: [],
  classification: "",
  tags: "",
  sort: "relevance",
  scope: "tenant",
};

function TypeBadge({ type }) {
  const tone = type === "file" ? "inactive" : "active";
  return <span className={`badge ${tone}`}>{type}</span>;
}

function html(value) {
  return { __html: value || "" };
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [text, setText] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [includeFacets, setIncludeFacets] = useState(true);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveForm, setSaveForm] = useState({ name: "", description: "", sharing_scope: "private" });
  const [exports, setExports] = useState([]);
  const criteria = useRef({ text: "", filters: EMPTY_FILTERS });
  const suggestTimer = useRef(null);

  const criteriaPayload = useCallback(
    (override = {}) => {
      const next = {
        text: override.text ?? criteria.current.text,
        filters: override.filters ?? criteria.current.filters,
        page: override.page ?? 1,
        page_size: override.page_size ?? pageSize,
      };
      const payload = {
        text: next.text || undefined,
        object_types: next.filters.object_types.length ? next.filters.object_types : undefined,
        statuses: next.filters.statuses.length ? next.filters.statuses : undefined,
        lifecycle_states: next.filters.lifecycle_states.length ? next.filters.lifecycle_states : undefined,
        classification: next.filters.classification || undefined,
        tags: next.filters.tags || undefined,
        sort: next.filters.sort,
        scope: next.filters.scope,
        page: next.page,
        page_size: next.page_size,
      };
      if (includeFacets && next.page === 1) payload.include_facets = true;
      return payload;
    },
    [includeFacets, pageSize]
  );

  const loadSaved = useCallback(() => {
    search.saved().then((res) => setSaved(res.items || [])).catch(() => setSaved([]));
  }, []);

  const loadHistory = useCallback(() => {
    search.history("?limit=12").then((res) => setHistory(res.items || [])).catch(() => setHistory([]));
  }, []);

  const loadExports = useCallback(() => {
    search.exports().then((res) => setExports(res.items || [])).catch(() => setExports([]));
  }, []);

  const runSearch = useCallback(
    async (override = {}) => {
      if (override.text !== undefined) criteria.current.text = override.text;
      if (override.filters !== undefined) criteria.current.filters = override.filters;
      const searchText = criteria.current.text;
      const searchFilters = criteria.current.filters;
      if (!searchText && !searchFilters.object_types.length && !searchFilters.statuses.length && !searchFilters.tags) {
        setResult(null);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const payload = criteriaPayload(override);
        const res = await search.global(payload);
        setResult(res);
        setPage(res.page || 1);
        loadHistory();
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [criteriaPayload, loadHistory]
  );

  useEffect(() => {
    search.meta().then(setMeta).catch((err) => setError(err.message));
    loadSaved();
    loadHistory();
    loadExports();
  }, [loadSaved, loadHistory, loadExports]);

  function onSuggest(value) {
    setText(value);
    criteria.current.text = value;
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    suggestTimer.current = setTimeout(() => {
      search
        .suggestions(`?q=${encodeURIComponent(value)}&limit=8`)
        .then((res) => {
          setSuggestions(res.suggestions || []);
          setSuggestOpen(true);
        })
        .catch(() => setSuggestions([]));
    }, 180);
  }

  function submit(e) {
    e?.preventDefault();
    setSuggestOpen(false);
    runSearch({ text, filters });
  }

  function setFilter(patch) {
    const next = { ...criteria.current.filters, ...patch };
    setFilters(next);
    criteria.current.filters = next;
    runSearch({ filters: next });
  }

  function toggleArrayFilter(key, value) {
    const current = criteria.current.filters[key] || [];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    setFilter({ [key]: next });
  }

  function applyFacet(field, value) {
    if (field === "object_type") return toggleArrayFilter("object_types", value);
    if (field === "status") return toggleArrayFilter("statuses", value);
    if (field === "lifecycle_state") return toggleArrayFilter("lifecycle_states", value);
    if (field === "tags") {
      const current = String(criteria.current.filters.tags || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
      return setFilter({ tags: next.join(",") });
    }
    if (field === "classification") {
      const next = criteria.current.filters.classification === value ? "" : value;
      return setFilter({ classification: next });
    }
    return undefined;
  }

  function openResult(item) {
    if (item.object_type === "file") {
      navigate(`/files/${encodeURIComponent(item.code || item.object_uuid)}`);
    } else {
      navigate(`/objects/${encodeURIComponent(item.object_uuid || item.object_id)}`);
    }
  }

  async function saveCurrent() {
    try {
      await search.createSaved({
        name: saveForm.name || text || "Saved search",
        description: saveForm.description,
        sharing_scope: saveForm.sharing_scope,
        query: {
          text: criteria.current.text,
          object_types: criteria.current.filters.object_types,
          statuses: criteria.current.filters.statuses,
          lifecycle_states: criteria.current.filters.lifecycle_states,
          classification: criteria.current.filters.classification || undefined,
          tags: criteria.current.filters.tags ? criteria.current.filters.tags.split(",") : undefined,
          sort: criteria.current.filters.sort,
          scope: criteria.current.filters.scope,
        },
      });
      setSaveOpen(false);
      setSaveForm({ name: "", description: "", sharing_scope: "private" });
      setNotice("Search saved.");
      loadSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function runSavedSearch(item) {
    const query = item.query || {};
    const nextFilters = {
      ...EMPTY_FILTERS,
      object_types: query.object_types || [],
      statuses: query.statuses || [],
      lifecycle_states: query.lifecycle_states || [],
      classification: query.classification || "",
      tags: Array.isArray(query.tags) ? query.tags.join(",") : query.tags || "",
      sort: query.sort || "relevance",
      scope: query.scope || "tenant",
    };
    setText(query.text || "");
    setFilters(nextFilters);
    criteria.current = { text: query.text || "", filters: nextFilters };
    await runSearch({ text: query.text || "", filters: nextFilters });
    try {
      await search.runSaved(item.uuid, {});
    } catch {
      /* running via the plain search endpoint is sufficient */
    }
  }

  async function removeSaved(reference) {
    try {
      await search.deleteSaved(reference);
      loadSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function requestExport(format) {
    try {
      const created = await search.createExport({
        name: `${criteria.current.text || "Search"} export`,
        format,
        query: criteriaPayload({ page: 1 }),
      });
      setNotice(`Export ${created.format.toUpperCase()} queued (${created.status}).`);
      loadExports();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearHistory() {
    try {
      await search.clearHistory(true);
      loadHistory();
    } catch (err) {
      setError(err.message);
    }
  }

  const facetMap = useMemo(() => {
    const map = {};
    for (const facet of result?.facets || []) map[facet.field] = facet.values || [];
    return map;
  }, [result]);

  const activeFilterCount =
    filters.object_types.length +
    filters.statuses.length +
    filters.lifecycle_states.length +
    (filters.classification ? 1 : 0) +
    (filters.tags ? 1 : 0);

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Search &amp; Discovery</h1>
          <div className="crumbs">Search across every registered object type, document and relationship.</div>
        </div>
        <div className="inline">
          <button className="btn ghost" type="button" onClick={() => requestExport("csv")}>Export CSV</button>
          <button className="btn ghost" type="button" onClick={() => requestExport("json")}>Export JSON</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="badge active" style={{ marginBottom: 12 }}>{notice}</div> : null}

      <form className="panel" onSubmit={submit}>
        <div className="row" style={{ position: "relative" }}>
          <label className="field grow">
            <span>Search query</span>
            <input
              value={text}
              placeholder="Search titles, codes, metadata, relationships…"
              onChange={(e) => onSuggest(e.target.value)}
              onFocus={() => suggestions.length && setSuggestOpen(true)}
            />
          </label>
          <button className="btn" type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
          <button className="btn ghost" type="button" onClick={() => setSaveOpen(!saveOpen)}>Save search</button>
        </div>

        {suggestOpen && suggestions.length ? (
          <div className="suggestions">
            {suggestions.map((item, index) => (
              <button
                key={`${item.type}-${item.text}-${index}`}
                type="button"
                className="suggestion"
                onClick={() => {
                  setSuggestOpen(false);
                  setText(item.text);
                  runSearch({ text: item.text });
                }}
              >
                <span dangerouslySetInnerHTML={html(item.highlighted || item.text)} />
                <span className="mono">{item.type}{item.object_type ? ` · ${item.object_type}` : ""}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 6 }}>
          <label className="field">
            <span>Sort</span>
            <select value={filters.sort} onChange={(e) => setFilter({ sort: e.target.value })}>
              {(meta?.sorts || ["relevance", "modified", "created", "title", "type", "owner"]).map((sort) => (
                <option key={sort} value={sort}>{sort}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Scope</span>
            <select value={filters.scope} onChange={(e) => setFilter({ scope: e.target.value })}>
              {(meta?.scopes || ["tenant", "organization", "global"]).map((scope) => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Page size</span>
            <select
              value={pageSize}
              onChange={(e) => {
                const value = Number(e.target.value);
                setPageSize(value);
                runSearch({ page_size: value });
              }}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Types</span>
            <div className="chips">
              {(meta?.object_types || []).map((type) => (
                <button
                  key={type.code}
                  type="button"
                  className={`chip ${filters.object_types.includes(type.code) ? "active" : ""}`}
                  onClick={() => toggleArrayFilter("object_types", type.code)}
                >
                  {type.name || type.code}
                </button>
              ))}
            </div>
          </label>
          <label className="field grow">
            <span>Tags (comma separated)</span>
            <input value={filters.tags} onChange={(e) => setFilter({ tags: e.target.value })} />
          </label>
          <label className="field">
            <span>Facets</span>
            <select value={includeFacets ? "on" : "off"} onChange={(e) => setIncludeFacets(e.target.value === "on")}>
              <option value="on">enabled</option>
              <option value="off">disabled</option>
            </select>
          </label>
        </div>

        {saveOpen ? (
          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-head"><h3>Save this search</h3></div>
            <div className="row">
              <label className="field grow">
                <span>Name</span>
                <input value={saveForm.name} onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })} />
              </label>
              <label className="field grow">
                <span>Description</span>
                <input value={saveForm.description} onChange={(e) => setSaveForm({ ...saveForm, description: e.target.value })} />
              </label>
              <label className="field">
                <span>Sharing</span>
                <select
                  value={saveForm.sharing_scope}
                  onChange={(e) => setSaveForm({ ...saveForm, sharing_scope: e.target.value })}
                >
                  <option value="private">private</option>
                  <option value="organization">organization</option>
                  <option value="tenant">tenant</option>
                </select>
              </label>
              <button className="btn" type="button" onClick={saveCurrent}>Save</button>
            </div>
          </div>
        ) : null}
      </form>

      <div className="search-layout" style={{ marginTop: 16 }}>
        <div>
          {result ? (
            <>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <div className="mono">
                  {result.total} result{result.total === 1 ? "" : "s"} · page {result.page} of {result.pages}
                  {activeFilterCount ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}` : ""}
                </div>
                {result.took_ms !== undefined ? <div className="mono">{result.took_ms} ms</div> : null}
              </div>
              <div className="result-list">
                {(result.items || []).map((item) => (
                  <div className="result-card" key={`${item.object_type}-${item.object_id}`}>
                    <div className="result-main" onClick={() => openResult(item)}>
                      <div className="result-title" dangerouslySetInnerHTML={html(item.highlights?.title || item.title)} />
                      <div className="result-sub">
                        <TypeBadge type={item.object_type} />
                        <span className="mono">{item.code || item.object_id}</span>
                        {item.status ? <span className="badge inactive">{item.status}</span> : null}
                        {item.classification ? <span className="badge inactive">{item.classification}</span> : null}
                        {item.score !== null && item.score !== undefined ? (
                          <span className="mono">score {Number(item.score).toFixed(1)}</span>
                        ) : null}
                      </div>
                      {item.summary ? (
                        <div className="result-summary" dangerouslySetInnerHTML={html(item.highlights?.summary || item.summary)} />
                      ) : null}
                      {item.tags?.length ? (
                        <div className="chips" style={{ marginTop: 6 }}>
                          {item.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!(result.items || []).length ? <p className="sub">No matching records.</p> : null}
              </div>
              <div className="pager">
                <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => runSearch({ page: page - 1 })}>
                  Previous
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={page >= (result.pages || 1)}
                  onClick={() => runSearch({ page: page + 1 })}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <div className="panel">
              <p className="sub">Enter a query or pick an object type to begin searching.</p>
            </div>
          )}
        </div>

        <div className="search-aside">
          {result?.facets?.length ? (
            <div className="panel">
              <div className="panel-head"><h3>Facets</h3></div>
              {result.facets.map((facet) => (
                <div className="facet-group" key={facet.field}>
                  <div className="facet-title">{facet.field.replace(/_/g, " ")}</div>
                  {facet.values.map((value) => (
                    <button
                      key={`${facet.field}-${value.value}`}
                      type="button"
                      className="facet-value"
                      onClick={() => applyFacet(facet.field, value.value)}
                    >
                      <span>{value.value}</span>
                      <span className="mono">{value.count}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-head"><h3>Saved searches</h3></div>
            {saved.length ? (
              <div className="stack">
                {saved.map((item) => (
                  <div className="stack-row" key={item.uuid}>
                    <button type="button" className="link-btn" onClick={() => runSavedSearch(item)}>{item.name}</button>
                    <button type="button" className="btn ghost" onClick={() => removeSaved(item.uuid)}>Delete</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sub">No saved searches yet.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Recent searches</h3>
              <button className="btn ghost" type="button" onClick={clearHistory}>Clear</button>
            </div>
            {history.length ? (
              <div className="stack">
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setText(item.query);
                      runSearch({ text: item.query });
                    }}
                  >
                    {item.query || "(filtered)"}
                    <span className="mono">{item.result_count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="sub">No search history yet.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Exports</h3></div>
            {exports.length ? (
              <div className="stack">
                {exports.map((item) => (
                  <div className="stack-row" key={item.uuid}>
                    <span className="mono">{item.name}</span>
                    <span className="badge inactive">{item.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sub">No exports requested.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
