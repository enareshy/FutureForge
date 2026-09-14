import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

export default function SessionsPage() {
  const [mine, setMine] = useState([]);
  const [admin, setAdmin] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const [s, a] = await Promise.all([
      iam.mySessions(),
      iam.adminSessions("?pageSize=50&active=1").catch(() => null),
    ]);
    setMine(s.items || []);
    setAdmin(a);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function act(fn) {
    setError("");
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Security</div>
          <h1>Sessions</h1>
          <p className="sub">Opaque bearer tokens. APIs expose public_id only — the token is never listed.</p>
        </div>
        <button className="btn secondary" onClick={() => act(() => iam.revokeAllSessions())}>Revoke other sessions</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel">
        <h3>This account</h3>
        <table>
          <thead><tr><th>Id</th><th>Provider</th><th>MFA</th><th>IP</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {mine.map((s) => (
              <tr key={s.public_id}>
                <td className="mono">{s.public_id}</td>
                <td>{s.provider_code}</td>
                <td>{s.mfa_verified ? "yes" : "no"}</td>
                <td className="mono">{s.ip || "—"}</td>
                <td className="mono">{s.expires_at}</td>
                <td><button className="btn ghost" onClick={() => act(() => iam.revokeSession(s.public_id))}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admin ? (
        <div className="panel">
          <h3>All sessions</h3>
          <table>
            <thead><tr><th>Id</th><th>User</th><th>Provider</th><th>IP</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {(admin.items || []).map((s) => (
                <tr key={s.public_id}>
                  <td className="mono">{s.public_id}</td>
                  <td className="mono">{s.user_id}</td>
                  <td>{s.provider_code}</td>
                  <td className="mono">{s.ip || "—"}</td>
                  <td className="mono">{s.expires_at}</td>
                  <td><button className="btn ghost" onClick={() => act(() => iam.adminRevokeSession(s.public_id))}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
