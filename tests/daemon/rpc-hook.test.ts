import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { connect } from "net";
import { encodeFrame, FrameDecoder } from "../../src/lib/rpc.ts";

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

// Spin up a daemon in-process (subprocess pattern like lifecycle.test.ts uses,
// but inline to avoid SIGTERM/SIGINT leaking into the test process).
// We use a helper that starts the daemon, runs our assertions, then shuts down.

function rpcCall(sockPath: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath, () => {
      sock.write(encodeFrame({ jsonrpc: "2.0", id: 1, method, params }));
    });
    const dec = new FrameDecoder();
    sock.on("data", (buf: Buffer) => {
      dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      for (const msg of dec.drain()) {
        const m = msg as { result?: unknown; error?: { message: string } };
        sock.destroy();
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("RPC timeout")); });
  });
}

describe("daemon RPC: hook + listSessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wc-rpc-hook-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("SessionStart hook creates a wild session with status=working", async () => {
    const pathsModule = JSON.stringify(join(PROJECT_ROOT, "src/lib/paths.ts"));
    const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));

    const script = `
      process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
      const { paths } = await import(${pathsModule});
      const { startDaemon } = await import(${daemonModule});
      const { connect } = await import("net");
      const { encodeFrame, FrameDecoder } = await import(${JSON.stringify(join(PROJECT_ROOT, "src/lib/rpc.ts"))});

      function rpcCall(method, params) {
        return new Promise((resolve, reject) => {
          const sock = connect(paths.sock, () => {
            sock.write(encodeFrame({ jsonrpc: "2.0", id: 1, method, params }));
          });
          const dec = new FrameDecoder();
          sock.on("data", buf => {
            dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
            for (const msg of dec.drain()) {
              sock.destroy();
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          });
          sock.on("error", reject);
          sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("RPC timeout")); });
        });
      }

      const daemon = await startDaemon();

      // Send SessionStart hook
      await rpcCall("hook", {
        kind: "claude",
        event: "SessionStart",
        payload: { session_id: "test-1", transcript_path: "/tmp/x.jsonl" },
      });

      // List sessions and verify
      const sessions = await rpcCall("listSessions", {});
      const s = sessions.find(s => s.agent_session_id === "test-1");
      const result = {
        found: !!s,
        status: s?.status,
        agent_session_id: s?.agent_session_id,
        auto_resume: s?.auto_resume,
      };

      await daemon.shutdown();
      console.log(JSON.stringify(result));
    `;

    const proc = Bun.spawn(["bun", "--eval", script], {
      env: { ...process.env, WAVECREST_HOME: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);

    let result: { found: boolean; status: string; agent_session_id: string; auto_resume: boolean };
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(result.found).toBe(true);
    expect(result.agent_session_id).toBe("test-1");
    expect(result.status).toBe("working");
    expect(result.auto_resume).toBe(false);
  });

  test("Stop hook updates existing session status to idle", async () => {
    const pathsModule = JSON.stringify(join(PROJECT_ROOT, "src/lib/paths.ts"));
    const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));

    const script = `
      process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
      const { paths } = await import(${pathsModule});
      const { startDaemon } = await import(${daemonModule});

      function rpcCall(method, params) {
        const { connect } = require("net");
        const { encodeFrame, FrameDecoder } = require(${JSON.stringify(join(PROJECT_ROOT, "src/lib/rpc.ts"))});
        return new Promise((resolve, reject) => {
          const sock = connect(paths.sock, () => {
            sock.write(encodeFrame({ jsonrpc: "2.0", id: 1, method, params }));
          });
          const dec = new FrameDecoder();
          sock.on("data", buf => {
            dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
            for (const msg of dec.drain()) {
              sock.destroy();
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          });
          sock.on("error", reject);
          sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("RPC timeout")); });
        });
      }

      const daemon = await startDaemon();

      // Create session via SessionStart
      await rpcCall("hook", {
        kind: "claude",
        event: "SessionStart",
        payload: { session_id: "test-2", transcript_path: "/tmp/y.jsonl" },
      });

      // Send Stop hook for same session
      await rpcCall("hook", {
        kind: "claude",
        event: "Stop",
        payload: { session_id: "test-2" },
      });

      // Verify status is now idle
      const sessions = await rpcCall("listSessions", {});
      const s = sessions.find(s => s.agent_session_id === "test-2");
      const result = {
        found: !!s,
        status: s?.status,
        count: sessions.filter(s => s.agent_session_id === "test-2").length,
      };

      await daemon.shutdown();
      console.log(JSON.stringify(result));
    `;

    const proc = Bun.spawn(["bun", "--eval", script], {
      env: { ...process.env, WAVECREST_HOME: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);

    let result: { found: boolean; status: string; count: number };
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(result.found).toBe(true);
    expect(result.status).toBe("idle");
    // Not re-inserted — exactly one session with this agent_session_id
    expect(result.count).toBe(1);
  });
});
