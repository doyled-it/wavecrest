import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { paths } from "../lib/paths.ts";
import { openDb } from "../db/index.ts";
import { log } from "../lib/logger.ts";
import { startSockServer } from "./sock.ts";
import { startHttpServer } from "./http.ts";
import { listActiveSessions, getRollup, latestUsageSnapshots, insertSession, updateSessionStatus, findSessionByAgentSessionId, insertEvent, listResumableSessions } from "../db/queries.ts";
import { attachSse, broadcast } from "./sse.ts";
import { startTranscriptWatcher } from "./transcript-watcher.ts";
import { ulid } from "../lib/ulid.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { AgentKind } from "../types.ts";
import type { Database } from "bun:sqlite";

export interface Daemon {
  shutdown(): Promise<void>;
}

export function isDaemonRunning(): { running: boolean; pid?: number } {
  if (!existsSync(paths.pid)) return { running: false };
  const pid = parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
  if (!Number.isFinite(pid)) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return { running: false };
    if (code === "EPERM") return { running: true, pid }; // owned by another user — still "running" from our POV
    return { running: false };
  }
}

export async function startDaemon(): Promise<Daemon> {
  mkdirSync(paths.root, { recursive: true });
  ensureNotRunning();
  writeFileSync(paths.pid, String(process.pid));

  const db = openDb(paths.db);
  log.info("daemon: db ready", { path: paths.db });

  const sock = startSockServer(paths.sock, makeRpcHandler(db));
  const http = startHttpServer(makeHttpHandler(db));
  writeFileSync(paths.port, String(http.port));

  const claudeRoot = join(homedir(), ".claude", "projects");
  const watcher = startTranscriptWatcher(db, [claudeRoot]);

  log.info("daemon: ready", { port: http.port, sock: paths.sock });

  const shutdown = async () => {
    await watcher.stop();
    sock.close();
    http.stop();
    db.close();
    for (const p of [paths.pid, paths.port]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch {}
      }
    }
    log.info("daemon: shut down");
  };

  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0)).catch((e) => {
      log.error("shutdown error on SIGTERM", { error: String(e) });
      process.exit(1);
    });
  });
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0)).catch((e) => {
      log.error("shutdown error on SIGINT", { error: String(e) });
      process.exit(1);
    });
  });

  return { shutdown };
}

function makeRpcHandler(db: Database) {
  return async (method: string, params: unknown): Promise<unknown> => {
    if (method === "ping") return { ok: true };

    if (method === "hook") {
      const { kind, event, payload } = params as { kind: AgentKind; event: string; payload: unknown };
      const adapter = getAdapter(kind);
      const upd = adapter.hookEventToSessionUpdate(event, payload);
      if (!upd) return { ok: true };
      if (!upd.agent_session_id && event === "SessionStart") {
        log.warn("hook: SessionStart missing session_id, skipping adoption");
      }

      let session = upd.agent_session_id ? findSessionByAgentSessionId(db, upd.agent_session_id) : null;
      if (!session && upd.agent_session_id) {
        // adopt wild session
        const id = ulid();
        insertSession(db, {
          id, agent_kind: kind, agent_session_id: upd.agent_session_id,
          workspace_id: null, wave_tab_id: null, wave_block_id: null,
          cwd: upd.cwd ?? process.env.PWD ?? "/", repo_root: null, branch: null, worktree_path: null,
          launch_argv: ["claude"], display_name: null,
          status: upd.status ?? "working", auto_resume: false, pinned: false,
          created_at: Date.now(), last_active_at: upd.last_active_at ?? Date.now(),
          transcript_path: upd.transcript_path ?? null,
        });
        session = findSessionByAgentSessionId(db, upd.agent_session_id);
      }
      if (session) {
        if (upd.status) updateSessionStatus(db, session.id, upd.status, upd.last_active_at ?? Date.now());
        insertEvent(db, { session_id: session.id, ts: Date.now(), kind: event, payload_json: JSON.stringify(payload) });
        broadcast("session", { id: session.id });
      }
      return { ok: true };
    }

    if (method === "listSessions") return listActiveSessions(db);

    if (method === "registerPlannedSession") {
      const p = params as Record<string, unknown>;
      const { kind, cwd, branch, worktree_path, launch_argv, display_name } = p;
      if (typeof kind !== "string") throw new Error("registerPlannedSession: kind must be a string");
      if (typeof cwd !== "string") throw new Error("registerPlannedSession: cwd must be a string");
      if (!Array.isArray(launch_argv)) throw new Error("registerPlannedSession: launch_argv must be an array");
      const id = ulid();
      insertSession(db, {
        id, agent_kind: kind as AgentKind, agent_session_id: null,
        workspace_id: null, wave_tab_id: null, wave_block_id: null,
        cwd, repo_root: null, branch: typeof branch === "string" ? branch : null,
        worktree_path: typeof worktree_path === "string" ? worktree_path : null,
        launch_argv: launch_argv as string[],
        display_name: typeof display_name === "string" ? display_name : null,
        status: "idle", auto_resume: true, pinned: false,
        created_at: Date.now(), last_active_at: Date.now(),
        transcript_path: null,
      });
      return { id };
    }

    if (method === "listResumable") return listResumableSessions(db);

    throw new Error(`unknown method: ${method}`);
  };
}

function makeHttpHandler(db: Database) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/api/health" && req.method === "GET") return Response.json({ ok: true });

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const sessions = listActiveSessions(db).map(s => ({
        ...s,
        rollup: getRollup(db, s.id),
      }));
      return Response.json(sessions);
    }

    if (url.pathname === "/api/usage" && req.method === "GET") {
      return Response.json({ claude: latestUsageSnapshots(db, "claude") });
    }

    if (url.pathname === "/api/events" && req.method === "GET") return attachSse();

    return new Response("not found", { status: 404 });
  };
}

function ensureNotRunning(): void {
  if (!existsSync(paths.pid)) return;
  const status = isDaemonRunning();
  if (status.running) {
    if (status.pid != null) {
      // Check for EPERM (owned by another user) to emit a more helpful log
      const pid = parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
      try { process.kill(pid, 0); }
      catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "EPERM") log.warn("ensureNotRunning: pid file exists but process is owned by another user", { pid });
        throw e;
      }
      throw new Error(`daemon already running (pid ${status.pid})`);
    }
    throw new Error("daemon already running");
  }
  // Stale PID — clean it up
  try { unlinkSync(paths.pid); } catch {}
}
