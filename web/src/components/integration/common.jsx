import React, { useCallback, useEffect, useState } from "react";

export function ts(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 19);
}

export function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatusBadge({ value, prefix = "" }) {
  const status = String(value || "unknown").toLowerCase();
  return <span className={`badge ${prefix}${status.replace(/[^a-z0-9_]/g, "")}`}>{value || "unknown"}</span>;
}

export function useAsync(loader, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await loader();
      setData(result);
      return result;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
  }, [run]);
  return { data, loading, error, reload: run, setData, setError };
}

export function Section({ title, actions, children, className = "" }) {
  return (
    <div className={`panel ${className}`}>
      {title || actions ? (
        <div className="panel-head">
          {title ? <h3>{title}</h3> : <span />}
          {actions ? <div className="inline">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <b>{value ?? "—"}</b>
      {hint ? <span className="muted intg-stat-hint">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ items }) {
  return (
    <div className="grid">
      {items.map((item) => (
        <Stat key={item.label} {...item} />
      ))}
    </div>
  );
}

export function Table({ columns, rows, empty = "No records", rowKey, onRow, loading }) {
  if (loading && !rows?.length) return <div className="audit-empty">Loading…</div>;
  if (!rows?.length) return <div className="audit-empty">{empty}</div>;
  return (
    <div className="intg-table-wrap">
      <table className="intg-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey ? rowKey(row, index) : row.id ?? index}
              className={onRow ? "intg-clickable" : ""}
              onClick={onRow ? () => onRow(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key}>{col.render ? col.render(row) : String(row[col.key] ?? "—")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / (pageSize || 25)));
  return (
    <div className="pager">
      <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {totalPages} · {total || 0} records</span>
      <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export function JsonBlock({ value, maxHeight = 260 }) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className="intg-json" style={{ maxHeight }}>{text}</pre>;
}

export function Drawer({ title, subtitle, onClose, children }) {
  return (
    <div className="audit-drawer-backdrop" onClick={onClose}>
      <div className="audit-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="audit-drawer-head">
          <div>
            <div className="brand">{subtitle}</div>
            <h2>{title}</h2>
          </div>
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Notice({ kind = "ok", children }) {
  if (!children) return null;
  return <div className={kind === "ok" ? "notice" : "error"}>{children}</div>;
}

export function Toolbar({ children }) {
  return <div className="intg-toolbar">{children}</div>;
}
