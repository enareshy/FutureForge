import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

export default function PolicyPage() {
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { iam.policy().then(setForm).catch((e) => setError(e.message)); }, []);

  function num(key) {
    return (e) => setForm({ ...form, [key]: Number(e.target.value) });
  }
  function flag(key) {
    return (e) => setForm({ ...form, [key]: e.target.checked ? 1 : 0 });
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    setSaved(false);
    try {
      const next = await iam.updatePolicy(form);
      setForm(next);
      setSaved(true);
    } catch (err) { setError(err.message); }
  }

  if (!form) return error ? <div className="error">{error}</div> : null;

  return (
    <>
      <div className="topbar"><div><div className="brand">Security</div><h1>Password policy</h1></div></div>
      <form className="panel" onSubmit={save} style={{ maxWidth: 560 }}>
        {error ? <div className="error">{error}</div> : null}
        {saved ? <p className="sub">Policy updated.</p> : null}
        {[
          ["min_length", "Minimum length"],
          ["max_age_days", "Max age (days)"],
          ["history_count", "History count"],
          ["lockout_threshold", "Lockout threshold"],
          ["lockout_minutes", "Lockout minutes"],
        ].map(([k, label]) => (
          <label className="field" key={k}><span>{label}</span><input type="number" value={form[k]} onChange={num(k)} /></label>
        ))}
        {[
          ["require_uppercase", "Require uppercase"],
          ["require_lowercase", "Require lowercase"],
          ["require_digit", "Require digit"],
          ["require_special", "Require special"],
        ].map(([k, label]) => (
          <label className="field" key={k} style={{ flexDirection: "row", alignItems: "center" }}>
            <input type="checkbox" checked={!!form[k]} onChange={flag(k)} />
            <span>{label}</span>
          </label>
        ))}
        <button className="btn">Save policy</button>
      </form>
    </>
  );
}
