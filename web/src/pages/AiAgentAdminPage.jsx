import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

const EMPTY_AGENT = {
  system_instructions: "",
  tools: ["knowledge.search"],
  steps: [],
  limits: { max_steps: 5, max_tool_calls: 5, max_elapsed_seconds: 120 },
};

const EMPTY_TOOL = {
  capability: "knowledge.read",
  read_only: true,
  risk_class: "read_only",
  requires_approval: false,
  idempotency: "supported",
  input_schema: { type: "object" },
  output_schema: { type: "object" },
};

const TABS = [
  "Agents",
  "Tools",
  "Templates",
  "Executions",
  "Schedules",
  "Memory",
  "Monitoring",
  "Approvals",
];

export default function AiAgentAdminPage() {
  const [tab, setTab] = useState("Agents");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionTools, setVersionTools] = useState([]);
  const [agentForm, setAgentForm] = useState({ code: "", name: "", category: "" });
  const [definition, setDefinition] = useState(JSON.stringify(EMPTY_AGENT, null, 2));
  const [validation, setValidation] = useState(null);

  const [tools, setTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [toolForm, setToolForm] = useState({ code: "", name: "", category: "" });
  const [toolDefinition, setToolDefinition] = useState(
    JSON.stringify(EMPTY_TOOL, null, 2),
  );

  const [executions, setExecutions] = useState([]);
  const [execution, setExecution] = useState(null);

  const [approvals, setApprovals] = useState([]);
  const [approvalFilter, setApprovalFilter] = useState("pending");
  const [decisionReason, setDecisionReason] = useState("");

  const [templates, setTemplates] = useState([]);
  const [templateForms, setTemplateForms] = useState({});

  const [schedules, setSchedules] = useState([]);
  const [scheduleForm, setScheduleForm] = useState({
    name: "",
    schedule_kind: "recurring",
    cron: "0 2 * * *",
    timezone: "UTC",
    input_text: "",
  });

  const [memory, setMemory] = useState([]);
  const [memoryForm, setMemoryForm] = useState({ memory_key: "", content: "" });

  const [overview, setOverview] = useState(null);
  const [delegations, setDelegations] = useState([]);

  async function guard(action) {
    setError("");
    setNotice("");
    try {
      return await action();
    } catch (err) {
      setError(describe(err));
      return null;
    }
  }

  async function loadAgents() {
    const rows = await guard(() => ai.agents({ limit: 100 }));
    if (rows) setAgents(rows);
  }

  async function loadTools() {
    const rows = await guard(() => ai.agentTools({ limit: 100 }));
    if (rows) setTools(rows);
  }

  async function loadExecutions() {
    const page = await guard(() => ai.agentExecutions({ limit: 50 }));
    if (page) setExecutions(page.items || []);
  }

  async function loadApprovals() {
    const page = await guard(() =>
      ai.agentApprovals({ status: approvalFilter || undefined, limit: 50 }),
    );
    if (page) setApprovals(page.items || []);
  }

  async function loadTemplates() {
    const rows = await guard(() => ai.agentTemplates({ limit: 100 }));
    if (rows) setTemplates(rows);
  }

  async function loadSchedules() {
    const page = await guard(() => ai.agentSchedules({ limit: 50 }));
    if (page) setSchedules(page.items || []);
  }

  async function loadMemory(agentId) {
    if (!agentId) {
      setMemory([]);
      return;
    }
    const page = await guard(() => ai.agentMemory({ agent_id: agentId, limit: 50 }));
    if (page) setMemory(page.items || []);
  }

  async function loadMonitoring() {
    const data = await guard(() => ai.agentMonitoringOverview());
    if (data) setOverview(data);
  }

  useEffect(() => {
    loadAgents();
    loadTools();
    loadExecutions();
    loadApprovals();
    loadTemplates();
    loadSchedules();
    loadMonitoring();
  }, []);

  async function selectAgent(agent) {
    setSelected(agent);
    setValidation(null);
    setNotice("");
    const detail = await guard(() => ai.agent(agent.id));
    if (detail) {
      setSelected(detail);
      setDefinition(JSON.stringify(detail.current_version?.definition || EMPTY_AGENT, null, 2));
    }
    const list = await guard(() => ai.agentVersions(agent.id));
    if (list) setVersions(list);
    await loadMemory(agent.id);
    if (detail?.current_version_id) {
      const linked = await guard(() =>
        ai.agentVersionTools(agent.id, detail.current_version_id),
      );
      if (linked) setVersionTools(linked);
    } else {
      setVersionTools([]);
    }
  }

  async function createAgent(e) {
    e.preventDefault();
    const body = {
      code: agentForm.code,
      name: agentForm.name,
      category: agentForm.category || null,
      definition: parseJson(definition, "Definition"),
    };
    const created = await guard(() => ai.createAgent(body));
    if (created) {
      setNotice(`Draft agent ${created.code} created`);
      setAgentForm({ code: "", name: "", category: "" });
      await loadAgents();
      await selectAgent(created);
    }
  }

  async function saveAgent() {
    if (!selected) return;
    const detail = await guard(() =>
      ai.updateAgent(selected.id, {
        definition: parseJson(definition, "Definition"),
        lock_version: selected.lock_version,
      }),
    );
    if (detail) {
      setNotice("Draft updated");
      setSelected(detail);
      setVersions(await ai.agentVersions(selected.id));
    }
  }

  async function validateAgent() {
    if (!selected) return;
    const result = await guard(() => ai.validateAgent(selected.id));
    if (result) {
      setValidation(result);
      setNotice(result.valid ? "Definition is valid" : "Definition has errors");
    }
  }

  async function publishAgent() {
    if (!selected) return;
    const published = await guard(() => ai.publishAgent(selected.id));
    if (published) {
      setNotice(`Published version ${published.current_version?.version ?? ""}`);
      setSelected(published);
      await loadAgents();
      setVersions(await ai.agentVersions(selected.id));
    }
  }

  async function disableAgent() {
    if (!selected) return;
    const reason = window.prompt("Disable reason (optional)") || null;
    const disabled = await guard(() => ai.disableAgent(selected.id, { reason }));
    if (disabled) {
      setSelected(disabled);
      setNotice("Agent disabled; new executions are blocked");
      await loadAgents();
    }
  }

  async function rollback(versionId) {
    if (!selected) return;
    const rolled = await guard(() =>
      ai.rollbackAgent(selected.id, { version_id: versionId }),
    );
    if (rolled) {
      setSelected(rolled);
      setNotice(`Activated version ${versionId}`);
      await loadAgents();
    }
  }

  async function activateAgent() {
    if (!selected) return;
    const updated = await guard(() => ai.activateAgent(selected.id));
    if (updated) {
      setSelected(updated);
      setNotice("Agent activated");
      await loadAgents();
    }
  }

  async function deactivateAgent() {
    if (!selected) return;
    const updated = await guard(() => ai.deactivateAgent(selected.id));
    if (updated) {
      setSelected(updated);
      setNotice("Agent deactivated");
      await loadAgents();
    }
  }

  async function suspendAgent() {
    if (!selected) return;
    const reason = window.prompt("Suspend reason (optional)") || null;
    const updated = await guard(() => ai.suspendAgent(selected.id, { reason }));
    if (updated) {
      setSelected(updated);
      setNotice("Agent suspended; executions blocked");
      await loadAgents();
    }
  }

  async function duplicateAgent() {
    if (!selected) return;
    const code = window.prompt("New agent code");
    if (!code) return;
    const copy = await guard(() => ai.duplicateAgent(selected.id, { code }));
    if (copy) {
      setNotice(`Duplicated as ${copy.code}`);
      await loadAgents();
      await selectAgent(copy);
    }
  }

  async function deleteAgent() {
    if (!selected) return;
    const confirmed = window.confirm("Delete this agent (soft delete)?");
    if (!confirmed) return;
    const deleted = await guard(() =>
      ai.deleteAgent(selected.id, { confirm: true }),
    );
    if (deleted) {
      setSelected(null);
      setNotice("Agent deleted");
      await loadAgents();
    }
  }

  async function instantiateTemplate(template) {
    const form = templateForms[template.id] || {};
    const code = form.code || window.prompt("New agent code");
    if (!code) return;
    const created = await guard(() =>
      ai.instantiateAgentTemplate(template.id, {
        code,
        name: form.name || template.name,
        activate: Boolean(form.activate),
      }),
    );
    if (created) {
      setNotice(`Agent ${created.code} created from template`);
      setTemplateForms({ ...templateForms, [template.id]: {} });
      await loadAgents();
      await selectAgent(created);
    }
  }

  async function createSchedule(e) {
    e.preventDefault();
    if (!selected) return;
    const body = {
      agent_id: selected.id,
      name: scheduleForm.name,
      schedule_kind: scheduleForm.schedule_kind,
      timezone: scheduleForm.timezone,
      input_text: scheduleForm.input_text || null,
    };
    if (scheduleForm.schedule_kind === "recurring") {
      body.cron = scheduleForm.cron;
    } else {
      body.run_at = scheduleForm.run_at;
    }
    const created = await guard(() => ai.createAgentSchedule(body));
    if (created) {
      setNotice(`Schedule ${created.name} created`);
      setScheduleForm({ ...scheduleForm, name: "", input_text: "" });
      await loadSchedules();
    }
  }

  async function toggleSchedule(schedule) {
    const updated = await guard(() =>
      ai.updateAgentSchedule(schedule.id, { enabled: !schedule.enabled }),
    );
    if (updated) await loadSchedules();
  }

  async function removeSchedule(schedule) {
    const deleted = await guard(() => ai.deleteAgentSchedule(schedule.id));
    if (deleted) await loadSchedules();
  }

  async function writeMemory(e) {
    e.preventDefault();
    if (!selected) return;
    const created = await guard(() =>
      ai.writeAgentMemory({
        agent_id: selected.id,
        scope: "agent",
        memory_key: memoryForm.memory_key,
        content: memoryForm.content,
      }),
    );
    if (created) {
      setMemoryForm({ memory_key: "", content: "" });
      setNotice("Memory saved");
      await loadMemory(selected.id);
    }
  }

  async function removeMemory(entry) {
    const deleted = await guard(() => ai.deleteAgentMemory(entry.id));
    if (deleted) await loadMemory(selected?.id);
  }

  async function loadDelegations() {
    if (!execution) return;
    const data = await guard(() => ai.agentExecutionDelegations(execution.id));
    if (data) setDelegations(data.delegations || []);
  }

  async function selectTool(tool) {
    setSelectedTool(tool);
    setNotice("");
    const detail = await guard(() => ai.agentTool(tool.id));
    if (detail) {
      setSelectedTool(detail);
      setToolDefinition(
        JSON.stringify(detail.current_version?.definition || EMPTY_TOOL, null, 2),
      );
    }
  }

  async function createTool(e) {
    e.preventDefault();
    const body = {
      code: toolForm.code,
      name: toolForm.name,
      category: toolForm.category || null,
      definition: parseJson(toolDefinition, "Tool definition"),
    };
    const created = await guard(() => ai.createAgentTool(body));
    if (created) {
      setNotice(`Tool ${created.code} registered`);
      setToolForm({ code: "", name: "", category: "" });
      await loadTools();
      await selectTool(created);
    }
  }

  async function createToolVersion() {
    if (!selectedTool) return;
    const version = await guard(() =>
      ai.createAgentToolVersion(selectedTool.id, {
        definition: parseJson(toolDefinition, "Tool definition"),
      }),
    );
    if (version) setNotice(`Draft tool version ${version.version} created`);
  }

  async function validateTool() {
    if (!selectedTool) return;
    const result = await guard(() => ai.validateAgentTool(selectedTool.id));
    if (result) {
      setNotice(result.valid ? "Tool version is valid" : "Tool validation failed");
      setValidation(result);
    }
  }

  async function publishTool() {
    if (!selectedTool) return;
    const published = await guard(() => ai.publishAgentTool(selectedTool.id));
    if (published) {
      setNotice(`Published tool version ${published.current_version?.version ?? ""}`);
      setSelectedTool(published);
      await loadTools();
    }
  }

  async function openExecution(row) {
    const detail = await guard(() => ai.agentExecution(row.id));
    if (detail) setExecution(detail);
  }

  async function cancelExecution() {
    if (!execution) return;
    const updated = await guard(() => ai.cancelAgentExecution(execution.id));
    if (updated) {
      setExecution(updated);
      await loadExecutions();
    }
  }

  async function retryExecution() {
    if (!execution) return;
    const updated = await guard(() => ai.retryAgentExecution(execution.id));
    if (updated) {
      setExecution(updated);
      setNotice("Execution requeued");
      await loadExecutions();
    }
  }

  async function decide(approval, action) {
    const body = { reason: decisionReason || null };
    const updated = await guard(() =>
      action === "approve"
        ? ai.approveAgentApproval(approval.id, body)
        : ai.rejectAgentApproval(approval.id, body),
    );
    if (updated) {
      setDecisionReason("");
      setNotice(`Approval ${updated.status}`);
      await loadApprovals();
      await loadExecutions();
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Agent platform</h1>
          <p className="sub">
            Versioned agent and tool registry, durable execution monitor, and
            human approval inbox. Published definitions are immutable.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        {TABS.map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "" : "ghost"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Agents" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Catalog</h3></div>
            <table>
              <thead>
                <tr><th>Code</th><th>Lifecycle</th><th>Version</th><th>Owner</th></tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className={selected?.id === agent.id ? "valid" : ""}>
                    <td>
                      <button className="link-btn" onClick={() => selectAgent(agent)}>
                        {agent.code}
                      </button>
                    </td>
                    <td><span className="badge">{agent.lifecycle_status || "published"}</span></td>
                    <td>{agent.current_version_id || "-"}</td>
                    <td className="muted">{agent.owner || "-"}</td>
                  </tr>
                ))}
                {agents.length === 0 ? (
                  <tr><td colSpan={4} className="muted">No agents yet.</td></tr>
                ) : null}
              </tbody>
            </table>
            <div className="panel-head"><h3>Create draft</h3></div>
            <form onSubmit={createAgent}>
              <label className="field">
                <span>Code</span>
                <input
                  value={agentForm.code}
                  onChange={(e) => setAgentForm({ ...agentForm, code: e.target.value })}
                  placeholder="knowledge-reporter"
                  required
                />
              </label>
              <label className="field">
                <span>Name</span>
                <input
                  value={agentForm.name}
                  onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>Category</span>
                <input
                  value={agentForm.category}
                  onChange={(e) => setAgentForm({ ...agentForm, category: e.target.value })}
                />
              </label>
              <button className="btn">Create draft</button>
            </form>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>{selected ? selected.name : "Agent detail"}</h3>
              {selected ? (
                <span className="badge">{selected.lifecycle_status}</span>
              ) : null}
            </div>
            {!selected ? (
              <p className="muted">Select an agent to edit its draft definition.</p>
            ) : (
              <>
                <label className="field">
                  <span>Draft definition (JSON)</span>
                  <textarea
                    rows={16}
                    value={definition}
                    onChange={(e) => setDefinition(e.target.value)}
                  />
                </label>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" onClick={saveAgent}>Save draft</button>
                  <button className="btn ghost" onClick={validateAgent}>Validate</button>
                  <button className="btn ghost" onClick={publishAgent}>Publish</button>
                  <button className="btn ghost" onClick={disableAgent}>Disable</button>
                  <button className="btn ghost" onClick={activateAgent}>Activate</button>
                  <button className="btn ghost" onClick={deactivateAgent}>Deactivate</button>
                  <button className="btn ghost" onClick={suspendAgent}>Suspend</button>
                  <button className="btn ghost" onClick={duplicateAgent}>Duplicate</button>
                  <button className="btn ghost" onClick={deleteAgent}>Delete</button>
                </div>
                {validation ? (
                  <div className={validation.valid ? "notice" : "error"} style={{ marginTop: 12 }}>
                    <div>{validation.valid ? "Valid" : "Invalid"}</div>
                    {validation.errors?.length ? (
                      <ul>{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                    ) : null}
                    {validation.warnings?.length ? (
                      <ul>{validation.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                    ) : null}
                  </div>
                ) : null}
                <div className="panel-head"><h3>Versions</h3></div>
                <table>
                  <thead>
                    <tr><th>Version</th><th>Status</th><th>Created</th><th></th></tr>
                  </thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.id}>
                        <td>v{version.version}</td>
                        <td><span className="badge">{version.status}</span></td>
                        <td className="muted">{formatTime(version.created_at)}</td>
                        <td>
                          {version.status === "published" ? (
                            <button className="link-btn" onClick={() => rollback(version.id)}>
                              activate
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {versionTools.length ? (
                  <p className="muted">
                    Current tools: {versionTools.map((tool) => `${tool.code}@v${tool.version}`).join(", ")}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Templates" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Template gallery</h3>
            <button className="btn ghost" onClick={loadTemplates}>Refresh</button>
          </div>
          <p className="muted">
            Templates instantiate a normal draft agent through the registry; they
            never execute on their own and reuse the same tool allowlist and approvals.
          </p>
          <table>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Category</th><th>Use case</th><th>Instantiate</th></tr>
            </thead>
            <tbody>
              {templates.map((template) => {
                const form = templateForms[template.id] || {};
                return (
                  <tr key={template.id}>
                    <td>{template.code}</td>
                    <td>{template.name}</td>
                    <td><span className="badge">{template.category || "-"}</span></td>
                    <td className="muted">{template.use_case || "-"}</td>
                    <td>
                      <div className="row" style={{ gap: 6, alignItems: "center" }}>
                        <input
                          placeholder="agent-code"
                          value={form.code || ""}
                          onChange={(e) =>
                            setTemplateForms({
                              ...templateForms,
                              [template.id]: { ...form, code: e.target.value },
                            })
                          }
                        />
                        <label className="row" style={{ gap: 4, alignItems: "center" }}>
                          <input
                            type="checkbox"
                            checked={Boolean(form.activate)}
                            onChange={(e) =>
                              setTemplateForms({
                                ...templateForms,
                                [template.id]: { ...form, activate: e.target.checked },
                              })
                            }
                          />
                          <span className="muted">activate</span>
                        </label>
                        <button className="link-btn" onClick={() => instantiateTemplate(template)}>
                          create
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {templates.length === 0 ? (
                <tr><td colSpan={5} className="muted">No templates available.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "Tools" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Tool registry</h3></div>
            <table>
              <thead>
                <tr><th>Code</th><th>Lifecycle</th><th>Version</th><th>Enabled</th></tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.id} className={selectedTool?.id === tool.id ? "valid" : ""}>
                    <td>
                      <button className="link-btn" onClick={() => selectTool(tool)}>
                        {tool.code}
                      </button>
                    </td>
                    <td><span className="badge">{tool.lifecycle_status}</span></td>
                    <td>{tool.current_version_id || "-"}</td>
                    <td>{tool.enabled ? "yes" : "no"}</td>
                  </tr>
                ))}
                {tools.length === 0 ? (
                  <tr><td colSpan={4} className="muted">No tools registered.</td></tr>
                ) : null}
              </tbody>
            </table>
            <div className="panel-head"><h3>Register tool</h3></div>
            <form onSubmit={createTool}>
              <label className="field">
                <span>Code</span>
                <input
                  value={toolForm.code}
                  onChange={(e) => setToolForm({ ...toolForm, code: e.target.value })}
                  placeholder="record.create"
                  required
                />
              </label>
              <label className="field">
                <span>Name</span>
                <input
                  value={toolForm.name}
                  onChange={(e) => setToolForm({ ...toolForm, name: e.target.value })}
                  required
                />
              </label>
              <button className="btn">Register tool</button>
            </form>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>{selectedTool ? selectedTool.name : "Tool detail"}</h3>
            </div>
            {!selectedTool ? (
              <p className="muted">Select a tool to inspect or publish its draft.</p>
            ) : (
              <>
                <label className="field">
                  <span>Definition (JSON)</span>
                  <textarea
                    rows={14}
                    value={toolDefinition}
                    onChange={(e) => setToolDefinition(e.target.value)}
                  />
                </label>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" onClick={createToolVersion}>New version</button>
                  <button className="btn ghost" onClick={validateTool}>Validate</button>
                  <button className="btn ghost" onClick={publishTool}>Publish</button>
                </div>
                <p className="muted">
                  Risk classes: read_only, low_risk_preparation, controlled_mutation.
                  Consequential tools are disabled and prohibited tools cannot be published.
                </p>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Executions" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Executions</h3>
              <button className="btn ghost" onClick={loadExecutions}>Refresh</button>
            </div>
            <table>
              <thead>
                <tr><th>ID</th><th>Agent</th><th>Status</th><th>Step</th><th>When</th></tr>
              </thead>
              <tbody>
                {executions.map((row) => (
                  <tr key={row.id} className={execution?.id === row.id ? "valid" : ""}>
                    <td>
                      <button className="link-btn" onClick={() => openExecution(row)}>
                        {row.id}
                      </button>
                    </td>
                    <td>{row.agent_id}</td>
                    <td><span className="badge">{row.status}</span></td>
                    <td>{row.current_step || "-"}</td>
                    <td className="muted">{formatTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>{execution ? `Execution ${execution.id}` : "Execution detail"}</h3>
            </div>
            {!execution ? (
              <p className="muted">Select an execution to inspect its durable trace.</p>
            ) : (
              <>
                <p>
                  <span className="badge">{execution.status}</span>{" "}
                  agent {execution.agent_id} · version {execution.agent_version_id}
                </p>
                <table>
                  <thead><tr><th>Step</th><th>Tool</th><th>Status</th><th>Attempts</th></tr></thead>
                  <tbody>
                    {(execution.steps || []).map((step) => (
                      <tr key={step.id}>
                        <td>{step.step_key}</td>
                        <td>{step.tool_code}</td>
                        <td><span className="badge">{step.status}</span></td>
                        <td>{step.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn ghost" onClick={loadDelegations}>Delegations</button>
                  <button className="btn ghost" onClick={cancelExecution}>Cancel</button>
                  <button className="btn ghost" onClick={retryExecution}>Retry failed</button>
                  <button className="btn ghost" onClick={() => openExecution(execution)}>Refresh</button>
                </div>
                {execution.output ? (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                    {JSON.stringify(execution.output, null, 2)}
                  </pre>
                ) : null}
                {execution.error ? (
                  <div className="error">{execution.error.message}</div>
                ) : null}
                {delegations.length ? (
                  <>
                    <div className="panel-head"><h3>Delegations</h3></div>
                    <table>
                      <thead>
                        <tr><th>Child agent</th><th>Step</th><th>Depth</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {delegations.map((row) => (
                          <tr key={row.id}>
                            <td>{row.child_agent_id}</td>
                            <td>{row.step_key}</td>
                            <td>{row.depth}</td>
                            <td><span className="badge">{row.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Schedules" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Schedules</h3>
              <button className="btn ghost" onClick={loadSchedules}>Refresh</button>
            </div>
            <table>
              <thead>
                <tr><th>Name</th><th>Agent</th><th>Kind</th><th>Next run</th><th>Enabled</th><th></th></tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.name}</td>
                    <td>{schedule.agent_id}</td>
                    <td>
                      <span className="badge">
                        {schedule.schedule_kind === "recurring" ? schedule.cron : "once"}
                      </span>
                    </td>
                    <td className="muted">{formatTime(schedule.next_run_at) || "-"}</td>
                    <td>{schedule.enabled ? "yes" : "no"}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="link-btn" onClick={() => toggleSchedule(schedule)}>
                          {schedule.enabled ? "disable" : "enable"}
                        </button>
                        <button className="link-btn" onClick={() => removeSchedule(schedule)}>
                          delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {schedules.length === 0 ? (
                  <tr><td colSpan={6} className="muted">No schedules yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>New schedule</h3></div>
            {!selected ? (
              <p className="muted">Select an active agent first.</p>
            ) : (
              <form onSubmit={createSchedule}>
                <p className="muted">Target agent: {selected.code}</p>
                <label className="field">
                  <span>Name</span>
                  <input
                    value={scheduleForm.name}
                    onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })}
                    required
                  />
                </label>
                <label className="field">
                  <span>Kind</span>
                  <select
                    value={scheduleForm.schedule_kind}
                    onChange={(e) =>
                      setScheduleForm({ ...scheduleForm, schedule_kind: e.target.value })
                    }
                  >
                    <option value="recurring">Recurring</option>
                    <option value="once">One time</option>
                  </select>
                </label>
                {scheduleForm.schedule_kind === "recurring" ? (
                  <label className="field">
                    <span>Cron (5 fields)</span>
                    <input
                      value={scheduleForm.cron}
                      onChange={(e) => setScheduleForm({ ...scheduleForm, cron: e.target.value })}
                      required
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span>Run at (ISO)</span>
                    <input
                      value={scheduleForm.run_at || ""}
                      onChange={(e) => setScheduleForm({ ...scheduleForm, run_at: e.target.value })}
                      placeholder="2026-12-01T09:00:00Z"
                      required
                    />
                  </label>
                )}
                <label className="field">
                  <span>Input text</span>
                  <textarea
                    rows={3}
                    value={scheduleForm.input_text}
                    onChange={(e) =>
                      setScheduleForm({ ...scheduleForm, input_text: e.target.value })
                    }
                  />
                </label>
                <button className="btn">Create schedule</button>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Memory" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Agent memory</h3>
              <button className="btn ghost" onClick={() => loadMemory(selected?.id)}>
                Refresh
              </button>
            </div>
            {!selected ? (
              <p className="muted">Select an agent to inspect its persistent memory.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Key</th><th>Scope</th><th>Owner</th><th>Content</th><th></th></tr>
                </thead>
                <tbody>
                  {memory.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.memory_key}</td>
                      <td><span className="badge">{entry.scope}</span></td>
                      <td className="muted">{entry.owner_username || "-"}</td>
                      <td className="muted">{entry.content}</td>
                      <td>
                        <button className="link-btn" onClick={() => removeMemory(entry)}>
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {memory.length === 0 ? (
                    <tr><td colSpan={5} className="muted">No memory entries.</td></tr>
                  ) : null}
                </tbody>
              </table>
            )}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Write memory</h3></div>
            {!selected ? (
              <p className="muted">Select an agent first.</p>
            ) : (
              <form onSubmit={writeMemory}>
                <label className="field">
                  <span>Key</span>
                  <input
                    value={memoryForm.memory_key}
                    onChange={(e) =>
                      setMemoryForm({ ...memoryForm, memory_key: e.target.value })
                    }
                    required
                  />
                </label>
                <label className="field">
                  <span>Content</span>
                  <textarea
                    rows={4}
                    value={memoryForm.content}
                    onChange={(e) => setMemoryForm({ ...memoryForm, content: e.target.value })}
                    required
                  />
                </label>
                <button className="btn">Save memory</button>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Monitoring" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Monitoring overview</h3>
            <button className="btn ghost" onClick={loadMonitoring}>Refresh</button>
          </div>
          {overview ? (
            <>
              <p className="muted">
                Agents: {overview.agents_total} · generated {formatTime(overview.generated_at)}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Total</th><th>Succeeded</th><th>Failed</th><th>Active</th>
                    <th>Waiting approval</th><th>Avg latency (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{overview.executions.total}</td>
                    <td>{overview.executions.succeeded}</td>
                    <td>{overview.executions.failed}</td>
                    <td>{overview.executions.active}</td>
                    <td>{overview.executions.waiting_approval}</td>
                    <td>{overview.executions.avg_latency_ms ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
              <div className="panel-head"><h3>Recent executions</h3></div>
              <table>
                <thead>
                  <tr><th>ID</th><th>Agent</th><th>Status</th><th>Depth</th><th>When</th></tr>
                </thead>
                <tbody>
                  {(overview.recent || []).map((row) => (
                    <tr key={row.id}>
                      <td>{row.id}</td>
                      <td>{row.agent_id}</td>
                      <td><span className="badge">{row.status}</span></td>
                      <td>{row.delegation_depth || 0}</td>
                      <td className="muted">{formatTime(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted">Loading monitoring data...</p>
          )}
        </div>
      ) : null}

      {tab === "Approvals" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Approval inbox</h3>
            <div className="row" style={{ gap: 8 }}>
              <select
                value={approvalFilter}
                onChange={(e) => setApprovalFilter(e.target.value)}
              >
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="">All</option>
              </select>
              <button className="btn ghost" onClick={loadApprovals}>Refresh</button>
            </div>
          </div>
          <p className="muted">
            Approvals bind the exact agent version, step, tool version, and arguments.
            Approving releases the paused execution; it does not execute anything directly.
          </p>
          <label className="field">
            <span>Decision reason</span>
            <input
              value={decisionReason}
              onChange={(e) => setDecisionReason(e.target.value)}
              placeholder="Required for rejection"
            />
          </label>
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Execution</th><th>Step</th><th>Tool</th>
                <th>Risk</th><th>Requested by</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td>{approval.id}</td>
                  <td>{approval.execution_id}</td>
                  <td>{approval.step_key}</td>
                  <td>{approval.tool_code}</td>
                  <td><span className="badge">{approval.risk_class}</span></td>
                  <td className="muted">{approval.requested_by_name || "-"}</td>
                  <td>{approval.status}</td>
                  <td>
                    {approval.status === "pending" ? (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="link-btn" onClick={() => decide(approval, "approve")}>
                          approve
                        </button>
                        <button className="link-btn" onClick={() => decide(approval, "reject")}>
                          reject
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
              {approvals.length === 0 ? (
                <tr><td colSpan={8} className="muted">No approvals in this view.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
