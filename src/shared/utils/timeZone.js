export const DEFAULT_TIME_ZONE = "UTC";

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(timeZone) {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

export function getAvailableTimeZones() {
  if (typeof Intl.supportedValuesOf === "function") {
    return [...new Set([DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")])];
  }
  return [DEFAULT_TIME_ZONE];
}

export function formatInTimeZone(value, timeZone, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    timeZone: normalizeTimeZone(timeZone),
  }).format(date);
}

function dateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function getDateKey(value, timeZone) {
  const { year, month, day } = dateParts(value instanceof Date ? value : new Date(value), timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function startOfDateKeyInTimeZone(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  for (let index = 0; index < 3; index++) {
    const parts = dateParts(new Date(instant), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += target - represented;
  }
  return new Date(instant);
}

export function startOfDayInTimeZone(value, timeZone) {
  return startOfDateKeyInTimeZone(getDateKey(value, timeZone), timeZone);
}

export function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
