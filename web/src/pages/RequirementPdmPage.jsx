import React, { useEffect, useState } from "react";
import { requirementPdm, requirements, pdm, bom } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "allocations", label: "Allocations" },
  { key: "coverage", label: "Coverage & compatibility" },
  { key: "impact", label: "Impact & synchronization" },
  { key: "plmProduct", label: "Product & lifecycle" },
  { key: "plmStructures", label: "EBOM / MBOM / BOP" },
  { key: "plmDocuments", label: "Documents" },
  { key: "plmChanges", label: "Change requests" },
  { key: "plmImpact", label: "PLM impact" },
  { key: "configuration", label: "Configuration" },
];

const PLM_TABS = ["plmProduct", "plmStructures", "plmDocuments", "plmChanges", "plmImpact"];

const CHANGE_TYPE_LABELS = {
  change_request: "Change request",
  change_order: "Change order",
  change_notice: "Change notice",
};

const TARGET_LOADERS = {
  pdm_item: () => pdm.items("?page_size=200"),
  pdm_revision: () => pdm.revisions("?page_size=200"),
  pdm_dataset: () => pdm.datasets("?page_size=200"),
  bom_revision: () => bom.revisions("?page_size=200"),
};

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function coverageTone(status) {
  if (status === "SATISFIED" || status === "ALLOCATED") return "ok";
  if (status === "PARTIAL") return "warn";
  if (status === "UNALLOCATED") return "danger";
  return undefined;
}

function compatibilityTone(status) {
  if (status === "COMPATIBLE") return "ok";
  if (status === "STALE") return "warn";
  if (status === "INCOMPATIBLE") return "danger";
  return undefined;
}

function targetLabel(targetType, entry) {
  if (!entry) return "-";
  if (targetType === "pdm_item") return `${entry.item_number || entry.code || entry.id} — ${entry.name || ""}`;
  if (targetType === "pdm_revision") return `${entry.revision_number || entry.id} — ${entry.item_number || entry.item_ref || ""}`;
  if (targetType === "pdm_dataset") return `${entry.dataset_number || entry.code || entry.id} — ${entry.name || ""}`;
  if (targetType === "bom_revision") return `${entry.revision_number || entry.id} — ${entry.bom_number || entry.bom_ref || ""}`;
  return String(entry.id ?? entry);
}

