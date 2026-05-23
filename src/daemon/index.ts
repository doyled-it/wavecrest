import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { paths } from "../lib/paths.ts";
import { openDb } from "../db/index.ts";
import { log } from "../lib/logger.ts";
import { startSockServer } from "./sock.ts";
import { startHttpServer } from "./http.ts";
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

  log.info("daemon: ready", { port: http.port, sock: paths.sock });

  const shutdown = async () => {
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

function makeRpcHandler(_db: Database) {
  return async (method: string): Promise<unknown> => {
    if (method === "ping") return { ok: true };
    throw new Error(`unknown method: ${method}`);
  };
}

function makeHttpHandler(_db: Database) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
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
