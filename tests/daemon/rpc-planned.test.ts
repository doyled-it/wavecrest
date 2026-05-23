import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

describe("daemon RPC: registerPlannedSession + listResumable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wc-rpc-planned-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registerPlannedSession creates a session row with correct fields", async () => {
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

      const { id } = await rpcCall("registerPlannedSession", {
        kind: "claude",
        cwd: "/some/path",
        branch: "feat/my-feature",
        worktree_path: "/some/path/.worktrees/feat-my-feature",
        launch_argv: ["claude"],
        display_name: "feat/my-feature",
      });

      const sessions = await rpcCall("listSessions", {});
      const s = sessions.find(s => s.id === id);
      const result = {
        found: !!s,
        id_nonempty: !!id,
        status: s?.status,
        auto_resume: s?.auto_resume,
        pinned: s?.pinned,
        cwd: s?.cwd,
        branch: s?.branch,
        worktree_path: s?.worktree_path,
        display_name: s?.display_name,
        agent_session_id: s?.agent_session_id,
        launch_argv: s?.launch_argv,
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

    let result: any;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(result.found).toBe(true);
    expect(result.id_nonempty).toBe(true);
    expect(result.status).toBe("idle");
    expect(result.auto_resume).toBe(true);
    expect(result.pinned).toBe(false);
    expect(result.cwd).toBe("/some/path");
    expect(result.branch).toBe("feat/my-feature");
    expect(result.worktree_path).toBe("/some/path/.worktrees/feat-my-feature");
    expect(result.display_name).toBe("feat/my-feature");
    expect(result.agent_session_id).toBeNull();
    expect(result.launch_argv).toEqual(["claude"]);
  });

  test("listResumable returns idle auto_resume sessions but not finished ones", async () => {
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

      // Register a session that should be resumable (status=idle, auto_resume=true)
      const { id: resumableId } = await rpcCall("registerPlannedSession", {
        kind: "claude",
        cwd: "/work/branch-a",
        branch: "branch-a",
        worktree_path: null,
        launch_argv: ["claude"],
        display_name: "branch-a",
      });

      // Register a second session and then mark it finished via a hook
      const { id: finishedId } = await rpcCall("registerPlannedSession", {
        kind: "claude",
        cwd: "/work/branch-b",
        branch: "branch-b",
        worktree_path: null,
        launch_argv: ["claude"],
        display_name: "branch-b",
      });

      // Transition branch-b to finished: simulate a SessionStart then SubagentStop
      // We use the hook RPC to push a stop event — but since registerPlannedSession
      // doesn't set an agent_session_id, we can't match by that. Instead update
      // status directly through the DB. Use the openDb + updateSessionStatus path.
      const { openDb } = await import(${JSON.stringify(join(PROJECT_ROOT, "src/db/index.ts"))});
      const { updateSessionStatus } = await import(${JSON.stringify(join(PROJECT_ROOT, "src/db/queries.ts"))});
      const { paths: p2 } = await import(${pathsModule});
      const db2 = openDb(p2.db);
      updateSessionStatus(db2, finishedId, "finished", Date.now());
      db2.close();

      const resumable = await rpcCall("listResumable", {});
      const result = {
        count: resumable.length,
        has_resumable: resumable.some(s => s.id === resumableId),
        has_finished: resumable.some(s => s.id === finishedId),
        resumable_auto_resume: resumable.find(s => s.id === resumableId)?.auto_resume,
        resumable_launch_argv_parsed: Array.isArray(resumable.find(s => s.id === resumableId)?.launch_argv),
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

    let result: any;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(result.count).toBe(1);
    expect(result.has_resumable).toBe(true);
    expect(result.has_finished).toBe(false);
    // Confirm rowToSession deserialization ran: auto_resume is boolean, launch_argv is an array
    expect(result.resumable_auto_resume).toBe(true);
    expect(result.resumable_launch_argv_parsed).toBe(true);
  });

  test("registerPlannedSession rejects missing required fields", async () => {
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

      let threw = false;
      let errMsg = "";
      try {
        await rpcCall("registerPlannedSession", {
          // missing kind and launch_argv
          cwd: "/some/path",
        });
      } catch (e) {
        threw = true;
        errMsg = e.message;
      }

      await daemon.shutdown();
      console.log(JSON.stringify({ threw, errMsg }));
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

    let result: any;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(result.threw).toBe(true);
    expect(result.errMsg).toContain("kind must be a string");
  });
});
