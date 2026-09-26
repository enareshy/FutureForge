import React from "react";

const FORBIDDEN = ["script", "style", "iframe", "object", "embed", "link", "meta", "form"];

export function safeHtml(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = doc.body.firstChild;
    if (!root) return "";
    FORBIDDEN.forEach((tag) => root.querySelectorAll(tag).forEach((node) => node.remove()));
    root.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || (name === "href" && /^\s*javascript:/i.test(attr.value))) {
          node.removeAttribute(attr.name);
        }
      });
    });
    return root.innerHTML;
  } catch {
    return "";
  }
}

function fmt(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function NotificationDrawer({ notification, onClose, onRead, onUnread, onArchive, onDelete }) {
  if (!notification) return null;
  const links = notification.action_links || [];
  return (
    <div className="audit-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="audit-drawer notif-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="audit-drawer-head">
          <div>
            <div className="brand">{notification.event_type || notification.channel}</div>
            <h2>{notification.subject || "(no subject)"}</h2>
            <div className="crumbs">
              {notification.priority} · {notification.status} · {fmt(notification.created_at)}
            </div>
          </div>
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>

        <div className="notif-drawer-body" dangerouslySetInnerHTML={{ __html: safeHtml(notification.body) }} />

        {links.length ? (
          <>
            <h3>Actions</h3>
            <div className="inline">
              {links.map((link, index) => (
                <a className="btn secondary" key={`${link.url}-${index}`} href={link.url || link.href || "#"}>
                  {link.label || link.title || link.url}
                </a>
              ))}
            </div>
          </>
        ) : null}

        {notification.deep_link ? (
          <p style={{ marginTop: 16 }}>
            <a href={notification.deep_link}>Open related item →</a>
          </p>
        ) : null}

        <h3>Details</h3>
        <div className="audit-meta">
          <div><span>Channel</span><b>{notification.channel}</b></div>
          <div><span>Priority</span><b>{notification.priority}</b></div>
          <div><span>Recipient</span><b>{notification.recipient_username || notification.recipient_id}</b></div>
          <div><span>Template</span><b>{notification.template_code || "—"}</b></div>
          <div><span>Object</span><b>{notification.object_name || notification.object_type || "—"}</b></div>
          <div><span>Correlation</span><b className="mono">{notification.correlation_id || "—"}</b></div>
          <div><span>Sent</span><b>{fmt(notification.sent_at)}</b></div>
          <div><span>Read</span><b>{fmt(notification.read_at)}</b></div>
        </div>

        <div className="inline" style={{ marginTop: 18 }}>
          {notification.read ? (
            <button className="btn ghost" type="button" onClick={() => onUnread(notification)}>Mark unread</button>
          ) : (
            <button className="btn" type="button" onClick={() => onRead(notification)}>Mark read</button>
          )}
          <button className="btn secondary" type="button" onClick={() => onArchive(notification)}>Archive</button>
          <button className="btn danger" type="button" onClick={() => onDelete(notification)}>Delete</button>
        </div>
      </aside>
    </div>
  );
}
