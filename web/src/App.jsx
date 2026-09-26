import React, { useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getToken, iam, setToken } from "./api.js";
import NotificationBell from "./components/NotificationBell.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
// Route-level code splitting: each page is loaded on demand so the initial
// bundle only contains the shell and the landing route instead of all 60+ admin
// modules.
const UsersPage = React.lazy(() => import("./pages/UsersPage.jsx"));
const UserDetailPage = React.lazy(() => import("./pages/UserDetailPage.jsx"));
const GroupsPage = React.lazy(() => import("./pages/GroupsPage.jsx"));
const GroupDetailPage = React.lazy(() => import("./pages/GroupDetailPage.jsx"));
const RolesPage = React.lazy(() => import("./pages/RolesPage.jsx"));
const RoleDetailPage = React.lazy(() => import("./pages/RoleDetailPage.jsx"));
const PolicyPage = React.lazy(() => import("./pages/PolicyPage.jsx"));
const AuditPage = React.lazy(() => import("./pages/AuditPage.jsx"));
const DashboardPage = React.lazy(() => import("./pages/DashboardPage.jsx"));
const PermissionsPage = React.lazy(() => import("./pages/PermissionsPage.jsx"));
const AuthorizationPage = React.lazy(() => import("./pages/AuthorizationPage.jsx"));
const SecurityModelPage = React.lazy(() => import("./pages/SecurityModelPage.jsx"));
const DataGovernancePage = React.lazy(() => import("./pages/DataGovernancePage.jsx"));
const DataCatalogPage = React.lazy(() => import("./pages/DataCatalogPage.jsx"));
const GlossaryPage = React.lazy(() => import("./pages/GlossaryPage.jsx"));
const DataLifecyclePage = React.lazy(() => import("./pages/DataLifecyclePage.jsx"));
const DataExchangePage = React.lazy(() => import("./pages/DataExchangePage.jsx"));
const MigrationPage = React.lazy(() => import("./pages/MigrationPage.jsx"));
const ClassificationPage = React.lazy(() => import("./pages/ClassificationPage.jsx"));
const BomPage = React.lazy(() => import("./pages/BomPage.jsx"));
const PdmPage = React.lazy(() => import("./pages/PdmPage.jsx"));
const DigitalThreadPage = React.lazy(() => import("./pages/DigitalThreadPage.jsx"));
const StandardsExchangePage = React.lazy(() => import("./pages/StandardsExchangePage.jsx"));
const ReportingAnalyticsPage = React.lazy(() => import("./pages/ReportingAnalyticsPage.jsx"));
const DataObservabilityPage = React.lazy(() => import("./pages/DataObservabilityPage.jsx"));
const OrganizationsPage = React.lazy(() => import("./pages/OrganizationsPage.jsx"));
const OrganizationDetailPage = React.lazy(() => import("./pages/OrganizationDetailPage.jsx"));
const PlatformPage = React.lazy(() => import("./pages/PlatformPage.jsx"));
const TenantsPage = React.lazy(() => import("./pages/TenantsPage.jsx"));
const ConfigurationPage = React.lazy(() => import("./pages/ConfigurationPage.jsx"));
const MetadataPage = React.lazy(() => import("./pages/MetadataPage.jsx"));
const ObjectsPage = React.lazy(() => import("./pages/ObjectsPage.jsx"));
const ObjectDetailPage = React.lazy(() => import("./pages/ObjectDetailPage.jsx"));
const RelationshipTypesPage = React.lazy(() => import("./pages/RelationshipTypesPage.jsx"));
const LifecyclePage = React.lazy(() => import("./pages/LifecyclePage.jsx"));
const WorkflowPage = React.lazy(() => import("./pages/WorkflowPage.jsx"));
const ExplorerPage = React.lazy(() => import("./pages/ExplorerPage.jsx"));
const NotificationsPage = React.lazy(() => import("./pages/NotificationsPage.jsx"));
const NotificationAdminPage = React.lazy(() => import("./pages/NotificationAdminPage.jsx"));
const DeliveryAdminPage = React.lazy(() => import("./pages/DeliveryAdminPage.jsx"));
const JobsDashboardPage = React.lazy(() => import("./pages/JobsDashboardPage.jsx"));
const JobsPage = React.lazy(() => import("./pages/JobsPage.jsx"));
const JobDetailPage = React.lazy(() => import("./pages/JobDetailPage.jsx"));
const JobTypesPage = React.lazy(() => import("./pages/JobTypesPage.jsx"));
const JobQueuesPage = React.lazy(() => import("./pages/JobQueuesPage.jsx"));
const JobSchedulesPage = React.lazy(() => import("./pages/JobSchedulesPage.jsx"));
const JobWorkersPage = React.lazy(() => import("./pages/JobWorkersPage.jsx"));
const JobExecutionPage = React.lazy(() => import("./pages/JobExecutionPage.jsx"));
const JobDeadLetterPage = React.lazy(() => import("./pages/JobDeadLetterPage.jsx"));
const AuthenticationPage = React.lazy(() => import("./pages/AuthenticationPage.jsx"));
const SessionsPage = React.lazy(() => import("./pages/SessionsPage.jsx"));
const MfaPage = React.lazy(() => import("./pages/MfaPage.jsx"));
const FilesPage = React.lazy(() => import("./pages/FilesPage.jsx"));
const FileDetailPage = React.lazy(() => import("./pages/FileDetailPage.jsx"));
const FileAdminPage = React.lazy(() => import("./pages/FileAdminPage.jsx"));
const ContentPage = React.lazy(() => import("./pages/ContentPage.jsx"));
const ContentAdminPage = React.lazy(() => import("./pages/ContentAdminPage.jsx"));
const SearchPage = React.lazy(() => import("./pages/SearchPage.jsx"));
const SearchFoundationPage = React.lazy(() => import("./pages/SearchFoundationPage.jsx"));
const SearchAdminPage = React.lazy(() => import("./pages/SearchAdminPage.jsx"));
const IntegrationPage = React.lazy(() => import("./pages/IntegrationPage.jsx"));
const EventsPage = React.lazy(() => import("./pages/EventsPage.jsx"));
const NumberingPage = React.lazy(() => import("./pages/NumberingPage.jsx"));
const VersioningPage = React.lazy(() => import("./pages/VersioningPage.jsx"));
const ReferenceDataPage = React.lazy(() => import("./pages/ReferenceDataPage.jsx"));

