import React from "react";

const TYPE_TONE = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  READ: "read",
  VIEW: "read",
  DOWNLOAD: "read",
  LOGIN: "auth",
  LOGOUT: "auth",
  PERMISSION: "auth",
  EXPORT: "export",
};

function toneOf(event) {
  if (event.status === "denied" || event.status === "failure") return "alert";
  return TYPE_TONE[event.event_type] || "default";
}

function timeOf(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export default function AuditTimeline({ events = [], selectedId, onSelect, emptyText = "No audit events found." }) {
  if (!events.length) return <div className="audit-empty">{emptyText}</div>;
  return (
    <ol className="audit-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <button
            type="button"
            className={`audit-item ${selectedId === event.id ? "active" : ""}`}
            onClick={() => onSelect?.(event)}
          >
            <span className={`audit-dot ${toneOf(event)}`} />
            <span className="audit-item-body">
              <span className="audit-item-top">
                <b>{event.action}</b>
                {event.event_type ? <span className="chip">{event.event_type}</span> : null}
                {event.status && event.status !== "success" ? (
                  <span className={`badge ${event.status === "denied" ? "locked" : "inactive"}`}>{event.status}</span>
                ) : null}
                <span className="audit-item-time">{timeOf(event.occurred_at || event.created_at)}</span>
              </span>
              <span className="audit-item-sub">
                <span>{event.actor_username || "system"}</span>
                <span className="mono">
                  {event.object_type}
                  {event.object_id ? ` #${event.object_id}` : ""}
                </span>
                {event.object_name ? <span>{event.object_name}</span> : null}
                {event.source ? <span className="mono">{event.source}</span> : null}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
