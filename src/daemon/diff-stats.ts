// Per-session git diff-stat probe. Powers the worktree "+X -Y" line on each
// card. Cheap (single `git diff --shortstat`) but called per session per list
// fetch, so results are cached briefly.
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { log } from "../lib/logger.ts";

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
  base: string; // the merge-base sha (short) we diffed against
}

interface CacheEntry {
  ts: number;
  stats: DiffStats | null;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, CacheEntry>();

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
}

// Pick the repo's default branch. Tries origin/HEAD symbolic ref first (the
// authoritative answer); falls back to common names so freshly-cloned
// or origin-less repos still get an answer.
function defaultBranch(cwd: string): string | null {
  try {
    const ref = run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // origin/HEAD may not be set — fall through.
  }
  for (const candidate of ["main", "master"]) {
    try {
      run(cwd, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // not present — try next
    }
  }
  return null;
}

// Parse "N files changed, X insertions(+), Y deletions(-)" — git omits files
// or sides that are zero, so each field is independently optional.
function parseShortstat(line: string): { files: number; insertions: number; deletions: number } {
  const files = /(\d+)\s+files? changed/.exec(line)?.[1];
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(line)?.[1];
  const del = /(\d+)\s+deletions?\(-\)/.exec(line)?.[1];
  return {
    files: files ? parseInt(files, 10) : 0,
    insertions: ins ? parseInt(ins, 10) : 0,
    deletions: del ? parseInt(del, 10) : 0,
  };
}

// Compute diff stats for any git directory — works for both linked worktrees
// and ordinary checkouts. Returns null if cwd isn't a git repo, has no
// default branch, or hasn't diverged from it.
export function computeDiffStats(cwd: string | null): DiffStats | null {
  if (!cwd || !existsSync(cwd)) return null;

  try {
    const base = defaultBranch(cwd);
    if (!base) return null;

    const mergeBase = run(cwd, ["merge-base", "HEAD", base]).trim();
    if (!mergeBase) return null;

    // Include uncommitted changes — what a PR-in-progress would actually show.
    const shortstat = run(cwd, ["diff", "--shortstat", mergeBase]).trim();
    const parsed = parseShortstat(shortstat);
    return { ...parsed, base: mergeBase.slice(0, 7) };
  } catch (e) {
    log.debug("diff-stats: probe failed", { cwd, error: String(e) });
    return null;
  }
}

export function getDiffStats(sessionId: string, cwd: string | null): DiffStats | null {
  const cached = cache.get(sessionId);
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.stats;

  const stats = computeDiffStats(cwd);
  cache.set(sessionId, { ts: now, stats });
  return stats;
}
