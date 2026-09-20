import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { searchFoundation as sf } from "../api.js";

// Enterprise Search Foundation console. Exercises the canonical, provider-
// independent /api/v1/search contract: global keyword search, structured
// filters with explicit operators, effectivity context, facets, saved searches,
// history and index administration.

const OPERATOR_LABELS = {
  EQ: "=",
  NE: "≠",
  GT: ">",
  GTE: "≥",
  LT: "<",
  LTE: "≤",
  CONTAINS: "contains",
  STARTS_WITH: "starts with",
  ENDS_WITH: "ends with",
  WILDCARD: "wildcard",
  IN: "in",
  NOT_IN: "not in",
  IS_NULL: "is empty",
  IS_NOT_NULL: "is not empty",
  BETWEEN: "between",
};

function parseValue(filter) {
  const raw = filter.value;
  if (["IS_NULL", "IS_NOT_NULL"].includes(filter.operator)) return null;
  if (["IN", "NOT_IN", "BETWEEN"].includes(filter.operator)) {
    return String(raw || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (filter.dataType === "number") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  if (filter.dataType === "boolean") return String(raw).toLowerCase() === "true";
  return raw;
}

function html(value) {
  return { __html: value || "" };
}

export default function SearchFoundationPage() {
  const [meta, setMeta] = useState(null);
  const [objects, setObjects] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [text, setText] = useState("");
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [filters, setFilters] = useState([]);
  const [booleanOp, setBooleanOp] = useState("and");
  const [sortField, setSortField] = useState("");
  const [sortDir, setSortDir] = useState("ASC");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [effectivity, setEffectivity] = useState({ asOfDate: "", plant: "", model: "" });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [saveName, setSaveName] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [indexStatus, setIndexStatus] = useState(null);
  const [failureList, setFailureList] = useState([]);
  const [rebuildScope, setRebuildScope] = useState("full");
  const [rebuildType, setRebuildType] = useState("");
  const [rebuildOrg, setRebuildOrg] = useState("");
  const [textObject, setTextObject] = useState({ objectType: "content", objectId: "", text: "" });
  const suggestTimer = useRef(null);

  const loadSaved = useCallback(() => {
    sf.saved().then((res) => setSaved(res.savedSearches || [])).catch(() => setSaved([]));
  }, []);

  const loadHistory = useCallback(() => {
    sf.history("?limit=12").then((res) => setHistory(res.history || [])).catch(() => setHistory([]));
  }, []);

  const loadIndex = useCallback(() => {
    sf.indexStatus()
      .then((res) => {
        setIndexStatus(res.status || null);
        setFailureList(res.failures || []);
      })
      .catch(() => setIndexStatus(null));
  }, []);

  useEffect(() => {
    sf.meta().then(setMeta).catch((err) => setError(err.message));
    sf.objects()
      .then((res) => setObjects(res.objects || []))
      .catch(() => setObjects([]));
    loadSaved();
    loadHistory();
  }, [loadSaved, loadHistory]);

  const facetFields = useMemo(
    () => ["object_type", "status", "classification"].filter(Boolean),
    []
  );

  useEffect(() => {
    const code = selectedTypes[0] || objects[0]?.code;
    if (!code) return;
    sf.object(code)
      .then((res) => setCatalog(res.fields || []))
      .catch(() => setCatalog([]));
  }, [selectedTypes, objects]);

  function buildQuery(overrides = {}) {
    const cleanFilters = filters
      .filter((filter) => filter.field && filter.operator)
      .map((filter) => ({
        field: filter.field,
        operator: filter.operator,
        value: parseValue(filter),
      }));
    const query = {
      text: text || undefined,
      objectTypes: selectedTypes.length ? selectedTypes : undefined,
      filters: cleanFilters,
      sort: sortField ? [{ field: sortField, direction: sortDir }] : undefined,
      facets: facetFields,
      page: overrides.page ?? page,
      pageSize: overrides.pageSize ?? pageSize,
      highlight: true,
      ...overrides,
    };
    if (cleanFilters.length && booleanOp === "or") {
      query.condition = { operator: "or", filters: cleanFilters };
      query.filters = [];
    }
    const effectivityContext = {};
    for (const [key, value] of Object.entries(effectivity)) {
      if (value) effectivityContext[key] = value;
    }
    if (Object.keys(effectivityContext).length) query.effectivity = effectivityContext;
    return query;
  }

  const runSearch = useCallback(
    async (overrides = {}) => {
      setLoading(true);
      setError("");
      try {
        const res = await sf.search(buildQuery(overrides));
        setResult(res);
        setPage((res.page ?? 0) + 1);
        loadHistory();
      } catch (err) {
        setError(err.message);
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, selectedTypes, filters, booleanOp, sortField, sortDir, page, pageSize, effectivity, facetFields, loadHistory]
  );

  function onTextChange(value) {
    setText(value);
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    suggestTimer.current = setTimeout(() => {
      sf.suggestions(`?q=${encodeURIComponent(value)}&limit=8`)
        .then((res) => {
          setSuggestions(res.suggestions || []);
          setSuggestOpen(true);
        })
        .catch(() => setSuggestions([]));
    }, 180);
  }

  function submit(event) {
    event?.preventDefault();
    setSuggestOpen(false);
    runSearch({ page: 1 });
  }

  function toggleType(code) {
    setSelectedTypes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
    );
  }

  function addFilter() {
    const field = catalog.find((item) => item.filterable) || catalog[0];
    setFilters((current) => [
      ...current,
      {
        field: field?.field || "",
        dataType: field?.dataType || "string",
        operator: field?.allowedOperators?.[0] || "EQ",
        value: "",
      },
    ]);
  }

  function updateFilter(index, patch) {
    setFilters((current) =>
      current.map((filter, position) => {
        if (position !== index) return filter;
        const next = { ...filter, ...patch };
        if (patch.field !== undefined) {
          const definition = catalog.find((item) => item.field === patch.field);
          next.dataType = definition?.dataType || "string";
          next.operator = definition?.allowedOperators?.[0] || "EQ";
        }
        return next;
      })
    );
  }

  function removeFilter(index) {
    setFilters((current) => current.filter((_, position) => position !== index));
  }

  function operatorsFor(field) {
    return catalog.find((item) => item.field === field)?.allowedOperators || ["EQ", "CONTAINS"];
  }

  async function saveCurrent() {
    try {
      await sf.createSaved({
        name: saveName || text || "Saved search",
        query: buildQuery({ page: 1 }),
      });
      setSaveName("");
      setNotice("Search saved.");
      loadSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function runSaved(item) {
    try {
      const res = await sf.runSaved(item.uuid, {});
      setResult(res);
      setPage((res.page ?? 0) + 1);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeSaved(reference) {
    try {
      await sf.deleteSaved(reference);
      loadSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearHistory() {
    try {
      await sf.clearHistory(true);
      loadHistory();
    } catch (err) {
      setError(err.message);
    }
  }

  async function runRebuild() {
    try {
      const body = { scope: rebuildScope };
      if (rebuildType) body.objectType = rebuildType;
      if (rebuildOrg) body.organizationId = Number(rebuildOrg);
      const res = await sf.rebuild(body);
      setNotice(`Rebuild (${res.scope}) complete.`);
      loadIndex();
    } catch (err) {
      setError(err.message);
    }
  }

  async function retryFailed() {
    try {
      const res = await sf.retryFailed({});
      setNotice(`Requeued ${res.requeued ?? res.retried ?? 0} failure(s).`);
      loadIndex();
    } catch (err) {
      setError(err.message);
    }
  }

  async function ingestText() {
    try {
      await sf.putContentText({
        objectType: textObject.objectType,
        objectId: textObject.objectId,
        text: textObject.text,
        source: "manual",
      });
      setNotice("Extracted text indexed.");
      setTextObject({ objectType: textObject.objectType, objectId: "", text: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  const facets = result?.facets || [];

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>Enterprise Search</h1>
          <div className="crumbs">
            Provider-independent canonical search. Syntax: <span className="mono">status:RELEASED</span>,{" "}
            <span className="mono">name:Brake*</span>, <span className="mono">a AND (b OR c)</span>.
          </div>
        </div>
        <div className="inline">
          <button className="btn ghost" type="button" onClick={() => { setAdminOpen(!adminOpen); if (!adminOpen) loadIndex(); }}>
            {adminOpen ? "Hide admin" : "Index admin"}
          </button>
          <Link className="btn ghost" to="/search">Legacy search</Link>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="badge active" style={{ marginBottom: 12 }}>{notice}</div> : null}

      <form className="panel" onSubmit={submit}>
        <div className="row" style={{ position: "relative" }}>
          <label className="field grow">
            <span>Query</span>
            <input
              value={text}
              placeholder='e.g. compressor AND classification:internal'
              onChange={(event) => onTextChange(event.target.value)}
              onFocus={() => suggestions.length && setSuggestOpen(true)}
            />
          </label>
          <button className="btn" type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
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
                  runSearch({ text: item.text, page: 1 });
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
            <span>Boolean</span>
            <select value={booleanOp} onChange={(event) => setBooleanOp(event.target.value)}>
              <option value="and">all filters (AND)</option>
              <option value="or">any filter (OR)</option>
            </select>
          </label>
          <label className="field">
            <span>Sort field</span>
            <select value={sortField} onChange={(event) => setSortField(event.target.value)}>
              <option value="">relevance</option>
              {catalog.filter((field) => field.sortable).map((field) => (
                <option key={field.field} value={field.field}>{field.displayName || field.field}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Direction</span>
            <select value={sortDir} onChange={(event) => setSortDir(event.target.value)}>
              <option value="ASC">ascending</option>
              <option value="DESC">descending</option>
            </select>
          </label>
          <label className="field">
            <span>Page size</span>
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label className="field">
            <span>As of</span>
            <input type="date" value={effectivity.asOfDate} onChange={(event) => setEffectivity({ ...effectivity, asOfDate: event.target.value })} />
          </label>
          <label className="field">
            <span>Plant</span>
            <input value={effectivity.plant} onChange={(event) => setEffectivity({ ...effectivity, plant: event.target.value })} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={effectivity.model} onChange={(event) => setEffectivity({ ...effectivity, model: event.target.value })} />
          </label>
        </div>

        <div className="row" style={{ marginTop: 6 }}>
          <label className="field grow">
            <span>Object types</span>
            <div className="chips">
              {objects.map((type) => (
                <button
                  key={type.code}
                  type="button"
                  className={`chip ${selectedTypes.includes(type.code) ? "active" : ""}`}
                  onClick={() => toggleType(type.code)}
                >
                  {type.name || type.code}
                </button>
              ))}
            </div>
          </label>
        </div>

        <div className="panel" style={{ marginTop: 10 }}>
          <div className="panel-head">
            <h3>Structured filters</h3>
            <button className="btn ghost" type="button" onClick={addFilter}>Add filter</button>
          </div>
          {filters.map((filter, index) => (
            <div className="row" key={index}>
              <label className="field grow">
                <span>Field</span>
                <select value={filter.field} onChange={(event) => updateFilter(index, { field: event.target.value })}>
                  {catalog.filter((field) => field.filterable).map((field) => (
                    <option key={field.field} value={field.field}>{field.displayName || field.field}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Operator</span>
                <select value={filter.operator} onChange={(event) => updateFilter(index, { operator: event.target.value })}>
                  {operatorsFor(filter.field).map((operator) => (
                    <option key={operator} value={operator}>{OPERATOR_LABELS[operator] || operator}</option>
                  ))}
                </select>
              </label>
              {!["IS_NULL", "IS_NOT_NULL"].includes(filter.operator) ? (
                <label className="field grow">
                  <span>Value</span>
                  <input value={filter.value} onChange={(event) => updateFilter(index, { value: event.target.value })} />
                </label>
              ) : null}
              <button className="btn ghost" type="button" onClick={() => removeFilter(index)}>Remove</button>
            </div>
          ))}
          {!filters.length ? <p className="sub">No structured filters. Free-text query only.</p> : null}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <label className="field grow">
            <span>Save as</span>
            <input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Name this search" />
          </label>
          <button className="btn ghost" type="button" onClick={saveCurrent}>Save search</button>
        </div>
      </form>

      {adminOpen ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h3>Index administration</h3></div>
          <div className="row">
            <div className="field">
              <span>Documents</span>
              <div className="mono">{indexStatus?.documents_total ?? "—"}</div>
            </div>
            <div className="field">
              <span>Pending</span>
              <div className="mono">{indexStatus?.queue?.pending ?? "—"}</div>
            </div>
            <div className="field">
              <span>Failed</span>
              <div className="mono">{indexStatus?.queue?.failed ?? "—"}</div>
            </div>
          </div>
          <div className="row">
            <label className="field">
              <span>Rebuild scope</span>
              <select value={rebuildScope} onChange={(event) => setRebuildScope(event.target.value)}>
                <option value="full">full / tenant</option>
                <option value="object_type">object type</option>
                <option value="organization">organization</option>
              </select>
            </label>
            {rebuildScope === "object_type" ? (
              <label className="field grow">
                <span>Object type</span>
                <input value={rebuildType} onChange={(event) => setRebuildType(event.target.value)} />
              </label>
            ) : null}
            {rebuildScope === "organization" ? (
              <label className="field grow">
                <span>Organization id</span>
                <input value={rebuildOrg} onChange={(event) => setRebuildOrg(event.target.value)} />
              </label>
            ) : null}
            <button className="btn" type="button" onClick={runRebuild}>Rebuild</button>
            <button className="btn ghost" type="button" onClick={retryFailed}>Retry failed</button>
          </div>
          {failureList.length ? (
            <div className="stack">
              {failureList.map((failure) => (
                <div className="stack-row" key={`${failure.object_type}-${failure.object_id}`}>
                  <span className="mono">{failure.object_type}:{failure.object_id}</span>
                  <span className="badge inactive">{failure.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="sub">No indexing failures.</p>
          )}

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-head"><h3>Index extracted text (content integration)</h3></div>
            <div className="row">
              <label className="field">
                <span>Object type</span>
                <input value={textObject.objectType} onChange={(event) => setTextObject({ ...textObject, objectType: event.target.value })} />
              </label>
              <label className="field grow">
                <span>Object id</span>
                <input value={textObject.objectId} onChange={(event) => setTextObject({ ...textObject, objectId: event.target.value })} />
              </label>
              <label className="field grow">
                <span>Extracted text</span>
                <input value={textObject.text} onChange={(event) => setTextObject({ ...textObject, text: event.target.value })} />
              </label>
              <button className="btn ghost" type="button" onClick={ingestText}>Index text</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="search-layout" style={{ marginTop: 16 }}>
        <div>
          {result ? (
            <>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <div className="mono">
                  {result.total} result{result.total === 1 ? "" : "s"} · page {page} of {result.pages || 1}
                  {result.tookMs !== undefined ? ` · ${result.tookMs} ms` : ""}
                </div>
                <div className="mono">{result.provider || "relational"}</div>
              </div>
              <div className="result-list">
                {(result.results || []).map((item) => (
                  <div className="result-card" key={`${item.objectType}-${item.objectId}`}>
                    <div className="result-main">
                      <div className="result-title" dangerouslySetInnerHTML={html(item.highlight?.title || item.title)} />
                      <div className="result-sub">
                        <span className="badge active">{item.objectType}</span>
                        <span className="mono">{item.code || item.objectId}</span>
                        {item.status ? <span className="badge inactive">{item.status}</span> : null}
                        {item.matchedFields?.length ? <span className="mono">matched: {item.matchedFields.join(", ")}</span> : null}
                      </div>
                      {item.description ? (
                        <div className="result-summary" dangerouslySetInnerHTML={html(item.highlight?.summary || item.description)} />
                      ) : null}
                    </div>
                  </div>
                ))}
                {!(result.results || []).length ? <p className="sub">No matching records.</p> : null}
              </div>
              <div className="pager">
                <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => runSearch({ page: page - 1 })}>Previous</button>
                <button className="btn ghost" type="button" disabled={page >= (result.pages || 1)} onClick={() => runSearch({ page: page + 1 })}>Next</button>
              </div>
            </>
          ) : (
            <div className="panel"><p className="sub">Run a query to see canonical results.</p></div>
          )}
        </div>

        <div className="search-aside">
          {facets.length ? (
            <div className="panel">
              <div className="panel-head"><h3>Facets</h3></div>
              {facets.map((facet) => (
                <div className="facet-group" key={facet.field}>
                  <div className="facet-title">{facet.name.replace(/_/g, " ")}</div>
                  {(facet.values || []).map((value) => (
                    <div className="facet-value" key={`${facet.field}-${value.value}`}>
                      <span>{value.value}</span>
                      <span className="mono">{value.count}</span>
                    </div>
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
                    <button type="button" className="link-btn" onClick={() => runSaved(item)}>{item.name}</button>
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
                    onClick={() => { setText(item.query); runSearch({ text: item.query, page: 1 }); }}
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

          {meta ? (
            <div className="panel">
              <div className="panel-head"><h3>Engine</h3></div>
              <div className="mono" style={{ lineHeight: 1.7 }}>
                <div>ranking: {(meta.rankingStrategies || []).join(", ")}</div>
                <div>semantic: {(meta.semanticProviders || []).join(", ") || "not configured"}</div>
                <div>effectivity: {(meta.effectivityResolvers || []).join(", ")}</div>
                <div>operators: {(meta.operators || []).length}</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
