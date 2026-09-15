import React from "react";

function valueText(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function StatusBadge({ status }) {
  const cls = status === "success" ? "active" : status === "denied" ? "locked" : "inactive";
  return <span className={`badge ${cls}`}>{status || "success"}</span>;
}

function changeRows(event) {
  if (Array.isArray(event.changes) && event.changes.length) {
    return event.changes.map((change) => ({
      attribute: change.attribute,
      old: change.old_value,
      next: change.new_value,
      masked: change.masked,
    }));
  }
  const fields = event.changed_fields || [];
  const before = event.before_values || {};
  const after = event.after_values || {};
  return fields.map((attribute) => ({
    attribute,
    old: before[attribute],
    next: after[attribute],
    masked: false,
  }));
}

export default function AuditEventDrawer({ event, onClose }) {
  if (!event) return null;
  const rows = changeRows(event);
  return (
    <div className="audit-drawer-backdrop" onClick={onClose}>
      <aside className="audit-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="audit-drawer-head">
          <div>
            <div className="brand">Audit event</div>
            <h2>{event.action}</h2>
            <div className="mono">#{event.id} · {event.occurred_at || event.created_at}</div>
          </div>
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>

        <div className="audit-meta">
          <div><span>Actor</span><b>{event.actor_username || "system"}</b>{event.user_display_name ? <i>{event.user_display_name}</i> : null}</div>
          <div><span>Type</span><b>{event.event_type || "—"}</b></div>
          <div><span>Status</span><StatusBadge status={event.status} /></div>
          <div><span>Source</span><b>{event.source || "api"}</b></div>
          <div><span>Object</span><b className="mono">{event.object_type}{event.object_id ? ` #${event.object_id}` : ""}</b></div>
          <div><span>Object name</span><b>{event.object_name || "—"}</b></div>
          <div><span>IP</span><b className="mono">{event.ip || "—"}</b></div>
          <div><span>Duration</span><b>{event.duration_ms == null ? "—" : `${event.duration_ms} ms`}</b></div>
          <div><span>Correlation</span><b className="mono">{event.correlation_id || "—"}</b></div>
          <div><span>Parent event</span><b className="mono">{event.parent_event_id || "—"}</b></div>
          <div><span>Request</span><b className="mono">{event.request_id || "—"}</b></div>
          <div><span>Device</span><b className="mono" title={event.device || ""}>{event.device ? event.device.slice(0, 40) : "—"}</b></div>
        </div>

        {event.reason ? <div className="audit-note"><span>Reason</span><p>{event.reason}</p></div> : null}
        {event.error_message ? <div className="error">{event.error_message}</div> : null}

        <h3>Attribute changes</h3>
        {rows.length ? (
          <table className="audit-diff">
            <thead>
              <tr><th>Attribute</th><th>Before</th><th>After</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.attribute}>
                  <td className="mono">{row.attribute}{row.masked ? " (masked)" : ""}</td>
                  <td className="audit-before">{valueText(row.old)}</td>
                  <td className="audit-after">{valueText(row.next)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No attribute-level changes were recorded for this event.</p>
        )}

        {event.details ? (
          <>
            <h3>Details</h3>
            <pre className="json">{JSON.stringify(event.details, null, 2)}</pre>
          </>
        ) : null}

        {event.related ? (
          <>
            <h3>Related records</h3>
            <pre className="json">{JSON.stringify(event.related, null, 2)}</pre>
          </>
        ) : null}
      </aside>
    </div>
  );
}
