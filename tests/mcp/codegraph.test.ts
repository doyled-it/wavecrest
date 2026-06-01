import { expect, test } from "bun:test";
import { makeDispatcher } from "../../src/mcp/tools.ts";
import type { DaemonClient } from "../../src/mcp/daemon-client.ts";
import type { CodegraphRunResult } from "../../src/mcp/codegraph.ts";

// Minimal daemon stub — codegraph tools never touch it.
const stubClient: DaemonClient = {
  listSessions: () => Promise.resolve([]),
  getSession: () => Promise.resolve({}),
  getUsage: () => Promise.resolve({}),
  recentEvents: () => Promise.resolve([]),
  openSession: () => Promise.resolve({}),
  renameSession: () => Promise.resolve({}),
  pinSession: () => Promise.resolve({}),
  deleteSession: () => Promise.resolve({}),
  focusSession: () => Promise.resolve({}),
};

interface RunCall {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

function mockCodegraph(opts: {
  bin?: string | null;
  indexedPaths?: Set<string>;
  validPaths?: Set<string>;
  results?: Record<string, CodegraphRunResult>;
  defaultResult?: CodegraphRunResult;
}) {
  const calls: RunCall[] = [];
  const cg = {
    findBin: () => (opts.bin === undefined ? "/usr/bin/codegraph" : opts.bin),
    repoIsIndexed: (p: string) => (opts.indexedPaths ? opts.indexedPaths.has(p) : true),
    repoPathLooksValid: (p: string) => (opts.validPaths ? opts.validPaths.has(p) : true),
    run: async (args: string[], runOpts?: { cwd?: string; timeoutMs?: number }) => {
      calls.push({ args, cwd: runOpts?.cwd, timeoutMs: runOpts?.timeoutMs });
      const key = args[0] ?? "";
      const fromMap = opts.results?.[key];
      if (fromMap) return fromMap;
      return (
        opts.defaultResult ?? {
          ok: true,
          stdout: `# codegraph ${args.join(" ")}\nresult body`,
          stderr: "",
          code: 0,
        }
      );
    },
  };
  return { cg, calls };
}

test("query_repo: returns hint when codegraph CLI not installed", async () => {
  const { cg } = mockCodegraph({ bin: null });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/repo", question: "what?" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("codegraph CLI not found");
  expect(String(r.hint)).toContain("npm install -g @colbymchenry/codegraph");
});

test("query_repo: returns hint when repo is not indexed", async () => {
  const { cg, calls } = mockCodegraph({ indexedPaths: new Set() });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/repo", question: "what?" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("not indexed");
  expect(String(r.hint)).toContain("index_repo");
  expect(calls.length).toBe(0); // never invoked codegraph
});

test("query_repo: rejects nonexistent repo_path", async () => {
  const { cg } = mockCodegraph({ validPaths: new Set() });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/nope", question: "?" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("not found or not a directory");
});

test("query_repo: passes question through argv (not shell), returns markdown", async () => {
  const tricky = `what calls foo(); rm -rf /`;
  const { cg, calls } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/repo", question: tricky })) as Record<string, unknown>;
  expect(r.ok).toBe(true);
  expect(String(r.markdown)).toContain("codegraph context");
  expect(calls[0]?.args).toEqual(["context", tricky]);
  expect(calls[0]?.cwd).toBe("/repo");
});

test("query_repo: surfaces codegraph stderr on failure", async () => {
  const { cg } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
    results: { context: { ok: false, stdout: "", stderr: "boom", code: 2 } },
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/repo", question: "?" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("boom");
});

test("query_repo: surfaces timeout cleanly", async () => {
  const { cg } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
    results: { context: { ok: false, stdout: "", stderr: "", code: null, timedOut: true } },
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.query_repo({ repo_path: "/repo", question: "?" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("timed out");
});

test("index_repo: short-circuits when already indexed (no force)", async () => {
  const { cg, calls } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
    results: { status: { ok: true, stdout: "indexed: 42 files\n", stderr: "", code: 0 } },
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.index_repo({ repo_path: "/repo" })) as Record<string, unknown>;
  expect(r.ok).toBe(true);
  expect(r.already_indexed).toBe(true);
  expect(String(r.status)).toContain("indexed: 42 files");
  // Only `status` should have been called — not `init` or `index`.
  expect(calls.map((c) => c.args[0])).toEqual(["status"]);
});

test("index_repo: force=true re-indexes even when .codegraph/ exists", async () => {
  const { cg, calls } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.index_repo({ repo_path: "/repo", force: true })) as Record<string, unknown>;
  expect(r.ok).toBe(true);
  expect(r.already_indexed).toBe(false);
  // force skips init (already indexed) but still runs index + status.
  const verbs = calls.map((c) => c.args[0]);
  expect(verbs).toContain("index");
  expect(verbs).toContain("status");
  expect(verbs).not.toContain("init");
});

test("index_repo: full init+index flow when .codegraph/ missing", async () => {
  const { cg, calls } = mockCodegraph({
    indexedPaths: new Set(),
    validPaths: new Set(["/repo"]),
  });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.index_repo({ repo_path: "/repo" })) as Record<string, unknown>;
  expect(r.ok).toBe(true);
  const verbs = calls.map((c) => c.args[0]);
  expect(verbs).toEqual(["init", "index", "status"]);
  expect(calls[0]?.args).toEqual(["init", "-i", "/repo"]);
});

test("index_repo: surfaces hint when codegraph not installed", async () => {
  const { cg } = mockCodegraph({ bin: null });
  const d = makeDispatcher(stubClient, { codegraph: cg });
  const r = (await d.index_repo({ repo_path: "/repo" })) as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(String(r.hint)).toContain("npm install");
});

test("index_repo: write-tool hook fires the first time it runs", async () => {
  const { cg } = mockCodegraph({
    indexedPaths: new Set(["/repo"]),
    validPaths: new Set(["/repo"]),
  });
  const fired: string[] = [];
  const d = makeDispatcher(stubClient, {
    codegraph: cg,
    onFirstWrite: (n) => fired.push(n),
  });
  await d.query_repo({ repo_path: "/repo", question: "?" });
  expect(fired).toEqual([]); // query_repo is read-only
  await d.index_repo({ repo_path: "/repo" });
  expect(fired).toEqual(["index_repo"]);
});
