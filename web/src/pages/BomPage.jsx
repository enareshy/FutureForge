import React, { useEffect, useState } from "react";
import { bom } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "revisions", label: "Revisions" },
  { key: "structure", label: "Structure & rollup" },
  { key: "analysis", label: "Where-used & compare" },
  { key: "transformation", label: "Transformation" },
  { key: "baselines", label: "Baselines" },
  { key: "configuration", label: "Configuration" },
  { key: "audit", label: "Audit" },
];

const emptyBom = { bom_number: "", name: "", bom_type: "EBOM", description: "" };
const emptyRevision = { revision_number: "A1" };
const emptyLine = {
  child_object_id: "",
  quantity: "1",
  uom: "EA",
  find_number: "",
  reference_designator: "",
  usage: "DESIGN",
  optional: false,
};

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["RELEASED", "ACTIVE", "FROZEN", "PASS", "ok", "healthy"].includes(status)) return "ok";
  if (["DRAFT", "IN_REVIEW", "PENDING", "WARNING", "degraded"].includes(status)) return "warn";
  if (["OBSOLETE", "SUPERSEDED", "ERROR", "FAILED", "error"].includes(status)) return "danger";
  return undefined;
}

function TreeNode({ node }) {
  const line = node.line || {};
  return (
    <li>
      <div className="stack-row" style={{ alignItems: "center", gap: "0.5rem" }}>
        <span className="mono">{line.find_number || "-"}</span>
        <span className="mono">{line.child_object_id}</span>
        <span className="subtle">x{line.quantity} {line.uom}</span>
        {line.optional ? <Badge tone="warn">optional</Badge> : null}
      </div>
      {node.children?.length ? (
        <ul>
          {node.children.map((child, index) => (
            <TreeNode key={`${child.line?.id || index}`} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function BomPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [boms, setBoms] = useState([]);
  const [revisions, setRevisions] = useState([]);
  const [configuration, setConfiguration] = useState({});
  const [units, setUnits] = useState([]);
  const [rules, setRules] = useState([]);
  const [transformations, setTransformations] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [history, setHistory] = useState([]);

  const [tree, setTree] = useState(null);
  const [lines, setLines] = useState([]);
  const [rollup, setRollup] = useState(null);
  const [validation, setValidation] = useState(null);
  const [uses, setUses] = useState(null);
  const [whereUsedObject, setWhereUsedObject] = useState("");
  const [whereUsedResult, setWhereUsedResult] = useState(null);
  const [compareForm, setCompareForm] = useState({ left_id: "", right_id: "" });
  const [compareResult, setCompareResult] = useState(null);
  const [transformForm, setTransformForm] = useState({ definition_id: "", mode: "DRY_RUN" });
  const [transformResult, setTransformResult] = useState(null);
  const [baselineForm, setBaselineForm] = useState({ baseline_number: "", name: "" });
  const [snapshot, setSnapshot] = useState(null);

  const [bomForm, setBomForm] = useState(emptyBom);
  const [revisionForm, setRevisionForm] = useState(emptyRevision);
  const [lineForm, setLineForm] = useState(emptyLine);
  const [selectedBom, setSelectedBom] = useState("");
  const [selectedRevision, setSelectedRevision] = useState("");

  async function refresh() {
    setError("");
    try {
      const [met, m, h, bs, cfg, un, rl, tr, bl, hs] = await Promise.all([
        bom.meta(),
        bom.metrics(),
        bom.health(),
        bom.boms("?page_size=50"),
        bom.configuration(),
        bom.units(),
        bom.validationRules("?page_size=100"),
        bom.transformations("?page_size=50"),
        bom.baselines("?page_size=50"),
        bom.history("?page_size=50"),
      ]);
      setMeta(met);
      setMetrics(m);
      setHealth(h);
      const bomItems = bs.items || [];
      setBoms(bomItems);
      setConfiguration(cfg || {});
      setUnits(un.items || un || []);
      setRules(rl.items || []);
      setTransformations(tr.items || []);
      setBaselines(bl.items || []);
      setHistory(hs.items || []);
      if (!selectedBom && bomItems[0]) setSelectedBom(bomItems[0].bom_number || String(bomItems[0].id));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRevisions(bomRef) {
    if (!bomRef) return;
    try {
      const result = await bom.bomRevisions(bomRef, "?page_size=50");
      setRevisions(result.items || []);
      const first = (result.items || [])[0];
      if (first) setSelectedRevision(String(first.id));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadRevisions(selectedBom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBom]);

  async function loadRevisionDetail(revisionId) {
    if (!revisionId) return;
    try {
      const [treeResult, lineResult, validationResult, useResult] = await Promise.all([
        bom.revisionTree(revisionId),
        bom.revisionLines(revisionId, "?page_size=200"),
        bom.revisionValidationResults(revisionId, "?page_size=1"),
        bom.uses(`?revision_id=${encodeURIComponent(revisionId)}&page_size=200`),
      ]);
      setTree(treeResult);
      setLines(lineResult.items || []);
      setValidation((validationResult.items || [])[0] || null);
      setUses(useResult);
      setRollup(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadRevisionDetail(selectedRevision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRevision]);

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

  function bind(setter, form, transform = (value) => value) {
    return (event) => setter({ ...form, [event.target.name]: transform(event.target.value) });
  }

  const selectedRevisionRow = revisions.find((entry) => String(entry.id) === String(selectedRevision));
  const selectedBomRow = boms.find((entry) => (entry.bom_number || String(entry.id)) === selectedBom);

  async function createBom() {
    const result = await run(() => bom.createBom({ ...bomForm, bom_type: bomForm.bom_type.toUpperCase() }), "BOM created.");
    if (result) {
      setBomForm(emptyBom);
      await refresh();
      setSelectedBom(result.bom_number || String(result.id));
    }
  }

  async function createRevision() {
    if (!selectedBomRow) return;
    const result = await run(() => bom.createRevision(selectedBomRow.id, revisionForm), "Revision created.");
    if (result) {
      setRevisionForm(emptyRevision);
      await loadRevisions(selectedBom);
      setSelectedRevision(String(result.id));
    }
  }

  async function addLine() {
    if (!selectedRevisionRow) return;
    const result = await run(
      () =>
        bom.createLine(selectedRevisionRow.id, {
          ...lineForm,
          quantity: Number(lineForm.quantity),
          optional: Boolean(lineForm.optional),
        }),
      "Line added."
    );
    if (result) {
      setLineForm(emptyLine);
      await loadRevisionDetail(selectedRevision);
    }
  }

  async function changeRevisionStatus(status) {
    if (!selectedRevisionRow) return;
    await run(() => bom.setRevisionStatus(selectedRevisionRow.id, status), `Revision set to ${status}.`);
    await loadRevisions(selectedBom);
    await loadRevisionDetail(selectedRevision);
  }

  async function reviseRevision() {
    if (!selectedRevisionRow) return;
    const next = window.prompt("New revision number", `${selectedRevisionRow.revision_number}.1`);
    if (!next) return;
    const result = await run(() => bom.reviseRevision(selectedRevisionRow.id, { revision_number: next }), "Revision revised.");
    if (result) {
      await loadRevisions(selectedBom);
      setSelectedRevision(String(result.revision?.id || ""));
    }
  }

  async function computeRollup() {
    if (!selectedRevisionRow) return;
    const result = await run(() => bom.revisionRollup(selectedRevisionRow.id, { options: { includeOptional: true } }), "Rollup computed.");
    setRollup(result);
  }

  async function validateRevision() {
    if (!selectedRevisionRow) return;
    const result = await run(() => bom.revisionValidate(selectedRevisionRow.id, {}), "Validation complete.");
    if (result) await loadRevisionDetail(selectedRevision);
  }

  async function runWhereUsed() {
    if (!whereUsedObject) return;
    const result = await run(() => bom.whereUsed(whereUsedObject.trim(), "?page_size=100"));
    setWhereUsedResult(result);
  }

  async function runCompare() {
    const result = await run(
      () =>
        bom.compare({
          left_kind: "REVISION",
          left_id: Number(compareForm.left_id),
          right_kind: "REVISION",
          right_id: Number(compareForm.right_id),
        }),
      "Comparison complete."
    );
    setCompareResult(result);
  }

  async function runTransform() {
    const definitionId = Number(transformForm.definition_id);
    const body = { definition_id: definitionId, mode: transformForm.mode };
    if (selectedRevisionRow) body.source_revision_id = Number(selectedRevisionRow.id);
    const result = await run(() => bom.transform(body), "Transformation submitted.");
    setTransformResult(result);
    if (result && transformForm.mode === "EXECUTE") await refresh();
  }

  async function createBaseline() {
    if (!selectedRevisionRow) return;
    const result = await run(
      () =>
        bom.createBaseline({
          revision_id: Number(selectedRevisionRow.id),
          baseline_number: baselineForm.baseline_number,
          name: baselineForm.name || baselineForm.baseline_number,
          status: "DRAFT",
        }),
      "Baseline created."
    );
    if (result) {
      setBaselineForm({ baseline_number: "", name: "" });
      await refresh();
    }
  }

  async function freezeBaseline(ref) {
    await run(() => bom.freezeBaseline(ref), "Baseline frozen.");
    await refresh();
    const snap = await run(() => bom.baselineSnapshot(ref));
    setSnapshot(snap);
  }

  async function loadSnapshot(ref) {
    const snap = await run(() => bom.baselineSnapshot(ref));
    setSnapshot(snap);
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => bom.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  async function seedDemo() {
    await run(() => bom.seed(), "Demonstration BOM seeded.");
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Bill of materials</h1>
          <p className="subtle">Enterprise BOM engine: EBOM/MBOM/BOP, revisions, structure, rollup, compare and transformation.</p>
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
            <div className="panel grow"><h3>BOMs</h3><div className="mono">{metrics?.totals?.boms ?? "-"}</div></div>
            <div className="panel grow"><h3>Revisions</h3><div className="mono">{metrics?.totals?.revisions ?? "-"}</div></div>
            <div className="panel grow"><h3>Lines</h3><div className="mono">{metrics?.totals?.lines ?? "-"}</div></div>
            <div className="panel grow"><h3>Substitutes</h3><div className="mono">{metrics?.totals?.substitutes ?? "-"}</div></div>
            <div className="panel grow"><h3>Baselines</h3><div className="mono">{metrics?.totals?.baselines ?? "-"}</div></div>
            <div className="panel grow"><h3>Comparisons</h3><div className="mono">{metrics?.totals?.comparisons ?? "-"}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Health checks</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed demonstration BOM</button>
            </div>
            <div className="chips">
              {(health?.checks || []).map((check) => (
                <Badge key={check.name} tone={check.status === "ok" ? "ok" : "danger"}>{check.name}: {check.status}</Badge>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Create a BOM</h3>
            <div className="grid">
              <label className="field"><span>BOM number</span><input name="bom_number" value={bomForm.bom_number} onChange={bind(setBomForm, bomForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={bomForm.name} onChange={bind(setBomForm, bomForm)} /></label>
              <label className="field"><span>Type</span>
                <select name="bom_type" value={bomForm.bom_type} onChange={bind(setBomForm, bomForm)}>
                  {(meta?.capabilities?.bom_types || ["EBOM", "MBOM", "BOP"]).map((type) => <option key={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={bomForm.description} onChange={bind(setBomForm, bomForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !bomForm.bom_number} onClick={createBom}>Create</button>
          </div>

          <div className="panel">
            <h3>BOM headers ({boms.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Name</th><th>Type</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {boms.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.bom_number}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.bom_type}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => { setSelectedBom(entry.bom_number); setTab("revisions"); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "revisions" ? (
        <>
          <div className="panel">
            <h3>Select a BOM</h3>
            <label className="field">
              <span>BOM</span>
              <select value={selectedBom} onChange={(event) => setSelectedBom(event.target.value)}>
                <option value="">Select…</option>
                {boms.map((entry) => (
                  <option key={entry.id} value={entry.bom_number}>{entry.bom_number} — {entry.name}</option>
                ))}
              </select>
            </label>
          </div>

          {selectedBomRow ? (
            <div className="panel">
              <h3>Create revision for {selectedBomRow.bom_number}</h3>
              <div className="grid">
                <label className="field"><span>Revision</span><input name="revision_number" value={revisionForm.revision_number} onChange={bind(setRevisionForm, revisionForm)} /></label>
              </div>
              <button className="btn" disabled={busy} onClick={createRevision}>Create revision</button>
            </div>
          ) : null}

          <div className="panel">
            <h3>Revisions ({revisions.length})</h3>
            <table className="table">
              <thead><tr><th>Revision</th><th>Status</th><th>Lines</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {revisions.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.revision_number}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.line_count ?? "-"}</td>
                    <td className="subtle">{entry.created_at}</td>
                    <td className="stack-row">
                      <button className="btn ghost" onClick={() => { setSelectedRevision(String(entry.id)); setTab("structure"); }}>Open</button>
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedRevision(String(entry.id)); changeRevisionStatus("IN_REVIEW"); }}>In review</button>
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedRevision(String(entry.id)); changeRevisionStatus("RELEASED"); }}>Release</button>
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
            <h3>Select a revision</h3>
            <label className="field">
              <span>Revision</span>
              <select value={selectedRevision} onChange={(event) => setSelectedRevision(event.target.value)}>
                <option value="">Select…</option>
                {revisions.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.revision_number} ({entry.status})</option>
                ))}
              </select>
            </label>
            {selectedRevisionRow ? (
              <div className="stack-row" style={{ marginTop: "0.5rem" }}>
                <Badge tone={toneFor(selectedRevisionRow.status)}>{selectedRevisionRow.status}</Badge>
                <button className="btn secondary" disabled={busy} onClick={reviseRevision}>Revise</button>
                <button className="btn secondary" disabled={busy} onClick={computeRollup}>Rollup</button>
                <button className="btn secondary" disabled={busy} onClick={validateRevision}>Validate</button>
              </div>
            ) : null}
          </div>

          {selectedRevisionRow ? (
            <div className="panel">
              <h3>Add a line</h3>
              <div className="grid">
                <label className="field"><span>Child object</span><input name="child_object_id" value={lineForm.child_object_id} onChange={bind(setLineForm, lineForm)} /></label>
                <label className="field"><span>Quantity</span><input name="quantity" value={lineForm.quantity} onChange={bind(setLineForm, lineForm)} /></label>
                <label className="field"><span>UOM</span>
                  <select name="uom" value={lineForm.uom} onChange={bind(setLineForm, lineForm)}>
                    {(units.length ? units : [{ code: "EA" }]).map((unit) => <option key={unit.code} value={unit.code}>{unit.code}</option>)}
                  </select>
                </label>
                <label className="field"><span>Find number</span><input name="find_number" value={lineForm.find_number} onChange={bind(setLineForm, lineForm)} /></label>
                <label className="field"><span>Reference designator</span><input name="reference_designator" value={lineForm.reference_designator} onChange={bind(setLineForm, lineForm)} /></label>
                <label className="field"><span>Usage</span>
                  <select name="usage" value={lineForm.usage} onChange={bind(setLineForm, lineForm)}>
                    {(meta?.capabilities?.usages || ["DESIGN"]).map((usage) => <option key={usage}>{usage}</option>)}
                  </select>
                </label>
              </div>
              <button className="btn" disabled={busy || !lineForm.child_object_id} onClick={addLine}>Add line</button>
            </div>
          ) : null}

          <div className="panel">
            <h3>Structure</h3>
            {tree?.roots?.length ? (
              <ul className="bom-tree">
                {tree.roots.map((node, index) => <TreeNode key={node.line?.id || index} node={node} />)}
              </ul>
            ) : <p className="subtle">No lines yet.</p>}
            <p className="subtle">Lines: {tree?.line_count ?? 0} · Max depth: {tree?.max_depth ?? 0}</p>
          </div>

          <div className="panel">
            <h3>Lines ({lines.length})</h3>
            <table className="table">
              <thead><tr><th>Find</th><th>Child</th><th>Qty</th><th>UOM</th><th>Usage</th><th>Optional</th></tr></thead>
              <tbody>
                {lines.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.find_number || "-"}</td>
                    <td className="mono">{entry.child_object_id}</td>
                    <td className="mono">{entry.quantity}</td>
                    <td className="mono">{entry.uom}</td>
                    <td className="mono">{entry.usage}</td>
                    <td>{entry.optional ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rollup ? (
            <div className="panel">
              <h3>Rollup ({rollup.totals?.objects?.length ?? 0} objects)</h3>
              <table className="table">
                <thead><tr><th>Object</th><th>Type</th><th>Quantity</th><th>Occurrences</th></tr></thead>
                <tbody>
                  {(rollup.totals?.objects || []).map((entry) => (
                    <tr key={`${entry.object_type}:${entry.object_id}`}>
                      <td className="mono">{entry.object_id}</td>
                      <td className="mono">{entry.object_type}</td>
                      <td className="mono">{entry.quantity}</td>
                      <td className="mono">{entry.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {validation ? (
            <div className="panel">
              <h3>Validation</h3>
              <div className="stack-row">
                <Badge tone={toneFor(validation.status)}>{validation.status}</Badge>
                <span className="subtle">errors: {validation.error_count ?? 0} · warnings: {validation.warning_count ?? 0}</span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "analysis" ? (
        <>
          <div className="panel">
            <h3>Where-used</h3>
            <div className="stack-row">
              <label className="field grow"><span>Component object id</span><input value={whereUsedObject} onChange={(event) => setWhereUsedObject(event.target.value)} /></label>
              <button className="btn" disabled={busy || !whereUsedObject} onClick={runWhereUsed}>Search</button>
            </div>
            {whereUsedResult ? (
              <table className="table">
                <thead><tr><th>BOM</th><th>Revision</th><th>Find</th><th>Qty</th></tr></thead>
                <tbody>
                  {(whereUsedResult.items || []).map((entry, index) => (
                    <tr key={`${entry.line?.id || index}`}>
                      <td className="mono">{entry.bom?.bom_number}</td>
                      <td className="mono">{entry.revision?.revision_number}</td>
                      <td className="mono">{entry.line?.find_number || "-"}</td>
                      <td className="mono">{entry.line?.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>

          <div className="panel">
            <h3>Compare revisions</h3>
            <div className="grid">
              <label className="field"><span>Left revision id</span><input name="left_id" value={compareForm.left_id} onChange={bind(setCompareForm, compareForm)} /></label>
              <label className="field"><span>Right revision id</span><input name="right_id" value={compareForm.right_id} onChange={bind(setCompareForm, compareForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !compareForm.left_id || !compareForm.right_id} onClick={runCompare}>Compare</button>
            {compareResult ? (
              <div className="chips" style={{ marginTop: "0.5rem" }}>
                <Badge tone="ok">added: {compareResult.comparison?.summary?.added ?? 0}</Badge>
                <Badge tone="danger">removed: {compareResult.comparison?.summary?.removed ?? 0}</Badge>
                <Badge tone="warn">modified: {compareResult.comparison?.summary?.modified ?? 0}</Badge>
                <Badge>unchanged: {compareResult.comparison?.summary?.unchanged ?? 0}</Badge>
              </div>
            ) : null}
          </div>

          {uses ? (
            <div className="panel">
              <h3>Selected revision uses ({uses.total ?? 0})</h3>
              <div className="chips">
                {(uses.items || []).slice(0, 40).map((entry, index) => (
                  <Badge key={entry.line?.id || index}>{entry.line?.child_object_id} x{entry.line?.quantity}</Badge>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "transformation" ? (
        <>
          <div className="panel">
            <h3>Run a transformation</h3>
            <div className="grid">
              <label className="field"><span>Definition</span>
                <select name="definition_id" value={transformForm.definition_id} onChange={bind(setTransformForm, transformForm)}>
                  <option value="">Select…</option>
                  {transformations.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.code} ({entry.source_bom_type}→{entry.target_bom_type})</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Mode</span>
                <select name="mode" value={transformForm.mode} onChange={bind(setTransformForm, transformForm)}>
                  <option value="DRY_RUN">DRY_RUN</option>
                  <option value="EXECUTE">EXECUTE</option>
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !transformForm.definition_id} onClick={runTransform}>Run</button>
            {transformResult ? (
              <p className="subtle" style={{ marginTop: "0.5rem" }}>
                status: {transformResult.run?.status} · mapped: {transformResult.summary?.mapped} · unmapped: {transformResult.summary?.unmapped} · lines: {transformResult.summary?.lines}
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h3>Definitions ({transformations.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Source</th><th>Target</th><th>Status</th></tr></thead>
              <tbody>
                {transformations.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.source_bom_type}</td>
                    <td className="mono">{entry.target_bom_type}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "baselines" ? (
        <>
          {selectedRevisionRow ? (
            <div className="panel">
              <h3>Create a baseline for {selectedRevisionRow.revision_number}</h3>
              <div className="grid">
                <label className="field"><span>Baseline number</span><input name="baseline_number" value={baselineForm.baseline_number} onChange={bind(setBaselineForm, baselineForm)} /></label>
                <label className="field"><span>Name</span><input name="name" value={baselineForm.name} onChange={bind(setBaselineForm, baselineForm)} /></label>
              </div>
              <button className="btn" disabled={busy || !baselineForm.baseline_number} onClick={createBaseline}>Create baseline</button>
            </div>
          ) : <div className="panel"><p className="subtle">Open a revision in the Structure tab to create a baseline.</p></div>}

          <div className="panel">
            <h3>Baselines ({baselines.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Lines</th><th></th></tr></thead>
              <tbody>
                {baselines.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.baseline_number}</td>
                    <td>{entry.name}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.line_count ?? "-"}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => loadSnapshot(entry.id)}>Snapshot</button>
                      {entry.status !== "FROZEN" ? <button className="btn ghost" disabled={busy} onClick={() => freezeBaseline(entry.id)}>Freeze</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {snapshot ? (
              <p className="subtle" style={{ marginTop: "0.5rem" }}>
                {snapshot.baseline?.baseline_number}: {snapshot.lines?.length ?? 0} frozen lines
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <>
          <div className="panel">
            <h3>BOM configuration</h3>
            <table className="table">
              <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
              <tbody>
                {Object.entries(configuration).map(([key, value]) => (
                  <ConfigRow key={key} configKey={key} value={value} disabled={busy} onSave={saveConfig} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Validation rules ({rules.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Type</th><th>Severity</th><th>Status</th></tr></thead>
              <tbody>
                {rules.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td className="mono">{entry.rule_type}</td>
                    <td><Badge tone={entry.severity === "ERROR" ? "danger" : entry.severity === "WARNING" ? "warn" : "ok"}>{entry.severity}</Badge></td>
                    <td className="mono">{entry.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "audit" ? (
        <div className="panel">
          <h3>Change history ({history.length})</h3>
          <table className="table">
            <thead><tr><th>Entity</th><th>Ref</th><th>Action</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.entity_type}</td>
                  <td className="mono">{entry.entity_ref}</td>
                  <td className="mono">{entry.action}</td>
                  <td className="mono">{entry.status}</td>
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

function ConfigRow({ configKey, value, disabled, onSave }) {
  const [draft, setDraft] = useState(typeof value === "object" ? JSON.stringify(value) : String(value));
  return (
    <tr>
      <td className="mono">{configKey}</td>
      <td><input value={draft} onChange={(event) => setDraft(event.target.value)} /></td>
      <td><button className="btn ghost" disabled={disabled} onClick={() => onSave(configKey, draft)}>Save</button></td>
    </tr>
  );
}
