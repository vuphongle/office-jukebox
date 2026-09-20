export const DEFAULT_WEEKLY_TIMEZONE = "Asia/Ho_Chi_Minh";

// Weekly competition rewards music participation only. Chat XP still advances
// lifetime rank, but cannot turn the weekly leaderboard into a message race.
export const WEEKLY_MUSIC_ACTIVITY_TYPES = Object.freeze([
  "qualified_play",
  "vote_participation",
]);

function zonedDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function timezoneOffsetMs(instant, timezone) {
  const { year, month, day, hour, minute, second } = zonedDateParts(new Date(instant), timezone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - instant;
}

function zonedMidnightToUtc({ year, month, day }, timezone) {
  const localMidnight = Date.UTC(year, month - 1, day);
  let instant = localMidnight;
  // Re-evaluate once so zones with a DST change around the boundary resolve
  // from their actual offset instead of the UTC date's apparent offset.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    instant = localMidnight - timezoneOffsetMs(instant, timezone);
  }
  return new Date(instant);
}

function addCalendarDays(parts, days) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function formatLocalDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Resolve a Monday-to-Monday calendar period in the configured business
 * timezone. Ledger timestamps remain UTC ISO strings, so SQL can use this
 * exact [start, end) interval without mutating persistent XP totals.
 */
export function getWeeklyPeriod({ now = new Date(), timezone = DEFAULT_WEEKLY_TIMEZONE } = {}) {
  let localToday;
  try {
    localToday = zonedDateParts(now, timezone);
  } catch {
    localToday = {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
    };
    timezone = "UTC";
  }
  const dayOfWeek = new Date(Date.UTC(localToday.year, localToday.month - 1, localToday.day)).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const startLocal = addCalendarDays(localToday, -daysSinceMonday);
  const endLocal = addCalendarDays(startLocal, 7);
  const startAt = zonedMidnightToUtc(startLocal, timezone);
  const endAt = zonedMidnightToUtc(endLocal, timezone);

  return {
    id: `week-${formatLocalDate(startLocal)}`,
    timezone,
    startDate: formatLocalDate(startLocal),
    endDate: formatLocalDate(endLocal),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
}
