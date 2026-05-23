import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { paths } from "../lib/paths.ts";
import { openDb } from "../db/index.ts";
import { log } from "../lib/logger.ts";

export interface Daemon {
  shutdown(): Promise<void>;
}

export async function startDaemon(): Promise<Daemon> {
  mkdirSync(paths.root, { recursive: true });
  ensureNotRunning();
  writeFileSync(paths.pid, String(process.pid));

  const db = openDb(paths.db);
  log.info("daemon: db ready", { path: paths.db });

  // HTTP + sock + watchers will be wired in later tasks.

  const shutdown = async () => {
    db.close();
    if (existsSync(paths.pid)) {
      try { unlinkSync(paths.pid); } catch {}
    }
    log.info("daemon: shut down");
  };

  process.on("SIGTERM", () => { shutdown().then(() => process.exit(0)); });
  process.on("SIGINT",  () => { shutdown().then(() => process.exit(0)); });

  return { shutdown };
}

function ensureNotRunning(): void {
  if (!existsSync(paths.pid)) return;
  const pid = parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
  if (!Number.isFinite(pid)) { unlinkSync(paths.pid); return; }
  try {
    process.kill(pid, 0);
    throw new Error(`daemon already running (pid ${pid})`);
  } catch (e: any) {
    if (e?.code === "ESRCH") { unlinkSync(paths.pid); return; }
    throw e;
  }
}
