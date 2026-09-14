import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

function emptyLevel() {
  return { code: "", name: "", sort_order: 80, allow_root: 0, collection: "", active: 1, description: "" };
}

function parentsOf(level, allowedParents) {
  return allowedParents[level.code] || [];
}

export default function PlatformPage() {
  const [hierarchy, setHierarchy] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    const [h, s] = await Promise.all([iam.platformHierarchy(), iam.platformSettings()]);
    setHierarchy(h);
    setSettings(s);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  function setLevel(i, patch) {
    const levels = hierarchy.levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    const allowedParents = { ...hierarchy.allowedParents };
    if (patch.code && patch.code !== hierarchy.levels[i].code) {
      allowedParents[patch.code] = allowedParents[hierarchy.levels[i].code] || [];
      delete allowedParents[hierarchy.levels[i].code];
    }
    setHierarchy({ ...hierarchy, levels, allowedParents });
  }

  function toggleParent(child, parent, on) {
    const current = new Set((hierarchy.allowedParents[child] || []).map((p) => (p === null ? null : p)));
    if (on) current.add(parent);
    else current.delete(parent);
    setHierarchy({
      ...hierarchy,
      allowedParents: { ...hierarchy.allowedParents, [child]: [...current] },
    });
  }

  async function saveHierarchy(e) {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const next = await iam.updatePlatformHierarchy({
        levels: hierarchy.levels,
        allowedParents: hierarchy.allowedParents,
      });
      setHierarchy(next);
      setSaved("Hierarchy saved.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const next = await iam.updatePlatformSettings({ values: settings.values });
      setSettings(next);
      setSaved("Feature properties saved.");
    } catch (err) {
      setError(err.message);
    }
  }

  if (!hierarchy || !settings) return error ? <div className="error">{error}</div> : null;
  const codes = hierarchy.levels.map((l) => l.code);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Super Admin</div>
          <h1>Platform properties</h1>
          <p className="sub">Change Organization &amp; Site Structure and other feature properties. Operators follow this definition.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {saved ? <p className="sub">{saved}</p> : null}

      <form className="panel" onSubmit={saveHierarchy}>
        <h3>Organization &amp; site hierarchy</h3>
        <p className="mono">{hierarchy.path || "No active levels"}</p>
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Order</th><th>Root</th><th>API collection</th><th>Active</th></tr>
          </thead>
          <tbody>
            {hierarchy.levels.map((level, i) => (
              <tr key={`${level.code}-${i}`}>
                <td><input value={level.code} onChange={(e) => setLevel(i, { code: e.target.value })} /></td>
                <td><input value={level.name} onChange={(e) => setLevel(i, { name: e.target.value })} /></td>
                <td><input type="number" value={level.sort_order} onChange={(e) => setLevel(i, { sort_order: Number(e.target.value) })} /></td>
                <td><input type="checkbox" checked={!!level.allow_root} onChange={(e) => setLevel(i, { allow_root: e.target.checked ? 1 : 0 })} /></td>
                <td><input value={level.collection || ""} onChange={(e) => setLevel(i, { collection: e.target.value })} /></td>
                <td><input type="checkbox" checked={!!level.active} onChange={(e) => setLevel(i, { active: e.target.checked ? 1 : 0 })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn secondary" style={{ marginTop: 12 }} onClick={() => setHierarchy({
          ...hierarchy,
          levels: [...hierarchy.levels, emptyLevel()],
          allowedParents: { ...hierarchy.allowedParents, "": [null] },
        })}>Add level</button>

        <h3 style={{ marginTop: 24 }}>Allowed parents</h3>
        <div className="matrix">
          <table>
            <thead>
              <tr>
                <th>Child</th>
                <th>Root</th>
                {codes.map((c) => <th key={c} className="action">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {hierarchy.levels.map((level) => {
                const parents = parentsOf(level, hierarchy.allowedParents);
                return (
                  <tr key={`rule-${level.code}`}>
                    <td className="mono">{level.code || "(new)"}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={parents.includes(null)}
                        onChange={(e) => toggleParent(level.code, null, e.target.checked)}
                      />
                    </td>
                    {codes.map((c) => (
                      <td key={`${level.code}-${c}`}>
                        <input
                          type="checkbox"
                          checked={parents.includes(c)}
                          onChange={(e) => toggleParent(level.code, c, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button className="btn" style={{ marginTop: 16 }}>Save hierarchy</button>
      </form>

      <form className="panel" onSubmit={saveSettings} style={{ maxWidth: 560 }}>
        <h3>Other feature properties</h3>
        {settings.items.map((item) => (
          <label className="field" key={item.key}>
            <span>{item.key} — {item.description}</span>
            {item.key === "org.allow_multi_site" ? (
              <input
                type="checkbox"
                checked={!!settings.values[item.key]}
                onChange={(e) => setSettings({
                  ...settings,
                  values: { ...settings.values, [item.key]: e.target.checked },
                })}
              />
            ) : (
              <input
                type="number"
                value={settings.values[item.key]}
                onChange={(e) => setSettings({
                  ...settings,
                  values: { ...settings.values, [item.key]: e.target.value },
                })}
              />
            )}
          </label>
        ))}
        <button className="btn">Save properties</button>
      </form>
    </>
  );
}
