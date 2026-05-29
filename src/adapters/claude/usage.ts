// src/adapters/claude/usage.ts
import { closeSync, existsSync, readFileSync, readSync, writeSync } from "fs";
import { dirname, join } from "path";
import type { UsageSnapshot } from "../../types.ts";
import { log } from "../../lib/logger.ts";

/** Try to load node-pty: first as a sibling node_modules next to the binary,
 *  then as a regular ESM import (dev mode where node_modules is reachable). */
async function loadNodePty(): Promise<typeof import("node-pty").default> {
  const candidates: string[] = [];
  if (process.env.WAVECREST_NODE_PTY_PATH) candidates.push(process.env.WAVECREST_NODE_PTY_PATH);

  // In bun-compiled binaries, process.execPath is the virtual `/$bunfs/...` path,
  // but process.argv[0] is the real on-disk binary path the user invoked.
  const probeDirs: string[] = [];
  if (process.argv[0]) probeDirs.push(dirname(process.argv[0]));
  if (process.execPath && !process.execPath.startsWith("/$bunfs")) probeDirs.push(dirname(process.execPath));
  // Also probe relative to cwd as a last resort (helps in test contexts).
  probeDirs.push(process.cwd());

  for (const d of probeDirs) {
    candidates.push(join(d, "node_modules", "node-pty"));
    candidates.push(join(d, "..", "node_modules", "node-pty"));
    candidates.push(join(d, "..", "..", "node_modules", "node-pty"));
  }

  // Bun's compiled binary uses a sealed virtual filesystem at /$bunfs — dynamic
  // `import()` of external paths fails. Use Node's createRequire anchored at a
  // REAL disk path, then load node-pty's main entry directly by absolute path.
  const { createRequire } = await import("module");
  for (const p of candidates) {
    const pkgPath = join(p, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string };
      const entry = join(p, pkg.main ?? "lib/index.js");
      if (!existsSync(entry)) continue;
      // Anchor createRequire at the entry file itself so relative requires inside
      // node-pty (e.g. to its build/Release/pty.node addon) resolve correctly.
      const req = createRequire(entry);
      const mod = req(entry);
      return mod.default ?? mod;
    } catch (e) {
      log.warn("node-pty: load via createRequire failed, trying next", { path: p, error: String(e) });
    }
  }
  // Fall back to bare import (dev mode resolves via project node_modules).
  const mod = await import("node-pty");
  return mod.default ?? mod;
}

const COLS = 200;
const ROWS = 50;

interface MetaProcess {
  poll(): Promise<UsageSnapshot[]>;
  kill(): void;
}

let meta: MetaProcess | null = null;

export async function claudeAccountUsage(): Promise<UsageSnapshot[]> {
  if (!meta) meta = await spawnMeta();
  try {
    return await meta.poll();
  } catch (e) {
    log.warn("usage poll failed, respawning", { error: String(e) });
    meta.kill();
    meta = await spawnMeta();
    return meta.poll();
  }
}

/** Reset the module-level meta process — useful for test isolation. */
export function _resetMetaForTests(): void {
  if (meta) {
    try { meta.kill(); } catch {}
    meta = null;
  }
}

