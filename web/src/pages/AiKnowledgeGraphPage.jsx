import React, { useEffect, useMemo, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function confidence(value) {
  if (value === null || value === undefined) return "";
  return `${Math.round(Number(value) * 100)}%`;
}

const TABS = [
  "Entities",
  "Digital thread",
  "Where-used",
  "Change impact",
  "Traceability",
  "Types",
];

const LIFECYCLE_TONES = {
  active: "active",
  released: "succeeded",
  draft: "draft",
  inactive: "inactive",
  stale: "pending",
  obsolete: "deprecated",
  archived: "disabled",
};

function toneFor(status) {
  return LIFECYCLE_TONES[status];
}

function EntityTable({ entities, onSelect, selectedId }) {
  if (!entities?.length) return <p className="subtle">No entities.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Key</th><th>Type</th><th>Name</th><th>Lifecycle</th><th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        {entities.map((entity) => (
          <tr key={entity.id} className={selectedId === entity.id ? "valid" : ""}>
            <td>
              <button className="link-btn" onClick={() => onSelect(entity)}>
                {entity.stable_key}
              </button>
            </td>
            <td className="mono">{entity.entity_type}</td>
            <td>{entity.name || "-"}</td>
            <td>
              <span className={`badge${toneFor(entity.lifecycle_status) ? ` ${toneFor(entity.lifecycle_status)}` : ""}`}>
                {entity.lifecycle_status}
              </span>
            </td>
            <td>{confidence(entity.confidence)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NodeList({ nodes }) {
  if (!nodes?.length) return <p className="subtle">No related entities.</p>;
  return (
    <ul className="detail-list">
      {nodes.map((node) => (
        <li key={node.id}>
          <span className="mono">{node.entity_type}</span>{" "}
          <strong>{node.stable_key}</strong>
          {node.name ? <span className="muted"> - {node.name}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function SectionList({ sections }) {
  const entries = Object.entries(sections || {}).filter(([, values]) => values?.length);
  if (!entries.length) return <p className="subtle">No thread sections.</p>;
  return (
    <div className="stack">
      {entries.map(([key, values]) => (
        <div className="panel" key={key}>
          <div className="panel-head"><h3>{key.replace(/_/g, " ")}</h3></div>
          <NodeList nodes={values} />
        </div>
      ))}
    </div>
  );
}

export default function AiKnowledgeGraphPage() {
  const [tab, setTab] = useState("Entities");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState(null);
  const [entities, setEntities] = useState([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [types, setTypes] = useState({ entity_types: [], relationship_types: [] });
  const [selected, setSelected] = useState(null);
  const [versions, setVersions] = useState([]);
  const [neighborhood, setNeighborhood] = useState(null);
  const [traversal, setTraversal] = useState(null);
  const [maxDepth, setMaxDepth] = useState(2);

  const [threadId, setThreadId] = useState("");
  const [thread, setThread] = useState(null);

  const [partId, setPartId] = useState("");
  const [whereUsed, setWhereUsed] = useState(null);

  const [changeId, setChangeId] = useState("");
  const [impact, setImpact] = useState(null);

  const [traceId, setTraceId] = useState("");
  const [traceability, setTraceability] = useState(null);

  async function guard(fn) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const entityTypeCodes = useMemo(
    () => (types.entity_types || []).map((item) => item.code),
    [types],
  );

  async function loadTypes() {
    const data = await guard(() => ai.graphTypes());
    if (data) setTypes(data);
  }

  async function loadStats() {
    const data = await guard(() => ai.graphStats());
    if (data) setStats(data);
  }

  async function loadEntities() {
    const params = { limit: 25 };
    if (query) params.query = query;
    if (typeFilter) params.entity_types = typeFilter;
    const page = await guard(() => ai.graphEntities(params));
    if (page) {
      setEntities(page.items || []);
      setTotal(page.total || 0);
    }
  }

  useEffect(() => {
    loadTypes();
    loadStats();
    loadEntities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectEntity(entity) {
    setSelected(entity);
    setVersions([]);
    setNeighborhood(null);
    setTraversal(null);
    const detail = await guard(() => ai.graphEntity(entity.id));
    if (detail) setSelected(detail);
    const vers = await guard(() => ai.graphEntityVersions(entity.id));
    if (vers) setVersions(vers);
    const hood = await guard(() =>
      ai.graphNeighborhood(entity.id, { direction: "both", limit: 50 }),
    );
    if (hood) setNeighborhood(hood);
  }

  async function traverse() {
    if (!selected) return;
    const result = await guard(() =>
      ai.graphTraverse(selected.id, {
        direction: "both",
        max_depth: Number(maxDepth) || 1,
        limit: 100,
      }),
    );
    if (result) setTraversal(result);
  }

  async function runThread(e) {
    e.preventDefault();
    if (!threadId) return;
    setThread(null);
    const result = await guard(() => ai.graphDigitalThread(Number(threadId)));
    if (result) setThread(result);
  }

  async function runWhereUsed(e) {
    e.preventDefault();
    if (!partId) return;
    setWhereUsed(null);
    const result = await guard(() =>
      ai.graphWhereUsed(Number(partId), { max_depth: 3 }),
    );
    if (result) setWhereUsed(result);
  }

  async function runImpact(e) {
    e.preventDefault();
    if (!changeId) return;
    setImpact(null);
    const result = await guard(() =>
      ai.graphChangeImpact(Number(changeId), { max_depth: 3 }),
    );
    if (result) setImpact(result);
  }

  async function runTraceability(e) {
    e.preventDefault();
    if (!traceId) return;
    setTraceability(null);
    const result = await guard(() =>
      ai.graphTraceability(Number(traceId), { max_depth: 4 }),
    );
    if (result) setTraceability(result);
  }

  async function deleteSelected() {
    if (!selected) return;
    if (!window.confirm(`Archive entity ${selected.stable_key}?`)) return;
    const deleted = await guard(() => ai.deleteGraphEntity(selected.id));
    if (deleted) {
      setNotice(`Archived ${deleted.stable_key}`);
      setSelected(null);
      setNeighborhood(null);
      await loadEntities();
      await loadStats();
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Knowledge graph & digital thread</h1>
          <p className="sub">
            Tenant-scoped product, BOM, change, requirement and quality entities
            with typed relationships. Traversal honors object-level authorization.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {stats ? (
        <div className="row" style={{ gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
          <div><span className="muted">Entities</span> <strong>{stats.entities}</strong></div>
          <div><span className="muted">Relationships</span> <strong>{stats.relationships}</strong></div>
          <div><span className="muted">Stale</span> <strong>{stats.stale_entities}</strong></div>
          <div className="muted">Updated {formatTime(stats.last_entity_update) || "-"}</div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "" : "ghost"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Entities" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Entities ({total})</h3>
            </div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                loadEntities();
              }}
            >
              <input
                placeholder="Search name or key"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                {entityTypeCodes.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              <button className="btn ghost" disabled={busy}>Search</button>
            </form>
            <EntityTable
              entities={entities}
              onSelect={selectEntity}
              selectedId={selected?.id}
            />
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Entity detail</h3>
              {selected ? (
                <button className="btn ghost" onClick={deleteSelected}>Archive</button>
              ) : null}
            </div>
            {!selected ? (
              <p className="subtle">Select an entity to inspect it.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>ID: {selected.id}</li>
                  <li>Type: <span className="mono">{selected.entity_type}</span></li>
                  <li>Key: {selected.stable_key}</li>
                  <li>Name: {selected.name || "-"}</li>
                  <li>Lifecycle: {selected.lifecycle_status}</li>
                  <li>Classification: {selected.classification}</li>
                  <li>Confidence: {confidence(selected.confidence)}</li>
                  <li>Version: {selected.version}</li>
                  <li>Source: {selected.source_system || "-"}</li>
                  <li>Updated: {formatTime(selected.updated_at) || "-"}</li>
                </ul>

                {selected.description ? (
                  <p className="subtle">{selected.description}</p>
                ) : null}

                <div className="panel-head"><h3>Neighbors</h3></div>
                {neighborhood ? (
                  <>
                    {neighborhood.truncated ? (
                      <p className="subtle">Results truncated.</p>
                    ) : null}
                    <ul className="detail-list">
                      {(neighborhood.neighbors || []).map((item) => (
                        <li key={`${item.relationship.id}-${item.entity.id}`}>
                          <span className="badge">{item.relationship.relationship_type}</span>{" "}
                          {item.direction === "outgoing" ? "\u2192" : "\u2190"}{" "}
                          <span className="mono">{item.entity.entity_type}</span>{" "}
                          <strong>{item.entity.stable_key}</strong>
                        </li>
                      ))}
                      {!neighborhood.neighbors?.length ? (
                        <li className="subtle">No neighbors.</li>
                      ) : null}
                    </ul>
                  </>
                ) : (
                  <p className="subtle">Loading neighbors.</p>
                )}

                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <input
                    type="number"
                    min="1"
                    max="6"
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(e.target.value)}
                    style={{ width: 80 }}
                  />
                  <button className="btn ghost" onClick={traverse}>Traverse</button>
                </div>
                {traversal ? (
                  <p className="subtle">
                    Reached depth {traversal.depth_reached}, {traversal.nodes.length} nodes
                    {traversal.truncated ? " (truncated)" : ""}.
                  </p>
                ) : null}

                <div className="panel-head"><h3>Versions</h3></div>
                <table>
                  <thead>
                    <tr><th>Version</th><th>Reason</th><th>By</th><th>At</th></tr>
                  </thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.id}>
                        <td>{version.version}</td>
                        <td>{version.change_reason || "-"}</td>
                        <td className="muted">{version.created_by || "-"}</td>
                        <td className="muted">{formatTime(version.created_at)}</td>
                      </tr>
                    ))}
                    {!versions.length ? (
                      <tr><td colSpan={4} className="muted">No versions.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Digital thread" ? (
        <form className="panel" onSubmit={runThread}>
          <div className="panel-head"><h3>Digital thread</h3></div>
          <p className="subtle">
            Enter a product entity ID to assemble its engineering, manufacturing
            and quality context.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number"
              min="1"
              placeholder="Product entity ID"
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
            />
            <button className="btn" disabled={busy}>Load thread</button>
          </div>
          {thread ? (
            <div style={{ marginTop: 16 }}>
              <p>
                <strong>{thread.product.name || thread.product.stable_key}</strong>{" "}
                <span className="mono">({thread.product.stable_key})</span>
              </p>
              <SectionList sections={thread.sections} />
            </div>
          ) : null}
        </form>
      ) : null}

      {tab === "Where-used" ? (
        <form className="panel" onSubmit={runWhereUsed}>
          <div className="panel-head"><h3>Where-used analysis</h3></div>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number"
              min="1"
              placeholder="Part entity ID"
              value={partId}
              onChange={(e) => setPartId(e.target.value)}
            />
            <button className="btn" disabled={busy}>Analyze</button>
          </div>
          {whereUsed ? (
            <div style={{ marginTop: 16 }}>
              <p>
                <strong>{whereUsed.part.name || whereUsed.part.stable_key}</strong> is used by:
              </p>
              <table>
                <thead><tr><th>Type</th><th>Key</th><th>Name</th><th>Depth</th></tr></thead>
                <tbody>
                  {whereUsed.used_by.map((item) => (
                    <tr key={`${item.entity.id}-${item.depth}`}>
                      <td className="mono">{item.entity.entity_type}</td>
                      <td>{item.entity.stable_key}</td>
                      <td>{item.entity.name || "-"}</td>
                      <td>{item.depth}</td>
                    </tr>
                  ))}
                  {!whereUsed.used_by.length ? (
                    <tr><td colSpan={4} className="muted">Not used.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </form>
      ) : null}

      {tab === "Change impact" ? (
        <form className="panel" onSubmit={runImpact}>
          <div className="panel-head"><h3>Change impact</h3></div>
          <p className="subtle">
            Enter an engineering change or change request entity ID. Inferred
            impact is flagged so it is never presented as fact.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number"
              min="1"
              placeholder="Change entity ID"
              value={changeId}
              onChange={(e) => setChangeId(e.target.value)}
            />
            <button className="btn" disabled={busy}>Analyze</button>
          </div>
          {impact ? (
            <div style={{ marginTop: 16 }}>
              {impact.inferred ? (
                <p><span className="badge pending">Includes inferred impact</span></p>
              ) : null}
              <table>
                <thead><tr><th>Type</th><th>Key</th><th>Impact</th><th>Depth</th><th>Confidence</th></tr></thead>
                <tbody>
                  {impact.affected.map((item, index) => (
                    <tr key={`${item.entity.id}-${index}`}>
                      <td className="mono">{item.entity.entity_type}</td>
                      <td>{item.entity.stable_key}</td>
                      <td>{item.impact}</td>
                      <td>{item.depth}</td>
                      <td>{confidence(item.confidence)}</td>
                    </tr>
                  ))}
                  {!impact.affected.length ? (
                    <tr><td colSpan={5} className="muted">No affected entities.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </form>
      ) : null}

      {tab === "Traceability" ? (
        <form className="panel" onSubmit={runTraceability}>
          <div className="panel-head"><h3>Traceability</h3></div>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number"
              min="1"
              placeholder="Entity ID"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
            />
            <button className="btn" disabled={busy}>Trace</button>
          </div>
          {traceability ? (
            <div style={{ marginTop: 16 }}>
              <p className="mono">{traceability.root.stable_key}</p>
              <table>
                <thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Inferred</th></tr></thead>
                <tbody>
                  {traceability.links.map((link, index) => (
                    <tr key={`${link.source.id}-${link.target.id}-${index}`}>
                      <td className="mono">{link.source.stable_key}</td>
                      <td>{link.relationship_type}</td>
                      <td className="mono">{link.target.stable_key}</td>
                      <td>{link.inferred ? "yes" : "no"}</td>
                    </tr>
                  ))}
                  {!traceability.links.length ? (
                    <tr><td colSpan={4} className="muted">No links.</td></tr>
                  ) : null}
                </tbody>
              </table>
              {traceability.orphaned.length ? (
                <p className="subtle">
                  {traceability.orphaned.length} orphaned entities in scope.
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : null}

      {tab === "Types" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Entity types</h3></div>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Source</th></tr></thead>
              <tbody>
                {(types.entity_types || []).map((item) => (
                  <tr key={item.code}>
                    <td className="mono">{item.code}</td>
                    <td>{item.name}</td>
                    <td>{item.category || "-"}</td>
                    <td>{item.builtin ? "built-in" : "tenant"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Relationship types</h3></div>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>From</th><th>To</th></tr></thead>
              <tbody>
                {(types.relationship_types || []).map((item) => (
                  <tr key={item.code}>
                    <td className="mono">{item.code}</td>
                    <td>{item.name}</td>
                    <td className="muted">{(item.source_types || []).join(", ") || "any"}</td>
                    <td className="muted">{(item.target_types || []).join(", ") || "any"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
