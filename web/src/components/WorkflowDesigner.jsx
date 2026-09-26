import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workflow } from "../api.js";

const NODE_TYPES = [
  { type: "start", label: "Start", color: "#3ee0c0" },
  { type: "end", label: "End", color: "#ff6b7a" },
  { type: "task", label: "Task", color: "#5b8cff" },
  { type: "approval", label: "Approval", color: "#b07bff" },
  { type: "decision", label: "Decision", color: "#f5c15a" },
  { type: "parallel", label: "Parallel", color: "#4fd1ff" },
  { type: "join", label: "Join", color: "#4fd1ff" },
  { type: "notification", label: "Notify", color: "#ff9f5a" },
  { type: "timer", label: "Timer", color: "#8fa4c8" },
  { type: "subprocess", label: "Subprocess", color: "#64d68a" },
  { type: "service", label: "Service", color: "#64d68a" },
  { type: "terminate", label: "Terminate", color: "#ff6b7a" },
];
const NODE_COLORS = Object.fromEntries(NODE_TYPES.map((n) => [n.type, n.color]));
const NODE_W = 190;
const NODE_H = 68;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2;

const CONDITION_OPERATORS = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "not equals" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less or equal" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "in", label: "in list" },
  { value: "not_in", label: "not in list" },
];
const LIST_OPERATORS = ["in", "not_in"];

function parseConditionValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function displayConditionValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function conditionToText(condition) {
  const value = condition && typeof condition === "object" ? condition : null;
  if (!value || !Object.keys(value).length) return "always";
  if (Array.isArray(value.all)) return value.all.map(conditionToText).join(" AND ");
  if (Array.isArray(value.any)) return value.any.map(conditionToText).join(" OR ");
  if (value.not !== undefined) return `NOT (${conditionToText(value.not)})`;
  if (value.field !== undefined) {
    const operator = CONDITION_OPERATORS.find((op) => op.value === (value.operator || "eq"));
    return `${value.field} ${operator?.label || value.operator || "eq"} ${displayConditionValue(value.value)}`.trim();
  }
  return "custom rule";
}

function approvalOutcomeLabel(fromNode, edge) {
  const config = fromNode?.config || {};
  if (config.approve_transition_key && String(config.approve_transition_key) === String(edge.transition_key)) return "approve";
  if (config.reject_transition_key && String(config.reject_transition_key) === String(edge.transition_key)) return "reject";
  return "";
}

function edgeLabel(edge, fromNode) {
  const outcome = approvalOutcomeLabel(fromNode, edge);
  const condition = edge.condition && Object.keys(edge.condition).length ? conditionToText(edge.condition) : "";
  const parts = [];
  if (outcome) parts.push(outcome);
  if (edge.name) parts.push(edge.name);
  else if (condition && !outcome) parts.push(condition);
  if (edge.is_default) parts.push("default");
  return parts.join(" · ");
}

