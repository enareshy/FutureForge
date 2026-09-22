import React, { useEffect, useMemo, useState } from "react";
import { iam, security } from "../api.js";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "policies", label: "Policies" },
  { key: "entitlements", label: "Entitlements" },
  { key: "fields", label: "Field & masking" },
  { key: "classification", label: "Classification" },
  { key: "scope", label: "Organization & plant" },
  { key: "objectTypes", label: "Object types" },
  { key: "inspector", label: "Decision inspector" },
];

const emptyPolicy = {
  code: "",
  name: "",
  scope: "object_type",
  subject_type: "everyone",
  subject_id: "",
  resource_type: "",
  action: "read",
  effect: "allow",
  priority: 100,
  condition: "",
};

const emptyEntitlement = {
  code: "",
  name: "",
  subject_type: "everyone",
  subject_id: "",
  resource_type: "",
  action: "read",
  effect: "allow",
  scope: "object_type",
  classification: "",
  priority: 100,
};

const emptyFieldRule = {
  object_type: "",
  field_name: "",
  action: "read",
  subject_type: "everyone",
  subject_id: "",
  effect: "mask",
  masking_strategy: "REDACT",
  masking_config: "",
  priority: 100,
};

function parseJson(value, label, setError) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    setError(`${label} must be valid JSON`);
    return undefined;
  }
}

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

