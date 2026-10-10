import React, { useEffect, useState } from "react";
import {
  requirementManufacturing,
  requirements,
  pdm,
  bom,
  objects,
  classification,
  content,
} from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "allocations", label: "Allocations" },
  { key: "ebomMbom", label: "EBOM / MBOM" },
  { key: "bop", label: "BOP / Operations" },
  { key: "characteristics", label: "Characteristics & CTQ" },
  { key: "matrix", label: "Matrix & gaps" },
  { key: "impact", label: "Change impact" },
  { key: "trace", label: "Traceability" },
  { key: "configuration", label: "Configuration" },
];

const NAVIGATION_TYPES = [
  "requirement",
  "pdm_item",
  "pdm_revision",
  "bom_revision",
  "operation",
  "work_center",
  "characteristic",
  "content",
];

const TARGET_LOADERS = {
  pdm_item: () => pdm.items("?page_size=200"),
  pdm_revision: () => pdm.revisions("?page_size=200"),
  bom_revision: () => bom.revisions("?page_size=200"),
  operation: () => objects.list("?type=operation&pageSize=200"),
  work_center: () => objects.list("?type=work_center&pageSize=200"),
  characteristic: () => classification.characteristics("?page_size=200"),
  content: () => content.list("?page_size=200"),
};

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function coverageTone(status) {
  if (status === "COVERED") return "ok";
  if (status === "PARTIAL") return "warn";
  if (status === "GAP" || status === "UNALLOCATED") return "danger";
  return undefined;
}

function linkTone(status) {
  if (status === "VALID") return "ok";
  if (status === "MISSING_LINK") return "warn";
  if (status === "INVALID_LINK" || status === "NOT_EFFECTIVE") return "danger";
  return undefined;
}

function severityTone(severity) {
  if (severity === "ERROR") return "danger";
  if (severity === "WARNING") return "warn";
  return undefined;
}

function goalLabel(entry) {
  if (!entry) return "-";
  return entry.code || entry.number || entry.ref || entry.object_id || entry.id || "-";
}

function objectLabel(entry) {
  if (!entry) return "-";
  const id = entry.item_number || entry.revision_number || entry.code || entry.number || entry.ref || entry.id;
  const name = entry.name || entry.title || entry.display_name || "";
  return name ? `${id} — ${name}` : String(id ?? "-");
}

function requirementLabel(entry) {
  if (!entry) return "-";
  return `${entry.requirement_number || entry.number || entry.requirement_ref} — ${entry.title || ""}`;
}

