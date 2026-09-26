import React, { useEffect, useState } from "react";
import { digitalThread } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "explorer", label: "Explorer" },
  { key: "traceability", label: "Traceability" },
  { key: "impact", label: "Impact" },
  { key: "dependency", label: "Dependency" },
  { key: "paths", label: "Paths" },
  { key: "completeness", label: "Completeness" },
  { key: "snapshots", label: "Snapshots" },
  { key: "baselines", label: "Baselines" },
  { key: "compare", label: "Compare" },
  { key: "definitions", label: "Definitions" },
  { key: "rules", label: "Rules" },
  { key: "operations", label: "Operations" },
];

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["ACTIVE", "RELEASED", "FROZEN", "COMPLETE", "OK", "CURRENT"].includes(status)) return "ok";
  if (["DRAFT", "INCOMPLETE", "WARNING", "STALE", "UPDATING", "MISSING_DOWNSTREAM", "MISSING_UPSTREAM"].includes(status)) return "warn";
  if (["ARCHIVED", "FAILED", "ERROR", "BROKEN_LINK"].includes(status)) return "danger";
  return undefined;
}

function NodesTable({ nodes }) {
  if (!nodes?.length) return <p className="subtle">No nodes.</p>;
  return (
    <table className="table">
      <thead><tr><th>Depth</th><th>Type</th><th>Number</th><th>Name</th><th>Domain</th><th>Revision</th><th>State</th></tr></thead>
      <tbody>
        {nodes.map((node) => (
          <tr key={node.node_ref}>
            <td className="mono">{node.depth ?? 0}</td>
            <td className="mono">{node.object_type}</td>
            <td className="mono">{node.number || node.object_id}</td>
            <td>{node.display_name || "-"}</td>
            <td className="mono">{node.domain}</td>
            <td className="mono">{node.revision || "-"}</td>
            <td>{node.lifecycle_state ? <Badge tone={toneFor(node.lifecycle_state)}>{node.lifecycle_state}</Badge> : "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EdgesTable({ edges }) {
  if (!edges?.length) return <p className="subtle">No relationships.</p>;
  return (
    <table className="table">
      <thead><tr><th>Source</th><th>Relationship</th><th>Target</th><th>Direction</th></tr></thead>
      <tbody>
        {edges.map((edge, index) => (
          <tr key={edge.edge_ref || `${edge.source_node_ref}-${edge.target_node_ref}-${index}`}>
            <td className="mono">{edge.source_node_ref}</td>
            <td className="mono">{edge.relationship_type}</td>
            <td className="mono">{edge.target_node_ref}</td>
            <td className="mono">{edge.relationship_direction || "OUT"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const emptyRule = { code: "", name: "", source_domain: "REQUIREMENT", target_domain: "SYSTEM", relationship_type: "", required: true, severity: "ERROR" };
const emptyDefinition = { code: "", name: "", description: "", thread_type: "PRODUCT_DEVELOPMENT", root_object_type: "requirement", direction: "DOWNSTREAM", max_depth: 25 };

export default function DigitalThreadPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [activity, setActivity] = useState([]);
  const [configuration, setConfiguration] = useState({});
  const [definitions, setDefinitions] = useState([]);
  const [rules, setRules] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [baselines, setBaselines] = useState([]);

  const [root, setRoot] = useState("");
  const [direction, setDirection] = useState("DOWNSTREAM");
  const [maxDepth, setMaxDepth] = useState(5);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [graph, setGraph] = useState(null);
  const [matrix, setMatrix] = useState(null);
  const [impact, setImpact] = useState(null);
  const [dependency, setDependency] = useState(null);
  const [paths, setPaths] = useState(null);
  const [completeness, setCompleteness] = useState(null);

  const [target, setTarget] = useState("");
  const [snapshotForm, setSnapshotForm] = useState({ name: "", description: "" });
  const [baselineForm, setBaselineForm] = useState({ name: "", description: "", snapshot_id: "" });
  const [compareForm, setCompareForm] = useState({ left: "", right: "" });
  const [diff, setDiff] = useState(null);
  const [ruleForm, setRuleForm] = useState(emptyRule);
  const [definitionForm, setDefinitionForm] = useState(emptyDefinition);
  const [selectedSnapshot, setSelectedSnapshot] = useState(null);
  const [history, setHistory] = useState([]);

  function options(extra = {}) {
    return {
      root,
      direction,
      max_depth: Number(maxDepth) || undefined,
      include_inactive: includeInactive,
      ...extra,
    };
  }

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

  async function refresh() {
    setError("");
    try {
      const [met, h, m, act, cfg, defs, rls, snaps, bases] = await Promise.all([
        digitalThread.meta(),
        digitalThread.health(),
        digitalThread.metrics(),
        digitalThread.activity("?limit=20"),
        digitalThread.configuration(),
        digitalThread.definitions("?page_size=100"),
        digitalThread.rules("?page_size=200"),
        digitalThread.snapshots("?page_size=100"),
        digitalThread.baselines("?page_size=100"),
      ]);
      setMeta(met);
      setHealth(h);
      setMetrics(m);
      setActivity(act.items || []);
      setConfiguration(cfg || {});
      setDefinitions(defs.items || []);
      setRules(rls.items || []);
      setSnapshots(snaps.items || []);
      setBaselines(bases.items || []);
      if (!root && (snaps.items || [])[0]) {
        const seeded = (snaps.items || [])[0];
        setRoot(`${seeded.root_object_type}:${seeded.root_object_id}`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadHistory() {
    const result = await run(() => digitalThread.history("?page_size=50"));
    if (result) setHistory(result.items || []);
  }

  async function explore() {
    const result = await run(() => digitalThread.traverse(options()), "Thread traversed.");
    if (result) setGraph(result);
  }

  async function loadMatrix() {
    const result = await run(() => digitalThread.traceabilityMatrix(options()));
    if (result) setMatrix(result);
  }

  async function loadImpact() {
    const result = await run(() => digitalThread.impact(options()));
    if (result) setImpact(result);
  }

  async function loadDependency() {
    const result = await run(() => digitalThread.dependency(options()));
    if (result) setDependency(result);
  }

  async function loadPaths() {
    const result = await run(() => digitalThread.paths(options({ source: root, target: target || root })));
    if (result) setPaths(result);
  }

  async function loadCompleteness() {
    const result = await run(() => digitalThread.completeness(options()));
    if (result) setCompleteness(result);
  }

  async function createSnapshot() {
    const result = await run(
      () => digitalThread.createSnapshot({ root, direction, max_depth: Number(maxDepth) || undefined, include_inactive: includeInactive, ...snapshotForm }),
      "Snapshot created."
    );
    if (result) {
      setSnapshotForm({ name: "", description: "" });
      await refresh();
    }
  }

  async function openSnapshot(snapshot) {
    const result = await run(() => digitalThread.snapshotGraph(snapshot.id));
    if (result) setSelectedSnapshot(result);
  }

  async function snapshotAction(snapshot, status) {
    await run(() => digitalThread.setSnapshotStatus(snapshot.id, status), `Snapshot ${status}.`);
    await refresh();
  }

  async function createBaseline() {
    const result = await run(() => digitalThread.createBaseline({ ...baselineForm, snapshot_id: baselineForm.snapshot_id || undefined }), "Baseline created.");
    if (result) {
      setBaselineForm({ name: "", description: "", snapshot_id: "" });
      await refresh();
    }
  }

  async function baselineAction(baseline, action, label) {
    await run(() => action(baseline.id), label);
    await refresh();
  }

  async function compare() {
    const result = await run(() =>
      digitalThread.compareSnapshots({ left: compareForm.left, right: compareForm.right })
    );
    if (result) setDiff(result);
  }

  async function createRule() {
    const result = await run(() => digitalThread.createRule(ruleForm), "Rule created.");
    if (result) {
      setRuleForm(emptyRule);
      await refresh();
    }
  }

  async function toggleRule(rule) {
    await run(() => digitalThread.setRuleStatus(rule.id, rule.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"), "Rule status updated.");
    await refresh();
  }

  async function createDefinition() {
    const result = await run(() => digitalThread.createDefinition(definitionForm), "Definition created.");
    if (result) {
      setDefinitionForm(emptyDefinition);
      await refresh();
    }
  }

  async function toggleDefinition(definition) {
    await run(() => digitalThread.setDefinitionStatus(definition.id, definition.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"), "Definition status updated.");
    await refresh();
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => digitalThread.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  async function seedDemo() {
    await run(() => digitalThread.seed(), "Digital thread demonstration seeded.");
    await refresh();
  }

  async function rebuildProjection() {
    await run(() => digitalThread.rebuildProjection({}), "Projection rebuilt.");
    await refresh();
  }

  async function submitJob(kind, body = {}) {
    const result = await run(() => digitalThread[kind](body), "Job submitted.");
    if (result) setNotice(`Job ${result.job_ref || result.id || "submitted"} accepted.`);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Digital thread</h1>
          <p className="subtle">End-to-end traceability from requirement through system, design, part, BOM, manufacturing and quality to service, with impact, dependency, snapshots, baselines and completeness.</p>
        </div>
        <div className="stack-row">
          {meta?.source_module ? <Badge tone="ok">{meta.source_module}</Badge> : null}
          {health?.status ? <Badge tone={toneFor(health.status)}>{health.status}</Badge> : null}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} className={`tab${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>{entry.label}</button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Definitions</h3><div className="mono">{metrics?.counts?.definitions ?? "-"}</div></div>
            <div className="panel grow"><h3>Rules</h3><div className="mono">{metrics?.counts?.rules ?? "-"}</div></div>
            <div className="panel grow"><h3>Snapshots</h3><div className="mono">{metrics?.counts?.snapshots ?? "-"}</div></div>
            <div className="panel grow"><h3>Baselines</h3><div className="mono">{metrics?.counts?.baselines ?? "-"}</div></div>
            <div className="panel grow"><h3>Queries</h3><div className="mono">{metrics?.counts?.queries ?? "-"}</div></div>
            <div className="panel grow"><h3>Projections</h3><div className="mono">{metrics?.counts?.projections ?? "-"}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Providers</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed demonstration</button>
            </div>
            <div className="chips">
              {(meta?.capabilities?.providers || []).map((provider) => (
                <Badge key={provider.code} tone={provider.builtin ? "ok" : undefined}>{provider.code}</Badge>
              ))}
            </div>
            <p className="subtle">Domains: {(meta?.capabilities?.domains || []).map((domain) => domain.code).join(" -> ")}</p>
          </div>

          <div className="panel">
            <h3>Traceability link vocabulary</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Source</th><th>Target</th><th>Relationship</th></tr></thead>
              <tbody>
                {(meta?.capabilities?.traceability_links || []).map((link) => (
                  <tr key={link.code}>
                    <td className="mono">{link.code}</td>
                    <td className="mono">{link.source_domain}</td>
                    <td className="mono">{link.target_domain}</td>
                    <td className="mono">{link.relationship_type || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Recent queries</h3>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => digitalThread.reindexSearch(), "Search reindex queued.")}>Reindex search</button>
            </div>
            <table className="table">
              <thead><tr><th>Action</th><th>Nodes</th><th>Edges</th><th>Truncated</th><th>Actor</th><th>When</th></tr></thead>
              <tbody>
                {activity.map((entry, index) => (
                  <tr key={index}>
                    <td className="mono">{entry.action}</td>
                    <td className="mono">{entry.node_count}</td>
                    <td className="mono">{entry.edge_count}</td>
                    <td>{entry.truncated ? "yes" : "no"}</td>
                    <td className="mono">{entry.actor_username || "-"}</td>
                    <td className="mono">{entry.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "explorer" ? (
        <>
          <div className="panel">
            <h3>Traversal</h3>
            <div className="grid">
              <label className="field"><span>Root (type:id)</span><input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="product:1" /></label>
              <label className="field"><span>Direction</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  {(meta?.capabilities?.directions || ["UPSTREAM", "DOWNSTREAM", "BOTH"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Max depth</span><input type="number" min="1" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} /></label>
              <label className="field"><span>Include inactive</span>
                <select value={includeInactive ? "yes" : "no"} onChange={(e) => setIncludeInactive(e.target.value === "yes")}>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !root} onClick={explore}>Traverse</button>
          </div>

          {graph ? (
            <>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <div className="panel grow"><h3>Nodes</h3><div className="mono">{graph.node_count}</div></div>
                <div className="panel grow"><h3>Edges</h3><div className="mono">{graph.edge_count}</div></div>
                <div className="panel grow"><h3>Depth reached</h3><div className="mono">{graph.depth_reached}</div></div>
                <div className="panel grow"><h3>Truncated</h3><div className="mono">{String(graph.truncated)}</div></div>
                <div className="panel grow"><h3>Duration (ms)</h3><div className="mono">{graph.duration_ms}</div></div>
              </div>
              <div className="panel"><h3>Nodes</h3><NodesTable nodes={graph.nodes} /></div>
              <div className="panel"><h3>Relationships</h3><EdgesTable edges={graph.edges} /></div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "traceability" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Domain matrix</h3>
              <button className="btn" disabled={busy || !root} onClick={loadMatrix}>Build matrix</button>
            </div>
            {matrix ? (
              <table className="table">
                <thead><tr><th>From</th><th>To</th><th>Count</th><th>Relationship types</th></tr></thead>
                <tbody>
                  {matrix.matrix.map((cell) => (
                    <tr key={`${cell.from_domain}->${cell.to_domain}`}>
                      <td className="mono">{cell.from_domain}</td>
                      <td className="mono">{cell.to_domain}</td>
                      <td className="mono">{cell.count}</td>
                      <td className="mono">{(cell.relationship_types || []).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="subtle">Run the matrix to aggregate traceability by domain.</p>}
          </div>
          {matrix ? (
            <div className="panel">
              <h3>Relationship inventory</h3>
              <div className="chips">
                {matrix.relationship_inventory.map((entry) => (
                  <Badge key={entry.relationship_type}>{entry.relationship_type}: {entry.count}</Badge>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "impact" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Change impact (downstream)</h3>
              <button className="btn" disabled={busy || !root} onClick={loadImpact}>Analyse impact</button>
            </div>
            {impact ? (
              <>
                <div className="chips">
                  <Badge tone="warn">impacted: {impact.impact_summary?.impacted_count}</Badge>
                  {(impact.impact_summary?.domain_totals || []).map((entry) => (
                    <Badge key={entry.code}>{entry.code}: {entry.count}</Badge>
                  ))}
                </div>
                <NodesTable nodes={impact.nodes} />
              </>
            ) : <p className="subtle">Analyse what a change to the root impacts downstream.</p>}
          </div>
        </>
      ) : null}

      {tab === "dependency" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Upstream dependencies</h3>
              <button className="btn" disabled={busy || !root} onClick={loadDependency}>Analyse dependency</button>
            </div>
            {dependency ? (
              <>
                <div className="chips">
                  <Badge tone="warn">dependencies: {dependency.dependency_summary?.dependency_count}</Badge>
                </div>
                <NodesTable nodes={dependency.nodes} />
              </>
            ) : <p className="subtle">Analyse what the root depends on upstream.</p>}
          </div>
        </>
      ) : null}

      {tab === "paths" ? (
        <>
          <div className="panel">
            <h3>Path resolution</h3>
            <div className="grid">
              <label className="field"><span>Source</span><input value={root} onChange={(e) => setRoot(e.target.value)} /></label>
              <label className="field"><span>Target</span><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="part:1" /></label>
            </div>
            <button className="btn" disabled={busy || !root || !target} onClick={loadPaths}>Find paths</button>
            {paths ? (
              paths.found ? (
                <>
                  <p className="subtle">Shortest path length: {paths.shortest_path?.edges?.length ?? paths.shortest_path?.nodes?.length ?? 0} of {paths.path_count} path(s)</p>
                  <div className="chips">
                    {(paths.shortest_path?.nodes || []).map((node) => <Badge key={node}>{node}</Badge>)}
                  </div>
                </>
              ) : <p className="subtle">No path found.</p>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "completeness" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Rule completeness</h3>
              <button className="btn" disabled={busy || !root} onClick={loadCompleteness}>Evaluate</button>
            </div>
            {completeness ? (
              <>
                <div className="chips">
                  <Badge tone={completeness.completeness_score === 100 ? "ok" : "warn"}>score: {completeness.completeness_score}%</Badge>
                  <Badge>satisfied: {completeness.satisfied_rules}</Badge>
                  <Badge tone="danger">violated: {completeness.violated_rules}</Badge>
                </div>
                <table className="table">
                  <thead><tr><th>Rule</th><th>Source</th><th>Target</th><th>State</th><th>Missing</th></tr></thead>
                  <tbody>
                    {completeness.rules.map((entry) => (
                      <tr key={entry.rule.id}>
                        <td className="mono">{entry.rule.code}</td>
                        <td className="mono">{entry.source_domain}</td>
                        <td className="mono">{entry.target_domain}</td>
                        <td><Badge tone={toneFor(entry.state)}>{entry.state}</Badge></td>
                        <td className="mono">{entry.missing_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Evaluate active traceability rules against the traversal.</p>}
          </div>
        </>
      ) : null}

      {tab === "snapshots" ? (
        <>
          <div className="panel">
            <h3>Freeze a snapshot</h3>
            <div className="grid">
              <label className="field"><span>Name</span><input value={snapshotForm.name} onChange={(e) => setSnapshotForm({ ...snapshotForm, name: e.target.value })} /></label>
              <label className="field"><span>Description</span><input value={snapshotForm.description} onChange={(e) => setSnapshotForm({ ...snapshotForm, description: e.target.value })} /></label>
              <label className="field"><span>Root</span><input value={root} onChange={(e) => setRoot(e.target.value)} /></label>
            </div>
            <button className="btn" disabled={busy || !root || !snapshotForm.name} onClick={createSnapshot}>Create snapshot</button>
          </div>
          <div className="panel">
            <h3>Snapshots ({snapshots.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Name</th><th>Status</th><th>Immutable</th><th>Nodes</th><th>Edges</th><th></th></tr></thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="mono">{snapshot.snapshot_ref}</td>
                    <td>{snapshot.name}</td>
                    <td><Badge tone={toneFor(snapshot.status)}>{snapshot.status}</Badge></td>
                    <td className="mono">{String(snapshot.immutable)}</td>
                    <td className="mono">{snapshot.node_count}</td>
                    <td className="mono">{snapshot.edge_count}</td>
                    <td className="stack-row">
                      <button className="btn ghost" onClick={() => openSnapshot(snapshot)}>View</button>
                      <button className="btn ghost" onClick={() => snapshotAction(snapshot, "ARCHIVED")}>Archive</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedSnapshot ? (
            <div className="panel">
              <h3>{selectedSnapshot.snapshot.name} graph</h3>
              <NodesTable nodes={selectedSnapshot.nodes} />
              <EdgesTable edges={selectedSnapshot.edges} />
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "baselines" ? (
        <>
          <div className="panel">
            <h3>Create a baseline</h3>
            <div className="grid">
              <label className="field"><span>Name</span><input value={baselineForm.name} onChange={(e) => setBaselineForm({ ...baselineForm, name: e.target.value })} /></label>
              <label className="field"><span>Snapshot</span>
                <select value={baselineForm.snapshot_id} onChange={(e) => setBaselineForm({ ...baselineForm, snapshot_id: e.target.value })}>
                  <option value="">(none)</option>
                  {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input value={baselineForm.description} onChange={(e) => setBaselineForm({ ...baselineForm, description: e.target.value })} /></label>
            </div>
            <button className="btn" disabled={busy || !baselineForm.name} onClick={createBaseline}>Create baseline</button>
          </div>
          <div className="panel">
            <h3>Baselines ({baselines.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Name</th><th>Status</th><th>Members</th><th></th></tr></thead>
              <tbody>
                {baselines.map((baseline) => (
                  <tr key={baseline.id}>
                    <td className="mono">{baseline.baseline_ref}</td>
                    <td>{baseline.name}</td>
                    <td><Badge tone={toneFor(baseline.status)}>{baseline.status}</Badge></td>
                    <td className="mono">{baseline.member_count}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={baseline.status !== "DRAFT"} onClick={() => baselineAction(baseline, digitalThread.releaseBaseline, "Baseline released.")}>Release</button>
                      <button className="btn ghost" disabled={baseline.status === "FROZEN"} onClick={() => baselineAction(baseline, digitalThread.freezeBaseline, "Baseline frozen.")}>Freeze</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "compare" ? (
        <>
          <div className="panel">
            <h3>Compare snapshots</h3>
            <div className="grid">
              <label className="field"><span>Left</span>
                <select value={compareForm.left} onChange={(e) => setCompareForm({ ...compareForm, left: e.target.value })}>
                  <option value="">Select</option>
                  {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Right</span>
                <select value={compareForm.right} onChange={(e) => setCompareForm({ ...compareForm, right: e.target.value })}>
                  <option value="">Select</option>
                  {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !compareForm.left || !compareForm.right} onClick={compare}>Compare</button>
          </div>
          {diff ? (
            <>
              <div className="panel">
                <h3>Summary</h3>
                <div className="chips">
                  {Object.entries(diff.summary || {}).map(([key, value]) => <Badge key={key}>{key}: {value}</Badge>)}
                </div>
              </div>
              <div className="panel"><h3>Added nodes</h3><NodesTable nodes={diff.added_nodes} /></div>
              <div className="panel"><h3>Removed nodes</h3><NodesTable nodes={diff.removed_nodes} /></div>
              <div className="panel"><h3>Added relationships</h3><EdgesTable edges={diff.added_relationships} /></div>
              <div className="panel"><h3>Removed relationships</h3><EdgesTable edges={diff.removed_relationships} /></div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "definitions" ? (
        <>
          <div className="panel">
            <h3>Create a definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={definitionForm.code} onChange={(e) => setDefinitionForm({ ...definitionForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={definitionForm.name} onChange={(e) => setDefinitionForm({ ...definitionForm, name: e.target.value })} /></label>
              <label className="field"><span>Root type</span><input value={definitionForm.root_object_type} onChange={(e) => setDefinitionForm({ ...definitionForm, root_object_type: e.target.value })} /></label>
              <label className="field"><span>Thread type</span>
                <select value={definitionForm.thread_type} onChange={(e) => setDefinitionForm({ ...definitionForm, thread_type: e.target.value })}>
                  {(meta?.capabilities?.thread_types || ["PRODUCT_DEVELOPMENT"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label className="field"><span>Max depth</span><input type="number" min="1" value={definitionForm.max_depth} onChange={(e) => setDefinitionForm({ ...definitionForm, max_depth: Number(e.target.value) })} /></label>
            </div>
            <button className="btn" disabled={busy || !definitionForm.code || !definitionForm.name} onClick={createDefinition}>Create definition</button>
          </div>
          <div className="panel">
            <h3>Definitions ({definitions.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Max depth</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {definitions.map((definition) => (
                  <tr key={definition.id}>
                    <td className="mono">{definition.code}</td>
                    <td>{definition.name}</td>
                    <td className="mono">{definition.thread_type}</td>
                    <td className="mono">{definition.max_depth}</td>
                    <td><Badge tone={toneFor(definition.status)}>{definition.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => toggleDefinition(definition)}>{definition.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "rules" ? (
        <>
          <div className="panel">
            <h3>Create a traceability rule</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input value={ruleForm.code} onChange={(e) => setRuleForm({ ...ruleForm, code: e.target.value })} /></label>
              <label className="field"><span>Name</span><input value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} /></label>
              <label className="field"><span>Source domain</span><input value={ruleForm.source_domain} onChange={(e) => setRuleForm({ ...ruleForm, source_domain: e.target.value })} /></label>
              <label className="field"><span>Target domain</span><input value={ruleForm.target_domain} onChange={(e) => setRuleForm({ ...ruleForm, target_domain: e.target.value })} /></label>
              <label className="field"><span>Relationship</span><input value={ruleForm.relationship_type} onChange={(e) => setRuleForm({ ...ruleForm, relationship_type: e.target.value })} /></label>
              <label className="field"><span>Severity</span>
                <select value={ruleForm.severity} onChange={(e) => setRuleForm({ ...ruleForm, severity: e.target.value })}>
                  {(meta?.capabilities?.severities || ["INFO", "WARNING", "ERROR"]).map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !ruleForm.code || !ruleForm.name} onClick={createRule}>Create rule</button>
          </div>
          <div className="panel">
            <h3>Rules ({rules.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Source</th><th>Target</th><th>Severity</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="mono">{rule.code}</td>
                    <td>{rule.name}</td>
                    <td className="mono">{rule.source_domain}</td>
                    <td className="mono">{rule.target_domain}</td>
                    <td className="mono">{rule.severity}</td>
                    <td><Badge tone={toneFor(rule.status)}>{rule.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => toggleRule(rule)}>{rule.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "operations" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Platform operations</h3>
              <div className="stack-row">
                <button className="btn secondary" disabled={busy} onClick={rebuildProjection}>Rebuild projection</button>
                <button className="btn secondary" disabled={busy} onClick={loadHistory}>Load history</button>
              </div>
            </div>
            <div className="chips">
              {meta?.capabilities?.job_types?.map((code) => <Badge key={code} tone="ok">{code}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Submit background jobs</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <button className="btn ghost" disabled={busy || !root} onClick={() => submitJob("submitTraversalJob", { root, options: { include_inactive: includeInactive } })}>Traverse</button>
              <button className="btn ghost" disabled={busy || !root} onClick={() => submitJob("submitImpactJob", { root, options: { include_inactive: includeInactive } })}>Impact</button>
              <button className="btn ghost" disabled={busy || !root} onClick={() => submitJob("submitCompletenessJob", { root, options: { include_inactive: includeInactive } })}>Completeness</button>
              <button className="btn ghost" disabled={busy || !root} onClick={() => submitJob("submitSnapshotJob", { root, include_inactive: includeInactive, name: `Async snapshot ${Date.now()}` })}>Snapshot</button>
              <button className="btn ghost" disabled={busy} onClick={() => submitJob("submitReindexJob", {})}>Reindex</button>
              <button className="btn ghost" disabled={busy} onClick={() => submitJob("submitProjectionRebuildJob", {})}>Projection rebuild</button>
              <button className="btn ghost" disabled={busy} onClick={() => submitJob("submitMaintenanceJob", {})}>Maintenance</button>
            </div>
          </div>

          <div className="panel">
            <h3>Configuration</h3>
            <table className="table">
              <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
              <tbody>
                {Object.entries(configuration).map(([key, value]) => (
                  <tr key={key}>
                    <td className="mono">{key}</td>
                    <td className="mono">{JSON.stringify(value)}</td>
                    <td>
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={() => {
                          const next = window.prompt(`New value for ${key}`, JSON.stringify(value));
                          if (next !== null) saveConfig(key, next);
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Change history ({history.length})</h3>
            <table className="table">
              <thead><tr><th>Entity</th><th>Action</th><th>Status</th><th>Summary</th><th>When</th></tr></thead>
              <tbody>
                {history.map((entry, index) => (
                  <tr key={index}>
                    <td className="mono">{entry.entity_type}:{entry.entity_ref || entry.entity_id}</td>
                    <td className="mono">{entry.action}</td>
                    <td className="mono">{entry.status}</td>
                    <td>{entry.summary}</td>
                    <td className="mono">{entry.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
