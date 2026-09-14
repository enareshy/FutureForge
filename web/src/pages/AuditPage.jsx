import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

export default function AuditPage() {
  const [q, setQ] = useState("");
  const [data, setData] = useState({ items: [], total: 0, page: 1, pageSize: 20 });
  const [error, setError] = useState("");

  function load(page = 1) {
    const qs = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q) qs.set("q", q);
    iam.audit(`?${qs}`).then(setData).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="topbar"><div><div className="brand">Security</div><h1>Audit log</h1></div></div>
      <div className="panel row">
        <label className="field grow"><span>Search</span><input value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn secondary" onClick={() => load(1)}>Search</button>
      </div>
      <div className="panel">
        {error ? <div className="error">{error}</div> : null}
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.created_at}</td>
                <td>{row.actor_username}</td>
                <td>{row.action}</td>
                <td className="mono">{row.resource_type} #{row.resource_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager"><span>{data.total} events</span></div>
      </div>
    </>
  );
}
