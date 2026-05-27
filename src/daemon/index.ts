import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { paths } from "../lib/paths.ts";
import { openDb } from "../db/index.ts";
import { log } from "../lib/logger.ts";
import { startSockServer } from "./sock.ts";
import { startHttpServer, serveUi } from "./http.ts";
import { listActiveSessions, getRollup, latestUsageSnapshots, insertSession, updateSessionStatus, findSessionByAgentSessionId, insertEvent, listResumableSessions } from "../db/queries.ts";
import { attachSse, broadcast } from "./sse.ts";
import { startTranscriptWatcher } from "./transcript-watcher.ts";
import { startUsagePoller } from "./usage-poller.ts";
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
  const poller = startUsagePoller(db);

  log.info("daemon: ready", { port: http.port, sock: paths.sock });

  const shutdown = async () => {
    poller.stop();
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
      if (launch_argv.some(el => typeof el !== "string"))
        throw new Error("registerPlannedSession: launch_argv elements must all be strings");
      const adapter = getAdapter(kind as AgentKind); // throws if unknown kind
      const id = ulid();
      void adapter; // adapter validated above; reserved for future per-kind defaults
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

    if (method === "setAuth") {
      const p = params as Record<string, unknown>;
      const { wave } = await import("./wave-bridge.ts");
      // New form: { env: { WAVETERM_*: ... } }. Legacy form: { jwt: "..." }.
      if (p.env && typeof p.env === "object") {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
        if (!env.WAVETERM_JWT) throw new Error("setAuth: env.WAVETERM_JWT required");
        wave.setWaveEnv(env);
        return { ok: true, captured: wave.capturedKeys() };
      }
      if (typeof p.jwt === "string" && p.jwt) {
        wave.setWaveEnv({ WAVETERM_JWT: p.jwt });
        return { ok: true, captured: wave.capturedKeys() };
      }
      throw new Error("setAuth: either env or jwt required");
    }

    if (method === "renameSession") {
      const p = params as Record<string, unknown>;
      if (typeof p.id !== "string" || !p.id) throw new Error("renameSession: id required");
      if (typeof p.display_name !== "string") throw new Error("renameSession: display_name required");
      const trimmed = p.display_name.trim() || null;
      db.query("UPDATE sessions SET display_name = ? WHERE id = ?").run(trimmed, p.id);
      broadcast("session", { id: p.id });
      return { ok: true };
    }

    throw new Error(`unknown method: ${method}`);
  };
}

const _uiDir = resolveUiDir();
const _ui = serveUi(_uiDir);

function resolveUiDir(): string {
  // Probe several locations so the daemon finds dist/ui in both dev and
  // compiled-binary modes. process.execPath is the binary in compiled mode,
  // or `bun` in dev mode.
  const candidates: string[] = [];
  if (process.env.WAVECREST_UI_DIR) candidates.push(process.env.WAVECREST_UI_DIR);
  const execDir = dirname(process.execPath);
  candidates.push(join(execDir, "ui"));                       // installed: binary + ui/ sibling
  candidates.push(join(execDir, "..", "ui"));                 // installed: binary in bin/, ui in ../
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "..", "dist", "ui"));    // dev: bun run src/cli.ts
  } catch {}
  for (const c of candidates) if (existsSync(c)) return c;
  log.warn("ui directory not found; dashboard will 404", { tried: candidates });
  return candidates[0] ?? "ui";
}

function makeHttpHandler(db: Database) {
  return async (req: Request): Promise<Response> => {
    const uiResp = _ui(req);
    if (uiResp) return uiResp;

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

    if (url.pathname === "/api/open" && req.method === "POST") {
      try {
        const body = await req.json() as {
          branch?: unknown;
          agent?: unknown;
          cwd?: unknown;
          worktree?: unknown;
          display_name?: unknown;
          new_tab?: unknown;
        };
        const branch = typeof body.branch === "string" ? body.branch.trim() : "";
        if (!branch) return Response.json({ error: "branch is required" }, { status: 400 });

        // new_tab defaults to true when omitted (undefined), false only when explicitly false.
        const newTab = body.new_tab !== false;

        const { prepareSession } = await import("../commands/open.ts");
        const { wave } = await import("./wave-bridge.ts");

        const prep = prepareSession(branch, {
          agent: typeof body.agent === "string" ? body.agent : undefined,
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          worktree: !!body.worktree,
        });

        const displayName = typeof body.display_name === "string" && body.display_name.trim()
          ? body.display_name.trim()
          : prep.branch;

        let waveTabId: string | null = null;

        if (newTab) {
          // Spawn in a brand-new Wave tab (Cmd+T via osascript + wsh targeting that tab).
          const tabResult = await wave.createSessionTab({
            displayName,
            cwd: prep.workCwd,
            argv: prep.launchArgv,
            envExtra: {},
            includeDashboard: true,
          });
          if (!tabResult.ok) {
            return Response.json({ error: tabResult.error ?? "tab creation failed" }, { status: 502 });
          }
          waveTabId = tabResult.tabId ?? null;
        } else {
          // Legacy: spawn the block in the current (captured) tab.
          const blockResult = await wave.createBlock({
            cwd: prep.workCwd,
            argv: prep.launchArgv,
            envExtra: {},
          });
          if (!blockResult.ok) {
            return Response.json({ error: blockResult.error ?? "block creation failed" }, { status: 502 });
          }
        }

        const id = ulid();
        insertSession(db, {
          id,
          agent_kind: prep.agentKind,
          agent_session_id: null,
          workspace_id: null,
          wave_tab_id: waveTabId,
          wave_block_id: null,
          cwd: prep.workCwd,
          repo_root: null,
          branch: prep.branch,
          worktree_path: prep.worktreePath,
          launch_argv: prep.launchArgv,
          display_name: displayName,
          status: "idle",
          auto_resume: true,
          pinned: false,
          created_at: Date.now(),
          last_active_at: Date.now(),
          transcript_path: null,
        });
        broadcast("session", { id });

        return Response.json({ id, branch: prep.branch, cwd: prep.workCwd, new_tab: newTab, wave_tab_id: waveTabId });
      } catch (e: unknown) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }

    // PATCH /api/sessions/:id  body { display_name }
    // DELETE /api/sessions/:id
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "PATCH") {
      try {
        const body = await req.json() as { display_name?: unknown };
        if (typeof body.display_name !== "string") {
          return Response.json({ error: "display_name required" }, { status: 400 });
        }
        const id = sessionMatch[1]!;
        const trimmed = body.display_name.trim() || null;
        db.query("UPDATE sessions SET display_name = ? WHERE id = ?").run(trimmed, id);
        broadcast("session", { id });
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }
    if (sessionMatch && req.method === "DELETE") {
      try {
        const id = sessionMatch[1]!;
        // FK ON DELETE CASCADE handles events + token rollup.
        const result = db.query("DELETE FROM sessions WHERE id = ?").run(id);
        if (result.changes === 0) return Response.json({ error: "session not found" }, { status: 404 });
        broadcast("session", { id, deleted: true });
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/auth-status" && req.method === "GET") {
      const { wave } = await import("./wave-bridge.ts");
      return Response.json({ hasJwt: wave.hasJwt() });
    }

    if (url.pathname === "/api/browse" && req.method === "GET") {
      try {
        const { browseDir } = await import("./browse.ts");
        const reqPath = url.searchParams.get("path") || homedir();
        return Response.json(browseDir(reqPath));
      } catch (e: unknown) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    }

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
