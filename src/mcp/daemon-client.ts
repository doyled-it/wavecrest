// Thin client over the wavecrest daemon. Prefer the HTTP API (already
// JSON-shaped for the dashboard) and fall back to the Unix-socket JSON-RPC
// only for things the HTTP surface doesn't expose.
import { existsSync, readFileSync } from "fs";
import { paths } from "../lib/paths.ts";
import { callDaemon } from "../commands/hook.ts";

function daemonPort(): number {
  if (existsSync(paths.port)) {
    const raw = readFileSync(paths.port, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 17321;
}

function baseUrl(): string {
  return `http://127.0.0.1:${daemonPort()}`;
}

async function httpJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in (body as Record<string, unknown>))
      ? String((body as Record<string, unknown>).error)
      : `daemon HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export interface DaemonClient {
  listSessions(): Promise<unknown[]>;
  getSession(id: string): Promise<unknown>;
  getUsage(): Promise<unknown>;
  recentEvents(limit: number, verbose: boolean): Promise<unknown[]>;
  openSession(input: {
    branch: string;
    cwd?: string;
    display_name?: string;
    worktree?: boolean;
    agent?: string;
    new_tab?: boolean;
  }): Promise<unknown>;
  renameSession(id: string, display_name: string): Promise<unknown>;
  pinSession(id: string, pinned: boolean): Promise<unknown>;
  deleteSession(id: string): Promise<unknown>;
  focusSession(id: string): Promise<unknown>;
}

export function createHttpDaemonClient(): DaemonClient {
  return {
    listSessions: () => httpJson<unknown[]>("/api/sessions"),
    getSession: (id) => httpJson(`/api/sessions/${encodeURIComponent(id)}`),
    getUsage: () => httpJson("/api/usage"),
    recentEvents: (limit, verbose) =>
      httpJson<unknown[]>(
        `/api/events/recent?limit=${encodeURIComponent(String(limit))}${verbose ? "&verbose=1" : ""}`,
      ),
    openSession: (input) =>
      httpJson("/api/open", { method: "POST", body: JSON.stringify(input) }),
    // renameSession goes via PATCH (display_name). Could also call daemon RPC
    // renameSession, but the HTTP route already exists and broadcasts SSE.
    renameSession: (id, display_name) =>
      httpJson(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ display_name }),
      }),
    pinSession: (id, pinned) =>
      httpJson(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      }),
    deleteSession: (id) =>
      httpJson(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    focusSession: (id) =>
      httpJson(`/api/sessions/${encodeURIComponent(id)}/focus`, {
        method: "POST",
      }),
  };
}

// Exposed so MCP tool wiring can ping the daemon (e.g. for a startup check).
export async function pingDaemon(): Promise<void> {
  await callDaemon("ping", {});
}
