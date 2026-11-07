import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { HealthResponse } from "../api/types";

type ViewState =
  | { status: "loading" }
  | { status: "ready"; health: HealthResponse }
  | { status: "error"; message: string };

export default function DashboardPage() {
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((health) => {
        if (!cancelled) {
          setState({ status: "ready", health });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof ApiError
            ? `${error.code}: ${error.message}`
            : "Unable to reach the AI API";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1>AI Platform dashboard</h1>
      <p className="muted">
        Governance-first AI control plane. All reads and actions are authorized server-side.
      </p>

      {state.status === "loading" && <p role="status">Loading platform status...</p>}

      {state.status === "error" && (
        <p role="alert" className="error">
          AI API unavailable ({state.message}). Start it with{" "}
          <code>uvicorn ai_api.main:app --app-dir src --port 8000</code>.
        </p>
      )}

      {state.status === "ready" && (
        <dl className="status-grid">
          <div>
            <dt>Status</dt>
            <dd>{state.health.status}</dd>
          </div>
          <div>
            <dt>Service</dt>
            <dd>{state.health.service}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{state.health.version}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{state.health.environment}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
