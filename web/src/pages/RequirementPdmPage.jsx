import React, { useEffect, useState } from "react";
import { requirementPdm, requirements, pdm, bom } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "allocations", label: "Allocations" },
  { key: "coverage", label: "Coverage & compatibility" },
  { key: "impact", label: "Impact & synchronization" },
  { key: "configuration", label: "Configuration" },
];

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
