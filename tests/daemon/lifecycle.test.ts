import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { rmSync } from "fs";
import { fileURLToPath } from "url";

// We use Bun.spawn subprocess isolation so that the module-load-time `paths`
// binding in src/lib/paths.ts sees the correct WAVECREST_HOME for each run,
// and so that process-level SIGTERM/SIGINT handlers don't leak into the test
// process.

// Absolute path to the project root so inline eval scripts can import correctly.
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

describe("daemon lifecycle (subprocess)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wc-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("starts, writes PID file, shuts down and removes PID file", async () => {
    // Inline script: start daemon, record whether PID file was written, call
    // shutdown, then verify PID file was removed.  Print JSON result to stdout.
    const pathsModule = JSON.stringify(join(PROJECT_ROOT, "src/lib/paths.ts"));
    const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));
    const script = `
      process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
      const { paths } = await import(${pathsModule});
      const { startDaemon } = await import(${daemonModule});
      const { existsSync } = await import("fs");
      const daemon = await startDaemon();
      const pidWritten = existsSync(paths.pid);
      await daemon.shutdown();
      const pidGone = !existsSync(paths.pid);
      console.log(JSON.stringify({ pidWritten, pidGone }));
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

    let result: { pidWritten: boolean; pidGone: boolean };
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON: ${stdout}\nstderr: ${stderr}`);
    }

    expect(result.pidWritten).toBe(true);
    expect(result.pidGone).toBe(true);
  });

  test("throws when daemon is already running (PID collision)", async () => {
    // Write a fake PID file pointing to this very test process (guaranteed alive).
    const pidFile = join(tmpDir, "daemon.pid");
    const { writeFileSync } = await import("fs");
    writeFileSync(pidFile, String(process.pid));

    const daemonModule = JSON.stringify(join(PROJECT_ROOT, "src/daemon/index.ts"));
    const script = `
      process.env.WAVECREST_HOME = ${JSON.stringify(tmpDir)};
      const { startDaemon } = await import(${daemonModule});
      try {
        await startDaemon();
        console.log(JSON.stringify({ threw: false }));
      } catch (e) {
        console.log(JSON.stringify({ threw: true, msg: e.message }));
      }
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

    let result: { threw: boolean; msg?: string };
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`subprocess stdout not JSON: ${stdout}\nstderr: ${stderr}`);
    }

    expect(result.threw).toBe(true);
    expect(result.msg).toContain("daemon already running");
  });
});
