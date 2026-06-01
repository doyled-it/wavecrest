// Helpers for proxying the `codegraph` CLI from wavecrest's MCP tools.
// codegraph (https://github.com/colbymchenry/codegraph) is an external tool
// that builds a queryable index over a codebase. We shell out to its CLI
// rather than embedding its MCP server so wavecrest stays the single MCP
// entrypoint a host needs to register.
import { execFile } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60_000;

export interface CodegraphRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
}

function readInteractivePath(): string | null {
  try {
    const envPath = join(
      process.env.WAVECREST_HOME ?? join(homedir(), ".wavecrest"),
      "wave-env.json",
    );
    if (!existsSync(envPath)) return null;
    const env = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, unknown>;
    const ip = env.INTERACTIVE_PATH;
    return typeof ip === "string" && ip.length > 0 ? ip : null;
  } catch {
    return null;
  }
}

function whichOn(bin: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

// Resolve the `codegraph` binary. Probe order:
//   1. WAVECREST_CODEGRAPH_PATH env var
//   2. PATH captured in ~/.wavecrest/wave-env.json (INTERACTIVE_PATH)
//   3. System PATH inherited by this process
// Returns null if not found anywhere.
export function findCodegraphBin(): string | null {
  const envOverride = process.env.WAVECREST_CODEGRAPH_PATH;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const interactive = readInteractivePath();
  if (interactive) {
    const found = whichOn("codegraph", interactive);
    if (found) return found;
  }

  const sysPath = process.env.PATH ?? "";
  if (sysPath) {
    const found = whichOn("codegraph", sysPath);
    if (found) return found;
  }

  return null;
}

export function repoIsIndexed(repoPath: string): boolean {
  return existsSync(join(repoPath, ".codegraph"));
}

export function repoPathLooksValid(repoPath: string): boolean {
  try {
    return statSync(repoPath).isDirectory();
  } catch {
    return false;
  }
}

// Wraps execFile with a timeout and returns a normalized result.
// We use execFile (not exec) so the question / repo path arguments are
// passed as argv elements — no shell interpolation of quotes or `;`.
export function runCodegraph(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; bin?: string },
): Promise<CodegraphRunResult> {
  const bin = opts?.bin ?? findCodegraphBin();
  if (!bin) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "codegraph CLI not found",
      code: null,
    });
  }
  const timeout = opts?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: opts?.cwd,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const so = stdout?.toString() ?? "";
        const se = stderr?.toString() ?? "";
        if (err) {
          // execFile sets `killed=true` and `code=null` on timeout.
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null };
          const timedOut = !!e.killed && e.code === null;
          resolve({
            ok: false,
            stdout: so,
            stderr: se || (timedOut ? `timed out after ${timeout}ms` : e.message),
            code: typeof e.code === "number" ? e.code : null,
            timedOut,
          });
          return;
        }
        resolve({ ok: true, stdout: so, stderr: se, code: 0 });
      },
    );
  });
}

export { DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_INDEX_TIMEOUT_MS };
