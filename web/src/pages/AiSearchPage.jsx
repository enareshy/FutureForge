import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AiApiError, ai } from "../aiApi.js";
import { search as helixSearch } from "../api.js";

const MODES = [
  { value: "hybrid", label: "Hybrid (semantic + keyword)" },
  { value: "semantic", label: "Semantic" },
  { value: "lexical", label: "Keyword" },
];

const FILTER_FIELDS = [
  { field: "source_code", label: "Source code" },
  { field: "external_id", label: "External ID" },
  { field: "classification", label: "Classification" },
  { field: "document_status", label: "Document status" },
  { field: "mime_type", label: "MIME type" },
  { field: "product", label: "Product" },
  { field: "part_number", label: "Part number" },
  { field: "revision", label: "Revision" },
];

const EMPTY_FILTER_VALUES = {
  source_code: "",
  external_id: "",
  classification: "",
  document_status: "",
  mime_type: "",
  product: "",
  part_number: "",
  revision: "",
};

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function buildFilters(values) {
  return FILTER_FIELDS.filter(({ field }) => values[field]?.trim()).map(({ field }) => ({
    field,
    op: "eq",
    value: values[field].trim(),
  }));
}

function labelize(value) {
  return String(value || "").replace(/_/g, " ");
}

export default function AiSearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [sort, setSort] = useState("relevance");
  const [limit, setLimit] = useState(10);
  const [filterValues, setFilterValues] = useState(EMPTY_FILTER_VALUES);
  const [aiResult, setAiResult] = useState(null);
  const [helixResult, setHelixResult] = useState(null);
  const [aiError, setAiError] = useState("");
  const [helixError, setHelixError] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [health, setHealth] = useState(null);
  const [facets, setFacets] = useState(null);
  const [saved, setSaved] = useState([]);
  const [saveName, setSaveName] = useState("");
  const [duplicates, setDuplicates] = useState([]);
  const [scanSummary, setScanSummary] = useState(null);
  const [note, setNote] = useState("");
  const suggestTimer = useRef(null);

  const filters = useMemo(() => buildFilters(filterValues), [filterValues]);
  const activeFilterCount = filters.length;

  const loadSaved = useCallback(() => {
    ai.savedSearches({ limit: 20 })
      .then((page) => setSaved(page.items || []))
      .catch(() => setSaved([]));
  }, []);

  const loadDuplicates = useCallback(() => {
    ai.duplicates({ status: "open", limit: 5 })
      .then((page) => setDuplicates(page.items || []))
      .catch(() => setDuplicates([]));
  }, []);

  useEffect(() => {
    ai.searchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
    loadSaved();
    loadDuplicates();
  }, [loadSaved, loadDuplicates]);

  useEffect(() => {
    const term = query.trim();
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (term.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    suggestTimer.current = setTimeout(() => {
      ai.searchSuggestions({ q: term, limit: 6 })
        .then((res) => setSuggestions(res.suggestions || []))
        .catch(() => setSuggestions([]));
    }, 250);
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
    };
  }, [query]);

  const runSearch = useCallback(
    async (override = {}) => {
      const nextQuery = (override.query ?? query).trim();
      const nextMode = override.mode ?? mode;
      const nextSort = override.sort ?? sort;
      const nextLimit = override.limit ?? limit;
      const nextFilters = override.filters ?? filters;
      if (!nextQuery) {
        setAiResult(null);
        setHelixResult(null);
        return;
      }
      setLoading(true);
      setAiError("");
      setHelixError("");
      setNote("");
      setFacets(null);

      const aiPayload = {
        query: nextQuery,
        mode: nextMode,
        sort: nextSort,
        limit: nextLimit,
        page: 1,
        filters: nextFilters,
      };
      const helixPayload = {
        text: nextQuery,
        sort: "relevance",
        scope: "tenant",
        page: 1,
        page_size: nextLimit,
      };

      const [aiOutcome, helixOutcome] = await Promise.allSettled([
        ai.search(aiPayload),
        helixSearch.global(helixPayload),
      ]);

      if (aiOutcome.status === "fulfilled") {
        setAiResult(aiOutcome.value);
        const params = { q: nextQuery, mode: nextMode, limit: 50 };
        if (nextFilters.length) params.filters = JSON.stringify(nextFilters);
        ai.searchFacets(params)
          .then(setFacets)
          .catch(() => setFacets(null));
      } else {
        setAiResult(null);
        setAiError(describe(aiOutcome.reason));
      }

      if (helixOutcome.status === "fulfilled") {
        setHelixResult(helixOutcome.value);
      } else {
        setHelixResult(null);
        setHelixError(describe(helixOutcome.reason));
      }

      setLoading(false);
    },
    [query, mode, sort, limit, filters]
  );

  function submit(event) {
    event.preventDefault();
    runSearch();
  }

  async function saveCurrent(event) {
    event.preventDefault();
    const name = saveName.trim();
    if (!name || !query.trim()) return;
    setNote("");
    try {
      await ai.createSavedSearch({
        name,
        query: query.trim(),
        mode,
        sort,
        filters,
      });
      setSaveName("");
      loadSaved();
      setNote("Search saved.");
    } catch (err) {
      setNote(describe(err));
    }
  }

  function applySaved(item) {
    setQuery(item.query);
    setMode(item.mode);
    setSort(item.sort);
    const values = { ...EMPTY_FILTER_VALUES };
    for (const filter of item.filters || []) {
      if (filter.field in values && typeof filter.value === "string") {
        values[filter.field] = filter.value;
      }
    }
    setFilterValues(values);
    runSearch({
      query: item.query,
      mode: item.mode,
      sort: item.sort,
      filters: item.filters || [],
    });
  }

  async function removeSaved(item) {
    if (!window.confirm(`Delete saved search "${item.name}"?`)) return;
    try {
      await ai.deleteSavedSearch(item.id);
      loadSaved();
    } catch (err) {
      setNote(describe(err));
    }
  }

  async function scanForDuplicates() {
    setNote("");
    try {
      const summary = await ai.scanDuplicates();
      setScanSummary(summary);
      loadDuplicates();
    } catch (err) {
      setNote(describe(err));
    }
  }

  async function dismissFinding(finding) {
    try {
      await ai.reviewDuplicate(finding.id, { status: "dismissed", note: "Dismissed in console" });
      loadDuplicates();
    } catch (err) {
      setNote(describe(err));
    }
  }

  const aiResults = aiResult?.results || [];
  const helixResults = helixResult?.items || [];

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>AI search &amp; knowledge intelligence</h1>
          <p className="sub">
            Authorized search across the AI knowledge corpus, with facets, freshness and
            duplicate review. Helix enterprise records are shown alongside AI results but
            are ranked independently.
          </p>
        </div>
        <Link className="button" to="/ai/knowledge">Knowledge sources</Link>
      </header>

      {health ? (
        <div className="card">
          <div className="inline" style={{ justifyContent: "space-between" }}>
            <strong>Index health</strong>
            <span className={`badge ${health.status === "ok" ? "active" : "inactive"}`}>
              {health.status}
            </span>
          </div>
          <div className="grid" style={{ marginTop: 10 }}>
            <div><div className="sub">Documents</div><div className="mono">{health.documents.total}</div></div>
            <div><div className="sub">Indexed</div><div className="mono">{health.documents.indexed}</div></div>
            <div><div className="sub">Stale</div><div className="mono">{health.documents.stale}</div></div>
            <div><div className="sub">Failed</div><div className="mono">{health.documents.failed}</div></div>
            <div><div className="sub">Chunks</div><div className="mono">{health.chunks_total}</div></div>
            <div><div className="sub">Embeddings</div><div className="mono">{health.embeddings_total}</div></div>
          </div>
        </div>
      ) : null}

      <form className="card" onSubmit={submit}>
        <div className="inline" style={{ gap: 10, flexWrap: "wrap" }}>
          <input
            aria-label="Search query"
            placeholder="Search authorized knowledge..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ flex: "1 1 320px" }}
          />
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            {MODES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="relevance">Relevance</option>
            <option value="recency">Recency</option>
            <option value="title">Title</option>
          </select>
          <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {[10, 20, 30].map((value) => <option key={value} value={value}>{value} results</option>)}
          </select>
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? "Searching..." : "Search"}
          </button>
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          {FILTER_FIELDS.map(({ field, label }) => (
            <label key={field} className="stack">
              <span className="sub">{label}</span>
              <input
                value={filterValues[field]}
                onChange={(event) =>
                  setFilterValues((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
        <div className="inline" style={{ marginTop: 8, gap: 8 }}>
          <span className="sub">
            {activeFilterCount ? `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} applied` : "No filters"}
          </span>
          {activeFilterCount ? (
            <button
              type="button"
              className="ghost"
              onClick={() => setFilterValues(EMPTY_FILTER_VALUES)}
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {suggestions.length ? (
          <div className="chips" style={{ marginTop: 10 }}>
            {suggestions.map((suggestion) => (
              <button
                type="button"
                className="chip"
                key={suggestion}
                onClick={() => {
                  setQuery(suggestion);
                  runSearch({ query: suggestion });
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </form>

      {note ? <p className="sub">{note}</p> : null}

      <div className="search-layout" style={{ marginTop: 16 }}>
        <div>
          <div className="split">
            <div>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <strong>AI knowledge</strong>
                <span className="mono">
                  {aiResult ? `${aiResult.total} result${aiResult.total === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              <p className="sub">
                {aiResult
                  ? `mode ${aiResult.mode}${aiResult.fallback ? " (fallback)" : ""} · scores are AI relevance only`
                  : "Semantic, keyword or hybrid retrieval over authorized indexed content."}
              </p>
              {aiError ? <p className="error">{aiError}</p> : null}
              <div className="result-list">
                {aiResults.map((item) => (
                  <div className="result-card" key={item.chunk_id}>
                    <div className="result-title">
                      {item.title || item.external_id || `Document ${item.document_id}`}
                    </div>
                    <div className="result-sub">
                      <span className="badge active">{item.source_code}</span>
                      {item.external_id ? <span className="mono">{item.external_id}</span> : null}
                      <span className="badge inactive">chunk {item.chunk_index}</span>
                      {item.document_status ? (
                        <span className="badge inactive">{labelize(item.document_status)}</span>
                      ) : null}
                      {item.classification ? (
                        <span className="badge inactive">{item.classification}</span>
                      ) : null}
                      <span className="mono">AI score {Number(item.score).toFixed(3)}</span>
                    </div>
                    <div className="result-summary">{item.content}</div>
                    <div className="sub" style={{ marginTop: 6 }}>
                      {item.document_updated_at
                        ? `updated ${new Date(item.document_updated_at).toLocaleDateString()}`
                        : "update time unavailable"}
                      {item.hit_count > 1 ? ` · ${item.hit_count} matching passages` : ""}
                      {item.page ? ` · page ${item.page}` : ""}
                      {item.section ? ` · ${item.section}` : ""}
                    </div>
                  </div>
                ))}
                {aiResult && !aiResults.length ? (
                  <p className="sub">No authorized AI knowledge matches.</p>
                ) : null}
              </div>
            </div>

            <div>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <strong>Helix enterprise search</strong>
                <span className="mono">
                  {helixResult ? `${helixResult.total} record${helixResult.total === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              <p className="sub">
                Independent keyword index over enterprise records. Scores are not comparable
                with AI relevance scores.
              </p>
              {helixError ? <p className="error">{helixError}</p> : null}
              <div className="result-list">
                {helixResults.map((item) => (
                  <div className="result-card" key={`${item.object_type}-${item.object_id}`}>
                    <div className="result-title">{item.title || item.code || item.object_id}</div>
                    <div className="result-sub">
                      <span className="badge inactive">{labelize(item.object_type)}</span>
                      {item.code ? <span className="mono">{item.code}</span> : null}
                      {item.status ? <span className="badge inactive">{item.status}</span> : null}
                      {item.classification ? (
                        <span className="badge inactive">{item.classification}</span>
                      ) : null}
                      {item.score !== null && item.score !== undefined ? (
                        <span className="mono">Helix score {Number(item.score).toFixed(1)}</span>
                      ) : null}
                    </div>
                    {item.summary ? <div className="result-summary">{item.summary}</div> : null}
                  </div>
                ))}
                {helixResult && !helixResults.length ? (
                  <p className="sub">No matching enterprise records.</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <aside className="search-aside">
          <div className="card">
            <strong>Facets</strong>
            <p className="sub">Authorized metadata counts for the current AI query.</p>
            {facets?.facets?.length ? (
              facets.facets.map((facet) => (
                <div className="facet-group" key={facet.field}>
                  <div className="facet-title">{labelize(facet.field)}</div>
                  {facet.buckets.map((bucket) => (
                    <div className="facet-value" key={`${facet.field}-${bucket.value}`}>
                      <span>{String(bucket.value)}</span>
                      <span className="mono">{bucket.count}</span>
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <p className="sub">{aiResult ? "No facets for this result set." : "Run a search to load facets."}</p>
            )}
          </div>

          <div className="card">
            <strong>Saved searches</strong>
            <form className="inline" onSubmit={saveCurrent} style={{ marginTop: 8, gap: 8 }}>
              <input
                placeholder="Save this search as..."
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                style={{ flex: "1 1 140px" }}
              />
              <button type="submit" className="ghost" disabled={!saveName.trim() || !query.trim()}>
                Save
              </button>
            </form>
            <div className="chips" style={{ marginTop: 10 }}>
              {saved.map((item) => (
                <span className="chip" key={item.id}>
                  <button type="button" className="link" onClick={() => applySaved(item)}>
                    {item.name}
                  </button>
                  <button type="button" className="link" onClick={() => removeSaved(item)}>
                    remove
                  </button>
                </span>
              ))}
              {!saved.length ? <span className="sub">No saved searches yet.</span> : null}
            </div>
          </div>

          <div className="card">
            <div className="inline" style={{ justifyContent: "space-between" }}>
              <strong>Duplicate &amp; conflict review</strong>
              <button type="button" className="ghost" onClick={scanForDuplicates}>
                Scan
              </button>
            </div>
            {scanSummary ? (
              <p className="sub">
                Scanned {scanSummary.documents_scanned} documents · {scanSummary.findings} findings
                ({scanSummary.created} new, {scanSummary.updated} updated)
              </p>
            ) : (
              <p className="sub">Advisory findings only; nothing is merged automatically.</p>
            )}
            <div className="result-list">
              {duplicates.map((finding) => (
                <div className="result-card" key={finding.id}>
                  <div className="result-sub">
                    <span className={`badge ${finding.kind === "conflict" ? "inactive" : "active"}`}>
                      {finding.kind}
                    </span>
                    <span className="mono">{finding.match_type}</span>
                    <span className="mono">confidence {Number(finding.confidence).toFixed(2)}</span>
                  </div>
                  <div className="sub">
                    documents {finding.document_a_id} and {finding.document_b_id}
                  </div>
                  <button type="button" className="ghost" onClick={() => dismissFinding(finding)}>
                    Dismiss
                  </button>
                </div>
              ))}
              {!duplicates.length ? <p className="sub">No open findings.</p> : null}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
