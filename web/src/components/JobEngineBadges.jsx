import React from "react";

export function queueHealthStatus(queue) {
  if (!queue) return "unknown";
  if (!queue.enabled) return "disabled";
  if (queue.paused) return "paused";
  if (queue.max_concurrency > 0 && queue.running >= queue.max_concurrency) return "saturated";
  if (queue.rate_limit_per_minute > 0 && queue.utilization >= 100) return "rate_limited";
  if (queue.depth > 0 && queue.oldest_job_age_seconds > 900) return "degraded";
  return "healthy";
}

export function QueueStatusBadge({ queue }) {
  const status = queueHealthStatus(queue);
  return <span className={`badge eng-${status}`}>{status.replace("_", " ").toUpperCase()}</span>;
}

export function ScheduleStatusBadge({ status }) {
  const value = String(status || "active").toLowerCase();
  return <span className={`badge sched-${value}`}>{value.toUpperCase()}</span>;
}

export function WorkerStatusBadge({ status }) {
  const value = String(status || "offline").toLowerCase();
  return <span className={`badge eng-${value}`}>{value.toUpperCase()}</span>;
}

export function DeadLetterStatusBadge({ status }) {
  const value = String(status || "open").toLowerCase();
  return <span className={`badge eng-${value}`}>{value.toUpperCase()}</span>;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeCadence(schedule) {
  if (!schedule) return "—";
  const tz = schedule.timezone && schedule.timezone !== "UTC" ? ` (${schedule.timezone})` : "";
  switch (schedule.schedule_type) {
    case "interval": {
      const seconds = Number(schedule.interval_seconds) || 0;
      if (seconds % 86400 === 0) return `Every ${seconds / 86400}d${tz}`;
      if (seconds % 3600 === 0) return `Every ${seconds / 3600}h${tz}`;
      if (seconds % 60 === 0) return `Every ${seconds / 60}m${tz}`;
      return `Every ${seconds}s${tz}`;
    }
    case "daily":
      return `Daily at ${schedule.daily_time}${tz}`;
    case "weekly": {
      const days = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
      const names = days.map((day) => WEEKDAY_LABELS[day] || day).join(", ");
      return `${names || "Weekly"} at ${schedule.daily_time}${tz}`;
    }
    case "monthly":
      return `Monthly on day ${schedule.day_of_month} at ${schedule.daily_time}${tz}`;
    case "cron":
      return `Cron ${schedule.cron_expression}${tz}`;
    case "once":
      return `Once at ${schedule.start_at || "—"}${tz}`;
    default:
      return schedule.schedule_type || "—";
  }
}

export function formatDateTime(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 19);
}
