// wavecrest MCP server. Exposes wavecrest state + actions to any MCP host
// over stdio (Claude Code, Codex, etc).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { createHttpDaemonClient } from "./daemon-client.ts";
import { makeDispatcher } from "./tools.ts";

// MCP host log channel: stderr is safe (stdout is the protocol stream).
function log(msg: string): void {
  process.stderr.write(`[wavecrest mcp] ${msg}\n`);
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

export function buildServer(opts?: { dispatcher?: ReturnType<typeof makeDispatcher> }) {
  const dispatcher =
    opts?.dispatcher ??
    makeDispatcher(createHttpDaemonClient(), {
      onFirstWrite: (name) => {
        log(`first write-tool invoked (${name}). wavecrest MCP write tools are enabled — disable by removing the wavecrest entry from your MCP host config.`);
      },
    });

  const server = new McpServer(
    { name: "wavecrest", version: pkg.version },
    {
      instructions:
        "wavecrest MCP server. Exposes the wavecrest agent-session dashboard over MCP, plus a codegraph proxy for codebase Q&A. Read tools (list_sessions, get_session, get_usage, recent_events, query_repo) describe state or query a codebase. Write tools (open_session, rename_session, pin_session, delete_session, focus_session, index_repo) mutate the dashboard or filesystem.",
    },
  );

  // ─── Read tools ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_sessions",
    {
      description:
        "List active wavecrest agent sessions (with rollup token/cost data). Optional filter by status (e.g. 'working', 'idle', 'awaiting_input', 'finished') or agent_kind ('claude', 'codex', 'gemini', 'custom').",
      inputSchema: {
        filter: z
          .object({
            status: z.string().optional(),
            agent_kind: z.string().optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.list_sessions({ filter: args.filter }));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "get_session",
    {
      description:
        "Fetch a single wavecrest session by id, including rollup data.",
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.get_session({ id: args.id }));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "get_usage",
    {
      description:
        "Latest agent-usage snapshots (Claude session/week limits as reported by `claude /usage`).",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await dispatcher.get_usage({}));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "recent_events",
    {
      description:
        "Recent session state-transition events (highest-signal by default). Use verbose=true to include every hook event.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        verbose: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.recent_events({ limit: args.limit, verbose: args.verbose }));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  // ─── Write tools ──────────────────────────────────────────────────────────
  server.registerTool(
    "open_session",
    {
      description:
        "Open a new wavecrest agent session on the given branch. Creates a Wave block in the currently focused tab. NOTE: new_tab defaults to false; opening in a new Wave tab via this MCP path is not yet supported (the existing snapshot/finalize flow requires a user keystroke to create the tab).",
      inputSchema: {
        branch: z.string().min(1),
        cwd: z.string().optional(),
        display_name: z.string().optional(),
        worktree: z.boolean().optional(),
        agent: z.string().optional(),
        new_tab: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.open_session(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "rename_session",
    {
      description: "Update a session's display name.",
      inputSchema: { id: z.string().min(1), display_name: z.string() },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.rename_session(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "pin_session",
    {
      description: "Pin or unpin a session in the wavecrest dashboard.",
      inputSchema: { id: z.string().min(1), pinned: z.boolean() },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.pin_session(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "delete_session",
    {
      description:
        "Remove a session from the wavecrest dashboard. Does not stop the underlying agent process.",
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.delete_session(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "query_repo",
    {
      description:
        "Ask a question about a codebase. Requires the repo to be indexed first via `index_repo` or by running `codegraph init -i && codegraph index` manually. Returns a markdown context bundle suitable for agent consumption.",
      inputSchema: { repo_path: z.string().min(1), question: z.string().min(1) },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.query_repo(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "index_repo",
    {
      description:
        "Index a codebase with codegraph so it can be queried via `query_repo`. Idempotent unless `force` is true. Codegraph must be installed (npm install -g @colbymchenry/codegraph). Creates a `.codegraph/` directory in the repo.",
      inputSchema: { repo_path: z.string().min(1), force: z.boolean().optional() },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.index_repo(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerTool(
    "focus_session",
    {
      description:
        "Focus the Wave tab containing a session. May fail if the session was adopted via hook (no known Wave tab), or if upstream wsh tab focus is unavailable.",
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      try {
        return jsonResult(await dispatcher.focus_session(args));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  return server;
}

export async function runMcpStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready on stdio");
}
