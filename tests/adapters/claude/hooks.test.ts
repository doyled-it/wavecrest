// tests/adapters/claude/hooks.test.ts
import { expect, test } from "bun:test";
import { hookEventToSessionUpdate, claudeInstallInstructions } from "../../../src/adapters/claude/hooks.ts";
import { claudeResumeCommand } from "../../../src/adapters/claude/resume.ts";
import type { Session } from "../../../src/types.ts";

test("SessionStart marks working and captures session id + transcript path", () => {
  const upd = hookEventToSessionUpdate("SessionStart", {
    session_id: "abc-123",
    transcript_path: "/Users/x/.claude/projects/foo/abc-123.jsonl",
  });
  expect(upd?.status).toBe("working");
  expect(upd?.agent_session_id).toBe("abc-123");
  expect(upd?.transcript_path).toContain("abc-123.jsonl");
});

test("PreToolUse with AskUserQuestion → awaiting", () => {
  expect(hookEventToSessionUpdate("PreToolUse", { tool_name: "AskUserQuestion" })?.status).toBe("awaiting");
});

test("PreToolUse with other tool → working", () => {
  expect(hookEventToSessionUpdate("PreToolUse", { tool_name: "Read" })?.status).toBe("working");
});

test("Notification with permission_prompt → awaiting", () => {
  expect(hookEventToSessionUpdate("Notification", { matcher: "permission_prompt" })?.status).toBe("awaiting");
});

test("Stop → idle", () => {
  expect(hookEventToSessionUpdate("Stop", {})?.status).toBe("idle");
});

test("SessionEnd → finished", () => {
  expect(hookEventToSessionUpdate("SessionEnd", {})?.status).toBe("finished");
});

test("unknown event → null", () => {
  expect(hookEventToSessionUpdate("SomethingElse", {})).toBeNull();
});

test("claudeInstallInstructions returns hooks for all 6 event names", () => {
  const cfg = claudeInstallInstructions("/usr/local/bin/wavecrest");
  const events = ["SessionStart", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
  for (const evt of events) {
    expect(cfg.hooks[evt]).toBeDefined();
    const entry = cfg.hooks[evt]![0]!;
    expect(entry.hooks[0]!.type).toBe("command");
    expect(entry.hooks[0]!.command).toBe(`/usr/local/bin/wavecrest hook ${evt}`);
  }
});

test("PostToolUse → working", () => {
  expect(hookEventToSessionUpdate("PostToolUse", { tool_name: "Read" })?.status).toBe("working");
});

test("Notification with unrelated matcher → no status, has last_active_at", () => {
  const upd = hookEventToSessionUpdate("Notification", { matcher: "some_future_event" });
  expect(upd).not.toBeNull();
  expect(upd!.status).toBeUndefined();
  expect(typeof upd!.last_active_at).toBe("number");
});

test("claudeResumeCommand without agent_session_id returns ['claude']", () => {
  const session = { agent_session_id: null } as unknown as Session;
  expect(claudeResumeCommand(session)).toEqual(["claude"]);
});

test("claudeResumeCommand with agent_session_id returns resume args", () => {
  const session = { agent_session_id: "abc-123" } as unknown as Session;
  expect(claudeResumeCommand(session)).toEqual(["claude", "--resume", "abc-123"]);
});
