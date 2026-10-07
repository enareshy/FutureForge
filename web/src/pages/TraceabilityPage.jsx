import React, { useEffect, useState } from "react";
import { traceability } from "../api.js";
import ObjectGraphView from "../components/ObjectGraphView.jsx";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "explorer", label: "Explorer" },
  { key: "coverage", label: "Coverage & orphans" },
  { key: "integrity", label: "Link integrity" },
  { key: "analysis", label: "Matrix & impact" },
  { key: "links", label: "Trace links" },
  { key: "configuration", label: "Configuration" },
];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneForSeverity(severity) {
  if (severity === "ERROR") return "danger";
  if (severity === "WARNING") return "warn";
  return undefined;
}

function coverageTone(value) {
  if (value >= 90) return "ok";
  if (value >= 60) return "warn";
  return "danger";
}

function refOf(node) {
  return node?.node_ref || (node?.object_type ? `${node.object_type}:${node.object_id}` : "");
}

function idOfRef(ref) {
  return String(ref || "").split(":").pop();
}

function toObjectGraph(graph) {
  if (!graph) return null;
  const nodes = (graph.nodes || []).map((node) => ({
    id: String(node.object_id),
    code: node.display_name || node.object_id,
    name: node.display_name,
    type: { name: node.object_type },
    status: node.lifecycle_state || node.status,
  }));
  const edges = (graph.edges || []).map((edge, idx) => ({
    id: `${edge.source_node_ref}->${edge.target_node_ref}:${idx}`,
    source: { id: idOfRef(edge.source_node_ref) },
    target: { id: idOfRef(edge.target_node_ref) },
    relationship_type: { code: edge.relationship_type, directed: true },
  }));
  return {
    nodes,
    edges,
    root_id: idOfRef(graph.root?.node_ref),
    node_count: graph.node_count,
    edge_count: graph.edge_count,
  };
}

