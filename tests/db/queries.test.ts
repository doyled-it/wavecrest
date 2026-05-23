import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../src/db/index.ts";
import {
  insertSession,
  getSession,
  upsertRollup,
  getRollup,
  insertUsageSnapshot,
  latestUsageSnapshots,
} from "../../src/db/queries.ts";
import type { Session, AgentKind } from "../../src/types.ts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-1",
    agent_kind: "claude" as AgentKind,
    agent_session_id: null,
    workspace_id: null,
    wave_tab_id: null,
    wave_block_id: null,
    cwd: "/tmp/test",
    repo_root: null,
    branch: null,
    worktree_path: null,
    launch_argv: ["node", "index.js"],
    display_name: null,
    status: "idle",
    auto_resume: false,
    pinned: false,
    created_at: 1000000,
    last_active_at: 1000001,
    transcript_path: null,
    ...overrides,
  };
}

test("insertSession then getSession roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-queries-test-"));
  const db = openDb(join(dir, "test.db"));
  try {
    const session = makeSession({
      id: "roundtrip-1",
      agent_session_id: "agent-abc",
      workspace_id: null,
      wave_tab_id: "tab-1",
      wave_block_id: "blk-1",
      repo_root: "/repo",
      branch: "main",
      worktree_path: "/repo/.worktrees/feat",
      launch_argv: ["claude", "--dangerously-skip-permissions"],
      display_name: "My Session",
      status: "working",
      auto_resume: true,
      pinned: true,
      created_at: 1700000000000,
      last_active_at: 1700000001000,
      transcript_path: "/tmp/transcript.jsonl",
    });
    insertSession(db, session);
    const got = getSession(db, "roundtrip-1");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("roundtrip-1");
    expect(got!.agent_session_id).toBe("agent-abc");
    expect(got!.workspace_id).toBeNull();
    expect(got!.wave_tab_id).toBe("tab-1");
    expect(got!.wave_block_id).toBe("blk-1");
    expect(got!.repo_root).toBe("/repo");
    expect(got!.branch).toBe("main");
    expect(got!.worktree_path).toBe("/repo/.worktrees/feat");
    // launch_argv must round-trip as an array
    expect(got!.launch_argv).toEqual(["claude", "--dangerously-skip-permissions"]);
    expect(got!.display_name).toBe("My Session");
    expect(got!.status).toBe("working");
    // boolean coercion from INTEGER
    expect(got!.auto_resume).toBe(true);
    expect(got!.pinned).toBe(true);
    expect(got!.created_at).toBe(1700000000000);
    expect(got!.last_active_at).toBe(1700000001000);
    expect(got!.transcript_path).toBe("/tmp/transcript.jsonl");
    // nullable fields stay null when not set
    const session2 = makeSession({ id: "roundtrip-2" });
    insertSession(db, session2);
    const got2 = getSession(db, "roundtrip-2");
    expect(got2!.agent_session_id).toBeNull();
    expect(got2!.auto_resume).toBe(false);
    expect(got2!.pinned).toBe(false);
    expect(got2!.launch_argv).toEqual(["node", "index.js"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertRollup accumulates token counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-queries-test-"));
  const db = openDb(join(dir, "test.db"));
  try {
    const session = makeSession({ id: "rollup-session" });
    insertSession(db, session);

    upsertRollup(db, {
      session_id: "rollup-session",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      cost_usd: 0.01,
      updated_at: 1000,
    });
    upsertRollup(db, {
      session_id: "rollup-session",
      input_tokens: 7,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 3,
      cost_usd: 0.005,
      updated_at: 2000,
    });

    const rollup = getRollup(db, "rollup-session");
    expect(rollup).not.toBeNull();
    expect(rollup!.input_tokens).toBe(17);
    expect(rollup!.output_tokens).toBe(7);
    expect(rollup!.cache_read_tokens).toBe(2);
    expect(rollup!.cache_write_tokens).toBe(4);
    expect(rollup!.updated_at).toBe(2000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latestUsageSnapshots resolves ties by MAX(id), returns exactly one row", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-queries-test-"));
  const db = openDb(join(dir, "test.db"));
  try {
    const sameTs = 9999999;
    // Insert two snapshots with the SAME ts and same (scope, scope_key)
    insertUsageSnapshot(db, {
      agent_kind: "claude",
      ts: sameTs,
      scope: "session",
      scope_key: "key-a",
      used: 10,
      limit: 100,
      resets_at: null,
    });
    insertUsageSnapshot(db, {
      agent_kind: "claude",
      ts: sameTs,
      scope: "session",
      scope_key: "key-a",
      used: 20,
      limit: 100,
      resets_at: null,
    });

    const results = latestUsageSnapshots(db, "claude");
    expect(results).toHaveLength(1);
    // Must be the one with the higher id (used=20, inserted second)
    expect(results[0]!.used).toBe(20);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rowToSession throws with session id on malformed launch_argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-queries-test-"));
  const db = openDb(join(dir, "test.db"));
  try {
    // Insert a valid session first so the FK is satisfied, then corrupt launch_argv via raw SQL
    const session = makeSession({ id: "bad-argv-session" });
    insertSession(db, session);
    db.run("UPDATE sessions SET launch_argv='not-json' WHERE id='bad-argv-session'");

    expect(() => getSession(db, "bad-argv-session")).toThrow("bad-argv-session");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
