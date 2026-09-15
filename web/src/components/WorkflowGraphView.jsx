import React, { useMemo } from "react";

// Read-only workflow progress graph for the task detail view. Nodes are coloured
// by their instance status: completed = green, current step = yellow, steps not
// reached yet = grey. Connectors are routed along node boundaries (not centres)
// so they stay visible, with arrowheads pointing into the next node.

const NODE_W = 154;
const NODE_H = 56;
const PAD = 40;

const STATUS_STYLE = {
  completed: { fill: "rgba(62, 224, 192, 0.16)", stroke: "#3ee0c0", text: "#3ee0c0" },
  active: { fill: "rgba(245, 193, 90, 0.20)", stroke: "#f5c15a", text: "#f5c15a" },
  blocked: { fill: "rgba(245, 193, 90, 0.20)", stroke: "#f5c15a", text: "#f5c15a" },
  failed: { fill: "rgba(255, 107, 122, 0.20)", stroke: "#ff6b7a", text: "#ff6b7a" },
  pending: { fill: "rgba(143, 164, 200, 0.14)", stroke: "#56617f", text: "#93a0c0" },
  skipped: { fill: "rgba(143, 164, 200, 0.10)", stroke: "#46527a", text: "#93a0c0" },
  cancelled: { fill: "rgba(143, 164, 200, 0.10)", stroke: "#46527a", text: "#93a0c0" },
};

function styleFor(status) {
  return STATUS_STYLE[status] || STATUS_STYLE.pending;
}

function isCurrentNode(node, workflow) {
  return (
    node.instance_status === "active" ||
    node.instance_status === "blocked" ||
    (workflow.current_node_id && String(node.id) === String(workflow.current_node_id))
  );
}

// Layered fallback used only when the template has no saved coordinates.
function layeredLayout(nodes, transitions) {
  const outgoing = new Map(nodes.map((n) => [String(n.id), []]));
  for (const e of transitions) outgoing.get(String(e.from_node_id))?.push(String(e.to_node_id));
  const depth = new Map();
  const start = nodes.find((n) => n.type === "start") || nodes[0];
  const queue = start ? [String(start.id)] : [];
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      if (!depth.has(next)) {
        depth.set(next, (depth.get(id) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  const rows = new Map();
  nodes.forEach((n, i) => {
    const d = depth.get(String(n.id)) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push({ n, i });
  });
  const pos = new Map();
  [...rows.entries()].sort((a, b) => a[0] - b[0]).forEach(([d, list]) => {
    list.sort((a, b) => a.i - b.i);
    list.forEach(({ n }, idx) => pos.set(String(n.id), { x: 60 + d * 220, y: 40 + idx * 110 }));
  });
  return pos;
}

// Route a connector along the facing edges of two nodes so it never runs under
// a node box. Returns the path plus a label anchor near the midpoint.
function connector(a, b) {
  const ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
  const bc = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const right = dx >= 0;
    const sx = a.x + (right ? NODE_W : 0);
    const sy = a.y + NODE_H / 2;
    const ex = b.x + (right ? 0 : NODE_W);
    const ey = b.y + NODE_H / 2;
    const mx = (sx + ex) / 2;
    return {
      d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`,
      label: { x: mx, y: (sy + ey) / 2 - 6 },
    };
  }
  const down = dy >= 0;
  const sx = a.x + NODE_W / 2;
  const sy = a.y + (down ? NODE_H : 0);
  const ex = b.x + NODE_W / 2;
  const ey = b.y + (down ? 0 : NODE_H);
  const my = (sy + ey) / 2;
  return {
    d: `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`,
    label: { x: (sx + ex) / 2, y: my - 6 },
  };
}

export default function WorkflowGraphView({ workflow, taskNodeId, height = 340 }) {
  const model = useMemo(() => {
    if (!workflow?.nodes?.length) return null;
    const nodes = workflow.nodes;
    const transitions = workflow.transitions || [];
    const stored = new Map(nodes.map((n) => [String(n.id), { x: n.position_x || 0, y: n.position_y || 0 }]));
    const anyStored = nodes.some((n) => (n.position_x || 0) !== 0 || (n.position_y || 0) !== 0);
    const fallback = layeredLayout(nodes, transitions);
    const positions = new Map();
    for (const n of nodes) {
      const s = stored.get(String(n.id));
      positions.set(String(n.id), anyStored && (s.x !== 0 || s.y !== 0) ? s : fallback.get(String(n.id)));
    }
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const minX = Math.min(...xs) - PAD;
    const minY = Math.min(...ys) - PAD;
    const maxX = Math.max(...xs) + NODE_W + PAD;
    const maxY = Math.max(...ys) + NODE_H + PAD;
    const edges = transitions
      .map((edge) => {
        const a = positions.get(String(edge.from_node_id));
        const b = positions.get(String(edge.to_node_id));
        if (!a || !b) return null;
        return { id: edge.id, ...connector(a, b) };
      })
      .filter(Boolean);
    return {
      nodes,
      edges,
      positions,
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [workflow]);

  if (!model) return <p className="mono">No workflow graph available for this task.</p>;

  return (
    <div className="wf-graph-view">
      <div className="wf-graph-legend">
        <span className="chip wf-legend-done">Completed</span>
        <span className="chip wf-legend-current">Current</span>
        <span className="chip wf-legend-pending">Not completed</span>
      </div>
      <div className="wf-graph-scroll">
        <svg
          className="wf-graph-svg"
          viewBox={model.viewBox}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", aspectRatio: `${model.width} / ${Math.max(model.height, 140)}` }}
        >
          <defs>
            <marker
              id="wf-graph-arrow"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
              markerUnits="strokeWidth"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7ba3" />
            </marker>
          </defs>

          {model.edges.map((edge) => (
            <path key={edge.id} d={edge.d} className="wf-graph-edge" markerEnd="url(#wf-graph-arrow)" fill="none" />
          ))}

          {model.nodes.map((node) => {
            const p = model.positions.get(String(node.id));
            const style = styleFor(node.instance_status);
            const current = isCurrentNode(node, workflow);
            const thisTask = taskNodeId && String(node.id) === String(taskNodeId);
            return (
              <g key={node.id} transform={`translate(${p.x}, ${p.y})`} className="wf-graph-node">
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  fill={style.fill}
                  stroke={style.stroke}
                  strokeWidth={current || thisTask ? 3 : 1.5}
                  className={current ? "current" : ""}
                />
                <text x={12} y={19} className="wf-graph-node-type" fill={style.text}>
                  {node.type}
                </text>
                <text x={12} y={40} className="wf-graph-node-name">
                  {truncate(node.name, 20)}
                </text>
                {current ? (
                  <text x={NODE_W - 10} y={19} className="wf-graph-node-state" textAnchor="end">
                    current
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