export default function RequirementPdmPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [summary, setSummary] = useState(null);
  const [reqItems, setReqItems] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [targets, setTargets] = useState({});

  const [form, setForm] = useState({ requirement_id: "", relationship_type: "", target_type: "", target_id: "" });
  const [coverageRef, setCoverageRef] = useState("");
  const [coverage, setCoverage] = useState(null);
  const [compat, setCompat] = useState(null);

  const [impactForm, setImpactForm] = useState({ target_type: "pdm_item", target_id: "" });
  const [impact, setImpact] = useState(null);
  const [syncResult, setSyncResult] = useState(null);

  const [plmRef, setPlmRef] = useState("");
  const [plmProducts, setPlmProducts] = useState(null);
  const [plmLifecycle, setPlmLifecycle] = useState(null);
  const [plmStructures, setPlmStructures] = useState(null);
  const [plmDocuments, setPlmDocuments] = useState(null);
  const [plmChanges, setPlmChanges] = useState(null);
  const [plmChain, setPlmChain] = useState(null);
  const [plmImpact, setPlmImpact] = useState(null);
  const [plmImpactDepth, setPlmImpactDepth] = useState(6);
  const [plmDecision, setPlmDecision] = useState(null);
  const [plmMetrics, setPlmMetrics] = useState(null);
  const [docCategory, setDocCategory] = useState("");
  const [plmTrace, setPlmTrace] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, h, cfg, sm, reqs, allocs] = await Promise.all([
        requirementPdm.meta(),
        requirementPdm.health(),
        requirementPdm.configuration(),
        requirementPdm.integrationSummary(),
        requirements.list("?page_size=200"),
        requirementPdm.allocations("?page_size=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setSummary(sm);
      setReqItems(reqs.items || []);
      setAllocations(allocs.items || []);
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

  async function loadTargets(targetType) {
    if (!targetType || targets[targetType]) return;
    const loader = TARGET_LOADERS[targetType];
    if (!loader) return;
    await run(async () => {
      const result = await loader();
      setTargets((prev) => ({ ...prev, [targetType]: result.items || [] }));
    });
  }

  function allocationTypes() {
    return meta?.allocation_types || [];
  }

  function targetTypesFor(relationshipType) {
    const entry = allocationTypes().find((item) => item.code === relationshipType);
    return entry?.target_types || [];
  }

  function onRelationshipChange(event) {
    const relationship_type = event.target.value;
    const target_type = targetTypesFor(relationship_type)[0] || "";
    setForm({ ...form, relationship_type, target_type, target_id: "" });
    if (target_type) loadTargets(target_type);
  }

  async function createAllocation() {
    const result = await run(
      () => requirementPdm.createAllocation({ ...form, requirement_id: Number(form.requirement_id) }),
      "Allocation created."
    );
    if (result) {
      setForm({ requirement_id: "", relationship_type: "", target_type: "", target_id: "" });
      await refresh();
    }
  }

  async function removeAllocation(entry) {
    await run(() => requirementPdm.removeAllocation(entry.allocation_ref), "Allocation removed.");
    await refresh();
  }

  async function checkAllocation(entry) {
    const result = await run(() => requirementPdm.checkAllocation(entry.allocation_ref, {}));
    if (result) {
      setCompat({ requirement_ref: entry.requirement_ref, reports: [result], summary: null });
      setTab("coverage");
    }
  }

  async function syncAllocation(entry) {
    const result = await run(() => requirementPdm.synchronizeAllocation(entry.allocation_ref, {}), "Allocation synchronized.");
    if (result) setSyncResult(result);
  }

  async function loadCoverage(ref) {
    setCoverageRef(ref);
    if (!ref) return;
    await run(async () => {
      const [cov, cmp] = await Promise.all([
        requirementPdm.requirementCoverage(ref),
        requirementPdm.requirementCompatibilities(ref),
      ]);
      setCoverage(cov);
      setCompat(cmp);
    });
  }

  async function runImpact() {
    const qs = `?target_type=${encodeURIComponent(impactForm.target_type)}&target_id=${encodeURIComponent(impactForm.target_id)}`;
    const result = await run(() => requirementPdm.impact(qs));
    setImpact(result);
  }

  async function synchronize() {
    const result = await run(
      () => requirementPdm.synchronize({ target_type: impactForm.target_type, target_id: impactForm.target_id }),
      "Synchronization completed."
    );
    if (result) setSyncResult(result);
  }

  async function submitSyncJob() {
    const result = await run(
      () => requirementPdm.submitSynchronization({ target_type: impactForm.target_type, target_id: impactForm.target_id }),
      "Synchronization job submitted."
    );
    if (result) setSyncResult(result);
  }

  async function submitSweep() {
    const result = await run(() => requirementPdm.submitImpactSweep({}), "Impact sweep job submitted.");
    if (result) setSyncResult(result);
  }

  async function loadPlm(ref) {
    setPlmRef(ref);
    if (!ref) return;
    await run(async () => {
      const [products, lifecycle, structures, documents, changes] = await Promise.all([
        requirementPdm.requirementProducts(ref),
        requirementPdm.productLifecycle(ref),
        requirementPdm.requirementStructures(ref, "?include_structure=true"),
        requirementPdm.requirementDocuments(ref),
        requirementPdm.requirementChanges(ref),
      ]);
      setPlmProducts(products);
      setPlmLifecycle(lifecycle);
      setPlmStructures(structures);
      setPlmDocuments(documents);
      setPlmChanges(changes);
    });
  }

  async function refreshPlm() {
    if (plmRef) await loadPlm(plmRef);
  }

  async function runPlmImpact() {
    const result = await run(() => requirementPdm.requirementImpactAnalysis(plmRef, { max_depth: Number(plmImpactDepth) || 6 }));
    if (result) setPlmImpact(result);
  }

  async function evaluatePlmChange() {
    const result = await run(() => requirementPdm.requirementChangeInitiation(plmRef));
    if (result) {
      setPlmDecision(result);
      const chain = await run(() => requirementPdm.requirementChangeChain(plmRef));
      if (chain) setPlmChain(chain);
    }
  }

  async function initiatePlmChange() {
    const result = await run(() => requirementPdm.initiateRequirementChange(plmRef, {}), "Change request initiated.");
    if (result) {
      setPlmDecision(result);
      await refreshPlm();
      const chain = await run(() => requirementPdm.requirementChangeChain(plmRef));
      if (chain) setPlmChain(chain);
    }
  }

  async function unlinkPlmChange(linkRef) {
    await run(() => requirementPdm.unlinkChange(linkRef), "Change link removed.");
    await refreshPlm();
  }

  async function loadPlmMetrics() {
    const result = await run(() => requirementPdm.plmMetrics());
    if (result) setPlmMetrics(result);
  }

  async function loadFilteredDocuments(category) {
    setDocCategory(category);
    if (!plmRef) return;
    const result = await run(() =>
      requirementPdm.requirementDocuments(plmRef, category ? `?category=${encodeURIComponent(category)}` : "")
    );
    if (result) setPlmDocuments(result);
  }

  async function loadStructureTrace(ref) {
    const result = await run(() => requirementPdm.structureTrace(ref));
    if (result) setPlmTrace(result);
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => requirementPdm.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  const coverageRefSelection = reqItems.find((entry) => entry.requirement_ref === coverageRef) || null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Requirement / PDM integration</h1>
          <p className="subtle">
            Allocate requirements to products, items, item revisions, CAD/document datasets and EBOM revisions.
            Coverage, effectivity and configuration compatibility, change impact and synchronization are projected onto
            the shared digital thread — reusing the existing PDM, BOM, Object and Traceability engines.
          </p>
        </div>
        <div className="stack-row">{meta?.thread_provider ? <Badge tone="ok">{meta.thread_provider}</Badge> : null}</div>
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

      {PLM_TABS.includes(tab) ? (
        <div className="panel">
          <div className="stack-row" style={{ justifyContent: "space-between" }}>
            <h3>Requirement PLM workspace</h3>
            <label className="field">
              <span>Requirement</span>
              <select value={plmRef} onChange={(event) => loadPlm(event.target.value)}>
                <option value="">Select a requirement…</option>
                {reqItems.map((entry) => (
                  <option key={entry.id} value={entry.requirement_ref}>{entry.requirement_number} — {entry.title}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="subtle">
            Product, EBOM/MBOM/BOP, document and change projections for the selected requirement, projected onto the
            shared PLM lifecycle, BOM and Change Management engines.
          </p>
          <div className="stack-row">
            <button className="btn ghost" disabled={busy || !plmRef} onClick={loadPlmMetrics}>Refresh PLM metrics</button>
          </div>
          {plmMetrics ? (
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <Badge tone="ok">status {plmMetrics.status}</Badge>
              <span className="subtle">allocations {plmMetrics.allocations?.total ?? 0}</span>
              <span className="subtle">change links {plmMetrics.change_links?.total ?? 0}</span>
              <span className="subtle">change requests {plmMetrics.change_requests?.total ?? 0}</span>
              <span className="subtle">orders {plmMetrics.change_orders?.total ?? 0}</span>
              <span className="subtle">notices {plmMetrics.change_notices?.total ?? 0}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Allocations</h3><div className="mono">{health?.counts?.allocations ?? "-"}</div></div>
            <div className="panel grow"><h3>Requirements</h3><div className="mono">{reqItems.length}</div></div>
            <div className="panel grow"><h3>Event deliveries</h3><div className="mono">{summary?.events?.delivered ?? summary?.delivered ?? "-"}</div></div>
            <div className="panel grow"><h3>Pending messages</h3><div className="mono">{summary?.messages?.pending ?? summary?.pending ?? "-"}</div></div>
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
                    <option key={entry.id} value={entry.id}>{entry.requirement_number} — {entry.title}</option>
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
                    <option key={entry.id} value={entry.id}>{targetLabel(form.target_type, entry)}</option>
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
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => checkAllocation(entry)}>Check</button>
                      <button className="btn ghost" disabled={busy} onClick={() => syncAllocation(entry)}>Sync</button>
                      <button className="btn ghost" disabled={busy} onClick={() => removeAllocation(entry)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "coverage" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Requirement coverage</h3>
              <label className="field">
                <span>Requirement</span>
                <select value={coverageRef} onChange={(event) => loadCoverage(event.target.value)}>
                  <option value="">Select a requirement…</option>
                  {reqItems.map((entry) => (
                    <option key={entry.id} value={entry.requirement_ref}>{entry.requirement_number} — {entry.title}</option>
                  ))}
                </select>
              </label>
            </div>
            {coverage ? (
              <>
                <div className="stack-row">
                  <Badge tone={coverageTone(coverage.coverage)}>{coverage.coverage}</Badge>
                  <span className="subtle">active {coverage.active} / total {coverage.total}</span>
                </div>
                <table className="table">
                  <thead><tr><th>Relationship</th><th>Count</th></tr></thead>
                  <tbody>
                    {Object.entries(coverage.by_relationship || {}).map(([key, value]) => (
                      <tr key={key}><td className="mono">{key}</td><td className="mono">{value}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <p className="subtle">Choose a requirement to evaluate its allocation coverage.</p>}
          </div>

          {compat ? (
            <div className="panel">
              <h3>
                Compatibility {coverageRefSelection ? `— ${coverageRefSelection.requirement_number}` : ""}
                {compat.summary ? <span className="subtle"> ({compat.summary.total} allocations)</span> : null}
              </h3>
              <table className="table">
                <thead><tr><th>Allocation</th><th>Type</th><th>Target</th><th>Status</th><th>Reasons</th></tr></thead>
                <tbody>
                  {(compat.reports || []).map((report) => (
                    <tr key={report.allocation_ref}>
                      <td className="mono">{report.allocation_ref}</td>
                      <td className="mono">{report.relationship_type}</td>
                      <td className="mono">{report.target_type}:{report.target_id}</td>
                      <td><Badge tone={compatibilityTone(report.status)}>{report.status}</Badge></td>
                      <td className="mono">{(report.reasons || []).join(", ") || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "impact" ? (
        <>
          <div className="panel">
            <h3>Change impact analysis</h3>
            <p className="subtle">Find the requirements allocated to a PDM/BOM artifact and re-evaluate their compatibility.</p>
            <div className="grid">
              <label className="field"><span>Target type</span>
                <select name="target_type" value={impactForm.target_type} onChange={bind(setImpactForm, impactForm)}>
                  {(meta?.target_types || []).map((entry) => <option key={entry.code} value={entry.code}>{entry.code}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Target id</span>
                <input name="target_id" value={impactForm.target_id} onChange={bind(setImpactForm, impactForm)} placeholder="artifact id" />
              </label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy || !impactForm.target_id} onClick={runImpact}>Analyze impact</button>
              <button className="btn secondary" disabled={busy || !impactForm.target_id} onClick={synchronize}>Synchronize now</button>
              <button className="btn secondary" disabled={busy || !impactForm.target_id} onClick={submitSyncJob}>Queue sync job</button>
              <button className="btn ghost" disabled={busy} onClick={submitSweep}>Queue impact sweep</button>
            </div>
          </div>

          {impact ? (
            <div className="panel">
              <h3>Impacted requirements ({impact.total})</h3>
              <table className="table">
                <thead><tr><th>Number</th><th>Title</th><th>Status</th><th>Allocations</th></tr></thead>
                <tbody>
                  {(impact.requirements || []).map((entry) => (
                    <tr key={entry.requirement_id}>
                      <td className="mono">{entry.requirement_number}</td>
                      <td>{entry.title}</td>
                      <td className="mono">{entry.status}</td>
                      <td className="mono">{entry.allocation_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {syncResult ? (
            <div className="panel">
              <h3>Synchronization result</h3>
              <p className="subtle">
                {syncResult.status || syncResult.message_type || "submitted"} — evaluated {syncResult.evaluated ?? "-"},
                changed {syncResult.changed ?? "-"}, stale {syncResult.stale ?? "-"}, incompatible {syncResult.incompatible ?? "-"}
              </p>
              {syncResult.evaluations?.length ? (
                <table className="table">
                  <thead><tr><th>Allocation</th><th>From</th><th>To</th><th>Changed</th><th>Reasons</th></tr></thead>
                  <tbody>
                    {syncResult.evaluations.map((entry) => (
                      <tr key={entry.allocation_ref}>
                        <td className="mono">{entry.allocation_ref}</td>
                        <td className="mono">{entry.previous_status}</td>
                        <td className="mono">{entry.status}</td>
                        <td className="mono">{String(entry.changed)}</td>
                        <td className="mono">{(entry.reasons || []).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "plmProduct" ? (
        <>
          {plmProducts ? (
            <div className="panel">
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone="ok">realization {plmProducts.realization?.stage}</Badge>
                <span className="subtle">products {plmProducts.product_count}</span>
                <span className="subtle">released {plmProducts.realization?.released_count ?? 0}</span>
                <span className="subtle">superseded {plmProducts.realization?.superseded_count ?? 0}</span>
                <span className="subtle">implemented {String(plmProducts.realization?.implemented ?? false)}</span>
              </div>
              <table className="table">
                <thead><tr><th>Number</th><th>Name</th><th>Revision</th><th>Status</th><th>Realization</th><th>Released</th><th>Revisions</th></tr></thead>
                <tbody>
                  {(plmProducts.products || []).map((product) => (
                    <tr key={`${product.target_type}:${product.target_id}`}>
                      <td className="mono">{product.number || product.ref}</td>
                      <td>{product.name}</td>
                      <td className="mono">{product.revision_number || "-"}</td>
                      <td className="mono">{product.status}</td>
                      <td className="mono">{product.realization_stage}</td>
                      <td>{product.is_released ? <Badge tone="ok">yes</Badge> : <span className="subtle">no</span>}</td>
                      <td className="mono">{(product.revisions || []).length}</td>
                    </tr>
                  ))}
                  {!(plmProducts.products || []).length ? (
                    <tr><td colSpan={7} className="subtle">No product allocations for this requirement.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : <p className="subtle">Select a requirement to project its products and realization stage.</p>}

          {plmLifecycle ? (
            <div className="panel">
              <h3>Lifecycle — {plmLifecycle.product?.number || plmLifecycle.product?.ref}</h3>
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone="ok">category {plmLifecycle.lifecycle_category}</Badge>
                <span className="subtle">stage {plmLifecycle.realization_stage}</span>
                <span className="subtle">definition {plmLifecycle.lifecycle?.lifecycle?.code || plmLifecycle.lifecycle?.lifecycle?.name || "-"}</span>
                <span className="subtle">version {plmLifecycle.lifecycle?.version?.version ?? "-"}</span>
                <span className="subtle">state {plmLifecycle.lifecycle?.state?.name || plmLifecycle.product?.lifecycle_state || "-"}</span>
                <span className="subtle">status {plmLifecycle.lifecycle?.status?.code || "-"}</span>
                {plmLifecycle.lifecycle?.state?.is_terminal ? <Badge tone="ok">terminal</Badge> : null}
              </div>
              {(plmLifecycle.lifecycle?.transitions || []).length ? (
                <table className="table">
                  <thead><tr><th>Transition</th><th>Name</th><th>Approval</th></tr></thead>
                  <tbody>
                    {plmLifecycle.lifecycle.transitions.map((transition) => (
                      <tr key={transition.code || transition.id}>
                        <td className="mono">{transition.code}</td>
                        <td>{transition.name || "-"}</td>
                        <td className="mono">{transition.requires_approval ? "required" : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="subtle">No lifecycle transitions available.</p>}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "plmStructures" ? (
        <>
          {plmStructures ? (
            <div className="panel">
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <span className="subtle">structures {plmStructures.total ?? 0}</span>
                <span className="subtle">covered {(plmStructures.coverage?.covered_types || []).join(", ") || "none"}</span>
                <span className="subtle">missing {(plmStructures.coverage?.missing_types || []).join(", ") || "none"}</span>
                {plmStructures.coverage?.released ? <Badge tone="ok">EBOM/MBOM/BOP released</Badge> : <Badge tone="warn">not fully released</Badge>}
              </div>
              <table className="table">
                <thead><tr><th>Type</th><th>Number</th><th>Revision</th><th>Status</th><th>Released</th><th>Lines</th><th></th></tr></thead>
                <tbody>
                  {(plmStructures.structures || []).map((item) => (
                    <tr key={`${item.target_type}:${item.target_id}`}>
                      <td className="mono">{item.bom_type}</td>
                      <td className="mono">{item.number || item.ref}</td>
                      <td className="mono">{item.revision_number || "-"}</td>
                      <td className="mono">{item.status}</td>
                      <td>{item.is_released ? <Badge tone="ok">yes</Badge> : <span className="subtle">no</span>}</td>
                      <td className="mono">{item.structure?.line_count ?? "-"}</td>
                      <td><button className="btn ghost" disabled={busy} onClick={() => loadStructureTrace(item.target_id)}>Trace</button></td>
                    </tr>
                  ))}
                  {!(plmStructures.structures || []).length ? (
                    <tr><td colSpan={7} className="subtle">No EBOM/MBOM/BOP revisions allocated.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : <p className="subtle">Select a requirement to project its engineering, manufacturing and process structures.</p>}

          {plmTrace ? (
            <div className="panel">
              <h3>Structure trace — {plmTrace.structure?.number || plmTrace.structure?.ref} ({plmTrace.structure?.bom_type})</h3>
              <p className="subtle">
                lines {plmTrace.structure?.structure?.line_count ?? plmTrace.nodes?.length ?? 0},
                roots {plmTrace.structure?.structure?.root_count ?? "-"},
                depth {plmTrace.structure?.structure?.max_depth ?? "-"}
              </p>
              <table className="table">
                <thead><tr><th>Level</th><th>Child</th><th>Qty</th><th>UoM</th><th>Ref designators</th></tr></thead>
                <tbody>
                  {(plmTrace.nodes || []).map((node, index) => (
                    <tr key={node.line?.line_ref || index}>
                      <td className="mono">{node.level}</td>
                      <td className="mono" style={{ paddingLeft: `${Number(node.level || 1) * 12}px` }}>{node.line?.child_object_id ?? "-"}</td>
                      <td className="mono">{node.line?.quantity ?? "-"}</td>
                      <td className="mono">{node.line?.uom || "-"}</td>
                      <td className="mono">{(node.line?.reference_designators || []).join(", ") || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "plmDocuments" ? (
        <div className="panel">
          <div className="stack-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <h3>Documents {plmDocuments ? <span className="subtle">({plmDocuments.total} across {plmDocuments.source_count} sources)</span> : null}</h3>
            <label className="field">
              <span>Category</span>
              <select value={docCategory} onChange={(event) => loadFilteredDocuments(event.target.value)}>
                <option value="">All</option>
                <option value="REQUIREMENT">Requirement</option>
                <option value="PRODUCT">Product</option>
                <option value="STRUCTURE">Structure</option>
                <option value="CHANGE">Change</option>
              </select>
            </label>
          </div>
          {plmDocuments ? (
            <table className="table">
              <thead><tr><th>File</th><th>Category</th><th>Source</th><th>Role</th><th>Status</th><th>Classification</th></tr></thead>
              <tbody>
                {(plmDocuments.documents || []).map((document) => (
                  <tr key={document.association_ref || document.content_id}>
                    <td className="mono">{document.file_name}</td>
                    <td className="mono">{document.source?.category}</td>
                    <td className="mono">{document.source?.number || document.source?.ref || `${document.source?.object_type}:${document.source?.object_id}`}</td>
                    <td className="mono">{document.document_role || "-"}</td>
                    <td className="mono">{document.status}</td>
                    <td className="mono">{document.security_classification || "-"}</td>
                  </tr>
                ))}
                {!(plmDocuments.documents || []).length ? (
                  <tr><td colSpan={6} className="subtle">No documents associated with this requirement's PLM scope.</td></tr>
                ) : null}
              </tbody>
            </table>
          ) : <p className="subtle">Select a requirement to project its documents.</p>}
        </div>
      ) : null}

      {tab === "plmChanges" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <button className="btn" disabled={busy || !plmRef} onClick={evaluatePlmChange}>Evaluate change initiation</button>
              <button className="btn secondary" disabled={busy || !plmRef} onClick={initiatePlmChange}>Initiate change request</button>
            </div>
            {plmDecision ? (
              <div className="stack-row" style={{ flexWrap: "wrap" }}>
                <Badge tone={plmDecision.status === "CREATED" ? "ok" : undefined}>{plmDecision.status || plmDecision.decision?.status}</Badge>
                <span className="subtle">severity {plmDecision.decision?.severity || plmDecision.severity || "-"}</span>
                <span className="subtle">impacted {plmDecision.decision?.impact_summary?.impacted_count ?? plmDecision.impact_summary?.impacted_count ?? "-"}</span>
                <span className="subtle">released {plmDecision.decision?.impact_summary?.released_count ?? plmDecision.impact_summary?.released_count ?? "-"}</span>
                {plmDecision.decision?.blocked_by || plmDecision.blocked_by ? (
                  <span className="subtle">blocked: {plmDecision.decision?.blocked_by || plmDecision.blocked_by}</span>
                ) : null}
                {(plmDecision.decision?.matched_rules || plmDecision.matched_rules || []).length ? (
                  <span className="subtle">rules {(plmDecision.decision?.matched_rules || plmDecision.matched_rules).join(", ")}</span>
                ) : null}
              </div>
            ) : null}
          </div>

          {plmChanges ? (
            <div className="panel">
              <h3>Linked change records ({plmChanges.total})</h3>
              <table className="table">
                <thead><tr><th>Type</th><th>Number</th><th>Title</th><th>Status</th><th>Link status</th><th>Reason</th><th></th></tr></thead>
                <tbody>
                  {(plmChanges.items || []).map((link) => (
                    <tr key={link.link_ref}>
                      <td className="mono">{CHANGE_TYPE_LABELS[link.change_type] || link.change_type}</td>
                      <td className="mono">{link.change?.number || link.change_id}</td>
                      <td>{link.change?.title || "-"}</td>
                      <td className="mono">{link.change?.status || "-"}</td>
                      <td><Badge tone={link.status === "ACTIVE" ? "ok" : undefined}>{link.status}</Badge></td>
                      <td className="subtle">{link.reason || "-"}</td>
                      <td><button className="btn ghost" disabled={busy} onClick={() => unlinkPlmChange(link.link_ref)}>Unlink</button></td>
                    </tr>
                  ))}
                  {!(plmChanges.items || []).length ? (
                    <tr><td colSpan={7} className="subtle">No change records linked to this requirement.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {plmChain ? (
            <div className="panel">
              <h3>Change chain — {plmChain.change_request_count} request(s), {plmChain.order_count} order(s)</h3>
              {(plmChain.items || []).map((entry) => (
                <div key={entry.link_ref} style={{ marginBottom: "1rem" }}>
                  <div className="stack-row">
                    <Badge tone="ok">CR {entry.change_request?.number || entry.change_request?.ref}</Badge>
                    <span className="subtle">{entry.change_request?.title || "-"}</span>
                    <span className="subtle">status {entry.change_request?.status || "-"}</span>
                    <span className="subtle">orders {entry.order_count}</span>
                  </div>
                  {(entry.orders || []).length ? (
                    <table className="table">
                      <thead><tr><th>Order</th><th>Title</th><th>Status</th><th>Affected</th><th>Notices</th></tr></thead>
                      <tbody>
                        {entry.orders.map((order) => (
                          <tr key={order.order_ref || order.id}>
                            <td className="mono">{order.number || order.order_ref}</td>
                            <td>{order.title || "-"}</td>
                            <td className="mono">{order.status}</td>
                            <td className="mono">{order.affected_item_count}</td>
                            <td className="mono">{(order.notices || []).map((notice) => notice.number || notice.notice_ref).join(", ") || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="subtle">No change orders yet.</p>}
                </div>
              ))}
              {!(plmChain.items || []).length ? <p className="subtle">No change chain for this requirement.</p> : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "plmImpact" ? (
        <>
          <div className="panel">
            <h3>PLM impact analysis</h3>
            <p className="subtle">Traverse the digital thread from the requirement through allocated products, structures and change records.</p>
            <div className="stack-row">
              <label className="field"><span>Max depth</span>
                <input type="number" min="1" max="20" value={plmImpactDepth} onChange={(event) => setPlmImpactDepth(event.target.value)} />
              </label>
              <button className="btn" disabled={busy || !plmRef} onClick={runPlmImpact}>Analyze PLM impact</button>
            </div>
          </div>

          {plmImpact ? (
            <>
              <div className="panel">
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  <Badge tone={plmImpact.released_impacted ? "danger" : "ok"}>impacted {plmImpact.impacted_count}</Badge>
                  <span className="subtle">nodes {plmImpact.node_count}</span>
                  <span className="subtle">edges {plmImpact.edge_count}</span>
                  <span className="subtle">depth {plmImpact.depth_reached}</span>
                  <span className="subtle">released {plmImpact.released_count}</span>
                  {plmImpact.truncated ? <Badge tone="warn">truncated</Badge> : null}
                  {plmImpact.recommendation?.change_candidate ? <Badge tone="warn">change candidate</Badge> : null}
                </div>
                <div className="stack-row" style={{ flexWrap: "wrap" }}>
                  {Object.entries(plmImpact.category_totals || {}).map(([category, count]) => (
                    <span key={category} className="subtle">{category} {count}</span>
                  ))}
                </div>
              </div>

              <div className="panel">
                <h3>Impacted objects ({plmImpact.items?.length ?? 0})</h3>
                <table className="table">
                  <thead><tr><th>Type</th><th>Name</th><th>Domain</th><th>Depth</th><th>Category</th><th>Lifecycle</th><th>Released</th></tr></thead>
                  <tbody>
                    {(plmImpact.items || []).map((item) => (
                      <tr key={item.node_ref}>
                        <td className="mono">{item.object_type}</td>
                        <td>{item.display_name || item.node_ref}</td>
                        <td className="mono">{item.domain}</td>
                        <td className="mono">{item.depth}</td>
                        <td className="mono">{item.category}</td>
                        <td className="mono">{item.lifecycle_state || "-"}</td>
                        <td>{item.released ? <Badge tone="ok">yes</Badge> : <span className="subtle">no</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Integration configuration</h3>
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
    </div>
  );
}
