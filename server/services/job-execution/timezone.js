// Time-zone aware calendar helpers for the scheduling engine.
//
// The engine never depends on the host time zone: every recurrence rule is
// evaluated in the schedule's configured zone and converted to a UTC instant
// for storage. Uses Intl.DateTimeFormat only (no external dependencies).

const FORMATTERS = new Map();

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Returns the wall-clock components of `date` as observed in `timeZone`.
export function zonedParts(date, timeZone = "UTC") {
  const parts = formatterFor(timeZone).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

// Milliseconds that `timeZone` is ahead of UTC at the given instant.
function zoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - (date.getTime() - date.getMilliseconds());
}

// Converts wall-clock parts observed in `timeZone` into a UTC Date. The
// two-pass offset resolution handles DST transitions; non-existent local times
// are shifted forward to the next valid instant.
export function zonedTimeToUtc(parts, timeZone = "UTC") {
  const base = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  let ts = base - zoneOffsetMs(new Date(base), timeZone);
  ts = base - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    String(value || "").trim()
  );
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
  };
}

// Parses an ISO-like instant. Values carrying an explicit offset/`Z` are
// absolute; wall-clock values are interpreted in the schedule time zone.
export function parseInstant(value, timeZone = "UTC") {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parts = parseDateParts(text);
  if (!parts) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return zonedTimeToUtc(parts, timeZone);
}

export function addCalendarDays(dateParts, days) {
  const probe = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days)
  );
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
  };
}

export function calendarWeekday(dateParts) {
  return new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)
  ).getUTCDay();
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseClock(value, fallback = { hour: 0, minute: 0 }) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return fallback;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// Storage format used across the platform: "YYYY-MM-DD HH:MM:SS" in UTC.
export function sqlTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function parseSqlTime(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sqlTimeAfterSeconds(base, seconds) {
  const date = parseSqlTime(base) || new Date();
  date.setSeconds(date.getSeconds() + Number(seconds || 0));
  return sqlTime(date);
}
