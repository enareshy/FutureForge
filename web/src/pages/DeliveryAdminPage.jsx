import React, { useEffect, useState } from "react";
import { delivery } from "../api.js";
import DeliveryOverviewPanel from "../components/DeliveryOverviewPanel.jsx";
import DeliveryRequestPanel from "../components/DeliveryRequestPanel.jsx";
import DeliveryProviderPanel from "../components/DeliveryProviderPanel.jsx";
import DeliverySchedulePanel from "../components/DeliverySchedulePanel.jsx";

const TABS = [
  ["overview", "Overview"],
  ["requests", "Requests"],
  ["providers", "Providers"],
  ["schedules", "Reminders & escalations"],
];

export default function DeliveryAdminPage() {
  const [tab, setTab] = useState("overview");
  const [meta, setMeta] = useState(null);
  const [allTenants, setAllTenants] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    delivery.meta().then(setMeta).catch((err) => setError(err.message));
  }, []);

  const scope = allTenants ? "all=true&" : "";

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Communication</div>
          <h1>Delivery services</h1>
          <div className="sub">Outbound queue, provider routing, retries, reminders, escalations, and operational monitoring.</div>
        </div>
        <label className="notif-check">
          <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
          <span>All tenants</span>
        </label>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {tab === "overview" ? <DeliveryOverviewPanel scope={scope} /> : null}
      {tab === "requests" ? <DeliveryRequestPanel meta={meta} scope={scope} /> : null}
      {tab === "providers" ? <DeliveryProviderPanel meta={meta} scope={scope} /> : null}
      {tab === "schedules" ? <DeliverySchedulePanel meta={meta} scope={scope} /> : null}
    </>
  );
}
