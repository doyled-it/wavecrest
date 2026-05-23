// src/adapters/claude/usage.ts
import pty from "node-pty";
import type { UsageSnapshot } from "../../types.ts";
import { log } from "../../lib/logger.ts";

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
  let p;
  try {
    p = pty.spawn("claude", [], {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: "/tmp",
      env: process.env as any,
    });
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      log.warn("claude not found on PATH, usage polling disabled");
      return { poll: async () => [], kill: () => {} };
    }
    throw e;
  }
  let buf = "";
  p.onData(d => {
    buf += d;
    if (buf.length > 200_000) buf = buf.slice(-100_000);
  });

  // wait for idle prompt + accept trust if shown
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await sleep(500);
    if (buf.includes("Yes, I trust this folder")) {
      p.write("\r");
      continue;
    }
    if (looksIdle(buf)) break;
  }
  if (!looksIdle(buf)) {
    p.kill();
    throw new Error("claude didn't reach idle prompt");
  }

  return {
    async poll() {
      // close any previous /usage view
      p.write("\x1b"); // Esc
      await sleep(300);
      buf = "";
      p.write("/usage\r");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(250);
        const parsed = parseUsage(buf);
        if (parsed.length >= 3) return parsed;
      }
      return parseUsage(buf);
    },
    kill() {
      try { p.kill(); } catch {}
    },
  };
}

function looksIdle(b: string): boolean {
  return /[╭>]/.test(b.slice(-2000));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

const BUCKET_PATTERNS: Array<[RegExp, UsageSnapshot["scope"], string | null]> = [
  [/Current session[\s\S]{0,200}?(\d+)% used[\s\S]{0,200}?Resets\s+([^\n]+)/i, "session", null],
  [/Current week \(all models\)[\s\S]{0,200}?(\d+)% used[\s\S]{0,200}?Resets\s+([^\n]+)/i, "weekly", null],
  [/Current week \(Sonnet only\)[\s\S]{0,200}?(\d+)% used[\s\S]{0,200}?Resets\s+([^\n]+)/i, "model", "Sonnet"],
  [/Current week \(Opus only\)[\s\S]{0,200}?(\d+)% used[\s\S]{0,200}?Resets\s+([^\n]+)/i, "model", "Opus"],
];

export function parseUsage(text: string): UsageSnapshot[] {
  const clean = stripAnsi(text);
  const out: UsageSnapshot[] = [];
  const now = Date.now();
  for (const [re, scope, key] of BUCKET_PATTERNS) {
    const m = clean.match(re);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({
      agent_kind: "claude",
      ts: now,
      scope,
      scope_key: key,
      used: parseInt(m[1], 10),
      limit: 100,
      resets_at: parseResetTime(m[2]),
    });
  }
  return out;
}

function parseResetTime(_s: string): number | null {
  return null; // phase 1: leave null; future: parse human dates
}
