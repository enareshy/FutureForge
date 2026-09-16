import React from "react";

export function jobStatusClass(status) {
  return `job-${status || "created"}`;
}

export function JobStatusBadge({ status, label }) {
  return <span className={`badge ${jobStatusClass(status)}`}>{label || String(status || "").toUpperCase()}</span>;
}

export function JobProgress({ value = 0, status }) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const kind = status === "completed" ? "done" : ["failed", "timed_out", "cancelled"].includes(status) ? "failed" : "";
  return (
    <div className={`job-progress ${kind}`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total)) return "—";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default JobStatusBadge;
