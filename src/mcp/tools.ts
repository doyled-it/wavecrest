// Pure tool dispatcher. Each tool maps to one DaemonClient call.
// Kept separate from server.ts so it can be unit-tested with a mock client.
import type { DaemonClient } from "./daemon-client.ts";
import {
  DEFAULT_INDEX_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  findCodegraphBin as defaultFindCodegraphBin,
  repoIsIndexed as defaultRepoIsIndexed,
  repoPathLooksValid as defaultRepoPathLooksValid,
  runCodegraph as defaultRunCodegraph,
  type CodegraphRunResult,
} from "./codegraph.ts";

export interface ToolDispatcher {
  list_sessions(args: { filter?: { status?: string; agent_kind?: string } }): Promise<unknown>;
  get_session(args: { id: string }): Promise<unknown>;
  get_usage(args: Record<string, never>): Promise<unknown>;
  recent_events(args: { limit?: number; verbose?: boolean }): Promise<unknown>;
  open_session(args: {
    branch: string;
    cwd?: string;
    display_name?: string;
    worktree?: boolean;
    agent?: string;
    new_tab?: boolean;
  }): Promise<unknown>;
  rename_session(args: { id: string; display_name: string }): Promise<unknown>;
  pin_session(args: { id: string; pinned: boolean }): Promise<unknown>;
  delete_session(args: { id: string }): Promise<unknown>;
  focus_session(args: { id: string }): Promise<unknown>;
  query_repo(args: { repo_path: string; question: string }): Promise<unknown>;
  index_repo(args: { repo_path: string; force?: boolean }): Promise<unknown>;
}

export const WRITE_TOOLS = new Set([
  "open_session",
  "rename_session",
  "pin_session",
  "delete_session",
  "focus_session",
  "index_repo",
]);

export interface CodegraphDeps {
  findBin: () => string | null;
  repoIsIndexed: (repoPath: string) => boolean;
  repoPathLooksValid: (repoPath: string) => boolean;
  run: (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<CodegraphRunResult>;
}

const NOT_INSTALLED = {
  ok: false as const,
  error: "codegraph CLI not found",
  hint: "Install with: npm install -g @colbymchenry/codegraph",
};

export function makeDispatcher(
  client: DaemonClient,
  hooks?: { onFirstWrite?: (toolName: string) => void; codegraph?: Partial<CodegraphDeps> },
): ToolDispatcher {
  const cg: CodegraphDeps = {
    findBin: hooks?.codegraph?.findBin ?? defaultFindCodegraphBin,
    repoIsIndexed: hooks?.codegraph?.repoIsIndexed ?? defaultRepoIsIndexed,
    repoPathLooksValid: hooks?.codegraph?.repoPathLooksValid ?? defaultRepoPathLooksValid,
    run: hooks?.codegraph?.run ?? defaultRunCodegraph,
  };
  let warnedAboutWrite = false;
  const notifyWrite = (name: string) => {
    if (!warnedAboutWrite && hooks?.onFirstWrite) {
      warnedAboutWrite = true;
      hooks.onFirstWrite(name);
    }
  };

  const matchFilter = (
    s: Record<string, unknown>,
    filter?: { status?: string; agent_kind?: string },
  ): boolean => {
    if (!filter) return true;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.agent_kind && s.agent_kind !== filter.agent_kind) return false;
    return true;
  };

  return {
    async list_sessions({ filter }) {
      const all = (await client.listSessions()) as Record<string, unknown>[];
      return all.filter((s) => matchFilter(s, filter));
    },
    async get_session({ id }) {
      return client.getSession(id);
    },
    async get_usage() {
      return client.getUsage();
    },
    async recent_events({ limit, verbose }) {
      const n = Math.max(1, Math.min(500, limit ?? 60));
      return client.recentEvents(n, !!verbose);
    },
    async open_session(args) {
      notifyWrite("open_session");
      // Default new_tab=false — see tool description for rationale.
      const new_tab = args.new_tab ?? false;
      return client.openSession({ ...args, new_tab });
    },
    async rename_session({ id, display_name }) {
      notifyWrite("rename_session");
      return client.renameSession(id, display_name);
    },
    async pin_session({ id, pinned }) {
      notifyWrite("pin_session");
      return client.pinSession(id, pinned);
    },
    async delete_session({ id }) {
      notifyWrite("delete_session");
      return client.deleteSession(id);
    },
    async focus_session({ id }) {
      notifyWrite("focus_session");
      try {
        return await client.focusSession(id);
      } catch (e) {
        // Focus depends on wsh tab focus support; surface a softer message.
        return {
          ok: false,
          error: (e as Error).message,
          note: "focus may require upstream wsh tab-focus support; ignore if not available",
        };
      }
    },

    async query_repo({ repo_path, question }) {
      if (!cg.findBin()) return { ...NOT_INSTALLED };
      if (!cg.repoPathLooksValid(repo_path)) {
        return { ok: false, error: `repo_path not found or not a directory: ${repo_path}` };
      }
      if (!cg.repoIsIndexed(repo_path)) {
        return {
          ok: false,
          error: "repository is not indexed",
          hint: "Run `index_repo` first, or invoke `codegraph init -i && codegraph index` in that path.",
        };
      }
      const r = await cg.run(["context", question], {
        cwd: repo_path,
        timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
      });
      if (!r.ok) {
        return {
          ok: false,
          error: r.timedOut ? "codegraph query timed out" : (r.stderr || `codegraph exited with code ${r.code}`),
        };
      }
      return { ok: true, markdown: r.stdout };
    },

    async index_repo({ repo_path, force }) {
      notifyWrite("index_repo");
      if (!cg.findBin()) return { ...NOT_INSTALLED };
      if (!cg.repoPathLooksValid(repo_path)) {
        return { ok: false, error: `repo_path not found or not a directory: ${repo_path}` };
      }

      if (cg.repoIsIndexed(repo_path) && !force) {
        const status = await cg.run(["status", repo_path], { timeoutMs: 30_000 });
        return {
          ok: true,
          already_indexed: true,
          indexed: true,
          status: status.ok ? status.stdout.trim() : (status.stderr.trim() || "status unavailable"),
        };
      }

      if (!cg.repoIsIndexed(repo_path)) {
        const init = await cg.run(["init", "-i", repo_path], { timeoutMs: 60_000 });
        if (!init.ok) {
          return {
            ok: false,
            error: init.timedOut ? "codegraph init timed out" : (init.stderr || `codegraph init exited with code ${init.code}`),
          };
        }
      }

      const idx = await cg.run(["index", repo_path], { timeoutMs: DEFAULT_INDEX_TIMEOUT_MS });
      if (!idx.ok) {
        return {
          ok: false,
          error: idx.timedOut ? "codegraph index timed out" : (idx.stderr || `codegraph index exited with code ${idx.code}`),
        };
      }
      const status = await cg.run(["status", repo_path], { timeoutMs: 30_000 });
      return {
        ok: true,
        indexed: true,
        already_indexed: false,
        status: status.ok ? status.stdout.trim() : idx.stdout.trim(),
      };
    },
  };
}
