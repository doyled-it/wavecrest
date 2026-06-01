import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installMcpServer, removeMcpServer } from "../../src/commands/install.ts";

let tmpHome: string;
let settingsPath: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wc-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  settingsPath = join(tmpHome, ".claude", "settings.json");
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("installMcpServer adds wavecrest entry and creates file", () => {
  installMcpServer(settingsPath, "/usr/local/bin/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.mcpServers.wavecrest.command).toBe("/usr/local/bin/wavecrest");
  expect(s.mcpServers.wavecrest.args).toEqual(["mcp"]);
  expect(s.mcpServers.wavecrest._wavecrest_managed).toBe(true);
});

test("installMcpServer is idempotent and preserves other mcpServers entries", () => {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        other: { command: "other", args: ["x"] },
      },
    }),
  );
  installMcpServer(settingsPath, "/usr/local/bin/wavecrest");
  installMcpServer(settingsPath, "/opt/wavecrest");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(Object.keys(s.mcpServers).sort()).toEqual(["other", "wavecrest"]);
  expect(s.mcpServers.wavecrest.command).toBe("/opt/wavecrest");
  expect(s.mcpServers.other.command).toBe("other");
});

test("removeMcpServer removes only the managed wavecrest entry", () => {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        wavecrest: { command: "/usr/local/bin/wavecrest", args: ["mcp"], _wavecrest_managed: true },
        other: { command: "other", args: ["x"] },
      },
    }),
  );
  removeMcpServer(settingsPath);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.mcpServers.wavecrest).toBeUndefined();
  expect(s.mcpServers.other).toBeDefined();
});

test("removeMcpServer leaves a user-customised wavecrest entry alone", () => {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        wavecrest: { command: "/custom/wavecrest", args: ["mcp"] }, // no managed tag
      },
    }),
  );
  removeMcpServer(settingsPath);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.mcpServers.wavecrest.command).toBe("/custom/wavecrest");
});

test("removeMcpServer is safe on a missing file", () => {
  removeMcpServer(settingsPath);
  expect(existsSync(settingsPath)).toBe(false);
});

test("removeMcpServer deletes the mcpServers key when it becomes empty", () => {
  installMcpServer(settingsPath, "/usr/local/bin/wavecrest");
  removeMcpServer(settingsPath);
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(s.mcpServers).toBeUndefined();
});
