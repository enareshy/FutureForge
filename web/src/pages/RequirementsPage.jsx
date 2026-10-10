import React, { useEffect, useState } from "react";
import { requirements } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "requirements", label: "Requirements" },
  { key: "traceability", label: "Traceability" },
  { key: "baselines", label: "Baselines" },
  { key: "reviews", label: "Reviews & rules" },
  { key: "configuration", label: "Configuration" },
];

const emptyRequirement = {
  title: "",
  description: "",
  requirement_type: "functional_requirement",
  category: "",
  priority: "NORMAL",
  criticality: "MEDIUM",
  domain: "",
  discipline: "",
  source: "",
  classification: "",
  owner_user_id: "",
};

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["RELEASED", "IMPLEMENTED", "VERIFIED", "VALIDATED", "APPROVED"].includes(status)) return "ok";
  if (["DRAFT", "IN_REVIEW", "APPROVED", "WORKING"].includes(status)) return "warn";
  if (["REJECTED", "OBSOLETE", "WITHDRAWN", "FAILED"].includes(status)) return "danger";
  return undefined;
}

function listOf(meta, key, fallback) {
  return meta?.vocabulary?.[key] || fallback;
}

export default function RequirementsPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [types, setTypes] = useState([]);
  const [items, setItems] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [rules, setRules] = useState([]);

  const [requirementForm, setRequirementForm] = useState(emptyRequirement);
  const [selectedRef, setSelectedRef] = useState("");
  const [detail, setDetail] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [history, setHistory] = useState([]);
  const [validation, setValidation] = useState(null);

  const [relationshipForm, setRelationshipForm] = useState({ relationship_type: "RELATED_TO", target_id: "" });
  const [hierarchy, setHierarchy] = useState(null);

  const [baselineForm, setBaselineForm] = useState({ name: "", description: "" });
  const [baselineDiffs, setBaselineDiffs] = useState(null);

  const [ruleForm, setRuleForm] = useState({ code: "", name: "", rule_type: "REQUIRED", target_attribute: "title", severity: "ERROR", message: "" });
  const [validationRun, setValidationRun] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, h, cfg, ty, reqs, bl, rl] = await Promise.all([
        requirements.meta(),
        requirements.health(),
        requirements.configuration(),
        requirements.types("?page_size=200"),
        requirements.list("?page_size=200"),
        requirements.baselines("?page_size=200"),
        requirements.validationRules("?page_size=200"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setTypes(ty.items || []);
      setItems(reqs.items || []);
      setBaselines(bl.items || []);
      setRules(rl.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function bind(setter, form) {
    return (event) => setter({ ...form, [event.target.name]: event.target.value });
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

  const selected = items.find((entry) => entry.requirement_ref === selectedRef) || null;

  async function openDetail(entry) {
    setSelectedRef(entry.requirement_ref);
    await run(async () => {
      const [revs, hist, val] = await Promise.all([
        requirements.revisions(entry.requirement_ref),
        requirements.history(entry.requirement_ref),
        requirements.validateRequirement(entry.requirement_ref),
      ]);
      setRevisions(revs.items || []);
      setHistory(hist.items || []);
      setValidation(val);
    });
  }

  async function seedDemo() {
    await run(() => requirements.seed(), "Demonstration requirement chain seeded.");
    await refresh();
  }

  function toPayload(form) {
    const payload = { ...form };
    if (!payload.owner_user_id) delete payload.owner_user_id;
    else payload.owner_user_id = Number(payload.owner_user_id);
    return payload;
  }

  async function createRequirement() {
    const result = await run(() => requirements.create(toPayload(requirementForm)), "Requirement created.");
    if (result) {
      setRequirementForm(emptyRequirement);
      await refresh();
    }
  }

  async function transition(entry, status) {
    await run(() => requirements.transition(entry.requirement_ref, status), `${entry.requirement_number} → ${status}.`);
    await refresh();
    if (selectedRef === entry.requirement_ref) await openDetail(entry);
  }

  async function revise() {
    if (!selected) return;
    const result = await run(() => requirements.revise(selected.requirement_ref, { change_reason: "Revision from UI" }), "New revision created.");
    if (result) {
      await refresh();
      await openDetail(selected);
    }
  }

  async function setVerification(status) {
    if (!selected) return;
    await run(() => requirements.setVerification(selected.requirement_ref, status), `Verification set to ${status}.`);
    await openDetail(selected);
  }

  async function createRelationship() {
    if (!selected || !relationshipForm.target_id) return;
    await run(
      () =>
        requirements.createRelationship({
          relationship_type: relationshipForm.relationship_type,
          source_type: "requirement",
          source_id: selected.id,
          target_type: "requirement",
          target_id: relationshipForm.target_id,
          status: "ACTIVE",
        }),
      "Relationship created."
    );
    setRelationshipForm({ relationship_type: "RELATED_TO", target_id: "" });
    await openDetail(selected);
  }

  async function traverse() {
    if (!selected) return;
    const result = await run(() => requirements.hierarchy(selected.requirement_ref, 5));
    setHierarchy(result);
  }

  async function createBaseline() {
    const result = await run(
      () =>
        requirements.createBaseline({
          name: baselineForm.name,
          description: baselineForm.description,
          include_all_released: true,
        }),
      "Baseline created."
    );
    if (result) {
      setBaselineForm({ name: "", description: "" });
      await refresh();
    }
  }

  async function releaseBaseline(entry) {
    await run(() => requirements.releaseBaseline(entry.baseline_ref), `${entry.baseline_number} released.`);
    await refresh();
  }

  async function compareBaseline(entry) {
    const result = await run(() => requirements.compareBaseline(entry.baseline_ref));
    setBaselineDiffs(result);
  }

  async function createRule() {
    const result = await run(
      () => requirements.createValidationRule({ ...ruleForm, target_attribute: ruleForm.target_attribute || null }),
      "Validation rule created."
    );
    if (result) {
      setRuleForm({ code: "", name: "", rule_type: "REQUIRED", target_attribute: "title", severity: "ERROR", message: "" });
      await refresh();
    }
  }

  async function deleteRule(entry) {
    await run(() => requirements.deleteValidationRule(entry.code), `${entry.code} deleted.`);
    await refresh();
  }

  async function runValidation() {
    const result = await run(() => requirements.runValidation({ limit: 500 }));
    setValidationRun(result);
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => requirements.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Requirements manager</h1>
          <p className="subtle">
            The foundation of the digital thread: revision-controlled, hierarchical requirements with traceability,
            baselines and configurable validation. Numbering, workflow, search, audit and security are reused from the
            platform.
          </p>
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
            <div className="panel grow"><h3>Requirements</h3><div className="mono">{health?.counts?.requirements ?? "-"}</div></div>
            <div className="panel grow"><h3>Revisions</h3><div className="mono">{health?.counts?.revisions ?? "-"}</div></div>
            <div className="panel grow"><h3>Baselines</h3><div className="mono">{health?.counts?.baselines ?? "-"}</div></div>
            <div className="panel grow"><h3>Relationships</h3><div className="mono">{health?.counts?.relationships ?? "-"}</div></div>
            <div className="panel grow"><h3>Validation rules</h3><div className="mono">{health?.counts?.validation_rules ?? "-"}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Demonstration data</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed requirement chain</button>
            </div>
            <p className="subtle">
              Installs a business → system requirement hierarchy with traceability relationships, a controlled revision
              and a released baseline.
            </p>
          </div>

          <div className="panel">
            <h3>Recent requirements</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Rev</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.slice(0, 8).map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.requirement_number}</td>
                    <td>{entry.title}</td>
                    <td className="mono">{entry.requirement_type}</td>
                    <td className="mono">{entry.revision}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td><button className="btn ghost" onClick={() => { setTab("requirements"); openDetail(entry); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "requirements" ? (
        <>
          <div className="panel">
            <h3>Create a requirement</h3>
            <div className="grid">
              <label className="field grow"><span>Title</span><input name="title" value={requirementForm.title} onChange={bind(setRequirementForm, requirementForm)} /></label>
              <label className="field"><span>Type</span>
                <select name="requirement_type" value={requirementForm.requirement_type} onChange={bind(setRequirementForm, requirementForm)}>
                  {types.length === 0 ? <option value={requirementForm.requirement_type}>{requirementForm.requirement_type}</option> : null}
                  {types.map((entry) => <option key={entry.code} value={entry.code}>{entry.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Priority</span>
                <select name="priority" value={requirementForm.priority} onChange={bind(setRequirementForm, requirementForm)}>
                  {listOf(meta, "requirement_priorities", ["LOW", "NORMAL", "HIGH", "URGENT"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Criticality</span>
                <select name="criticality" value={requirementForm.criticality} onChange={bind(setRequirementForm, requirementForm)}>
                  {listOf(meta, "requirement_criticalities", ["LOW", "MEDIUM", "HIGH", "CRITICAL"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Source</span>
                <select name="source" value={requirementForm.source} onChange={bind(setRequirementForm, requirementForm)}>
                  <option value="">-</option>
                  {listOf(meta, "requirement_sources", []).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Domain</span>
                <select name="domain" value={requirementForm.domain} onChange={bind(setRequirementForm, requirementForm)}>
                  <option value="">-</option>
                  {listOf(meta, "requirement_domains", []).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Discipline</span>
                <select name="discipline" value={requirementForm.discipline} onChange={bind(setRequirementForm, requirementForm)}>
                  <option value="">-</option>
                  {listOf(meta, "requirement_disciplines", []).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Classification</span>
                <select name="classification" value={requirementForm.classification} onChange={bind(setRequirementForm, requirementForm)}>
                  <option value="">-</option>
                  {listOf(meta, "requirement_classifications", []).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Description</span><input name="description" value={requirementForm.description} onChange={bind(setRequirementForm, requirementForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !requirementForm.title} onClick={createRequirement}>Create</button>
          </div>

          <div className="panel">
            <h3>Requirements ({items.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Priority</th><th>Rev</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} className={entry.requirement_ref === selectedRef ? "selected" : ""}>
                    <td className="mono">{entry.requirement_number}</td>
                    <td>{entry.title}</td>
                    <td className="mono">{entry.requirement_type}</td>
                    <td className="mono">{entry.priority}</td>
                    <td className="mono">{entry.revision}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" onClick={() => openDetail(entry)}>Open</button>
                      {(listOf(meta, "status_transitions", {})?.[entry.status] || []).map((next) => (
                        <button key={next} className="btn ghost" disabled={busy} onClick={() => transition(entry, next)}>{next}</button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <div className="panel">
              <div className="stack-row" style={{ justifyContent: "space-between" }}>
                <h3>{selected.requirement_number} — {selected.title}</h3>
                <div className="stack-row">
                  <Badge tone={toneFor(selected.status)}>{selected.status}</Badge>
                  <Badge>{`rev ${selected.revision}`}</Badge>
                  <button className="btn secondary" disabled={busy} onClick={revise}>New revision</button>
                </div>
              </div>
              <p className="subtle">{selected.description}</p>
              <div className="stack-row">
                {listOf(meta, "verification_statuses", ["NOT_VERIFIED", "IN_PROGRESS", "VERIFIED", "FAILED", "WAIVED"]).map((v) => (
                  <button key={v} className="btn ghost" disabled={busy} onClick={() => setVerification(v)}>Verify: {v}</button>
                ))}
              </div>

              {validation ? (
                <>
                  <h4>Validation {validation.valid ? <Badge tone="ok">valid</Badge> : <Badge tone="danger">{validation.error_count} errors</Badge>}</h4>
                  {validation.violations?.length ? (
                    <ul>
                      {validation.violations.map((v, idx) => (
                        <li key={idx} className="mono">{v.severity}: {v.message} ({v.rule_code})</li>
                      ))}
                    </ul>
                  ) : <p className="subtle">No rule violations.</p>}
                </>
              ) : null}

              <h4>Revisions ({revisions.length})</h4>
              <table className="table">
                <thead><tr><th>Revision</th><th>Status</th><th>Change reason</th><th>When</th></tr></thead>
                <tbody>
                  {revisions.map((rev) => (
                    <tr key={rev.id}>
                      <td className="mono">{rev.revision}</td>
                      <td className="mono">{rev.revision_status}</td>
                      <td>{rev.change_reason}</td>
                      <td className="subtle">{rev.created_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>History ({history.length})</h4>
              <table className="table">
                <thead><tr><th>Action</th><th>Status</th><th>Version</th><th>When</th></tr></thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id}>
                      <td className="mono">{entry.action}</td>
                      <td className="mono">{entry.status}</td>
                      <td className="mono">{entry.version}</td>
                      <td className="subtle">{entry.created_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "traceability" ? (
        <>
          <div className="panel">
            <h3>Add a relationship</h3>
            {!selected ? <p className="subtle">Open a requirement from the Requirements tab to add relationships.</p> : null}
            <div className="grid">
              <label className="field"><span>Source</span><input value={selected ? `${selected.requirement_number} — ${selected.title}` : ""} readOnly /></label>
              <label className="field"><span>Type</span>
                <select name="relationship_type" value={relationshipForm.relationship_type} onChange={bind(setRelationshipForm, relationshipForm)}>
                  {listOf(meta, "relationship_types", ["RELATED_TO"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Target</span>
                <select name="target_id" value={relationshipForm.target_id} onChange={bind(setRelationshipForm, relationshipForm)}>
                  <option value="">Select a requirement…</option>
                  {items.filter((entry) => !selected || entry.id !== selected.id).map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.requirement_number} — {entry.title}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn" disabled={busy || !selected || !relationshipForm.target_id} onClick={createRelationship}>Add relationship</button>
              <button className="btn secondary" disabled={busy || !selected} onClick={traverse}>Traverse hierarchy</button>
            </div>
          </div>

          {hierarchy ? (
            <div className="panel">
              <h3>Traversal from {selected?.requirement_number}</h3>
              <p className="subtle">Nodes: {hierarchy.nodes?.join(", ")}</p>
              <table className="table">
                <thead><tr><th>Depth</th><th>Type</th><th>From</th><th>To</th></tr></thead>
                <tbody>
                  {(hierarchy.edges || []).map((edge, idx) => (
                    <tr key={idx}>
                      <td className="mono">{edge.depth}</td>
                      <td className="mono">{edge.relationship_type}</td>
                      <td className="mono">{edge.source_id}</td>
                      <td className="mono">{edge.target_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "baselines" ? (
        <>
          <div className="panel">
            <h3>Create a baseline</h3>
            <p className="subtle">Baselines snapshot all currently released requirements at their exact revisions.</p>
            <div className="grid">
              <label className="field grow"><span>Name</span><input name="name" value={baselineForm.name} onChange={bind(setBaselineForm, baselineForm)} /></label>
              <label className="field grow"><span>Description</span><input name="description" value={baselineForm.description} onChange={bind(setBaselineForm, baselineForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !baselineForm.name} onClick={createBaseline}>Create from released</button>
          </div>

          <div className="panel">
            <h3>Baselines ({baselines.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Name</th><th>Status</th><th>Members</th><th></th></tr></thead>
              <tbody>
                {baselines.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.baseline_number}</td>
                    <td>{entry.name}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.member_count ?? "-"}</td>
                    <td className="stack-row">
                      {entry.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => releaseBaseline(entry)}>Release</button> : null}
                      <button className="btn ghost" disabled={busy} onClick={() => compareBaseline(entry)}>Compare</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {baselineDiffs ? (
            <div className="panel">
              <h3>{baselineDiffs.baseline?.baseline_number} — drift {baselineDiffs.in_sync ? <Badge tone="ok">in sync</Badge> : <Badge tone="warn">{baselineDiffs.differences.length} changes</Badge>}</h3>
              {baselineDiffs.differences?.length ? (
                <table className="table">
                  <thead><tr><th>Requirement</th><th>Change</th><th>Baseline rev</th><th>Current rev</th></tr></thead>
                  <tbody>
                    {baselineDiffs.differences.map((diff, idx) => (
                      <tr key={idx}>
                        <td className="mono">{diff.requirement_ref}</td>
                        <td className="mono">{diff.change}</td>
                        <td className="mono">{diff.baseline_revision}</td>
                        <td className="mono">{diff.current_revision ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="subtle">The baseline matches current requirement revisions.</p>}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "reviews" ? (
        <>
          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Validation rules ({rules.length})</h3>
              <button className="btn secondary" disabled={busy} onClick={runValidation}>Run validation sweep</button>
            </div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Target</th><th>Severity</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rules.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.rule_type}</td>
                    <td className="mono">{entry.target_attribute || "-"}</td>
                    <td className="mono">{entry.severity}</td>
                    <td className="mono">{entry.status}</td>
                    <td><button className="btn ghost" disabled={busy} onClick={() => deleteRule(entry)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Create a rule</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={ruleForm.code} onChange={bind(setRuleForm, ruleForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={ruleForm.name} onChange={bind(setRuleForm, ruleForm)} /></label>
              <label className="field"><span>Type</span>
                <select name="rule_type" value={ruleForm.rule_type} onChange={bind(setRuleForm, ruleForm)}>
                  {listOf(meta, "validation_rule_types", ["REQUIRED"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Target attribute</span><input name="target_attribute" value={ruleForm.target_attribute} onChange={bind(setRuleForm, ruleForm)} placeholder="title" /></label>
              <label className="field"><span>Severity</span>
                <select name="severity" value={ruleForm.severity} onChange={bind(setRuleForm, ruleForm)}>
                  {listOf(meta, "validation_severities", ["ERROR", "WARNING", "INFO"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Message</span><input name="message" value={ruleForm.message} onChange={bind(setRuleForm, ruleForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !ruleForm.code || !ruleForm.name} onClick={createRule}>Create rule</button>
          </div>

          {validationRun ? (
            <div className="panel">
              <h3>Validation sweep</h3>
              <p className="subtle">Evaluated {validationRun.evaluated} requirements against {validationRun.rule_count} rules — {validationRun.total_violations} violations.</p>
              <table className="table">
                <thead><tr><th>Requirement</th><th>Violations</th></tr></thead>
                <tbody>
                  {(validationRun.results || []).map((row) => (
                    <tr key={row.requirement_id}>
                      <td className="mono">{row.requirement_number}</td>
                      <td className="mono">{row.violations.map((v) => v.rule_code).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
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
    </div>
  );
}
