import React, { useEffect, useState } from "react";
import { dataGovernance, dataQuality } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "domains", label: "Domains & catalogue" },
  { key: "rules", label: "Quality rules" },
  { key: "results", label: "Results & scores" },
  { key: "exceptions", label: "Exceptions" },
  { key: "duplicates", label: "Duplicates" },
];

const emptyDomain = { code: "", name: "", description: "", category: "master" };
const emptyRule = {
  code: "",
  name: "",
  object_type: "product",
  attribute_name: "",
  rule_type: "REQUIRED",
  severity: "warning",
  status: "draft",
};
const emptyMatchRule = { code: "", name: "", object_type: "product", attributes: "", strategy: "normalized" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function statusTone(status) {
  if (status === "EXCELLENT" || status === "GOOD") return "ok";
  if (status === "WARNING" || status === "POOR") return "warn";
  return "danger";
}

export default function DataGovernancePage() {
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [vocab, setVocab] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [scores, setScores] = useState(null);
  const [typeScores, setTypeScores] = useState([]);
  const [domains, setDomains] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [rules, setRules] = useState([]);
  const [results, setResults] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [exceptionSummary, setExceptionSummary] = useState(null);
  const [matchRules, setMatchRules] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [domainScores, setDomainScores] = useState([]);

  const [domainForm, setDomainForm] = useState(emptyDomain);
  const [ruleForm, setRuleForm] = useState(emptyRule);
  const [matchRuleForm, setMatchRuleForm] = useState(emptyMatchRule);

  async function refresh() {
    setError("");
    try {
      const [meta, m, s, ts, d, c, r, res, ex, exs, mr, cand] = await Promise.all([
        dataQuality.meta(),
        dataGovernance.metrics(),
        dataQuality.scores(),
        dataQuality.typeScores(),
        dataGovernance.domains(),
        dataGovernance.catalog(),
        dataQuality.rules(),
        dataQuality.results("?pageSize=25"),
        dataQuality.exceptions("?pageSize=25"),
        dataQuality.exceptionSummary(),
        dataQuality.matchRules(),
        dataQuality.candidates("?status=open"),
      ]);
      setVocab(meta);
      setMetrics(m);
      setScores(s);
      setTypeScores(ts.items || []);
      setDomains(d.items || []);
      setCatalog(c.items || []);
      setRules(r.items || []);
      setResults(res.items || []);
      setExceptions(ex.items || []);
      setExceptionSummary(exs);
      setMatchRules(mr.items || []);
      setCandidates(cand.items || []);
      const ds = await dataQuality.domainScores();
      setDomainScores(ds.items || []);
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

  async function createDomain(event) {
    event.preventDefault();
    await run(async () => {
      await dataGovernance.createDomain(domainForm);
      setDomainForm(emptyDomain);
    });
  }

  async function createRule(event) {
    event.preventDefault();
    await run(async () => {
      const expression = ruleForm.attribute_name
        ? { attribute: ruleForm.attribute_name, operator: "is_not_null" }
        : undefined;
      await dataQuality.createRule({
        code: ruleForm.code,
        name: ruleForm.name || ruleForm.code,
        object_type: ruleForm.object_type,
        attribute_name: ruleForm.attribute_name,
        rule_type: ruleForm.rule_type,
        severity: ruleForm.severity,
        status: ruleForm.status,
        ...(expression ? { expression } : {}),
      });
      setRuleForm(emptyRule);
    });
  }

  async function createMatchRule(event) {
    event.preventDefault();
    await run(async () => {
      await dataQuality.createMatchRule({
        ...matchRuleForm,
        attributes: matchRuleForm.attributes
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      setMatchRuleForm(emptyMatchRule);
    });
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Data governance</div>
          <h1>Data governance &amp; data quality</h1>
          <p className="sub">
            Centralized domains, ownership, policies, quality rules, scoring, exceptions and duplicate detection. Every
            business module registers its data definitions here instead of building its own quality engine.
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
                  <h3>Domains</h3>
                  <div className="mono">{metrics.counters.domains}</div>
                </div>
                <div className="panel grow">
                  <h3>Quality rules</h3>
                  <div className="mono">
                    {metrics.counters.active_rules} active / {metrics.counters.rules} total
                  </div>
                </div>
                <div className="panel grow">
                  <h3>Objects evaluated</h3>
                  <div className="mono">{scores ? scores.objects : 0}</div>
                </div>
                <div className="panel grow">
                  <h3>Open exceptions</h3>
                  <div className="mono">{metrics.counters.exceptions_open}</div>
                </div>
                <div className="panel grow">
                  <h3>Duplicate candidates</h3>
                  <div className="mono">{metrics.counters.duplicate_candidates_open}</div>
                </div>
              </>
            ) : (
              <div className="panel grow mono">Loading…</div>
            )}
          </div>

          <div className="panel">
            <h3>Quality by object type</h3>
            {typeScores.length ? (
              typeScores.map((row) => (
                <div className="row" key={row.object_type}>
                  <div className="grow mono">
                    <Badge tone={statusTone(row.quality_status)}>{row.quality_status || "UNKNOWN"}</Badge> {row.object_type} ·{" "}
                    {row.average_score != null ? `${row.average_score}` : "n/a"} · {row.objects} object(s)
                  </div>
                </div>
              ))
            ) : (
              <div className="mono">No quality results yet. Run an evaluation from the Results tab.</div>
            )}
          </div>

          <div className="panel">
            <h3>Quality by domain</h3>
            {domainScores.length ? (
              domainScores.map((row) => (
                <div className="row" key={row.domain_id ?? "unassigned"}>
                  <div className="grow mono">
                    domain #{row.domain_id ?? "unassigned"} · {row.average_score != null ? `${row.average_score}` : "n/a"} ·{" "}
                    {row.objects} object(s)
                  </div>
                  <div className="chips">
                    {Object.entries(row.by_status || {}).map(([status, count]) => (
                      <Badge key={status} tone={statusTone(status)}>
                        {status} · {count}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="mono">No domain scores yet.</div>
            )}
          </div>

          {scores && scores.by_status ? (
            <div className="panel">
              <h3>Overall status distribution</h3>
              <div className="chips">
                {Object.entries(scores.by_status).length ? (
                  Object.entries(scores.by_status).map(([status, count]) => (
                    <Badge key={status} tone={statusTone(status)}>
                      {status} · {count}
                    </Badge>
                  ))
                ) : (
                  <span className="mono">No evaluations recorded.</span>
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "domains" ? (
        <>
          <form className="panel" onSubmit={createDomain}>
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={domainForm.code} onChange={(e) => setDomainForm({ ...domainForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={domainForm.name} onChange={(e) => setDomainForm({ ...domainForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Category</span>
                <input value={domainForm.category} onChange={(e) => setDomainForm({ ...domainForm, category: e.target.value })} />
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Create domain
            </button>
          </form>

          <div className="panel">
            <h3>Domains ({domains.length})</h3>
            {domains.map((domain) => (
              <div className="row" key={domain.id}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={domain.status === "active" ? "ok" : undefined}>{domain.status}</Badge> {domain.code} · {domain.name}
                  </div>
                  {domain.path ? <div className="mono muted">{domain.path}</div> : null}
                </div>
              </div>
            ))}
            {domains.length === 0 ? <div className="mono">No domains registered.</div> : null}
          </div>

          <div className="panel">
            <h3>Catalogued object types ({catalog.length})</h3>
            {catalog.map((entry) => (
              <div className="row" key={entry.id}>
                <div className="grow mono">
                  {entry.object_type} · {entry.name} · {entry.attribute_count ?? 0} attribute(s)
                </div>
              </div>
            ))}
            {catalog.length === 0 ? <div className="mono">No object types catalogued.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "rules" ? (
        <>
          <form className="panel" onSubmit={createRule}>
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={ruleForm.code} onChange={(e) => setRuleForm({ ...ruleForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Object type</span>
                <input value={ruleForm.object_type} onChange={(e) => setRuleForm({ ...ruleForm, object_type: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                <span>Attribute</span>
                <input value={ruleForm.attribute_name} onChange={(e) => setRuleForm({ ...ruleForm, attribute_name: e.target.value })} />
              </label>
              <label className="field">
                <span>Rule type</span>
                <select value={ruleForm.rule_type} onChange={(e) => setRuleForm({ ...ruleForm, rule_type: e.target.value })}>
                  {(vocab?.vocabularies?.rule_types || ["REQUIRED"]).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Severity</span>
                <select value={ruleForm.severity} onChange={(e) => setRuleForm({ ...ruleForm, severity: e.target.value })}>
                  {(vocab?.vocabularies?.severities || ["warning"]).map((severity) => (
                    <option key={severity}>{severity}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Status</span>
                <select value={ruleForm.status} onChange={(e) => setRuleForm({ ...ruleForm, status: e.target.value })}>
                  {(vocab?.vocabularies?.rule_statuses || ["draft"]).map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Create rule
            </button>
          </form>

          <div className="panel">
            <h3>Rules ({rules.length})</h3>
            {rules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={rule.status === "active" ? "ok" : undefined}>{rule.status}</Badge> {rule.code} · {rule.rule_type} ·{" "}
                    {rule.object_type}
                    {rule.attribute_name ? `.${rule.attribute_name}` : ""}
                  </div>
                  <div className="mono muted">
                    dimension={rule.dimension} severity={rule.severity} {rule.description ? `· ${rule.description}` : ""}
                  </div>
                </div>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    run(() => dataQuality.setRuleStatus(rule.rule_ref, rule.status === "active" ? "inactive" : "active"))
                  }
                >
                  {rule.status === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
            {rules.length === 0 ? <div className="mono">No rules defined.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "results" ? (
        <>
          <div className="panel">
            <h3>Evaluate on demand</h3>
            <div className="row">
              {["product", "part", "document"].map((type) => (
                <button
                  key={type}
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run(() => dataQuality.evaluateBatch({ object_type: type }))}
                >
                  Evaluate {type}
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Current results ({results.length})</h3>
            {results.map((row) => (
              <div className="row" key={row.result_ref}>
                <div className="grow mono">
                  <Badge tone={statusTone(row.quality_status)}>{row.quality_status}</Badge> {row.object_type}#{row.object_id} ·
                  score {row.overall_score} · {row.violation_count} violation(s)
                </div>
              </div>
            ))}
            {results.length === 0 ? <div className="mono">No results yet.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "exceptions" ? (
        <>
          {exceptionSummary ? (
            <div className="stack-row" style={{ flexWrap: "wrap" }}>
              <div className="panel grow">
                <h3>Total</h3>
                <div className="mono">{exceptionSummary.total}</div>
              </div>
              <div className="panel grow">
                <h3>Open</h3>
                <div className="mono">{exceptionSummary.by_status?.OPEN || 0}</div>
              </div>
              <div className="panel grow">
                <h3>Overdue</h3>
                <div className="mono">{exceptionSummary.overdue}</div>
              </div>
            </div>
          ) : null}

          <div className="panel">
            <h3>Exceptions ({exceptions.length})</h3>
            {exceptions.map((row) => (
              <div className="row" key={row.exception_ref}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={row.status === "CLOSED" || row.status === "RESOLVED" ? "ok" : "warn"}>{row.status}</Badge>{" "}
                    {row.exception_ref} · {row.object_type}#{row.object_id} · {row.severity} · {row.priority}
                  </div>
                  <div className="mono muted">{row.description}</div>
                </div>
              </div>
            ))}
            {exceptions.length === 0 ? <div className="mono">No exceptions raised.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "duplicates" ? (
        <>
          <form className="panel" onSubmit={createMatchRule}>
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={matchRuleForm.code} onChange={(e) => setMatchRuleForm({ ...matchRuleForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={matchRuleForm.name} onChange={(e) => setMatchRuleForm({ ...matchRuleForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Object type</span>
                <input value={matchRuleForm.object_type} onChange={(e) => setMatchRuleForm({ ...matchRuleForm, object_type: e.target.value })} />
              </label>
              <label className="field">
                <span>Strategy</span>
                <select value={matchRuleForm.strategy} onChange={(e) => setMatchRuleForm({ ...matchRuleForm, strategy: e.target.value })}>
                  {(vocab?.duplicate_strategies || ["normalized"]).map((strategy) => (
                    <option key={strategy}>{strategy}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Attributes (comma separated)</span>
              <input value={matchRuleForm.attributes} onChange={(e) => setMatchRuleForm({ ...matchRuleForm, attributes: e.target.value })} />
            </label>
            <button className="btn" disabled={busy}>
              Create match rule
            </button>
          </form>

          <div className="panel">
            <h3>Match rules ({matchRules.length})</h3>
            <div className="row">
              <button className="btn ghost" disabled={busy} onClick={() => run(() => dataQuality.detectDuplicates({ object_type: "product" }))}>
                Scan product
              </button>
            </div>
            {matchRules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow mono">
                  {rule.code} · {rule.object_type} · {rule.strategy} · {(rule.attributes || []).join(", ")}
                </div>
              </div>
            ))}
            {matchRules.length === 0 ? <div className="mono">No match rules defined.</div> : null}
          </div>

          <div className="panel">
            <h3>Open candidates ({candidates.length})</h3>
            {candidates.map((candidate) => (
              <div className="row" key={candidate.candidate_ref}>
                <div className="grow mono">
                  {candidate.candidate_ref} · {candidate.object_type} · {candidate.strategy} · score {candidate.score}
                </div>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run(() => dataQuality.resolveCandidate(candidate.candidate_ref, { status: "CONFIRMED" }))}
                >
                  Confirm duplicate
                </button>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run(() => dataQuality.resolveCandidate(candidate.candidate_ref, { status: "DISMISSED" }))}
                >
                  Not a duplicate
                </button>
              </div>
            ))}
            {candidates.length === 0 ? <div className="mono">No duplicate candidates.</div> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
