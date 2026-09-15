import React, { useCallback, useEffect, useState } from "react";
import { lifecycle } from "../api.js";

const CATEGORIES = ["draft", "in_review", "approved", "released", "obsolete", "cancelled"];

export default function LifecyclePage() {
  const [statuses, setStatuses] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [rules, setRules] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [graph, setGraph] = useState(null);
  const [form, setForm] = useState({ code: "", name: "", description: "", category: "draft" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [statusRes, defRes, ruleRes, assignRes] = await Promise.all([
      lifecycle.statuses("?pageSize=200"),
      lifecycle.definitions("?pageSize=200"),
      lifecycle.approvalRules("?pageSize=200"),
      lifecycle.assignments(),
    ]);
    setStatuses(statusRes.items || []);
    setDefinitions(defRes.items || []);
    setRules(ruleRes.items || []);
    setAssignments(assignRes.items || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function selectDefinition(definition) {
    setSelected(definition);
    setGraph(null);
    try {
      const report = await lifecycle.validate(definition.id);
      setGraph(report);
    } catch (err) {
      setError(err.message);
    }
  }

  async function publish(definition) {
    setError("");
    try {
      const res = await lifecycle.publish(definition.id, {});
      setNotice(`Published ${definition.code} v${res.version?.version}.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createStatus(e) {
    e.preventDefault();
    setError("");
    try {
      const payload = {
        code: form.code,
        name: form.name,
        description: form.description,
        category: form.category,
      };
      await lifecycle.createStatus(payload);
      setNotice(`Status ${form.code} created.`);
      setForm({ code: "", name: "", description: "", category: "draft" });
      await load();
    } catch (err) {
      setError(err.message);
    }
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
                <td>
                  <button className="btn ghost" onClick={() => selectDefinition(d)}>
                    Inspect
                  </button>
                  {d.published_version !== d.current_version ? (
                    <button className="btn secondary" onClick={() => publish(d)}>
                      Publish v{d.current_version}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!definitions.length ? (
              <tr>
                <td colSpan={6} className="mono">
                  No lifecycle definitions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selected && graph ? (
        <div className="panel">
          <div className="panel-head">
            <h3>
              {selected.code} · version validity
            </h3>
            <span className={`badge ${graph.valid ? "active" : "locked"}`}>{graph.valid ? "valid" : "invalid"}</span>
          </div>
          <ul className="detail-list">
            <li>States: {graph.state_count}</li>
            <li>Transitions: {graph.transition_count}</li>
          </ul>
          {graph.errors?.length ? <pre className="json">{JSON.stringify(graph.errors, null, 2)}</pre> : null}
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
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Create status</h3>
          </div>
          <form onSubmit={createStatus}>
            <label className="field">
              <span>Code</span>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span>Category</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Description</span>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <button className="btn">Create status</button>
          </form>
        </div>
      </div>

      <div className="split">
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
        </div>

        <div className="panel">
          <h3>Type assignments</h3>
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
