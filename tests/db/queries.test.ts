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

test("insertSample + getSubagentBreakdown groups by subagent_type with NULL as 'main'", async () => {
  const { insertSample, getSubagentBreakdown } = await import("../../src/db/queries.ts");
  const dir = mkdtempSync(join(tmpdir(), "wc-q-bd-"));
  const db = openDb(join(dir, "state.db"));
  try {
    insertSession(db, makeSession({ id: "s1" }));
    // 3 main + 2 general-purpose + 1 explore samples
    const base = { session_id: "s1", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    insertSample(db, { ...base, ts: 1, input_tokens: 100, subagent_type: null,              message_uuid: "u1" });
    insertSample(db, { ...base, ts: 2, output_tokens: 50, subagent_type: null,              message_uuid: "u2" });
    insertSample(db, { ...base, ts: 3, cache_read_tokens: 25, subagent_type: null,          message_uuid: "u3" });
    insertSample(db, { ...base, ts: 4, output_tokens: 200, subagent_type: "general-purpose", message_uuid: "u4" });
    insertSample(db, { ...base, ts: 5, output_tokens: 50,  subagent_type: "general-purpose", message_uuid: "u5" });
    insertSample(db, { ...base, ts: 6, output_tokens: 10,  subagent_type: "Explore",         message_uuid: "u6" });

    const slices = getSubagentBreakdown(db, "s1");
    // Sorted desc by total_tokens.
    expect(slices.map(s => s.subagent_type)).toEqual(["general-purpose", "main", "Explore"]);
    expect(slices.find(s => s.subagent_type === "main")?.total_tokens).toBe(175);
    expect(slices.find(s => s.subagent_type === "general-purpose")?.total_tokens).toBe(250);
    expect(slices.find(s => s.subagent_type === "Explore")?.total_tokens).toBe(10);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insertSample is idempotent on (session_id, message_uuid)", async () => {
  const { insertSample, getSubagentBreakdown } = await import("../../src/db/queries.ts");
  const dir = mkdtempSync(join(tmpdir(), "wc-q-idem-"));
  const db = openDb(join(dir, "state.db"));
  try {
    insertSession(db, makeSession({ id: "s1" }));
    const sample = { session_id: "s1", ts: 1, input_tokens: 100, output_tokens: 0,
                     cache_read_tokens: 0, cache_write_tokens: 0, subagent_type: null, message_uuid: "u-dup" };
    insertSample(db, sample);
    insertSample(db, sample); // duplicate — INSERT OR IGNORE
    insertSample(db, sample); // again

    const slices = getSubagentBreakdown(db, "s1");
    expect(slices[0]?.total_tokens).toBe(100); // not 300
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSparkline returns N buckets covering [min_ts, max_ts]", async () => {
  const { insertSample, getSparkline } = await import("../../src/db/queries.ts");
  const dir = mkdtempSync(join(tmpdir(), "wc-q-sl-"));
  const db = openDb(join(dir, "state.db"));
  try {
    insertSession(db, makeSession({ id: "s1" }));
    const base = { session_id: "s1", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, subagent_type: null };
    // Three samples spanning ts=100..200, each contributing 10 tokens.
    insertSample(db, { ...base, ts: 100, output_tokens: 10, message_uuid: "u1" });
    insertSample(db, { ...base, ts: 150, output_tokens: 10, message_uuid: "u2" });
    insertSample(db, { ...base, ts: 200, output_tokens: 10, message_uuid: "u3" });

    const buckets = getSparkline(db, "s1", 10);
    expect(buckets.length).toBe(10);
    // Sum of all buckets equals total tokens (30).
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(30);
    // First bucket has ts=100, last bucket has ts=200.
    expect(buckets[0]).toBe(10);
    expect(buckets[9]).toBe(10);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSparkline returns [] when no samples exist", async () => {
  const { getSparkline } = await import("../../src/db/queries.ts");
  const dir = mkdtempSync(join(tmpdir(), "wc-q-sl-empty-"));
  const db = openDb(join(dir, "state.db"));
  try {
    insertSession(db, makeSession({ id: "s-empty" }));
    expect(getSparkline(db, "s-empty")).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
