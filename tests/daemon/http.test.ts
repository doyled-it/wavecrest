import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { startHttpServer } from "../../src/daemon/http.ts";

// Absolute path to project root for subprocess scripts.
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

// ---------------------------------------------------------------------------
// Helper: wait for a file to appear (poll up to maxMs)
// ---------------------------------------------------------------------------
async function waitForFile(filePath: string, maxMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await Bun.sleep(50);
  }
  throw new Error(`file never appeared: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Helper: run an inline bun script and return its output
// ---------------------------------------------------------------------------
async function runScript(
  script: string,
  tmpDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "--eval", script], {
    env: { ...process.env, WAVECREST_HOME: tmpDir },
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Helper: start daemon in subprocess, wait for port file, call fn, kill daemon
// ---------------------------------------------------------------------------
interface DaemonHandle {
  port: number;
  kill: () => Promise<void>;
}

async function spawnDaemon(tmpDir: string): Promise<DaemonHandle> {
  const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));
  const portFile = join(tmpDir, "port");

  // This script starts the daemon then parks waiting for SIGTERM.
  const script = `
    process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
    const { startDaemon } = await import(${daemonModule});
    const daemon = await startDaemon();
    // Keep alive until killed
    await new Promise(() => {});
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    env: { ...process.env, WAVECREST_HOME: tmpDir },
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });

  // Wait for daemon to write its port file
  await waitForFile(portFile, 10_000);
  const port = parseInt(readFileSync(portFile, "utf8"), 10);

  const kill = async () => {
    proc.kill("SIGTERM");
    await proc.exited;
  };

  return { port, kill };
}

