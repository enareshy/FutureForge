import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

const TABS = [
  "Overview",
  "Plants",
  "Processes",
  "Operations",
  "Quality issues",
  "Inspections",
  "Actions",
  "Suppliers",
  "Analytics",
  "Impact",
];

const TONES = {
  active: "active",
  released: "succeeded",
  passed: "succeeded",
  verified: "succeeded",
  closed: "succeeded",
  draft: "draft",
  in_review: "pending",
  in_progress: "pending",
  investigating: "pending",
  planned: "pending",
  contained: "pending",
  obsolete: "deprecated",
  superseded: "deprecated",
  failed: "locked",
  critical: "locked",
  cancelled: "disabled",
  archived: "disabled",
};

function toneFor(value) {
  return TONES[value];
}

function Badge({ value }) {
  return (
    <span className={`badge${toneFor(value) ? ` ${toneFor(value)}` : ""}`}>
      {value || "-"}
    </span>
  );
}

function Table({ columns, rows, empty, keyField = "id" }) {
  if (!rows?.length) return <p className="subtle">{empty || "No rows."}</p>;
  return (
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row[keyField] ?? index}>
            {columns.map((col) => (
              <td key={col.key} className={col.mono ? "mono" : undefined}>
                {col.render ? col.render(row) : row[col.key] ?? "-"}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AiManufacturingQualityPage() {
  const [tab, setTab] = useState("Overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState(null);
  const [qualityStats, setQualityStats] = useState(null);

  const [plants, setPlants] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [processQuery, setProcessQuery] = useState("");
  const [selectedProcess, setSelectedProcess] = useState(null);
  const [structure, setStructure] = useState(null);
  const [validation, setValidation] = useState(null);

  const [operations, setOperations] = useState([]);
  const [issues, setIssues] = useState([]);
  const [issueQuery, setIssueQuery] = useState("");
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [traceability, setTraceability] = useState(null);

  const [inspections, setInspections] = useState([]);
  const [actions, setActions] = useState([]);
  const [suppliers, setSuppliers] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsKind, setAnalyticsKind] = useState("issues_by_product");
  const [repeat, setRepeat] = useState(null);
  const [impactId, setImpactId] = useState("");
  const [impact, setImpact] = useState(null);

  async function guard(fn) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadOverview() {
    const [mfg, quality] = await Promise.all([
      guard(() => ai.manufacturingStats()),
      guard(() => ai.qualityStats()),
    ]);
    if (mfg) setStats(mfg);
    if (quality) setQualityStats(quality);
  }

  async function loadPlants() {
    const page = await guard(() => ai.manufacturingPlants({ limit: 50 }));
    if (page) setPlants(page.items || []);
  }

  async function loadProcesses() {
    const params = { limit: 50 };
    if (processQuery) params.query = processQuery;
    const page = await guard(() => ai.manufacturingProcesses(params));
    if (page) setProcesses(page.items || []);
  }

  async function selectProcess(process) {
    setSelectedProcess(process);
    setStructure(null);
    setValidation(null);
  }

  async function expandProcess() {
    if (!selectedProcess) return;
    const data = await guard(() =>
      ai.manufacturingProcessStructure(selectedProcess.id, {
        max_depth: 5,
        limit: 500,
      }),
    );
    if (data) setStructure(data);
  }

  async function validateProcess() {
    if (!selectedProcess) return;
    const data = await guard(() =>
      ai.manufacturingProcessValidate(selectedProcess.id),
    );
    if (data) setValidation(data);
  }

  async function loadOperations() {
    const page = await guard(() => ai.manufacturingOperations({ limit: 100 }));
    if (page) setOperations(page.items || []);
  }

  async function loadIssues() {
    const params = { limit: 50 };
    if (issueQuery) params.query = issueQuery;
    const page = await guard(() => ai.qualityIssues(params));
    if (page) setIssues(page.items || []);
  }

  async function selectIssue(issue) {
    setSelectedIssue(issue);
    setTraceability(null);
  }

  async function loadTraceability() {
    if (!selectedIssue) return;
    const data = await guard(() =>
      ai.qualityIssueTraceability(selectedIssue.id),
    );
    if (data) setTraceability(data);
  }

  async function loadInspections() {
    const page = await guard(() => ai.qualityInspections({ limit: 50 }));
    if (page) setInspections(page.items || []);
  }

  async function loadActions() {
    const page = await guard(() => ai.qualityActions({ limit: 50 }));
    if (page) setActions(page.items || []);
  }

  async function loadSuppliers() {
    const data = await guard(() => ai.qualitySupplierQuality());
    if (data) setSuppliers(data);
  }

  async function loadAnalytics() {
    const [data, repeated] = await Promise.all([
      guard(() => ai.qualityAnalytics(analyticsKind)),
      guard(() => ai.qualityRepeatIssues({ window_days: 90 })),
    ]);
    if (data) setAnalytics(data);
    if (repeated) setRepeat(repeated);
  }

  async function runImpact(e) {
    e.preventDefault();
    if (!impactId) return;
    setImpact(null);
    const data = await guard(() =>
      ai.qualityImpact({ entity_id: Number(impactId), max_depth: 3 }),
    );
    if (data) setImpact(data);
  }

  useEffect(() => {
    loadOverview();
    loadPlants();
    loadProcesses();
    loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "Operations" && !operations.length) loadOperations();
    if (tab === "Inspections" && !inspections.length) loadInspections();
    if (tab === "Actions" && !actions.length) loadActions();
    if (tab === "Suppliers" && !suppliers) loadSuppliers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Manufacturing & quality intelligence</h1>
          <p className="sub">
            Tenant-scoped manufacturing plants, process plans, quality issues,
            inspections and CAPA linked to the knowledge graph. Analytics and
            impact analysis honor object-level authorization.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {stats ? (
        <div className="row" style={{ gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
          <div><span className="muted">Plants</span> <strong>{stats.plants}</strong></div>
          <div><span className="muted">Lines</span> <strong>{stats.production_lines}</strong></div>
          <div><span className="muted">Work centres</span> <strong>{stats.work_centres}</strong></div>
          <div><span className="muted">Processes</span> <strong>{stats.processes}</strong></div>
          <div><span className="muted">Operations</span> <strong>{stats.operations}</strong></div>
          <div><span className="muted">Coverage</span> <strong>{stats.documented_coverage}</strong></div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "" : "ghost"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h3>Manufacturing</h3>
              <button className="btn ghost" onClick={loadOverview} disabled={busy}>
                Refresh
              </button>
            </div>
            {stats ? (
              <ul className="detail-list">
                <li>Plants: {stats.plants}</li>
                <li>Production lines: {stats.production_lines}</li>
                <li>Work centres: {stats.work_centres}</li>
                <li>Processes: {stats.processes}</li>
                <li>Operations: {stats.operations}</li>
                <li>Work instructions: {stats.work_instructions}</li>
                <li>Resources: {stats.resources}</li>
                <li>Production versions: {stats.production_versions}</li>
                <li>Operations without instructions: {stats.operations_without_instructions}</li>
              </ul>
            ) : (
              <p className="subtle">Load manufacturing statistics.</p>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Quality</h3>
              <button className="btn ghost" onClick={loadOverview} disabled={busy}>
                Refresh
              </button>
            </div>
            {qualityStats ? (
              <ul className="detail-list">
                <li>Issues: {qualityStats.issues}</li>
                <li>Open issues: {qualityStats.open_issues}</li>
                <li>Critical issues: {qualityStats.critical_issues}</li>
                <li>Inspections: {qualityStats.inspections}</li>
                <li>Failed inspections: {qualityStats.failed_inspections}</li>
                <li>Actions: {qualityStats.actions}</li>
                <li>Overdue actions: {qualityStats.overdue_actions}</li>
                <li>Effective actions: {qualityStats.effective_actions}</li>
                <li>Supplier issues: {qualityStats.supplier_issues}</li>
              </ul>
            ) : (
              <p className="subtle">Load quality statistics.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Plants" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Plants</h3>
            <button className="btn ghost" onClick={loadPlants} disabled={busy}>
              Refresh
            </button>
          </div>
          <Table
            rows={plants}
            columns={[
              { key: "plant_key", label: "Key", mono: true },
              { key: "name", label: "Name" },
              { key: "site_code", label: "Site" },
              { key: "country", label: "Country" },
              { key: "lifecycle_status", label: "Lifecycle", render: (row) => <Badge value={row.lifecycle_status} /> },
            ]}
          />
        </div>
      ) : null}

      {tab === "Processes" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Processes</h3></div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                loadProcesses();
              }}
            >
              <input
                placeholder="Search key or name"
                value={processQuery}
                onChange={(e) => setProcessQuery(e.target.value)}
              />
              <button className="btn ghost" disabled={busy}>Search</button>
            </form>
            {!processes.length ? (
              <p className="subtle">No processes.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Key</th><th>Type</th><th>Name</th><th>Lifecycle</th></tr>
                </thead>
                <tbody>
                  {processes.map((process) => (
                    <tr
                      key={process.id}
                      className={selectedProcess?.id === process.id ? "valid" : ""}
                    >
                      <td>
                        <button
                          className="link-btn"
                          onClick={() => selectProcess(process)}
                        >
                          {process.process_key}
                        </button>
                      </td>
                      <td className="mono">{process.process_type}</td>
                      <td>{process.name || "-"}</td>
                      <td><Badge value={process.lifecycle_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Process detail</h3></div>
            {!selectedProcess ? (
              <p className="subtle">Select a process to inspect it.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>ID: {selectedProcess.id}</li>
                  <li>Key: {selectedProcess.process_key}</li>
                  <li>Type: <span className="mono">{selectedProcess.process_type}</span></li>
                  <li>Lifecycle: <Badge value={selectedProcess.lifecycle_status} /></li>
                  <li>Plant: {selectedProcess.plant_id ?? "-"}</li>
                  <li>Graph entity: {selectedProcess.graph_entity_id ?? "-"}</li>
                </ul>
                <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                  <button className="btn" onClick={expandProcess} disabled={busy}>
                    Expand
                  </button>
                  <button className="btn ghost" onClick={validateProcess} disabled={busy}>
                    Validate
                  </button>
                </div>
                {structure ? (
                  <>
                    <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                      <span className="muted">Operations: <strong>{structure.total}</strong></span>
                      {structure.truncated ? <span className="badge pending">truncated</span> : null}
                      {structure.cycle_detected ? <span className="badge deprecated">cycle</span> : null}
                    </div>
                    <Table
                      rows={structure.operations}
                      keyField="operation_id"
                      columns={[
                        { key: "sequence", label: "Seq" },
                        { key: "operation_key", label: "Operation", mono: true },
                        { key: "name", label: "Name" },
                        { key: "depth", label: "Depth" },
                        { key: "has_instruction", label: "Instruction", render: (row) => (row.has_instruction ? "yes" : "no") },
                      ]}
                    />
                  </>
                ) : null}
                {validation ? (
                  <>
                    <div className="row" style={{ gap: 16, margin: "12px 0 8px" }}>
                      <span className="muted">Status: <Badge value={validation.status} /></span>
                      <span className="muted">Score: <strong>{validation.score}</strong></span>
                    </div>
                    {!validation.checks?.length ? (
                      <p className="subtle">No validation findings.</p>
                    ) : (
                      <ul className="detail-list">
                        {validation.checks.map((check, index) => (
                          <li key={`${check.rule}-${index}`}>
                            <Badge value={check.severity} />{" "}
                            <span className="mono">{check.rule}</span> {check.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Operations" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Operations</h3>
            <button className="btn ghost" onClick={loadOperations} disabled={busy}>
              Refresh
            </button>
          </div>
          <Table
            rows={operations}
            columns={[
              { key: "sequence", label: "Seq" },
              { key: "operation_key", label: "Operation", mono: true },
              { key: "name", label: "Name" },
              { key: "operation_type", label: "Type" },
              { key: "work_centre_id", label: "Work centre" },
              { key: "lifecycle_status", label: "Lifecycle", render: (row) => <Badge value={row.lifecycle_status} /> },
            ]}
          />
        </div>
      ) : null}

      {tab === "Quality issues" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Quality issues</h3></div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                loadIssues();
              }}
            >
              <input
                placeholder="Search key or title"
                value={issueQuery}
                onChange={(e) => setIssueQuery(e.target.value)}
              />
              <button className="btn ghost" disabled={busy}>Search</button>
            </form>
            {!issues.length ? (
              <p className="subtle">No quality issues.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Key</th><th>Type</th><th>Severity</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {issues.map((issue) => (
                    <tr
                      key={issue.id}
                      className={selectedIssue?.id === issue.id ? "valid" : ""}
                    >
                      <td>
                        <button
                          className="link-btn"
                          onClick={() => selectIssue(issue)}
                        >
                          {issue.issue_key}
                        </button>
                      </td>
                      <td className="mono">{issue.issue_type}</td>
                      <td><Badge value={issue.severity} /></td>
                      <td><Badge value={issue.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Traceability</h3>
              <button
                className="btn ghost"
                onClick={loadTraceability}
                disabled={busy || !selectedIssue}
              >
                Trace
              </button>
            </div>
            {!selectedIssue ? (
              <p className="subtle">Select an issue to trace it.</p>
            ) : traceability ? (
              <ul className="detail-list">
                <li>Issue: {traceability.issue?.issue_key} <Badge value={traceability.issue?.status} /></li>
                <li>Product: {traceability.product?.key ?? "-"}</li>
                <li>Component: {traceability.component?.key ?? "-"}</li>
                <li>Process: {traceability.process?.key ?? "-"}</li>
                <li>Operation: {traceability.operation?.key ?? "-"}</li>
                <li>Plant: {traceability.plant?.key ?? "-"}</li>
                <li>Work centre: {traceability.work_centre?.key ?? "-"}</li>
                <li>Root causes: {traceability.root_causes?.length ?? 0}</li>
                <li>Actions: {traceability.actions?.length ?? 0}</li>
                <li>Inspections: {traceability.inspections?.length ?? 0}</li>
                <li>Work instructions: {traceability.work_instructions?.length ?? 0}</li>
              </ul>
            ) : (
              <p className="subtle">Run traceability.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Inspections" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Inspections</h3>
            <button className="btn ghost" onClick={loadInspections} disabled={busy}>
              Refresh
            </button>
          </div>
          <Table
            rows={inspections}
            columns={[
              { key: "inspection_key", label: "Key", mono: true },
              { key: "inspection_type", label: "Type" },
              { key: "status", label: "Status", render: (row) => <Badge value={row.status} /> },
              { key: "sample_size", label: "Sample" },
              { key: "passed_count", label: "Passed" },
              { key: "failed_count", label: "Failed" },
            ]}
          />
        </div>
      ) : null}

      {tab === "Actions" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Corrective / preventive actions</h3>
            <button className="btn ghost" onClick={loadActions} disabled={busy}>
              Refresh
            </button>
          </div>
          <Table
            rows={actions}
            columns={[
              { key: "action_key", label: "Key", mono: true },
              { key: "action_type", label: "Type" },
              { key: "status", label: "Status", render: (row) => <Badge value={row.status} /> },
              { key: "effectiveness", label: "Effectiveness", render: (row) => <Badge value={row.effectiveness} /> },
              { key: "owner_user", label: "Owner" },
              { key: "due_at", label: "Due" },
            ]}
          />
        </div>
      ) : null}

      {tab === "Suppliers" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Supplier quality</h3>
            <button className="btn ghost" onClick={loadSuppliers} disabled={busy}>
              Refresh
            </button>
          </div>
          {suppliers ? (
            <Table
              rows={suppliers.rows}
              keyField="supplier_ref"
              columns={[
                { key: "supplier_ref", label: "Supplier", mono: true },
                { key: "supplier_name", label: "Name" },
                { key: "issue_count", label: "Issues" },
                { key: "defect_count", label: "Defects" },
                { key: "affected_components", label: "Components" },
                { key: "open_issues", label: "Open" },
              ]}
            />
          ) : (
            <p className="subtle">Load supplier quality.</p>
          )}
        </div>
      ) : null}

      {tab === "Analytics" ? (
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>Quality analytics</h3>
              <div className="row" style={{ gap: 8 }}>
                <select
                  value={analyticsKind}
                  onChange={(e) => setAnalyticsKind(e.target.value)}
                >
                  {[
                    "issues_by_product",
                    "issues_by_part",
                    "defects_by_supplier",
                    "defects_by_plant",
                    "defects_by_work_centre",
                    "defects_by_operation",
                    "open_vs_closed",
                    "capa_effectiveness",
                    "issue_trends",
                    "issue_concentration",
                  ].map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
                <button className="btn ghost" onClick={loadAnalytics} disabled={busy}>
                  Load
                </button>
              </div>
            </div>
            {analytics ? (
              <Table
                rows={analytics.rows}
                keyField="key"
                columns={[
                  { key: "key", label: "Key", mono: true },
                  { key: "label", label: "Label" },
                  { key: "count", label: "Count" },
                  { key: "severity", label: "Worst severity", render: (row) => (row.severity ? <Badge value={row.severity} /> : "-") },
                ]}
              />
            ) : (
              <p className="subtle">Load analytics.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Repeat nonconformances</h3></div>
            {repeat ? (
              <Table
                rows={repeat.groups}
                keyField="signature"
                columns={[
                  { key: "signature", label: "Signature", mono: true },
                  { key: "occurrences", label: "Occurrences" },
                  { key: "failure_code", label: "Failure code" },
                  { key: "reason", label: "Reason" },
                ]}
              />
            ) : (
              <p className="subtle">Load analytics to see repeat issues.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Impact" ? (
        <div className="panel">
          <div className="panel-head"><h3>Quality impact</h3></div>
          <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={runImpact}>
            <input
              placeholder="Graph entity id"
              value={impactId}
              onChange={(e) => setImpactId(e.target.value)}
              style={{ width: 160 }}
            />
            <button className="btn" disabled={busy}>Analyze</button>
          </form>
          {impact ? (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="muted">Affected: <strong>{impact.affected?.length || 0}</strong></span>
                {impact.inferred ? <span className="badge pending">inferred</span> : null}
                {impact.truncated ? <span className="badge pending">truncated</span> : null}
              </div>
              <Table
                rows={impact.affected}
                keyField="entity_id"
                columns={[
                  { key: "stable_key", label: "Entity", mono: true },
                  { key: "entity_type", label: "Type" },
                  { key: "name", label: "Name" },
                  { key: "impact", label: "Impact", render: (row) => <Badge value={row.impact} /> },
                  { key: "reason", label: "Reason" },
                ]}
              />
            </>
          ) : (
            <p className="subtle">Enter a graph entity id.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
