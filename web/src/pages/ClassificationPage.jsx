import React, { useEffect, useState } from "react";
import { classification } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "classifications", label: "Classifications" },
  { key: "classes", label: "Classes" },
  { key: "characteristics", label: "Characteristics" },
  { key: "values", label: "Allowed values" },
  { key: "assignments", label: "Assignments" },
  { key: "validation", label: "Validation" },
  { key: "duplicates", label: "Duplicates" },
  { key: "configuration", label: "Configuration" },
];

const emptyClassification = { code: "", name: "", description: "" };
const emptyClass = { classification_id: "", parent_class_id: "", code: "", name: "", description: "" };
const emptyCharacteristic = { code: "", name: "", data_type: "STRING", unit: "", base_unit: "", description: "" };
const emptyValue = { code: "", display_name: "" };
const emptyAssign = { object_type: "product", object_id: "", class_id: "", values: "{}" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["ACTIVE", "APPROVED", "ok", "healthy"].includes(status)) return "ok";
  if (["DRAFT", "PENDING", "INACTIVE", "degraded", "warning"].includes(status)) return "warn";
  if (["OBSOLETE", "SUPERSEDED", "error", "REJECTED"].includes(status)) return "danger";
  return undefined;
}

export default function ClassificationPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [classifications, setClassifications] = useState([]);
  const [classes, setClasses] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);
  const [groups, setGroups] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [configuration, setConfiguration] = useState({});
  const [units, setUnits] = useState([]);

  const [classificationForm, setClassificationForm] = useState(emptyClassification);
  const [classForm, setClassForm] = useState(emptyClass);
  const [characteristicForm, setCharacteristicForm] = useState(emptyCharacteristic);
  const [valueForm, setValueForm] = useState(emptyValue);
  const [assignForm, setAssignForm] = useState(emptyAssign);
  const [selectedClassification, setSelectedClassification] = useState("");
  const [selectedCharacteristic, setSelectedCharacteristic] = useState("");
  const [allowedValues, setAllowedValues] = useState([]);
  const [effective, setEffective] = useState(null);
  const [validationResult, setValidationResult] = useState(null);
  const [duplicateResult, setDuplicateResult] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [met, m, h, cls, klass, chars, grp, asg, cfg, un] = await Promise.all([
        classification.meta(),
        classification.metrics(),
        classification.health(),
        classification.classifications("?page_size=50"),
        classification.classes("?page_size=100"),
        classification.characteristics("?page_size=100"),
        classification.groups("?page_size=50"),
        classification.assignments("?page_size=50"),
        classification.configuration(),
        classification.units(),
      ]);
      setMeta(met);
      setMetrics(m);
      setHealth(h);
      setClassifications(cls.items || []);
      setClasses(klass.items || []);
      setCharacteristics(chars.items || []);
      setGroups(grp.items || []);
      setAssignments(asg.items || []);
      setConfiguration(cfg || {});
      setUnits(un || []);
      if (!selectedClassification && cls.items?.[0]) setSelectedClassification(cls.items[0].code || cls.items[0].id);
      if (!selectedCharacteristic && chars.items?.[0]) setSelectedCharacteristic(String(chars.items[0].id));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAllowedValues(ref) {
    if (!ref) return;
    try {
      const result = await classification.allowedValues(ref, "?page_size=200");
      setAllowedValues(result.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadAllowedValues(selectedCharacteristic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCharacteristic]);

  async function run(action, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function bind(setter, form) {
    return (event) => setter({ ...form, [event.target.name]: event.target.value });
  }

  const classOptions = classes.filter((entry) => !selectedClassification || entry.code);
  const selectedCharacteristicRow = characteristics.find((entry) => String(entry.id) === String(selectedCharacteristic));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Enterprise classification</h1>
          <p className="subtle">Centralized classification engine for parts, documents, suppliers, processes and products.</p>
        </div>
        <div className="stack-row">
          {meta?.source_module ? <Badge tone="ok">{meta.source_module}</Badge> : null}
          {health?.status ? <Badge tone={toneFor(health.status)}>{health.status}</Badge> : null}
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
            <div className="panel grow"><h3>Classifications</h3><div className="mono">{metrics?.totals?.classifications ?? "—"}</div></div>
            <div className="panel grow"><h3>Classes</h3><div className="mono">{metrics?.totals?.classes ?? "—"}</div></div>
            <div className="panel grow"><h3>Characteristics</h3><div className="mono">{metrics?.totals?.characteristics ?? "—"}</div></div>
            <div className="panel grow"><h3>Assignments</h3><div className="mono">{metrics?.totals?.active_assignments ?? "—"}</div></div>
            <div className="panel grow"><h3>Classified objects</h3><div className="mono">{metrics?.classified_objects ?? "—"}</div></div>
            <div className="panel grow"><h3>Missing required</h3><div className="mono">{metrics?.assignments_missing_required ?? "—"}</div></div>
          </div>
          <div className="panel">
            <h3>Health checks</h3>
            <div className="chips">
              {(health?.checks || []).map((check) => (
                <Badge key={check.name} tone={check.status === "ok" ? "ok" : "danger"}>{check.name}: {check.status}</Badge>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {tab === "classifications" ? (
        <>
          <div className="panel">
            <h3>Create a classification</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={classificationForm.code} onChange={bind(setClassificationForm, classificationForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={classificationForm.name} onChange={bind(setClassificationForm, classificationForm)} /></label>
              <label className="field"><span>Description</span><input name="description" value={classificationForm.description} onChange={bind(setClassificationForm, classificationForm)} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => classification.createClassification(classificationForm), "Classification created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Classifications ({classifications.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Approval</th><th>Version</th><th></th></tr></thead>
              <tbody>
                {classifications.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td><Badge tone={toneFor(entry.approval_status)}>{entry.approval_status}</Badge></td>
                    <td className="mono">{entry.version}</td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.setClassificationStatus(entry.id, entry.status === "ACTIVE" ? "OBSOLETE" : "ACTIVE"), "Status changed.")}>{entry.status === "ACTIVE" ? "Obsolete" : "Activate"}</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.approveClassification(entry.id), "Approved.")}>Approve</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(async () => { setSelectedClassification(entry.code); setTab("classes"); })}>Classes</button>
                    </td>
                  </tr>
                ))}
                {!classifications.length ? <tr><td colSpan={6} className="mono">No classifications.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "classes" ? (
        <>
          <div className="panel">
            <h3>Create a class</h3>
            <div className="grid">
              <label className="field"><span>Classification</span>
                <select name="classification_id" value={classForm.classification_id} onChange={bind(setClassForm, classForm)}>
                  <option value="">Select…</option>
                  {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Parent class</span>
                <select name="parent_class_id" value={classForm.parent_class_id} onChange={bind(setClassForm, classForm)}>
                  <option value="">None (root)</option>
                  {classes.map((entry) => <option key={entry.id} value={entry.id}>{entry.path || entry.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Code</span><input name="code" value={classForm.code} onChange={bind(setClassForm, classForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={classForm.name} onChange={bind(setClassForm, classForm)} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => classification.createClass({ ...classForm, classification_id: Number(classForm.classification_id), parent_class_id: classForm.parent_class_id ? Number(classForm.parent_class_id) : null }), "Class created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Classes ({classes.length})</h3>
            <table className="table">
              <thead><tr><th>Path</th><th>Code</th><th>Name</th><th>Level</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {classes.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.path}</td>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.level}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.setClassStatus(entry.id, entry.status === "ACTIVE" ? "OBSOLETE" : "ACTIVE"), "Status changed.")}>{entry.status === "ACTIVE" ? "Obsolete" : "Activate"}</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(async () => setEffective(await classification.classEffective(entry.id)))}>Effective</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.addClassCharacteristic(entry.id, { characteristic_id: Number(selectedCharacteristic) }), "Characteristic attached.")}>+ characteristic</button>
                    </td>
                  </tr>
                ))}
                {!classes.length ? <tr><td colSpan={6} className="mono">No classes.</td></tr> : null}
              </tbody>
            </table>
            {effective ? (
              <div style={{ marginTop: 12 }}>
                <h4>Effective contract · {effective.class?.code} ({effective.total})</h4>
                <table className="table">
                  <thead><tr><th>Code</th><th>Type</th><th>Required</th><th>Origin</th><th>Source</th></tr></thead>
                  <tbody>
                    {(effective.items || []).map((item) => (
                      <tr key={item.characteristic_id}>
                        <td className="mono">{item.code}</td>
                        <td className="mono">{item.data_type}{item.unit ? ` (${item.unit})` : ""}</td>
                        <td className="mono">{item.required ? "yes" : "no"}</td>
                        <td><Badge>{item.origin}</Badge></td>
                        <td className="mono">{item.source_class_code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "characteristics" ? (
        <>
          <div className="panel">
            <h3>Create a characteristic</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={characteristicForm.code} onChange={bind(setCharacteristicForm, characteristicForm)} /></label>
              <label className="field"><span>Name</span><input name="name" value={characteristicForm.name} onChange={bind(setCharacteristicForm, characteristicForm)} /></label>
              <label className="field"><span>Data type</span>
                <select name="data_type" value={characteristicForm.data_type} onChange={bind(setCharacteristicForm, characteristicForm)}>
                  {(meta?.capabilities?.characteristic_data_types || ["STRING", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "ENUMERATION", "UNIT_NUMERIC", "REFERENCE"]).map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Unit</span>
                <select name="unit" value={characteristicForm.unit} onChange={bind(setCharacteristicForm, characteristicForm)}>
                  <option value="">None</option>
                  {units.map((unit) => <option key={unit.code} value={unit.code}>{unit.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={characteristicForm.description} onChange={bind(setCharacteristicForm, characteristicForm)} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(async () => {
              const body = { ...characteristicForm };
              if (characteristicForm.data_type === "UNIT_NUMERIC" && !body.base_unit) body.base_unit = characteristicForm.unit;
              if (!body.unit) delete body.unit;
              return classification.createCharacteristic(body);
            }, "Characteristic created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Characteristics ({characteristics.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Unit</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {characteristics.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.code}</td>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.data_type}</td>
                    <td className="mono">{entry.unit || "—"}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => { setSelectedCharacteristic(String(entry.id)); setTab("values"); }}>Allowed values</button>
                    </td>
                  </tr>
                ))}
                {!characteristics.length ? <tr><td colSpan={6} className="mono">No characteristics.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {groups.length ? (
            <div className="panel">
              <h3>Characteristic groups ({groups.length})</h3>
              <div className="chips">{groups.map((group) => <Badge key={group.id}>{group.code}</Badge>)}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "values" ? (
        <>
          <div className="panel">
            <h3>Allowed values</h3>
            <div className="grid">
              <label className="field"><span>Characteristic</span>
                <select value={selectedCharacteristic} onChange={(event) => setSelectedCharacteristic(event.target.value)}>
                  <option value="">Select…</option>
                  {characteristics.map((entry) => <option key={entry.id} value={String(entry.id)}>{entry.code}</option>)}
                </select>
              </label>
            </div>
            {selectedCharacteristicRow && selectedCharacteristicRow.data_type !== "ENUMERATION" ? (
              <p className="subtle">Allowed values apply to ENUMERATION characteristics.</p>
            ) : null}
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={valueForm.code} onChange={bind(setValueForm, valueForm)} /></label>
              <label className="field"><span>Display name</span><input name="display_name" value={valueForm.display_name} onChange={bind(setValueForm, valueForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !selectedCharacteristic} onClick={() => run(async () => {
              await classification.createAllowedValue(selectedCharacteristic, valueForm);
              await loadAllowedValues(selectedCharacteristic);
            }, "Allowed value added.")}>Add</button>
            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>Code</th><th>Display</th><th>Status</th></tr></thead>
              <tbody>
                {allowedValues.map((entry) => (
                  <tr key={entry.id}><td className="mono">{entry.code}</td><td>{entry.display_name}</td><td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td></tr>
                ))}
                {!allowedValues.length ? <tr><td colSpan={3} className="mono">No allowed values.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "assignments" ? (
        <>
          <div className="panel">
            <h3>Assign a class to an object</h3>
            <div className="grid">
              <label className="field"><span>Object type</span><input name="object_type" value={assignForm.object_type} onChange={bind(setAssignForm, assignForm)} /></label>
              <label className="field"><span>Object id</span><input name="object_id" value={assignForm.object_id} onChange={bind(setAssignForm, assignForm)} /></label>
              <label className="field"><span>Class</span>
                <select name="class_id" value={assignForm.class_id} onChange={bind(setAssignForm, assignForm)}>
                  <option value="">Select…</option>
                  {classOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.path || entry.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Values (JSON)</span><input name="values" value={assignForm.values} onChange={bind(setAssignForm, assignForm)} /></label>
            </div>
            <button className="btn" disabled={busy || !assignForm.class_id} onClick={() => run(async () => {
              let values = null;
              try { values = assignForm.values ? JSON.parse(assignForm.values) : null; } catch { throw new Error("Values must be valid JSON"); }
              return classification.assign({ object_type: assignForm.object_type, object_id: assignForm.object_id, class_id: Number(assignForm.class_id), values });
            }, "Object classified.")}>Assign</button>
          </div>

          <div className="panel">
            <h3>Assignments ({assignments.length})</h3>
            <table className="table">
              <thead><tr><th>Object</th><th>Class</th><th>Classification</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {assignments.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.object_type}:{entry.object_id}</td>
                    <td className="mono">{entry.class_code}</td>
                    <td className="mono">{entry.classification_code}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                    <td className="stack-row">
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.validateAssignment(entry.id), "Assignment validated.")}>Validate</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.setAssignmentStatus(entry.id, entry.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"), "Status changed.")}>{entry.status === "ACTIVE" ? "Deactivate" : "Activate"}</button>
                      <button className="btn ghost" disabled={busy} onClick={() => run(() => classification.unassign(entry.id), "Unassigned.")}>Remove</button>
                    </td>
                  </tr>
                ))}
                {!assignments.length ? <tr><td colSpan={5} className="mono">No assignments.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "validation" ? (
        <>
          <div className="panel">
            <h3>Validate a class value set</h3>
            <div className="grid">
              <label className="field"><span>Class</span>
                <select id="validation-class">
                  <option value="">Select…</option>
                  {classOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.path || entry.code}</option>)}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy} onClick={() => run(async () => {
                const ref = document.getElementById("validation-class")?.value;
                if (!ref) throw new Error("Select a class");
                setValidationResult(await classification.validateClass(ref, { values: {} }));
              })}>Validate required</button>
            </div>
            {validationResult ? (
              <div style={{ marginTop: 12 }}>
                <Badge tone={validationResult.valid ? "ok" : "danger"}>{validationResult.valid ? "valid" : "invalid"}</Badge>
                <div className="mono" style={{ marginTop: 8 }}>
                  {(validationResult.errors || []).map((entry) => entry.message).join("; ") || "No errors."}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "duplicates" ? (
        <>
          <div className="panel">
            <h3>Duplicate detection</h3>
            <p className="subtle">Objects with identical or near-identical classification signatures.</p>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy} onClick={() => run(async () => setDuplicateResult(await classification.duplicateSummary()))}>Summary</button>
              <button className="btn" disabled={busy} onClick={() => run(async () => setDuplicateResult(await classification.scanDuplicates({})))}>Run scan</button>
            </div>
            {duplicateResult ? (
              <div className="mono" style={{ marginTop: 12 }}>{JSON.stringify(duplicateResult, null, 2)}</div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{String(value)}</td>
                  <td>
                    <button className="btn ghost" disabled={busy} onClick={() => run(async () => {
                      const next = window.prompt(`New value for ${key}`, String(value));
                      if (next === null) return;
                      let parsed = next;
                      if (next === "true" || next === "false") parsed = next === "true";
                      else if (next !== "" && !Number.isNaN(Number(next))) parsed = Number(next);
                      await classification.setConfiguration(key, parsed);
                    }, "Configuration updated.")}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
