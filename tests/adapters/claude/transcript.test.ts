import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseClaudeTranscript } from "../../../src/adapters/claude/transcript.ts";

test("parses a real transcript and extracts usage", async () => {
  const msgs: any[] = [];
  for await (const m of parseClaudeTranscript("tests/fixtures/claude-transcript.jsonl")) {
    msgs.push(m);
  }
  const asst = msgs.filter(m => m.role === "assistant");
  expect(asst.length).toBeGreaterThan(0);
  const withUsage = asst.find(m => m.usage);
  expect(withUsage).toBeDefined();
  expect(typeof withUsage.usage.input_tokens).toBe("number");
  expect(typeof withUsage.usage.output_tokens).toBe("number");
});

test("silently skips malformed JSON lines without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wavecrest-test-"));
  const tmpFile = join(dir, "malformed.jsonl");
  try {
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-05-22T10:00:00.000Z", message: { role: "user", content: "hello" } }),
      "{",  // malformed
      JSON.stringify({ type: "assistant", timestamp: "2026-05-22T10:00:01.000Z", message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "world" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    ].join("\n");
    writeFileSync(tmpFile, lines, "utf8");

    const msgs: any[] = [];
    for await (const m of parseClaudeTranscript(tmpFile)) {
      msgs.push(m);
    }
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("cache token fields are populated correctly when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wavecrest-test-"));
  const tmpFile = join(dir, "cache.jsonl");
  try {
    const assistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-22T10:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "response" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    });
    writeFileSync(tmpFile, assistantLine + "\n", "utf8");

    const msgs: any[] = [];
    for await (const m of parseClaudeTranscript(tmpFile)) {
      msgs.push(m);
    }

    expect(msgs.length).toBe(1);
    const msg = msgs[0]!;
    expect(msg.role).toBe("assistant");
    expect(msg.usage).toBeDefined();
    expect(msg.usage.input_tokens).toBe(10);
    expect(msg.usage.output_tokens).toBe(5);
    expect(msg.usage.cache_read_tokens).toBe(100);
    expect(msg.usage.cache_creation_tokens).toBe(20);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