// Inline editor for a single {field, operator, value} rule. Kept intentionally
// small so it can be reused in the inspector and per-branch in the canvas.
function ConditionEditor({ condition, onChange, disabled }) {
  const current = condition && typeof condition === "object" && !Array.isArray(condition) ? condition : {};
  const operator = current.operator || "eq";
  const isList = LIST_OPERATORS.includes(operator);
  const setField = (field) => onChange({ ...current, field, operator });
  const setOperator = (next) => onChange({ ...current, field: current.field || "", operator: next });
  const setValue = (raw) => {
    const value = isList
      ? String(raw)
          .split(",")
          .map((part) => parseConditionValue(part))
          .filter((part) => part !== "" && part !== null)
      : parseConditionValue(raw);
    onChange({ ...current, field: current.field || "", operator, value });
  };
  return (
    <div className="wf-condition">
      <input
        placeholder="field (e.g. priority)"
        value={current.field || ""}
        onChange={(e) => setField(e.target.value)}
        disabled={disabled}
      />
      <select value={operator} onChange={(e) => setOperator(e.target.value)} disabled={disabled}>
        {CONDITION_OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      <input
        placeholder={isList ? "value, value" : "value"}
        value={displayConditionValue(current.value)}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

function slugify(prefix, value, fallback) {
  const base = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}-${base || fallback || "node"}`.slice(0, 60);
}

function layout(nodes, transitions) {
  const outgoing = new Map();
  const incoming = new Map();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of transitions) {
    outgoing.get(e.from_node_id)?.push(e.to_node_id);
    incoming.get(e.to_node_id)?.push(e.from_node_id);
  }
  const depth = new Map();
  const starts = nodes.filter((n) => n.type === "start");
  const queue = (starts.length ? starts : nodes.slice(0, 1)).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      const candidate = (depth.get(id) ?? 0) + 1;
      if (!depth.has(next) || candidate > depth.get(next)) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }
  const columns = new Map();
  nodes.forEach((node, index) => {
    const d = depth.has(node.id) ? depth.get(node.id) : 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push({ node, index });
  });
  const positions = new Map();
  for (const [d, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.index - b.index);
    list.forEach(({ node }, i) => positions.set(node.id, { x: 80 + d * 260, y: 80 + i * 130 }));
  }
  return positions;
}

let tmpCounter = 0;
const tmpId = () => `tmp-${Date.now()}-${tmpCounter++}`;

export default function WorkflowDesigner({ templateId, onClose, onChanged }) {
  const [ctx, setCtx] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [transitions, setTransitions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [pointer, setPointer] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [clipboard, setClipboard] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(null);

  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const stateRef = useRef({ nodes: [], transitions: [] });
  stateRef.current = { nodes, transitions };

  const load = useCallback(async () => {
    setError("");
    const res = await workflow.designer(templateId);
    setCtx(res);
    setNodes((res.graph?.nodes || []).map((n) => ({ ...n })));
    setTransitions((res.graph?.transitions || []).map((e) => ({ ...e })));
    setValidation(res.validation || null);
    setPast([]);
    setFuture([]);
    setSelected(null);
    const bounds = (res.graph?.nodes || []).reduce(
      (acc, n) => ({ x: Math.max(acc.x, n.position_x || 0), y: Math.max(acc.y, n.position_y || 0) }),
      { x: 0, y: 0 }
    );
    setView({ x: 40, y: 20, scale: bounds.x > 1400 ? 0.7 : 1 });
  }, [templateId]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  const editable = Boolean(ctx?.editable);

  const snapshot = useCallback(() => {
    setPast((prev) => [...prev.slice(-49), { nodes: stateRef.current.nodes, transitions: stateRef.current.transitions }]);
    setFuture([]);
  }, []);

  const commit = useCallback((nextNodes, nextTransitions) => {
    setNodes(nextNodes);
    setTransitions(nextTransitions);
  }, []);

  const undo = useCallback(() => {
    setPast((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setFuture((f) => [...f, { nodes: stateRef.current.nodes, transitions: stateRef.current.transitions }]);
      commit(last.nodes, last.transitions);
      setSelected(null);
      return prev.slice(0, -1);
    });
  }, [commit]);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setPast((p) => [...p, { nodes: stateRef.current.nodes, transitions: stateRef.current.transitions }]);
      commit(last.nodes, last.transitions);
      setSelected(null);
      return prev.slice(0, -1);
    });
  }, [commit]);

  function screenToWorld(clientX, clientY) {
    const rect = viewportRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  }

  function addNode(type, worldX, worldY) {
    if (!editable) return;
    const existing = stateRef.current.nodes.filter((n) => n.type === type).length;
    const name = `${NODE_TYPES.find((n) => n.type === type)?.label || type} ${existing + 1}`;
    const node = {
      id: tmpId(),
      node_key: slugify(type, name, "node"),
      type,
      name,
      description: "",
      config: type === "task" || type === "approval" ? { assignee_type: "role", assignee_ref: "" } : {},
      position_x: Math.round(worldX ?? 120),
      position_y: Math.round(worldY ?? 120),
      display_order: stateRef.current.nodes.length,
    };
    snapshot();
    commit([...stateRef.current.nodes, node], stateRef.current.transitions);
    setSelected({ kind: "node", id: node.id });
  }

  function removeSelected() {
    if (!editable || !selected) return;
    snapshot();
    if (selected.kind === "node") {
      commit(
        stateRef.current.nodes.filter((n) => String(n.id) !== String(selected.id)),
        stateRef.current.transitions.filter(
          (e) => String(e.from_node_id) !== String(selected.id) && String(e.to_node_id) !== String(selected.id)
        )
      );
    } else {
      commit(stateRef.current.nodes, stateRef.current.transitions.filter((e) => String(e.id) !== String(selected.id)));
    }
    setSelected(null);
  }

  function patchSelected(patch) {
    if (!editable || !selected || selected.kind !== "node") return;
    snapshot();
    commit(
      stateRef.current.nodes.map((n) => (String(n.id) === String(selected.id) ? { ...n, ...patch } : n)),
      stateRef.current.transitions
    );
  }

  function patchSelectedConfig(key, value) {
    const node = stateRef.current.nodes.find((n) => String(n.id) === String(selected?.id));
    if (!node) return;
    patchSelected({ config: { ...(node.config || {}), [key]: value } });
  }

  function patchEdge(id, patch) {
    if (!editable) return;
    snapshot();
    commit(
      stateRef.current.nodes,
      stateRef.current.transitions.map((e) => (String(e.id) === String(id) ? { ...e, ...patch } : e))
    );
  }

  function connect(fromId, toId) {
    if (!editable || String(fromId) === String(toId)) return;
    const exists = stateRef.current.transitions.some(
      (e) => String(e.from_node_id) === String(fromId) && String(e.to_node_id) === String(toId)
    );
    if (exists) return;
    const from = stateRef.current.nodes.find((n) => String(n.id) === String(fromId));
    const to = stateRef.current.nodes.find((n) => String(n.id) === String(toId));
    const edge = {
      id: tmpId(),
      transition_key: `edge-${from?.node_key}-${to?.node_key}`,
      from_node_id: fromId,
      to_node_id: toId,
      name: "",
      condition: {},
      is_default: false,
      display_order: stateRef.current.transitions.length,
    };
    snapshot();
    commit(stateRef.current.nodes, [...stateRef.current.transitions, edge]);
    setConnecting(null);
  }

  function applyAutoLayout() {
    if (!editable) return;
    snapshot();
    const positions = layout(stateRef.current.nodes, stateRef.current.transitions);
    commit(
      stateRef.current.nodes.map((n) => {
        const p = positions.get(n.id);
        return p ? { ...n, position_x: p.x, position_y: p.y } : n;
      }),
      stateRef.current.transitions
    );
  }

  // Adds a ready-to-edit conditional branch: a new task node plus the outgoing
  // transition from the decision, so authors can wire "if X then task Y" fast.
  function addConditionBranch(node) {
    if (!editable) return;
    const branchCount = stateRef.current.transitions.filter((e) => String(e.from_node_id) === String(node.id)).length;
    const taskCount = stateRef.current.nodes.filter((n) => n.type === "task").length + 1;
    const branch = {
      id: tmpId(),
      node_key: slugify("task", `${node.node_key}-branch-${taskCount}`, "branch"),
      type: "task",
      name: `Branch task ${taskCount}`,
      description: "",
      config: { assignee_type: "role", assignee_ref: "" },
      position_x: Math.round((node.position_x || 0) + 260),
      position_y: Math.round((node.position_y || 0) + branchCount * 130),
      display_order: stateRef.current.nodes.length,
    };
    const edge = {
      id: tmpId(),
      transition_key: `edge-${node.node_key}-${branch.node_key}`,
      from_node_id: node.id,
      to_node_id: branch.id,
      name: "",
      condition: {},
      is_default: false,
      display_order: stateRef.current.transitions.length,
    };
    snapshot();
    commit([...stateRef.current.nodes, branch], [...stateRef.current.transitions, edge]);
    setSelected({ kind: "node", id: branch.id });
  }

  const copySelected = useCallback(() => {
    const node = stateRef.current.nodes.find((n) => String(n.id) === String(selected?.id));
    if (node) setClipboard({ node });
  }, [selected]);

  const paste = useCallback(() => {
    if (!editable || !clipboard?.node) return;
    const src = clipboard.node;
    const copy = {
      ...src,
      id: tmpId(),
      node_key: `${src.node_key}-copy`,
      name: `${src.name} copy`,
      position_x: (src.position_x || 0) + 40,
      position_y: (src.position_y || 0) + 40,
      config: { ...(src.config || {}) },
    };
    snapshot();
    commit([...stateRef.current.nodes, copy], stateRef.current.transitions);
    setSelected({ kind: "node", id: copy.id });
  }, [clipboard, commit, snapshot, editable]);

  // Keep the latest shortcut state/handlers in a ref so the global keydown
  // listener can be registered exactly once. Previously the effect had no
  // dependency array, so the listener was removed and re-added on every render
  // (including every mousemove during pan/drag).
  const keyHandlerRef = useRef(null);
  keyHandlerRef.current = { selected, undo, redo, copySelected, paste, removeSelected, setConnecting };

  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const {
        selected,
        undo,
        redo,
        copySelected,
        paste,
        removeSelected,
        setConnecting,
      } = keyHandlerRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        copySelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        paste();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) {
          e.preventDefault();
          removeSelected();
        }
      } else if (e.key === "Escape") {
        setConnecting(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onBackgroundDown(e) {
    if (e.target !== e.currentTarget && !e.target.classList.contains("wf-canvas")) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, view };
    setSelected(null);
    setConnecting(null);
  }

  function onMouseMove(e) {
    if (panRef.current) {
      setView({
        ...panRef.current.view,
        x: panRef.current.view.x + (e.clientX - panRef.current.startX),
        y: panRef.current.view.y + (e.clientY - panRef.current.startY),
      });
    }
    if (dragRef.current) {
      const world = screenToWorld(e.clientX, e.clientY);
      const { id, offsetX, offsetY } = dragRef.current;
      setNodes((prev) =>
        prev.map((n) => (String(n.id) === String(id) ? { ...n, position_x: Math.round(world.x - offsetX), position_y: Math.round(world.y - offsetY) } : n))
      );
    }
    if (connecting) setPointer(screenToWorld(e.clientX, e.clientY));
  }

  function onMouseUp() {
    if (dragRef.current) {
      snapshot();
      dragRef.current = null;
    }
    panRef.current = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewportRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    const worldX = (mx - view.x) / view.scale;
    const worldY = (my - view.y) / view.scale;
    setView({ x: mx - worldX * scale, y: my - worldY * scale, scale });
  }

  function startDrag(e, node) {
    if (!editable) return;
    e.stopPropagation();
    setSelected({ kind: "node", id: node.id });
    const world = screenToWorld(e.clientX, e.clientY);
    dragRef.current = { id: node.id, offsetX: world.x - (node.position_x || 0), offsetY: world.y - (node.position_y || 0) };
  }

  async function validate() {
    setBusy(true);
    setError("");
    try {
      const res = await workflow.validateDesigner(templateId, { graph: { nodes, transitions } });
      setValidation(res.validation);
      if (res.validation?.valid) setNotice("Graph is valid.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await workflow.saveDesigner(templateId, {
        version_id: ctx.version.id,
        graph: { nodes, transitions },
      });
      setCtx(res);
      setNodes((res.graph?.nodes || []).map((n) => ({ ...n })));
      setTransitions((res.graph?.transitions || []).map((e) => ({ ...e })));
      setValidation(res.validation || null);
      setPast([]);
      setFuture([]);
      setNotice("Draft saved.");
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await save();
      const res = await workflow.publish(templateId, { version: ctx.version.version });
      setNotice(`Published v${res.version.version}.`);
      onChanged?.();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const nodeById = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => map.set(String(n.id), n));
    return map;
  }, [nodes]);

  const minimap = useMemo(() => {
    if (!nodes.length) return null;
    const xs = nodes.map((n) => n.position_x || 0);
    const ys = nodes.map((n) => n.position_y || 0);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NODE_W + 40;
    const maxY = Math.max(...ys) + NODE_H + 40;
    return { minX, minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
  }, [nodes]);

  const selectedNode = selected?.kind === "node" ? nodeById.get(String(selected.id)) : null;
  const selectedOutgoing = selectedNode
    ? transitions.filter((e) => String(e.from_node_id) === String(selectedNode.id))
    : [];

  if (!ctx) return <div className="panel">{error ? <div className="error">{error}</div> : <p className="mono">Loading designer…</p>}</div>;

  return (
    <div className="wf-designer">
      <div className="wf-toolbar">
        <div className="inline">
          <strong>{ctx.definition.name}</strong>
          <span className={`badge ${editable ? "active" : "locked"}`}>v{ctx.version.version} {ctx.version.status}</span>
          {validation ? (
            <span className={`badge ${validation.valid ? "active" : "locked"}`}>
              {validation.valid ? "valid" : `${validation.errors.length} issue(s)`}
            </span>
          ) : null}
        </div>
        <div className="inline">
          <button className="btn ghost" onClick={undo} disabled={!editable || !past.length}>Undo</button>
          <button className="btn ghost" onClick={redo} disabled={!editable || !future.length}>Redo</button>
          <button className="btn ghost" onClick={copySelected} disabled={!selectedNode}>Copy</button>
          <button className="btn ghost" onClick={paste} disabled={!editable || !clipboard}>Paste</button>
          <button className="btn ghost" onClick={applyAutoLayout} disabled={!editable}>Auto layout</button>
          <button className="btn ghost" onClick={() => setView({ x: 40, y: 20, scale: 1 })}>Reset view</button>
          <button className="btn secondary" onClick={validate} disabled={busy}>Validate</button>
          <button className="btn" onClick={save} disabled={!editable || busy}>Save draft</button>
          <button className="btn" onClick={publish} disabled={!editable || busy}>Publish</button>
          {onClose ? <button className="btn ghost" onClick={onClose}>Close</button> : null}
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}
      {validation && !validation.valid ? (
        <ul className="errors">
          {validation.errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}

      <div className="wf-designer-body">
        <div className="wf-palette">
          <div className="mono" style={{ marginBottom: 8 }}>Node palette</div>
          {NODE_TYPES.map((n) => (
            <button
              key={n.type}
              className="wf-palette-item"
              disabled={!editable}
              onClick={() => addNode(n.type, 140 - view.x / view.scale, 140 - view.y / view.scale)}
            >
              <span className="wf-dot" style={{ background: n.color }} />
              {n.label}
            </button>
          ))}
        </div>

        <div
          className="wf-viewport"
          ref={viewportRef}
          onMouseDown={onBackgroundDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
        >
          <div
            className="wf-canvas"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            <svg className="wf-edges" width="4000" height="3000">
              {transitions.map((edge) => {
                const from = nodeById.get(String(edge.from_node_id));
                const to = nodeById.get(String(edge.to_node_id));
                if (!from || !to) return null;
                const x1 = (from.position_x || 0) + NODE_W;
                const y1 = (from.position_y || 0) + NODE_H / 2;
                const x2 = to.position_x || 0;
                const y2 = (to.position_y || 0) + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                const selectedEdge = selected?.kind === "edge" && String(selected.id) === String(edge.id);
                const outcome = approvalOutcomeLabel(from, edge);
                const label = edgeLabel(edge, from);
                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      className={`wf-edge ${selectedEdge ? "selected" : ""} ${edge.is_default ? "default" : ""} ${outcome}`}
                    />
                    <circle cx={x1} cy={y1} r={4} className="wf-edge-dot" />
                    <circle cx={x2} cy={y2} r={4} className="wf-edge-dot" />
                    <text
                      x={mid}
                      y={(y1 + y2) / 2 - 6}
                      className={`wf-edge-label ${outcome}`}
                      onClick={() => setSelected({ kind: "edge", id: edge.id })}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
              {connecting && pointer
                ? (() => {
                    const from = nodeById.get(String(connecting));
                    if (!from) return null;
                    return (
                      <path
                        d={`M ${(from.position_x || 0) + NODE_W} ${(from.position_y || 0) + NODE_H / 2} L ${pointer.x} ${pointer.y}`}
                        className="wf-edge pending"
                      />
                    );
                  })()
                : null}
            </svg>

            {nodes.map((node) => (
              <div
                key={node.id}
                className={`wf-node ${selected?.kind === "node" && String(selected.id) === String(node.id) ? "selected" : ""}`}
                style={{ left: node.position_x || 0, top: node.position_y || 0, width: NODE_W, minHeight: NODE_H }}
                onMouseDown={(e) => startDrag(e, node)}
                onClick={() => (connecting ? connect(connecting, node.id) : setSelected({ kind: "node", id: node.id }))}
              >
                <div className="wf-node-head" style={{ borderColor: NODE_COLORS[node.type] }}>
                  <span className="wf-dot" style={{ background: NODE_COLORS[node.type] }} />
                  <span className="wf-node-type">{node.type}</span>
                </div>
                <div className="wf-node-name">{node.name}</div>
                <div className="wf-node-key mono">{node.node_key}</div>
                {editable && node.type !== "end" && node.type !== "terminate" ? (
                  <button
                    className="wf-port"
                    title="Connect"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConnecting(connecting && String(connecting) === String(node.id) ? null : node.id);
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>

          {minimap ? (
            <svg className="wf-minimap" viewBox={`0 0 ${minimap.w} ${minimap.h}`} preserveAspectRatio="xMidYMid meet">
              {transitions.map((edge) => {
                const from = nodeById.get(String(edge.from_node_id));
                const to = nodeById.get(String(edge.to_node_id));
                if (!from || !to) return null;
                return (
                  <line
                    key={edge.id}
                    x1={(from.position_x || 0) - minimap.minX + NODE_W / 2}
                    y1={(from.position_y || 0) - minimap.minY + NODE_H / 2}
                    x2={(to.position_x || 0) - minimap.minX + NODE_W / 2}
                    y2={(to.position_y || 0) - minimap.minY + NODE_H / 2}
                    className="wf-mini-edge"
                  />
                );
              })}
              {nodes.map((n) => (
                <rect
                  key={n.id}
                  x={(n.position_x || 0) - minimap.minX}
                  y={(n.position_y || 0) - minimap.minY}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  className="wf-mini-node"
                  style={{ fill: NODE_COLORS[n.type] }}
                />
              ))}
            </svg>
          ) : null}
        </div>

        <div className="wf-inspector">
          <div className="mono" style={{ marginBottom: 8 }}>Inspector</div>
          {selectedNode ? (
            <>
              <label className="field">
                <span>Name</span>
                <input value={selectedNode.name} onChange={(e) => patchSelected({ name: e.target.value })} disabled={!editable} />
              </label>
              <label className="field">
                <span>Key</span>
                <input value={selectedNode.node_key} onChange={(e) => patchSelected({ node_key: e.target.value })} disabled={!editable} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea value={selectedNode.description || ""} onChange={(e) => patchSelected({ description: e.target.value })} disabled={!editable} />
              </label>
              {(selectedNode.type === "task" || selectedNode.type === "approval") ? (
                <>
                  <label className="field">
                    <span>Assignee type</span>
                    <select value={selectedNode.config?.assignee_type || "role"} onChange={(e) => patchSelectedConfig("assignee_type", e.target.value)} disabled={!editable}>
                      {["unassigned", "user", "role", "organization", "group", "queue"].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Assignee ref</span>
                    <input value={selectedNode.config?.assignee_ref || ""} onChange={(e) => patchSelectedConfig("assignee_ref", e.target.value)} disabled={!editable} />
                  </label>
                </>
              ) : null}
              {selectedNode.type === "approval" ? (
                <>
                  <label className="field">
                    <span>Approval rule code</span>
                    <input value={selectedNode.config?.approval_rule_code || ""} onChange={(e) => patchSelectedConfig("approval_rule_code", e.target.value)} disabled={!editable} />
                  </label>
                  <div className="wf-path-group">
                    <div className="mono">Outcome paths</div>
                    <label className="field">
                      <span>On approve, go to</span>
                      <select
                        value={selectedNode.config?.approve_transition_key || ""}
                        onChange={(e) => patchSelectedConfig("approve_transition_key", e.target.value)}
                        disabled={!editable}
                      >
                        <option value="">— first / default branch —</option>
                        {selectedOutgoing.map((edge) => (
                          <option key={edge.id} value={edge.transition_key}>
                            {(nodeById.get(String(edge.to_node_id))?.name || edge.to_node_id)} [{edge.transition_key}]
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>On reject, go to</span>
                      <select
                        value={selectedNode.config?.reject_transition_key || ""}
                        onChange={(e) => patchSelectedConfig("reject_transition_key", e.target.value)}
                        disabled={!editable}
                      >
                        <option value="">— fail the workflow —</option>
                        {selectedOutgoing.map((edge) => (
                          <option key={edge.id} value={edge.transition_key}>
                            {(nodeById.get(String(edge.to_node_id))?.name || edge.to_node_id)} [{edge.transition_key}]
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="mono sub">
                      Connect this approval to its outcome nodes first, then pick the approve and reject branches here.
                    </p>
                  </div>
                </>
              ) : null}
              {selectedNode.type === "decision" ? (
                <div className="field">
                  <span>Conditional branches</span>
                  {selectedOutgoing.length === 0 ? (
                    <p className="mono">Connect this decision to target nodes, then add a condition per branch.</p>
                  ) : (
                    selectedOutgoing.map((edge) => (
                      <div key={edge.id} className="wf-branch">
                        <div className="inline">
                          <strong className="grow">{nodeById.get(String(edge.to_node_id))?.name || `#${edge.to_node_id}`}</strong>
                          <label className="inline">
                            <input
                              type="checkbox"
                              checked={Boolean(edge.is_default)}
                              onChange={(e) => patchEdge(edge.id, { is_default: e.target.checked })}
                              disabled={!editable}
                            />
                            <span className="mono">default</span>
                          </label>
                        </div>
                        <ConditionEditor
                          condition={edge.condition}
                          onChange={(condition) => patchEdge(edge.id, { condition })}
                          disabled={!editable}
                        />
                      </div>
                    ))
                  )}
                  {editable ? (
                    <button className="btn ghost" onClick={() => addConditionBranch(selectedNode)}>Add conditional task</button>
                  ) : null}
                </div>
              ) : null}
              {selectedNode.type === "timer" ? (
                <label className="field">
                  <span>Duration (minutes)</span>
                  <input type="number" value={selectedNode.config?.duration_minutes ?? 60} onChange={(e) => patchSelectedConfig("duration_minutes", Number(e.target.value))} disabled={!editable} />
                </label>
              ) : null}
              {selectedNode.type === "notification" ? (
                <label className="field">
                  <span>Template code</span>
                  <input value={selectedNode.config?.template_code || ""} onChange={(e) => patchSelectedConfig("template_code", e.target.value)} disabled={!editable} />
                </label>
              ) : null}
              {selectedNode.type === "subprocess" ? (
                <>
                  <label className="field">
                    <span>Workflow code</span>
                    <input value={selectedNode.config?.workflow_code || ""} onChange={(e) => patchSelectedConfig("workflow_code", e.target.value)} disabled={!editable} />
                  </label>
                  <label className="field">
                    <span>Definition id</span>
                    <input value={selectedNode.config?.definition_id || ""} onChange={(e) => patchSelectedConfig("definition_id", e.target.value)} disabled={!editable} />
                  </label>
                </>
              ) : null}
              {selectedNode.type === "service" ? (
                <label className="field">
                  <span>Handler</span>
                  <input value={selectedNode.config?.handler || ""} onChange={(e) => patchSelectedConfig("handler", e.target.value)} disabled={!editable} />
                </label>
              ) : null}
              {editable ? <button className="btn danger" onClick={removeSelected}>Delete node</button> : null}
            </>
          ) : selected?.kind === "edge" ? (
            (() => {
              const edge = transitions.find((e) => String(e.id) === String(selected.id));
              if (!edge) return <p className="mono">Edge not found.</p>;
              return (
                <>
                  <label className="field">
                    <span>Name</span>
                    <input value={edge.name || ""} onChange={(e) => patchEdge(edge.id, { name: e.target.value })} disabled={!editable} />
                  </label>
                  <label className="field">
                    <span>Default branch</span>
                    <input type="checkbox" checked={Boolean(edge.is_default)} onChange={(e) => patchEdge(edge.id, { is_default: e.target.checked })} disabled={!editable} />
                  </label>
                  <div className="field">
                    <span>Condition</span>
                    <ConditionEditor
                      condition={edge.condition}
                      onChange={(condition) => patchEdge(edge.id, { condition })}
                      disabled={!editable}
                    />
                  </div>
                  <label className="field">
                    <span>Condition (JSON, advanced)</span>
                    <textarea
                      value={JSON.stringify(edge.condition || {}, null, 2)}
                      onChange={(e) => {
                        try {
                          patchEdge(edge.id, { condition: JSON.parse(e.target.value || "{}") });
                        } catch {
                          /* keep typing */
                        }
                      }}
                      disabled={!editable}
                    />
                  </label>
                  {editable ? <button className="btn danger" onClick={removeSelected}>Delete transition</button> : null}
                </>
              );
            })()
          ) : (
            <p className="mono">
              Select a node or transition. {editable ? "Drag nodes, click a port then a target to connect." : "This version is published and read-only."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