async function spawnMeta(): Promise<MetaProcess> {
  let pty: typeof import("node-pty").default;
  try {
    pty = await loadNodePty();
  } catch (e) {
    log.warn("node-pty not available, usage polling disabled", { error: String(e) });
    return { poll: async () => [], kill: () => {} };
  }

  // The daemon's PATH (under launchd) doesn't include user shell paths. Use the
  // claude binary we captured in `wavecrest auth-set`, and inject the interactive
  // PATH so any subprocesses claude spawns can resolve their tools too.
  const waveEnvPath = join(process.env.HOME ?? "", ".wavecrest", "wave-env.json");
  let claudeBin = "claude";
  let interactivePath = process.env.PATH ?? "";
  if (existsSync(waveEnvPath)) {
    try {
      const wenv = JSON.parse(readFileSync(waveEnvPath, "utf8")) as Record<string, string>;
      if (wenv.AGENT_PATH_CLAUDE) claudeBin = wenv.AGENT_PATH_CLAUDE;
      if (wenv.INTERACTIVE_PATH) interactivePath = wenv.INTERACTIVE_PATH;
    } catch { /* ignore */ }
  }

  // In bun --compile binaries: process.argv[0]="bun", process.execPath=real binary path.
  // Use execPath when it's a real path; fall back to argv[1] (bunfs virtual) only as last resort.
  const realBin = (!process.execPath.startsWith("/$bunfs") ? process.execPath : null)
    ?? process.argv[0];
  const binaryDir = dirname(realBin);
  const spawnHelperPath = join(
    binaryDir, "node_modules", "node-pty",
    "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper",
  );

  log.info("usage poller: spawning meta claude", {
    bin: claudeBin,
    exists: existsSync(claudeBin),
    spawnHelper: spawnHelperPath,
    spawnHelperExists: existsSync(spawnHelperPath),
    execPath: process.execPath,
  });

  // Bun's tty.ReadStream does not auto-resume on 'data' listener registration (unlike
  // Node.js), and on a non-blocking PTY fd it immediately emits EAGAIN then 'close',
  // which causes node-pty to close the master fd and send SIGHUP to the child.
  // Work around this by using pty.native.fork() directly with a readSync polling loop
  // instead of relying on node-pty's tty.ReadStream-based onData event.
  const nativePty: {
    fork(
      file: string, args: string[], env: string[], cwd: string,
      cols: number, rows: number, uid: number, gid: number,
      utf8: boolean, helperPath: string,
      onexit: (code: number, signal: number) => void,
    ): { fd: number; pid: number; pty: string };
  } = (pty as any).native;

  const childEnv = Object.entries({
    ...process.env,
    PATH: interactivePath,
    WAVECREST_USAGE_POLLER: "1",
  }).map(([k, v]) => `${k}=${v ?? ""}`);

  let childFd = -1;
  let childPid = -1;

  try {
    // cwd=/tmp so the daemon's hook filter (which skips /tmp/* sessions) catches
    // these meta-process hooks and doesn't adopt them as wild dashboard rows.
    const term = nativePty.fork(
      claudeBin, [],
      childEnv,
      "/tmp",
      COLS, ROWS, -1, -1, true,
      spawnHelperPath,
      (_code, _signal) => { /* child exited; drainFd will get EIO on next call */ },
    );
    childFd = term.fd;
    childPid = term.pid;
  } catch (e: any) {
    log.warn("usage poller: pty.fork threw", { bin: claudeBin, code: e?.code, error: String(e) });
    if (e?.code === "ENOENT") {
      return { poll: async () => [], kill: () => {} };
    }
    throw e;
  }

  const fd = childFd;
  const pid = childPid;
  let buf = "";
  const readChunk = Buffer.alloc(16384);

  // Poll the master fd directly to avoid Bun's EAGAIN-closes-tty.ReadStream bug.
  const drainFd = () => {
    while (true) {
      try {
        const n = readSync(fd, readChunk, 0, readChunk.length, null);
        if (n <= 0) break;
        buf += readChunk.slice(0, n).toString("utf8");
        if (buf.length > 200_000) buf = buf.slice(-100_000);
      } catch (e: any) {
        if (e?.code === "EAGAIN" || e?.code === "EWOULDBLOCK") break;
        // EIO means the child closed the PTY (exited). Stop draining.
        break;
      }
    }
  };

  const writeToPty = (data: string) => {
    try { writeSync(fd, data); } catch { /* child may have exited */ }
  };

  const killChild = () => {
    try { process.kill(pid, "SIGTERM"); } catch {}
    try { closeSync(fd); } catch {} // release the PTY master fd
  };

  // wait for idle prompt + accept trust dialog if shown.
  // The trust dialog renders text spread across cursor-positioning escape codes, so check
  // the stripped buffer for fragments that uniquely identify the dialog vs. the idle prompt.
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await sleep(500);
    drainFd();
    const cleanBuf = stripAnsi(buf);
    // Trust dialog contains "❯1." followed by trust text (varies by claude version).
    // Detecting "trust" in stripped text is reliable; "No,exit" also distinctive.
    const isTrustDialog = (cleanBuf.includes("trust") && cleanBuf.includes("No,exit"))
      || cleanBuf.includes("trust this folder");
    if (isTrustDialog) {
      writeToPty("\r");   // select option 1 (yes)
      buf = "";           // reset buffer so looksIdle waits for the post-trust idle prompt
      continue;
    }
    if (looksIdle(buf)) break;
  }
  if (!looksIdle(buf)) {
    killChild();
    throw new Error("claude didn't reach idle prompt");
  }

  return {
    async poll() {
      // close any previous /usage view
      writeToPty("\x1b"); // Esc
      await sleep(300);
      drainFd();
      buf = "";
      writeToPty("/usage\r");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(250);
        drainFd();
        const parsed = parseUsage(buf);
        if (parsed.length >= 3) return parsed;
      }
      drainFd();
      return parseUsage(buf);
    },
    kill() {
      killChild();
    },
  };
}

