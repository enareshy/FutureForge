import React, { useEffect, useState } from "react";
import { migration } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "sources", label: "Sources" },
  { key: "projects", label: "Projects" },
  { key: "packages", label: "Packages" },
  { key: "definitions", label: "Definitions" },
  { key: "planning", label: "Planning" },
  { key: "jobs", label: "Jobs" },
  { key: "mappings", label: "Mappings" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "audit", label: "Audit" },
  { key: "configuration", label: "Configuration" },
];

const emptySource = { code: "", name: "", adapter_type: "DATABASE", description: "" };
const emptyProject = { code: "", name: "", source_system: "", description: "" };
const emptyPackage = { code: "", name: "", project_id: "", source_object_type: "", target_object_type: "", description: "" };
const emptyDefinition = { code: "", name: "", source_object_type: "", target_object_type: "", description: "" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function toneFor(status) {
  if (["COMPLETED", "READY", "ACTIVE", "MAPPED", "MIGRATED", "satisfied", "ready"].includes(status)) return "ok";
  if (["RUNNING", "QUEUED", "DRAFT", "VALIDATING", "PAUSED", "RETRYING", "PARTIALLY_COMPLETED", "warning", "PENDING"].includes(status)) return "warn";
  if (["FAILED", "CANCELLED", "BLOCKED", "VARIANCE", "missing", "circular", "blocked"].includes(status)) return "danger";
  return undefined;
}

export default function MigrationPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [adapters, setAdapters] = useState([]);
  const [sources, setSources] = useState([]);
  const [projects, setProjects] = useState([]);
  const [packages, setPackages] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [plans, setPlans] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [identifiers, setIdentifiers] = useState([]);
  const [files, setFiles] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [audit, setAudit] = useState([]);
  const [configuration, setConfiguration] = useState({});

  const [sourceForm, setSourceForm] = useState(emptySource);
  const [projectForm, setProjectForm] = useState(emptyProject);
  const [packageForm, setPackageForm] = useState(emptyPackage);
  const [definitionForm, setDefinitionForm] = useState(emptyDefinition);
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedPackage, setSelectedPackage] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [preview, setPreview] = useState(null);
  const [validation, setValidation] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [jobErrors, setJobErrors] = useState([]);

  async function refresh() {
    setError("");
    try {
      const [met, m, h, ad, sc, proj, pkg, defs, pl, jb, idm, fm, rec, au, cfg] = await Promise.all([
        migration.meta(),
        migration.metrics(),
        migration.health(),
        migration.sourceAdapters(),
        migration.sourceConfigurations("?page_size=50"),
        migration.projects("?page_size=50"),
        migration.packages("?page_size=50"),
        migration.definitions("?page_size=50"),
        migration.plans("?page_size=25"),
        migration.jobs("?page_size=25"),
        migration.identifierMappings("?page_size=25"),
        migration.fileMigrations("?page_size=25"),
        migration.reconciliations("?page_size=25"),
        migration.audit("?page_size=25"),
        migration.configuration(),
      ]);
      setMeta(met);
      setMetrics(m);
      setHealth(h);
      setAdapters(ad.items || []);
      setSources(sc.items || []);
      setProjects(proj.items || []);
      setPackages(pkg.items || []);
      setDefinitions(defs.items || []);
      setPlans(pl.items || []);
      setJobs(jb.items || []);
      setIdentifiers(idm.items || []);
      setFiles(fm.items || []);
      setReconciliations(rec.items || []);
      setAudit(au.items || []);
      setConfiguration(cfg.config || {});
      if (!selectedProject && proj.items?.[0]) setSelectedProject(proj.items[0].code);
      if (!selectedPackage && pkg.items?.[0]) setSelectedPackage(pkg.items[0].code);
      if (!selectedJob && jb.items?.[0]) setSelectedJob(jb.items[0].job_ref);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function bindUnknown(setter, form) {
    return (event) => setter({ ...form, [event.target.name]: event.target.value });
  }

  const onChangeSource = bind(setSourceForm, sourceForm);
  const onChangeProject = bind(setProjectForm, projectForm);
  const onChangePackage = bindUnknown(setPackageForm, packageForm);
  const onChangeDefinition = bind(setDefinitionForm, definitionForm);

  const adapterTypes = meta?.vocabularies?.source_adapter_types || [];
  const projectStatuses = meta?.vocabularies?.project_statuses || [];
  const executionModes = meta?.vocabularies?.execution_modes || [];
  const reconciliationStrategies = meta?.vocabularies?.reconciliation_strategies || [];

  const selectedPackageRow = packages.find((pkg) => pkg.code === selectedPackage);
  const selectedJobRow = jobs.find((job) => job.job_ref === selectedJob);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Migration</div>
          <h1>Migration &amp; onboarding framework</h1>
          <p className="sub">
            Controlled, dependency-aware, resumable migration of large historical datasets from legacy systems.
            Package, map, transform, validate, resolve dependencies, execute, reconcile and audit — at scale.
          </p>
        </div>
        <div className="stack-row">
          <button className="btn ghost" onClick={refresh} disabled={busy}>Refresh</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

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
            <div className="panel grow"><h3>Projects</h3><div className="mono">{metrics?.projects ?? "—"}</div></div>
            <div className="panel grow"><h3>Packages</h3><div className="mono">{metrics?.packages ?? "—"}</div></div>
            <div className="panel grow"><h3>Definitions</h3><div className="mono">{metrics?.definitions ?? "—"}</div></div>
            <div className="panel grow"><h3>Source configs</h3><div className="mono">{metrics?.source_configurations ?? "—"}</div></div>
            <div className="panel grow"><h3>Object results</h3><div className="mono">{metrics?.object_results ?? "—"}</div></div>
            <div className="panel grow"><h3>Open errors</h3><div className="mono">{metrics?.open_errors ?? "—"}</div></div>
          </div>

          <div className="panel">
            <h3>Pipeline stages</h3>
            <div className="chips">
              {(meta?.capabilities?.pipeline_stages || []).map((stage) => <Badge key={stage}>{stage}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Source adapters ({adapters.length})</h3>
            <div className="chips">
              {adapters.map((adapter) => <Badge key={adapter.adapter_type}>{adapter.adapter_type}</Badge>)}
            </div>
          </div>

          <div className="panel">
            <h3>Health · {health?.status || "unknown"}</h3>
            {health?.checks?.length ? (
              <div className="chips">
                {health.checks.map((check) => (
                  <Badge key={check.name} tone={check.status === "ok" ? "ok" : "warn"}>{check.name}: {check.status}</Badge>
                ))}
              </div>
            ) : (
              <div className="mono">No health data.</div>
            )}
          </div>
        </>
      ) : null}

      {tab === "sources" ? (
        <>
          <div className="panel">
            <h3>Create a source configuration</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={sourceForm.code} onChange={onChangeSource} /></label>
              <label className="field"><span>Name</span><input name="name" value={sourceForm.name} onChange={onChangeSource} /></label>
              <label className="field"><span>Adapter type</span>
                <select name="adapter_type" value={sourceForm.adapter_type} onChange={onChangeSource}>
                  {adapterTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input name="description" value={sourceForm.description} onChange={onChangeSource} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => migration.createSourceConfiguration(sourceForm), "Source configuration created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Source configurations ({sources.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Adapter</th><th>Status</th><th>Credential</th><th></th></tr></thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.code}>
                    <td className="mono">{source.code}</td>
                    <td>{source.name}</td>
                    <td className="mono">{source.adapter_type}</td>
                    <td><Badge tone={source.status === "active" ? "ok" : undefined}>{source.status}</Badge></td>
                    <td className="mono">{source.credential_ref || "—"}</td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(async () => {
                          const result = await migration.testSourceConfiguration(source.code);
                          setNotice(result.connected ? "Connection OK." : "Connection failed.");
                        })}>Test</button>
                    </td>
                  </tr>
                ))}
                {!sources.length ? <tr><td colSpan={6} className="mono">No source configurations.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "projects" ? (
        <>
          <div className="panel">
            <h3>Create a migration project</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={projectForm.code} onChange={onChangeProject} /></label>
              <label className="field"><span>Name</span><input name="name" value={projectForm.name} onChange={onChangeProject} /></label>
              <label className="field"><span>Source system</span><input name="source_system" value={projectForm.source_system} onChange={onChangeProject} placeholder="Teamcenter" /></label>
              <label className="field"><span>Description</span><input name="description" value={projectForm.description} onChange={onChangeProject} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => migration.createProject(projectForm), "Project created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Projects ({projects.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Source system</th><th>Status</th><th>Version</th><th></th></tr></thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td className="mono">{project.code}</td>
                    <td>{project.name}</td>
                    <td>{project.source_system || "—"}</td>
                    <td><Badge tone={toneFor(project.status)}>{project.status}</Badge></td>
                    <td>{project.version}</td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(async () => setReadiness(await migration.projectReadiness(project.code)))}>Readiness</button>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.generatePlan(project.code, {}), "Plan generated.")}>Plan</button>
                      {project.status === "DRAFT" ? (
                        <button className="chip link-btn" disabled={busy}
                          onClick={() => run(() => migration.setProjectStatus(project.code, "READY"), "Project marked READY.")}>Mark ready</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!projects.length ? <tr><td colSpan={6} className="mono">No projects.</td></tr> : null}
              </tbody>
            </table>
            {readiness ? (
              <div style={{ marginTop: 12 }}>
                <h3>Readiness · {readiness.status} ({readiness.summary?.ready || 0}/{readiness.summary?.total || 0} ready)</h3>
                <div className="chips">
                  {(readiness.packages || []).map((entry) => (
                    <Badge key={entry.code} tone={toneFor(entry.readiness)}>{entry.code}: {entry.readiness}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "packages" ? (
        <>
          <div className="panel">
            <h3>Create a migration package</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={packageForm.code} onChange={onChangePackage} /></label>
              <label className="field"><span>Name</span><input name="name" value={packageForm.name} onChange={onChangePackage} /></label>
              <label className="field"><span>Project</span>
                <select name="project_id" value={packageForm.project_id} onChange={onChangePackage}>
                  <option value="">Select…</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Source object type</span><input name="source_object_type" value={packageForm.source_object_type} onChange={onChangePackage} placeholder="Part" /></label>
              <label className="field"><span>Target object type</span><input name="target_object_type" value={packageForm.target_object_type} onChange={onChangePackage} placeholder="product" /></label>
              <label className="field"><span>Description</span><input name="description" value={packageForm.description} onChange={onChangePackage} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => migration.createPackage({ ...packageForm, project_id: Number(packageForm.project_id) }), "Package created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Preview, validate &amp; run ({packages.length})</h3>
            <div className="grid">
              <label className="field"><span>Package</span>
                <select value={selectedPackage} onChange={(event) => setSelectedPackage(event.target.value)}>
                  <option value="">Select…</option>
                  {packages.map((pkg) => <option key={pkg.code} value={pkg.code}>{pkg.code} → {pkg.target_object_type}</option>)}
                </select>
              </label>
              <label className="field"><span>Execution mode</span>
                <select id="migration-mode" defaultValue="EXECUTE">
                  {executionModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </label>
            </div>
            <div className="stack-row">
              <button className="btn secondary" disabled={busy || !selectedPackage}
                onClick={() => run(async () => setPreview(await migration.previewPackage(selectedPackage, { limit: 20 })))}>Preview</button>
              <button className="btn secondary" disabled={busy || !selectedPackage}
                onClick={() => run(async () => setValidation(await migration.validatePackage(selectedPackage, {})))}>Validate</button>
              <button className="btn" disabled={busy || !selectedPackage}
                onClick={() => run(() => {
                  const mode = document.getElementById("migration-mode")?.value || "EXECUTE";
                  return migration.runPackage(selectedPackage, { mode });
                }, "Migration job submitted.")}>Run</button>
              {selectedPackageRow && selectedPackageRow.status === "DRAFT" ? (
                <button className="btn ghost" disabled={busy}
                  onClick={() => run(() => migration.setPackageStatus(selectedPackage, "READY"), "Package marked READY.")}>Mark ready</button>
              ) : null}
            </div>

            {preview ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Preview · {preview.record_count} records · valid {preview.valid} · invalid {preview.invalid}</h3>
                <table className="table">
                  <thead><tr><th>#</th><th>Errors</th><th>Target</th></tr></thead>
                  <tbody>
                    {(preview.records || []).slice(0, 10).map((row) => (
                      <tr key={row.record_number}>
                        <td className="mono">{row.record_number}</td>
                        <td className="mono">{(row.errors || []).map((e) => e.message).join("; ") || "—"}</td>
                        <td className="mono">{JSON.stringify(row.transformed || {}).slice(0, 80)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {validation ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Validation · {validation.valid ? "valid" : "invalid"}</h3>
                <div className="mono">{(validation.errors || []).map((e) => e.message).join("; ") || "No errors."}</div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "definitions" ? (
        <>
          <div className="panel">
            <h3>Create a migration definition</h3>
            <div className="grid">
              <label className="field"><span>Code</span><input name="code" value={definitionForm.code} onChange={onChangeDefinition} /></label>
              <label className="field"><span>Name</span><input name="name" value={definitionForm.name} onChange={onChangeDefinition} /></label>
              <label className="field"><span>Source object type</span><input name="source_object_type" value={definitionForm.source_object_type} onChange={onChangeDefinition} placeholder="Part" /></label>
              <label className="field"><span>Target object type</span><input name="target_object_type" value={definitionForm.target_object_type} onChange={onChangeDefinition} placeholder="product" /></label>
              <label className="field"><span>Description</span><input name="description" value={definitionForm.description} onChange={onChangeDefinition} /></label>
            </div>
            <button className="btn" disabled={busy} onClick={() => run(() => migration.createDefinition(definitionForm), "Definition created.")}>Create</button>
          </div>

          <div className="panel">
            <h3>Definitions ({definitions.length})</h3>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Source</th><th>Target</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {definitions.map((def) => (
                  <tr key={def.code}>
                    <td className="mono">{def.code}</td>
                    <td>{def.name}</td>
                    <td className="mono">{def.source_object_type || "—"}</td>
                    <td className="mono">{def.target_object_type}</td>
                    <td><Badge tone={toneFor(def.status)}>{def.status}</Badge></td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.validateDefinition(def.code), "Definition validated.")}>Validate</button>
                      {def.status === "DRAFT" ? (
                        <button className="chip link-btn" disabled={busy}
                          onClick={() => run(() => migration.setDefinitionStatus(def.code, "ACTIVE"), "Definition activated.")}>Activate</button>
                      ) : null}
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.runDefinition(def.code, { mode: "EXECUTE" }), "Definition run submitted.")}>Run</button>
                    </td>
                  </tr>
                ))}
                {!definitions.length ? <tr><td colSpan={6} className="mono">No definitions.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "planning" ? (
        <div className="panel">
          <h3>Execution plans ({plans.length})</h3>
          <table className="table">
            <thead><tr><th>Ref</th><th>Status</th><th>Packages</th><th>Ready</th><th>Blocked</th><th></th></tr></thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.plan_ref}>
                  <td className="mono">{plan.plan_ref}</td>
                  <td><Badge tone={toneFor(plan.status)}>{plan.status}</Badge></td>
                  <td>{plan.summary?.package_count ?? "—"}</td>
                  <td>{plan.summary?.ready_count ?? "—"}</td>
                  <td>{plan.summary?.blocked_count ?? "—"}</td>
                  <td>
                    {plan.status === "READY" ? (
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.approvePlan(plan.plan_ref), "Plan approved.")}>Approve</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!plans.length ? <tr><td colSpan={6} className="mono">No plans. Generate one from the Projects tab.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "jobs" ? (
        <>
          <div className="panel">
            <h3>Migration jobs ({jobs.length})</h3>
            <table className="table">
              <thead><tr><th>Ref</th><th>Mode</th><th>Status</th><th>Processed</th><th>Success</th><th>Failed</th><th></th></tr></thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.job_ref}>
                    <td className="mono">{job.job_ref}</td>
                    <td>{job.mode}</td>
                    <td><Badge tone={toneFor(job.status)}>{job.status}</Badge></td>
                    <td>{job.processed_records}</td>
                    <td>{job.success_count}</td>
                    <td>{job.failed_count}</td>
                    <td>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.executeJob(job.job_ref), "Job submitted.")}>Execute</button>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(async () => {
                          setSelectedJob(job.job_ref);
                          const res = await migration.jobErrors(job.job_ref);
                          setJobErrors(res.items || []);
                        })}>Errors</button>
                      <button className="chip link-btn" disabled={busy || !job.failed_count}
                        onClick={() => run(() => migration.retryJob(job.job_ref), "Retry submitted.")}>Retry</button>
                      <button className="chip link-btn" disabled={busy}
                        onClick={() => run(() => migration.reconcileJob(job.job_ref, { strategy: "COUNT" }), "Reconciled.")}>Reconcile</button>
                      <button className="chip link-btn" disabled={busy || ["COMPLETED", "FAILED", "CANCELLED", "PARTIALLY_COMPLETED"].includes(job.status)}
                        onClick={() => run(() => migration.cancelJob(job.job_ref), "Cancelled.")}>Cancel</button>
                      <button className="chip link-btn" disabled={busy || job.status !== "PAUSED"}
                        onClick={() => run(() => migration.resumeJob(job.job_ref), "Resumed.")}>Resume</button>
                      <button className="chip link-btn" disabled={busy || !["QUEUED", "RUNNING", "VALIDATING", "RETRYING"].includes(job.status)}
                        onClick={() => run(() => migration.pauseJob(job.job_ref), "Paused.")}>Pause</button>
                    </td>
                  </tr>
                ))}
                {!jobs.length ? <tr><td colSpan={7} className="mono">No migration jobs.</td></tr> : null}
              </tbody>
            </table>
            {selectedJob && jobErrors.length ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>Errors · {selectedJob} ({jobErrors.length})</h3>
                <table className="table">
                  <thead><tr><th>Category</th><th>Type</th><th>Message</th><th>Retryable</th></tr></thead>
                  <tbody>
                    {jobErrors.map((entry) => (
                      <tr key={entry.id}>
                        <td className="mono">{entry.category}</td>
                        <td className="mono">{entry.error_type}</td>
                        <td>{entry.message}</td>
                        <td>{entry.retryable ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <h3>Checkpoints</h3>
            {selectedJob ? (
              <button className="btn secondary" disabled={busy}
                onClick={() => run(async () => {
                  const res = await migration.jobCheckpoints(selectedJob);
                  setNotice(`${res.total} checkpoint(s) for ${selectedJob}.`);
                })}>Load checkpoints for {selectedJob}</button>
            ) : <div className="mono">Select a job’s Errors to focus it.</div>}
          </div>
        </>
      ) : null}

      {tab === "mappings" ? (
        <>
          <div className="panel">
            <h3>Identifier mappings ({identifiers.length})</h3>
            <table className="table">
              <thead><tr><th>Source system</th><th>Source type</th><th>Source id</th><th>Target type</th><th>Target id</th><th>Status</th></tr></thead>
              <tbody>
                {identifiers.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.source_system || "—"}</td>
                    <td className="mono">{entry.source_object_type || "—"}</td>
                    <td className="mono">{entry.source_object_id}</td>
                    <td className="mono">{entry.target_object_type || "—"}</td>
                    <td className="mono">{entry.target_object_id || "—"}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  </tr>
                ))}
                {!identifiers.length ? <tr><td colSpan={6} className="mono">No identifier mappings.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>File migrations ({files.length})</h3>
            <table className="table">
              <thead><tr><th>Filename</th><th>Source object</th><th>Target object</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>
                {files.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.original_filename || "—"}</td>
                    <td className="mono">{entry.source_object_id || "—"}</td>
                    <td className="mono">{entry.target_object_id || "—"}</td>
                    <td>{entry.file_size}</td>
                    <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                  </tr>
                ))}
                {!files.length ? <tr><td colSpan={5} className="mono">No file migrations.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "reconciliation" ? (
        <div className="panel">
          <h3>Reconciliations ({reconciliations.length})</h3>
          <table className="table">
            <thead><tr><th>Ref</th><th>Strategy</th><th>Source</th><th>Migrated</th><th>Variance</th><th>Status</th></tr></thead>
            <tbody>
              {reconciliations.map((entry) => (
                <tr key={entry.reconciliation_ref}>
                  <td className="mono">{entry.reconciliation_ref}</td>
                  <td>{entry.strategy}</td>
                  <td>{entry.source_count}</td>
                  <td>{entry.successful_count}</td>
                  <td>{entry.variance}</td>
                  <td><Badge tone={toneFor(entry.status)}>{entry.status}</Badge></td>
                </tr>
              ))}
              {!reconciliations.length ? <tr><td colSpan={6} className="mono">No reconciliations. Run one from the Jobs tab.</td></tr> : null}
            </tbody>
          </table>
          <div className="mono" style={{ marginTop: 8 }}>
            Strategies: {reconciliationStrategies.join(", ")}
          </div>
        </div>
      ) : null}

      {tab === "audit" ? (
        <div className="panel">
          <h3>Migration audit trail ({audit.length})</h3>
          <table className="table">
            <thead><tr><th>Action</th><th>Object type</th><th>Object</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.action}</td>
                  <td className="mono">{entry.resource_type || "—"}</td>
                  <td className="mono">{entry.resource_id || "—"}</td>
                  <td><Badge tone={entry.status === "FAILED" ? "danger" : undefined}>{entry.status || "—"}</Badge></td>
                  <td className="mono">{entry.created_at}</td>
                </tr>
              ))}
              {!audit.length ? <tr><td colSpan={5} className="mono">No audit entries.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "configuration" ? (
        <div className="panel">
          <h3>Configuration</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {Object.entries(configuration).map(([key, value]) => (
                <ConfigRow key={key} name={key} value={value} busy={busy} onSave={(next) => run(() => migration.setConfiguration(key, next), "Configuration updated.")} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {selectedJobRow ? null : null}
    </>
  );
}

function ConfigRow({ name, value, busy, onSave }) {
  const [draft, setDraft] = useState(Array.isArray(value) ? value.join(", ") : String(value));
  const isArray = Array.isArray(value);
  const isBoolean = typeof value === "boolean";
  return (
    <tr>
      <td className="mono">{name}</td>
      <td>
        {isBoolean ? (
          <select value={String(draft)} onChange={(event) => setDraft(event.target.value)}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        )}
      </td>
      <td>
        <button className="chip link-btn" disabled={busy}
          onClick={() => {
            let next = draft;
            if (isBoolean) next = draft === "true";
            else if (isArray) next = draft.split(",").map((part) => part.trim()).filter(Boolean);
            else if (typeof value === "number") next = Number(draft);
            onSave(next);
          }}>Save</button>
      </td>
    </tr>
  );
}
