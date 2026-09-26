import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { notifications } from "../api.js";

function timeAgo(value) {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function NotificationBell({ enabled = true }) {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(enabled);
  const wrapRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [count, list] = await Promise.all([
        notifications.unreadCount(),
        notifications.inbox("?unread=true&pageSize=5"),
      ]);
      setUnread(count.unread || 0);
      setItems(list.items || []);
      setAllowed(true);
    } catch (err) {
      if (err.status === 403) setAllowed(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!allowed) return null;

  async function openItem(item) {
    try {
      if (!item.read) await notifications.markRead(item.id);
    } catch {
      /* best effort */
    }
    setOpen(false);
    refresh();
    if (item.deep_link) navigate(item.deep_link);
    else navigate("/notifications");
  }

  return (
    <div className="notif-bell" ref={wrapRef}>
      <button type="button" className="btn ghost notif-bell-btn" onClick={() => setOpen(!open)} title="Notifications">
        <span aria-hidden="true">Bell</span>
        {unread ? <span className="notif-badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="notif-menu">
          <div className="panel-head">
            <strong>Notifications</strong>
            <button className="btn ghost" type="button" onClick={() => { setOpen(false); navigate("/notifications"); }}>
              View all
            </button>
          </div>
          {items.length ? (
            <ul className="notif-menu-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => openItem(item)}>
                    <span className={`notif-dot priority-${item.priority}`} />
                    <span className="notif-menu-text">
                      <b>{item.subject || "(no subject)"}</b>
                      <i>{item.event_type || item.channel} · {timeAgo(item.created_at)}</i>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ padding: "10px 12px" }}>You are all caught up.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
