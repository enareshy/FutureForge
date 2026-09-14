import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { iam } from "../api.js";

const empty = { username: "", email: "", employee_id: "", display_name: "", password: "", organization_id: "" };

export default function UsersPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, page: 1, pageSize: 20 });
  const [orgs, setOrgs] = useState([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");

  function load(nextPage = page) {
    const qs = new URLSearchParams({ page: String(nextPage), pageSize: "20" });
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    iam.users(`?${qs}`).then(setData).catch((e) => setError(e.message));
  }

  useEffect(() => { iam.orgs("?pageSize=100").then((r) => setOrgs(r.items)).catch(() => {}); }, []);
  useEffect(() => { load(1); }, [status]);

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      await iam.createUser({
        ...form,
        organization_id: form.organization_id ? Number(form.organization_id) : null,
      });
      setForm(empty);
      load(1);
    } catch (err) {
      setError(err.message + (err.details ? `: ${err.details.join(", ")}` : ""));
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Directory</div>
          <h1>Users</h1>
        </div>
      </div>
      <div className="panel">
        <div className="row">
          <label className="field grow">
            <span>Search</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="username, email, employee ID" />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="locked">Locked</option>
            </select>
          </label>
          <button className="btn secondary" onClick={() => { setPage(1); load(1); }}>Search</button>
        </div>
      </div>
      <div className="split">
        <div className="panel">
          {error ? <div className="error">{error}</div> : null}
          <table>
            <thead>
              <tr><th>Username</th><th>Employee</th><th>Email</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td><Link to={`/users/${u.id}`}>{u.username}</Link><div className="mono">{u.display_name}</div></td>
                  <td>{u.employee_id}</td>
                  <td>{u.email}</td>
                  <td><span className={`badge ${u.status}`}>{u.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span>{data.total} users</span>
            <button className="btn ghost" disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); load(p); }}>Prev</button>
            <button className="btn ghost" disabled={page * data.pageSize >= data.total} onClick={() => { const p = page + 1; setPage(p); load(p); }}>Next</button>
          </div>
        </div>
        <form className="panel" onSubmit={create}>
          <h3>Create user</h3>
          {["username", "email", "employee_id", "display_name", "password"].map((k) => (
            <label className="field" key={k}>
              <span>{k.replace("_", " ")}</span>
              <input type={k === "password" ? "password" : "text"} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required />
            </label>
          ))}
          <label className="field">
            <span>Organization</span>
            <select value={form.organization_id} onChange={(e) => setForm({ ...form, organization_id: e.target.value })}>
              <option value="">None</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <button className="btn">Create</button>
        </form>
      </div>
    </>
  );
}
