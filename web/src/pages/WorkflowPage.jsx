import React, { useCallback, useEffect, useState } from "react";
import { workflow } from "../api.js";
import WorkflowDesigner from "../components/WorkflowDesigner.jsx";
import WorkflowGraphView from "../components/WorkflowGraphView.jsx";

const TABS = [
  { key: "tasks", label: "My Tasks", scope: "user" },
  { key: "team", label: "Team Tasks", scope: "user" },
  { key: "approvals", label: "Approvals", scope: "user" },
  { key: "instances", label: "Instances", scope: "user" },
  { key: "templates", label: "Workflow Templates", scope: "config" },
];

const STATUS_BADGE = {
  running: "active",
  completed: "active",
  pending: "",
  paused: "",
  failed: "locked",
  cancelled: "inactive",
  rejected: "locked",
};

function TaskDetail({ taskId, onChanged }) {
  const [task, setTask] = useState(null);
  const [comment, setComment] = useState("");
  const [subtask, setSubtask] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const res = await workflow.task(taskId);
    setTask(res);
  }, [taskId]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!task) return <p className="mono">Loading task…</p>;

  async function run(fn) {
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          {task.title} <span className="mono">#{task.id}</span>
        </h3>
        <span className={`badge ${STATUS_BADGE[task.status] || ""}`}>{task.status}</span>
      </div>
      <p className="sub">{task.description || "No description."}</p>
      <div className="chips">
        <span className="chip">Priority: {task.priority}</span>
        <span className="chip">Assignee: {task.assignee_ref || task.assignee_type || "unassigned"}</span>
        {task.escalated ? <span className="chip">Escalated</span> : null}
        {task.due_at ? <span className="chip">Due: {task.due_at}</span> : null}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <h3>Workflow progress</h3>
          {task.instance ? (
            <span className="mono">
              {task.instance.title || task.instance.code} · {task.instance.status}
            </span>
          ) : null}
        </div>
        <WorkflowGraphView workflow={task.workflow} taskNodeId={task.node_id} height={320} />
      </div>

      {["assigned", "in_progress", "unassigned", "blocked"].includes(task.status) ? (
        <div className="row" style={{ margin: "14px 0" }}>
          <button className="btn" onClick={() => run(() => workflow.completeTask(task.id, { outcome: "completed" }))}>
            Complete task
          </button>
          {task.status !== "in_progress" ? (
            <button className="btn secondary" onClick={() => run(() => workflow.setTaskStatus(task.id, "in_progress"))}>
              Start work
            </button>
          ) : null}
          {task.status === "unassigned" ? (
            <button className="btn ghost" onClick={() => run(() => workflow.claimTask(task.id))}>Claim</button>
          ) : null}
        </div>
      ) : null}

      <div className="split">
        <div>
          <h3>Subtasks</h3>
          <table>
            <tbody>
              {(task.subtasks || []).map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>
                    <button
                      className="btn ghost"
                      onClick={() => run(() => workflow.updateSubtask(task.id, s.id, { status: s.status === "done" ? "todo" : "done" }))}
                    >
                      {s.status === "done" ? "Reopen" : "Complete"}
                    </button>
                  </td>
                </tr>
              ))}
              {!(task.subtasks || []).length ? (
                <tr>
                  <td colSpan={2} className="mono">No subtasks.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <form
            className="row"
            style={{ marginTop: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              run(() => workflow.addSubtask(task.id, { title: subtask }));
              setSubtask("");
            }}
          >
            <label className="field grow">
              <span>New subtask</span>
              <input value={subtask} onChange={(e) => setSubtask(e.target.value)} required />
            </label>
            <button className="btn secondary">Add</button>
          </form>

          <h3 style={{ marginTop: 16 }}>Attachments</h3>
          <ul className="detail-list">
            {(task.attachments || []).map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer">{a.filename}</a>
              </li>
            ))}
            {!(task.attachments || []).length ? <li className="mono">No attachments.</li> : null}
          </ul>
        </div>

        <div>
          <h3>Comments</h3>
          <ul className="detail-list">
            {(task.comments || []).map((c) => (
              <li key={c.id}>
                <strong>{c.author_name || c.author_id || "user"}:</strong> {c.body}
              </li>
            ))}
            {!(task.comments || []).length ? <li className="mono">No comments.</li> : null}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => workflow.addComment(task.id, { body: comment }));
              setComment("");
            }}
          >
            <label className="field">
              <span>Add comment</span>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} required />
            </label>
            <button className="btn secondary">Comment</button>
          </form>
        </div>
      </div>
    </div>
  );
}

