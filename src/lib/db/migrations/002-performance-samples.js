const migration = {
  version: 2,
  name: "performance samples",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS performanceSamples (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      connectionId TEXT, outcome TEXT NOT NULL, httpStatus INTEGER, latencyMs REAL, ttftMs REAL, outputTokens INTEGER
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_perf_ts ON performanceSamples(timestamp DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_perf_provider_ts ON performanceSamples(provider, timestamp DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_perf_conn_ts ON performanceSamples(connectionId, timestamp DESC)");
  },
};

export default migration;
