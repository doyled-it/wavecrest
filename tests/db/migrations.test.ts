import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../src/db/index.ts";

test("openDb applies migrations and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-test-"));
  try {
    const db = openDb(join(dir, "test.db"));
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("events");
    expect(names).toContain("usage_snapshots");
    expect(names).toContain("session_token_rollup");
    db.close();

    // re-open: must not error
    const db2 = openDb(join(dir, "test.db"));
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
