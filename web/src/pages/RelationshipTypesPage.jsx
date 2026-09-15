import React, { useCallback, useEffect, useState } from "react";
import { objects } from "../api.js";

const CARDINALITIES = ["1:1", "1:N", "N:1", "N:N"];
const SEMANTICS = ["association", "aggregation", "composition"];
const STATUSES = ["draft", "active", "inactive"];

export default function RelationshipTypesPage() {
  const [types, setTypes] = useState([]);
  const [objectTypes, setObjectTypes] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    module: "",
    source_type_id: "",
    target_type_id: "",
    cardinality: "N:N",
    semantic: "association",
    cascade_delete: false,
    status: "active",
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [rt, ot] = await Promise.all([objects.relationshipTypes("?pageSize=200"), objects.types()]);
    setItems(rt.items || []);
    setObjectTypes(ot.items || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function create(e) {
    e.preventDefault();
    setError("");
    try {
      const payload = { ...form };
      if (!payload.source_type_id) delete payload.source_type_id;
      if (!payload.target_type_id) delete payload.target_type_id;
      await objects.createRelationshipType(payload);
      setNotice(`Relationship type ${form.code} created.`);
      setForm({
        code: "",
        name: "",
        description: "",
        module: "",
        source_type_id: "",
        target_type_id: "",
        cardinality: "N:N",
        semantic: "association",
        cascade_delete: false,
        status: "active",
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function changeStatus(rt, status) {
    setError("");
    try {
      await objects.setRelationshipTypeStatus(rt.id, status);
      setNotice(`Relationship type ${rt.code} set to ${status}.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(rt) {
    setError("");
    try {
      await objects.deleteRelationshipType(rt.id);
      setNotice(`Relationship type ${rt.code} deleted.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Object &amp; Relationship Framework</div>
          <h1>Relationship types</h1>
          <p className="sub">
            Typed edges between object types with cardinality, ownership semantics and optional cascading delete. Types
            in use by existing relationships cannot be deleted.
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <p className="sub valid">{notice}</p> : null}

      <form className="panel" onSubmit={create}>
        <div className="panel-head">
          <h3>Create relationship type</h3>
        </div>
        <div className="row">
          <label className="field grow">
            <span>Code</span>
            <input value={form.code} onChange={(e) => set("code", e.target.value)} required />
          </label>
          <label className="field grow">
            <span>Name</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </label>
          <label className="field grow">
            <span>Module</span>
            <input value={form.module} onChange={(e) => set("module", e.target.value)} placeholder="pim, dms, ecm…" />
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>Source type</span>
            <select value={form.source_type_id} onChange={(e) => set("source_type_id", e.target.value)}>
              <option value="">Any type</option>
              {objectTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Target type</span>
            <select value={form.target_type_id} onChange={(e) => set("target_type_id", e.target.value)}>
              <option value="">Any type</option>
              {objectTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Cardinality</span>
            <select value={form.cardinality} onChange={(e) => set("cardinality", e.target.value)}>
              {CARDINALITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Semantic</span>
            <select value={form.semantic} onChange={(e) => set("semantic", e.target.value)}>
              {SEMANTICS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Cascade delete</span>
            <input
              type="checkbox"
              checked={form.cascade_delete}
              onChange={(e) => set("cascade_delete", e.target.checked)}
            />
          </label>
        </div>
        <button className="btn" style={{ marginTop: 8 }}>
          Create relationship type
        </button>
      </form>

      <div className="panel">
        <h3>Relationship types</h3>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Cardinality</th>
              <th>Semantic</th>
              <th>Cascade</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((rt) => (
              <tr key={rt.id}>
                <td className="mono">{rt.code}</td>
                <td>{rt.name}</td>
                <td>{rt.cardinality}</td>
                <td>{rt.semantic}</td>
                <td>{rt.cascade_delete ? "yes" : "no"}</td>
                <td>
                  <span className={`badge ${rt.status === "active" ? "active" : "inactive"}`}>{rt.status}</span>
                </td>
                <td>
                  <div className="inline">
                    {STATUSES.filter((s) => s !== rt.status).map((s) => (
                      <button key={s} className="btn ghost" onClick={() => changeStatus(rt, s)}>
                        {s}
                      </button>
                    ))}
                    <button className="btn ghost" onClick={() => remove(rt)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td colSpan={7} className="mono">
                  No relationship types defined.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
