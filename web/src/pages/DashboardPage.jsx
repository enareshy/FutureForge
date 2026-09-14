import React, { useEffect, useState } from "react";
import { iam } from "../api.js";

export default function DashboardPage() {
  const [data, setData] = useState({ users: 0, groups: 0, roles: 0, audits: 0, permissions: 0, orgs: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.allSettled([
      iam.users("?pageSize=1"),
      iam.groups("?pageSize=1"),
      iam.roles("?pageSize=1"),
      iam.audit("?pageSize=1"),
      iam.permissions("?pageSize=1"),
      iam.orgs("?pageSize=1"),
    ])
      .then((results) => {
        const val = (i) => (results[i].status === "fulfilled" ? results[i].value.total : 0);
        setData({
          users: val(0),
          groups: val(1),
          roles: val(2),
          audits: val(3),
          permissions: val(4),
          orgs: val(5),
        });
        const denied = results.find((r) => r.status === "rejected");
        if (denied) setError("");
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Platform</div>
          <h1>Identity overview</h1>
          <p className="sub">Reusable IAM fabric. Modules call POST /api/authorization/check and checkPermission(user, resource, action, context). Default deny.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="grid">
        <div className="stat">Organizations<b>{data.orgs}</b></div>
        <div className="stat">Users<b>{data.users}</b></div>
        <div className="stat">Groups<b>{data.groups}</b></div>
        <div className="stat">Roles<b>{data.roles}</b></div>
        <div className="stat">Permissions<b>{data.permissions}</b></div>
        <div className="stat">Audit events<b>{data.audits}</b></div>
      </div>
    </>
  );
}
