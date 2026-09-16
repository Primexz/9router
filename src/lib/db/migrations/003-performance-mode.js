const migration = {
  version: 3,
  name: "performance mode",
  up(db) {
    if (!db.all("PRAGMA table_info(performanceSamples)").some((column) => column.name === "mode")) {
      db.exec("ALTER TABLE performanceSamples ADD COLUMN mode TEXT NOT NULL DEFAULT 'unknown'");
    }
  },
};

export default migration;
