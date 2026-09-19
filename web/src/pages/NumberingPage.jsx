import React, { useCallback, useEffect, useState } from "react";
import { numbering } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "schemes", label: "Schemes" },
  { key: "generate", label: "Generate" },
  { key: "allocations", label: "Allocations" },
  { key: "sequences", label: "Sequences" },
];

function StatusBadge({ status }) {
  const tone = status === "active" || status === "consumed" ? "active" : status === "reserved" || status === "allocated" ? "locked" : "inactive";
  return <span className={`badge ${tone}`}>{status}</span>;
}

function fmt(value) {
  return value === null || value === undefined ? "–" : value;
}

export default function NumberingPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [objectTypes, setObjectTypes] = useState([]);
  const [schemes, setSchemes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [allocationQuery, setAllocationQuery] = useState({ status: "", objectType: "" });
  const [sequences, setSequences] = useState([]);
  const [genForm, setGenForm] = useState({ objectType: "PART", organizationId: "", manualNumber: "", reserve: false });
  const [genResult, setGenResult] = useState(null);
  const [schemeForm, setSchemeForm] = useState({ code: "", name: "", objectType: "PART", pattern: "{TYPE}-{YYYY}-{SEQ}", padding: 6 });

  const loadOverview = useCallback(async () => {
    const [metricsRes, healthRes, typesRes] = await Promise.all([numbering.metrics(), numbering.health(), numbering.objectTypes()]);
    setMetrics(metricsRes);
    setHealth(healthRes);
    setObjectTypes(typesRes.items || []);
  }, []);

  const loadSchemes = useCallback(async () => {
    const res = await numbering.schemes();
    setSchemes(res.items || []);
  }, []);

  const loadAllocations = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("pageSize", "25");
    if (allocationQuery.status) params.set("status", allocationQuery.status);
    if (allocationQuery.objectType) params.set("objectType", allocationQuery.objectType);
    const res = await numbering.allocations(`?${params.toString()}`);
    setAllocations(res.items || []);
  }, [allocationQuery]);

  const loadSequences = useCallback(async () => {
    const res = await numbering.sequences("?pageSize=50");
    setSequences(res.items || []);
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadOverview(), loadSchemes(), loadAllocations(), loadSequences()]);
    } catch (err) {
      setError(err.message);
    }
  }, [loadOverview, loadSchemes, loadAllocations, loadSequences]);

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

  async function preview() {
    const body = { objectType: genForm.objectType };
    if (genForm.organizationId) body.organizationId = Number(genForm.organizationId);
    if (genForm.manualNumber) body.manualNumber = genForm.manualNumber;
    await run(async () => {
      const result = await numbering.preview(body);
      setGenResult({ mode: "preview", ...result });
    });
  }

  async function generate() {
    const body = { objectType: genForm.objectType };
    if (genForm.organizationId) body.organizationId = Number(genForm.organizationId);
    if (genForm.manualNumber) body.manualNumber = genForm.manualNumber;
    if (genForm.reserve) {
      const result = await run(() => numbering.reserve(body), "Identifier reserved.");
      if (result) setGenResult({ mode: "reserve", ...result });
      return;
    }
    const result = await run(() => numbering.generate(body), "Identifier generated.");
    if (result) setGenResult({ mode: "generate", ...result });
  }

  async function createScheme(event) {
    event.preventDefault();
    const body = {
      code: schemeForm.code.trim().toUpperCase(),
      name: schemeForm.name.trim(),
      objectType: schemeForm.objectType,
      pattern: schemeForm.pattern,
      padding: Number(schemeForm.padding) || 6,
      status: "draft",
    };
    const created = await run(() => numbering.createScheme(body), `Scheme ${body.code} created.`);
    if (created) setSchemeForm({ code: "", name: "", objectType: "PART", pattern: "{TYPE}-{YYYY}-{SEQ}", padding: 6 });
  }

  const allocationStats = metrics?.allocations || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Numbering &amp; identifiers</h1>
          <div className="crumbs">Central, concurrency-safe identifier generation for every business module.</div>
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
            <div className="stat"><span>Active schemes</span><b>{fmt(metrics?.schemes?.active)}</b></div>
            <div className="stat"><span>Allocated</span><b>{fmt(allocationStats.allocated)}</b></div>
            <div className="stat"><span>Reserved</span><b>{fmt(allocationStats.reserved)}</b></div>
            <div className="stat"><span>Consumed</span><b>{fmt(allocationStats.consumed)}</b></div>
            <div className="stat"><span>Generated today</span><b>{fmt(metrics?.generated_today)}</b></div>
            <div className="stat"><span>Health</span><b>{health?.healthy ? "Healthy" : "Degraded"}</b></div>
          </div>
          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Service status</h3></div>
              <ul className="detail-list">
                <li>ready: <span className="mono">{String(health?.ready ?? false)}</span></li>
                <li>exhausted sequences: <span className="mono">{fmt(health?.exhausted_sequences)}</span></li>
                <li>expired reservations: <span className="mono">{fmt(health?.expired_reservations)}</span></li>
                <li>generation latency: <span className="mono">{fmt(metrics?.generation_latency?.avg_ms)} ms</span></li>
              </ul>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Registered object types</h3></div>
              <div className="stack">
                {objectTypes.map((type) => (
                  <div className="stack-row" key={type.code}>
                    <span className="mono">{type.code}</span>
                    <StatusBadge status={type.status} />
                  </div>
                ))}
                {!objectTypes.length ? <p className="sub">No object types registered.</p> : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {tab === "schemes" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Schemes</h3></div>
            <div className="stack">
              {schemes.map((scheme) => (
                <div className="stack-row" key={scheme.id}>
                  <div>
                    <div className="type-name">{scheme.name} <span className="mono">{scheme.code}</span></div>
                    <div className="mono">{scheme.object_type} · {scheme.pattern} · v{scheme.version}</div>
                  </div>
                  <div className="inline">
                    <StatusBadge status={scheme.status} />
                    {scheme.status !== "active" ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => numbering.activateScheme(scheme.code), `${scheme.code} activated.`)}>Activate</button>
                    ) : (
                      <button className="btn ghost" type="button" onClick={() => run(() => numbering.deactivateScheme(scheme.code), `${scheme.code} deactivated.`)}>Deactivate</button>
                    )}
                    {scheme.status !== "retired" ? (
                      <button className="btn ghost" type="button" onClick={() => run(() => numbering.retireScheme(scheme.code), `${scheme.code} retired.`)}>Retire</button>
                    ) : null}
                  </div>
                </div>
              ))}
              {!schemes.length ? <p className="sub">No schemes defined.</p> : null}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create scheme</h3></div>
            <form onSubmit={createScheme} className="stack">
              <label className="field"><span>Code</span><input value={schemeForm.code} onChange={(e) => setSchemeForm({ ...schemeForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={schemeForm.name} onChange={(e) => setSchemeForm({ ...schemeForm, name: e.target.value })} required /></label>
              <label className="field"><span>Object type</span><input value={schemeForm.objectType} onChange={(e) => setSchemeForm({ ...schemeForm, objectType: e.target.value })} required /></label>
              <label className="field"><span>Pattern</span><input value={schemeForm.pattern} onChange={(e) => setSchemeForm({ ...schemeForm, pattern: e.target.value })} required /></label>
              <label className="field"><span>Padding</span><input type="number" min="0" value={schemeForm.padding} onChange={(e) => setSchemeForm({ ...schemeForm, padding: e.target.value })} /></label>
              <button className="btn" type="submit">Create scheme</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "generate" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Generate identifier</h3></div>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); generate(); }}>
              <label className="field"><span>Object type</span><input value={genForm.objectType} onChange={(e) => setGenForm({ ...genForm, objectType: e.target.value.toUpperCase() })} required /></label>
              <label className="field"><span>Organization id (optional)</span><input value={genForm.organizationId} onChange={(e) => setGenForm({ ...genForm, organizationId: e.target.value })} /></label>
              <label className="field"><span>Manual number (optional)</span><input value={genForm.manualNumber} onChange={(e) => setGenForm({ ...genForm, manualNumber: e.target.value })} /></label>
              <label className="inline"><input type="checkbox" checked={genForm.reserve} onChange={(e) => setGenForm({ ...genForm, reserve: e.target.checked })} /> <span>Reserve instead of allocate</span></label>
              <div className="inline">
                <button className="btn ghost" type="button" onClick={preview}>Preview</button>
                <button className="btn" type="submit">{genForm.reserve ? "Reserve" : "Generate"}</button>
              </div>
            </form>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Result</h3></div>
            {genResult ? (
              <ul className="detail-list">
                <li>number: <span className="mono">{genResult.number}</span></li>
                <li>mode: <span className="mono">{genResult.mode}</span></li>
                <li>scheme: <span className="mono">{genResult.scheme_code || genResult.scheme || "–"}</span></li>
                <li>status: <span className="mono">{genResult.status || "preview"}</span></li>
                <li>sequence value: <span className="mono">{fmt(genResult.sequence_value)}</span></li>
              </ul>
            ) : (
              <p className="sub">Generate or preview an identifier to see the result here.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "allocations" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Allocations</h3>
            <div className="inline">
              <input placeholder="status" value={allocationQuery.status} onChange={(e) => setAllocationQuery({ ...allocationQuery, status: e.target.value })} />
              <input placeholder="object type" value={allocationQuery.objectType} onChange={(e) => setAllocationQuery({ ...allocationQuery, objectType: e.target.value })} />
              <button className="btn ghost" type="button" onClick={loadAllocations}>Filter</button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr><th>Number</th><th>Object</th><th>Scheme</th><th>Status</th><th>Requested</th><th /></tr>
            </thead>
            <tbody>
              {allocations.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.number}</td>
                  <td className="mono">{row.object_type}</td>
                  <td className="mono">{row.scheme_code}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="mono">{row.requested_at}</td>
                  <td className="inline">
                    {row.status === "reserved" || row.status === "allocated" ? (
                      <>
                        <button className="btn ghost" type="button" onClick={() => run(() => numbering.consumeAllocation(row.id, {}), `${row.number} consumed.`)}>Consume</button>
                        <button className="btn ghost" type="button" onClick={() => run(() => numbering.releaseAllocation(row.id, {}), `${row.number} released.`)}>Release</button>
                        <button className="btn ghost" type="button" onClick={() => run(() => numbering.cancelAllocation(row.id, {}), `${row.number} cancelled.`)}>Cancel</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!allocations.length ? <tr><td colSpan="6" className="sub">No allocations found.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "sequences" ? (
        <div className="panel">
          <div className="panel-head"><h3>Sequences</h3></div>
          <table className="table">
            <thead>
              <tr><th>Scheme</th><th>Scope</th><th>Period</th><th>Current</th><th>Next</th><th>Remaining</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {sequences.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.scheme_code}</td>
                  <td className="mono">{row.scope_key}</td>
                  <td className="mono">{row.period_key || "–"}</td>
                  <td className="mono">{row.current_value}</td>
                  <td className="mono">{row.next_value}</td>
                  <td className="mono">{row.remaining}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>
                    <button className="btn ghost" type="button" onClick={() => run(() => numbering.resetSequence(row.id, {}), `Sequence ${row.id} reset.`)}>Reset</button>
                  </td>
                </tr>
              ))}
              {!sequences.length ? <tr><td colSpan="8" className="sub">No sequences yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
