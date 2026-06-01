import { expect, test } from "bun:test";
import { makeDispatcher, WRITE_TOOLS } from "../../src/mcp/tools.ts";
import type { DaemonClient } from "../../src/mcp/daemon-client.ts";

interface Call { name: string; args: unknown[] }

function mockClient(): { client: DaemonClient; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
    return Promise.resolve({ ok: true, _from: name, args });
  };
  const client: DaemonClient = {
    listSessions: () =>
      Promise.resolve([
        { id: "a", status: "working", agent_kind: "claude" },
        { id: "b", status: "idle", agent_kind: "claude" },
        { id: "c", status: "working", agent_kind: "codex" },
      ]),
    getSession: rec("getSession") as any,
    getUsage: rec("getUsage") as any,
    recentEvents: rec("recentEvents") as any,
    openSession: rec("openSession") as any,
    renameSession: rec("renameSession") as any,
    pinSession: rec("pinSession") as any,
    deleteSession: rec("deleteSession") as any,
    focusSession: rec("focusSession") as any,
  };
  return { client, calls };
}

test("list_sessions returns all when no filter", async () => {
  const { client } = mockClient();
  const d = makeDispatcher(client);
  const r = (await d.list_sessions({})) as unknown[];
  expect(r.length).toBe(3);
});

test("list_sessions filters by status", async () => {
  const { client } = mockClient();
  const d = makeDispatcher(client);
  const r = (await d.list_sessions({ filter: { status: "working" } })) as unknown[];
  expect(r.length).toBe(2);
});

test("list_sessions filters by agent_kind", async () => {
  const { client } = mockClient();
  const d = makeDispatcher(client);
  const r = (await d.list_sessions({ filter: { agent_kind: "codex" } })) as unknown[];
  expect(r.length).toBe(1);
});

test("get_session forwards id", async () => {
  const { client, calls } = mockClient();
  const d = makeDispatcher(client);
  await d.get_session({ id: "abc" });
  expect(calls).toEqual([{ name: "getSession", args: ["abc"] }]);
});

test("get_usage calls usage endpoint", async () => {
  const { client, calls } = mockClient();
  const d = makeDispatcher(client);
  await d.get_usage({});
  expect(calls[0]?.name).toBe("getUsage");
});

test("recent_events clamps limit and forwards verbose", async () => {
  const { client, calls } = mockClient();
  const d = makeDispatcher(client);
  await d.recent_events({ limit: 10000, verbose: true });
  expect(calls[0]?.args).toEqual([500, true]);
  await d.recent_events({});
  expect(calls[1]?.args).toEqual([60, false]);
});

test("open_session defaults new_tab=false (MCP path)", async () => {
  const { client, calls } = mockClient();
  const d = makeDispatcher(client);
  await d.open_session({ branch: "feat/x" });
  const args = calls[0]?.args[0] as Record<string, unknown>;
  expect(args.new_tab).toBe(false);
  expect(args.branch).toBe("feat/x");
});

test("rename_session, pin_session, delete_session, focus_session map to client", async () => {
  const { client, calls } = mockClient();
  const d = makeDispatcher(client);
  await d.rename_session({ id: "x", display_name: "n" });
  await d.pin_session({ id: "x", pinned: true });
  await d.delete_session({ id: "x" });
  await d.focus_session({ id: "x" });
  expect(calls.map(c => c.name)).toEqual(["renameSession", "pinSession", "deleteSession", "focusSession"]);
});

test("focus_session returns soft-fail object instead of throwing", async () => {
  const calls: Call[] = [];
  const client: DaemonClient = {
    listSessions: () => Promise.resolve([]),
    getSession: () => Promise.resolve({}),
    getUsage: () => Promise.resolve({}),
    recentEvents: () => Promise.resolve([]),
    openSession: () => Promise.resolve({}),
    renameSession: () => Promise.resolve({}),
    pinSession: () => Promise.resolve({}),
    deleteSession: () => Promise.resolve({}),
    focusSession: () => { calls.push({ name: "focusSession", args: [] }); return Promise.reject(new Error("no tab id")); },
  };
  const d = makeDispatcher(client);
  const r = (await d.focus_session({ id: "x" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("no tab id");
  expect(r.note).toBeDefined();
});

test("write-tool first-call hook fires exactly once", async () => {
  const { client } = mockClient();
  const fired: string[] = [];
  const d = makeDispatcher(client, { onFirstWrite: (n) => fired.push(n) });
  await d.list_sessions({});
  await d.rename_session({ id: "a", display_name: "b" });
  await d.pin_session({ id: "a", pinned: true });
  expect(fired).toEqual(["rename_session"]);
});

test("WRITE_TOOLS set lists the right tool names", () => {
  expect([...WRITE_TOOLS].sort()).toEqual([
    "delete_session",
    "focus_session",
    "index_repo",
    "open_session",
    "pin_session",
    "rename_session",
  ]);
});
