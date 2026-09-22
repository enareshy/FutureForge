import React, { useEffect, useState } from "react";
import { dataCatalog } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "objects", label: "Objects & attributes" },
  { key: "sources", label: "Sources" },
  { key: "consumers", label: "Consumers" },
  { key: "lineage", label: "Lineage & impact" },
  { key: "classifications", label: "Classifications" },
  { key: "ownership", label: "Ownership" },
  { key: "importexport", label: "Import & export" },
];

const emptyObject = { object_type: "", display_name: "", description: "" };
const emptySource = { code: "", name: "", source_type: "APPLICATION", system: "" };
const emptyConsumer = { code: "", name: "", consumer_type: "APPLICATION", purpose: "" };
const emptyClassification = { code: "", name: "", category: "business", security_classification: "internal" };
const emptyOwnership = { entry_ref: "", ownership_kind: "DATA_OWNER", subject_type: "user", subject_id: "" };
const emptyLineage = { from_type: "SOURCE", from_id: "", to_type: "OBJECT", to_id: "", relationship_type: "SOURCE_OF" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function statusTone(status) {
  if (status === "active") return "ok";
  if (status === "draft") return "warn";
  if (status === "deprecated" || status === "retired") return "danger";
  return undefined;
}

export default function DataCatalogPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [entries, setEntries] = useState([]);
  const [objects, setObjects] = useState([]);
  const [selectedObject, setSelectedObject] = useState(null);
  const [attributes, setAttributes] = useState([]);
  const [sources, setSources] = useState([]);
  const [consumers, setConsumers] = useState([]);
  const [lineage, setLineage] = useState([]);
  const [graph, setGraph] = useState(null);
  const [classifications, setClassifications] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [ownership, setOwnership] = useState([]);
  const [gaps, setGaps] = useState([]);
  const [importRuns, setImportRuns] = useState([]);

  const [objectForm, setObjectForm] = useState(emptyObject);
  const [sourceForm, setSourceForm] = useState(emptySource);
  const [consumerForm, setConsumerForm] = useState(emptyConsumer);
  const [classificationForm, setClassificationForm] = useState(emptyClassification);
  const [ownershipForm, setOwnershipForm] = useState(emptyOwnership);
  const [lineageForm, setLineageForm] = useState(emptyLineage);
  const [graphRoot, setGraphRoot] = useState({ type: "OBJECT", id: "" });

  async function refresh() {
    setError("");
    try {
      const [m, met, ent, obj, src, con, lin, cls, asg, own, gap, runs] = await Promise.all([
        dataCatalog.metrics(),
        dataCatalog.meta(),
        dataCatalog.entries("?pageSize=50"),
        dataCatalog.objects("?pageSize=50"),
        dataCatalog.sources("?pageSize=50"),
        dataCatalog.consumers("?pageSize=50"),
        dataCatalog.lineage("?pageSize=50"),
        dataCatalog.classifications(),
        dataCatalog.classificationAssignments("?pageSize=50"),
        dataCatalog.ownership("?pageSize=50"),
        dataCatalog.ownershipGaps(),
        dataCatalog.importRuns("?pageSize=25"),
      ]);
      setMetrics(m);
      setMeta(met);
      setEntries(ent.items || []);
      setObjects(obj.items || []);
      setSources(src.items || []);
      setConsumers(con.items || []);
      setLineage(lin.items || []);
      setClassifications(cls.items || []);
      setAssignments(asg.items || []);
      setOwnership(own.items || []);
      setGaps(gap.items || []);
      setImportRuns(runs.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openObject(ref) {
    setBusy(true);
    setError("");
    try {
      const [detail, attrs] = await Promise.all([dataCatalog.object(ref), dataCatalog.attributes(ref)]);
      setSelectedObject(detail);
      setAttributes(attrs.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadGraph(event) {
    event?.preventDefault?.();
    setBusy(true);
    setError("");
    try {
      const qs = `?root_type=${encodeURIComponent(graphRoot.type)}&root_id=${encodeURIComponent(graphRoot.id)}&direction=both&max_depth=2`;
      setGraph(await dataCatalog.lineageGraph(qs));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Data catalog</div>
          <h1>Data catalog &amp; business glossary</h1>
          <p className="sub">
            The central metadata registry: domains, data objects, attributes, business terms, sources, consumers,
            lineage, classifications and accountability. Business modules register metadata here instead of building
            their own catalogue.
          </p>
        </div>
        <div className="stack-row">
          <button className="btn ghost" onClick={refresh} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="tabs">
        {TABS.map((entry) => (
          <button key={entry.key} type="button" className={`tab ${tab === entry.key ? "active" : ""}`} onClick={() => setTab(entry.key)}>
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            {metrics ? (
              <>
                <div className="panel grow">
                  <h3>Catalog entries</h3>
                  <div className="mono">{metrics.counters.entries}</div>
                </div>
                <div className="panel grow">
                  <h3>Data objects</h3>
                  <div className="mono">{metrics.counters.objects}</div>
                </div>
                <div className="panel grow">
                  <h3>Attributes</h3>
                  <div className="mono">{metrics.counters.attributes}</div>
                </div>
                <div className="panel grow">
                  <h3>Business terms</h3>
                  <div className="mono">
                    {metrics.counters.terms_approved} / {metrics.counters.terms}
                  </div>
                </div>
                <div className="panel grow">
                  <h3>Lineage edges</h3>
                  <div className="mono">{metrics.counters.lineage}</div>
                </div>
              </>
            ) : (
              <div className="panel grow mono">Loading…</div>
            )}
          </div>

          <div className="panel">
            <h3>Registry by entry type</h3>
            {metrics?.by_type?.length ? (
              <div className="chips">
                {metrics.by_type.map((row) => (
                  <Badge key={`${row.entry_type}-${row.status}`}>
                    {row.entry_type} · {row.status} · {row.count}
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="mono">No entries yet.</div>
            )}
          </div>

          <div className="panel">
            <h3>Unified registry ({entries.length})</h3>
            {entries.map((entry) => (
              <div className="row" key={entry.id}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={statusTone(entry.status)}>{entry.status}</Badge> {entry.entry_type} · {entry.code} ·{" "}
                    {entry.display_name || entry.name}
                  </div>
                  <div className="mono muted">
                    {entry.entry_ref} · {entry.classification} · {entry.description || "no description"}
                  </div>
                </div>
              </div>
            ))}
            {entries.length === 0 ? <div className="mono">No catalog entries registered.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "objects" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createObject(objectForm);
                setObjectForm(emptyObject);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Object type</span>
                <input value={objectForm.object_type} onChange={(e) => setObjectForm({ ...objectForm, object_type: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Display name</span>
                <input value={objectForm.display_name} onChange={(e) => setObjectForm({ ...objectForm, display_name: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Description</span>
              <input value={objectForm.description} onChange={(e) => setObjectForm({ ...objectForm, description: e.target.value })} />
            </label>
            <button className="btn" disabled={busy}>
              Register object
            </button>
          </form>

          <div className="panel">
            <h3>Data objects ({objects.length})</h3>
            {objects.map((object) => (
              <div className="row" key={object.id}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={statusTone(object.status)}>{object.status}</Badge> {object.object_type} ·{" "}
                    {object.display_name} · {object.attribute_count ?? 0} attribute(s)
                  </div>
                  <div className="mono muted">
                    {object.object_ref} · {object.classification}
                  </div>
                </div>
                <button className="btn ghost" disabled={busy} onClick={() => openObject(object.object_ref)}>
                  View attributes
                </button>
              </div>
            ))}
            {objects.length === 0 ? <div className="mono">No data objects registered.</div> : null}
          </div>

          {selectedObject ? (
            <div className="panel">
              <h3>
                Attributes · {selectedObject.object_type} ({attributes.length})
              </h3>
              {attributes.map((attribute) => (
                <div className="row" key={attribute.id}>
                  <div className="grow mono">
                    {attribute.attribute_name} · {attribute.display_name} · {attribute.data_type}
                    {attribute.mandatory ? " · mandatory" : ""}
                  </div>
                  <Badge>{attribute.classification}</Badge>
                </div>
              ))}
              {attributes.length === 0 ? <div className="mono">No attributes defined.</div> : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "sources" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createSource(sourceForm);
                setSourceForm(emptySource);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={sourceForm.code} onChange={(e) => setSourceForm({ ...sourceForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={sourceForm.name} onChange={(e) => setSourceForm({ ...sourceForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={sourceForm.source_type} onChange={(e) => setSourceForm({ ...sourceForm, source_type: e.target.value })}>
                  {(meta?.capabilities?.source_types || ["APPLICATION"]).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>System</span>
                <input value={sourceForm.system} onChange={(e) => setSourceForm({ ...sourceForm, system: e.target.value })} />
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Register source
            </button>
          </form>

          <div className="panel">
            <h3>Data sources ({sources.length})</h3>
            {sources.map((source) => (
              <div className="row" key={source.id}>
                <div className="grow mono">
                  <Badge tone={statusTone(source.status)}>{source.status}</Badge> {source.code} · {source.name} ·{" "}
                  {source.source_type} · {source.system || "no system"}
                </div>
              </div>
            ))}
            {sources.length === 0 ? <div className="mono">No sources registered.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "consumers" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createConsumer(consumerForm);
                setConsumerForm(emptyConsumer);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={consumerForm.code} onChange={(e) => setConsumerForm({ ...consumerForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={consumerForm.name} onChange={(e) => setConsumerForm({ ...consumerForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={consumerForm.consumer_type} onChange={(e) => setConsumerForm({ ...consumerForm, consumer_type: e.target.value })}>
                  {(meta?.capabilities?.consumer_types || ["APPLICATION"]).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Register consumer
            </button>
          </form>

          <div className="panel">
            <h3>Data consumers ({consumers.length})</h3>
            {consumers.map((consumer) => (
              <div className="row" key={consumer.id}>
                <div className="grow mono">
                  <Badge tone={statusTone(consumer.status)}>{consumer.status}</Badge> {consumer.code} · {consumer.name} ·{" "}
                  {consumer.consumer_type}
                </div>
              </div>
            ))}
            {consumers.length === 0 ? <div className="mono">No consumers registered.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "lineage" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createLineage(lineageForm);
                setLineageForm(emptyLineage);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>From type</span>
                <input value={lineageForm.from_type} onChange={(e) => setLineageForm({ ...lineageForm, from_type: e.target.value })} />
              </label>
              <label className="field grow">
                <span>From id</span>
                <input value={lineageForm.from_id} onChange={(e) => setLineageForm({ ...lineageForm, from_id: e.target.value })} />
              </label>
              <label className="field grow">
                <span>To type</span>
                <input value={lineageForm.to_type} onChange={(e) => setLineageForm({ ...lineageForm, to_type: e.target.value })} />
              </label>
              <label className="field grow">
                <span>To id</span>
                <input value={lineageForm.to_id} onChange={(e) => setLineageForm({ ...lineageForm, to_id: e.target.value })} />
              </label>
              <label className="field">
                <span>Relationship</span>
                <select value={lineageForm.relationship_type} onChange={(e) => setLineageForm({ ...lineageForm, relationship_type: e.target.value })}>
                  {(meta?.capabilities?.lineage_relationship_types || ["SOURCE_OF"]).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Add lineage edge
            </button>
          </form>

          <form className="panel" onSubmit={loadGraph}>
            <h3>Impact explorer</h3>
            <div className="row">
              <label className="field grow">
                <span>Root type</span>
                <input value={graphRoot.type} onChange={(e) => setGraphRoot({ ...graphRoot, type: e.target.value })} />
              </label>
              <label className="field grow">
                <span>Root id</span>
                <input value={graphRoot.id} onChange={(e) => setGraphRoot({ ...graphRoot, id: e.target.value })} />
              </label>
              <button className="btn ghost" disabled={busy || !graphRoot.id}>
                Load graph
              </button>
            </div>
            {graph ? (
              <>
                <div className="mono muted">
                  {graph.nodes?.length || 0} node(s) · {graph.edges?.length || 0} edge(s)
                  {graph.truncated ? " · truncated" : ""}
                </div>
                {(graph.nodes || []).map((node) => (
                  <div className="row" key={`${node.type}-${node.id}`}>
                    <div className="grow mono">
                      {node.type} · {node.ref || node.id} · {node.name || ""}
                    </div>
                  </div>
                ))}
              </>
            ) : null}
          </form>

          <div className="panel">
            <h3>Lineage edges ({lineage.length})</h3>
            {lineage.map((edge) => (
              <div className="row" key={edge.id}>
                <div className="grow mono">
                  {edge.from_type}:{edge.from_id} → {edge.to_type}:{edge.to_id} · {edge.relationship_type} ·{" "}
                  <Badge tone={edge.status === "active" ? "ok" : undefined}>{edge.status}</Badge>
                </div>
              </div>
            ))}
            {lineage.length === 0 ? <div className="mono">No lineage recorded.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "classifications" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createClassification(classificationForm);
                setClassificationForm(emptyClassification);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={classificationForm.code} onChange={(e) => setClassificationForm({ ...classificationForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={classificationForm.name} onChange={(e) => setClassificationForm({ ...classificationForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Category</span>
                <select value={classificationForm.category} onChange={(e) => setClassificationForm({ ...classificationForm, category: e.target.value })}>
                  {["business", "security", "regulatory", "domain"].map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Security</span>
                <select
                  value={classificationForm.security_classification}
                  onChange={(e) => setClassificationForm({ ...classificationForm, security_classification: e.target.value })}
                >
                  {(meta?.capabilities?.security_classifications || ["internal"]).map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Create classification
            </button>
          </form>

          <div className="panel">
            <h3>Classifications ({classifications.length})</h3>
            {classifications.map((classification) => (
              <div className="row" key={classification.id}>
                <div className="grow mono">
                  {classification.code} · {classification.name} · {classification.category} →{" "}
                  <Badge>{classification.security_classification}</Badge>
                </div>
              </div>
            ))}
            {classifications.length === 0 ? <div className="mono">No classifications defined.</div> : null}
          </div>

          <div className="panel">
            <h3>Assignments ({assignments.length})</h3>
            {assignments.map((assignment) => (
              <div className="row" key={assignment.id}>
                <div className="grow mono">
                  entry #{assignment.entry_id} · {assignment.classification_code || assignment.classification_id} ·{" "}
                  {assignment.status}
                </div>
              </div>
            ))}
            {assignments.length === 0 ? <div className="mono">No classification assignments.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "ownership" ? (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await dataCatalog.createOwnership(ownershipForm);
                setOwnershipForm(emptyOwnership);
              });
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Entry ref</span>
                <input value={ownershipForm.entry_ref} onChange={(e) => setOwnershipForm({ ...ownershipForm, entry_ref: e.target.value })} required />
              </label>
              <label className="field">
                <span>Kind</span>
                <select value={ownershipForm.ownership_kind} onChange={(e) => setOwnershipForm({ ...ownershipForm, ownership_kind: e.target.value })}>
                  {(meta?.capabilities?.ownership_kinds || ["DATA_OWNER"]).map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject</span>
                <select value={ownershipForm.subject_type} onChange={(e) => setOwnershipForm({ ...ownershipForm, subject_type: e.target.value })}>
                  {["user", "group", "role", "organization"].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject id</span>
                <input value={ownershipForm.subject_id} onChange={(e) => setOwnershipForm({ ...ownershipForm, subject_id: e.target.value })} required />
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Assign accountability
            </button>
          </form>

          <div className="panel">
            <h3>Ownership gaps ({gaps.length})</h3>
            {gaps.map((gap) => (
              <div className="row" key={`${gap.entry_id}-${gap.relationship}`}>
                <div className="grow mono">
                  entry #{gap.entry_id} · missing {gap.relationship} · {gap.entry_ref || ""}
                </div>
              </div>
            ))}
            {gaps.length === 0 ? <div className="mono">No ownership gaps detected.</div> : null}
          </div>

          <div className="panel">
            <h3>Assignments ({ownership.length})</h3>
            {ownership.map((row) => (
              <div className="row" key={row.id}>
                <div className="grow mono">
                  entry #{row.entry_id} · {row.relationship} · {row.ownership_kind} · {row.subject_type}#{row.subject_id}
                  {row.is_primary ? " · primary" : ""}
                </div>
              </div>
            ))}
            {ownership.length === 0 ? <div className="mono">No accountability recorded.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "importexport" ? (
        <>
          <div className="panel">
            <h3>Background jobs</h3>
            <div className="row">
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataCatalog.runLineageMaintenance())}>
                Run lineage maintenance
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataCatalog.submitReindex({}))}>
                Reindex catalog
              </button>
              <a className="btn ghost" href="/api/v1/data-catalog/export?format=json" target="_blank" rel="noreferrer">
                Export snapshot
              </a>
            </div>
          </div>

          <div className="panel">
            <h3>Import runs ({importRuns.length})</h3>
            {importRuns.map((runItem) => (
              <div className="row" key={runItem.id}>
                <div className="grow mono">
                  <Badge tone={runItem.status === "completed" ? "ok" : runItem.status === "failed" ? "danger" : "warn"}>
                    {runItem.status}
                  </Badge>{" "}
                  {runItem.resource_type} · {runItem.format} · {runItem.dry_run ? "dry run" : "applied"} ·{" "}
                  {runItem.created_at}
                </div>
              </div>
            ))}
            {importRuns.length === 0 ? <div className="mono">No import runs recorded.</div> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
