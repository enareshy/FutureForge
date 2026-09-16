import React, { useEffect, useState } from "react";
import { notifications } from "../api.js";
import NotificationTemplatePanel from "../components/NotificationTemplatePanel.jsx";
import NotificationRulePanel from "../components/NotificationRulePanel.jsx";
import NotificationProviderPanel from "../components/NotificationProviderPanel.jsx";
import NotificationMonitorPanel from "../components/NotificationMonitorPanel.jsx";

const TABS = [
  ["templates", "Templates"],
  ["rules", "Rules"],
  ["providers", "Providers"],
  ["monitor", "Delivery monitor"],
];

export default function NotificationAdminPage() {
  const [tab, setTab] = useState("templates");
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    notifications.meta().then(setMeta).catch(() => {});
  }, []);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Communication</div>
          <h1>Notification administration</h1>
          <div className="sub">Templates, rules, channel providers, and delivery monitoring.</div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {tab === "templates" ? <NotificationTemplatePanel meta={meta} /> : null}
      {tab === "rules" ? <NotificationRulePanel meta={meta} /> : null}
      {tab === "providers" ? <NotificationProviderPanel meta={meta} /> : null}
      {tab === "monitor" ? (
        <NotificationMonitorPanel
          meta={meta}
        />
      ) : null}
    </>
  );
}
