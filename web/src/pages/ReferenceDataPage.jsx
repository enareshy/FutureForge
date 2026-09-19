import React, { useCallback, useEffect, useState } from "react";
import { referenceData } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "domains", label: "Domains" },
  { key: "values", label: "Values" },
  { key: "resolve", label: "Resolve" },
  { key: "approvals", label: "Approvals" },
  { key: "transfer", label: "Import / Export" },
];

function fmt(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

function Badge({ status }) {
  const tone =
    status === "active" || status === "approved" || status === "RESOLVED" || status === "committed"
      ? "active"
      : status === "draft" || status === "submitted" || status === "under_review" || status === "validated"
        ? "locked"
        : "inactive";
  return <span className={`badge ${tone}`}>{status}</span>;
}

const EMPTY_ITEM = { domainCode: "", code: "", name: "", description: "", status: "draft", scopeType: "GLOBAL", effectiveFrom: "", effectiveTo: "" };
const EMPTY_DOMAIN = { code: "", name: "", category: "general", description: "" };
const EMPTY_RESOLVE = { domainCode: "", code: "", alias: "", asOf: "" };

export default function ReferenceDataPage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [domains, setDomains] = useState([]);
  const [items, setItems] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [exports, setExports] = useState([]);
  const [imports, setImports] = useState([]);
  const [valuesDomain, setValuesDomain] = useState("");
  const [searchText, setSearchText] = useState("");
  const [resolved, setResolved] = useState(null);
  const [validated, setValidated] = useState(null);
  const [domainForm, setDomainForm] = useState(EMPTY_DOMAIN);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM);
  const [resolveForm, setResolveForm] = useState(EMPTY_RESOLVE);
  const [exportDomain, setExportDomain] = useState("");
  const [exportFormat, setExportFormat] = useState("json");
  const [importDomain, setImportDomain] = useState("");
  const [importRows, setImportRows] = useState("");

  const loadAll = useCallback(async () => {
    const [metaRes, metricsRes, dashRes, domainRes, approvalRes, exportRes, importRes] = await Promise.all([
      referenceData.meta(),
      referenceData.metrics(),
      referenceData.dashboard(),
      referenceData.domains("?pageSize=100"),
      referenceData.approvals("?pageSize=50"),
      referenceData.exports("?limit=50"),
      referenceData.imports("?limit=50"),
    ]);
    setMeta(metaRes);
    setMetrics(metricsRes);
    setDashboard(dashRes);
    setDomains(domainRes.items || []);
    setApprovals(approvalRes.items || []);
    setExports(exportRes.items || []);
    setImports(importRes.items || []);
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      await loadAll();
    } catch (err) {
      setError(err.message);
    }
  }, [loadAll]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadValues = useCallback(async (domainCode, text) => {
    if (!domainCode) {
      setItems([]);
      return;
    }
    const params = new URLSearchParams({ domain_code: domainCode });
    if (text) params.set("text", text);
    const res = await referenceData.search(`?${params.toString()}`);
    setItems(res.items || []);
  }, []);

  useEffect(() => {
    if (valuesDomain) {
      loadValues(valuesDomain, searchText).catch((err) => setError(err.message));
    }
  }, [valuesDomain, searchText, loadValues]);

  async function run(fn, success) {
    setError("");
    setNotice("");
    try {
      const result = await fn();
      if (success) setNotice(success);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  async function submitDomain(event) {
    event.preventDefault();
    const body = {
      code: domainForm.code.trim(),
      name: domainForm.name.trim() || domainForm.code.trim(),
      category: domainForm.category.trim() || "general",
      description: domainForm.description.trim() || undefined,
    };
    const created = await run(() => referenceData.createDomain(body), `Domain ${body.code} created.`);
    if (created) setDomainForm(EMPTY_DOMAIN);
  }

  async function submitItem(event) {
    event.preventDefault();
    const body = {
      domain_code: itemForm.domainCode.trim(),
      code: itemForm.code.trim(),
      name: itemForm.name.trim() || itemForm.code.trim(),
      description: itemForm.description.trim() || undefined,
      status: itemForm.status,
      scope_type: itemForm.scopeType,
    };
    if (itemForm.effectiveFrom) body.effective_from = itemForm.effectiveFrom;
    if (itemForm.effectiveTo) body.effective_to = itemForm.effectiveTo;
    const created = await run(() => referenceData.createItem(body), `Value ${body.code} created.`);
    if (created) {
      setItemForm({ ...EMPTY_ITEM, domainCode: itemForm.domainCode, scopeType: itemForm.scopeType });
      await loadValues(valuesDomain, searchText);
    }
  }

  async function resolve(event) {
    event.preventDefault();
    setValidated(null);
    const body = { domain_code: resolveForm.domainCode.trim() };
    if (resolveForm.code.trim()) body.code = resolveForm.code.trim();
    if (resolveForm.alias.trim()) body.alias = resolveForm.alias.trim();
    if (resolveForm.asOf) body.as_of = resolveForm.asOf;
    try {
      setError("");
      setResolved(await referenceData.resolve(body));
    } catch (err) {
      setResolved(null);
      setError(err.message);
    }
  }

  async function validate(event) {
    event.preventDefault();
    setResolved(null);
    const body = { domain_code: resolveForm.domainCode.trim(), code: resolveForm.code.trim() };
    try {
      setError("");
      setValidated(await referenceData.validate(body));
    } catch (err) {
      setValidated(null);
      setError(err.message);
    }
  }

  async function submitExport(event) {
    event.preventDefault();
    const body = { domain_code: exportDomain.trim(), format: exportFormat };
    const created = await run(() => referenceData.createExport(body), `Export ${body.domain_code} created.`);
    if (created && created.content) {
      const blob = new Blob([created.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${created.export_ref}.${created.format}`;
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  async function submitImport(event) {
    event.preventDefault();
    let rows;
    try {
      rows = JSON.parse(importRows);
    } catch {
      setError("Import rows must be valid JSON array.");
      return;
    }
    const created = await run(
      () => referenceData.createImport({ domain_code: importDomain.trim(), format: "json", rows }),
      "Import validated."
    );
    if (created) {
      await run(() => referenceData.commitImport(created.import_ref, {}), "Import committed.");
      setImportRows("");
      if (valuesDomain === importDomain) await loadValues(valuesDomain, searchText);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Enterprise reference data</h2>
          <p className="sub">Governed master and reference values with scope precedence, effectivity, approvals and versioning.</p>
        </div>
        <button className="btn ghost" type="button" onClick={refresh}>Refresh</button>
      </div>

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.key} type="button" className={`tab ${tab === item.key ? "active" : ""}`} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert">{notice}</div> : null}

      {tab === "overview" ? (
        <>
          <div className="grid">
            <div className="stat"><span>Domains</span><b>{fmt(metrics?.totals?.domains)}</b></div>
            <div className="stat"><span>Values</span><b>{fmt(metrics?.totals?.items)}</b></div>
            <div className="stat"><span>Active values</span><b>{fmt(metrics?.totals?.active_items)}</b></div>
            <div className="stat"><span>Codes</span><b>{fmt(metrics?.totals?.codes)}</b></div>
            <div className="stat"><span>Aliases</span><b>{fmt(metrics?.totals?.aliases)}</b></div>
            <div className="stat"><span>Translations</span><b>{fmt(metrics?.totals?.translations)}</b></div>
            <div className="stat"><span>Versions</span><b>{fmt(metrics?.totals?.versions)}</b></div>
            <div className="stat"><span>Pending approvals</span><b>{fmt(metrics?.totals?.pending_approvals)}</b></div>
          </div>
          <div className="split" style={{ marginTop: 16 }}>
            <div className="panel">
              <div className="panel-head"><h3>Values by domain</h3></div>
              <table className="table">
                <thead><tr><th>Domain</th><th>Values</th></tr></thead>
                <tbody>
                  {(dashboard?.top_domains || []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.code}</td>
                      <td className="mono">{row.item_count}</td>
                    </tr>
                  ))}
                  {!(dashboard?.top_domains || []).length ? <tr><td colSpan="2" className="sub">No values yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Recently updated values</h3></div>
              <table className="table">
                <thead><tr><th>Domain</th><th>Code</th><th>Name</th><th>Status</th></tr></thead>
                <tbody>
                  {(dashboard?.recent_items || []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.domain_code}</td>
                      <td className="mono">{row.code}</td>
                      <td>{row.name}</td>
                      <td><Badge status={row.status} /></td>
                    </tr>
                  ))}
                  {!(dashboard?.recent_items || []).length ? <tr><td colSpan="4" className="sub">Nothing recent.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head"><h3>Supported categories</h3></div>
            <div className="inline">
              {(meta?.categories || []).map((cat) => <span className="badge locked" key={cat}>{cat}</span>)}
            </div>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Default scope precedence</h3></div>
            <div className="inline">
              {(meta?.default_scope_precedence || []).map((scope) => <span className="badge" key={scope}>{scope}</span>)}
            </div>
          </div>
        </>
      ) : null}

      {tab === "domains" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Domains</h3></div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Scope</th><th>Status</th><th /></tr></thead>
              <tbody>
                {domains.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.code}</td>
                    <td>{row.name}</td>
                    <td className="mono">{row.category}</td>
                    <td className="mono">{row.scope_type}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="inline">
                      {row.status === "active" ? (
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.setDomainStatus(row.domain_ref, "inactive"), `${row.code} inactivated.`)}>Inactivate</button>
                      ) : (
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.setDomainStatus(row.domain_ref, "active"), `${row.code} activated.`)}>Activate</button>
                      )}
                      <button className="btn ghost" type="button" onClick={() => run(() => referenceData.reindexDomain(row.domain_ref), `${row.code} reindexed.`)}>Reindex</button>
                    </td>
                  </tr>
                ))}
                {!domains.length ? <tr><td colSpan="6" className="sub">No domains.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create domain</h3></div>
            <form onSubmit={submitDomain} className="stack">
              <label className="field"><span>Code</span><input value={domainForm.code} onChange={(e) => setDomainForm({ ...domainForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={domainForm.name} onChange={(e) => setDomainForm({ ...domainForm, name: e.target.value })} /></label>
              <label className="field">
                <span>Category</span>
                <select value={domainForm.category} onChange={(e) => setDomainForm({ ...domainForm, category: e.target.value })}>
                  {(meta?.categories || ["general"]).map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </label>
              <label className="field"><span>Description</span><input value={domainForm.description} onChange={(e) => setDomainForm({ ...domainForm, description: e.target.value })} /></label>
              <button className="btn" type="submit">Create domain</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "values" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Governed values</h3></div>
            <div className="inline" style={{ marginBottom: 12 }}>
              <label className="field"><span>Domain</span>
                <select value={valuesDomain} onChange={(e) => setValuesDomain(e.target.value)}>
                  <option value="">Select a domain...</option>
                  {domains.map((row) => <option key={row.id} value={row.code}>{row.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Search</span><input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="code, name, alias" /></label>
            </div>
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Scope</th><th>Version</th><th>Aliases</th><th>Status</th><th /></tr></thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.item_ref}>
                    <td className="mono">{row.code}</td>
                    <td>{row.name}</td>
                    <td className="mono">{row.scope_key}</td>
                    <td className="mono">{row.version}</td>
                    <td className="mono">{(row.aliases || []).join(", ") || "-"}</td>
                    <td><Badge status={row.status} /></td>
                    <td className="inline">
                      {row.status !== "active" ? (
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.activateItem(row.item_ref), `${row.code} activated.`).then(() => loadValues(valuesDomain, searchText))}>Activate</button>
                      ) : (
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.retireItem(row.item_ref), `${row.code} retired.`).then(() => loadValues(valuesDomain, searchText))}>Retire</button>
                      )}
                    </td>
                  </tr>
                ))}
                {!items.length ? <tr><td colSpan="7" className="sub">No values loaded. Choose a domain above.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Create value</h3></div>
            <form onSubmit={submitItem} className="stack">
              <label className="field">
                <span>Domain</span>
                <select value={itemForm.domainCode} onChange={(e) => setItemForm({ ...itemForm, domainCode: e.target.value })} required>
                  <option value="">Select...</option>
                  {domains.map((row) => <option key={row.id} value={row.code}>{row.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Code</span><input value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} required /></label>
              <label className="field"><span>Name</span><input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} /></label>
              <label className="field"><span>Description</span><input value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} /></label>
              <label className="field">
                <span>Status</span>
                <select value={itemForm.status} onChange={(e) => setItemForm({ ...itemForm, status: e.target.value })}>
                  {(meta?.item_statuses || ["draft", "active", "inactive"]).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="field"><span>Effective from</span><input type="date" value={itemForm.effectiveFrom} onChange={(e) => setItemForm({ ...itemForm, effectiveFrom: e.target.value })} /></label>
              <label className="field"><span>Effective to</span><input type="date" value={itemForm.effectiveTo} onChange={(e) => setItemForm({ ...itemForm, effectiveTo: e.target.value })} /></label>
              <button className="btn" type="submit">Create value</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "resolve" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Resolve value</h3></div>
            <form className="stack" onSubmit={resolve}>
              <label className="field">
                <span>Domain</span>
                <select value={resolveForm.domainCode} onChange={(e) => setResolveForm({ ...resolveForm, domainCode: e.target.value })} required>
                  <option value="">Select...</option>
                  {domains.map((row) => <option key={row.id} value={row.code}>{row.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Code</span><input value={resolveForm.code} onChange={(e) => setResolveForm({ ...resolveForm, code: e.target.value })} /></label>
              <label className="field"><span>Alias</span><input value={resolveForm.alias} onChange={(e) => setResolveForm({ ...resolveForm, alias: e.target.value })} /></label>
              <label className="field"><span>As of</span><input type="date" value={resolveForm.asOf} onChange={(e) => setResolveForm({ ...resolveForm, asOf: e.target.value })} /></label>
              <div className="inline">
                <button className="btn" type="submit">Resolve</button>
                <button className="btn ghost" type="button" onClick={validate}>Validate</button>
              </div>
            </form>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Result</h3></div>
            {resolved ? (
              <ul className="detail-list">
                <li>status: <Badge status={resolved.resolution_status} /></li>
                <li>matched by: <span className="mono">{fmt(resolved.resolution)}</span></li>
                <li>code: <span className="mono">{fmt(resolved.value?.code)}</span></li>
                <li>name: <span className="mono">{fmt(resolved.value?.name)}</span></li>
                <li>scope: <span className="mono">{fmt(resolved.value?.scope_key)}</span></li>
                <li>version: <span className="mono">{fmt(resolved.value?.version)}</span></li>
              </ul>
            ) : validated ? (
              <ul className="detail-list">
                <li>valid: <Badge status={validated.valid ? "RESOLVED" : "NOT_FOUND"} /></li>
                <li>reason: <span className="mono">{fmt(validated.reason)}</span></li>
                <li>item: <span className="mono">{fmt(validated.item_ref)}</span></li>
                <li>scope: <span className="mono">{fmt(validated.matched_scope)}</span></li>
                <li>codes: <span className="mono">{(validated.codes || []).join(", ") || "-"}</span></li>
              </ul>
            ) : (
              <p className="sub">Resolve or validate a value to see the deterministic result.</p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "approvals" ? (
        <div className="panel">
          <div className="panel-head"><h3>Approvals</h3></div>
          <table className="table">
            <thead><tr><th>Item</th><th>Status</th><th>Submitted</th><th>Decided</th><th /></tr></thead>
            <tbody>
              {approvals.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.item_code || row.item_ref || row.item_id}</td>
                  <td><Badge status={row.status} /></td>
                  <td className="mono">{fmt(row.submitted_at)}</td>
                  <td className="mono">{fmt(row.decided_at)}</td>
                  <td className="inline">
                    {row.status === "submitted" || row.status === "under_review" ? (
                      <>
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.decideApproval(row.approval_ref, { decision: "approve" }), "Approval recorded.")}>Approve</button>
                        <button className="btn ghost" type="button" onClick={() => run(() => referenceData.decideApproval(row.approval_ref, { decision: "reject" }), "Rejection recorded.")}>Reject</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!approvals.length ? <tr><td colSpan="5" className="sub">No approvals.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "transfer" ? (
        <div className="type-manager">
          <div className="panel">
            <div className="panel-head"><h3>Export</h3></div>
            <form className="stack" onSubmit={submitExport}>
              <label className="field">
                <span>Domain</span>
                <select value={exportDomain} onChange={(e) => setExportDomain(e.target.value)} required>
                  <option value="">Select...</option>
                  {domains.map((row) => <option key={row.id} value={row.code}>{row.code}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Format</span>
                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
                  {["json", "csv", "tsv"].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Export &amp; download</button>
            </form>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Recent exports</h3></div>
            <table className="table">
              <thead><tr><th>Domain</th><th>Format</th><th>Rows</th><th>Status</th></tr></thead>
              <tbody>
                {exports.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.domain_code || row.domain_id}</td>
                    <td className="mono">{row.format}</td>
                    <td className="mono">{fmt(row.row_count)}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
                {!exports.length ? <tr><td colSpan="4" className="sub">No exports.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Import (JSON rows)</h3></div>
            <form className="stack" onSubmit={submitImport}>
              <label className="field">
                <span>Domain</span>
                <select value={importDomain} onChange={(e) => setImportDomain(e.target.value)} required>
                  <option value="">Select...</option>
                  {domains.map((row) => <option key={row.id} value={row.code}>{row.code}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Rows</span>
                <textarea rows={6} value={importRows} onChange={(e) => setImportRows(e.target.value)} placeholder='[{"code":"ABC","name":"Alpha"}]' required />
              </label>
              <button className="btn" type="submit">Validate &amp; commit</button>
            </form>
            <div className="panel-head" style={{ marginTop: 16 }}><h3>Recent imports</h3></div>
            <table className="table">
              <thead><tr><th>Domain</th><th>Valid</th><th>Invalid</th><th>Status</th></tr></thead>
              <tbody>
                {imports.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.domain_code || row.domain_id}</td>
                    <td className="mono">{fmt(row.valid_rows)}</td>
                    <td className="mono">{fmt(row.invalid_rows)}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
                {!imports.length ? <tr><td colSpan="4" className="sub">No imports.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
