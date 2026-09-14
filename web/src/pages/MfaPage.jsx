import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

export default function MfaPage() {
  const [status, setStatus] = useState(null);
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    setStatus(await iam.mfaStatus());
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function startEnroll() {
    setError("");
    try {
      setEnroll(await iam.mfaEnroll());
      setRecovery([]);
    } catch (e) { setError(e.message); }
  }

  async function confirm() {
    setError("");
    try {
      const res = await iam.mfaVerifyEnroll(code);
      setRecovery(res.recoveryCodes || []);
      setEnroll(null);
      setCode("");
      await load();
    } catch (e) { setError(e.message); }
  }

  async function disable() {
    setError("");
    try {
      await iam.mfaDisable({ code });
      setCode("");
      setRecovery([]);
      await load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Security</div>
          <h1>Multi-factor authentication</h1>
          <p className="sub">TOTP authenticators and hashed recovery codes. Secrets are shown once.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {status ? (
        <div className="panel">
          <p>Platform MFA required: <b>{status.required ? "yes" : "no"}</b></p>
          <p>Enrolled: <b>{status.enrolled ? "yes" : "no"}</b> · Recovery codes remaining: {status.recoveryCodesRemaining}</p>
          {!status.enrolled ? <button className="btn" onClick={startEnroll}>Enroll authenticator</button> : null}
        </div>
      ) : null}
      {enroll ? (
        <div className="panel">
          <h3>Scan or enter secret</h3>
          <p className="mono">{enroll.secret}</p>
          <p className="mono">{enroll.otpauth}</p>
          <label className="field"><span>Code from authenticator</span><input value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn" onClick={confirm}>Verify and enable</button>
        </div>
      ) : null}
      {recovery.length ? (
        <div className="panel">
          <h3>Recovery codes (store offline)</h3>
          {recovery.map((c) => <div className="mono" key={c}>{c}</div>)}
        </div>
      ) : null}
      {status?.enrolled ? (
        <div className="panel" style={{ maxWidth: 480 }}>
          <h3>Disable MFA</h3>
          <label className="field"><span>Authenticator code</span><input value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn danger" onClick={disable}>Disable</button>
        </div>
      ) : null}
    </>
  );
}
