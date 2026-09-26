import React, { useEffect, useState } from "react";
import { pdm } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "items", label: "Items & parts" },
  { key: "revisions", label: "Revisions" },
  { key: "structure", label: "Structure" },
  { key: "analysis", label: "Where-used" },
  { key: "rules", label: "Revision rules" },
  { key: "baselines", label: "Baselines" },
  { key: "validation", label: "Validation" },
  { key: "configuration", label: "Configuration" },
  { key: "audit", label: "Audit" },
];

const emptyItem = { item_number: "", name: "", item_type: "PART", description: "" };
const emptyRevision = { revision_number: "A1" };
const emptyBaseline = { baseline_number: "", name: "" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["RELEASED", "ACTIVE", "FROZEN", "PASS", "ok", "healthy"].includes(status)) return "ok";
  if (["DRAFT", "IN_WORK", "IN_REVIEW", "PENDING", "WARNING", "degraded"].includes(status)) return "warn";
  if (["OBSOLETE", "SUPERSEDED", "RETIRED", "ERROR", "FAILED", "error"].includes(status)) return "danger";
  return undefined;
}

export default function PdmPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [items, setItems] = useState([]);
  const [revisions, setRevisions] = useState([]);
  const [revisionRules, setRevisionRules] = useState([]);
  const [configurationRules, setConfigurationRules] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [validationRules, setValidationRules] = useState([]);
  const [validationResults, setValidationResults] = useState([]);
  const [validationDetail, setValidationDetail] = useState(null);
  const [history, setHistory] = useState([]);

  const [itemForm, setItemForm] = useState(emptyItem);
  const [revisionForm, setRevisionForm] = useState(emptyRevision);
  const [baselineForm, setBaselineForm] = useState(emptyBaseline);
  const [selectedItem, setSelectedItem] = useState("");
  const [selectedRevision, setSelectedRevision] = useState("");
  const [structure, setStructure] = useState(null);
  const [whereUsedRef, setWhereUsedRef] = useState("");
  const [whereUsed, setWhereUsed] = useState(null);
  const [resolveContext, setResolveContext] = useState('{"variant_code":"STANDARD"}');
  const [resolveResult, setResolveResult] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, h, m, cfg, it, rv, rr, cr, bl, vr] = await Promise.all([
        pdm.meta(),
        pdm.health(),
        pdm.metrics(),
        pdm.configuration(),
        pdm.items("?page_size=100"),
        pdm.revisions("?page_size=100"),
        pdm.revisionRules("?page_size=100"),
        pdm.configurationRules("?page_size=100"),
        pdm.baselines("?page_size=100"),
        pdm.validationRules("?page_size=100"),
      ]);
      setMeta(met);
      setHealth(h);
      setMetrics(m);
      setConfiguration(cfg || {});
      setItems(it.items || []);
      setRevisions(rv.items || []);
      setRevisionRules(rr.items || []);
      setConfigurationRules(cr.items || []);
      setBaselines(bl.items || []);
      setValidationRules(vr.items || []);
      const results = await pdm.validationResults("?page_size=50");
      setValidationResults(results.items || []);
      if (!selectedItem && (it.items || [])[0]) setSelectedItem(String(it.items[0].id));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function bind(setter, form, transform = (value) => value) {
    return (event) => setter({ ...form, [event.target.name]: transform(event.target.value) });
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

  const selectedItemRow = items.find((entry) => String(entry.id) === String(selectedItem));
  const selectedRevisionRow = revisions.find((entry) => String(entry.id) === String(selectedRevision));
  const itemRevisions = revisions.filter((entry) => (selectedItemRow ? entry.item_id === selectedItemRow.id : false));

  useEffect(() => {
    if (!selectedItemRow) {
      setStructure(null);
      setWhereUsed(null);
      return;
    }
    run(async () => {
      const [tree, used] = await Promise.all([
        pdm.itemStructure(selectedItemRow.item_ref, "?rule_code=DEMO-LATEST-RELEASED"),
        pdm.itemWhereUsed(selectedItemRow.item_ref),
      ]);
      setStructure(tree);
      setWhereUsed(used);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem]);

  async function createItem() {
    const result = await run(() => pdm.createItem({ ...itemForm, item_type: itemForm.item_type.toUpperCase() }), "Item created.");
    if (result) {
      setItemForm(emptyItem);
      await refresh();
      setSelectedItem(String(result.id));
    }
  }

  async function createRevision() {
    if (!selectedItemRow) return;
    const result = await run(() => pdm.createRevision(selectedItemRow.item_ref, revisionForm), "Revision created.");
    if (result) {
      setRevisionForm(emptyRevision);
      await refresh();
      setSelectedRevision(String(result.id));
    }
  }

  async function changeRevisionStatus(entry, status) {
    await run(() => pdm.setRevisionStatus(entry.revision_ref, status), `Revision ${entry.revision_number} -> ${status}.`);
    await refresh();
  }

  async function reviseRevision(entry) {
    await run(() => pdm.reviseRevision(entry.revision_ref, {}), "Successor revision created.");
    await refresh();
  }

  async function validateRevision(entry) {
    const result = await run(() => pdm.revisionValidate(entry.revision_ref), "Revision validated.");
    if (result) setValidationDetail(result);
  }

  async function runWhereUsed(ref) {
    const result = await run(() => pdm.whereUsed(ref));
    if (result) setWhereUsed(result);
  }

  async function resolveRevision() {
    let context = {};
    try {
      context = JSON.parse(resolveContext || "{}");
    } catch {
      context = {};
    }
    const result = await run(() =>
      pdm.resolveRevisionRule({ item_id: selectedItemRow?.id, rule_code: "DEMO-LATEST-RELEASED", context })
    );
    if (result) setResolveResult(result);
  }

  async function evaluateConfiguration() {
    let context = {};
    try {
      context = JSON.parse(resolveContext || "{}");
    } catch {
      context = {};
    }
    const result = await run(() => pdm.evaluateConfigurationRules({ context }));
    if (result) setResolveResult(result);
  }

  async function createBaseline() {
    const result = await run(() => pdm.createBaseline({ ...baselineForm, name: baselineForm.name || baselineForm.baseline_number }), "Baseline created.");
    if (result) {
      setBaselineForm(emptyBaseline);
      await refresh();
    }
  }

  async function baselineAction(entry, action) {
    await run(() => action(entry.baseline_ref || entry.baseline_number), "Baseline updated.");
    await refresh();
  }

  async function runTenantValidation() {
    const result = await run(() => pdm.runValidation({ scope: "TENANT" }), "Tenant validation complete.");
    if (result) {
      setValidationDetail(result);
      await refresh();
    }
  }

  async function openValidation(entry) {
    const detail = await run(() => pdm.validationResult(entry.id));
    if (detail) setValidationDetail(detail);
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => pdm.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  async function loadHistory() {
    const result = await run(() => pdm.history("?page_size=100"));
    if (result) setHistory(result.items || []);
  }

  async function seedDemo() {
    await run(() => pdm.seed(), "Demonstration PDM data seeded.");
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Product data management</h1>
          <p className="subtle">PDM domain: items and revisions, parts/products, datasets, representations, design data, CAD associations, revision and configuration rules, baselines, where-used and validation.</p>
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
            <div className="panel grow"><h3>Items</h3><div className="mono">{metrics?.totals?.items ?? "-"}</div></div>
            <div className="panel grow"><h3>Revisions</h3><div className="mono">{metrics?.totals?.revisions ?? "-"}</div></div>
            <div className="panel grow"><h3>Datasets</h3><div className="mono">{metrics?.totals?.datasets ?? "-"}</div></div>
            <div className="panel grow"><h3>Representations</h3><div className="mono">{metrics?.totals?.representations ?? "-"}</div></div>
            <div className="panel grow"><h3>CAD links</h3><div className="mono">{metrics?.totals?.cad_associations ?? "-"}</div></div>
            <div className="panel grow"><h3>Baselines</h3><div className="mono">{metrics?.totals?.baselines ?? "-"}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Health checks</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed demonstration product</button>
            </div>
            <div className="chips">
              {(health?.checks || []).map((check) => (
                <Badge key={check.name} tone={check.status === "ok" ? "ok" : "danger"}>{check.name}: {check.status}</Badge>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Create an item</h3>
            <div className="grid">
              <label className="field"><span>Item number</span><input name="item_number" value={itemForm.item_number} onChange={bind(setItemForm, itemForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={itemForm.name} onChange={bind(setItemForm, itemForm)} /></label>
              <label className="field"><span>Type</span>
                <select name="item_type" value={itemForm.item_type} onChange={bind(setItemForm, itemForm)}>
                  {(meta?.capabilities?.item_types || ["PART", "PRODUCT", "ASSEMBLY", "DOCUMENT"]).map((type) => <option key={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={itemForm.description} onChange={bind(setItemForm, itemForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !itemForm.item_number} onClick={createItem}>Create</button>
          </div>

          <div className="panel">
            <h3>Items ({items.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.item_number}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.item_type}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => { setSelectedItem(String(entry.id)); setTab("revisions"); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "items" ? (
        <>
          <div className="panel">
            <h3>Select an item</h3>
            <label className="field">
              <span>Item</span>
              <select value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)}>
                <option value="">Select…</option>
                {items.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.item_number} — {entry.name}</option>
                ))}
              </select>
            </label>
          </div>
          {selectedItemRow ? (
            <div className="panel">
              <h3>{selectedItemRow.item_number}</h3>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone={toneFor(selectedItemRow.status)}>{selectedItemRow.status}</Badge>
                <span className="subtle mono">{selectedItemRow.item_type}</span>
                <span className="subtle mono">{selectedItemRow.item_ref}</span>
              </div>
              <p className="subtle">{selectedItemRow.description}</p>
              <div className="stack-row">
                {["DRAFT", "IN_WORK", "RELEASED", "OBSOLETE"].map((status) => (
                  <button key={status} className="btn ghost" disabled={busy} onClick={() => run(() => pdm.setItemStatus(selectedItemRow.item_ref, status), `Item -> ${status}.`).then(refresh)}>{status}</button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "revisions" ? (
        <>
          <div className="panel">
            <h3>Select an item</h3>
            <label className="field">
              <span>Item</span>
              <select value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)}>
                <option value="">Select…</option>
                {items.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.item_number} — {entry.name}</option>
                ))}
              </select>
            </label>
          </div>

          {selectedItemRow ? (
            <div className="panel">
              <h3>Create revision for {selectedItemRow.item_number}</h3>
              <div className="grid">
                <label className="field"><span>Revision</span><input name="revision_number" value={revisionForm.revision_number} onChange={bind(setRevisionForm, revisionForm)} /></label>
              </div>
              <button className="btn" disabled={busy} onClick={createRevision}>Create revision</button>
            </div>
          ) : null}

          <div className="panel">
            <h3>Revisions ({itemRevisions.length})</h3>
            <table className="table">
              <thead><tr><th>Revision</th><th>Status</th><th>Sequence</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {itemRevisions.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.revision_number}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.revision_sequence}</td>
                    <td className="subtle">{entry.created_at}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedRevision(String(entry.id)); setTab("structure"); }}>Open</button>
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedRevision(String(entry.id)); changeRevisionStatus(entry, "IN_REVIEW"); }}>In review</button>
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedRevision(String(entry.id)); changeRevisionStatus(entry, "RELEASED"); }}>Release</button>
                      <button className="btn ghost" disabled={busy} onClick={() => reviseRevision(entry)}>Revise</button>
                      <button className="btn ghost" disabled={busy} onClick={() => validateRevision(entry)}>Validate</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "structure" ? (
        <>
          <div className="panel">
            <h3>Select an item</h3>
            <label className="field">
              <span>Item</span>
              <select value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)}>
                <option value="">Select…</option>
                {items.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.item_number} — {entry.name}</option>
                ))}
              </select>
            </label>
            {selectedRevisionRow ? <p className="subtle">Focus revision: <span className="mono">{selectedRevisionRow.revision_number}</span></p> : null}
          </div>

          {structure ? (
            <div className="panel">
              <div className="stack-row" style={{ justifyContent: "space-between" }}>
                <h3>Resolved structure</h3>
                <div className="stack-row">
                  <Badge tone="ok">{structure.node_count} nodes</Badge>
                  <Badge tone="warn">{structure.edge_count} edges</Badge>
                  {structure.truncated ? <Badge tone="danger">truncated</Badge> : null}
                </div>
              </div>
              <table className="table">
                <thead><tr><th>Level</th><th>Item</th><th>Revision</th><th>Status</th><th>Qty</th><th>Path</th></tr></thead>
                <tbody>
                  {(structure.nodes || []).map((node) => (
                    <tr key={`${node.item_id}-${node.path}`}>
                      <td className="mono">{node.level}</td>
                      <td className="mono">{node.item_number}</td>
                      <td className="mono">{node.revision_number || "-"}</td>
                      <td><Badge tone={toneFor(node.revision_status || node.status)}>{node.revision_status || node.status}</Badge></td>
                      <td className="mono">{node.quantity ?? 1}</td>
                      <td className="subtle mono">{node.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "analysis" ? (
        <>
          <div className="panel">
            <h3>Where-used</h3>
            <div className="stack-row">
              <label className="field grow"><span>Item reference or number</span><input value={whereUsedRef} onChange={(event) => setWhereUsedRef(event.target.value)} placeholder="DEMO-SEAL-004" /></label>
              <button className="btn" disabled={busy || !whereUsedRef} onClick={() => runWhereUsed(whereUsedRef)}>Analyse</button>
            </div>
            {whereUsed ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
                  <Badge tone="ok">{whereUsed.immediate_parent_count} immediate parents</Badge>
                  <Badge tone="warn">{whereUsed.node_count} nodes</Badge>
                  <Badge tone="ok">{whereUsed.edge_count} edges</Badge>
                  {whereUsed.truncated ? <Badge tone="danger">truncated</Badge> : null}
                </div>
                <h4>Top level</h4>
                <ul>
                  {(whereUsed.top_level || []).map((entry) => (
                    <li key={entry.item_id} className="mono">{entry.item_number} — {entry.name}</li>
                  ))}
                </ul>
                <h4>Parents</h4>
                <table className="table">
                  <thead><tr><th>Level</th><th>Parent</th><th>Relationship</th><th>Type</th></tr></thead>
                  <tbody>
                    {(whereUsed.nodes || []).filter((node) => node.level > 0).map((node) => (
                      <tr key={`${node.item_id}-${node.path}`}>
                        <td className="mono">{node.level}</td>
                        <td className="mono">{node.item_number}</td>
                        <td className="mono">{node.relationship_id}</td>
                        <td className="mono">{node.relationship_type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "rules" ? (
        <>
          <div className="panel">
            <h3>Revision rules ({revisionRules.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Type</th><th>Status</th><th>Default</th><th>Version</th><th></th></tr></thead>
              <tbody>
                {revisionRules.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td className="mono">{entry.rule_type}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.is_default ? "yes" : "no"}</td>
                    <td className="mono">{entry.version_number}</td>
                    <td><button className="btn ghost" disabled={busy || entry.status === "ACTIVE"} onClick={() => run(() => pdm.activateRevisionRule(entry.rule_ref), "Rule activated.").then(refresh)}>Activate</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Resolve a revision</h3>
            <label className="field"><span>Context (JSON)</span><input value={resolveContext} onChange={(event) => setResolveContext(event.target.value)} /></label>
            <button className="btn" disabled={busy || !selectedItemRow} onClick={resolveRevision}>Resolve for selected item</button>
            {resolveResult?.revision !== undefined ? (
              <p className="subtle">Resolved revision: <span className="mono">{resolveResult.revision?.revision_number || "none"}</span> via <span className="mono">{resolveResult.rule?.code}</span></p>
            ) : null}
          </div>

          <div className="panel">
            <h3>Configuration rules ({configurationRules.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Type</th><th>Status</th><th>Default</th><th></th></tr></thead>
              <tbody>
                {configurationRules.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td className="mono">{entry.rule_type}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.is_default ? "yes" : "no"}</td>
                    <td><button className="btn ghost" disabled={busy || entry.status === "ACTIVE"} onClick={() => run(() => pdm.activateConfigurationRule(entry.rule_ref), "Rule activated.").then(refresh)}>Activate</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn secondary" disabled={busy} onClick={evaluateConfiguration}>Evaluate against context</button>
            {resolveResult?.matched ? <p className="subtle">{resolveResult.matched.length} rule(s) matched.</p> : null}
          </div>
        </>
      ) : null}

      {tab === "baselines" ? (
        <>
          <div className="panel">
            <h3>Create a baseline</h3>
            <div className="grid">
              <label className="field"><span>Baseline number</span><input name="baseline_number" value={baselineForm.baseline_number} onChange={bind(setBaselineForm, baselineForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={baselineForm.name} onChange={bind(setBaselineForm, baselineForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !baselineForm.baseline_number} onClick={createBaseline}>Create</button>
          </div>

          <div className="panel">
            <h3>Baselines ({baselines.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {baselines.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.baseline_number}</td>
                    <td>{entry.name}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="subtle">{entry.baseline_date || "-"}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy || entry.status !== "DRAFT"} onClick={() => baselineAction(entry, pdm.releaseBaseline)}>Release</button>
                      <button className="btn ghost" disabled={busy || entry.status !== "RELEASED"} onClick={() => baselineAction(entry, pdm.freezeBaseline)}>Freeze</button>
                      <button className="btn ghost" disabled={busy || entry.status === "RETIRED"} onClick={() => baselineAction(entry, pdm.retireBaseline)}>Retire</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "validation" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Validation rules ({validationRules.length})</h3>
              <button className="btn" disabled={busy} onClick={runTenantValidation}>Run tenant validation</button>
            </div>
            <div className="chips">
              {validationRules.map((entry) => <Badge key={entry.id} tone="ok">{entry.code} ({entry.severity})</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Validation results ({validationResults.length})</h3>
            <table className="table">
              <thead><tr><th>Scope</th><th>Status</th><th>Issues</th><th>Errors</th><th>Warnings</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {validationResults.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.scope}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.issue_count}</td>
                    <td className="mono">{entry.error_count}</td>
                    <td className="mono">{entry.warning_count}</td>
                    <td className="subtle">{entry.created_at}</td>
                    <td><button className="btn ghost" onClick={() => openValidation(entry)}>Inspect</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {validationDetail?.issues ? (
              <table className="table">
                <thead><tr><th>Rule</th><th>Severity</th><th>Message</th><th>Field</th></tr></thead>
                <tbody>
                  {validationDetail.issues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="mono">{issue.rule_code}</td>
                      <td><Badge tone={toneFor(issue.severity)}>{issue.severity}</Badge></td>
                      <td>{issue.message}</td>
                      <td className="mono">{issue.field}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Domain configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td><input defaultValue={typeof value === "object" ? JSON.stringify(value) : String(value)} onBlur={(event) => saveConfig(key, event.target.value)} /></td>
                  <td className="subtle">edit to update</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "audit" ? (
        <div className="panel">
          <div className="stack-row" style={{ justifyContent: "space-between" }}>
            <h3>Change history</h3>
            <button className="btn secondary" disabled={busy} onClick={loadHistory}>Load history</button>
          </div>
          <table className="table">
            <thead><tr><th>Entity</th><th>Ref</th><th>Action</th><th>Status</th><th>Actor</th><th>When</th></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.entity_type}</td>
                  <td className="mono">{entry.entity_ref}</td>
                  <td className="mono">{entry.action}</td>
                  <td className="mono">{entry.status}</td>
                  <td className="mono">{entry.actor_user_id ?? "-"}</td>
                  <td className="subtle">{entry.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
