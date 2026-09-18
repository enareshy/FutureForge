import React, { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getToken, iam, setToken } from "./api.js";
import UsersPage from "./pages/UsersPage.jsx";
import UserDetailPage from "./pages/UserDetailPage.jsx";
import GroupsPage from "./pages/GroupsPage.jsx";
import GroupDetailPage from "./pages/GroupDetailPage.jsx";
import RolesPage from "./pages/RolesPage.jsx";
import RoleDetailPage from "./pages/RoleDetailPage.jsx";
import PolicyPage from "./pages/PolicyPage.jsx";
import AuditPage from "./pages/AuditPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import PermissionsPage from "./pages/PermissionsPage.jsx";
import AuthorizationPage from "./pages/AuthorizationPage.jsx";
import OrganizationsPage from "./pages/OrganizationsPage.jsx";
import OrganizationDetailPage from "./pages/OrganizationDetailPage.jsx";
import PlatformPage from "./pages/PlatformPage.jsx";
import TenantsPage from "./pages/TenantsPage.jsx";
import ConfigurationPage from "./pages/ConfigurationPage.jsx";
import MetadataPage from "./pages/MetadataPage.jsx";
import ObjectsPage from "./pages/ObjectsPage.jsx";
import ObjectDetailPage from "./pages/ObjectDetailPage.jsx";
import RelationshipTypesPage from "./pages/RelationshipTypesPage.jsx";
import LifecyclePage from "./pages/LifecyclePage.jsx";
import WorkflowPage from "./pages/WorkflowPage.jsx";
import ExplorerPage from "./pages/ExplorerPage.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx";
import NotificationAdminPage from "./pages/NotificationAdminPage.jsx";
import DeliveryAdminPage from "./pages/DeliveryAdminPage.jsx";
import JobsDashboardPage from "./pages/JobsDashboardPage.jsx";
import JobsPage from "./pages/JobsPage.jsx";
import JobDetailPage from "./pages/JobDetailPage.jsx";
import JobTypesPage from "./pages/JobTypesPage.jsx";
import JobQueuesPage from "./pages/JobQueuesPage.jsx";
import JobSchedulesPage from "./pages/JobSchedulesPage.jsx";
import JobWorkersPage from "./pages/JobWorkersPage.jsx";
import JobExecutionPage from "./pages/JobExecutionPage.jsx";
import JobDeadLetterPage from "./pages/JobDeadLetterPage.jsx";
import NotificationBell from "./components/NotificationBell.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import AuthenticationPage from "./pages/AuthenticationPage.jsx";
import SessionsPage from "./pages/SessionsPage.jsx";
import MfaPage from "./pages/MfaPage.jsx";
import FilesPage from "./pages/FilesPage.jsx";
import FileDetailPage from "./pages/FileDetailPage.jsx";
import FileAdminPage from "./pages/FileAdminPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import SearchAdminPage from "./pages/SearchAdminPage.jsx";
import IntegrationPage from "./pages/IntegrationPage.jsx";

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

const NAV_SECTIONS = [
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
    key: "objects",
    label: "My Data",
    items: [
      { to: "/objects", label: "Business objects" },
      { to: "/workflows", label: "My tasks & approvals", end: true },
    ],
  },
  {
    key: "documents",
    label: "Documents",
    items: [
      { to: "/files", label: "File browser", end: true },
      { to: "/files/admin", label: "File administration", platformOrAdmin: true },
    ],
  },
  {
    key: "discovery",
    label: "Search",
    items: [
      { to: "/search", label: "Search & Discovery", end: true },
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
    items: [{ to: "/integration", label: "Integration hub", platformOrAdmin: true }],
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

  const [open, setOpen] = useState(() => new Set(["overview"]));
  useEffect(() => {
    const activeSection = NAV_SECTIONS.find((section) =>
      section.items.some((item) => visible(item) && isActive(item))
    );
    if (activeSection) setOpen((prev) => (prev.has(activeSection.key) ? prev : new Set([...prev, activeSection.key])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, canPlatform, canMetadata]);

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
            const items = section.items.filter(visible);
            if (!items.length) return null;
            if (!section.label) {
              return (
                <div className="nav-section plain" key={section.key}>
                  {items.map((item) => (
                    <NavLink key={item.to} to={item.to} end={item.end}>
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              );
            }
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
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="spacer" />
        <NotificationBell />
        <div className="mono">{me.display_name}</div>
        <button className="btn ghost" onClick={onLogout}>Sign out</button>
      </aside>
      <main className="main">{children}</main>
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
        <Route path="/search" element={<SearchPage />} />
        <Route path="/search/admin" element={<SearchAdminPage />} />
        <Route path="/integration" element={<IntegrationPage />} />
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
      </ErrorBoundary>
    </Shell>
  );
}
