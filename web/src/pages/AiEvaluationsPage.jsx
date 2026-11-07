import React, { useEffect, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function ratingLabel(rating) {
  if (rating === 1) return "up";
  if (rating === -1) return "down";
  if (rating == null) return "-";
  return String(rating);
}

export default function AiEvaluationsPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    ai.feedback({ limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items || []);
        setTotal(page.meta?.total ?? (page.items || []).length);
      })
      .catch((err) => {
        if (!cancelled) setError(describe(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rated = items.filter((x) => typeof x.rating === "number");
  const positives = rated.filter((x) => x.rating > 0).length;
  const negatives = rated.filter((x) => x.rating < 0).length;
  const sampleNote =
    items.length && total > items.length
      ? `across the ${items.length} most recent of ${total} feedback items`
      : `across ${items.length} feedback item(s)`;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Evaluation &amp; feedback</h1>
          <p className="sub">
            Human feedback captured on answers and agent runs. Automated offline evaluation
            suites are not part of this release.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="notice">
        Automated evaluation suites (golden datasets, scoring harnesses, regression gates) are not
        enabled in this release, so no model-quality scores are shown here. The panel below reflects
        only real, recorded human feedback.
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Feedback signal</h3>
          <span className="badge unknown">{sampleNote}</span>
        </div>
        <div className="grid">
          <div className="stat">
            <div className="result-sub">Total captured</div>
            <div>{total}</div>
          </div>
          <div className="stat">
            <div className="result-sub">Positive</div>
            <div>{positives}</div>
          </div>
          <div className="stat">
            <div className="result-sub">Negative</div>
            <div>{negatives}</div>
          </div>
          <div className="stat">
            <div className="result-sub">With comments</div>
            <div>{items.filter((x) => x.comment).length}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Recent feedback</h3></div>
        {loading ? (
          <p className="muted">Loading feedback…</p>
        ) : items.length === 0 ? (
          <p className="muted">
            No feedback yet. Rate a Copilot answer or an agent run to populate this view.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Execution</th>
                <th>Rating</th>
                <th>Comment</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>{f.id}</td>
                  <td>{f.execution_id ?? "-"}</td>
                  <td>
                    <span
                      className={`badge ${
                        f.rating > 0 ? "active" : f.rating < 0 ? "inactive" : "unknown"
                      }`}
                    >
                      {ratingLabel(f.rating)}
                    </span>
                  </td>
                  <td>{f.comment || "-"}</td>
                  <td>{f.actor_id ?? "-"}</td>
                  <td className="muted">{formatTime(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
