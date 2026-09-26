import React, { useEffect, useState } from "react";
import { change } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "requests", label: "Change requests (ECR)" },
  { key: "orders", label: "Change orders (ECO)" },
  { key: "notices", label: "Change notices (ECN)" },
  { key: "configuration", label: "Configuration" },
];

const emptyRequest = { title: "", category: "OTHER", priority: "NORMAL", description: "", reason: "" };
const emptyOrder = { title: "", description: "", effective_strategy: "DATE" };
const emptyAffectedItem = { object_type: "pdm_item", object_id: "", disposition: "NEW_REVISION", notes: "" };
const emptyNotice = { change_order_id: "", title: "", distribution: "" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["RELEASED", "APPROVED", "ISSUED", "ACKNOWLEDGED", "PROMOTED"].includes(status)) return "ok";
  if (["DRAFT", "SUBMITTED", "SCREENING", "IN_REVIEW"].includes(status)) return "warn";
  if (["REJECTED", "WITHDRAWN", "CANCELLED"].includes(status)) return "danger";
  return undefined;
}

export default function ChangeManagementPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [configuration, setConfiguration] = useState({});
  const [requests, setRequests] = useState([]);
  const [orders, setOrders] = useState([]);
  const [notices, setNotices] = useState([]);

  const [requestForm, setRequestForm] = useState(emptyRequest);
  const [orderForm, setOrderForm] = useState(emptyOrder);
  const [noticeForm, setNoticeForm] = useState(emptyNotice);
  const [affectedForm, setAffectedForm] = useState(emptyAffectedItem);

  const [selectedOrder, setSelectedOrder] = useState("");
  const [affectedItems, setAffectedItems] = useState([]);
  const [impactQuery, setImpactQuery] = useState({ object_type: "pdm_item", object_id: "" });
  const [impactResult, setImpactResult] = useState(null);
  const [history, setHistory] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, h, cfg, rq, ord, nt] = await Promise.all([
        change.meta(),
        change.health(),
        change.configuration(),
        change.requests("?page_size=100"),
        change.orders("?page_size=100"),
        change.notices("?page_size=100"),
      ]);
      setMeta(met);
      setHealth(h);
      setConfiguration(cfg || {});
      setRequests(rq.items || []);
      setOrders(ord.items || []);
      setNotices(nt.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function bind(setter, form) {
    return (event) => setter({ ...form, [event.target.name]: event.target.value });
  }

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (message) setNotice(message);
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const selectedOrderRow = orders.find((entry) => String(entry.id) === String(selectedOrder));

  useEffect(() => {
    if (!selectedOrderRow) {
      setAffectedItems([]);
      return;
    }
    run(async () => {
      const result = await change.affectedItems(selectedOrderRow.order_ref);
      setAffectedItems(result.items || []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder]);

  async function seedDemo() {
    await run(() => change.seed(), "Demonstration ECR -> ECO -> ECN chain seeded.");
    await refresh();
  }

  async function createRequest() {
    const result = await run(() => change.createRequest(requestForm), "Change request created.");
    if (result) {
      setRequestForm(emptyRequest);
      await refresh();
    }
  }

  async function submitRequest(entry) {
    await run(() => change.submitRequest(entry.request_ref), `${entry.request_number} submitted.`);
    await refresh();
  }

  async function withdrawRequest(entry) {
    await run(() => change.withdrawRequest(entry.request_ref), `${entry.request_number} withdrawn.`);
    await refresh();
  }

  async function screenRequest(entry, decision) {
    await run(() => change.screenRequest(entry.request_ref, decision, decision === "APPROVED" ? "CCB approves." : "CCB rejects."), `${entry.request_number} ${decision.toLowerCase()}.`);
    await refresh();
  }

  async function promoteRequest(entry) {
    const result = await run(
      () => change.promoteRequest(entry.request_ref, { title: `ECO: ${entry.title}`, description: entry.description }),
      `${entry.request_number} promoted to a change order.`
    );
    if (result) {
      await refresh();
      setSelectedOrder(String(result.order.id));
      setTab("orders");
    }
  }

  async function createOrder() {
    const result = await run(() => change.createOrder(orderForm), "Change order created.");
    if (result) {
      setOrderForm(emptyOrder);
      await refresh();
      setSelectedOrder(String(result.id));
    }
  }

  async function submitOrder(entry) {
    await run(() => change.submitOrder(entry.order_ref), `${entry.order_number} submitted for CCB approval.`);
    await refresh();
  }

  async function decideOrder(entry, decision) {
    await run(() => change.decideOrder(entry.order_ref, decision), `${entry.order_number} ${decision.toLowerCase()}.`);
    await refresh();
  }

  async function releaseOrder(entry) {
    const result = await run(() => change.releaseOrder(entry.order_ref), `${entry.order_number} released.`);
    if (result) await refresh();
  }

  async function cancelOrder(entry) {
    await run(() => change.cancelOrder(entry.order_ref), `${entry.order_number} cancelled.`);
    await refresh();
  }

  async function addAffectedItem() {
    if (!selectedOrderRow || !affectedForm.object_id) return;
    await run(() => change.addAffectedItem(selectedOrderRow.order_ref, affectedForm), "Affected item added.");
    setAffectedForm(emptyAffectedItem);
    const result = await change.affectedItems(selectedOrderRow.order_ref);
    setAffectedItems(result.items || []);
  }

  async function removeAffectedItem(item) {
    if (!selectedOrderRow) return;
    await run(() => change.removeAffectedItem(selectedOrderRow.order_ref, item.id), "Affected item removed.");
    const result = await change.affectedItems(selectedOrderRow.order_ref);
    setAffectedItems(result.items || []);
  }

  async function runImpact() {
    if (!impactQuery.object_id) return;
    const result = await run(() => change.impact(`?objectType=${encodeURIComponent(impactQuery.object_type)}&objectId=${encodeURIComponent(impactQuery.object_id)}`));
    setImpactResult(result);
  }

  async function loadOrderHistory(entry) {
    const result = await run(() => change.orderHistory(entry.order_ref));
    setHistory(result?.items || []);
  }

  const releasedOrders = orders.filter((entry) => entry.status === "RELEASED");

  async function createNotice() {
    if (!noticeForm.change_order_id) return;
    const order = orders.find((entry) => String(entry.id) === String(noticeForm.change_order_id));
    const distribution = noticeForm.distribution.split(",").map((v) => v.trim()).filter(Boolean);
    const result = await run(
      () => change.createNotice({ change_order_id: Number(noticeForm.change_order_id), title: noticeForm.title || `Notice: ${order?.title || ""}`, distribution }),
      "Change notice created."
    );
    if (result) {
      setNoticeForm(emptyNotice);
      await refresh();
    }
  }

  async function issueNotice(entry) {
    await run(() => change.issueNotice(entry.notice_ref), `${entry.notice_number} issued.`);
    await refresh();
  }

  async function acknowledgeNotice(entry) {
    await run(() => change.acknowledgeNotice(entry.notice_ref), `${entry.notice_number} acknowledged.`);
    await refresh();
  }

  async function saveConfig(key, value) {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    await run(() => change.setConfiguration(key, parsed), `Configuration ${key} updated.`);
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Change management</h1>
          <p className="subtle">Engineering change control: Change Request (ECR) → Change Order (ECO) → Change Notice (ECN). Release creates a real effectivity assignment and a frozen baseline for every affected item, via the platform's Versioning kernel.</p>
        </div>
        <div className="stack-row">
          {meta?.source_module ? <Badge tone="ok">{meta.source_module}</Badge> : null}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} className={`tab${tab === entry.key ? " active" : ""}`} onClick={() => setTab(entry.key)}>{entry.label}</button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            <div className="panel grow"><h3>Requests</h3><div className="mono">{health?.counts?.requests ?? "-"}</div></div>
            <div className="panel grow"><h3>Orders</h3><div className="mono">{health?.counts?.orders ?? "-"}</div></div>
            <div className="panel grow"><h3>Notices</h3><div className="mono">{health?.counts?.notices ?? "-"}</div></div>
            <div className="panel grow"><h3>Affected items</h3><div className="mono">{health?.counts?.affected_items ?? "-"}</div></div>
          </div>

          <div className="panel">
            <div className="stack-row" style={{ justifyContent: "space-between" }}>
              <h3>Demonstration data</h3>
              <button className="btn secondary" disabled={busy} onClick={seedDemo}>Seed ECR → ECO → ECN chain</button>
            </div>
            <p className="subtle">Installs a full example: a seal-leakage ECR, screened and promoted to an ECO against the seeded DEMO-PUMP-ASSY product, an affected item, approval and release (creating a real effectivity + frozen baseline), and an issued ECN.</p>
          </div>

          <div className="panel">
            <h3>Recent orders</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Status</th><th>Baseline</th><th></th></tr></thead>
              <tbody>
                {orders.slice(0, 8).map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.order_number}</td>
                    <td>{entry.title}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.baseline_id ?? "-"}</td>
                    <td><button className="btn ghost" onClick={() => { setSelectedOrder(String(entry.id)); setTab("orders"); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "requests" ? (
        <>
          <div className="panel">
            <h3>Create a change request (ECR)</h3>
            <div className="grid">
              <label className="field"><span>Title</span><input name="title" value={requestForm.title} onChange={bind(setRequestForm, requestForm)} /></label>
              <label className="field"><span>Category</span>
                <select name="category" value={requestForm.category} onChange={bind(setRequestForm, requestForm)}>
                  {(meta?.vocabulary?.request_categories || ["DESIGN", "PROCESS", "DOCUMENTATION", "SUPPLIER", "QUALITY", "OTHER"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field"><span>Priority</span>
                <select name="priority" value={requestForm.priority} onChange={bind(setRequestForm, requestForm)}>
                  {(meta?.vocabulary?.request_priorities || ["LOW", "NORMAL", "HIGH", "URGENT"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Description</span><input name="description" value={requestForm.description} onChange={bind(setRequestForm, requestForm)} /></label>
              <label className="field grow"><span>Reason</span><input name="reason" value={requestForm.reason} onChange={bind(setRequestForm, requestForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !requestForm.title} onClick={createRequest}>Create</button>
          </div>

          <div className="panel">
            <h3>Change requests ({requests.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Category</th><th>Priority</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {requests.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.request_number}</td>
                    <td>{entry.title}</td>
                    <td className="mono">{entry.category}</td>
                    <td className="mono">{entry.priority}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      {entry.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => submitRequest(entry)}>Submit</button> : null}
                      {["SUBMITTED", "SCREENING"].includes(entry.status) ? (
                        <>
                          <button className="btn ghost" disabled={busy} onClick={() => screenRequest(entry, "APPROVED")}>CCB approve</button>
                          <button className="btn ghost" disabled={busy} onClick={() => screenRequest(entry, "REJECTED")}>CCB reject</button>
                        </>
                      ) : null}
                      {entry.status === "APPROVED" ? <button className="btn" disabled={busy} onClick={() => promoteRequest(entry)}>Promote to ECO</button> : null}
                      {!["REJECTED", "WITHDRAWN", "PROMOTED"].includes(entry.status) ? <button className="btn ghost" disabled={busy} onClick={() => withdrawRequest(entry)}>Withdraw</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "orders" ? (
        <>
          <div className="panel">
            <h3>Create a change order (ECO)</h3>
            <div className="grid">
              <label className="field"><span>Title</span><input name="title" value={orderForm.title} onChange={bind(setOrderForm, orderForm)} /></label>
              <label className="field"><span>Effective strategy</span>
                <select name="effective_strategy" value={orderForm.effective_strategy} onChange={bind(setOrderForm, orderForm)}>
                  {(meta?.vocabulary?.effective_strategies || ["DATE", "IMMEDIATE", "SERIAL"]).map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label className="field grow"><span>Description</span><input name="description" value={orderForm.description} onChange={bind(setOrderForm, orderForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !orderForm.title} onClick={createOrder}>Create</button>
          </div>

          <div className="panel">
            <h3>Change orders ({orders.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Status</th><th>Baseline</th><th></th></tr></thead>
              <tbody>
                {orders.map((entry) => (
                  <tr key={entry.id} className={String(entry.id) === String(selectedOrder) ? "selected" : ""}>
                    <td className="mono">{entry.order_number}</td>
                    <td>{entry.title}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="mono">{entry.baseline_id ?? "-"}</td>
                    <td className="stack-row">
                      <button className="btn ghost" onClick={() => setSelectedOrder(String(entry.id))}>Select</button>
                      {entry.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => submitOrder(entry)}>Submit</button> : null}
                      {entry.status === "IN_REVIEW" ? (
                        <>
                          <button className="btn ghost" disabled={busy} onClick={() => decideOrder(entry, "APPROVED")}>CCB approve</button>
                          <button className="btn ghost" disabled={busy} onClick={() => decideOrder(entry, "REJECTED")}>CCB reject</button>
                        </>
                      ) : null}
                      {entry.status === "APPROVED" ? <button className="btn" disabled={busy} onClick={() => releaseOrder(entry)}>Release</button> : null}
                      {!["RELEASED", "CANCELLED"].includes(entry.status) ? <button className="btn ghost" disabled={busy} onClick={() => cancelOrder(entry)}>Cancel</button> : null}
                      <button className="btn ghost" onClick={() => loadOrderHistory(entry)}>History</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedOrderRow ? (
            <div className="panel">
              <h3>{selectedOrderRow.order_number} — affected items ({affectedItems.length})</h3>
              <div className="grid">
                <label className="field"><span>Object type</span><input name="object_type" value={affectedForm.object_type} onChange={bind(setAffectedForm, affectedForm)} /></label>
                <label className="field"><span>Object id</span><input name="object_id" value={affectedForm.object_id} onChange={bind(setAffectedForm, affectedForm)} placeholder="DEMO-SEAL-004" /></label>
                <label className="field"><span>Disposition</span>
                  <select name="disposition" value={affectedForm.disposition} onChange={bind(setAffectedForm, affectedForm)}>
                    {(meta?.vocabulary?.affected_item_dispositions || ["NEW_REVISION", "OBSOLETE", "NO_CHANGE", "SUPERSEDED"]).map((v) => <option key={v}>{v}</option>)}
                  </select>
                </label>
                <label className="field grow"><span>Notes</span><input name="notes" value={affectedForm.notes} onChange={bind(setAffectedForm, affectedForm)} /></label>
              </div>
              <button className="btn" disabled={busy || selectedOrderRow.status !== "DRAFT" && selectedOrderRow.status !== "IN_REVIEW" || !affectedForm.object_id} onClick={addAffectedItem}>Add affected item</button>

              <table className="table">
                <thead><tr><th>Object type</th><th>Object id</th><th>Disposition</th><th>Effectivity</th><th></th></tr></thead>
                <tbody>
                  {affectedItems.map((item) => (
                    <tr key={item.id}>
                      <td className="mono">{item.object_type}</td>
                      <td className="mono">{item.object_id}</td>
                      <td className="mono">{item.disposition}</td>
                      <td className="mono">{item.effectivity_assignment_id ? `assignment #${item.effectivity_assignment_id}` : "-"}</td>
                      <td><button className="btn ghost" disabled={busy || !["DRAFT", "IN_REVIEW"].includes(selectedOrderRow.status)} onClick={() => removeAffectedItem(item)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>Impact suggestion (BOM where-used)</h4>
              <div className="stack-row">
                <label className="field"><span>Object type</span><input value={impactQuery.object_type} onChange={(e) => setImpactQuery({ ...impactQuery, object_type: e.target.value })} /></label>
                <label className="field grow"><span>Object id</span><input value={impactQuery.object_id} onChange={(e) => setImpactQuery({ ...impactQuery, object_id: e.target.value })} placeholder="DEMO-SEAL-004" /></label>
                <button className="btn secondary" disabled={busy || !impactQuery.object_id} onClick={runImpact}>Find affected assemblies</button>
              </div>
              {impactResult ? (
                <ul>
                  {(impactResult.items || impactResult.nodes || []).length === 0 ? <li className="subtle">No consuming assemblies found (or impact analysis unavailable for this object type).</li> : null}
                  {(impactResult.items || impactResult.nodes || []).map((node, idx) => (
                    <li key={idx} className="mono">{JSON.stringify(node)}</li>
                  ))}
                </ul>
              ) : null}

              {history ? (
                <>
                  <h4>History</h4>
                  <table className="table">
                    <thead><tr><th>Action</th><th>Status</th><th>When</th></tr></thead>
                    <tbody>
                      {history.map((entry) => (
                        <tr key={entry.id}>
                          <td className="mono">{entry.action}</td>
                          <td className="mono">{entry.status}</td>
                          <td className="subtle">{entry.created_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "notices" ? (
        <>
          <div className="panel">
            <h3>Issue a change notice (ECN)</h3>
            <p className="subtle">Only released change orders can have a notice.</p>
            <div className="grid">
              <label className="field"><span>Change order</span>
                <select name="change_order_id" value={noticeForm.change_order_id} onChange={bind(setNoticeForm, noticeForm)}>
                  <option value="">Select a released order…</option>
                  {releasedOrders.map((entry) => <option key={entry.id} value={entry.id}>{entry.order_number} — {entry.title}</option>)}
                </select>
              </label>
              <label className="field"><span>Title (optional)</span><input name="title" value={noticeForm.title} onChange={bind(setNoticeForm, noticeForm)} /></label>
              <label className="field grow"><span>Distribution (comma-separated)</span><input name="distribution" value={noticeForm.distribution} onChange={bind(setNoticeForm, noticeForm)} placeholder="engineering, manufacturing, quality" /></label>
            </div>
            <button className="btn" disabled={busy || !noticeForm.change_order_id} onClick={createNotice}>Create</button>
          </div>

          <div className="panel">
            <h3>Change notices ({notices.length})</h3>
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Order</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {notices.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.notice_number}</td>
                    <td>{entry.title}</td>
                    <td className="mono">{orders.find((o) => o.id === entry.change_order_id)?.order_number || entry.change_order_id}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      {entry.status === "DRAFT" ? <button className="btn ghost" disabled={busy} onClick={() => issueNotice(entry)}>Issue</button> : null}
                      {entry.status === "ISSUED" ? <button className="btn ghost" disabled={busy} onClick={() => acknowledgeNotice(entry)}>Acknowledge</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Domain configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td><input defaultValue={typeof value === "object" ? JSON.stringify(value) : String(value)} onBlur={(event) => saveConfig(key, event.target.value)} /></td>
                  <td className="subtle">edit to update</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