function TasksPane({ scope, onChanged }) {
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const res = await workflow.tasks(`?scope=${scope}&pageSize=100`);
    setTasks(res.items || []);
  }, [scope]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel">
        <div className="panel-head">
          <h3>{scope === "team" ? "Team tasks" : scope === "all" ? "All tasks" : "My tasks"}</h3>
          <div className="inline">
            <button className="btn ghost" onClick={() => load()}>Refresh</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Instance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td><span className={`badge ${STATUS_BADGE[t.status] || ""}`}>{t.status}</span></td>
                <td>{t.priority}</td>
                <td className="mono">{t.assignee_ref || t.assignee_type}</td>
                <td className="mono">{t.instance_id}</td>
                <td>
                  <button className="btn ghost" onClick={() => setSelectedId(t.id)}>Open</button>
                </td>
              </tr>
            ))}
            {!tasks.length ? (
              <tr>
                <td colSpan={6} className="mono">No tasks.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {selectedId ? (
        <TaskDetail
          taskId={selectedId}
          onChanged={() => {
            load();
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}

function ApprovalsPane() {
  const [approvals, setApprovals] = useState([]);
  const [comment, setComment] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const res = await workflow.approvals("?scope=all&pageSize=100");
    setApprovals(res.items || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function decide(id, decision) {
    setError("");
    setNotice("");
    try {
      await workflow.decideApproval(id, { decision, comment: comment[id] || "" });
      setNotice(`Approval ${decision}.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}
      <div className="panel">
        <div className="panel-head">
          <h3>Approvals inbox</h3>
          <button className="btn ghost" onClick={() => load()}>Refresh</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Approval</th>
              <th>Status</th>
              <th>Instance</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td>{a.title || a.subject || a.node_key || `Approval #${a.id}`}</td>
                <td><span className={`badge ${a.status === "approved" ? "active" : a.status === "pending" ? "" : "inactive"}`}>{a.status}</span></td>
                <td className="mono">{a.instance_id}</td>
                <td>
                  {a.status === "pending" ? (
                    <div className="inline">
                      <input
                        placeholder="comment"
                        value={comment[a.id] || ""}
                        onChange={(e) => setComment((p) => ({ ...p, [a.id]: e.target.value }))}
                      />
                      <button className="btn" onClick={() => decide(a.id, "approve")}>Approve</button>
                      <button className="btn danger" onClick={() => decide(a.id, "reject")}>Reject</button>
                      <button className="btn ghost" onClick={() => decide(a.id, "request_changes")}>Changes</button>
                    </div>
                  ) : (
                    <span className="mono">{a.decision || "—"}</span>
                  )}
                </td>
              </tr>
            ))}
            {!approvals.length ? (
              <tr>
                <td colSpan={4} className="mono">No approvals.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TemplatesPane() {
  const [templates, setTemplates] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({ code: "", name: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const res = await workflow.templates("?pageSize=100");
    setTemplates(res.items || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function run(fn, message) {
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      if (message) setNotice(message);
    } catch (err) {
      setError(err.message);
    }
  }

  if (openId) {
    return (
      <WorkflowDesigner
        templateId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => load()}
      />
    );
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}
      <div className="panel">
        <div className="panel-head">
          <h3>Workflow templates</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th>Nodes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.code}</td>
                <td>{t.name}</td>
                <td><span className={`badge ${t.status === "published" ? "active" : ""}`}>{t.status}</span></td>
                <td className="mono">
                  v{t.current_version}
                  {t.published_version ? ` (published v${t.published_version})` : ""}
                </td>
                <td>{t.node_count ?? t.graph_stats?.nodes ?? ""}</td>
                <td>
                  <div className="inline">
                    <button className="btn ghost" onClick={() => setOpenId(t.id)}>Open designer</button>
                    <button className="btn ghost" onClick={() => run(() => workflow.createVersion(t.id, { notes: "draft" }), `Draft version created for ${t.code}.`)}>
                      New version
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!templates.length ? (
              <tr>
                <td colSpan={6} className="mono">No templates.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form
          className="row"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => workflow.createTemplate(form), `Template ${form.code} created.`);
            setForm({ code: "", name: "" });
          }}
        >
          <label className="field grow">
            <span>Code</span>
            <input value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} required />
          </label>
          <label className="field grow">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} required />
          </label>
          <button className="btn">Create template</button>
        </form>
      </div>
    </>
  );
}

function InstanceDetail({ id, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [inst, nodes, hist] = await Promise.all([
      workflow.instance(id),
      workflow.instanceNodes(id),
      workflow.instanceHistory(id, "?pageSize=100"),
    ]);
    setDetail({ ...inst, nodes: nodes.items || inst.nodes || [] });
    setHistory(hist.items || hist || []);
  }, [id]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="mono">Loading instance…</p>;

  async function act(fn) {
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          {detail.title || `Instance #${detail.id}`} <span className="mono">{detail.workflow_code || ""}</span>
        </h3>
        <div className="inline">
          <span className={`badge ${STATUS_BADGE[detail.status] || ""}`}>{detail.status}</span>
          {detail.status === "running" ? (
            <button className="btn ghost" onClick={() => act(() => workflow.pauseInstance(id))}>Pause</button>
          ) : null}
          {detail.status === "paused" ? (
            <button className="btn ghost" onClick={() => act(() => workflow.resumeInstance(id))}>Resume</button>
          ) : null}
          {detail.status === "failed" ? (
            <button className="btn secondary" onClick={() => act(() => workflow.retryInstance(id, { reason: "manual retry" }))}>Retry</button>
          ) : null}
          {["running", "paused", "pending"].includes(detail.status) ? (
            <button className="btn danger" onClick={() => act(() => workflow.cancelInstance(id, { reason: "cancelled from console" }))}>Cancel</button>
          ) : null}
        </div>
      </div>

      <div className="chips">
        {(detail.nodes || []).map((n) => (
          <span key={n.id} className={`chip ${n.status === "completed" ? "wf-chip-done" : n.status === "active" ? "wf-chip-active" : ""}`}>
            {n.node_key || n.node_type}: {n.status}
          </span>
        ))}
      </div>

      <h3 style={{ marginTop: 16 }}>History</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {history.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.created_at}</td>
              <td>{e.event_type}</td>
              <td className="mono">{e.actor_id || "system"}</td>
              <td className="mono">{e.message || JSON.stringify(e.payload || {})}</td>
            </tr>
          ))}
          {!history.length ? (
            <tr>
              <td colSpan={4} className="mono">No events.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function InstancesPane() {
  const [instances, setInstances] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState({ definition_id: "", title: "" });
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [inst, tmpl] = await Promise.all([
      workflow.instances("?pageSize=100"),
      workflow.templates("?status=published&pageSize=100"),
    ]);
    setInstances(inst.items || []);
    setTemplates(tmpl.items || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel">
        <div className="panel-head">
          <h3>Running &amp; completed instances</h3>
          <button className="btn ghost" onClick={() => load()}>Refresh</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Instance</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.id}>
                <td>{i.title || `#${i.id}`}</td>
                <td className="mono">{i.workflow_code}</td>
                <td><span className={`badge ${STATUS_BADGE[i.status] || ""}`}>{i.status}</span></td>
                <td className="mono">{i.started_at || i.created_at}</td>
                <td>
                  <button className="btn ghost" onClick={() => setSelectedId(i.id)}>Open</button>
                </td>
              </tr>
            ))}
            {!instances.length ? (
              <tr>
                <td colSpan={5} className="mono">No instances.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form
          className="row"
          style={{ marginTop: 16 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              const res = await workflow.startInstance({ definition_id: Number(form.definition_id), title: form.title });
              setForm({ definition_id: "", title: "" });
              setSelectedId(res.id);
              await load();
            } catch (err) {
              setError(err.message);
            }
          }}
        >
          <label className="field grow">
            <span>Published workflow</span>
            <select value={form.definition_id} onChange={(e) => setForm((p) => ({ ...p, definition_id: e.target.value }))} required>
              <option value="">—</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.code})</option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Title</span>
            <input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} required />
          </label>
          <button className="btn">Start instance</button>
        </form>
      </div>
      {selectedId ? <InstanceDetail id={selectedId} onChanged={load} /> : null}
    </>
  );
}

export default function WorkflowPage({ mode = "user", initialTab }) {
  const visibleTabs = TABS.filter((t) => t.scope === mode);
  const fallbackTab = visibleTabs[0]?.key || "tasks";
  const [tab, setTab] = useState(
    initialTab && visibleTabs.some((t) => t.key === initialTab) ? initialTab : fallbackTab
  );
  const [taskScope] = useState("mine");

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Workflow &amp; Process Engine</div>
          <h1>{mode === "config" ? "Workflow Engine" : "My tasks & approvals"}</h1>
          <p className="sub">
            {mode === "config"
              ? "Create and design versioned workflow templates. Published versions are immutable."
              : "Your task inbox, approvals, and the workflows you are involved in."}
          </p>
        </div>
      </div>

      <div className="tabs">
        {visibleTabs.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {mode === "config" ? <TemplatesPane /> : null}
      {mode === "user" && tab === "tasks" ? <TasksPane scope={taskScope} /> : null}
      {mode === "user" && tab === "team" ? <TasksPane scope="team" /> : null}
      {mode === "user" && tab === "approvals" ? <ApprovalsPane /> : null}
      {mode === "user" && tab === "instances" ? <InstancesPane /> : null}
    </>
  );
}
