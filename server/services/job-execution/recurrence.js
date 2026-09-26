// Recurrence calculation for the scheduling engine.
//
// `computeNextRun` returns the next UTC instant (or null when the schedule is
// exhausted/expired) for every supported cadence. It is pure: given the same
// schedule definition and `from` instant it always yields the same result,
// which keeps next-run computation consistent across scheduler replicas.

import { parseCron, cronMatches } from "./cron.js";
import {
  zonedParts,
  zonedTimeToUtc,
  addCalendarDays,
  calendarWeekday,
  daysInMonth,
  parseClock,
  parseInstant,
  parseSqlTime,
  sqlTime,
} from "./timezone.js";

export const SCHEDULE_TYPES = ["once", "interval", "daily", "weekly", "monthly", "cron"];

function weekdayList(value) {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(",");
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => Number(item)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
}

function nextDaily(from, timeZone, time) {
  const parts = zonedParts(from, timeZone);
  for (let i = 0; i < 4; i += 1) {
    const date = addCalendarDays(parts, i);
    const candidate = zonedTimeToUtc({ ...date, hour: time.hour, minute: time.minute, second: 0 }, timeZone);
    if (candidate > from) return candidate;
  }
  return null;
}

function nextWeekly(from, timeZone, weekdays, time) {
  const days = weekdayList(weekdays);
  if (!days.length) return null;
  const wanted = new Set(days);
  const parts = zonedParts(from, timeZone);
  for (let i = 0; i <= 7; i += 1) {
    const date = addCalendarDays(parts, i);
    if (!wanted.has(calendarWeekday(date))) continue;
    const candidate = zonedTimeToUtc({ ...date, hour: time.hour, minute: time.minute, second: 0 }, timeZone);
    if (candidate > from) return candidate;
  }
  return null;
}

function nextMonthly(from, timeZone, dayOfMonth, time) {
  const dom = Math.min(Math.max(1, Number(dayOfMonth) || 1), 31);
  const parts = zonedParts(from, timeZone);
  const base = parts.year * 12 + (parts.month - 1);
  for (let i = 0; i < 24; i += 1) {
    const index = base + i;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    if (dom > daysInMonth(year, month)) continue;
    const candidate = zonedTimeToUtc({ year, month, day: dom, hour: time.hour, minute: time.minute, second: 0 }, timeZone);
    if (candidate > from) return candidate;
  }
  return null;
}

export function nextCronRun(expression, timeZone, from) {
  const fields = parseCron(expression);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  let cursor = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  while (cursor <= limit) {
    const parts = zonedParts(new Date(cursor), timeZone);
    if (cronMatches(fields, parts)) return new Date(cursor);
    cursor += 60000;
  }
  return null;
}

// Computes the next run instant strictly after `fromDate`. `start_at` anchors
// the very first occurrence; `end_at` bounds the last. Returns a Date or null.
export function computeNextRun(schedule, fromDate = new Date()) {
  const timeZone = schedule.timezone || "UTC";
  const type = schedule.schedule_type || schedule.scheduleType || "once";
  const from = fromDate instanceof Date ? fromDate : parseSqlTime(fromDate) || new Date();
  const start = parseInstant(schedule.start_at ?? schedule.startAt, timeZone);
  const end = parseInstant(schedule.end_at ?? schedule.endAt, timeZone);

  // Anchor daily/weekly/monthly/cron just before `start_at` so an occurrence
  // landing exactly on the start boundary is not skipped.
  const anchor = start && start > from ? new Date(start.getTime() - 1000) : from;

  let candidate = null;
  if (type === "once") {
    if (start) candidate = start > from ? start : null;
    else candidate = new Date(from.getTime() + 1000);
  } else if (type === "interval") {
    const interval = Math.max(1, Number(schedule.interval_seconds ?? schedule.intervalSeconds) || 0);
    if (start && start > from) {
      candidate = start;
    } else if (start) {
      // Occurrences are anchored on start_at; find the first one after `from`.
      const elapsed = from.getTime() - start.getTime();
      const steps = Math.floor(elapsed / (interval * 1000)) + 1;
      candidate = new Date(start.getTime() + steps * interval * 1000);
    } else {
      candidate = new Date(from.getTime() + interval * 1000);
    }
  } else if (type === "daily") {
    candidate = nextDaily(anchor, timeZone, parseClock(schedule.daily_time ?? schedule.dailyTime));
  } else if (type === "weekly") {
    candidate = nextWeekly(anchor, timeZone, schedule.weekdays_json ?? schedule.weekdays, parseClock(schedule.daily_time ?? schedule.dailyTime));
  } else if (type === "monthly") {
    candidate = nextMonthly(anchor, timeZone, schedule.day_of_month ?? schedule.dayOfMonth, parseClock(schedule.daily_time ?? schedule.dailyTime));
  } else if (type === "cron") {
    candidate = nextCronRun(schedule.cron_expression ?? schedule.cronExpression, timeZone, anchor);
  }

  if (!candidate) return null;
  if (start && candidate < start) return null;
  if (end && candidate > end) return null;
  return candidate;
}

export function nextRunAt(schedule, fromDate = new Date()) {
  return sqlTime(computeNextRun(schedule, fromDate));
}

// Human-readable summary for API/UI consumption.
export function describeSchedule(schedule) {
  const type = schedule.schedule_type || "once";
  const timeZone = schedule.timezone || "UTC";
  switch (type) {
    case "interval": {
      const seconds = Number(schedule.interval_seconds) || 0;
      if (seconds % 86400 === 0) return `Every ${seconds / 86400} day(s)`;
      if (seconds % 3600 === 0) return `Every ${seconds / 3600} hour(s)`;
      if (seconds % 60 === 0) return `Every ${seconds / 60} minute(s)`;
      return `Every ${seconds} second(s)`;
    }
    case "daily":
      return `Daily at ${schedule.daily_time} (${timeZone})`;
    case "weekly": {
      const days = weekdayList(schedule.weekdays_json);
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `Weekly on ${days.map((d) => names[d]).join(", ") || "-"} at ${schedule.daily_time} (${timeZone})`;
    }
    case "monthly":
      return `Monthly on day ${schedule.day_of_month} at ${schedule.daily_time} (${timeZone})`;
    case "cron":
      return `Cron ${schedule.cron_expression} (${timeZone})`;
    default:
      return schedule.start_at ? `Once at ${schedule.start_at}` : "Once";
  }
}