export default function TraceabilityPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [orphans, setOrphans] = useState([]);
  const [broken, setBroken] = useState(null);
  const [links, setLinks] = useState([]);
  const [configuration, setConfiguration] = useState({});

  const [rootType, setRootType] = useState("product");
  const [rootId, setRootId] = useState("");
  const [graph, setGraph] = useState(null);

  const [matrix, setMatrix] = useState(null);
  const [impact, setImpact] = useState(null);

  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [paths, setPaths] = useState(null);

  const [linkForm, setLinkForm] = useState({
    relationshipType: "",
    sourceType: "document",
    sourceId: "",
    targetType: "product",
    targetId: "",
    start: "",
  });

  const [configKey, setConfigKey] = useState("");
  const [configValue, setConfigValue] = useState("");

  async function refresh() {
    setError("");
    try {
      const [met, h, cov, orp, brk, cfg, lns] = await Promise.all([
        traceability.meta(),
        traceability.health(),
        traceability.coverage(),
        traceability.orphans("?include_optional=true"),
        traceability.brokenLinks(),
        traceability.configuration(),
        traceability.links("?page_size=100"),
      ]);
      setMeta(met);
      setHealth(h);
      setCoverage(cov);
      setOrphans(orp.items || []);
      setBroken(brk);
      setConfiguration(cfg || {});
      setLinks(lns.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (message) setNotice(message);
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const qs = () => {
    const params = new URLSearchParams();
    if (rootType) params.set("objectType", rootType);
    if (rootId) params.set("objectId", rootId);
    params.set("include_inactive", "true");
    return `?${params.toString()}`;
  };

  async function traverse(kind) {
    const result = await run(() =>
      kind === "forward"
        ? traceability.forward(rootType, rootId, "?include_inactive=true")
        : kind === "backward"
        ? traceability.backward(rootType, rootId, "?include_inactive=true")
        : kind === "children"
        ? traceability.children(rootType, rootId, "?include_inactive=true")
        : kind === "parents"
        ? traceability.parents(rootType, rootId, "?include_inactive=true")
        : traceability.graph(qs().slice(1))
    );
    if (result) setGraph(result);
  }

  async function runMatrix() {
    const result = await run(() => traceability.matrix(qs().slice(1)));
    if (result) setMatrix(result);
  }

  async function runImpact() {
    const result = await run(() => traceability.impact({ objectType: rootType, objectId: rootId, include_inactive: true }));
    if (result) setImpact(result);
  }

  async function findPath() {
    const params = new URLSearchParams();
    if (pathFrom) params.set("source", pathFrom);
    if (pathTo) params.set("target", pathTo);
    params.set("include_inactive", "true");
    const result = await run(() => traceability.path(`?${params.toString()}`));
    if (result) setPaths(result);
  }

  async function createLink() {
    const body = {
      relationshipType: linkForm.relationshipType,
      sourceObject: { objectType: linkForm.sourceType, objectId: linkForm.sourceId },
      targetObject: { objectType: linkForm.targetType, objectId: linkForm.targetId },
    };
    if (linkForm.start) body.effectivity = { start: linkForm.start };
    const result = await run(() => traceability.createLink(body), "Trace link created.");
    if (result) {
      setLinkForm({ ...linkForm, sourceId: "", targetId: "", start: "" });
      await refresh();
    }
  }

  async function removeLink(link) {
    await run(() => traceability.deleteLink(link.id), "Trace link deleted.");
    await refresh();
  }

  async function saveConfig() {
    const value = configValue === "true" ? true : configValue === "false" ? false : Number.isNaN(Number(configValue)) ? configValue : Number(configValue);
    await run(() => traceability.setConfiguration(configKey, value), `Configuration "${configKey}" updated.`);
    setConfigKey("");
    setConfigValue("");
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Traceability engine</h1>
          <p className="subtle">
            A generic, configuration-driven traceability capability over the Object &amp; Relationship Framework and the
            Digital Thread. It is not specific to any domain — object types, relationship types and rules are data.
          </p>
        </div>
        <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
      </div>

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} className={`tab${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="panel">
            <h3>Health</h3>
            <div className="grid">
              <div><div className="subtle">Status</div><Badge tone={health?.status === "OK" ? "ok" : "warn"}>{health?.status || "-"}</Badge></div>
              <div><div className="subtle">Overall coverage</div><div className="mono">{health?.overall_coverage ?? "-"}%</div></div>
              <div><div className="subtle">Expected links</div><div className="mono">{health?.expected ?? "-"}</div></div>
              <div><div className="subtle">Linked</div><div className="mono">{health?.linked ?? "-"}</div></div>
              <div><div className="subtle">Orphans</div><div className="mono">{health?.orphaned ?? "-"}</div></div>
              <div><div className="subtle">Broken links</div><div className="mono">{health?.broken_links ?? "-"}</div></div>
              <div><div className="subtle">Rules</div><div className="mono">{health?.rules ?? "-"}</div></div>
            </div>
          </div>

          <div className="panel">
            <h3>Traceability rules</h3>
            <table className="table">
              <thead><tr><th>Rule</th><th>Source → target</th><th>Relationship</th><th>Required</th><th>Expected</th><th>Linked</th><th>Coverage</th></tr></thead>
              <tbody>
                {(coverage?.rules || []).map((entry) => (
                  <tr key={entry.rule.code}>
                    <td className="mono">{entry.rule.code}</td>
                    <td className="mono">{`${entry.rule.source_domain} → ${entry.rule.target_domain}`}</td>
                    <td className="mono">{entry.rule.relationship_type || "ANY"}</td>
                    <td>{entry.rule.required ? <Badge tone="danger">required</Badge> : <Badge>optional</Badge>}</td>
                    <td className="mono">{entry.expected}</td>
                    <td className="mono">{entry.linked}</td>
                    <td><Badge tone={coverageTone(entry.coverage)}>{entry.coverage}%</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Broken links by reason</h3>
            {Object.keys(broken?.counts_by_reason || {}).length === 0 ? (
              <p className="subtle">No broken links detected.</p>
            ) : (
              <table className="table">
                <thead><tr><th>Reason</th><th>Count</th></tr></thead>
                <tbody>
                  {Object.entries(broken.counts_by_reason).map(([reason, count]) => (
                    <tr key={reason}><td className="mono">{reason}</td><td className="mono">{count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}

      {tab === "explorer" ? (
        <>
          <div className="panel">
            <h3>Object traversal</h3>
            <div className="stack-row">
              <label className="field"><span>Object type</span><input value={rootType} onChange={(e) => setRootType(e.target.value)} /></label>
              <label className="field"><span>Object id</span><input value={rootId} onChange={(e) => setRootId(e.target.value)} /></label>
              <button className="btn" disabled={busy || !rootId} onClick={() => traverse("forward")}>Forward</button>
              <button className="btn ghost" disabled={busy || !rootId} onClick={() => traverse("backward")}>Backward</button>
              <button className="btn ghost" disabled={busy || !rootId} onClick={() => traverse("children")}>Children</button>
              <button className="btn ghost" disabled={busy || !rootId} onClick={() => traverse("parents")}>Parents</button>
              <button className="btn secondary" disabled={busy || !rootId} onClick={() => traverse("graph")}>Graph</button>
            </div>
          </div>

          {graph ? (
            <div className="panel">
              <h3>{`Graph — ${refOf(graph.root)} (${graph.node_count} nodes / ${graph.edge_count} edges)`}</h3>
              <ObjectGraphView graph={toObjectGraph(graph)} />
              <h4>Nodes ({graph.node_count})</h4>
              <table className="table">
                <thead><tr><th>Depth</th><th>Node</th><th>Type</th><th>Domain</th><th>Status</th></tr></thead>
                <tbody>
                  {(graph.nodes || []).map((node) => (
                    <tr key={refOf(node)}>
                      <td className="mono">{node.depth ?? 0}</td>
                      <td>{node.display_name || node.name || refOf(node)}</td>
                      <td className="mono">{node.object_type || node.domain}</td>
                      <td className="mono">{node.domain}</td>
                      <td className="mono">{node.lifecycle_state || node.status || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>Edges ({graph.edge_count})</h4>
              <table className="table">
                <thead><tr><th>Relationship</th><th>Source</th><th>Target</th></tr></thead>
                <tbody>
                  {(graph.edges || []).map((edge, idx) => (
                    <tr key={`${edge.source_node_ref}-${edge.target_node_ref}-${idx}`}>
                      <td className="mono">{edge.relationship_type}</td>
                      <td className="mono">{edge.source_node_ref}</td>
                      <td className="mono">{edge.target_node_ref}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="panel">
            <h3>Paths</h3>
            <div className="stack-row">
              <label className="field grow"><span>From (type:id)</span><input value={pathFrom} onChange={(e) => setPathFrom(e.target.value)} /></label>
              <label className="field grow"><span>To (type:id)</span><input value={pathTo} onChange={(e) => setPathTo(e.target.value)} /></label>
              <button className="btn secondary" disabled={busy || !pathFrom || !pathTo} onClick={findPath}>Find path</button>
            </div>
            {paths ? (
              paths.found ? (
                <table className="table">
                  <thead><tr><th>#</th><th>Length</th><th>Nodes</th></tr></thead>
                  <tbody>
                    {(paths.paths || []).map((entry, idx) => (
                      <tr key={idx}>
                        <td className="mono">{idx + 1}</td>
                        <td className="mono">{entry.length}</td>
                        <td className="mono">{(entry.nodes || []).map((n) => refOf(n)).join(" → ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="subtle">No path found.</p>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "coverage" ? (
        <>
          <div className="panel">
            <h3>{`Overall coverage: ${coverage?.overall_coverage ?? "-"}% (${coverage?.linked ?? 0}/${coverage?.expected ?? 0})`}</h3>
            <table className="table">
              <thead><tr><th>Target domain</th><th>Expected</th><th>Linked</th><th>Orphaned</th><th>Coverage</th></tr></thead>
              <tbody>
                {(coverage?.target_domains || []).map((domain) => (
                  <tr key={domain.target_domain}>
                    <td className="mono">{domain.target_domain}</td>
                    <td className="mono">{domain.expected}</td>
                    <td className="mono">{domain.linked}</td>
                    <td className="mono">{domain.orphaned}</td>
                    <td><Badge tone={coverageTone(domain.coverage)}>{domain.coverage}%</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>{`Orphaned objects (${orphans.length})`}</h3>
            <table className="table">
              <thead><tr><th>Object</th><th>Type</th><th>Status</th><th>Expected target</th><th>Rule</th></tr></thead>
              <tbody>
                {orphans.map((entry, idx) => (
                  <tr key={`${entry.object?.id}-${idx}`}>
                    <td>{entry.object?.code || entry.object?.name || entry.object?.id}</td>
                    <td className="mono">{entry.object?.type}</td>
                    <td className="mono">{entry.object?.status}</td>
                    <td className="mono">{entry.expected_target_domain}</td>
                    <td className="mono">{entry.rule?.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "integrity" ? (
        <div className="panel">
          <h3>{`Broken & dangling links (${broken?.total ?? 0})`}</h3>
          <table className="table">
            <thead><tr><th>Severity</th><th>Reasons</th><th>Source</th><th>Target</th><th>Relationship</th></tr></thead>
            <tbody>
              {(broken?.items || []).map((item, idx) => (
                <tr key={idx}>
                  <td><Badge tone={toneForSeverity(item.severity)}>{item.severity}</Badge></td>
                  <td className="mono">{(item.reasons || []).join(", ")}</td>
                  <td className="mono">{item.source?.code || item.source?.id || "-"}</td>
                  <td className="mono">{item.target?.code || item.target?.id || "-"}</td>
                  <td className="mono">{item.relationship?.type || "reference"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "analysis" ? (
        <>
          <div className="panel">
            <div className="stack-row">
              <label className="field"><span>Object type</span><input value={rootType} onChange={(e) => setRootType(e.target.value)} /></label>
              <label className="field"><span>Object id</span><input value={rootId} onChange={(e) => setRootId(e.target.value)} /></label>
              <button className="btn" disabled={busy || !rootId} onClick={runMatrix}>Matrix</button>
              <button className="btn secondary" disabled={busy || !rootId} onClick={runImpact}>Impact</button>
            </div>
          </div>

          {matrix ? (
            <div className="panel">
              <h3>{`Traceability matrix — ${refOf(matrix.root)}`}</h3>
              <table className="table">
                <thead><tr><th>From domain</th><th>To domain</th><th>Count</th><th>Relationship types</th></tr></thead>
                <tbody>
                  {(matrix.matrix || []).map((cell, idx) => (
                    <tr key={idx}>
                      <td className="mono">{cell.from_domain}</td>
                      <td className="mono">{cell.to_domain}</td>
                      <td className="mono">{cell.count}</td>
                      <td className="mono">{(cell.relationship_types || []).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {impact ? (
            <div className="panel">
              <h3>{`Impact — ${impact.impact_summary?.impacted_count ?? 0} affected`}</h3>
              <table className="table">
                <thead><tr><th>Depth</th><th>Node</th><th>Type</th><th>Domain</th></tr></thead>
                <tbody>
                  {(impact.impact_summary?.levels || []).flatMap((level) =>
                    (level.nodes || []).map((node) => (
                      <tr key={`${level.depth}-${node.node_ref}`}>
                        <td className="mono">{level.depth}</td>
                        <td>{node.display_name || node.node_ref}</td>
                        <td className="mono">{node.object_type}</td>
                        <td className="mono">{node.domain}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "links" ? (
        <>
          <div className="panel">
            <h3>Create trace link</h3>
            <div className="grid">
              <label className="field grow"><span>Relationship type code</span><input value={linkForm.relationshipType} onChange={(e) => setLinkForm({ ...linkForm, relationshipType: e.target.value })} /></label>
              <label className="field"><span>Source type</span><input value={linkForm.sourceType} onChange={(e) => setLinkForm({ ...linkForm, sourceType: e.target.value })} /></label>
              <label className="field"><span>Source id</span><input value={linkForm.sourceId} onChange={(e) => setLinkForm({ ...linkForm, sourceId: e.target.value })} /></label>
              <label className="field"><span>Target type</span><input value={linkForm.targetType} onChange={(e) => setLinkForm({ ...linkForm, targetType: e.target.value })} /></label>
              <label className="field"><span>Target id</span><input value={linkForm.targetId} onChange={(e) => setLinkForm({ ...linkForm, targetId: e.target.value })} /></label>
              <label className="field"><span>Valid from</span><input value={linkForm.start} onChange={(e) => setLinkForm({ ...linkForm, start: e.target.value })} /></label>
            </div>
            <button className="btn" disabled={busy || !linkForm.relationshipType || !linkForm.sourceId || !linkForm.targetId} onClick={createLink}>Create link</button>
          </div>

          <div className="panel">
            <h3>{`Trace links (${links.length})`}</h3>
            <table className="table">
              <thead><tr><th>Type</th><th>Source</th><th>Target</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id}>
                    <td className="mono">{link.relationship_type || link.type?.code || link.type}</td>
                    <td className="mono">{link.source?.code || link.source?.id}</td>
                    <td className="mono">{link.target?.code || link.target?.id}</td>
                    <td className="mono">{link.status}</td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => removeLink(link)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Traceability configuration</h3>
          <p className="subtle">Configuration is stored by the Digital Thread configuration service and shared across both projections.</p>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <tr key={key}><td className="mono">{key}</td><td className="mono">{JSON.stringify(value)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="stack-row" style={{ marginTop: 12 }}>
            <label className="field grow"><span>Key</span><input value={configKey} onChange={(e) => setConfigKey(e.target.value)} /></label>
            <label className="field grow"><span>Value</span><input value={configValue} onChange={(e) => setConfigValue(e.target.value)} /></label>
            <button className="btn secondary" disabled={busy || !configKey} onClick={saveConfig}>Save</button>
          </div>
        </div>
      ) : null}

      <p className="subtle mono">
        {meta ? `Source module: ${meta.source_module} · resources: ${Object.keys(meta.resources || {}).join(", ")}` : ""}
      </p>
    </div>
  );
}
