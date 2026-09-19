import React, { useCallback, useEffect, useState } from "react";
import { versioning } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "revisions", label: "Revisions" },
  { key: "effectivities", label: "Effectivities" },
  { key: "resolve", label: "Resolve" },
  { key: "policies", label: "Policies" },
  { key: "baselines", label: "Baselines" },
  { key: "snapshots", label: "Snapshots" },
  { key: "variants", label: "Variants" },
  { key: "contexts", label: "Contexts" },
];

function fmt(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

function Badge({ status }) {
  const tone =
    status === "active" || status === "frozen" || status === "RESOLVED"
      ? "active"
      : status === "draft" || status === "AMBIGUOUS" || status === "CONFLICT"
        ? "locked"
        : "inactive";
  return <span className={`badge ${tone}`}>{status}</span>;
}

const EMPTY_REVISION = { objectType: "Part", objectId: "", revisionCode: "", name: "", effectiveFrom: "", effectiveTo: "", isDefault: false };
const EMPTY_EFFECTIVITY = { code: "", name: "", dimension: "date", typeCode: "DATE_EFFECTIVITY", effectiveFrom: "", effectiveTo: "", serialFrom: "", serialTo: "", serialMode: "numeric", overlapAllowed: false };
const EMPTY_ASSIGN = { definition: "", objectType: "Part", objectId: "", revisionId: "" };
const EMPTY_RESOLVE = { objectType: "Part", objectId: "", asOfDate: "", serialNumber: "", plantId: "", modelId: "", configurationId: "" };
const EMPTY_POLICY = { code: "", name: "", precedence: "configuration,revision,serial,model,plant,unit,date,default", ambiguityStrategy: "error", isDefault: false };
const EMPTY_BASELINE = { code: "", name: "", asOfDate: "", objectType: "Part", objectId: "" };
const EMPTY_SNAPSHOT = { code: "", name: "", asOfDate: "", objectType: "Part", objectId: "" };
const EMPTY_VARIANT = { code: "", name: "", options: "BASE,ELECTRIC", ruleCode: "", ruleValues: "", evaluateCode: "" };
const EMPTY_CONTEXT = { code: "", name: "", asOfDate: "", modelId: "", plantId: "" };

export default function VersioningPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [effectivities, setEffectivities] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [variants, setVariants] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [revisionForm, setRevisionForm] = useState(EMPTY_REVISION);
  const [effectivityForm, setEffectivityForm] = useState(EMPTY_EFFECTIVITY);
  const [assignForm, setAssignForm] = useState(EMPTY_ASSIGN);
  const [resolveForm, setResolveForm] = useState(EMPTY_RESOLVE);
  const [resolveResult, setResolveResult] = useState(null);
  const [policyForm, setPolicyForm] = useState(EMPTY_POLICY);
  const [baselineForm, setBaselineForm] = useState(EMPTY_BASELINE);
  const [snapshotForm, setSnapshotForm] = useState(EMPTY_SNAPSHOT);
  const [variantForm, setVariantForm] = useState(EMPTY_VARIANT);
  const [contextForm, setContextForm] = useState(EMPTY_CONTEXT);
  const [variantEval, setVariantEval] = useState(null);

  const loadAll = useCallback(async () => {
    const [metaRes, metricsRes, dashRes, revRes, effRes, polRes, blRes, snapRes, varRes, ctxRes] = await Promise.all([
      versioning.meta(),
      versioning.metrics(),
      versioning.dashboard(),
      versioning.revisions("?pageSize=50"),
      versioning.effectivities("?pageSize=50"),
      versioning.policies(),
      versioning.baselines("?pageSize=50"),
      versioning.snapshots("?pageSize=50"),
      versioning.variants("?pageSize=50"),
      versioning.contexts("?pageSize=50"),
    ]);
    setMeta(metaRes);
    setMetrics(metricsRes);
    setDashboard(dashRes);
    setRevisions(revRes.items || []);
    setEffectivities(effRes.items || []);
    setPolicies(polRes.items || []);
    setBaselines(blRes.items || []);
    setSnapshots(snapRes.items || []);
    setVariants(varRes.items || []);
    setContexts(ctxRes.items || []);
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      await loadAll();
    } catch (err) {
      setError(err.message);
    }
  }, [loadAll]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      const result = await fn();
      if (success) setNotice(success);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  async function createRevision(event) {
    event.preventDefault();
    const body = {
      objectType: revisionForm.objectType,
      objectId: revisionForm.objectId.trim(),
      revisionCode: revisionForm.revisionCode.trim(),
      name: revisionForm.name.trim() || undefined,
      isDefault: revisionForm.isDefault,
      status: "active",
    };
    if (revisionForm.effectiveFrom) body.effectiveFrom = revisionForm.effectiveFrom;
    if (revisionForm.effectiveTo) body.effectiveTo = revisionForm.effectiveTo;
    const created = await run(() => versioning.createRevision(body), `Revision ${body.revisionCode} created.`);
    if (created) setRevisionForm({ ...EMPTY_REVISION, objectType: revisionForm.objectType, objectId: revisionForm.objectId });
  }

  async function createEffectivity(event) {
    event.preventDefault();
    const body = {
      code: effectivityForm.code.trim().toUpperCase(),
      name: effectivityForm.name.trim() || effectivityForm.code.trim(),
      dimension: effectivityForm.dimension,
      typeCode: effectivityForm.typeCode || `${effectivityForm.dimension.toUpperCase()}_EFFECTIVITY`,
      overlapAllowed: effectivityForm.overlapAllowed,
    };
    if (effectivityForm.effectiveFrom) body.effectiveFrom = effectivityForm.effectiveFrom;
    if (effectivityForm.effectiveTo) body.effectiveTo = effectivityForm.effectiveTo;
    if (effectivityForm.serialFrom) body.serialFrom = effectivityForm.serialFrom;
    if (effectivityForm.serialTo) body.serialTo = effectivityForm.serialTo;
    body.serialMode = effectivityForm.serialMode;
    const created = await run(() => versioning.createEffectivity(body), `Effectivity ${body.code} created.`);
    if (created) setEffectivityForm(EMPTY_EFFECTIVITY);
  }

  async function assignEffectivity(event) {
    event.preventDefault();
    const body = { objectType: assignForm.objectType, objectId: assignForm.objectId.trim() };
    if (assignForm.revisionId) body.revisionId = Number(assignForm.revisionId);
    const created = await run(() => versioning.createAssignment(assignForm.definition, body), "Effectivity assigned.");
    if (created) setAssignForm({ ...EMPTY_ASSIGN, definition: assignForm.definition });
  }

  async function resolve() {
    const context = {};
    if (resolveForm.asOfDate) context.asOfDate = resolveForm.asOfDate;
    if (resolveForm.serialNumber) context.serialNumber = resolveForm.serialNumber;
    if (resolveForm.plantId) context.plantId = resolveForm.plantId;
    if (resolveForm.modelId) context.modelId = resolveForm.modelId;
    if (resolveForm.configurationId) context.configurationId = resolveForm.configurationId;
    await run(async () => {
      const result = await versioning.resolve({ objectType: resolveForm.objectType, objectId: resolveForm.objectId.trim(), context });
      setResolveResult(result);
    });
  }

  async function createPolicy(event) {
    event.preventDefault();
    const body = {
      code: policyForm.code.trim().toUpperCase(),
      name: policyForm.name.trim() || policyForm.code.trim(),
      precedence: policyForm.precedence.split(",").map((s) => s.trim()).filter(Boolean),
      ambiguityStrategy: policyForm.ambiguityStrategy,
      isDefault: policyForm.isDefault,
    };
    const created = await run(() => versioning.createPolicy(body), `Policy ${body.code} created.`);
    if (created) setPolicyForm(EMPTY_POLICY);
  }

  async function createBaseline(event) {
    event.preventDefault();
    const body = {
      code: baselineForm.code.trim().toUpperCase(),
      name: baselineForm.name.trim() || baselineForm.code.trim(),
      context: baselineForm.asOfDate ? { asOfDate: baselineForm.asOfDate } : {},
      objects: [{ objectType: baselineForm.objectType, objectId: baselineForm.objectId.trim() }],
    };
    const created = await run(() => versioning.createBaseline(body), `Baseline ${body.code} created.`);
    if (created) setBaselineForm(EMPTY_BASELINE);
  }

  async function createSnapshot(event) {
    event.preventDefault();
    const body = {
      code: snapshotForm.code.trim().toUpperCase(),
      name: snapshotForm.name.trim() || snapshotForm.code.trim(),
      context: snapshotForm.asOfDate ? { asOfDate: snapshotForm.asOfDate } : {},
      objects: [{ objectType: snapshotForm.objectType, objectId: snapshotForm.objectId.trim() }],
    };
    const created = await run(() => versioning.createSnapshot(body), `Snapshot ${body.code} created.`);
    if (created) setSnapshotForm(EMPTY_SNAPSHOT);
  }

  async function createVariant(event) {
    event.preventDefault();
    const options = variantForm.options
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((code, index) => ({ code, sequence: index + 1 }));
    const body = { code: variantForm.code.trim().toUpperCase(), name: variantForm.name.trim() || variantForm.code.trim(), options };
    if (variantForm.ruleCode && variantForm.ruleValues) {
      body.rules = [
        {
          code: variantForm.ruleCode.trim().toUpperCase(),
          ruleType: "inclusion",
          expression: {
            dimension: "variantCode",
            operator: "in",
            values: variantForm.ruleValues.split(",").map((s) => s.trim()).filter(Boolean),
          },
        },
      ];
    }
    const created = await run(() => versioning.createVariant(body), `Variant ${body.code} created.`);
    if (created) setVariantForm(EMPTY_VARIANT);
  }

  async function evaluateVariant(event) {
    event.preventDefault();
    await run(async () => {
      const result = await versioning.evaluateVariant(variantForm.code.trim().toUpperCase(), { variantCode: variantForm.evaluateCode.trim() });
      setVariantEval(result);
    });
  }

  async function createContext(event) {
    event.preventDefault();
    const body = { code: contextForm.code.trim().toUpperCase(), name: contextForm.name.trim() || contextForm.code.trim() };
    if (contextForm.asOfDate) body.asOfDate = contextForm.asOfDate;
    if (contextForm.modelId) body.modelId = contextForm.modelId;
    if (contextForm.plantId) body.plantId = contextForm.plantId;
    const created = await run(() => versioning.createContext(body), `Context ${body.code} created.`);
    if (created) setContextForm(EMPTY_CONTEXT);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Effectivity &amp; versioning</h1>
          <div className="crumbs">Deterministic as-of resolution across revisions, serials, plants, models, variants and configuration contexts.</div>
        </div>
        <button className="btn ghost" type="button" onClick={refresh}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="badge active" style={{ marginBottom: 12 }}>{notice}</div> : null}

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.key} type="button" className={`tab ${tab === item.key ? "active" : ""}`} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="grid">
            <div className="stat"><span>Revisions</span><b>{fmt(metrics?.revision_creation_count)}</b></div>
            <div className="stat"><span>Active revisions</span><b>{fmt(metrics?.revision_active_count)}</b></div>
            <div className="stat"><span>Versions</span><b>{fmt(metrics?.version_creation_count)}</b></div>
            <div className="stat"><span>Effectivities</span><b>{fmt(metrics?.effectivity_definition_count)}</b></div>
            <div className="stat"><span>Baselines</span><b>{fmt(metrics?.baseline_count)}</b></div>
            <div className="stat"><span>Snapshots</span><b>{fmt(metrics?.snapshot_count)}</b></div>
            <div className="stat"><span>Resolutions</span><b>{fmt(metrics?.resolution_requests)}</b></div>
            <div className="stat"><span>Conflicts</span><b>{fmt(metrics?.effectivity_conflicts)}</b></div>
            <div className="stat"><span>Ambiguous</span><b>{fmt(metrics?.ambiguous_resolutions)}</b></div>
            <div className="stat"><span>Avg latency</span><b>{fmt(metrics?.resolution_latency?.average_ms)} ms</b></div>
          </div>
          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Recent resolutions</h3></div>
              <table className="table">
                <thead><tr><th>Object</th><th>Status</th><th>Reason</th><th>At</th></tr></thead>
                <tbody>
                  {(dashboard?.recent_resolutions || []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.object_type}/{row.object_id}</td>
                      <td><Badge status={row.status} /></td>
                      <td className="mono">{row.reason}</td>
                      <td className="mono">{row.at}</td>
                    </tr>
                  ))}
                  {!(dashboard?.recent_resolutions || []).length ? <tr><td colSpan="4" className="sub">No resolutions recorded.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Effectivity types</h3></div>
              <div className="stack">
                {(meta?.effectivity_types || []).map((type) => (
                  <div className="stack-row" key={type.code}>
                    <span className="mono">{type.code}</span>
                    <span className="sub">{type.dimension}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head"><h3>Core precedence</h3></div>
            <div className="inline">
              {(meta?.core_precedence || []).map((dim) => <span className="badge locked" key={dim}>{dim}</span>)}
            </div>
          </div>
        </>
      ) : null}

      {tab === "revisions" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Revisions</h3></div>
            <table className="table">
              <thead><tr><th>Object</th><th>Rev</th><th>Seq</th><th>Effective</th><th>Status</th><th>Default</th><th /></tr></thead>
              <tbody>
                {revisions.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.object_type}/{row.object_id}</td>
                    <td className="mono">{row.revision_code}</td>
                    <td className="mono">{row.revision_sequence}</td>
                    <td className="mono">{fmt(row.effective_from)} {"->"} {fmt(row.effective_to)}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{row.is_default ? "yes" : "-"}</td>
                    <td className="inline">
                      {row.status !== "active" ? <button className="btn ghost" type="button" onClick={() => run(() => versioning.activateRevision(row.revision_ref), `${row.revision_code} activated.`)}>Activate</button> : null}
                      {row.status === "active" && !row.is_default ? <button className="btn ghost" type="button" onClick={() => run(() => versioning.setDefaultRevision(row.revision_ref), `${row.revision_code} is now default.`)}>Default</button> : null}
                      {row.status === "active" ? <button className="btn ghost" type="button" onClick={() => run(() => versioning.supersedeRevision(row.revision_ref), `${row.revision_code} superseded.`)}>Supersede</button> : null}
                      <button className="btn ghost" type="button" onClick={() => run(() => versioning.deleteRevision(row.revision_ref), `${row.revision_code} deleted.`)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!revisions.length ? <tr><td colSpan="7" className="sub">No revisions.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create revision</h3></div>
            <form onSubmit={createRevision} className="stack">
              <label className="field"><span>Object type</span><input value={revisionForm.objectType} onChange={(e) => setRevisionForm({ ...revisionForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Object id</span><input value={revisionForm.objectId} onChange={(e) => setRevisionForm({ ...revisionForm, objectId: e.target.value })} required /></label>
              <label className="field"><span>Revision code</span><input value={revisionForm.revisionCode} onChange={(e) => setRevisionForm({ ...revisionForm, revisionCode: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={revisionForm.name} onChange={(e) => setRevisionForm({ ...revisionForm, name: e.target.value })} /></label>
              <label className="field"><span>Effective from</span><input type="date" value={revisionForm.effectiveFrom} onChange={(e) => setRevisionForm({ ...revisionForm, effectiveFrom: e.target.value })} /></label>
              <label className="field"><span>Effective to</span><input type="date" value={revisionForm.effectiveTo} onChange={(e) => setRevisionForm({ ...revisionForm, effectiveTo: e.target.value })} /></label>
              <label className="inline"><input type="checkbox" checked={revisionForm.isDefault} onChange={(e) => setRevisionForm({ ...revisionForm, isDefault: e.target.checked })} /> <span>Default revision</span></label>
              <button className="btn" type="submit">Create revision</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "effectivities" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Effectivity definitions</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Dimension</th><th>Range</th><th>Overlap</th><th>Status</th></tr></thead>
              <tbody>
                {effectivities.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td className="mono">{row.dimension}</td>
                    <td className="mono">
                      {row.dimension === "serial" ? `${fmt(row.serial_from)} -> ${fmt(row.serial_to)}` : `${fmt(row.effective_from)} -> ${fmt(row.effective_to)}`}
                    </td>
                    <td className="mono">{row.overlap_allowed ? "allowed" : "prohibited"}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
                {!effectivities.length ? <tr><td colSpan="5" className="sub">No effectivity definitions.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create effectivity</h3></div>
            <form onSubmit={createEffectivity} className="stack">
              <label className="field"><span>Code</span><input value={effectivityForm.code} onChange={(e) => setEffectivityForm({ ...effectivityForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={effectivityForm.name} onChange={(e) => setEffectivityForm({ ...effectivityForm, name: e.target.value })} /></label>
              <label className="field">
                <span>Dimension</span>
                <select value={effectivityForm.dimension} onChange={(e) => setEffectivityForm({ ...effectivityForm, dimension: e.target.value, typeCode: `${e.target.value.toUpperCase()}_EFFECTIVITY` })}>
                  {(meta?.dimensions || ["date", "serial", "plant", "unit", "model", "variant"]).map((dim) => <option key={dim} value={dim}>{dim}</option>)}
                </select>
              </label>
              <label className="field"><span>Effective from</span><input type="date" value={effectivityForm.effectiveFrom} onChange={(e) => setEffectivityForm({ ...effectivityForm, effectiveFrom: e.target.value })} /></label>
              <label className="field"><span>Effective to</span><input type="date" value={effectivityForm.effectiveTo} onChange={(e) => setEffectivityForm({ ...effectivityForm, effectiveTo: e.target.value })} /></label>
              {effectivityForm.dimension === "serial" ? (
                <>
                  <label className="field"><span>Serial from</span><input value={effectivityForm.serialFrom} onChange={(e) => setEffectivityForm({ ...effectivityForm, serialFrom: e.target.value })} /></label>
                  <label className="field"><span>Serial to</span><input value={effectivityForm.serialTo} onChange={(e) => setEffectivityForm({ ...effectivityForm, serialTo: e.target.value })} /></label>
                </>
              ) : null}
              <label className="inline"><input type="checkbox" checked={effectivityForm.overlapAllowed} onChange={(e) => setEffectivityForm({ ...effectivityForm, overlapAllowed: e.target.checked })} /> <span>Allow overlap</span></label>
              <button className="btn" type="submit">Create effectivity</button>
            </form>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Assign to target</h3></div>
            <form onSubmit={assignEffectivity} className="stack">
              <label className="field">
                <span>Definition</span>
                <select value={assignForm.definition} onChange={(e) => setAssignForm({ ...assignForm, definition: e.target.value })} required>
                  <option value="">Select...</option>
                  {effectivities.map((row) => <option key={row.id} value={row.definition_ref}>{row.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Object type</span><input value={assignForm.objectType} onChange={(e) => setAssignForm({ ...assignForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Object id</span><input value={assignForm.objectId} onChange={(e) => setAssignForm({ ...assignForm, objectId: e.target.value })} required /></label>
              <label className="field"><span>Revision id (optional)</span><input value={assignForm.revisionId} onChange={(e) => setAssignForm({ ...assignForm, revisionId: e.target.value })} /></label>
              <button className="btn" type="submit">Assign</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "resolve" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Resolve as-of</h3></div>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); resolve(); }}>
              <label className="field"><span>Object type</span><input value={resolveForm.objectType} onChange={(e) => setResolveForm({ ...resolveForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Object id</span><input value={resolveForm.objectId} onChange={(e) => setResolveForm({ ...resolveForm, objectId: e.target.value })} required /></label>
              <label className="field"><span>As-of date</span><input type="date" value={resolveForm.asOfDate} onChange={(e) => setResolveForm({ ...resolveForm, asOfDate: e.target.value })} /></label>
              <label className="field"><span>Serial number</span><input value={resolveForm.serialNumber} onChange={(e) => setResolveForm({ ...resolveForm, serialNumber: e.target.value })} /></label>
              <label className="field"><span>Plant</span><input value={resolveForm.plantId} onChange={(e) => setResolveForm({ ...resolveForm, plantId: e.target.value })} /></label>
              <label className="field"><span>Model</span><input value={resolveForm.modelId} onChange={(e) => setResolveForm({ ...resolveForm, modelId: e.target.value })} /></label>
              <label className="field"><span>Configuration context</span><input value={resolveForm.configurationId} onChange={(e) => setResolveForm({ ...resolveForm, configurationId: e.target.value })} /></label>
              <button className="btn" type="submit">Resolve</button>
            </form>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Result</h3></div>
            {resolveResult ? (
              <ul className="detail-list">
                <li>status: <Badge status={resolveResult.resolutionStatus} /></li>
                <li>revision: <span className="mono">{fmt(resolveResult.revisionCode)}</span></li>
                <li>version: <span className="mono">{fmt(resolveResult.versionNumber)}</span></li>
                <li>reason: <span className="mono">{fmt(resolveResult.resolutionReason)}</span></li>
                <li>dimension: <span className="mono">{fmt(resolveResult.dimension)}</span></li>
                <li>policy: <span className="mono">{fmt(resolveResult.policy)}</span></li>
                <li>message: <span className="mono">{fmt(resolveResult.message)}</span></li>
              </ul>
            ) : (
              <p className="sub">Resolve an object to see the deterministic revision here.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "policies" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Resolution policies</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Precedence</th><th>Ambiguity</th><th>Default</th><th>Status</th></tr></thead>
              <tbody>
                {policies.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td className="mono">{(row.precedence || []).join(" > ")}</td>
                    <td className="mono">{row.ambiguity_strategy}</td>
                    <td className="mono">{row.is_default ? "yes" : "-"}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
                {!policies.length ? <tr><td colSpan="5" className="sub">No policies.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create policy</h3></div>
            <form onSubmit={createPolicy} className="stack">
              <label className="field"><span>Code</span><input value={policyForm.code} onChange={(e) => setPolicyForm({ ...policyForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} /></label>
              <label className="field"><span>Precedence (comma separated)</span><input value={policyForm.precedence} onChange={(e) => setPolicyForm({ ...policyForm, precedence: e.target.value })} required /></label>
              <label className="field">
                <span>Ambiguity strategy</span>
                <select value={policyForm.ambiguityStrategy} onChange={(e) => setPolicyForm({ ...policyForm, ambiguityStrategy: e.target.value })}>
                  {(meta?.ambiguity_strategies || ["error", "priority", "latest_revision"]).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="inline"><input type="checkbox" checked={policyForm.isDefault} onChange={(e) => setPolicyForm({ ...policyForm, isDefault: e.target.checked })} /> <span>Make default</span></label>
              <button className="btn" type="submit">Create policy</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "baselines" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Baselines</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Objects</th><th>Status</th><th>Locked</th><th /></tr></thead>
              <tbody>
                {baselines.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td className="mono">{(row.objects || []).length}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{row.locked ? "yes" : "-"}</td>
                    <td className="inline">
                      {row.status !== "frozen" ? <button className="btn ghost" type="button" onClick={() => run(() => versioning.freezeBaseline(row.baseline_ref), `${row.code} frozen.`)}>Freeze</button> : null}
                      <button className="btn ghost" type="button" onClick={() => run(() => versioning.restoreBaseline(row.baseline_ref), `${row.code} restored.`)}>Restore</button>
                    </td>
                  </tr>
                ))}
                {!baselines.length ? <tr><td colSpan="5" className="sub">No baselines.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create baseline</h3></div>
            <form onSubmit={createBaseline} className="stack">
              <label className="field"><span>Code</span><input value={baselineForm.code} onChange={(e) => setBaselineForm({ ...baselineForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={baselineForm.name} onChange={(e) => setBaselineForm({ ...baselineForm, name: e.target.value })} /></label>
              <label className="field"><span>As-of date</span><input type="date" value={baselineForm.asOfDate} onChange={(e) => setBaselineForm({ ...baselineForm, asOfDate: e.target.value })} /></label>
              <label className="field"><span>Object type</span><input value={baselineForm.objectType} onChange={(e) => setBaselineForm({ ...baselineForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Object id</span><input value={baselineForm.objectId} onChange={(e) => setBaselineForm({ ...baselineForm, objectId: e.target.value })} required /></label>
              <button className="btn" type="submit">Create baseline</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "snapshots" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Snapshots</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Objects</th><th>Status</th><th>Hash</th><th /></tr></thead>
              <tbody>
                {snapshots.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td className="mono">{(row.objects || []).length}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="mono">{fmt((row.content_hash || "").slice(0, 12))}</td>
                    <td className="inline">
                      <button className="btn ghost" type="button" onClick={() => run(() => versioning.reconstructSnapshot(row.snapshot_ref), `${row.code} reconstructed.`)}>Reconstruct</button>
                      {row.status !== "archived" ? <button className="btn ghost" type="button" onClick={() => run(() => versioning.archiveSnapshot(row.snapshot_ref), `${row.code} archived.`)}>Archive</button> : null}
                    </td>
                  </tr>
                ))}
                {!snapshots.length ? <tr><td colSpan="5" className="sub">No snapshots.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create snapshot</h3></div>
            <form onSubmit={createSnapshot} className="stack">
              <label className="field"><span>Code</span><input value={snapshotForm.code} onChange={(e) => setSnapshotForm({ ...snapshotForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={snapshotForm.name} onChange={(e) => setSnapshotForm({ ...snapshotForm, name: e.target.value })} /></label>
              <label className="field"><span>As-of date</span><input type="date" value={snapshotForm.asOfDate} onChange={(e) => setSnapshotForm({ ...snapshotForm, asOfDate: e.target.value })} /></label>
              <label className="field"><span>Object type</span><input value={snapshotForm.objectType} onChange={(e) => setSnapshotForm({ ...snapshotForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Object id</span><input value={snapshotForm.objectId} onChange={(e) => setSnapshotForm({ ...snapshotForm, objectId: e.target.value })} required /></label>
              <button className="btn" type="submit">Create snapshot</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "variants" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Variants</h3></div>
            <div className="stack">
              {variants.map((row) => (
                <div className="stack-row" key={row.id}>
                  <div>
                    <div className="type-name">{row.name} <span className="mono">{row.code}</span></div>
                    <div className="mono">{(row.options || []).map((o) => o.code).join(", ")} · {(row.rules || []).length} rules</div>
                  </div>
                  <Badge status={row.status} />
                </div>
              ))}
              {!variants.length ? <p className="sub">No variants.</p> : null}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create / evaluate variant</h3></div>
            <form onSubmit={createVariant} className="stack">
              <label className="field"><span>Code</span><input value={variantForm.code} onChange={(e) => setVariantForm({ ...variantForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={variantForm.name} onChange={(e) => setVariantForm({ ...variantForm, name: e.target.value })} /></label>
              <label className="field"><span>Options (comma separated)</span><input value={variantForm.options} onChange={(e) => setVariantForm({ ...variantForm, options: e.target.value })} /></label>
              <label className="field"><span>Rule code</span><input value={variantForm.ruleCode} onChange={(e) => setVariantForm({ ...variantForm, ruleCode: e.target.value })} /></label>
              <label className="field"><span>Rule values (comma separated)</span><input value={variantForm.ruleValues} onChange={(e) => setVariantForm({ ...variantForm, ruleValues: e.target.value })} /></label>
              <button className="btn" type="submit">Create variant</button>
            </form>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Evaluate</h3></div>
            <form onSubmit={evaluateVariant} className="stack">
              <label className="field"><span>Variant code</span><input value={variantForm.code} onChange={(e) => setVariantForm({ ...variantForm, code: e.target.value })} required /></label>
              <label className="field"><span>Variant option</span><input value={variantForm.evaluateCode} onChange={(e) => setVariantForm({ ...variantForm, evaluateCode: e.target.value })} /></label>
              <button className="btn ghost" type="submit">Evaluate</button>
            </form>
            {variantEval ? <p className="sub">Applicable: <span className="mono">{String(variantEval.applicable)}</span></p> : null}
          </div>
        </div>
      ) : null}

      {tab === "contexts" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Configuration contexts</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>As-of</th><th>Model</th><th>Plant</th><th>Status</th></tr></thead>
              <tbody>
                {contexts.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td className="mono">{fmt(row.as_of_date)}</td>
                    <td className="mono">{fmt(row.model_id)}</td>
                    <td className="mono">{fmt(row.plant_id)}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
                {!contexts.length ? <tr><td colSpan="5" className="sub">No configuration contexts.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create context</h3></div>
            <form onSubmit={createContext} className="stack">
              <label className="field"><span>Code</span><input value={contextForm.code} onChange={(e) => setContextForm({ ...contextForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={contextForm.name} onChange={(e) => setContextForm({ ...contextForm, name: e.target.value })} /></label>
              <label className="field"><span>As-of date</span><input type="date" value={contextForm.asOfDate} onChange={(e) => setContextForm({ ...contextForm, asOfDate: e.target.value })} /></label>
              <label className="field"><span>Model</span><input value={contextForm.modelId} onChange={(e) => setContextForm({ ...contextForm, modelId: e.target.value })} /></label>
              <label className="field"><span>Plant</span><input value={contextForm.plantId} onChange={(e) => setContextForm({ ...contextForm, plantId: e.target.value })} /></label>
              <button className="btn" type="submit">Create context</button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
