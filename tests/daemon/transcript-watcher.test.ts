import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDb } from "../../src/db/index.ts";
import { insertSession, getRollup } from "../../src/db/queries.ts";
import { startTranscriptWatcher } from "../../src/daemon/transcript-watcher.ts";
import { ulid } from "../../src/lib/ulid.ts";

function makeSession(agentSessionId: string, transcriptPath: string) {
  return {
    id: ulid(),
    agent_kind: "claude" as const,
    agent_session_id: agentSessionId,
    workspace_id: null,
    wave_tab_id: null,
    wave_block_id: null,
    cwd: "/tmp",
    repo_root: null,
    branch: null,
    worktree_path: null,
    launch_argv: ["claude"],
    display_name: null,
    status: "working" as const,
    auto_resume: true,
    pinned: false,
    created_at: Date.now(),
    last_active_at: Date.now(),
    transcript_path: transcriptPath,
  };
}

function assistantLine(sessionId: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }) + "\n";
}

test("watcher tails JSONL and rolls up usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-tw-"));
  const db = openDb(join(dir, "test.db"));
  const transcript = join(dir, "abc.jsonl");
  writeFileSync(transcript, "");

  const sid = ulid();
  insertSession(db, {
    id: sid,
    agent_kind: "claude",
    agent_session_id: "abc",
    workspace_id: null,
    wave_tab_id: null,
    wave_block_id: null,
    cwd: "/tmp",
    repo_root: null,
    branch: null,
    worktree_path: null,
    launch_argv: ["claude"],
    display_name: null,
    status: "working",
    auto_resume: true,
    pinned: false,
    created_at: Date.now(),
    last_active_at: Date.now(),
    transcript_path: transcript,
  });

  const w = startTranscriptWatcher(db, [dir]);
  await new Promise(r => setTimeout(r, 200));

  appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      session_id: "abc",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }) + "\n",
  );
  await new Promise(r => setTimeout(r, 800));

  const r = getRollup(db, sid);
  expect(r?.input_tokens).toBe(10);
  expect(r?.output_tokens).toBe(5);

  w.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("watcher accumulates tokens across multiple appends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-tw-acc-"));
  const db = openDb(join(dir, "test.db"));
  const transcript = join(dir, "multi.jsonl");
  writeFileSync(transcript, "");

  const agentSid = "multi-session";
  const sess = makeSession(agentSid, transcript);
  insertSession(db, sess);

  const w = startTranscriptWatcher(db, [dir]);
  await new Promise(r => setTimeout(r, 200));

  // First append
  appendFileSync(transcript, assistantLine(agentSid, 100, 50));
  await new Promise(r => setTimeout(r, 800));

  // Second append
  appendFileSync(transcript, assistantLine(agentSid, 200, 75));
  await new Promise(r => setTimeout(r, 800));

  const r = getRollup(db, sess.id);
  expect(r?.input_tokens).toBe(300);
  expect(r?.output_tokens).toBe(125);

  w.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("watcher ignores lines without usage block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-tw-nousage-"));
  const db = openDb(join(dir, "test.db"));
  const transcript = join(dir, "nousage.jsonl");
  writeFileSync(transcript, "");

  const agentSid = "nousage-session";
  const sess = makeSession(agentSid, transcript);
  insertSession(db, sess);

  const w = startTranscriptWatcher(db, [dir]);
  await new Promise(r => setTimeout(r, 200));

  appendFileSync(
    transcript,
    JSON.stringify({
      type: "human",
      session_id: agentSid,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  await new Promise(r => setTimeout(r, 800));

  const r = getRollup(db, sess.id);
  expect(r).toBeNull();

  w.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("watcher skips lines whose session_id is not registered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-tw-unknown-"));
  const db = openDb(join(dir, "test.db"));
  const transcript = join(dir, "unknown.jsonl");
  writeFileSync(transcript, "");

  // Do NOT insert a session — agent_session_id won't match anything
  const w = startTranscriptWatcher(db, [dir]);
  await new Promise(r => setTimeout(r, 200));

  appendFileSync(transcript, assistantLine("ghost-session", 10, 5));
  await new Promise(r => setTimeout(r, 800));

  // No sessions exist, so no rollup should be created
  const rows = db.query("SELECT * FROM session_token_rollup").all();
  expect(rows.length).toBe(0);

  w.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("watcher silently skips malformed JSON lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-tw-malformed-"));
  const db = openDb(join(dir, "test.db"));
  const transcript = join(dir, "bad.jsonl");
  writeFileSync(transcript, "");

  const agentSid = "malformed-session";
  const sess = makeSession(agentSid, transcript);
  insertSession(db, sess);

  const w = startTranscriptWatcher(db, [dir]);
  await new Promise(r => setTimeout(r, 200));

  // Write a bad line, then a good line
  appendFileSync(transcript, "not valid json\n");
  appendFileSync(transcript, assistantLine(agentSid, 7, 3));
  await new Promise(r => setTimeout(r, 800));

  const r = getRollup(db, sess.id);
  // Good line should still be processed
  expect(r?.input_tokens).toBe(7);
  expect(r?.output_tokens).toBe(3);

  w.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
