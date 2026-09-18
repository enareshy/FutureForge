import React, { useState } from "react";
import IntegrationOverviewPanel from "../components/integration/IntegrationOverviewPanel.jsx";
import IntegrationDefinitionsPanel from "../components/integration/IntegrationDefinitionsPanel.jsx";
import IntegrationSystemsPanel from "../components/integration/IntegrationSystemsPanel.jsx";
import IntegrationEventsPanel from "../components/integration/IntegrationEventsPanel.jsx";
import IntegrationWebhooksPanel from "../components/integration/IntegrationWebhooksPanel.jsx";
import IntegrationMessagesPanel from "../components/integration/IntegrationMessagesPanel.jsx";
import IntegrationDataPanel from "../components/integration/IntegrationDataPanel.jsx";
import IntegrationApiPanel from "../components/integration/IntegrationApiPanel.jsx";

const TABS = [
  ["overview", "Overview"],
  ["integrations", "Integrations"],
  ["systems", "Systems & security"],
  ["events", "Events"],
  ["webhooks", "Webhooks"],
  ["messages", "Messages"],
  ["data", "Data & mappings"],
  ["api", "API & access"],
];

export default function IntegrationPage() {
  const [tab, setTab] = useState("overview");

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Platform</div>
          <h1>Integration hub</h1>
          <div className="sub">
            Connect external systems, publish events, exchange messages and monitor every interface from one control plane.
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === "overview" ? <IntegrationOverviewPanel /> : null}
      {tab === "integrations" ? <IntegrationDefinitionsPanel /> : null}
      {tab === "systems" ? <IntegrationSystemsPanel /> : null}
      {tab === "events" ? <IntegrationEventsPanel /> : null}
      {tab === "webhooks" ? <IntegrationWebhooksPanel /> : null}
      {tab === "messages" ? <IntegrationMessagesPanel /> : null}
      {tab === "data" ? <IntegrationDataPanel /> : null}
      {tab === "api" ? <IntegrationApiPanel /> : null}
    </>
  );
}
