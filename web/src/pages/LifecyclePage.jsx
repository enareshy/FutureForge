import React, { useCallback, useEffect, useState } from "react";
import { iam, lifecycle, objects } from "../api.js";

const CATEGORIES = ["draft", "in_review", "approved", "released", "obsolete", "cancelled"];
const RULE_KINDS = ["approval", "release"];

export default function LifecyclePage() {
  const [statuses, setStatuses] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [rules, setRules] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [objectTypes, setObjectTypes] = useState([]);
  const [roles, setRoles] = useState([]);

  const [selected, setSelected] = useState(null);
  const [versions, setVersions] = useState([]);
  const [states, setStates] = useState([]);
  const [transitions, setTransitions] = useState([]);
  const [graph, setGraph] = useState(null);

  const [defForm, setDefForm] = useState({ code: "", name: "", description: "", module: "" });
  const [statusForm, setStatusForm] = useState({ code: "", name: "", description: "", category: "draft" });
  const [stateForm, setStateForm] = useState({ code: "", name: "", status_code: "", is_initial: false, is_terminal: false });
  const [transitionForm, setTransitionForm] = useState({ code: "", name: "", from_state: "", to_state: "", requires_approval: false, required_permission: "" });
  const [ruleForm, setRuleForm] = useState({ code: "", name: "", kind: "approval", transition: "", approver_role: "" });
  const [assignForm, setAssignForm] = useState({ type: "", lifecycle: "" });

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [statusRes, defRes, ruleRes, assignRes, typeRes, roleRes] = await Promise.all([
      lifecycle.statuses("?pageSize=200"),
      lifecycle.definitions("?pageSize=200"),
      lifecycle.approvalRules("?pageSize=200"),
      lifecycle.assignments(),
      objects.types(),
      iam.roles("?pageSize=200"),
    ]);
    setStatuses(statusRes.items || []);
    setDefinitions(defRes.items || []);
    setRules(ruleRes.items || []);
    setAssignments(assignRes.items || []);
    setObjectTypes(typeRes.items || []);
    setRoles(roleRes.items || []);
  }, []);

  const loadDefinition = useCallback(
    async (definition) => {
      setSelected(definition);
      setGraph(null);
      setError("");
      const versionRes = await lifecycle.versions(definition.id);
      const items = versionRes.items || [];
      setVersions(items);
      const current = items.find((v) => v.version === definition.current_version) || items[0];
      if (current) {
        const [stateRes, transitionRes, report] = await Promise.all([
          lifecycle.states(`?versionId=${current.id}`),
          lifecycle.transitions(`?versionId=${current.id}`),
          lifecycle.validate(definition.id, `?version=${current.version}`),
        ]);
        setStates(stateRes.items || []);
        setTransitions(transitionRes.items || []);
        setGraph({ ...report, version: current });
      } else {
        setStates([]);
        setTransitions([]);
      }
    },
    []
  );

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function run(fn, message) {
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      if (selected) {
        const refreshed = await lifecycle.get(selected.id);
        await loadDefinition(refreshed);
      }
      if (message) setNotice(message);
    } catch (err) {
      setError(err.message);
    }
  }

  function setForm(setter, key, value) {
    setter((prev) => ({ ...prev, [key]: value }));
  }

  const editableVersion = versions.find((v) => v.status === "draft") || null;

  async function createDefinition(e) {
    e.preventDefault();
    await run(async () => {
      const res = await lifecycle.createDefinition(defForm);
      setDefForm({ code: "", name: "", description: "", module: "" });
      await loadDefinition(res.definition);
    }, `Lifecycle ${defForm.code} created.`);
  }

  async function createStatus(e) {
    e.preventDefault();
    await run(() => lifecycle.createStatus(statusForm), `Status ${statusForm.code} created.`);
    setStatusForm({ code: "", name: "", description: "", category: "draft" });
  }

  async function createVersion() {
    await run(() => lifecycle.createVersion(selected.id, {}), "New draft version created.");
  }

  async function addState(e) {
    e.preventDefault();
    await run(
      () =>
        lifecycle.createState({
          ...stateForm,
          lifecycle_version_id: editableVersion.id,
          status_code: stateForm.status_code || undefined,
          category: statuses.find((s) => s.code === stateForm.status_code)?.category,
        }),
      `State ${stateForm.code} added.`
    );
    setStateForm({ code: "", name: "", status_code: "", is_initial: false, is_terminal: false });
  }

  async function addTransition(e) {
    e.preventDefault();
    await run(
      () => lifecycle.createTransition({ ...transitionForm, lifecycle_version_id: editableVersion.id }),
      `Transition ${transitionForm.code} added.`
    );
    setTransitionForm({ code: "", name: "", from_state: "", to_state: "", requires_approval: false, required_permission: "" });
  }

  async function publish() {
    await run(() => lifecycle.publish(selected.id, {}), "Lifecycle version published.");
  }

  async function createRule(e) {
    e.preventDefault();
    if (!selected) return;
    const payload = {
      code: ruleForm.code,
      name: ruleForm.name,
      kind: ruleForm.kind,
      transition: ruleForm.transition || undefined,
      min_approvals: 1,
      require_all: true,
      steps: ruleForm.approver_role
        ? [{ code: "signoff", name: "Sign-off", approver_type: "role", approver_id: ruleForm.approver_role, approval_mode: "all" }]
        : [],
    };
    await run(() => lifecycle.createApprovalRule(payload), `Rule ${ruleForm.code} created.`);
    setRuleForm({ code: "", name: "", kind: "approval", transition: "", approver_role: "" });
  }

  async function assignLifecycle(e) {
    e.preventDefault();
    await run(() => lifecycle.createAssignment(assignForm), "Lifecycle assigned to object type.");
    setAssignForm({ type: "", lifecycle: "" });
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Lifecycle Management</div>
          <h1>Lifecycles</h1>
          <p className="sub">
            Configurable statuses and immutable, versioned state machines. Objects pin the version they were released
            under, so publishing a new version never moves existing objects.
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Lifecycle definitions</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Module</th>
              <th>Status</th>
              <th>Version</th>
              <th>States</th>
              <th>Transitions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {definitions.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.code}</td>
                <td>{d.name}</td>
                <td>{d.module}</td>
                <td>
                  <span className={`badge ${d.status === "published" ? "active" : ""}`}>{d.status}</span>
                </td>
                <td className="mono">
                  v{d.current_version}
                  {d.published_version ? ` (published v${d.published_version})` : ""}
                </td>
                <td>{d.state_count}</td>
                <td>{d.transition_count}</td>
                <td>
                  <button className="btn ghost" onClick={() => run(() => loadDefinition(d))}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
            {!definitions.length ? (
              <tr>
                <td colSpan={8} className="mono">
                  No lifecycle definitions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form className="row" style={{ marginTop: 16 }} onSubmit={createDefinition}>
          <label className="field grow">
            <span>Code</span>
            <input value={defForm.code} onChange={(e) => setForm(setDefForm, "code", e.target.value)} required />
          </label>
          <label className="field grow">
            <span>Name</span>
            <input value={defForm.name} onChange={(e) => setForm(setDefForm, "name", e.target.value)} required />
          </label>
          <label className="field grow">
            <span>Module</span>
            <input value={defForm.module} onChange={(e) => setForm(setDefForm, "module", e.target.value)} />
          </label>
          <button className="btn">Create lifecycle</button>
        </form>
      </div>

      {selected ? (
        <div className="panel">
          <div className="panel-head">
            <h3>{selected.name} · version graph</h3>
            <div className="inline">
              {graph ? (
                <span className={`badge ${graph.valid ? "active" : "locked"}`}>
                  v{graph.version?.version} {graph.valid ? "valid" : "invalid"}
                </span>
              ) : null}
              <button className="btn ghost" onClick={createVersion}>
                New draft version
              </button>
              <button className="btn secondary" onClick={publish} disabled={!editableVersion}>
                Publish v{editableVersion?.version ?? selected.current_version}
              </button>
            </div>
          </div>

          {graph?.errors?.length ? (
            <pre className="json">{JSON.stringify(graph.errors, null, 2)}</pre>
          ) : (
            <p className="sub mono">
              {states.length} states · {transitions.length} transitions
              {editableVersion ? ` · editing draft v${editableVersion.version}` : " · published (create a new version to edit)"}
            </p>
          )}

          <div className="split">
            <div className="panel">
              <h3>States</h3>
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Initial</th>
                    <th>Terminal</th>
                  </tr>
                </thead>
                <tbody>
                  {states.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.code}</td>
                      <td>{s.name}</td>
                      <td>{s.category}</td>
                      <td>{s.is_initial ? "yes" : ""}</td>
                      <td>{s.is_terminal ? "yes" : ""}</td>
                    </tr>
                  ))}
                  {!states.length ? (
                    <tr>
                      <td colSpan={5} className="mono">
                        No states yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {editableVersion ? (
                <form className="row" style={{ marginTop: 12 }} onSubmit={addState}>
                  <label className="field">
                    <span>Code</span>
                    <input value={stateForm.code} onChange={(e) => setForm(setStateForm, "code", e.target.value)} required />
                  </label>
                  <label className="field grow">
                    <span>Name</span>
                    <input value={stateForm.name} onChange={(e) => setForm(setStateForm, "name", e.target.value)} required />
                  </label>
                  <label className="field grow">
                    <span>Status</span>
                    <select value={stateForm.status_code} onChange={(e) => setForm(setStateForm, "status_code", e.target.value)}>
                      <option value="">—</option>
                      {statuses.map((s) => (
                        <option key={s.id} value={s.code}>
                          {s.label || s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Initial</span>
                    <input
                      type="checkbox"
                      checked={stateForm.is_initial}
                      onChange={(e) => setForm(setStateForm, "is_initial", e.target.checked)}
                    />
                  </label>
                  <label className="field">
                    <span>Terminal</span>
                    <input
                      type="checkbox"
                      checked={stateForm.is_terminal}
                      onChange={(e) => setForm(setStateForm, "is_terminal", e.target.checked)}
                    />
                  </label>
                  <button className="btn">Add state</button>
                </form>
              ) : null}
            </div>

            <div className="panel">
              <h3>Transitions</h3>
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {transitions.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.code}</td>
                      <td>{t.from_state_code}</td>
                      <td>{t.to_state_code}</td>
                      <td>{t.requires_approval ? "required" : ""}</td>
                    </tr>
                  ))}
                  {!transitions.length ? (
                    <tr>
                      <td colSpan={4} className="mono">
                        No transitions yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {editableVersion ? (
                <form className="row" style={{ marginTop: 12 }} onSubmit={addTransition}>
                  <label className="field">
                    <span>Code</span>
                    <input value={transitionForm.code} onChange={(e) => setForm(setTransitionForm, "code", e.target.value)} required />
                  </label>
                  <label className="field grow">
                    <span>Name</span>
                    <input value={transitionForm.name} onChange={(e) => setForm(setTransitionForm, "name", e.target.value)} required />
                  </label>
                  <label className="field">
                    <span>From</span>
                    <select value={transitionForm.from_state} onChange={(e) => setForm(setTransitionForm, "from_state", e.target.value)} required>
                      <option value="">—</option>
                      {states.map((s) => (
                        <option key={s.id} value={s.code}>
                          {s.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>To</span>
                    <select value={transitionForm.to_state} onChange={(e) => setForm(setTransitionForm, "to_state", e.target.value)} required>
                      <option value="">—</option>
                      {states.map((s) => (
                        <option key={s.id} value={s.code}>
                          {s.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Approval</span>
                    <input
                      type="checkbox"
                      checked={transitionForm.requires_approval}
                      onChange={(e) => setForm(setTransitionForm, "requires_approval", e.target.checked)}
                    />
                  </label>
                  <button className="btn">Add transition</button>
                </form>
              ) : null}
            </div>
          </div>

          <div className="split">
            <div className="panel">
              <h3>Approval rule</h3>
              <form onSubmit={createRule}>
                <div className="row">
                  <label className="field grow">
                    <span>Code</span>
                    <input value={ruleForm.code} onChange={(e) => setForm(setRuleForm, "code", e.target.value)} required />
                  </label>
                  <label className="field grow">
                    <span>Name</span>
                    <input value={ruleForm.name} onChange={(e) => setForm(setRuleForm, "name", e.target.value)} required />
                  </label>
                </div>
                <div className="row">
                  <label className="field">
                    <span>Kind</span>
                    <select value={ruleForm.kind} onChange={(e) => setForm(setRuleForm, "kind", e.target.value)}>
                      {RULE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field grow">
                    <span>Transition</span>
                    <select value={ruleForm.transition} onChange={(e) => setForm(setRuleForm, "transition", e.target.value)}>
                      <option value="">—</option>
                      {transitions.map((t) => (
                        <option key={t.id} value={t.code}>
                          {t.code} ({t.from_state_code} → {t.to_state_code})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field grow">
                    <span>Approver role</span>
                    <select
                      value={ruleForm.approver_role}
                      onChange={(e) => setForm(setRuleForm, "approver_role", e.target.value)}
                      required
                    >
                      <option value="">—</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.code}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className="btn">Create rule</button>
              </form>
            </div>

            <div className="panel">
              <h3>Assign to object type</h3>
              <form className="row" onSubmit={assignLifecycle}>
                <label className="field grow">
                  <span>Object type</span>
                  <select value={assignForm.type} onChange={(e) => setForm(setAssignForm, "type", e.target.value)} required>
                    <option value="">—</option>
                    {objectTypes.map((t) => (
                      <option key={t.id} value={t.code || t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span>Lifecycle</span>
                  <select value={assignForm.lifecycle} onChange={(e) => setForm(setAssignForm, "lifecycle", e.target.value)} required>
                    <option value="">—</option>
                    {definitions.map((d) => (
                      <option key={d.id} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn">Assign</button>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <h3>Statuses</h3>
          </div>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Legacy</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.label || s.name}</td>
                  <td>{s.category}</td>
                  <td>{s.legacy_status}</td>
                  <td>{s.tenant_id ? "tenant" : "global"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form style={{ marginTop: 12 }} onSubmit={createStatus}>
            <div className="row">
              <label className="field">
                <span>Code</span>
                <input value={statusForm.code} onChange={(e) => setForm(setStatusForm, "code", e.target.value)} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={statusForm.name} onChange={(e) => setForm(setStatusForm, "name", e.target.value)} required />
              </label>
              <label className="field">
                <span>Category</span>
                <select value={statusForm.category} onChange={(e) => setForm(setStatusForm, "category", e.target.value)}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn">Create status</button>
          </form>
        </div>

        <div className="panel">
          <h3>Approval &amp; release rules</h3>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Kind</th>
                <th>Steps</th>
                <th>Min approvals</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.code}</td>
                  <td>{r.kind}</td>
                  <td>{r.step_count ?? (r.steps?.length || 0)}</td>
                  <td>{r.min_approvals}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
              {!rules.length ? (
                <tr>
                  <td colSpan={5} className="mono">
                    No approval rules.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <h3 style={{ marginTop: 16 }}>Type assignments</h3>
          <table>
            <thead>
              <tr>
                <th>Object type</th>
                <th>Lifecycle</th>
                <th>Version</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.type_code}</td>
                  <td className="mono">{a.lifecycle_code}</td>
                  <td>v{a.version}</td>
                  <td>{a.is_default ? "yes" : "no"}</td>
                </tr>
              ))}
              {!assignments.length ? (
                <tr>
                  <td colSpan={4} className="mono">
                    No lifecycle assignments.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