function looksIdle(b: string): boolean {
  // Strip ANSI sequences before checking — raw PTY output contains escape sequences
  // like \x1b[>0q that include literal '>' characters, causing false positives.
  // ╭ appears in the box-drawing UI border. ❯ / > appear in the input prompt line.
  const clean = stripAnsi(b.slice(-4000));
  return /[╭❯]/.test(clean);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Bucket label matching is line-based and forgives cursor-render typos like
 *  "Curretsession" (missing letter) by checking for "Current" + close-enough
 *  follow-up text. */
interface BucketSpec { scope: UsageSnapshot["scope"]; key: string | null; matchLine(line: string): boolean; }

function startsLikeCurrent(line: string, after: RegExp): boolean {
  // Trim, strip remaining cursor-positioning leftovers, accept "Current" with
  // up to a couple of chars then the expected continuation. Cursor render
  // artifacts can drop one or two letters anywhere in the header.
  const t = line.trim();
  if (!/^Cur/.test(t)) return false;
  return after.test(t);
}

const BUCKETS: BucketSpec[] = [
  { scope: "session", key: null,    matchLine: l => startsLikeCurrent(l, /sess/i)   && !/\(/.test(l) },
  { scope: "weekly",  key: null,    matchLine: l => startsLikeCurrent(l, /week/i)   && /\(.*all/i.test(l) },
  { scope: "model",   key: "Sonnet",matchLine: l => startsLikeCurrent(l, /week/i)   && /\(.*so/i.test(l) },
  { scope: "model",   key: "Opus",  matchLine: l => startsLikeCurrent(l, /week/i)   && /\(.*op/i.test(l) },
];

/** Split a string like "Apr 26 at 10am (America/Los_Angeles)  1% used"
 *  into [resetsText, percent]. Returns [s, null] if no trailing "N% used". */
function splitTrailingPercent(s: string): [string, number | null] {
  const idx = s.lastIndexOf("% used");
  if (idx < 0) return [s, null];
  const before = s.slice(0, idx).trimEnd();
  const wsIdx = before.search(/\s\S*$/);
  if (wsIdx < 0) return [s, null];
  const numStr = before.slice(wsIdx).trim();
  const n = parseInt(numStr, 10);
  if (!Number.isFinite(n)) return [s, null];
  return [before.slice(0, wsIdx).trimEnd(), n];
}

function parseBucketAt(lines: string[], labelIdx: number): { percent: number; resets: string } | null {
  let percent: number | null = null;
  let resets: string | null = null;
  // Scan up to 8 lines forward; stop at next bucket header.
  for (let i = labelIdx + 1; i < Math.min(labelIdx + 9, lines.length); i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (/^Cur/.test(trimmed) && /sess|week/i.test(trimmed)) break;

    if (trimmed.startsWith("Resets ")) {
      const rest = trimmed.slice("Resets ".length);
      const [r, p] = splitTrailingPercent(rest);
      if (resets === null) resets = r.trim();
      if (percent === null && p !== null) percent = p;
      continue;
    }
    // Legacy bar line: "████ 33% used"  (also handles compressed "33%used")
    if (percent === null) {
      const m = trimmed.match(/(\d+)\s*%\s*used\s*$/);
      if (m) percent = parseInt(m[1]!, 10);
    }
  }
  if (resets === null) return null;
  return { percent: percent ?? 0, resets };
}

export function parseUsage(text: string): UsageSnapshot[] {
  const clean = stripAnsi(text);
  const lines = clean.split("\n");
  const out: UsageSnapshot[] = [];
  const now = Date.now();

  for (const spec of BUCKETS) {
    // Use rposition equivalent — find the LAST line matching this bucket so we
    // pick the freshest render. Earlier renders may have been pushed apart by
    // intervening output and lost their Resets line.
    let labelIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (spec.matchLine(lines[i]!)) { labelIdx = i; break; }
    }
    if (labelIdx < 0) continue;
    const parsed = parseBucketAt(lines, labelIdx);
    if (!parsed) continue;
    out.push({
      agent_kind: "claude",
      ts: now,
      scope: spec.scope,
      scope_key: spec.key,
      used: parsed.percent,
      limit: 100,
      resets_at: parseResetTime(parsed.resets),
    });
  }
  return out;
}

function parseResetTime(_s: string): number | null {
  return null; // phase 1: leave null; future: parse human dates
}
