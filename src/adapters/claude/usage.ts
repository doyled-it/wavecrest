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

// Track consecutive identical successful polls. claude's TUI sometimes serves
// a cached /usage view that doesn't reflect fresh server data; if our parsed
// result hasn't changed across STUCK_THRESHOLD polls, force-respawn the meta
// process so it re-fetches from claude's API. Ported from agent-view.
const STUCK_THRESHOLD = 3;
let lastSnapshotHash = 0;
let unchangedCount = 0;

function hashSnapshots(snaps: UsageSnapshot[]): number {
  // Cheap rolling hash over (scope, key, used, resets_text).
  let h = 5381;
  for (const s of snaps) {
    const key = `${s.scope}|${s.scope_key ?? ""}|${s.used}|${s.resets_text ?? ""}`;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return h;
}

export async function claudeAccountUsage(): Promise<UsageSnapshot[]> {
  if (!meta) meta = await spawnMeta();
  try {
    const result = await meta.poll();

    if (result.length > 0) {
      const h = hashSnapshots(result);
      if (h === lastSnapshotHash) {
        unchangedCount++;
        if (unchangedCount >= STUCK_THRESHOLD) {
          log.info("usage: stuck for several polls, respawning meta", { polls: unchangedCount });
          try { meta.kill(); } catch {}
          meta = null;
          unchangedCount = 0;
          lastSnapshotHash = 0;
        }
      } else {
        unchangedCount = 0;
        lastSnapshotHash = h;
      }
    }
    return result;
  } catch (e) {
    log.warn("usage poll failed, respawning", { error: String(e) });
    try { meta?.kill(); } catch {}
    meta = await spawnMeta();
    unchangedCount = 0;
    lastSnapshotHash = 0;
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
      // Wait up to 12s for /usage to finish rendering. Claude shows "Loading
      // usage data…" while it's still fetching — capturing during that window
      // would pick up half-rendered or stale bar values. Treat the buffer as
      // ready when (a) we got at least the session + weekly buckets and (b)
      // the loading placeholder no longer trails the buffer.
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await sleep(300);
        drainFd();
        if (looksStillLoading(buf)) continue;
        const parsed = parseUsage(buf);
        if (parsed.length >= 2) return parsed;
      }
      drainFd();
      if (looksStillLoading(buf)) {
        // Skip — the data would be wrong, and inserting it would knock the
        // dashboard down to whatever the loading placeholder leaves behind.
        return [];
      }
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

/** True when the buffer's most recent screen still shows the "Loading…"
 *  placeholder. Capturing during this state yields wrong bar percentages. */
function looksStillLoading(buf: string): boolean {
  const clean = stripAnsi(buf);
  const tail = clean.slice(-2000);
  return /loading\s*usage\s*data/i.test(tail) && !/Current\s*week/i.test(tail);
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

    // Cursor-positioning render often compresses whitespace, so "Resets" and
    // the following time may run together (e.g. "Resets10pm(America/...)").
    const resetsLine = trimmed.match(/^Resets\s*(.+)$/i);
    if (resetsLine) {
      const rest = resetsLine[1]!;
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
      resets_at: parseResetTime(parsed.resets, now),
      resets_text: abbreviateResets(parsed.resets),
    });
  }
  return out;
}

const TZ_ABBREV: Record<string, string> = {
  "America/Los_Angeles": "PT",
  "America/Denver": "MT",
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "Europe/London": "GMT",
  "Europe/Paris": "CET",
  "Europe/Berlin": "CET",
  "Asia/Tokyo": "JST",
  "Asia/Shanghai": "CST",
  "Asia/Hong_Kong": "CST",
  "UTC": "UTC",
};

/** Convert "12pm (America/Los_Angeles)" → "12pm PT".
 *  Convert "Apr 23 at 6pm (America/New_York)" → "Apr 23 at 6pm ET".
 *  Unknown IANA zones fall back to their last path component ("Europe/Madrid" → "Madrid"). */
export function abbreviateResets(resets: string): string {
  const m = resets.match(/^(.*?)\s*\(\s*([^)]+)\s*\)\s*$/);
  if (!m) return resets;
  const timePart = m[1]!.trim();
  const tz = m[2]!.trim();
  const abbr = TZ_ABBREV[tz] ?? tz.split("/").pop() ?? tz;
  return `${timePart} ${abbr}`;
}

