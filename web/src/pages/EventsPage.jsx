import React, { useState } from "react";
import {
  EventsOverviewPanel,
  EventRegistryPanel,
  EventSubscriptionsPanel,
  EventDeliveriesPanel,
  EventDeadLetterPanel,
  EventReplayPanel,
  EventRetentionPanel,
  EventTopologyPanel,
} from "../components/events/EventsPanels.jsx";

const TABS = [
  ["overview", "Overview"],
  ["registry", "Event registry"],
  ["subscriptions", "Subscriptions"],
  ["deliveries", "Deliveries"],
  ["deadletters", "Dead letters"],
  ["replay", "Replay"],
  ["retention", "Retention"],
  ["topology", "Topics & queues"],
];

export default function EventsPage() {
  const [tab, setTab] = useState("overview");

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Platform</div>
          <h1>Event & messaging framework</h1>
          <div className="sub">
            Publish, route and consume platform events with schema governance, delivery guarantees, replay and end-to-end traceability.
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === "overview" ? <EventsOverviewPanel /> : null}
      {tab === "registry" ? <EventRegistryPanel /> : null}
      {tab === "subscriptions" ? <EventSubscriptionsPanel /> : null}
      {tab === "deliveries" ? <EventDeliveriesPanel /> : null}
      {tab === "deadletters" ? <EventDeadLetterPanel /> : null}
      {tab === "replay" ? <EventReplayPanel /> : null}
      {tab === "retention" ? <EventRetentionPanel /> : null}
      {tab === "topology" ? <EventTopologyPanel /> : null}
    </>
  );
}
