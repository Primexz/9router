import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { buildPerformanceDashboard, normalizePerformanceSample, performanceStart, PERFORMANCE_RETENTION_DAYS, PERFORMANCE_SAMPLE_LIMIT } from "../../performanceMetrics.js";

let lastCleanup = 0;

function writeSample(db, sample, replace = true) {
  if (!sample) return;
  const columns = ["id", "timestamp", "provider", "model", "connectionId", "mode", "outcome", "httpStatus", "latencyMs", "ttftMs", "outputTokens"];
  db.run(
    `INSERT INTO performanceSamples (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(id) DO ${replace ? `UPDATE SET ${columns.slice(1).map((column) => `${column} = excluded.${column}`).join(", ")}` : "NOTHING"}`,
    columns.map((column) => sample[column])
  );
}

function pruneSamples(db, now) {
  if (now.getTime() - lastCleanup < 3600000) return;
  db.run("DELETE FROM performanceSamples WHERE timestamp < ?", [performanceStart(`${PERFORMANCE_RETENTION_DAYS}d`, now).toISOString()]);
  lastCleanup = now.getTime();
}

export async function savePerformanceSample(detail) {
  const sample = normalizePerformanceSample(detail);
  if (!sample) return;
  const db = await getAdapter();
  db.transaction(() => {
    writeSample(db, sample);
    pruneSamples(db, new Date());
  });
}

export async function getPerformanceDashboard({ period = "24h", provider = "", model = "", connectionId = "", mode = "" } = {}) {
  const db = await getAdapter();
  const now = new Date();
  const retentionStart = performanceStart(`${PERFORMANCE_RETENTION_DAYS}d`, now).toISOString();
  const legacy = db.all(
    `SELECT details.id, details.data FROM requestDetails details LEFT JOIN performanceSamples samples ON samples.id = details.id
     WHERE samples.id IS NULL AND details.timestamp >= ? AND details.timestamp <= ? ORDER BY details.timestamp DESC LIMIT 1000`,
    [retentionStart, now.toISOString()]
  );
  db.transaction(() => {
    for (const row of legacy) writeSample(db, normalizePerformanceSample({ ...parseJson(row.data, {}), id: row.id }), false);
    pruneSamples(db, now);
  });
  const conditions = ["samples.timestamp >= ?", "samples.timestamp <= ?"];
  const params = [performanceStart(period, now).toISOString(), now.toISOString()];
  for (const [column, value] of [["provider", provider], ["model", model], ["connectionId", connectionId], ["mode", mode]]) {
    if (value) { conditions.push(`samples.${column} = ?`); params.push(value); }
  }
  const where = conditions.join(" AND ");
  const total = db.get(`SELECT COUNT(*) AS count FROM performanceSamples samples WHERE ${where}`, params)?.count || 0;
  const samples = db.all(
    `SELECT samples.*, connections.name AS accountName FROM performanceSamples samples
     LEFT JOIN providerConnections connections ON samples.connectionId = connections.id
     WHERE ${where} ORDER BY samples.timestamp DESC, samples.id DESC LIMIT ?`,
    [...params, PERFORMANCE_SAMPLE_LIMIT]
  );
  const options = db.all(
    `SELECT DISTINCT samples.provider, samples.model, samples.connectionId, samples.mode, connections.name AS accountName
     FROM performanceSamples samples LEFT JOIN providerConnections connections ON samples.connectionId = connections.id
     WHERE samples.timestamp >= ? AND samples.timestamp <= ? ORDER BY samples.provider, samples.model`,
    [retentionStart, now.toISOString()]
  );
  return {
    ...buildPerformanceDashboard(samples, period, now),
    options,
    coverage: {
      retainedSince: db.get("SELECT MIN(timestamp) AS timestamp FROM performanceSamples WHERE timestamp >= ?", [retentionStart])?.timestamp || null,
      matchingAttempts: total,
      sampledAttempts: samples.length,
      sampleLimit: PERFORMANCE_SAMPLE_LIMIT,
      truncated: total > samples.length,
      retentionDays: PERFORMANCE_RETENTION_DAYS,
    },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    updatedAt: now.toISOString(),
  };
}