/** Parse a "Resets ..." string into an absolute epoch ms timestamp, best-effort.
 *
 *  Formats observed from claude /usage:
 *    "12pm (America/Los_Angeles)"           — time-only, same day or next day
 *    "3:20am (America/Los_Angeles)"         — same, with minutes
 *    "Apr 23 at 12pm (America/Los_Angeles)" — explicit date
 *    "May 29 at 2am (America/Los_Angeles)"  — same
 *
 *  Render artifacts compress whitespace ("May29at2am") so the regex tolerates
 *  optional whitespace around the connector words.
 *
 *  Returns null if parsing fails. Time-only formats assume the time is the
 *  next occurrence (today if still in future, else tomorrow). */
export function parseResetTime(resets: string, nowMs: number): number | null {
  const m = resets.match(/^(.*?)\s*\(\s*([^)]+)\s*\)\s*$/);
  if (!m) return null;
  const tz = m[2]!.trim();
  const timeStr = m[1]!.trim();

  // Format: "<month> <day> at <hour>[:<min>]<am|pm>"
  let mo: number | null = null, dy: number | null = null, hr: number | null = null, mn = 0;
  const dated = timeStr.match(/^([A-Za-z]+)\s*(\d+)\s*at\s*(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (dated) {
    mo = parseMonth(dated[1]!);
    dy = parseInt(dated[2]!, 10);
    hr = parseInt(dated[3]!, 10);
    if (dated[4]) mn = parseInt(dated[4], 10);
    hr = to24h(hr, dated[5]!);
    if (mo === null) return null;
  } else {
    // Format: "<hour>[:<min>]<am|pm>"
    const timeOnly = timeStr.match(/^(\d+)(?::(\d+))?\s*(am|pm)$/i);
    if (!timeOnly) return null;
    hr = parseInt(timeOnly[1]!, 10);
    if (timeOnly[2]) mn = parseInt(timeOnly[2], 10);
    hr = to24h(hr, timeOnly[3]!);
  }

  // Compute the wall-clock target in the user's reset timezone. We build a
  // candidate Date in UTC then shift it by the timezone's offset.
  const nowDate = new Date(nowMs);
  const tzNow = nowInTimezone(tz, nowDate);
  if (!tzNow) return null;

  if (mo === null) {
    // Time-only: today in tz; if it's already past, roll to tomorrow.
    mo = tzNow.month;
    dy = tzNow.day;
    let candidate = makeUtcMillisAt(tzNow.year, mo, dy!, hr, mn, tz);
    if (candidate <= nowMs) {
      const next = new Date(candidate);
      next.setUTCDate(next.getUTCDate() + 1);
      candidate = next.getTime();
    }
    return candidate;
  }
  // Explicit month/day: assume current year unless that would be in the past.
  let year = tzNow.year;
  let candidate = makeUtcMillisAt(year, mo, dy!, hr, mn, tz);
  if (candidate <= nowMs) {
    candidate = makeUtcMillisAt(year + 1, mo, dy!, hr, mn, tz);
  }
  return candidate;
}

function to24h(h: number, ampm: string): number {
  const isPm = /^pm$/i.test(ampm);
  if (h === 12) return isPm ? 12 : 0;
  return isPm ? h + 12 : h;
}

function parseMonth(name: string): number | null {
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const idx = months.indexOf(name.slice(0, 3).toLowerCase());
  return idx < 0 ? null : idx + 1;
}

/** Return year/month/day in the given IANA timezone as of `now`. */
function nowInTimezone(tz: string, now: Date): { year: number; month: number; day: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    const year = parseInt(get("year") ?? "", 10);
    const month = parseInt(get("month") ?? "", 10);
    const day = parseInt(get("day") ?? "", 10);
    if (!year || !month || !day) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

/** Compose a UTC epoch ms for a given wall-clock moment in `tz`. We use
 *  Intl.DateTimeFormat to discover how the tz interprets the moment, then
 *  adjust to align. Works across DST transitions within a few seconds. */
function makeUtcMillisAt(year: number, month: number, day: number, hr: number, mn: number, tz: string): number {
  // First guess: the same wall-clock interpreted as UTC.
  const guess = Date.UTC(year, month - 1, day, hr, mn, 0, 0);
  // Compute what the tz thinks `guess` is, then adjust by the difference.
  const tzWall = wallclockInTz(guess, tz);
  if (!tzWall) return guess;
  const tzGuess = Date.UTC(tzWall.year, tzWall.month - 1, tzWall.day, tzWall.hr, tzWall.mn, 0, 0);
  const diff = guess - tzGuess;
  return guess + diff;
}

function wallclockInTz(epochMs: number, tz: string): { year: number; month: number; day: number; hr: number; mn: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    return {
      year: parseInt(get("year") ?? "", 10),
      month: parseInt(get("month") ?? "", 10),
      day: parseInt(get("day") ?? "", 10),
      hr: parseInt(get("hour") ?? "", 10),
      mn: parseInt(get("minute") ?? "", 10),
    };
  } catch { return null; }
}
