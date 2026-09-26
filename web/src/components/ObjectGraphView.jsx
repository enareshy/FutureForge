import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// Lightweight, dependency-free force-directed graph view for object
// relationship projections (`GET /api/objects/:id/graph`). Renders nodes as
// circles with relationship edges; click a node to open that object.

const WIDTH = 1000;
const HEIGHT = 620;
const PAD = 70;

const STATUS_COLORS = {
  active: "#3ee0c0",
  released: "#3ee0c0",
  draft: "#5b8cff",
  in_review: "#f5c15a",
  approved: "#f5c15a",
  obsolete: "#93a0c0",
  archived: "#93a0c0",
  cancelled: "#ff6b7a",
};

function statusColor(status) {
  return STATUS_COLORS[status] || "#8fa4c8";
}

function computeLayout(nodeIds, edges, rootId) {
  const n = nodeIds.length;
  const positions = new Map();
  if (!n) return positions;
  const radius = Math.min(WIDTH, HEIGHT) / 2 - PAD;
  nodeIds.forEach((id, index) => {
    const angle = (index / n) * Math.PI * 2;
    positions.set(id, {
      x: WIDTH / 2 + radius * Math.cos(angle),
      y: HEIGHT / 2 + radius * Math.sin(angle),
    });
  });

  const area = WIDTH * HEIGHT;
  const k = Math.sqrt(area / Math.max(n, 1));
  let temperature = WIDTH / 8;
  // The all-pairs force loop is O(iterations · n²). Scale the iteration budget
  // down as the graph grows so large projections stay interactive instead of
  // freezing the main thread for seconds.
  const iterations = Math.max(40, Math.min(320, Math.round(60000 / Math.max(n, 1))));
  const fixed = new Set([rootId]);

  for (let step = 0; step < iterations; step += 1) {
    const disp = new Map(nodeIds.map((id) => [id, { x: 0, y: 0 }]));

    for (let i = 0; i < n; i += 1) {
      const a = positions.get(nodeIds[i]);
      for (let j = i + 1; j < n; j += 1) {
        const b = positions.get(nodeIds[j]);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        const da = disp.get(nodeIds[i]);
        const db = disp.get(nodeIds[j]);
        da.x += dx;
        da.y += dy;
        db.x -= dx;
        db.y -= dy;
      }
    }

    for (const edge of edges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      const da = disp.get(edge.from);
      const db = disp.get(edge.to);
      da.x -= dx;
      da.y -= dy;
      db.x += dx;
      db.y += dy;
    }

    for (const id of nodeIds) {
      const p = positions.get(id);
      const d = disp.get(id);
      d.x += (WIDTH / 2 - p.x) * 0.01;
      d.y += (HEIGHT / 2 - p.y) * 0.01;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const limit = Math.min(len, temperature);
      if (!fixed.has(id)) {
        p.x += (d.x / len) * limit;
        p.y += (d.y / len) * limit;
      }
    }
    temperature *= 0.985;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((WIDTH - PAD * 2) / spanX, (HEIGHT - PAD * 2) / spanY, 3);
  const offsetX = (WIDTH - spanX * scale) / 2 - minX * scale;
  const offsetY = (HEIGHT - spanY * scale) / 2 - minY * scale;
  for (const p of positions.values()) {
    p.x = p.x * scale + offsetX;
    p.y = p.y * scale + offsetY;
  }
  return positions;
}

export default function ObjectGraphView({ graph, height = 560 }) {
  const navigate = useNavigate();
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState(`0 0 ${WIDTH} ${HEIGHT}`);
  const [hover, setHover] = useState(null);
  const panRef = useRef(null);

  const model = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes || [];
    const nodeIds = nodes.map((n) => String(n.id));
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const edges = (graph.edges || [])
      .map((edge) => ({
        id: edge.id,
        from: String(edge.source?.id ?? edge.traversal_from),
        to: String(edge.target?.id ?? edge.traversal_to),
        label: edge.relationship_type?.code || "",
        semantic: edge.relationship_type?.semantic || "",
        directed: edge.relationship_type?.directed !== false,
        code: edge.relationship_type?.code || "",
      }))
      .filter((e) => byId.has(e.from) && byId.has(e.to));
    const positions = computeLayout([...nodeIds], edges, String(graph.root_id));
    return { nodes, byId, edges, positions };
  }, [graph]);

  useEffect(() => {
    setViewBox(`0 0 ${WIDTH} ${HEIGHT}`);
  }, [graph]);

  if (!graph) return <p className="mono">Loading graph…</p>;
  if (!model || !model.nodes.length) return <p className="mono">No related objects to plot.</p>;

  function parseViewBox() {
    const [x, y, w, h] = viewBox.split(" ").map(Number);
    return { x, y, w, h };
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const { x, y, w, h } = parseViewBox();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scale = e.deltaY < 0 ? 0.85 : 1.18;
    const nw = Math.min(WIDTH * 2, Math.max(WIDTH / 8, w * scale));
    const nh = (nw / w) * h;
    const wx = x + (mx / rect.width) * w;
    const wy = y + (my / rect.height) * h;
    setViewBox(`${wx - (mx / rect.width) * nw} ${wy - (my / rect.height) * nh} ${nw} ${nh}`);
  }

  function onMouseDown(e) {
    if (e.target.dataset.node) return;
    const { x, y, w, h } = parseViewBox();
    panRef.current = { clientX: e.clientX, clientY: e.clientY, x, y, w, h, rect: svgRef.current.getBoundingClientRect() };
  }

  function onMouseMove(e) {
    if (!panRef.current) return;
    const p = panRef.current;
    const dx = ((e.clientX - p.clientX) / p.rect.width) * p.w;
    const dy = ((e.clientY - p.clientY) / p.rect.height) * p.h;
    setViewBox(`${p.x - dx} ${p.y - dy} ${p.w} ${p.h}`);
  }

  function zoom(factor) {
    const { x, y, w, h } = parseViewBox();
    const nw = Math.min(WIDTH * 2, Math.max(WIDTH / 8, w * factor));
    const nh = (nw / w) * h;
    setViewBox(`${x + (w - nw) / 2} ${y + (h - nh) / 2} ${nw} ${nh}`);
  }

  return (
    <div className="obj-graph">
      <div className="obj-graph-toolbar">
        <span className="mono">
          {graph.node_count} nodes · {graph.edge_count} edges
        </span>
        <div className="inline">
          <button className="btn ghost" onClick={() => zoom(0.8)}>Zoom in</button>
          <button className="btn ghost" onClick={() => zoom(1.25)}>Zoom out</button>
          <button className="btn ghost" onClick={() => setViewBox(`0 0 ${WIDTH} ${HEIGHT}`)}>Reset</button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="obj-graph-svg"
        viewBox={viewBox}
        style={{ height }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={() => (panRef.current = null)}
        onMouseLeave={() => (panRef.current = null)}
      >
        <defs>
          <marker id="obj-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a4a74" />
          </marker>
        </defs>

        {model.edges.map((edge) => {
          const a = model.positions.get(edge.from);
          const b = model.positions.get(edge.to);
          if (!a || !b) return null;
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          return (
            <g key={edge.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className="obj-graph-edge"
                markerEnd={edge.directed ? "url(#obj-graph-arrow)" : undefined}
              />
              {edge.label ? (
                <text x={midX} y={midY - 4} className="obj-graph-edge-label">
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {model.nodes.map((node) => {
          const p = model.positions.get(String(node.id));
          const isRoot = String(node.id) === String(graph.root_id);
          const r = isRoot ? 24 : 18;
          return (
            <g
              key={node.id}
              className="obj-graph-node"
              transform={`translate(${p.x}, ${p.y})`}
              onMouseEnter={() => setHover({ node, x: p.x, y: p.y })}
              onMouseLeave={() => setHover(null)}
              onClick={() => navigate(`/objects/${node.id}`)}
            >
              <circle r={r} fill={statusColor(node.status)} className={isRoot ? "root" : ""} data-node="1" />
              <text y={r + 14} className="obj-graph-node-label" data-node="1">
                {node.code}
              </text>
              <title>{`${node.name} · ${node.type?.name || ""} · ${node.status}`}</title>
            </g>
          );
        })}

        {hover ? (
          <g transform={`translate(${hover.x + 16}, ${hover.y - 12})`} pointerEvents="none">
            <rect x={0} y={0} width={Math.min(240, Math.max(120, (hover.node.name || "").length * 7 + 90))} height={44} rx={8} className="obj-graph-tooltip" />
            <text x={10} y={18} className="obj-graph-tooltip-title">{hover.node.name}</text>
            <text x={10} y={34} className="obj-graph-tooltip-sub">
              {hover.node.code} · {hover.node.type?.name || ""} · {hover.node.status}
            </text>
          </g>
        ) : null}
      </svg>
      <div className="obj-graph-legend">
        {["draft", "active", "released", "in_review", "obsolete"].map((s) => (
          <span key={s} className="chip">
            <span className="wf-dot" style={{ background: statusColor(s) }} /> {s}
          </span>
        ))}
        <span className="mono">Click a node to open the object · scroll to zoom · drag to pan</span>
      </div>
    </div>
  );
}
