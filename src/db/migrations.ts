import { Database } from "bun:sqlite";
import init0001 from "./migrations/0001_init.sql" with { type: "text" };

const migrations = [
  { version: 1, sql: init0001 },
];

export function runMigrations(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(r => r.version)
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.run(m.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [m.version, Date.now()]);
    })();
  }
}