function Login({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("HelixAdmin!42");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetId, setResetId] = useState("");
  const [resetMsg, setResetMsg] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mfaToken) {
        const res = await iam.mfaChallenge({ mfaToken, code: mfaCode });
        setToken(res.token);
        onLogin(res.user);
        return;
      }
      const res = await iam.login(username, password);
      if (res.mfaRequired) {
        setMfaToken(res.mfaToken);
        return;
      }
      setToken(res.token);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(e) {
    e.preventDefault();
    setResetMsg("");
    try {
      await iam.requestPasswordReset({ username: resetId || username });
      setResetMsg("If the account exists, a reset token was issued. Ask an operator to complete it, or use /api/authentication/password-reset/complete.");
    } catch (err) {
      setResetMsg(err.message);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">Helix Identity Fabric</div>
        <h1>IAM Console</h1>
        <p className="sub">Central authentication for the enterprise platform.</p>
        {mfaToken ? (
          <label className="field">
            <span>Authenticator code</span>
            <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoComplete="one-time-code" />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Username</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </>
        )}
        {error ? <div className="error">{error}</div> : null}
        <button className="btn" disabled={busy}>{busy ? "Signing in…" : mfaToken ? "Verify" : "Sign in"}</button>
        {!mfaToken ? (
          <button type="button" className="btn ghost" style={{ marginTop: 10 }} onClick={() => setResetOpen(!resetOpen)}>Forgot password</button>
        ) : null}
        {resetOpen ? (
          <div style={{ marginTop: 16 }}>
            <label className="field">
              <span>Username or email</span>
              <input value={resetId} onChange={(e) => setResetId(e.target.value)} />
            </label>
            <button type="button" className="btn secondary" onClick={requestReset}>Request reset</button>
            {resetMsg ? <p className="sub">{resetMsg}</p> : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}

// Everything that is not personal workspace lives under the Platform menu,
// grouped by domain. "My Data" stays a top-level section of its own.
const PLATFORM_GROUPS = [
  {
    key: "overview",
    label: "",
    items: [
      { to: "/", label: "Overview", end: true },
      { to: "/explorer", label: "Data explorer" },
    ],
  },
  {
    key: "organization",
    label: "Organization",
    items: [
      { to: "/organizations", label: "Org structure" },
      { to: "/tenants", label: "Tenants", platform: true },
    ],
  },
  {
    key: "identity",
    label: "Identity",
    items: [
      { to: "/users", label: "Users" },
      { to: "/groups", label: "Groups" },
    ],
  },
  {
    key: "access",
    label: "Access control",
    items: [
      { to: "/roles", label: "Roles" },
      { to: "/permissions", label: "Permissions" },
      { to: "/authorization", label: "Authorization" },
      { to: "/security", label: "Data security", platformOrAdmin: true },
    ],
  },
  {
    key: "authentication",
    label: "Authentication",
    items: [
      { to: "/authentication", label: "Providers" },
      { to: "/policy", label: "Password policy" },
      { to: "/sessions", label: "Sessions" },
      { to: "/mfa", label: "MFA" },
    ],
  },
  {
    key: "configuration",
    label: "Configuration",
    items: [
      { to: "/configuration", label: "Scoped config" },
      { to: "/metadata", label: "Metadata", platformOrAdmin: true },
      { to: "/relationship-types", label: "Relationship types" },
      { to: "/lifecycles", label: "Lifecycles" },
      { to: "/workflows/templates", label: "Workflow Engine", platformOrAdmin: true },
      { to: "/platform", label: "Platform properties", platform: true },
    ],
  },
  {
    key: "documents",
    label: "Documents",
    items: [
      { to: "/files", label: "File browser", end: true },
      { to: "/files/admin", label: "File administration", platformOrAdmin: true },
      { to: "/content", label: "Content library", end: true },
      { to: "/content/admin", label: "Content administration", platformOrAdmin: true },
    ],
  },
  {
    key: "discovery",
    label: "Search",
    items: [
      { to: "/search", label: "Search & Discovery", end: true },
      { to: "/search/foundation", label: "Enterprise search" },
      { to: "/search/admin", label: "Search administration", platformOrAdmin: true },
    ],
  },
  {
    key: "audit",
    label: "Compliance",
    items: [{ to: "/audit", label: "Audit log" }],
  },
  {
    key: "integration",
    label: "Integration",
    items: [
      { to: "/integration", label: "Integration hub", platformOrAdmin: true },
      { to: "/events", label: "Event framework", platformOrAdmin: true },
    ],
  },
  {
    key: "numbering",
    label: "Identifiers",
    items: [{ to: "/numbering", label: "Numbering service", platformOrAdmin: true }],
  },
  {
    key: "versioning",
    label: "Versioning",
    items: [{ to: "/versioning", label: "Effectivity & versioning", platformOrAdmin: true }],
  },
  {
    key: "reference",
    label: "Reference data",
    items: [{ to: "/reference-data", label: "Enterprise reference data", platformOrAdmin: true }],
  },
  {
    key: "governance",
    label: "Data governance",
    items: [{ to: "/data-governance", label: "Governance & quality", platformOrAdmin: true }],
  },
  {
    key: "catalog",
    label: "Data catalog",
    items: [
      { to: "/data-catalog", label: "Catalog registry", platformOrAdmin: true },
      { to: "/glossary", label: "Business glossary", platformOrAdmin: true },
    ],
  },
  {
    key: "data-lifecycle",
    label: "Data lifecycle",
    items: [{ to: "/data-lifecycle", label: "Lifecycle & archival", platformOrAdmin: true }],
  },
  {
    key: "data-exchange",
    label: "Data exchange",
    items: [{ to: "/data-exchange", label: "Import & export", platformOrAdmin: true }],
  },
  {
    key: "migration",
    label: "Migration & onboarding",
    items: [{ to: "/migration", label: "Migration & onboarding", platformOrAdmin: true }],
  },
  {
    key: "classification",
    label: "Classification",
    items: [{ to: "/classification", label: "Enterprise classification", platformOrAdmin: true }],
  },
  {
    key: "bom",
    label: "Bill of materials",
    items: [{ to: "/bom", label: "BOM engine", platformOrAdmin: true }],
  },
  {
    key: "pdm",
    label: "Product data",
    items: [{ to: "/pdm", label: "PDM domain", platformOrAdmin: true }],
  },
  {
    key: "digital-thread",
    label: "Digital thread",
    items: [{ to: "/digital-thread", label: "Traceability workspace", platformOrAdmin: true }],
  },
  {
    key: "standards-exchange",
    label: "Standards & exchange",
    items: [{ to: "/standards-exchange", label: "Exchange workspace", platformOrAdmin: true }],
  },
  {
    key: "reporting-analytics",
    label: "Reporting & analytics",
    items: [{ to: "/reporting", label: "Analytics workspace", platformOrAdmin: true }],
  },
  {
    key: "observability",
    label: "Data observability",
    items: [{ to: "/observability", label: "Observability workspace", platformOrAdmin: true }],
  },
  {
    key: "communication",
    label: "Communication",
    items: [
      { to: "/notifications", label: "Inbox", end: true },
      { to: "/notifications/admin", label: "Notification admin", platformOrAdmin: true },
      { to: "/delivery/admin", label: "Delivery services", platformOrAdmin: true },
    ],
  },
  {
    key: "jobs",
    label: "Jobs",
    items: [
      { to: "/jobs", label: "Job dashboard", end: true },
      { to: "/jobs/list", label: "Jobs" },
      { to: "/jobs/execution", label: "Execution" },
      { to: "/jobs/workers", label: "Workers" },
      { to: "/jobs/dead-letter", label: "Dead letters" },
      { to: "/jobs/queues", label: "Queues", platformOrAdmin: true },
      { to: "/jobs/schedules", label: "Schedules", platformOrAdmin: true },
      { to: "/jobs/admin", label: "Job types", platformOrAdmin: true },
    ],
  },
];

const NAV_SECTIONS = [
  {
    key: "mydata",
    label: "My Data",
    items: [
      { to: "/objects", label: "Business objects" },
      { to: "/workflows", label: "My tasks & approvals", end: true },
    ],
  },
  {
    key: "platform",
    label: "Platform",
    groups: PLATFORM_GROUPS,
  },
];

function Shell({ me, access, tenant, tenants, onSwitch, onLogout, children }) {
  const location = useLocation();
  const roles = access?.roles || [];
  const canPlatform = roles.some((r) => r.code === "platform.admin");
  const canMetadata = canPlatform || roles.some((r) => r.code === "iam.admin");

  const visible = (item) => {
    if (item.platform && !canPlatform) return false;
    if (item.platformOrAdmin && !canMetadata) return false;
    return true;
  };

  const isActive = (item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);

  const [open, setOpen] = useState(() => new Set(["mydata", "platform", "overview"]));
  const mainRef = useRef(null);

  const visibleGroups = (section) =>
    (section.groups || [])
      .map((group) => ({ ...group, items: group.items.filter(visible) }))
      .filter((group) => group.items.length);

  useEffect(() => {
    const next = new Set();
    NAV_SECTIONS.forEach((section) => {
      const leafActive = (section.items || []).filter(visible).some(isActive);
      const groupsActive = (section.groups || []).some((group) =>
        group.items.filter(visible).some(isActive)
      );
      if (leafActive || groupsActive) {
        next.add(section.key);
        (section.groups || []).forEach((group) => {
          if (group.items.filter(visible).some(isActive)) next.add(group.key);
        });
      }
    });
    if (next.size) setOpen((prev) => new Set([...prev, ...next]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, canPlatform, canMetadata]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">Helix IAM</div>
        {tenants?.length ? (
          <label className="field">
            <span>Tenant context</span>
            <select value={tenant?.id || ""} onChange={(e) => onSwitch(Number(e.target.value))}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ) : null}
        <div className="nav-scroll">
          {NAV_SECTIONS.map((section) => {
            const items = (section.items || []).filter(visible);
            const groups = visibleGroups(section);
            if (!items.length && !groups.length) return null;
            const expanded = open.has(section.key);
            return (
              <div className={`nav-section ${expanded ? "open" : ""}`} key={section.key}>
                <button type="button" className="nav-section-head" onClick={() => toggle(section.key)}>
                  <span className="caret">{expanded ? "▾" : "▸"}</span>
                  {section.label}
                </button>
                {expanded ? (
                  <div className="nav-section-body">
                    {items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end}>
                        {item.label}
                      </NavLink>
                    ))}
                    {groups.map((group) => {
                      if (!group.label) {
                        return (
                          <div className="nav-group plain" key={group.key}>
                            {group.items.map((item) => (
                              <NavLink key={item.to} to={item.to} end={item.end}>
                                {item.label}
                              </NavLink>
                            ))}
                          </div>
                        );
                      }
                      const groupExpanded = open.has(group.key);
                      return (
                        <div className={`nav-group ${groupExpanded ? "open" : ""}`} key={group.key}>
                          <button type="button" className="nav-group-head" onClick={() => toggle(group.key)}>
                            <span className="caret">{groupExpanded ? "▾" : "▸"}</span>
                            {group.label}
                          </button>
                          {groupExpanded ? (
                            <div className="nav-group-body">
                              {group.items.map((item) => (
                                <NavLink key={item.to} to={item.to} end={item.end}>
                                  {item.label}
                                </NavLink>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <NotificationBell />
        <div className="mono">{me.display_name}</div>
        <button className="btn ghost" onClick={onLogout}>Sign out</button>
      </aside>
      <main className="main" ref={mainRef}>{children}</main>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [access, setAccess] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [ready, setReady] = useState(!getToken());
  const navigate = useNavigate();

  function applyMe(res) {
    setMe(res.user);
    setAccess(res.access || null);
    setTenant(res.tenant || null);
    setTenants(res.tenants || []);
  }

  useEffect(() => {
    if (!getToken()) return;
    iam.me()
      .then(applyMe)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  async function switchTenant(id) {
    if (!id || id === tenant?.id) return;
    try {
      await iam.selectTenant(id);
      const res = await iam.me();
      applyMe(res);
      navigate("/");
    } catch {
      /* ignore; the switcher keeps the previous tenant */
    }
  }

  async function logout() {
    try { await iam.logout(); } catch {}
    setToken(null);
    setMe(null);
    setAccess(null);
    setTenant(null);
    setTenants([]);
    navigate("/");
  }

  if (!ready) return <p className="mono" style={{ padding: 24 }}>Loading console…</p>;
  if (!me) {
    return (
      <Login
        onLogin={(user) => {
          setMe(user);
          iam.me().then(applyMe).catch(() => {});
        }}
      />
    );
  }

  return (
    <Shell me={me} access={access} tenant={tenant} tenants={tenants} onSwitch={switchTenant} onLogout={logout}>
      <ErrorBoundary>
      <React.Suspense fallback={<div className="page-loading mono">Loading…</div>}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/explorer" element={<ExplorerPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/organizations/:id" element={<OrganizationDetailPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/:id" element={<UserDetailPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/groups/:id" element={<GroupDetailPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/roles/:id" element={<RoleDetailPage />} />
        <Route path="/permissions" element={<PermissionsPage />} />
        <Route path="/authorization" element={<AuthorizationPage />} />
        <Route path="/security" element={<SecurityModelPage />} />
        <Route path="/data-governance" element={<DataGovernancePage />} />
        <Route path="/data-catalog" element={<DataCatalogPage />} />
        <Route path="/glossary" element={<GlossaryPage />} />
        <Route path="/data-lifecycle" element={<DataLifecyclePage />} />
        <Route path="/data-exchange" element={<DataExchangePage />} />
        <Route path="/migration" element={<MigrationPage />} />
        <Route path="/classification" element={<ClassificationPage />} />
        <Route path="/bom" element={<BomPage />} />
        <Route path="/pdm" element={<PdmPage />} />
        <Route path="/digital-thread" element={<DigitalThreadPage />} />
        <Route path="/standards-exchange" element={<StandardsExchangePage />} />
        <Route path="/reporting" element={<ReportingAnalyticsPage />} />
        <Route path="/observability" element={<DataObservabilityPage />} />
        <Route path="/policy" element={<PolicyPage />} />
        <Route path="/authentication" element={<AuthenticationPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route path="/tenants" element={<TenantsPage />} />
        <Route path="/configuration" element={<ConfigurationPage />} />
        <Route path="/metadata" element={<MetadataPage />} />
        <Route path="/objects" element={<ObjectsPage />} />
        <Route path="/objects/:id" element={<ObjectDetailPage />} />
        <Route path="/relationship-types" element={<RelationshipTypesPage />} />
        <Route path="/lifecycles" element={<LifecyclePage />} />
        <Route path="/workflows" element={<WorkflowPage mode="user" />} />
        <Route path="/workflows/templates" element={<WorkflowPage mode="config" />} />
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/notifications/admin" element={<NotificationAdminPage />} />
        <Route path="/delivery/admin" element={<DeliveryAdminPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/admin" element={<FileAdminPage />} />
        <Route path="/files/:ref" element={<FileDetailPage />} />
        <Route path="/content" element={<ContentPage />} />
        <Route path="/content/admin" element={<ContentAdminPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/search/foundation" element={<SearchFoundationPage />} />
        <Route path="/search/admin" element={<SearchAdminPage />} />
        <Route path="/integration" element={<IntegrationPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/numbering" element={<NumberingPage />} />
        <Route path="/versioning" element={<VersioningPage />} />
        <Route path="/reference-data" element={<ReferenceDataPage />} />
        <Route path="/jobs" element={<JobsDashboardPage />} />
        <Route path="/jobs/list" element={<JobsPage />} />
        <Route path="/jobs/execution" element={<JobExecutionPage />} />
        <Route path="/jobs/workers" element={<JobWorkersPage />} />
        <Route path="/jobs/dead-letter" element={<JobDeadLetterPage />} />
        <Route path="/jobs/queues" element={<JobQueuesPage />} />
        <Route path="/jobs/schedules" element={<JobSchedulesPage />} />
        <Route path="/jobs/admin" element={<JobTypesPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </React.Suspense>
      </ErrorBoundary>
    </Shell>
  );
}
