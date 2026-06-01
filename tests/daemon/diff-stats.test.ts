import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { computeDiffStats } from "../../src/daemon/diff-stats.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Build a throwaway repo with a default branch + a feature branch that has
// real commits diverging from it.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wc-diff-stats-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "init"]);
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "a.txt"), "hello\nworld\nnew line\nanother\n");
  writeFileSync(join(dir, "b.txt"), "fresh file\n");
  git(dir, ["add", "a.txt", "b.txt"]);
  git(dir, ["commit", "-m", "feature work"]);
  return dir;
}

test("computeDiffStats reports insertions/deletions vs main", () => {
  const dir = makeRepo();
  try {
    const stats = computeDiffStats(dir);
    expect(stats).not.toBeNull();
    expect(stats!.files).toBe(2);
    expect(stats!.insertions).toBe(3); // 2 new lines in a.txt + 1 line in b.txt
    expect(stats!.deletions).toBe(0);
    expect(stats!.base).toMatch(/^[0-9a-f]{7}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeDiffStats returns null for null path", () => {
  expect(computeDiffStats(null)).toBeNull();
});

test("computeDiffStats returns null for nonexistent path", () => {
  expect(computeDiffStats("/tmp/does-not-exist-wavecrest-test")).toBeNull();
});

test("computeDiffStats returns null for non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-diff-nogit-"));
  try {
    expect(computeDiffStats(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