export default function SecurityModelPage() {
  const [tab, setTab] = useState("overview");
  const [vocab, setVocab] = useState(null);
  const [overview, setOverview] = useState(null);
  const [objectTypes, setObjectTypes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [entitlements, setEntitlements] = useState([]);
  const [fieldRules, setFieldRules] = useState([]);
  const [maskingRules, setMaskingRules] = useState([]);
  const [classificationRules, setClassificationRules] = useState([]);
  const [organizationRules, setOrganizationRules] = useState([]);
  const [plantRules, setPlantRules] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [users, setUsers] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [policyForm, setPolicyForm] = useState(emptyPolicy);
  const [entitlementForm, setEntitlementForm] = useState(emptyEntitlement);
  const [fieldForm, setFieldForm] = useState(emptyFieldRule);

  const [inspection, setInspection] = useState({
    userId: "",
    action: "read",
    resource_type: "object",
    resource_id: "",
    organization_id: "",
    classification: "",
  });
  const [decision, setDecision] = useState(null);
  const [context, setContext] = useState(null);

  async function refresh() {
    setError("");
    try {
      const [v, o, ot, p, e, f, m, c, or, pr, d, u, og] = await Promise.all([
        security.vocabulary(),
        security.overview(),
        security.objectTypes(),
        security.policies(),
        security.entitlements(),
        security.fieldRules(),
        security.maskingRules(),
        security.classificationRules(),
        security.organizationRules(),
        security.plantRules(),
        security.decisions("?limit=50"),
        iam.users("?pageSize=200"),
        iam.orgs(),
      ]);
      setVocab(v);
      setOverview(o);
      setObjectTypes(ot);
      setPolicies(p);
      setEntitlements(e);
      setFieldRules(f);
      setMaskingRules(m);
      setClassificationRules(c);
      setOrganizationRules(or);
      setPlantRules(pr);
      setDecisions(d);
      setUsers(u.items || []);
      setOrgs(og.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit(create, form, resetForm) {
    setBusy(true);
    setError("");
    try {
      await create();
      resetForm();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function createPolicy(e) {
    e.preventDefault();
    const condition = parseJson(policyForm.condition, "Condition", setError);
    if (condition === undefined) return;
    submit(
      () =>
        security.createPolicy({
          ...policyForm,
          subject_id: policyForm.subject_id ? Number(policyForm.subject_id) : 0,
          priority: Number(policyForm.priority),
          condition: condition || undefined,
        }),
      policyForm,
      () => setPolicyForm(emptyPolicy)
    );
  }

  function createEntitlement(e) {
    e.preventDefault();
    submit(
      () =>
        security.createEntitlement({
          ...entitlementForm,
          subject_id: entitlementForm.subject_id ? Number(entitlementForm.subject_id) : 0,
          priority: Number(entitlementForm.priority),
        }),
      entitlementForm,
      () => setEntitlementForm(emptyEntitlement)
    );
  }

  function createFieldRule(e) {
    e.preventDefault();
    const config = parseJson(fieldForm.masking_config, "Masking config", setError);
    if (config === undefined) return;
    submit(
      () =>
        security.createFieldRule({
          ...fieldForm,
          subject_id: fieldForm.subject_id ? Number(fieldForm.subject_id) : 0,
          priority: Number(fieldForm.priority),
          masking_config: config || undefined,
        }),
      fieldForm,
      () => setFieldForm(emptyFieldRule)
    );
  }

  async function runInspection(e) {
    e.preventDefault();
    setError("");
    setDecision(null);
    setContext(null);
    try {
      const body = {
        action: inspection.action,
        resource_type: inspection.resource_type,
        resource_id: inspection.resource_id || undefined,
        organization_id: inspection.organization_id || undefined,
        classification: inspection.classification || undefined,
        user_id: inspection.userId || undefined,
      };
      const [result, ctx] = await Promise.all([
        security.evaluate(body),
        inspection.userId ? security.context(inspection.userId) : Promise.resolve(null),
      ]);
      setDecision(result);
      setContext(ctx);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  const objectTypeOptions = useMemo(
    () => objectTypes.map((type) => type.object_type),
    [objectTypes]
  );

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Data security</div>
          <h1>Security &amp; entitlement model</h1>
          <p className="sub">
            Centralized RBAC, object/field/row/organization/plant/classification security and masking. Every decision is
            server-side; the client never authorizes.
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
          <button
            key={entry.key}
            type="button"
            className={`tab ${tab === entry.key ? "active" : ""}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="stack-row" style={{ flexWrap: "wrap" }}>
            {overview ? (
              <>
                <div className="panel grow">
                  <h3>Object types</h3>
                  <div className="mono">{overview.objectTypes} registered</div>
                </div>
                <div className="panel grow">
                  <h3>Policies</h3>
                  <div className="mono">
                    {overview.activePolicies} active / {overview.policies} total
                  </div>
                </div>
                <div className="panel grow">
                  <h3>Entitlements</h3>
                  <div className="mono">{overview.entitlements}</div>
                </div>
                <div className="panel grow">
                  <h3>Field rules</h3>
                  <div className="mono">{overview.fieldRules}</div>
                </div>
                <div className="panel grow">
                  <h3>Decisions</h3>
                  <div className="mono">{overview.decisions} recorded</div>
                </div>
              </>
            ) : (
              <div className="panel grow mono">Loading…</div>
            )}
          </div>
          {overview ? (
            <div className="panel">
              <h3>Recent decision outcomes</h3>
              <div className="chips">
                {overview.decisionSummary.length ? (
                  overview.decisionSummary.map((row) => (
                    <Badge key={`${row.decision}-${row.reason}`} tone={row.decision === "allow" ? "ok" : "warn"}>
                      {row.decision} · {row.reason} · {row.count}
                    </Badge>
                  ))
                ) : (
                  <span className="mono">No decisions recorded yet.</span>
                )}
              </div>
            </div>
          ) : null}
          {vocab ? (
            <div className="panel">
              <h3>Vocabulary</h3>
              <div className="chips">
                {vocab.maskingStrategies.map((strategy) => (
                  <span className="chip" key={strategy}>
                    {strategy}
                  </span>
                ))}
              </div>
              <p className="mono">Scopes: {vocab.scopes.join(", ")}</p>
              <p className="mono">Reasons: {vocab.decisionReasons.join(", ")}</p>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "policies" ? (
        <>
          <form className="panel" onSubmit={createPolicy}>
            <div className="row">
              <label className="field grow">
                <span>Code</span>
                <input value={policyForm.code} onChange={(e) => setPolicyForm({ ...policyForm, code: e.target.value })} required />
              </label>
              <label className="field grow">
                <span>Name</span>
                <input value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Scope</span>
                <select value={policyForm.scope} onChange={(e) => setPolicyForm({ ...policyForm, scope: e.target.value })}>
                  {(vocab?.scopes || ["object_type"]).map((scope) => (
                    <option key={scope}>{scope}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject</span>
                <select value={policyForm.subject_type} onChange={(e) => setPolicyForm({ ...policyForm, subject_type: e.target.value })}>
                  {(vocab?.subjectTypes || ["everyone"]).map((subject) => (
                    <option key={subject}>{subject}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject id</span>
                <input value={policyForm.subject_id} onChange={(e) => setPolicyForm({ ...policyForm, subject_id: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                <span>Object type</span>
                <input
                  list="security-object-types"
                  value={policyForm.resource_type}
                  onChange={(e) => setPolicyForm({ ...policyForm, resource_type: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Action</span>
                <input value={policyForm.action} onChange={(e) => setPolicyForm({ ...policyForm, action: e.target.value })} />
              </label>
              <label className="field">
                <span>Effect</span>
                <select value={policyForm.effect} onChange={(e) => setPolicyForm({ ...policyForm, effect: e.target.value })}>
                  <option>allow</option>
                  <option>deny</option>
                </select>
              </label>
              <label className="field">
                <span>Priority</span>
                <input type="number" value={policyForm.priority} onChange={(e) => setPolicyForm({ ...policyForm, priority: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Condition (JSON, optional)</span>
              <textarea
                rows={2}
                value={policyForm.condition}
                onChange={(e) => setPolicyForm({ ...policyForm, condition: e.target.value })}
                placeholder='{"field":"request.authentication_method","operator":"eq","value":"sso"}'
              />
            </label>
            <button className="btn" disabled={busy}>
              Create policy
            </button>
          </form>

          <div className="panel">
            <h3>Policies ({policies.length})</h3>
            {policies.map((policy) => (
              <div className="row" key={policy.id}>
                <div className="grow">
                  <div className="mono">
                    <Badge tone={policy.effect === "allow" ? "ok" : "warn"}>{policy.effect}</Badge> {policy.code} ·{" "}
                    {policy.resource_type || "*"} · {policy.action || "*"} · {policy.subject_type}
                    {policy.subject_id ? `:${policy.subject_id}` : ""}
                  </div>
                  <div className="mono">
                    scope={policy.scope} priority={policy.priority} version={policy.version} status={policy.status}
                  </div>
                </div>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await security.setPolicyStatus(policy.id, policy.status === "active" ? "inactive" : "active");
                    refresh();
                  }}
                >
                  {policy.status === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
            {policies.length === 0 ? <div className="mono">No policies defined.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "entitlements" ? (
        <>
          <form className="panel" onSubmit={createEntitlement}>
            <div className="row">
              <label className="field grow">
                <span>Object type</span>
                <input
                  list="security-object-types"
                  value={entitlementForm.resource_type}
                  onChange={(e) => setEntitlementForm({ ...entitlementForm, resource_type: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Action</span>
                <input value={entitlementForm.action} onChange={(e) => setEntitlementForm({ ...entitlementForm, action: e.target.value })} />
              </label>
              <label className="field">
                <span>Subject</span>
                <select
                  value={entitlementForm.subject_type}
                  onChange={(e) => setEntitlementForm({ ...entitlementForm, subject_type: e.target.value })}
                >
                  {(vocab?.subjectTypes || ["everyone"]).map((subject) => (
                    <option key={subject}>{subject}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject id</span>
                <input
                  value={entitlementForm.subject_id}
                  onChange={(e) => setEntitlementForm({ ...entitlementForm, subject_id: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Effect</span>
                <select value={entitlementForm.effect} onChange={(e) => setEntitlementForm({ ...entitlementForm, effect: e.target.value })}>
                  <option>allow</option>
                  <option>deny</option>
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Create entitlement
            </button>
          </form>
          <div className="panel">
            <h3>Entitlements ({entitlements.length})</h3>
            {entitlements.map((entry) => (
              <div className="row" key={entry.id}>
                <div className="grow mono">
                  <Badge tone={entry.effect === "allow" ? "ok" : "warn"}>{entry.effect}</Badge> {entry.resource_type || "*"} ·{" "}
                  {entry.action} · {entry.subject_type}
                  {entry.subject_id ? `:${entry.subject_id}` : ""} · scope={entry.scope} status={entry.status}
                </div>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await security.setEntitlementStatus(entry.id, entry.status === "active" ? "inactive" : "active");
                    refresh();
                  }}
                >
                  {entry.status === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
            {entitlements.length === 0 ? <div className="mono">No entitlements defined.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "fields" ? (
        <>
          <form className="panel" onSubmit={createFieldRule}>
            <div className="row">
              <label className="field grow">
                <span>Object type</span>
                <input
                  list="security-object-types"
                  value={fieldForm.object_type}
                  onChange={(e) => setFieldForm({ ...fieldForm, object_type: e.target.value })}
                  required
                />
              </label>
              <label className="field grow">
                <span>Field</span>
                <input value={fieldForm.field_name} onChange={(e) => setFieldForm({ ...fieldForm, field_name: e.target.value })} required />
              </label>
              <label className="field">
                <span>Effect</span>
                <select value={fieldForm.effect} onChange={(e) => setFieldForm({ ...fieldForm, effect: e.target.value })}>
                  <option>mask</option>
                  <option>hide</option>
                  <option>deny</option>
                  <option>allow</option>
                </select>
              </label>
              <label className="field">
                <span>Strategy</span>
                <select
                  value={fieldForm.masking_strategy}
                  onChange={(e) => setFieldForm({ ...fieldForm, masking_strategy: e.target.value })}
                >
                  {(vocab?.maskingStrategies || ["REDACT"]).map((strategy) => (
                    <option key={strategy}>{strategy}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subject</span>
                <select value={fieldForm.subject_type} onChange={(e) => setFieldForm({ ...fieldForm, subject_type: e.target.value })}>
                  {(vocab?.subjectTypes || ["everyone"]).map((subject) => (
                    <option key={subject}>{subject}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn" disabled={busy}>
              Create field rule
            </button>
          </form>
          <div className="panel">
            <h3>Field rules ({fieldRules.length})</h3>
            {fieldRules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow mono">
                  {rule.object_type}.{rule.field_name} · {rule.action} · {rule.effect}
                  {rule.masking_strategy ? ` (${rule.masking_strategy})` : ""} · {rule.subject_type} status={rule.status}
                </div>
              </div>
            ))}
            {fieldRules.length === 0 ? <div className="mono">No field rules defined.</div> : null}
          </div>
          <div className="panel">
            <h3>Named masking rules ({maskingRules.length})</h3>
            {maskingRules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow mono">
                  {rule.code || rule.id} · {rule.strategy} · {rule.object_type || "*"}.{rule.field_name || "*"} status={rule.status}
                </div>
              </div>
            ))}
            {maskingRules.length === 0 ? <div className="mono">No named masking rules.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "classification" ? (
        <div className="panel">
          <h3>Classification rules ({classificationRules.length})</h3>
          {classificationRules.map((rule) => (
            <div className="row" key={rule.id}>
              <div className="grow mono">
                <Badge tone={rule.effect === "allow" ? "ok" : "warn"}>{rule.effect}</Badge> {rule.classification} ·{" "}
                {rule.resource_type || "*"} · {rule.action} · {rule.subject_type}
                {rule.subject_id ? `:${rule.subject_id}` : ""}
              </div>
              <button
                className="btn ghost"
                onClick={async () => {
                  await security.setClassificationRuleStatus(rule.id, rule.status === "active" ? "inactive" : "active");
                  refresh();
                }}
              >
                {rule.status === "active" ? "Deactivate" : "Activate"}
              </button>
            </div>
          ))}
          {classificationRules.length === 0 ? <div className="mono">No classification rules defined.</div> : null}
        </div>
      ) : null}

      {tab === "scope" ? (
        <>
          <div className="panel">
            <h3>Organization rules ({organizationRules.length})</h3>
            {organizationRules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow mono">
                  <Badge tone={rule.effect === "allow" ? "ok" : "warn"}>{rule.effect}</Badge> org={rule.organization_id} ·
                  mode={rule.scope_mode} · {rule.resource_type || "*"} · {rule.subject_type}
                  {rule.subject_id ? `:${rule.subject_id}` : ""}
                </div>
              </div>
            ))}
            {organizationRules.length === 0 ? <div className="mono">No organization rules defined.</div> : null}
          </div>
          <div className="panel">
            <h3>Plant rules ({plantRules.length})</h3>
            {plantRules.map((rule) => (
              <div className="row" key={rule.id}>
                <div className="grow mono">
                  <Badge tone={rule.effect === "allow" ? "ok" : "warn"}>{rule.effect}</Badge> plant={rule.plant_id} ·{" "}
                  {rule.resource_type || "*"} · {rule.subject_type}
                  {rule.subject_id ? `:${rule.subject_id}` : ""}
                </div>
              </div>
            ))}
            {plantRules.length === 0 ? <div className="mono">No plant rules defined.</div> : null}
          </div>
        </>
      ) : null}

      {tab === "objectTypes" ? (
        <div className="panel">
          <h3>Registered object types ({objectTypes.length})</h3>
          {objectTypes.map((type) => (
            <div className="row" key={type.id}>
              <div className="grow mono">
                <strong>{type.object_type}</strong> · enforcement={type.enforcement} · resource=
                {type.permission_resource || "-"} · status={type.status}
              </div>
              <select
                value={type.enforcement}
                onChange={async (e) => {
                  await security.updateObjectType(type.object_type, { enforcement: e.target.value });
                  refresh();
                }}
              >
                <option value="tenant">tenant</option>
                <option value="entitlement">entitlement</option>
                <option value="policy">policy</option>
              </select>
            </div>
          ))}
          {objectTypes.length === 0 ? <div className="mono">No object types registered.</div> : null}
        </div>
      ) : null}

      {tab === "inspector" ? (
        <>
          <form className="panel" onSubmit={runInspection}>
            <div className="row">
              <label className="field grow">
                <span>User</span>
                <select value={inspection.userId} onChange={(e) => setInspection({ ...inspection, userId: e.target.value })}>
                  <option value="">Current user</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.username}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>Object type</span>
                <input
                  list="security-object-types"
                  value={inspection.resource_type}
                  onChange={(e) => setInspection({ ...inspection, resource_type: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Resource id</span>
                <input value={inspection.resource_id} onChange={(e) => setInspection({ ...inspection, resource_id: e.target.value })} />
              </label>
              <label className="field">
                <span>Action</span>
                <input value={inspection.action} onChange={(e) => setInspection({ ...inspection, action: e.target.value })} />
              </label>
              <label className="field">
                <span>Organization</span>
                <select
                  value={inspection.organization_id}
                  onChange={(e) => setInspection({ ...inspection, organization_id: e.target.value })}
                >
                  <option value="">None</option>
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Classification</span>
                <select
                  value={inspection.classification}
                  onChange={(e) => setInspection({ ...inspection, classification: e.target.value })}
                >
                  <option value="">None</option>
                  {(vocab?.classifications || []).map((classification) => (
                    <option key={classification}>{classification}</option>
                  ))}
                </select>
              </label>
              <button className="btn">Evaluate</button>
            </div>
          </form>

          {decision ? (
            <div className="panel">
              <h3 className={decision.allowed ? "decision-allow" : "decision-deny"}>
                {decision.decision.toUpperCase()} — {decision.message}
              </h3>
              <p className="mono">
                reason={decision.reason} enforcement={decision.enforcement} duration={decision.durationMs}ms cached=
                {String(decision.cached)}
              </p>
              <div className="stack">
                {(decision.steps || []).map((entry) => (
                  <div className="mono" key={entry.step}>
                    <Badge tone={entry.passed ? "ok" : "warn"}>{entry.passed ? "pass" : "fail"}</Badge> {entry.step}
                    {entry.reason ? ` · ${entry.reason}` : ""}
                  </div>
                ))}
              </div>
              {decision.fields?.length ? (
                <div className="chips" style={{ marginTop: 8 }}>
                  {decision.fields.map((field) => (
                    <span className="chip" key={field.field}>
                      {field.field}: {field.effect}
                      {field.strategy ? ` (${field.strategy})` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {context ? (
            <div className="panel">
              <h3>Security context</h3>
              <p className="mono">roles: {context.roles.join(", ") || "none"}</p>
              <p className="mono">organizations: {context.organizations.join(", ") || "none"}</p>
              <p className="mono">plants: {context.plants.join(", ") || "none"}</p>
              <p className="mono">permissions: {context.permissions.length}</p>
            </div>
          ) : null}

          <div className="panel">
            <h3>Recent decisions</h3>
            {decisions.map((entry) => (
              <div className="row" key={entry.id}>
                <div className="grow mono">
                  <Badge tone={entry.allowed ? "ok" : "warn"}>{entry.decision}</Badge> {entry.resource_type}
                  {entry.resource_id ? `#${entry.resource_id}` : ""} · {entry.action} · {entry.reason}
                </div>
                <div className="mono">{entry.created_at}</div>
              </div>
            ))}
            {decisions.length === 0 ? <div className="mono">No decisions recorded.</div> : null}
          </div>
        </>
      ) : null}

      <datalist id="security-object-types">
        {objectTypeOptions.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
    </>
  );
}
