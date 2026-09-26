import React, { useCallback, useEffect, useState } from "react";
import { notifications } from "../api.js";
import NotificationDrawer from "../components/NotificationDrawer.jsx";
import NotificationPreferencesPanel from "../components/NotificationPreferencesPanel.jsx";

const TABS = [
  ["all", "All"],
  ["unread", "Unread"],
  ["tasks", "Tasks"],
  ["approvals", "Approvals"],
  ["system", "System"],
  ["archived", "Archived"],
  ["preferences", "Preferences"],
];

function fmt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function NotificationsPage() {
  const [tab, setTab] = useState("all");
  const [filters, setFilters] = useState({ q: "", channel: "", priority: "" });
  const [draft, setDraft] = useState({ q: "", channel: "", priority: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [unread, setUnread] = useState(0);
  const [meta, setMeta] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);

  const load = useCallback(async (targetPage = page) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: "25" });
      if (tab === "archived") params.set("archived", "true");
      else if (tab !== "all" && tab !== "preferences") params.set("tab", tab);
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      const res = await notifications.inbox(`?${params.toString()}`);
      setData(res);
      setDenied(false);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tab, filters, page]);

  const loadCount = useCallback(async () => {
    try {
      setUnread((await notifications.unreadCount()).unread || 0);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    if (tab === "preferences") return;
    load(page);
  }, [tab, filters, page, load]);

  useEffect(() => {
    loadCount();
    notifications.meta().then(setMeta).catch(() => {});
  }, [loadCount]);

  async function markRead(item) {
    try {
      const res = await notifications.markRead(item.id);
      setSelected((prev) => (prev && prev.id === item.id ? res : prev));
      setData((prev) => ({ ...prev, items: prev.items.map((n) => (n.id === item.id ? res : n)) }));
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  async function markUnread(item) {
    try {
      const res = await notifications.markUnread(item.id);
      setSelected((prev) => (prev && prev.id === item.id ? res : prev));
      setData((prev) => ({ ...prev, items: prev.items.map((n) => (n.id === item.id ? res : n)) }));
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  async function archive(item) {
    try {
      await notifications.archive(item.id);
      setSelected(null);
      load(page);
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(item) {
    try {
      await notifications.remove(item.id);
      setSelected(null);
      load(page);
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  async function markAllRead() {
    try {
      await notifications.markAllRead();
      load(page);
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  async function archiveAllRead() {
    try {
      await notifications.archiveAllRead();
      load(page);
      loadCount();
    } catch (err) {
      setError(err.message);
    }
  }

  function applyFilters(e) {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  }

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 25)));
  const channels = meta?.channels || [];
  const channelLabels = meta?.channel_labels || {};
  const priorities = meta?.priorities || ["low", "normal", "high", "urgent"];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Communication</div>
          <h1>Notifications</h1>
          <div className="sub">Your inbox, preferences, and delivery history.</div>
        </div>
        <div className="inline">
          <span className="badge">{unread} unread</span>
          <button className="btn secondary" type="button" onClick={markAllRead}>Mark all read</button>
          <button className="btn ghost" type="button" onClick={archiveAllRead}>Archive read</button>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => { setTab(key); setPage(1); }}>
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {denied ? (
        <div className="panel audit-empty">
          You do not have permission to view notifications. Ask an administrator for the notifications inbox permission.
        </div>
      ) : null}

      {!denied && tab === "preferences" ? <NotificationPreferencesPanel meta={meta} /> : null}

      {!denied && tab !== "preferences" ? (
        <>
          <form className="panel" onSubmit={applyFilters}>
            <div className="row">
              <label className="field grow"><span>Search</span>
                <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="subject, body, object…" />
              </label>
              <label className="field"><span>Channel</span>
                <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}>
                  <option value="">Any</option>
                  {channels.map((c) => <option key={c} value={c}>{channelLabels[c] || c}</option>)}
                </select>
              </label>
              <label className="field"><span>Priority</span>
                <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                  <option value="">Any</option>
                  {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Apply</button>
              <button className="btn ghost" type="button" onClick={() => { setDraft({ q: "", channel: "", priority: "" }); setFilters({ q: "", channel: "", priority: "" }); setPage(1); }}>Reset</button>
            </div>
          </form>

          <div className="panel">
            {loading && !data.items.length ? <div className="audit-empty">Loading notifications…</div> : null}
            <ul className="notif-list">
              {data.items.map((item) => (
                <li key={item.id} className={`notif-row ${item.read ? "read" : "unread"}`} onClick={() => setSelected(item)}>
                  <span className={`notif-dot priority-${item.priority}`} />
                  <div className="notif-row-body">
                    <div className="notif-row-top">
                      <b>{item.subject || "(no subject)"}</b>
                      {!item.read ? <span className="badge active">new</span> : null}
                      {item.archived_at ? <span className="badge">archived</span> : null}
                      <span className="audit-item-time">{fmt(item.created_at)}</span>
                    </div>
                    <div className="notif-row-sub">
                      <span className="chip">{item.event_type || item.channel}</span>
                      <span className="chip">{item.priority}</span>
                      {item.object_name ? <span className="muted">{item.object_type} · {item.object_name}</span> : null}
                      {item.correlation_id ? <span className="mono">{item.correlation_id}</span> : null}
                    </div>
                  </div>
                  <div className="notif-row-actions" onClick={(e) => e.stopPropagation()}>
                    {item.read ? (
                      <button className="btn ghost" type="button" onClick={() => markUnread(item)}>Unread</button>
                    ) : (
                      <button className="btn ghost" type="button" onClick={() => markRead(item)}>Read</button>
                    )}
                    <button className="btn ghost" type="button" onClick={() => archive(item)}>Archive</button>
                  </div>
                </li>
              ))}
              {!data.items.length && !loading ? <li className="audit-empty">No notifications match this view.</li> : null}
            </ul>
            {data.total > data.pageSize ? (
              <div className="pager">
                <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span>Page {page} of {totalPages} · {data.total} notifications</span>
                <button className="btn ghost" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            ) : (
              <div className="pager"><span>{data.total} notifications</span></div>
            )}
          </div>
        </>
      ) : null}

      {selected ? (
        <NotificationDrawer
          notification={selected}
          onClose={() => setSelected(null)}
          onRead={markRead}
          onUnread={markUnread}
          onArchive={archive}
          onDelete={remove}
        />
      ) : null}
    </>
  );
}
