// Pure tool dispatcher. Each tool maps to one DaemonClient call.
// Kept separate from server.ts so it can be unit-tested with a mock client.
import type { DaemonClient } from "./daemon-client.ts";

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
}

export const WRITE_TOOLS = new Set([
  "open_session",
  "rename_session",
  "pin_session",
  "delete_session",
  "focus_session",
]);

export function makeDispatcher(
  client: DaemonClient,
  hooks?: { onFirstWrite?: (toolName: string) => void },
): ToolDispatcher {
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
  };
}
