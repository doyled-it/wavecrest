// tests/commands/install.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  installClaudeHooks,
  removeClaudeHooks,
  installWaveWidget,
  removeWaveWidget,
} from "../../src/commands/install.ts";

let tmpHome: string;
let settingsPath: string;
let widgetsPath: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  settingsPath = join(tmpHome, ".claude", "settings.json");
  widgetsPath = join(tmpHome, ".config", "waveterm", "widgets.json");
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── installClaudeHooks ───────────────────────────────────────────────────────

test("installClaudeHooks creates settings file if none exists", () => {
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  expect(existsSync(settingsPath)).toBe(true);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.hooks).toBeDefined();
  expect(s.hooks.SessionStart).toBeDefined();
});

test("installClaudeHooks writes all 6 hook events", () => {
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const events = ["SessionStart", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
  for (const evt of events) {
    expect(s.hooks[evt]).toBeDefined();
    expect(s.hooks[evt].length).toBeGreaterThan(0);
  }
});

test("installClaudeHooks tags each entry for idempotency detection", () => {
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const entries of Object.values(s.hooks) as any[][]) {
    for (const entry of entries) {
      expect(JSON.stringify(entry)).toContain("wavecrest:");
    }
  }
});

test("installClaudeHooks is idempotent — second install does not duplicate entries", () => {
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const [evt, entries] of Object.entries(s.hooks) as [string, any[]][]) {
    const wavecrestEntries = entries.filter((e: any) =>
      JSON.stringify(e).includes("wavecrest:"),
    );
    expect(wavecrestEntries.length).toBe(1);
  }
});

test("installClaudeHooks preserves pre-existing non-wavecrest hooks", () => {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
      },
    }),
    "utf8",
  );

  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const starts = s.hooks.SessionStart as any[];

  // The original non-wavecrest entry should still be present
  const echoEntry = starts.find((e: any) =>
    JSON.stringify(e).includes("echo hello"),
  );
  expect(echoEntry).toBeDefined();

  // Plus exactly one wavecrest entry
  const wcEntries = starts.filter((e: any) =>
    JSON.stringify(e).includes("wavecrest:"),
  );
  expect(wcEntries.length).toBe(1);
});

// ─── removeClaudeHooks ────────────────────────────────────────────────────────

test("removeClaudeHooks removes all wavecrest entries", () => {
  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  removeClaudeHooks(settingsPath);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  // hooks key should be gone or empty
  if (s.hooks) {
    for (const entries of Object.values(s.hooks) as any[][]) {
      const wcEntries = entries.filter((e: any) =>
        JSON.stringify(e).includes("wavecrest:"),
      );
      expect(wcEntries.length).toBe(0);
    }
  }
});

test("removeClaudeHooks leaves non-wavecrest hooks intact", () => {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
      },
    }),
    "utf8",
  );

  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  removeClaudeHooks(settingsPath);

  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const starts = (s.hooks?.SessionStart ?? []) as any[];
  const echoEntry = starts.find((e: any) => JSON.stringify(e).includes("echo hello"));
  expect(echoEntry).toBeDefined();
});

test("round-trip: install then uninstall restores original state", () => {
  const original = {
    theme: "dark",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
    },
  };
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(original, null, 2), "utf8");

  installClaudeHooks(settingsPath, "/usr/local/bin/wavecrest");
  removeClaudeHooks(settingsPath);

  const result = JSON.parse(readFileSync(settingsPath, "utf8"));

  // theme should be preserved
  expect(result.theme).toBe("dark");

  // Only the original echo entry should remain
  const starts = result.hooks?.SessionStart ?? [];
  const echoEntry = starts.find((e: any) => JSON.stringify(e).includes("echo start"));
  expect(echoEntry).toBeDefined();

  const wcEntries = starts.filter((e: any) => JSON.stringify(e).includes("wavecrest:"));
  expect(wcEntries.length).toBe(0);
});

test("removeClaudeHooks is safe when settings file does not exist", () => {
  expect(() => removeClaudeHooks(settingsPath)).not.toThrow();
});

// ─── Widget helpers ───────────────────────────────────────────────────────────

test("installWaveWidget writes wavecrest entry", () => {
  installWaveWidget(widgetsPath);
  const w = JSON.parse(readFileSync(widgetsPath, "utf8"));
  expect(w.wavecrest).toBeDefined();
  expect(w.wavecrest.url).toBe("http://127.0.0.1:17321/ui/");
});

test("installWaveWidget is idempotent", () => {
  installWaveWidget(widgetsPath);
  installWaveWidget(widgetsPath);
  const w = JSON.parse(readFileSync(widgetsPath, "utf8"));
  expect(Object.keys(w).filter((k) => k === "wavecrest").length).toBe(1);
});

test("removeWaveWidget removes wavecrest entry", () => {
  installWaveWidget(widgetsPath);
  removeWaveWidget(widgetsPath);
  const w = JSON.parse(readFileSync(widgetsPath, "utf8"));
  expect(w.wavecrest).toBeUndefined();
});

test("removeWaveWidget preserves other widget entries", () => {
  mkdirSync(join(tmpHome, ".config", "waveterm"), { recursive: true });
  writeFileSync(widgetsPath, JSON.stringify({ other: { type: "web", url: "http://example.com" } }), "utf8");
  installWaveWidget(widgetsPath);
  removeWaveWidget(widgetsPath);
  const w = JSON.parse(readFileSync(widgetsPath, "utf8"));
  expect(w.other).toBeDefined();
  expect(w.wavecrest).toBeUndefined();
});
