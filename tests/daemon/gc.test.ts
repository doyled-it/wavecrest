import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../src/db/index.ts";
import { insertSession, getSession } from "../../src/db/queries.ts";
import { runGc, RETENTION_MS, STALE_REAP_MS } from "../../src/daemon/gc.ts";
import type { Session, AgentKind } from "../../src/types.ts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s", agent_kind: "claude" as AgentKind, agent_session_id: null,
    workspace_id: null, wave_tab_id: null, wave_block_id: null,
    cwd: "/tmp/test", repo_root: null, branch: null, worktree_path: null,
    launch_argv: ["claude"], display_name: null, status: "idle",
    auto_resume: false, pinned: false, created_at: 1000, last_active_at: 1000,
    transcript_path: null, ...overrides,
  };
}

test("runGc reaps stale zombies then deletes aged-out finished rows in one pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-gc-run-"));
  const db = openDb(join(dir, "state.db"));
  try {
    const NOW = 1_000_000_000_000;
    // A zombie just past the reap threshold → reaped to finished (but still within
    // retention, so NOT deleted this pass).
    insertSession(db, makeSession({ id: "zombie", status: "working", last_active_at: NOW - STALE_REAP_MS - 1000 }));
    // A finished session older than retention → deleted.
    insertSession(db, makeSession({ id: "ancient", status: "finished", last_active_at: NOW - RETENTION_MS - 1000 }));
    // A fresh working session → untouched.
    insertSession(db, makeSession({ id: "alive", status: "working", last_active_at: NOW - 1000 }));

    const { reaped, deleted } = runGc(db, NOW);

    expect(reaped).toBe(1);
    expect(deleted).toBe(1);
    expect(getSession(db, "zombie")!.status).toBe("finished");
    expect(getSession(db, "ancient")).toBeNull();
    expect(getSession(db, "alive")!.status).toBe("working");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGc is a no-op (returns zeros) when nothing is stale or aged out", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-gc-noop-"));
  const db = openDb(join(dir, "state.db"));
  try {
    const NOW = 1_000_000_000_000;
    insertSession(db, makeSession({ id: "alive", status: "working", last_active_at: NOW - 1000 }));
    insertSession(db, makeSession({ id: "recent-finished", status: "finished", last_active_at: NOW - 1000 }));
    const { reaped, deleted } = runGc(db, NOW);
    expect(reaped).toBe(0);
    expect(deleted).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