export default function RequirementManufacturingPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [reqItems, setReqItems] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [targets, setTargets] = useState({});

  const [form, setForm] = useState({ requirement_id: "", relationship_type: "", target_type: "", target_id: "" });
  const [coverageRef, setCoverageRef] = useState("");
  const [forwardCoverage, setForwardCoverage] = useState(null);

  const [ebomRef, setEbomRef] = useState("");
  const [ebomMappings, setEbomMappings] = useState(null);
  const [mbomRef, setMbomRef] = useState("");
  const [mbomSources, setMbomSources] = useState(null);
  const [bomRevRef, setBomRevRef] = useState("");
  const [bomTransformations, setBomTransformations] = useState(null);
  const [bomRevisions, setBomRevisions] = useState([]);

  const [bopRef, setBopRef] = useState("");
  const [bopOps, setBopOps] = useState(null);
  const [bopSeq, setBopSeq] = useState(null);
  const [bopCoverage, setBopCoverage] = useState(null);
  const [opRef, setOpRef] = useState("");
  const [opWorkCenters, setOpWorkCenters] = useState(null);
  const [opMbomItems, setOpMbomItems] = useState(null);
  const [opChars, setOpChars] = useState(null);
  const [opLinks, setOpLinks] = useState({ work_center_id: "", mbom_item_id: "", predecessor_id: "" });
  const [mbomProcRef, setMbomProcRef] = useState("");
  const [mbomProcCoverage, setMbomProcCoverage] = useState(null);

  const [ctqRef, setCtqRef] = useState("");
  const [reqCtqs, setReqCtqs] = useState(null);
  const [ctqCoverage, setCtqCoverage] = useState(null);

  const [matrix, setMatrix] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [gapRule, setGapRule] = useState("");
  const [reqGapsRef, setReqGapsRef] = useState("");
  const [reqGaps, setReqGaps] = useState(null);

  const [impactRef, setImpactRef] = useState("");
  const [requirementImpact, setRequirementImpact] = useState(null);
  const [nodeImpactForm, setNodeImpactForm] = useState({ node_type: "operation", node_id: "", analyze: true });
  const [nodeImpact, setNodeImpact] = useState(null);
  const [jobResult, setJobResult] = useState(null);

  const [traceForm, setTraceForm] = useState({ object_type: "requirement", object_id: "", direction: "forward", max_depth: 6 });
  const [trace, setTrace] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, h, cfg, reqs, allocs, revs] = await Promise.all([
        requirementManufacturing.meta(),
        requirementManufacturing.health(),
        requirementManufacturing.configuration(),
        requirements.list("?page_size=200"),
        requirementManufacturing.allocations("?page_size=200"),
        bom.revisions("?page_size=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setReqItems(reqs.items || []);
      setAllocations(allocs.items || []);
      setBomRevisions(revs.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function bind(setter, state) {
    return (event) => setter({ ...state, [event.target.name]: event.target.value });
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

  function allocationTypes() {
    return meta?.allocation_types || [];
  }

  function targetTypesFor(relationshipType) {
    const entry = allocationTypes().find((item) => item.code === relationshipType);
    return entry?.target_types || [];
  }

  async function loadTargets(targetType) {
    if (!targetType || targets[targetType]) return;
    const loader = TARGET_LOADERS[targetType];
    if (!loader) return;
    await run(async () => {
      const result = await loader();
      setTargets((prev) => ({ ...prev, [targetType]: result.items || [] }));
    });
  }

  function onRelationshipChange(event) {
    const relationship_type = event.target.value;
    const target_type = targetTypesFor(relationship_type)[0] || "";
    setForm({ ...form, relationship_type, target_type, target_id: "" });
    if (target_type) loadTargets(target_type);
  }

  async function createAllocation() {
    const result = await run(
      () => requirementManufacturing.createAllocation({ ...form, requirement_id: Number(form.requirement_id) }),
      "Allocation created."
    );
    if (result) {
      setForm({ requirement_id: "", relationship_type: "", target_type: "", target_id: "" });
      await refresh();
    }
  }

  async function removeAllocation(entry) {
    await run(() => requirementManufacturing.removeAllocation(entry.allocation_ref), "Allocation removed.");
    await refresh();
  }

  async function loadForwardCoverage(ref) {
    setCoverageRef(ref);
    if (!ref) {
      setForwardCoverage(null);
      return;
    }
    const result = await run(() => requirementManufacturing.requirementCoverage(ref));
    setForwardCoverage(result);
  }

  function findBomRevision(ref) {
    return bomRevisions.find((entry) => String(entry.revision_ref) === String(ref) || String(entry.id) === String(ref));
  }

  async function loadEbomMappings(ref) {
    setEbomRef(ref);
    if (!ref) return setEbomMappings(null);
    const result = await run(() => requirementManufacturing.ebomMbomMappings(ref, "?page_size=200"));
    setEbomMappings(result);
  }

  async function loadMbomSources(ref) {
    setMbomRef(ref);
    if (!ref) return setMbomSources(null);
    const result = await run(() => requirementManufacturing.mbomEbomSources(ref, "?page_size=200"));
    setMbomSources(result);
  }

  async function loadBomTransformations(ref) {
    setBomRevRef(ref);
    if (!ref) return setBomTransformations(null);
    const result = await run(() => requirementManufacturing.bomTransformations(ref));
    setBomTransformations(result);
  }

  async function loadBop(ref) {
    setBopRef(ref);
    if (!ref) {
      setBopOps(null);
      setBopSeq(null);
      setBopCoverage(null);
      return;
    }
    await run(async () => {
      const [ops, seq, cov] = await Promise.all([
        requirementManufacturing.bopOperations(ref, "?page_size=200"),
        requirementManufacturing.bopSequence(ref, "?page_size=200"),
        requirementManufacturing.bopCoverage(ref),
      ]);
      setBopOps(ops);
      setBopSeq(seq);
      setBopCoverage(cov);
    });
  }

  async function loadOperation(ref) {
    setOpRef(ref);
    if (!ref) {
      setOpWorkCenters(null);
      setOpMbomItems(null);
      setOpChars(null);
      return;
    }
    await run(async () => {
      const [wc, items, chars] = await Promise.all([
        requirementManufacturing.operationWorkCenters(ref, "?page_size=200"),
        requirementManufacturing.operationMbomItems(ref, "?page_size=200"),
        requirementManufacturing.operationCharacteristics(ref, "?page_size=200"),
      ]);
      setOpWorkCenters(wc);
      setOpMbomItems(items);
      setOpChars(chars);
    });
  }

  async function linkWorkCenter() {
    const result = await run(
      () => requirementManufacturing.linkOperationWorkCenter(opRef, { work_center_id: opLinks.work_center_id }),
      "Work center linked."
    );
    if (result) await loadOperation(opRef);
  }

  async function linkMbomItem() {
    const result = await run(
      () => requirementManufacturing.linkOperationMbomItem(opRef, { mbom_item_id: opLinks.mbom_item_id }),
      "MBOM item linked."
    );
    if (result) await loadOperation(opRef);
  }

  async function linkPredecessor() {
    const result = await run(
      () => requirementManufacturing.linkOperationPrecedence(opRef, { predecessor_id: opLinks.predecessor_id }),
      "Precedence linked."
    );
    if (result) await loadOperation(opRef);
  }

  async function loadMbomProcessCoverage(ref) {
    setMbomProcRef(ref);
    if (!ref) return setMbomProcCoverage(null);
    const result = await run(() => requirementManufacturing.mbomProcessCoverage(ref, "?page_size=200"));
    setMbomProcCoverage(result);
  }

  async function loadReqCtqs(ref) {
    setCtqRef(ref);
    if (!ref) return setReqCtqs(null);
    const result = await run(() => requirementManufacturing.requirementCtqs(ref, "?includeNonCtq=true"));
    setReqCtqs(result);
  }

  async function loadCtqCoverage() {
    const result = await run(() => requirementManufacturing.ctqCoverage("?page_size=200"));
    setCtqCoverage(result);
  }

  async function loadMatrix() {
    await run(async () => {
      const [mat, cov] = await Promise.all([
        requirementManufacturing.matrix("?page_size=200"),
        requirementManufacturing.coverage(),
      ]);
      setMatrix(mat);
      setCoverage(cov);
    });
  }

  async function loadGaps(rule) {
    const selected = rule === undefined ? gapRule : rule;
    setGapRule(selected);
    const qs = `?page_size=200${selected ? `&rules=${encodeURIComponent(selected)}` : ""}`;
    const result = await run(() => requirementManufacturing.gaps(qs));
    setGaps(result);
  }

  async function loadReqGaps(ref) {
    setReqGapsRef(ref);
    if (!ref) return setReqGaps(null);
    const result = await run(() => requirementManufacturing.requirementGaps(ref, "?page_size=200"));
    setReqGaps(result);
  }

  async function loadRequirementImpact(ref) {
    setImpactRef(ref);
    if (!ref) return setRequirementImpact(null);
    const result = await run(() => requirementManufacturing.requirementImpact(ref, "?max_depth=6"));
    setRequirementImpact(result);
  }

  async function runNodeImpact() {
    const result = await run(() =>
      requirementManufacturing.nodeImpact({
        node_type: nodeImpactForm.node_type,
        node_id: nodeImpactForm.node_id,
        analyze: nodeImpactForm.analyze,
      })
    );
    if (result) setNodeImpact(result);
  }

  async function submitImpactJob() {
    const result = await run(
      () => requirementManufacturing.submitImpactJob({ requirement_id: impactRef || undefined }),
      "Impact analysis job submitted."
    );
    if (result) setJobResult(result);
  }

  async function submitGapSweep() {
    const result = await run(() => requirementManufacturing.submitGapSweep({}), "Gap sweep job submitted.");
    if (result) setJobResult(result);
  }

  async function runTrace() {
    const { object_type, object_id, direction, max_depth } = traceForm;
    if (!object_type || !object_id) return;
    const qs = `?object_type=${encodeURIComponent(object_type)}&object_id=${encodeURIComponent(object_id)}&direction=${encodeURIComponent(direction)}&max_depth=${Number(max_depth) || 6}`;
    const result = await run(() => requirementManufacturing.trace(qs));
    if (result) setTrace(result);
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => requirementManufacturing.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Requirement / Manufacturing</h1>
          <p className="subtle">
            Trace requirements through EBOM to MBOM, BOP, operations, work centers, characteristics and CTQ, with
            coverage, gap analysis, change impact and bidirectional navigation. Projected onto the shared Digital
            Thread and reusing the existing PDM, BOM, Classification, Object and Traceability engines.
          </p>
        </div>
        <div className="stack-row">
          {meta?.thread_provider ? <Badge tone="ok">{meta.thread_provider}</Badge> : null}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} className={`tab${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Allocations</h3><div className="mono">{health?.counts?.allocations ?? "-"}</div></div>
            <div className="panel grow"><h3>Requirements</h3><div className="mono">{reqItems.length}</div></div>
            <div className="panel grow"><h3>Allocation types</h3><div className="mono">{allocationTypes().length}</div></div>
            <div className="panel grow"><h3>Impact categories</h3><div className="mono">{(meta?.impact_categories || []).length}</div></div>
          </div>

          <div className="panel">
            <h3>Allocation vocabulary ({allocationTypes().length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Targets</th><th>Direction</th></tr></thead>
              <tbody>
                {allocationTypes().map((entry) => (
                  <tr key={entry.code}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{(entry.target_types || []).join(", ")}</td>
                    <td className="mono">{entry.direction || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Manufacturing stages</h3>
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              {(meta?.stages || []).map((stage) => <Badge key={stage}>{stage}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Recent allocations</h3>
            <table className="table">
              <thead><tr><th>Requirement</th><th>Type</th><th>Target</th><th>Status</th></tr></thead>
              <tbody>
                {allocations.slice(0, 8).map((entry) => (
                  <tr key={entry.allocation_ref}>
                    <td className="mono">{entry.requirement_number || entry.requirement_ref}</td>
                    <td className="mono">{entry.relationship_type}</td>
                    <td className="mono">{entry.target_type}:{entry.target_id}</td>
                    <td><Badge tone={entry.status === "ACTIVE" ? "ok" : undefined}>{entry.status}</Badge></td>
                  </tr>
                ))}
                {!allocations.length ? <tr><td colSpan={4} className="subtle">No allocations yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "allocations" ? (
        <>
          <div className="panel">
            <h3>Allocate a requirement</h3>
            <div className="grid">
              <label className="field grow"><span>Requirement</span>
                <select name="requirement_id" value={form.requirement_id} onChange={bind(setForm, form)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.id}>{requirementLabel(entry)}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Relationship</span>
                <select name="relationship_type" value={form.relationship_type} onChange={onRelationshipChange}>
                  <option value="">Select…</option>
                  {allocationTypes().map((entry) => <option key={entry.code} value={entry.code}>{entry.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Target type</span>
                <select name="target_type" value={form.target_type} onChange={(event) => { setForm({ ...form, target_type: event.target.value, target_id: "" }); loadTargets(event.target.value); }}>
                  <option value="">Select…</option>
                  {targetTypesFor(form.relationship_type).map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Target</span>
                <select name="target_id" value={form.target_id} onChange={bind(setForm, form)}>
                  <option value="">Select a target…</option>
                  {(targets[form.target_type] || []).map((entry) => (
                    <option key={entry.id} value={entry.id}>{objectLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy || !form.requirement_id || !form.relationship_type || !form.target_id} onClick={createAllocation}>Allocate</button>
          </div>

          <div className="panel">
            <h3>Allocations ({allocations.length})</h3>
            <table className="table">
              <thead><tr><th>Requirement</th><th>Type</th><th>Target</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {allocations.map((entry) => (
                  <tr key={entry.allocation_ref}>
                    <td className="mono">{entry.requirement_number || entry.requirement_ref}</td>
                    <td className="mono">{entry.relationship_type}</td>
                    <td className="mono">{entry.target_type}:{entry.target_id}</td>
                    <td><Badge tone={entry.status === "ACTIVE" ? "ok" : undefined}>{entry.status}</Badge></td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => removeAllocation(entry)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Forward allocation coverage</h3>
              <label className="field">
                <span>Requirement</span>
                <select value={coverageRef} onChange={(event) => loadForwardCoverage(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            {forwardCoverage ? (
              <>
                <div className="stack-row">
                  <Badge tone={coverageTone(forwardCoverage.coverage)}>{forwardCoverage.coverage}</Badge>
                  <span className="subtle">active {forwardCoverage.active} / total {forwardCoverage.total}</span>
                </div>
                <table className="table">
                  <thead><tr><th>Relationship</th><th>Count</th></tr></thead>
                  <tbody>
                    {Object.entries(forwardCoverage.by_relationship || {}).map(([key, value]) => (
                      <tr key={key}><td className="mono">{key}</td><td className="mono">{value}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose a requirement to evaluate its allocation coverage.</p>}
          </div>
        </>
      ) : null}

      {tab === "ebomMbom" ? (
        <>
          <div className="panel">
            <h3>EBOM → MBOM mappings</h3>
            <div className="grid">
              <label className="field grow"><span>EBOM revision</span>
                <select value={ebomRef} onChange={(event) => loadEbomMappings(event.target.value)}>
                  <option value="">Select an EBOM revision…</option>
                  {bomRevisions.map((entry) => (
                    <option key={entry.id} value={entry.revision_ref || entry.id}>{objectLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            {ebomMappings ? (
              <table className="table">
                <thead><tr><th>Source line</th><th>Target line</th><th>Status</th></tr></thead>
                <tbody>
                  {(ebomMappings.items || []).map((entry, index) => (
                    <tr key={entry.relationship_ref || index}>
                      <td className="mono">{entry.source_line_ref || entry.source?.line_ref || "-"}</td>
                      <td className="mono">{entry.target_line_ref || entry.target?.line_ref || "-"}</td>
                      <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                    </tr>
                  ))}
                  {!ebomMappings.items?.length ? <tr><td colSpan={3} className="subtle">No mappings for this revision.</td></tr> : null}
                </tbody>
              </table>
            ) : <p className="subtle">Choose an EBOM revision to view its MBOM mappings.</p>}
          </div>

          <div className="panel">
            <h3>MBOM → EBOM sources</h3>
            <label className="field grow"><span>MBOM revision</span>
              <select value={mbomRef} onChange={(event) => loadMbomSources(event.target.value)}>
                <option value="">Select an MBOM revision…</option>
                {bomRevisions.map((entry) => (
                  <option key={entry.id} value={entry.revision_ref || entry.id}>{objectLabel(entry)}</option>
                ))}
              </select>
            </label>
            {mbomSources ? (
              <>
                <div className="stack-row">
                  <span className="subtle">linked {mbomSources.summary?.mapped_items ?? 0}</span>
                  <span className="subtle">unmapped {mbomSources.unlinked_target_items?.length ?? 0}</span>
                  <span className="subtle">invalid links {mbomSources.invalid_links?.length ?? 0}</span>
                </div>
                <table className="table">
                  <thead><tr><th>MBOM item</th><th>EBOM source</th><th>Status</th></tr></thead>
                  <tbody>
                    {(mbomSources.items || []).map((entry, index) => (
                      <tr key={entry.relationship_ref || index}>
                        <td className="mono">{entry.target_line_ref || entry.target?.line_ref || entry.mbom_ref || "-"}</td>
                        <td className="mono">{entry.source_line_ref || entry.source?.line_ref || "-"}</td>
                        <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose an MBOM revision to view its EBOM sources.</p>}
          </div>

          <div className="panel">
            <h3>Transformation runs</h3>
            <label className="field grow"><span>BOM revision</span>
              <select value={bomRevRef} onChange={(event) => loadBomTransformations(event.target.value)}>
                <option value="">Select a revision…</option>
                {bomRevisions.map((entry) => (
                  <option key={entry.id} value={entry.revision_ref || entry.id}>{objectLabel(entry)}</option>
                ))}
              </select>
            </label>
            {bomTransformations ? (
              <table className="table">
                <thead><tr><th>Run</th><th>Direction</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>
                  {(bomTransformations.items || bomTransformations.runs || []).map((entry, index) => (
                    <tr key={entry.run_ref || entry.id || index}>
                      <td className="mono">{entry.run_ref || entry.id || index}</td>
                      <td className="mono">{entry.direction || "-"}</td>
                      <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                      <td className="mono">{entry.created_at || "-"}</td>
                    </tr>
                  ))}
                  {!(bomTransformations.items || bomTransformations.runs || []).length ? <tr><td colSpan={4} className="subtle">No transformation runs recorded.</td></tr> : null}
                </tbody>
              </table>
            ) : <p className="subtle">Choose a revision to view provenance transformation runs.</p>}
          </div>
        </>
      ) : null}

      {tab === "bop" ? (
        <>
          <div className="panel">
            <h3>BOP → operations</h3>
            <label className="field grow"><span>BOP revision</span>
              <select value={bopRef} onChange={(event) => loadBop(event.target.value)}>
                <option value="">Select a BOP revision…</option>
                {bomRevisions.map((entry) => (
                  <option key={entry.id} value={entry.revision_ref || entry.id}>{objectLabel(entry)}</option>
                ))}
              </select>
            </label>
            {bopOps ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <span className="subtle">operations {bopOps.summary?.operations ?? 0}</span>
                  <span className="subtle">valid {bopOps.summary?.valid ?? 0}</span>
                  <span className="subtle">missing work center {bopOps.summary?.missing_work_center ?? 0}</span>
                  <span className="subtle">invalid {bopOps.summary?.invalid ?? 0}</span>
                  {bopSeq ? <Badge tone={bopSeq.valid ? "ok" : "warn"}>{bopSeq.valid ? "sequence valid" : `${(bopSeq.conflicts || []).length} conflicts`}</Badge> : null}
                  {bopCoverage ? <Badge tone={coverageTone(bopCoverage.coverage || bopCoverage.status)}>{bopCoverage.coverage || bopCoverage.status || "coverage"}</Badge> : null}
                </div>
                <table className="table">
                  <thead><tr><th>Seq</th><th>Operation</th><th>Work centers</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {(bopOps.items || []).map((entry) => (
                      <tr key={entry.line_ref || entry.operation_object_id}>
                        <td className="mono">{entry.sequence}</td>
                        <td className="mono">{objectLabel(entry.operation)}</td>
                        <td className="mono">{(entry.work_centers || []).map((wc) => goalLabel(wc)).join(", ") || "-"}</td>
                        <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                        <td><button className="btn ghost" disabled={busy} onClick={() => loadOperation(entry.operation_object_id)}>Inspect</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose a BOP revision to view its operations.</p>}
          </div>

          <div className="panel">
            <h3>Operation workspace</h3>
            <label className="field grow"><span>Operation (object id / code)</span>
              <input value={opRef} onChange={(event) => loadOperation(event.target.value)} placeholder="operation ref" />
            </label>
            {opRef ? (
              <div className="grid">
                <div className="panel grow">
                  <h4>Work centers</h4>
                  <table className="table">
                    <thead><tr><th>Work center</th></tr></thead>
                    <tbody>
                      {(opWorkCenters?.items || []).map((entry, index) => (
                        <tr key={entry.id || index}><td className="mono">{objectLabel(entry.work_center || entry)}</td></tr>
                      ))}
                      {!opWorkCenters?.items?.length ? <tr><td className="subtle">None linked.</td></tr> : null}
                    </tbody>
                  </table>
                  <div className="stack-row">
                    <input name="work_center_id" value={opLinks.work_center_id} onChange={bind(setOpLinks, opLinks)} placeholder="work center id" />
                    <button className="btn secondary" disabled={busy || !opLinks.work_center_id} onClick={linkWorkCenter}>Link</button>
                  </div>
                </div>
                <div className="panel grow">
                  <h4>Consumed MBOM items</h4>
                  <table className="table">
                    <thead><tr><th>Item</th></tr></thead>
                    <tbody>
                      {(opMbomItems?.items || []).map((entry, index) => (
                        <tr key={entry.id || index}><td className="mono">{objectLabel(entry.item || entry)}</td></tr>
                      ))}
                      {!opMbomItems?.items?.length ? <tr><td className="subtle">None linked.</td></tr> : null}
                    </tbody>
                  </table>
                  <div className="stack-row">
                    <input name="mbom_item_id" value={opLinks.mbom_item_id} onChange={bind(setOpLinks, opLinks)} placeholder="mbom item id" />
                    <button className="btn secondary" disabled={busy || !opLinks.mbom_item_id} onClick={linkMbomItem}>Link</button>
                  </div>
                </div>
                <div className="panel grow">
                  <h4>Characteristics</h4>
                  <table className="table">
                    <thead><tr><th>Characteristic</th></tr></thead>
                    <tbody>
                      {(opChars?.items || []).map((entry, index) => (
                        <tr key={entry.characteristic_id || index}><td className="mono">{objectLabel(entry.characteristic || entry)}</td></tr>
                      ))}
                      {!opChars?.items?.length ? <tr><td className="subtle">None linked.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
                <div className="panel grow">
                  <h4>Precedence</h4>
                  <div className="stack-row">
                    <input name="predecessor_id" value={opLinks.predecessor_id} onChange={bind(setOpLinks, opLinks)} placeholder="predecessor operation id" />
                    <button className="btn secondary" disabled={busy || !opLinks.predecessor_id} onClick={linkPredecessor}>Link</button>
                  </div>
                </div>
              </div>
            ) : <p className="subtle">Enter or select an operation to inspect its work centers, MBOM items and characteristics.</p>}
          </div>

          <div className="panel">
            <h3>MBOM process coverage</h3>
            <label className="field grow"><span>MBOM revision</span>
              <select value={mbomProcRef} onChange={(event) => loadMbomProcessCoverage(event.target.value)}>
                <option value="">Select an MBOM revision…</option>
                {bomRevisions.map((entry) => (
                  <option key={entry.id} value={entry.revision_ref || entry.id}>{objectLabel(entry)}</option>
                ))}
              </select>
            </label>
            {mbomProcCoverage ? (
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <span className="subtle">items {mbomProcCoverage.summary?.items ?? mbomProcCoverage.total ?? 0}</span>
                <span className="subtle">with operation {mbomProcCoverage.summary?.with_operation ?? "-"}</span>
                <span className="subtle">without operation {mbomProcCoverage.summary?.without_operation ?? "-"}</span>
              </div>
            ) : <p className="subtle">Choose an MBOM revision to evaluate its process coverage.</p>}
          </div>
        </>
      ) : null}

      {tab === "characteristics" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Requirement CTQ</h3>
              <label className="field">
                <span>Requirement</span>
                <select value={ctqRef} onChange={(event) => loadReqCtqs(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            {reqCtqs ? (
              <>
                <div className="stack-row">
                  <span className="subtle">characteristics {reqCtqs.total ?? 0}</span>
                  <span className="subtle">missing operation {reqCtqs.missing_operation ?? 0}</span>
                </div>
                <table className="table">
                  <thead><tr><th>Characteristic</th><th>CTQ</th><th>Operations</th><th>Status</th></tr></thead>
                  <tbody>
                    {(reqCtqs.items || []).map((entry, index) => (
                      <tr key={entry.characteristic?.characteristic_id || index}>
                        <td className="mono">{objectLabel(entry.characteristic)}</td>
                        <td className="mono">{entry.characteristic?.is_ctq === false ? "no" : entry.characteristic?.criticality || "yes"}</td>
                        <td className="mono">{entry.operation_count}</td>
                        <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                      </tr>
                    ))}
                    {!reqCtqs.items?.length ? <tr><td colSpan={4} className="subtle">No characteristics allocated.</td></tr> : null}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose a requirement to view its allocated characteristics and CTQ.</p>}
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>CTQ coverage</h3>
              <button className="btn ghost" disabled={busy} onClick={loadCtqCoverage}>Refresh CTQ coverage</button>
            </div>
            {ctqCoverage ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <span className="subtle">CTQ total {ctqCoverage.summary?.ctq_total ?? 0}</span>
                  <span className="subtle">with requirement {ctqCoverage.summary?.ctq_with_requirement ?? 0}</span>
                  <span className="subtle">without requirement {ctqCoverage.summary?.ctq_without_requirement ?? 0}</span>
                  <span className="subtle">with operation {ctqCoverage.summary?.ctq_with_operation ?? 0}</span>
                  <span className="subtle">without operation {ctqCoverage.summary?.ctq_without_operation ?? 0}</span>
                </div>
                <table className="table">
                  <thead><tr><th>CTQ</th><th>Operations</th><th>Status</th></tr></thead>
                  <tbody>
                    {(ctqCoverage.with_coverage || []).map((entry, index) => (
                      <tr key={entry.characteristic?.characteristic_id || index}>
                        <td className="mono">{objectLabel(entry.characteristic)}</td>
                        <td className="mono">{entry.operation_count}</td>
                        <td><Badge tone={linkTone(entry.status)}>{entry.status}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Load CTQ coverage to see characteristics linked to requirements and operations.</p>}
          </div>
        </>
      ) : null}

      {tab === "matrix" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Manufacturing matrix</h3>
              <button className="btn ghost" disabled={busy} onClick={loadMatrix}>Refresh matrix</button>
            </div>
            {coverage ? (
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone="ok">overall {coverage.overall_coverage}%</Badge>
                <span className="subtle">requirements {coverage.requirements?.requirements ?? 0}</span>
                <span className="subtle">covered {coverage.requirements?.COVERED ?? 0}</span>
                <span className="subtle">partial {coverage.requirements?.PARTIAL ?? 0}</span>
                <span className="subtle">gaps {coverage.requirements?.GAP ?? 0}</span>
              </div>
            ) : null}
            {matrix ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Requirement</th>
                    {(matrix.columns || []).map((column) => <th key={column}>{column}</th>)}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(matrix.items || []).map((row) => (
                    <tr key={row.requirement.requirement_id || row.requirement.requirement_ref}>
                      <td className="mono">{row.requirement.requirement_number}</td>
                      {(matrix.columns || []).map((column) => (
                        <td key={column} className="mono">{row.counts?.[column] ?? 0}</td>
                      ))}
                      <td><Badge tone={coverageTone(row.coverage_status)}>{row.coverage_status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="subtle">Load the matrix to see requirement coverage across the manufacturing chain.</p>}
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Gaps</h3>
              <label className="field">
                <span>Rule</span>
                <select value={gapRule} onChange={(event) => loadGaps(event.target.value)}>
                  <option value="">All rules</option>
                  <option value="REQUIREMENT_IMPLEMENTATION">REQUIREMENT_IMPLEMENTATION</option>
                  <option value="EBOM_MBOM_MAPPING">EBOM_MBOM_MAPPING</option>
                  <option value="MBOM_BOP_ASSIGNMENT">MBOM_BOP_ASSIGNMENT</option>
                  <option value="CTQ_COVERAGE">CTQ_COVERAGE</option>
                </select>
              </label>
            </div>
            <button className="btn ghost" disabled={busy} onClick={() => loadGaps()}>Run gap analysis</button>
            {gaps ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <span className="subtle">total {gaps.total ?? 0}</span>
                  {Object.entries(gaps.summary?.by_rule || {}).map(([rule, count]) => (
                    <span key={rule} className="subtle">{rule} {count}</span>
                  ))}
                </div>
                <table className="table">
                  <thead><tr><th>Rule</th><th>Severity</th><th>Object</th><th>Column</th><th>Status</th></tr></thead>
                  <tbody>
                    {(gaps.items || []).map((entry, index) => (
                      <tr key={`${entry.rule}-${entry.object?.type}-${entry.object?.id}-${entry.column}-${index}`}>
                        <td className="mono">{entry.rule}</td>
                        <td><Badge tone={severityTone(entry.severity)}>{entry.severity}</Badge></td>
                        <td className="mono">{entry.object?.type}:{entry.object?.number || entry.object?.ref || entry.object?.id}</td>
                        <td className="mono">{entry.column}</td>
                        <td className="mono">{entry.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Requirement-scoped gaps</h3>
              <label className="field">
                <span>Requirement</span>
                <select value={reqGapsRef} onChange={(event) => loadReqGaps(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            {reqGaps ? (
              <table className="table">
                <thead><tr><th>Rule</th><th>Severity</th><th>Column</th></tr></thead>
                <tbody>
                  {(reqGaps.items || []).map((entry, index) => (
                    <tr key={`${entry.rule}-${entry.column}-${index}`}>
                      <td className="mono">{entry.rule}</td>
                      <td><Badge tone={severityTone(entry.severity)}>{entry.severity}</Badge></td>
                      <td className="mono">{entry.column}</td>
                    </tr>
                  ))}
                  {!reqGaps.items?.length ? <tr><td colSpan={3} className="subtle">No gaps for this requirement.</td></tr> : null}
                </tbody>
              </table>
            ) : <p className="subtle">Choose a requirement to scope the gap analysis.</p>}
          </div>
        </>
      ) : null}

      {tab === "impact" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Requirement change impact</h3>
              <label className="field">
                <span>Requirement</span>
                <select value={impactRef} onChange={(event) => loadRequirementImpact(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.requirement_ref}>{requirementLabel(entry)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy || !impactRef} onClick={submitImpactJob}>Queue impact job</button>
              <button className="btn ghost" disabled={busy} onClick={submitGapSweep}>Queue gap sweep</button>
            </div>
            {requirementImpact ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <Badge tone={requirementImpact.released_impacted ? "danger" : "ok"}>impacted {requirementImpact.impacted_count}</Badge>
                  <span className="subtle">released impacted {requirementImpact.released_count ?? 0}</span>
                  <span className="subtle">depth {requirementImpact.depth_reached ?? "-"}</span>
                  {requirementImpact.recommendation?.change_candidate ? <Badge tone="warn">change candidate</Badge> : null}
                </div>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  {Object.entries(requirementImpact.category_totals || {}).map(([category, count]) => (
                    <span key={category} className="subtle">{category} {count}</span>
                  ))}
                </div>
                <table className="table">
                  <thead><tr><th>Depth</th><th>Node</th><th>Type</th><th>Category</th><th>Released</th></tr></thead>
                  <tbody>
                    {(requirementImpact.items || []).map((entry, index) => (
                      <tr key={entry.node_ref || index}>
                        <td className="mono">{entry.depth}</td>
                        <td className="mono">{entry.display_name || entry.object_id}</td>
                        <td className="mono">{entry.object_type}</td>
                        <td className="mono">{entry.category}</td>
                        <td>{entry.released ? <Badge tone="warn">released</Badge> : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose a requirement to analyze its downstream manufacturing impact.</p>}
          </div>

          <div className="panel">
            <h3>Node change impact (reverse)</h3>
            <div className="grid">
              <label className="field"><span>Node type</span>
                <select name="node_type" value={nodeImpactForm.node_type} onChange={bind(setNodeImpactForm, nodeImpactForm)}>
                  {NAVIGATION_TYPES.filter((type) => type !== "requirement").map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Node id</span>
                <input name="node_id" value={nodeImpactForm.node_id} onChange={bind(setNodeImpactForm, nodeImpactForm)} placeholder="artifact id" />
              </label>
            </div>
            <button className="btn" disabled={busy || !nodeImpactForm.node_id} onClick={runNodeImpact}>Analyze node impact</button>
            {nodeImpact ? (
              <>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <span className="subtle">requirements {nodeImpact.requirement_count ?? 0}</span>
                  <span className="subtle">impacted {nodeImpact.impacted_count ?? 0}</span>
                  {nodeImpact.released_impacted ? <Badge tone="danger">released impacted</Badge> : null}
                </div>
                <table className="table">
                  <thead><tr><th>Requirement</th><th>Impacted</th><th>Released</th></tr></thead>
                  <tbody>
                    {(nodeImpact.requirements || []).map((entry) => (
                      <tr key={entry.requirement_id}>
                        <td className="mono">{entry.requirement_number}</td>
                        <td className="mono">{entry.impacted_count}</td>
                        <td>{entry.released_impacted ? <Badge tone="warn">yes</Badge> : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            {jobResult ? (
              <p className="subtle">Job submitted: <span className="mono">{jobResult.job?.job_ref || jobResult.job_ref || jobResult.id || "-"}</span></p>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "trace" ? (
        <div className="panel">
          <h3>Bidirectional navigation</h3>
          <div className="grid">
            <label className="field"><span>Object type</span>
              <select name="object_type" value={traceForm.object_type} onChange={bind(setTraceForm, traceForm)}>
                {NAVIGATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="field grow"><span>Object id</span>
              <input name="object_id" value={traceForm.object_id} onChange={bind(setTraceForm, traceForm)} placeholder="object id" />
            </label>
            <label className="field"><span>Direction</span>
              <select name="direction" value={traceForm.direction} onChange={bind(setTraceForm, traceForm)}>
                <option value="forward">forward</option>
                <option value="backward">backward</option>
              </select>
            </label>
            <label className="field"><span>Max depth</span>
              <input name="max_depth" value={traceForm.max_depth} onChange={bind(setTraceForm, traceForm)} />
            </label>
          </div>
          <button className="btn" disabled={busy || !traceForm.object_id} onClick={runTrace}>Traverse</button>
          {trace ? (
            <>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <span className="subtle">nodes {trace.nodes?.length ?? 0}</span>
                <span className="subtle">edges {trace.edges?.length ?? 0}</span>
                <span className="subtle">depth reached {trace.depth_reached ?? "-"}</span>
                {trace.truncated ? <Badge tone="warn">truncated</Badge> : null}
              </div>
              <table className="table">
                <thead><tr><th>Depth</th><th>Node</th><th>Type</th></tr></thead>
                <tbody>
                  {(trace.nodes || []).map((node, index) => (
                    <tr key={node.node_ref || index}>
                      <td className="mono">{node.depth}</td>
                      <td className="mono">{node.node_ref}</td>
                      <td className="mono">{node.object_type || node.node_type || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <p className="subtle">Enter an object type and id to traverse the manufacturing thread.</p>}
        </div>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <ConfigRow key={key} configKey={key} value={value} busy={busy} onSave={saveConfig} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ConfigRow({ configKey, value, busy, onSave }) {
  const initial = typeof value === "string" ? value : JSON.stringify(value);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(typeof value === "string" ? value : JSON.stringify(value));
  }, [value]);
  return (
    <tr>
      <td className="mono">{configKey}</td>
      <td><input value={draft} onChange={(event) => setDraft(event.target.value)} style={{ width: "100%" }} /></td>
      <td><button className="btn ghost" disabled={busy || draft === initial} onClick={() => onSave(configKey, draft)}>Save</button></td>
    </tr>
  );
}
