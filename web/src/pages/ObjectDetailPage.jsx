import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { objects } from "../api.js";
import FormRenderer from "../components/FormRenderer.jsx";
import ObjectGraphView from "../components/ObjectGraphView.jsx";
import ObjectHistoryPanel from "../components/ObjectHistoryPanel.jsx";

const OBJECT_STATUSES = ["draft", "active", "released", "obsolete", "archived"];
const TABS = [
  ["overview", "Overview"],
  ["relationships", "Relationships"],
  ["references", "References"],
  ["versions", "Versions"],
  ["lifecycle", "Lifecycle"],
  ["history", "History"],
  ["graph", "Graph"],
  ["dependencies", "Dependencies"],
];

function seedValues(tree, data) {
  const next = {};
  for (const field of tree?.fields || []) {
    if (data && data[field.code] !== undefined) next[field.code] = data[field.code];
    else if (field.multi_value) next[field.code] = [];
    else if (field.data_type === "boolean") next[field.code] = field.default === true || field.default === "true";
    else next[field.code] = field.default ?? "";
  }
  return next;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

export default function ObjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [obj, setObj] = useState(null);
  const [locks, setLocks] = useState([]);
  const [relTypes, setRelTypes] = useState([]);
  const [rels, setRels] = useState({ outgoing: [], incoming: [] });
  const [versions, setVersions] = useState([]);
  const [references, setReferences] = useState([]);
  const [deps, setDeps] = useState(null);
  const [impact, setImpact] = useState(null);
  const [safe, setSafe] = useState(null);
  const [tree, setTree] = useState(null);
  const [graph, setGraph] = useState(null);
  const [graphDepth, setGraphDepth] = useState(2);
  const [showRawGraph, setShowRawGraph] = useState(false);
  const [lc, setLc] = useState(null);
  const [history, setHistory] = useState([]);
  const [viewTree, setViewTree] = useState(null);
  const [editTree, setEditTree] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [editName, setEditName] = useState("");
  const [editing, setEditing] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [tab, setTab] = useState("overview");
  const [statusDraft, setStatusDraft] = useState("");
  const [relForm, setRelForm] = useState({ type: "", target: "" });
  const [refForm, setRefForm] = useState({
    reference_type: "weak",
    target: "",
    external_system: "",
    external_ref: "",
    context: "",
    dependency: false,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const o = await objects.get(id);
    setObj(o);
    setStatusDraft(o.status);
    const [lockRes, relTypeRes, relRes, versionRes, depRes, impactRes, safeRes, viewRes, lcRes, historyRes] =
      await Promise.all([
        objects.locks(id),
        objects.relationshipTypes("?pageSize=200"),
        objects.relationships(id),
        objects.versions(id, "?pageSize=200"),
        objects.dependencies(id),
        objects.impact(id),
        objects.safeDelete(id),
        objects.typeForm(o.type.id, "?mode=view"),
        objects.lifecycle(id),
        objects.statusHistory(id, "?pageSize=50"),
      ]);
    const [sourceRefs, targetRefs] = await Promise.all([
      objects.references(`?source_object_id=${id}&pageSize=100`),
      objects.references(`?target_object_id=${id}&pageSize=100`),
    ]);
    setLocks(lockRes.items || []);
    setRelTypes(relTypeRes.items || []);
    setRels(relRes);
    setVersions(versionRes.items || []);
    setDeps(depRes);
    setImpact(impactRes);
    setSafe(safeRes);
    setViewTree(viewRes);
    setLc(lcRes);
    setHistory(historyRes.items || []);
    setReferences([...(sourceRefs.items || []), ...(targetRefs.items || [])]);
    setGraph(null);
    setTree(null);
    setSelectedVersion(null);
  }, [id]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function act(fn, message) {
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      if (message) setNotice(message);
    } catch (err) {
      setError(err.message);
    }
  }

  async function startEdit() {
    setError("");
    try {
      const t = await objects.typeForm(obj.type.id, "?mode=edit");
      setEditTree(t);
      setEditValues(seedValues(t, obj.data));
      setEditName(obj.name);
      setEditing(true);
      setTab("overview");
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    setError("");
    try {
      await objects.update(id, { revision: obj.revision, name: editName, data: editValues });
      setEditing(false);
      setNotice("Object updated.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadVersion(revision) {
    try {
      const version = await objects.version(id, revision);
      setSelectedVersion(version);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadGraph(depth = graphDepth) {
    try {
      const [t, g] = await Promise.all([objects.tree(id, `?depth=${depth}`), objects.graph(id, `?depth=${depth}`)]);
      setTree(t);
      setGraph(g);
    } catch (err) {
      setError(err.message);
    }
  }

  async function runTransition(code) {
    await act(() => objects.transition(id, { transition: code }), "Lifecycle transition applied.");
  }

  async function decideApproval(approvalId, decision) {
    let comment = "";
    if (decision !== "approve") {
      comment = window.prompt("Comment required for this decision:") || "";
    }
    await act(() => objects.decideApproval(id, approvalId, { decision, comment }), `Approval ${decision}.`);
  }

  async function addRelationship(e) {
    e.preventDefault();
    setError("");
    try {
      await objects.createRelationship({ type: relForm.type, source: obj.id, target: Number(relForm.target) });
      setRelForm({ type: "", target: "" });
      setNotice("Relationship created.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addReference(e) {
    e.preventDefault();
    setError("");
    try {
      const payload = { source_object_id: obj.id, reference_type: refForm.reference_type, context: refForm.context, dependency: refForm.dependency };
      if (refForm.reference_type === "external") {
        payload.external_system = refForm.external_system;
        payload.external_ref = refForm.external_ref;
      } else {
        payload.target_object_id = Number(refForm.target);
      }
      await objects.createReference(payload);
      setRefForm({ reference_type: "weak", target: "", external_system: "", external_ref: "", context: "", dependency: false });
      setNotice("Reference created.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function switchTab(key) {
    setTab(key);
    if (key === "graph" && !graph) loadGraph();
  }

  if (!obj) return error ? <div className="error">{error}</div> : null;

  const primaryLock = locks[0] || null;

  return (
    <>
      <div className="topbar">
        <div>
          <Link to="/objects">Objects</Link>
          <h1>{obj.name}</h1>
          <div className="mono">
            {obj.code} · {obj.type?.name} · rev {obj.revision}
          </div>
        </div>
        <div className="inline">
          <span className={`badge ${obj.status === "active" || obj.status === "released" ? "active" : ""}`}>{obj.status}</span>
          {obj.deleted ? <span className="badge locked">deleted</span> : null}
          {obj.locked ? <span className="badge locked">locked</span> : null}
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      <div className="row" style={{ marginBottom: 16 }}>
        <label className="field">
          <span>Set status</span>
          <select value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)} disabled={obj.deleted}>
            {OBJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn secondary"
          disabled={obj.deleted || statusDraft === obj.status}
          onClick={() => act(() => objects.setStatus(id, statusDraft), "Status updated.")}
        >
          Apply status
        </button>
        {primaryLock ? (
          <button className="btn secondary" onClick={() => act(() => objects.checkin(id, {}), "Lock released.")}>
            Unlock
          </button>
        ) : (
          <button
            className="btn secondary"
            disabled={obj.deleted}
            onClick={() => act(() => objects.checkout(id, { reason: "console edit" }), "Checked out.")}
          >
            Check out
          </button>
        )}
        {!obj.deleted ? (
          <>
            <button className="btn secondary" onClick={startEdit}>
              Edit
            </button>
            <button className="btn danger" onClick={() => act(() => objects.remove(id), "Object deleted.")}>
              Delete
            </button>
            <button className="btn danger" onClick={() => act(() => objects.remove(id, true), "Object force deleted.")}>
              Force delete
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => act(() => objects.restore(id), "Object restored.")}>
            Restore
          </button>
        )}
        <button className="btn ghost" onClick={() => navigate("/objects")}>
          Back to list
        </button>
      </div>

      {primaryLock ? (
        <p className="mono">
          Locked by {primaryLock.locked_by_username || primaryLock.locked_by} ({primaryLock.scope})
          {primaryLock.reason ? ` · ${primaryLock.reason}` : ""}
        </p>
      ) : null}

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => switchTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>{editing ? "Edit attributes" : "Attributes"}</h3>
            {editing ? (
              <button className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
          {editing ? (
            <form onSubmit={saveEdit}>
              <label className="field">
                <span>Name</span>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <FormRenderer
                tree={editTree}
                values={editValues}
                onChange={(code, value) => setEditValues((prev) => ({ ...prev, [code]: value }))}
              />
              <button className="btn" style={{ marginTop: 12 }}>
                Save changes
              </button>
            </form>
          ) : viewTree ? (
            <FormRenderer tree={viewTree} values={obj.data} readOnly onChange={() => {}} />
          ) : null}
          <ul className="detail-list" style={{ marginTop: 16 }}>
            <li>Owner: {obj.owner?.display_name || obj.owner?.username || "—"}</li>
            <li>Organization: {obj.organization_id ?? "—"}</li>
            <li>External ref: {obj.external_system ? `${obj.external_system}:${obj.external_ref}` : "—"}</li>
            <li>Created: {obj.created_at} · Updated: {obj.updated_at}</li>
            <li>Tags: {obj.tags?.length ? obj.tags.join(", ") : "—"}</li>
          </ul>
        </div>
      ) : null}

      {tab === "relationships" ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Add relationship</h3>
            </div>
            <form className="row" onSubmit={addRelationship}>
              <label className="field grow">
                <span>Relationship type</span>
                <select value={relForm.type} onChange={(e) => setRelForm({ ...relForm, type: e.target.value })} required>
                  <option value="">Select…</option>
                  {relTypes.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name} ({rt.code}) · {rt.cardinality}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>Target object id</span>
                <input
                  type="number"
                  value={relForm.target}
                  onChange={(e) => setRelForm({ ...relForm, target: e.target.value })}
                  required
                />
              </label>
              <button className="btn">Create edge</button>
            </form>
          </div>
          <div className="panel">
            <h3>Outgoing</h3>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Semantic</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rels.outgoing?.map((rel) => (
                  <tr key={rel.id}>
                    <td className="mono">{rel.relationship_type?.code}</td>
                    <td>
                      <Link to={`/objects/${rel.target?.id}`}>
                        {rel.target?.code}
                      </Link>
                    </td>
                    <td>{rel.relationship_type?.semantic}</td>
                    <td>
                      <button
                        className="btn ghost"
                        onClick={() => act(() => objects.deleteRelationship(rel.id), "Relationship removed.")}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {!rels.outgoing?.length ? (
                  <tr>
                    <td colSpan={4} className="mono">
                      No outgoing relationships.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <h3 style={{ marginTop: 16 }}>Incoming</h3>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Semantic</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rels.incoming?.map((rel) => (
                  <tr key={rel.id}>
                    <td className="mono">{rel.relationship_type?.code}</td>
                    <td>
                      <Link to={`/objects/${rel.source?.id}`}>
                        {rel.source?.code}
                      </Link>
                    </td>
                    <td>{rel.relationship_type?.semantic}</td>
                    <td>
                      <button
                        className="btn ghost"
                        onClick={() => act(() => objects.deleteRelationship(rel.id), "Relationship removed.")}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {!rels.incoming?.length ? (
                  <tr>
                    <td colSpan={4} className="mono">
                      No incoming relationships.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "references" ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Add reference</h3>
            </div>
            <form className="row" onSubmit={addReference}>
              <label className="field">
                <span>Type</span>
                <select
                  value={refForm.reference_type}
                  onChange={(e) => setRefForm({ ...refForm, reference_type: e.target.value })}
                >
                  <option value="weak">weak</option>
                  <option value="strong">strong</option>
                  <option value="external">external</option>
                </select>
              </label>
              {refForm.reference_type === "external" ? (
                <>
                  <label className="field grow">
                    <span>External system</span>
                    <input
                      value={refForm.external_system}
                      onChange={(e) => setRefForm({ ...refForm, external_system: e.target.value })}
                    />
                  </label>
                  <label className="field grow">
                    <span>External ref</span>
                    <input
                      value={refForm.external_ref}
                      onChange={(e) => setRefForm({ ...refForm, external_ref: e.target.value })}
                      required
                    />
                  </label>
                </>
              ) : (
                <label className="field grow">
                  <span>Target object id</span>
                  <input
                    type="number"
                    value={refForm.target}
                    onChange={(e) => setRefForm({ ...refForm, target: e.target.value })}
                    required
                  />
                </label>
              )}
              <label className="field grow">
                <span>Context</span>
                <input value={refForm.context} onChange={(e) => setRefForm({ ...refForm, context: e.target.value })} />
              </label>
              <label className="field">
                <span>Dependency</span>
                <input
                  type="checkbox"
                  checked={refForm.dependency}
                  onChange={(e) => setRefForm({ ...refForm, dependency: e.target.checked })}
                />
              </label>
              <button className="btn">Create reference</button>
            </form>
          </div>
          <div className="panel">
            <h3>References</h3>
            <table>
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Type</th>
                  <th>Peer</th>
                  <th>Context</th>
                  <th>Dependency</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {references.map((ref) => {
                  const outgoing = ref.source?.id === obj.id || ref.source_object_id === obj.id;
                  return (
                    <tr key={`${ref.id}-${outgoing ? "out" : "in"}`}>
                      <td>{outgoing ? "out" : "in"}</td>
                      <td>{ref.reference_type}</td>
                      <td className="mono">
                        {ref.reference_type === "external"
                          ? `${ref.external_system}:${ref.external_ref}`
                          : outgoing
                          ? ref.target?.code || "—"
                          : ref.source?.code || "—"}
                      </td>
                      <td>{ref.context || "—"}</td>
                      <td>{ref.dependency ? "yes" : "no"}</td>
                      <td>
                        {outgoing ? (
                          <button
                            className="btn ghost"
                            onClick={() => act(() => objects.deleteReference(ref.id), "Reference removed.")}
                          >
                            Remove
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!references.length ? (
                  <tr>
                    <td colSpan={6} className="mono">
                      No references.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "versions" ? (
        <div className="split">
          <div className="panel">
            <h3>Revision history</h3>
            <table>
              <thead>
                <tr>
                  <th>Rev</th>
                  <th>Change</th>
                  <th>By</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id} style={{ cursor: "pointer" }} onClick={() => loadVersion(version.revision)}>
                    <td>{version.revision}</td>
                    <td>{version.change_type}</td>
                    <td>{version.created_username || version.created_by || "—"}</td>
                    <td className="mono">{version.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Snapshot</h3>
            {selectedVersion ? (
              <pre className="json">{pretty(selectedVersion.snapshot)}</pre>
            ) : (
              <p className="mono">Select a revision to inspect its snapshot.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "lifecycle" ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Lifecycle</h3>
              {lc?.version ? (
                <span className="mono">
                  {lc.lifecycle?.code} · v{lc.version.version}
                </span>
              ) : null}
            </div>
            {lc?.lifecycle ? (
              <>
                <p className="mono">
                  State: <span className="badge active">{lc.state?.code || lc.object.status}</span>
                  {lc.status ? ` · ${lc.status.label} (${lc.status.category})` : ""}
                </p>
                <div className="row">
                  {(lc.transitions || []).map((t) => (
                    <button key={t.id} className="btn secondary" onClick={() => runTransition(t.code)}>
                      {t.name}
                      {t.requires_approval ? " (approval)" : ""}
                    </button>
                  ))}
                  {!lc.transitions?.length ? <span className="mono">No transitions available.</span> : null}
                </div>
              </>
            ) : (
              <p className="mono">No lifecycle is assigned to this object type.</p>
            )}
          </div>

          {lc?.pending_release ? (
            <div className="panel">
              <h3>Pending release</h3>
              <p className="mono">
                Rule {lc.pending_release.rule_code || lc.pending_release.rule_id} · status {lc.pending_release.status}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Approver</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lc.pending_release.approvals.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.step_code}</td>
                      <td>{a.approver_username || a.approver_id}</td>
                      <td>{a.status}</td>
                      <td>
                        {a.status === "pending" ? (
                          <>
                            <button className="btn ghost" onClick={() => decideApproval(a.id, "approve")}>
                              Approve
                            </button>
                            <button className="btn ghost" onClick={() => decideApproval(a.id, "request_changes")}>
                              Request changes
                            </button>
                            <button className="btn danger" onClick={() => decideApproval(a.id, "reject")}>
                              Reject
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="panel">
            <h3>Status history</h3>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Source</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="mono">{h.created_at}</td>
                    <td>{h.from_status_code || h.from_status || "—"}</td>
                    <td>{h.to_status_code || h.to_status || "—"}</td>
                    <td>
                      {h.source}
                      {h.transition_code ? ` (${h.transition_code})` : ""}
                    </td>
                    <td>{h.actor_username || h.actor_id || "—"}</td>
                  </tr>
                ))}
                {!history.length ? (
                  <tr>
                    <td colSpan={5} className="mono">
                      No status changes recorded.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "history" ? (
        <div className="panel">
          <ObjectHistoryPanel objectType="object" objectId={obj.id} />
        </div>
      ) : null}

      {tab === "graph" ? (
        <>
          <div className="grid" style={{ marginBottom: 16 }}>
            <div className="stat">
              <span className="mono">Nodes</span>
              <b>{graph?.node_count ?? "—"}</b>
            </div>
            <div className="stat">
              <span className="mono">Edges</span>
              <b>{graph?.edge_count ?? "—"}</b>
            </div>
            <div className="stat">
              <span className="mono">Traversal nodes</span>
              <b>{tree?.nodes?.length ?? "—"}</b>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Relationship graph</h3>
              <div className="inline">
                <label className="field" style={{ margin: 0 }}>
                  <span>Depth</span>
                  <select
                    value={graphDepth}
                    onChange={(e) => {
                      const depth = Number(e.target.value);
                      setGraphDepth(depth);
                      loadGraph(depth);
                    }}
                  >
                    {[1, 2, 3, 4].map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn ghost" onClick={() => loadGraph()}>Refresh</button>
                <button className="btn ghost" onClick={() => setShowRawGraph((v) => !v)}>
                  {showRawGraph ? "Hide raw JSON" : "Raw JSON"}
                </button>
              </div>
            </div>
            <ObjectGraphView graph={graph} height={540} />
          </div>
          <div className="split">
            <div className="panel">
              <h3>Reachable nodes (depth {graphDepth})</h3>
              <ul className="detail-list">
                {(tree?.nodes || []).map((node) => (
                  <li key={node.id}>
                    <Link to={`/objects/${node.id}`} className="mono">
                      {node.code}
                    </Link>{" "}
                    {node.name}
                  </li>
                ))}
                {!(tree?.nodes || []).length ? <li className="mono">No reachable nodes.</li> : null}
              </ul>
            </div>
            {showRawGraph ? (
              <div className="panel">
                <h3>Graph projection</h3>
                {graph ? <pre className="json">{pretty(graph)}</pre> : <p className="mono">Loading graph…</p>}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "dependencies" ? (
        <div className="split">
          <div className="panel">
            <h3>Direct dependencies</h3>
            <ul className="detail-list">
              <li>Depends on: {deps?.depends_on?.length || 0}</li>
              <li>Depended on by: {deps?.depended_on_by?.length || 0}</li>
            </ul>
            <h3>Impact analysis</h3>
            <ul className="detail-list">
              {(impact?.impacted || []).map((node) => (
                <li key={node.id}>
                  <Link to={`/objects/${node.id}`} className="mono">
                    {node.code}
                  </Link>{" "}
                  · depth {node.depth} · via {node.via_kind}
                </li>
              ))}
              {!impact?.impacted?.length ? <li className="mono">Nothing depends on this object.</li> : null}
            </ul>
          </div>
          <div className="panel">
            <h3>Delete safety</h3>
            <ul className="detail-list">
              <li>Safe to delete: {safe?.safe ? "yes" : "no"}</li>
              <li>Blockers: {safe?.blockers?.length || 0}</li>
              <li>Composition cascade: {safe?.cascade?.length || 0}</li>
              <li>Orphaned on delete: {safe?.orphaned_on_delete?.length || 0}</li>
            </ul>
            <pre className="json">{pretty(safe)}</pre>
          </div>
        </div>
      ) : null}
    </>
  );
}