// ---------------------------------------------------------------------------
// Unit tests: startHttpServer (no daemon needed)
// ---------------------------------------------------------------------------
describe("startHttpServer", () => {
  it("binds a port and responds to /api/health", async () => {
    const server = startHttpServer(
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/health") return Response.json({ ok: true });
        return new Response("not found", { status: 404 });
      },
      // Use port 0 to let the OS pick a free port... Bun.serve doesn't support port 0,
      // so use a high unlikely port range instead.
      47321,
    );

    try {
      const port = server.port;
      expect(port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as unknown;
      expect(body).toEqual({ ok: true });

      const notFound = await fetch(`http://127.0.0.1:${port}/missing`);
      expect(notFound.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("retries on a busy port", async () => {
    // Occupy the first port
    const first = startHttpServer((_req) => new Response("first"), 47400);
    const second = startHttpServer((_req) => new Response("second"), 47400);
    try {
      expect(second.port).toBe(47401);
    } finally {
      first.stop();
      second.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: REST routes via startDaemon subprocess
// ---------------------------------------------------------------------------
describe("REST routes (subprocess daemon)", () => {
  it("/api/sessions returns empty array on a fresh db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wc-http-"));
    const daemon = await spawnDaemon(tmpDir);
    try {
      const r = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions`);
      expect(r.status).toBe(200);
      const body = await r.json() as unknown;
      expect(body).toEqual([]);
    } finally {
      await daemon.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/api/usage returns { claude: [] } on a fresh db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wc-http-"));
    const daemon = await spawnDaemon(tmpDir);
    try {
      const r = await fetch(`http://127.0.0.1:${daemon.port}/api/usage`);
      expect(r.status).toBe(200);
      const body = await r.json() as unknown;
      expect(body).toEqual({ claude: [] });
    } finally {
      await daemon.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/api/sessions returns an inserted session with its rollup", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wc-http-"));
    try {
      // Use a self-contained script: start daemon, insert data via the same db
      // handle the daemon uses, then fetch via HTTP, then shut down.
      const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));
      const insertModule = JSON.stringify(join(PROJECT_ROOT, "src/db/queries.ts"));
      const dbModule = JSON.stringify(join(PROJECT_ROOT, "src/db/index.ts"));

      const script = `
        process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
        const { startDaemon } = await import(${daemonModule});
        const { openDb } = await import(${dbModule});
        const { insertSession, upsertRollup } = await import(${insertModule});
        const { readFileSync } = await import("fs");

        const daemon = await startDaemon();

        // Open a second handle to the same WAL-mode db to insert test data
        const db = openDb(${JSON.stringify(join(tmpDir, "state.db"))});
        const session = {
          id: "sess_01", agent_kind: "claude",
          agent_session_id: null, workspace_id: null,
          wave_tab_id: null, wave_block_id: null,
          cwd: "/tmp", repo_root: null, branch: null, worktree_path: null,
          launch_argv: ["claude"], display_name: "Test session",
          status: "running", auto_resume: false, pinned: false,
          created_at: 1000, last_active_at: 1001, transcript_path: null,
        };
        insertSession(db, session);
        upsertRollup(db, {
          session_id: "sess_01",
          input_tokens: 10, output_tokens: 5,
          cache_read_tokens: 0, cache_write_tokens: 0,
          cost_usd: 0.001, updated_at: 1002,
        });
        db.close();

        const port = parseInt(readFileSync(${JSON.stringify(join(tmpDir, "port"))}, "utf8"), 10);
        const r = await fetch("http://127.0.0.1:" + port + "/api/sessions");
        const body = await r.json();
        await daemon.shutdown();
        console.log(JSON.stringify({ status: r.status, body }));
      `;

      const { stdout, stderr, exitCode } = await runScript(script, tmpDir);
      expect(exitCode).toBe(0);

      let result: { status: number; body: unknown };
      try {
        result = JSON.parse(stdout.trim()) as { status: number; body: unknown };
      } catch {
        throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
      }

      expect(result.status).toBe(200);
      const sessions = result.body as Array<{
        id: string;
        display_name: string;
        rollup: { input_tokens: number } | null;
      }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("sess_01");
      expect(sessions[0]?.display_name).toBe("Test session");
      expect(sessions[0]?.rollup).not.toBeNull();
      expect(sessions[0]?.rollup?.input_tokens).toBe(10);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/api/events delivers a broadcast event over SSE", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wc-http-"));
    try {
      const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));
      const sseModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/sse.ts"));

      // Self-contained script: start daemon, connect SSE, broadcast, read back, shut down
      const script = `
        process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
        const { startDaemon } = await import(${daemonModule});
        const { broadcast } = await import(${sseModule});
        const { readFileSync } = await import("fs");

        const daemon = await startDaemon();
        const port = parseInt(readFileSync(${JSON.stringify(join(tmpDir, "port"))}, "utf8"), 10);

        // Connect to SSE endpoint
        const res = await fetch("http://127.0.0.1:" + port + "/api/events", {
          headers: { Accept: "text/event-stream" },
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        // Read the first chunk (": connected\\n\\n")
        const { value: connChunk } = await reader.read();
        const connText = decoder.decode(connChunk);

        // Broadcast after a short delay to ensure our reader is waiting
        setTimeout(() => broadcast("test", { x: 1 }), 50);

        // Read next chunk with 2s timeout
        const eventText = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("SSE read timeout")), 2000);
          reader.read().then(({ value }) => {
            clearTimeout(t);
            resolve(decoder.decode(value));
          }).catch(reject);
        });

        reader.cancel().catch(() => {});
        await daemon.shutdown();

        console.log(JSON.stringify({ connText, eventText }));
      `;

      const { stdout, stderr, exitCode } = await runScript(script, tmpDir);
      expect(exitCode).toBe(0);

      let result: { connText: string; eventText: string };
      try {
        result = JSON.parse(stdout.trim()) as { connText: string; eventText: string };
      } catch {
        throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
      }

      expect(result.connText).toContain(": connected");
      expect(result.eventText).toContain("event: test");
      expect(result.eventText).toContain('"x":1');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
