import React, { useEffect, useState } from "react";
import { dataLifecycle } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "objects", label: "Tracked objects" },
  { key: "policies", label: "Retention policies" },
  { key: "legalholds", label: "Legal holds" },
  { key: "archives", label: "Archive & purge" },
  { key: "jobs", label: "Jobs" },
  { key: "configuration", label: "Configuration" },
];

const emptyObject = { object_type: "", object_id: "", object_ref: "", current_state: "ACTIVE", classification: "internal", retention_anchor: "" };
const emptyPolicy = {
  code: "",
  name: "",
  scope_type: "OBJECT_TYPE",
  object_type: "",
  retention_period_days: 365,
  retention_basis: "LAST_MODIFIED_DATE",
  archive_after_days: 90,
  cold_storage_after_days: 180,
  purge_after_days: 365,
  data_tier: "HOT",
  status: "active",
};
const emptyHold = { code: "", name: "", scope_type: "OBJECT", object_type: "", object_id: "", reason: "" };
const emptyOperation = { object_type: "", object_id: "", action: "ARCHIVE", reason: "" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function stateTone(state) {
  if (state === "ACTIVE") return "ok";
  if (state === "INACTIVE" || state === "ARCHIVED") return "warn";
  if (state === "PURGED") return "danger";
  return undefined;
}

export default function DataLifecyclePage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState(null);
  const [states, setStates] = useState([]);
  const [objects, setObjects] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [holds, setHolds] = useState([]);
  const [archives, setArchives] = useState([]);
  const [purges, setPurges] = useState([]);
  const [jobs, setJobs] = useState([]);

  const [objectForm, setObjectForm] = useState(emptyObject);
  const [policyForm, setPolicyForm] = useState(emptyPolicy);
  const [holdForm, setHoldForm] = useState(emptyHold);
  const [operation, setOperation] = useState(emptyOperation);
  const [eligibility, setEligibility] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, m, h, cfg, st, obj, pol, hl, arc, prg, jb] = await Promise.all([
        dataLifecycle.meta(),
        dataLifecycle.metrics(),
        dataLifecycle.health(),
        dataLifecycle.configuration(),
        dataLifecycle.states(),
        dataLifecycle.objects("?pageSize=50"),
        dataLifecycle.policies("?pageSize=50"),
        dataLifecycle.legalHolds("?pageSize=50"),
        dataLifecycle.archives("?pageSize=25"),
        dataLifecycle.purges("?pageSize=25"),
        dataLifecycle.jobs("?pageSize=25"),
      ]);
      setMeta(met);
      setMetrics(m);
      setHealth(h);
      setConfiguration(cfg);
      setStates(st.items || []);
      setObjects(obj.items || []);
      setPolicies(pol.items || []);
      setHolds(hl.items || []);
      setArchives(arc.items || []);
      setPurges(prg.items || []);
      setJobs(jb.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function update(setter, form) {
    return (event) => {
      const { name, value } = event.target;
      setter({ ...form, [name]: value });
    };
  }

  const onChangeObject = update(setObjectForm, objectForm);
  const onChangePolicy = update(setPolicyForm, policyForm);
  const onChangeHold = update(setHoldForm, holdForm);
  const onChangeOperation = update(setOperation, operation);

  const retentionBases = meta?.capabilities?.retention_bases || [];
  const tiers = meta?.capabilities?.data_tiers || [];
  const holdScopeTypes = meta?.capabilities?.legal_hold_scope_types || [];
  const eligibilityActions = meta?.capabilities?.eligibility_actions || [];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Data lifecycle</div>
          <h1>Data lifecycle &amp; archival</h1>
          <p className="sub">
            Centralized lifecycle states, retention policies, legal holds, archiving, restore, recovery and purge.
            Business modules register objects here rather than building their own archival engines.
          </p>
        </div>
        <div className="stack-row">
          <button className="btn ghost" onClick={refresh} disabled={busy}>Refresh</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="chips" style={{ marginBottom: 12 }}>
        {TABS.map((entry) => (
          <button key={entry.key} className={`chip link-btn${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            {metrics ? (
              <>
                <div className="panel grow"><h3>Tracked objects</h3><div className="mono">{metrics.counters.objects_tracked}</div></div>
                <div className="panel grow"><h3>Archived</h3><div className="mono">{metrics.counters.objects_archived}</div></div>
                <div className="panel grow"><h3>Cold storage</h3><div className="mono">{metrics.counters.objects_cold}</div></div>
                <div className="panel grow"><h3>Legal holds</h3><div className="mono">{metrics.counters.legal_holds_active}</div></div>
                <div className="panel grow"><h3>Purged</h3><div className="mono">{metrics.counters.objects_purged}</div></div>
                <div className="panel grow"><h3>Archive bytes</h3><div className="mono">{metrics.counters.archive_bytes}</div></div>
              </>
            ) : (
              <div className="panel grow mono">Loading…</div>
            )}
          </div>

          <div className="panel">
            <h3>Due work</h3>
            {metrics ? (
              <div className="chips">
                <Badge>Due for archive · {metrics.counters.due_for_archive}</Badge>
                <Badge>Due for cold storage · {metrics.counters.due_for_cold_storage}</Badge>
                <Badge>Due for purge · {metrics.counters.due_for_purge}</Badge>
                <Badge>Under legal hold · {metrics.counters.objects_under_legal_hold}</Badge>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <h3>Health · {health?.status || "unknown"}</h3>
            {health?.checks?.length ? (
              <div className="chips">
                {health.checks.map((check) => (
                  <Badge key={check.name} tone={check.status === "ok" ? "ok" : "warn"}>{check.name}: {check.status}</Badge>
                ))}
              </div>
            ) : (
              <div className="mono">No health data.</div>
            )}
          </div>

          <div className="panel">
            <h3>Objects by state</h3>
            {metrics?.by_state?.length ? (
              <div className="chips">
                {metrics.by_state.map((row) => (
                  <Badge key={row.key} tone={stateTone(row.key)}>{row.key} · {row.count}</Badge>
                ))}
              </div>
            ) : (
              <div className="mono">No tracked objects.</div>
            )}
          </div>
        </>
      ) : null}

      {tab === "objects" ? (
        <>
          <div className="panel">
            <h3>Register / refresh an object</h3>
            <div className="grid">
              <label className="field"><span>Object type</span><input name="object_type" value={objectForm.object_type} onChange={onChangeObject} /></label>
              <label className="field"><span>Object id</span><input name="object_id" value={objectForm.object_id} onChange={onChangeObject} /></label>
              <label className="field"><span>Reference</span><input name="object_ref" value={objectForm.object_ref} onChange={onChangeObject} /></label>
              <label className="field"><span>Initial state</span>
                <select name="current_state" value={objectForm.current_state} onChange={onChangeObject}>
                  {states.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Classification</span><input name="classification" value={objectForm.classification} onChange={onChangeObject} /></label>
              <label className="field"><span>Retention anchor (optional)</span><input name="retention_anchor" value={objectForm.retention_anchor} onChange={onChangeObject} placeholder="ISO date" /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => dataLifecycle.registerObject({ ...objectForm, retention_anchor: objectForm.retention_anchor || undefined }))}>Register</button>
          </div>

          <div className="panel">
            <h3>Tracked objects ({objects.length})</h3>
            <table className="table">
              <thead><tr><th>Object</th><th>State</th><th>Tier</th><th>Legal hold</th><th>Archive eligible</th><th></th></tr></thead>
              <tbody>
                {objects.map((row) => (
                  <tr key={`${row.object_type}-${row.object_id}`}>
                    <td>{row.object_type} · {row.object_id}{row.object_ref ? ` (${row.object_ref})` : ""}</td>
                    <td><Badge tone={stateTone(row.current_state)}>{row.current_state}</Badge></td>
                    <td>{row.data_tier}</td>
                    <td>{row.legal_hold_status}</td>
                    <td className="mono">{row.archive_eligible_at || "—"}</td>
                    <td>
                      {states.map((s) => (
                        <button
                          key={s.code}
                          className="chip link-btn"
                          disabled={busy || s.code === row.current_state}
                          onClick={() => run(() => dataLifecycle.changeObjectState(row.object_type, row.object_id, { to_state: s.code, reason: "console" }))}
                        >
                          {s.code}
                        </button>
                      ))}
                    </td>
                  </tr>
                ))}
                {!objects.length ? <tr><td colSpan={6} className="mono">No tracked objects.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Eligibility &amp; operations</h3>
            <div className="grid">
              <label className="field"><span>Object type</span><input name="object_type" value={operation.object_type} onChange={onChangeOperation} /></label>
              <label className="field"><span>Object id</span><input name="object_id" value={operation.object_id} onChange={onChangeOperation} /></label>
              <label className="field"><span>Action</span>
                <select name="action" value={operation.action} onChange={onChangeOperation}>
                  {eligibilityActions.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy} onClick={() => run(async () => setEligibility(await dataLifecycle.checkEligibility({ object_type: operation.object_type, object_id: operation.object_id, action: operation.action })))}>Check eligibility</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.archiveObject({ object_type: operation.object_type, object_id: operation.object_id, reason: operation.reason }))}>Archive</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.moveToColdStorage(operation.object_type, operation.object_id, { reason: operation.reason }))}>Cold storage</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.restoreObjectByRef(operation.object_type, operation.object_id, { reason: operation.reason }))}>Restore</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.executePurge({ object_type: operation.object_type, object_id: operation.object_id, reason: operation.reason }))}>Purge</button>
            </div>
            {eligibility ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Result: {eligibility.result} {eligibility.eligible ? "(eligible)" : "(blocked)"}</h3>
                <ul>
                  {(eligibility.reasons || []).map((reason, index) => (
                    <li key={`${reason.code}-${index}`} className="mono">[{reason.severity}] {reason.code} — {reason.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "policies" ? (
        <>
          <div className="panel">
            <h3>Create a retention policy</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={policyForm.code} onChange={onChangePolicy} /></label>
              <label className="field"><span>Name</span><input name="name" value={policyForm.name} onChange={onChangePolicy} /></label>
              <label className="field"><span>Object type</span><input name="object_type" value={policyForm.object_type} onChange={onChangePolicy} /></label>
              <label className="field"><span>Retention basis</span>
                <select name="retention_basis" value={policyForm.retention_basis} onChange={onChangePolicy}>
                  {retentionBases.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label className="field"><span>Retention days</span><input name="retention_period_days" type="number" value={policyForm.retention_period_days} onChange={onChangePolicy} /></label>
              <label className="field"><span>Archive after (days)</span><input name="archive_after_days" type="number" value={policyForm.archive_after_days} onChange={onChangePolicy} /></label>
              <label className="field"><span>Cold storage after (days)</span><input name="cold_storage_after_days" type="number" value={policyForm.cold_storage_after_days} onChange={onChangePolicy} /></label>
              <label className="field"><span>Purge after (days)</span><input name="purge_after_days" type="number" value={policyForm.purge_after_days} onChange={onChangePolicy} /></label>
              <label className="field"><span>Data tier</span>
                <select name="data_tier" value={policyForm.data_tier} onChange={onChangePolicy}>
                  {tiers.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => dataLifecycle.createPolicy(policyForm))}>Create policy</button>
          </div>

          <div className="panel">
            <h3>Policies ({policies.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Scope</th><th>Object type</th><th>Retention</th><th>Basis</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {policies.map((row) => (
                  <tr key={row.policy_ref}>
                    <td>{row.code}</td>
                    <td>{row.scope_type}</td>
                    <td>{row.object_type || "—"}</td>
                    <td className="mono">{row.retention_period_days}d</td>
                    <td>{row.retention_basis}</td>
                    <td><Badge tone={row.status === "active" ? "ok" : "warn"}>{row.status}</Badge></td>
                    <td>
                      {["active", "suspended", "retired"].filter((s) => s !== row.status).map((status) => (
                        <button key={status} className="chip link-btn" disabled={busy} onClick={() => run(() => dataLifecycle.setPolicyStatus(row.policy_ref, status))}>{status}</button>
                      ))}
                    </td>
                  </tr>
                ))}
                {!policies.length ? <tr><td colSpan={7} className="mono">No policies.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "legalholds" ? (
        <>
          <div className="panel">
            <h3>Create a legal hold</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={holdForm.code} onChange={onChangeHold} /></label>
              <label className="field"><span>Name</span><input name="name" value={holdForm.name} onChange={onChangeHold} /></label>
              <label className="field"><span>Scope</span>
                <select name="scope_type" value={holdForm.scope_type} onChange={onChangeHold}>
                  {holdScopeTypes.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="field"><span>Object type</span><input name="object_type" value={holdForm.object_type} onChange={onChangeHold} /></label>
              <label className="field"><span>Object id (for OBJECT scope)</span><input name="object_id" value={holdForm.object_id} onChange={onChangeHold} /></label>
              <label className="field"><span>Reason</span><input name="reason" value={holdForm.reason} onChange={onChangeHold} /></label>
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(() =>
                  dataLifecycle.createLegalHold({
                    ...holdForm,
                    object_ids: holdForm.scope_type === "OBJECT" && holdForm.object_id ? [{ object_type: holdForm.object_type, object_id: holdForm.object_id }] : [],
                  })
                )
              }
            >
              Create hold
            </button>
          </div>

          <div className="panel">
            <h3>Legal holds ({holds.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Scope</th><th>Reason</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {holds.map((row) => (
                  <tr key={row.hold_ref}>
                    <td>{row.code}</td>
                    <td>{row.scope_type}{row.object_type ? ` · ${row.object_type}` : ""}</td>
                    <td>{row.reason || "—"}</td>
                    <td><Badge tone={row.status === "ACTIVE" ? "warn" : "ok"}>{row.status}</Badge></td>
                    <td>
                      {row.status === "ACTIVE" ? (
                        <>
                          <button className="chip link-btn" disabled={busy} onClick={() => run(() => dataLifecycle.releaseLegalHold(row.hold_ref, { reason: "console" }))}>release</button>
                          <button className="chip link-btn" disabled={busy} onClick={() => run(() => dataLifecycle.cancelLegalHold(row.hold_ref, { reason: "console" }))}>cancel</button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!holds.length ? <tr><td colSpan={5} className="mono">No legal holds.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "archives" ? (
        <>
          <div className="panel">
            <h3>Archives ({archives.length})</h3>
            <table className="table">
              <thead><tr><th>Archive</th><th>Object</th><th>Provider</th><th>Size</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {archives.map((row) => (
                  <tr key={row.archive_ref}>
                    <td className="mono">{row.archive_ref}</td>
                    <td>{row.object_type} · {row.object_id}</td>
                    <td>{row.provider_code}</td>
                    <td className="mono">{row.size_bytes}</td>
                    <td><Badge tone={row.status === "stored" ? "ok" : "warn"}>{row.status}</Badge></td>
                    <td><button className="chip link-btn" disabled={busy} onClick={() => run(() => dataLifecycle.verifyArchive(row.archive_ref))}>verify</button></td>
                  </tr>
                ))}
                {!archives.length ? <tr><td colSpan={6} className="mono">No archives.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Purge records ({purges.length})</h3>
            <table className="table">
              <thead><tr><th>Purge</th><th>Object</th><th>Reason</th><th>Status</th></tr></thead>
              <tbody>
                {purges.map((row) => (
                  <tr key={row.purge_ref}>
                    <td className="mono">{row.purge_ref}</td>
                    <td>{row.object_type} · {row.object_id}</td>
                    <td>{row.reason || "—"}</td>
                    <td><Badge tone={row.status === "executed" ? "ok" : "danger"}>{row.status}</Badge></td>
                  </tr>
                ))}
                {!purges.length ? <tr><td colSpan={4} className="mono">No purge records.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "jobs" ? (
        <div className="panel">
          <h3>Lifecycle jobs</h3>
          <div className="stack-row">
            <button className="btn secondary" disabled={busy} onClick={() => run(() => dataLifecycle.submitEvaluation({ actions: ["ARCHIVE", "PURGE"] }))}>Submit evaluation</button>
            <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.submitArchive({}))}>Submit archive batch</button>
            <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.submitPurge({}))}>Submit purge batch</button>
            <button className="btn ghost" disabled={busy} onClick={() => run(() => dataLifecycle.submitMaintenance())}>Submit maintenance</button>
          </div>
          <table className="table">
            <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Objects</th><th>Success</th><th>Failure</th></tr></thead>
            <tbody>
              {jobs.map((row) => (
                <tr key={row.job_ref}>
                  <td className="mono">{row.job_ref}</td>
                  <td>{row.job_type}</td>
                  <td><Badge tone={row.status === "completed" ? "ok" : "warn"}>{row.status}</Badge></td>
                  <td className="mono">{row.object_count}</td>
                  <td className="mono">{row.success_count}</td>
                  <td className="mono">{row.failure_count}</td>
                </tr>
              ))}
              {!jobs.length ? <tr><td colSpan={6} className="mono">No lifecycle jobs recorded yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          {configuration ? (
            <table className="table">
              <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
              <tbody>
                {Object.entries(configuration).map(([key, value]) => (
                  <tr key={key}>
                    <td className="mono">{key}</td>
                    <td className="mono">{typeof value === "object" ? JSON.stringify(value) : String(value)}</td>
                    <td>
                      <button
                        className="chip link-btn"
                        disabled={busy || typeof value === "object"}
                        onClick={() => {
                          const next = window.prompt(`New value for ${key}`, String(value));
                          if (next !== null) run(() => dataLifecycle.setConfiguration(key, next));
                        }}
                      >
                        edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="mono">Loading…</div>
          )}
        </div>
      ) : null}
    </>
  );
}
