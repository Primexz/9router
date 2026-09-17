import { addDaysToDateKey, formatInTimeZone, getDateKey, normalizeTimeZone, startOfDateKeyInTimeZone } from "../shared/utils/timeZone.js";

export const PERFORMANCE_RETENTION_DAYS = 90;
export const PERFORMANCE_SAMPLE_LIMIT = 50000;
export const PERFORMANCE_PERIODS = ["today", "24h", "7d", "30d", "90d"];

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizePerformanceSample(detail) {
  const timestamp = new Date(detail.timestamp);
  if (!detail.id || !Number.isFinite(timestamp.getTime())) return null;
  const httpStatus = nonNegativeNumber(detail.response?.status);
  const pending = detail.response?.content === "[Streaming in progress...]";
  const status = String(detail.status || "").toLowerCase();
  const outcome = pending ? "pending"
    : httpStatus === 499 || status === "cancelled" || status === "canceled" ? "cancelled"
    : status === "error" || status === "failed" || httpStatus >= 400 ? "error"
    : status === "success" || status === "ok" ? "success" : "unknown";
  const latencyMs = nonNegativeNumber(detail.latency?.total);
  const firstToken = nonNegativeNumber(detail.latency?.ttft);
  const streaming = detail.response?.type === "streaming";
  const ttftMs = outcome === "success" && streaming && firstToken > 0 && latencyMs > firstToken ? firstToken : null;
  return {
    id: detail.id,
    timestamp: timestamp.toISOString(),
    provider: detail.provider || "unknown",
    model: detail.model || "unknown",
    connectionId: detail.connectionId || null,
    mode: detail.fastMode === true ? "fast" : detail.fastMode === false ? "standard" : "unknown",
    outcome,
    httpStatus,
    latencyMs: latencyMs > 0 && outcome !== "pending" ? latencyMs : null,
    ttftMs,
    outputTokens: nonNegativeNumber(detail.tokens?.completion_tokens ?? detail.tokens?.output_tokens),
  };
}

export function performanceStart(period, now = new Date(), requestedTimeZone = "UTC") {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  if (period === "24h") return new Date(now.getTime() - 86400000);
  const days = period === "today" ? 0 : Number.parseInt(period, 10) - 1;
  const startKey = addDaysToDateKey(getDateKey(now, timeZone), -days);
  return startOfDateKeyInTimeZone(startKey, timeZone);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizePerformance(samples) {
  const successful = samples.filter((sample) => sample.outcome === "success");
  const errors = samples.filter((sample) => sample.outcome === "error").length;
  const timings = successful.map((sample) => sample.latencyMs).filter((value) => value > 0);
  const firstTokens = successful.map((sample) => sample.ttftMs).filter((value) => value > 0);
  const speeds = successful.filter((sample) => sample.ttftMs > 0 && sample.latencyMs > sample.ttftMs && sample.outputTokens > 0)
    .map((sample) => sample.outputTokens * 1000 / (sample.latencyMs - sample.ttftMs));
  const completed = successful.length + errors;
  return {
    attempts: samples.length,
    successes: successful.length,
    errors,
    cancelled: samples.filter((sample) => sample.outcome === "cancelled").length,
    incomplete: samples.filter((sample) => sample.outcome === "pending" || sample.outcome === "unknown").length,
    successRate: completed ? successful.length / completed * 100 : null,
    medianLatencyMs: percentile(timings, 0.5),
    p95LatencyMs: percentile(timings, 0.95),
    medianTtftMs: percentile(firstTokens, 0.5),
    p95TtftMs: percentile(firstTokens, 0.95),
    medianOutputTps: percentile(speeds, 0.5),
    latencySamples: timings.length,
    ttftSamples: firstTokens.length,
    throughputSamples: speeds.length,
  };
}

export function failureCategory(sample) {
  if (sample.outcome === "cancelled") return "Cancelled";
  if (sample.httpStatus === 429) return "Rate limited";
  if (sample.httpStatus === 401 || sample.httpStatus === 403) return "Authentication / access";
  if (sample.httpStatus >= 500) return "Upstream / gateway";
  if (sample.httpStatus >= 400) return "Other HTTP 4xx";
  return "Unclassified error";
}

export function buildPerformanceDashboard(samples, period, now = new Date(), requestedTimeZone = "UTC") {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const start = performanceStart(period, now, timeZone);
  const hourly = period === "today" || period === "24h";
  const groups = { provider: new Map(), model: new Map(), account: new Map() };
  const failures = new Map();
  const buckets = new Map();
  const cursor = new Date(start);
  if (hourly) cursor.setMinutes(0, 0, 0);
  while (cursor <= now) {
    const key = hourly ? String(cursor.getTime()) : getDateKey(cursor, timeZone);
    buckets.set(key, {
      timestamp: cursor.toISOString(),
      label: formatInTimeZone(cursor, timeZone, hourly ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }),
      samples: [],
    });
    if (hourly) cursor.setTime(cursor.getTime() + 3600000);
    else cursor.setDate(cursor.getDate() + 1);
  }
  for (const sample of samples) {
    const date = new Date(sample.timestamp);
    const hourlyKey = String(start.getTime() + Math.floor((date.getTime() - start.getTime()) / 3600000) * 3600000);
    buckets.get(hourly ? hourlyKey : getDateKey(date, timeZone))?.samples.push(sample);
    const keys = {
      provider: sample.provider,
      model: JSON.stringify([sample.provider, sample.model, sample.mode]),
      account: JSON.stringify([sample.provider, sample.connectionId]),
    };
    for (const [dimension, key] of Object.entries(keys)) {
      if (!groups[dimension].has(key)) groups[dimension].set(key, []);
      groups[dimension].get(key).push(sample);
    }
    if (sample.outcome === "error" || sample.outcome === "cancelled") {
      const category = failureCategory(sample);
      failures.set(category, (failures.get(category) || 0) + 1);
    }
  }
  return {
    summary: summarizePerformance(samples),
    trend: [...buckets.values()].map(({ timestamp, label, samples: bucketSamples }) => ({ timestamp, label, ...summarizePerformance(bucketSamples) })),
    groups: Object.fromEntries(Object.entries(groups).map(([dimension, map]) => [dimension, [...map.entries()].map(([key, entries]) => ({
      key,
      provider: entries[0].provider,
      model: entries[0].model,
      connectionId: entries[0].connectionId,
      mode: entries[0].mode,
      accountName: entries[0].accountName || entries[0].connectionId || "Unassigned",
      ...summarizePerformance(entries),
    })).sort((left, right) => right.attempts - left.attempts)])),
    failures: [...failures.entries()].map(([category, count]) => ({ category, count })).sort((left, right) => right.count - left.count),
    recentFailures: samples.filter((sample) => sample.outcome === "error" || sample.outcome === "cancelled").slice(0, 10).map((sample) => ({
      id: sample.id, timestamp: sample.timestamp, provider: sample.provider, model: sample.model,
      httpStatus: sample.httpStatus, category: failureCategory(sample),
    })),
  };
}
