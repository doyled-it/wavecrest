// Detect git context (branch, whether cwd is a linked worktree) for wild
// session adoption. Returns nulls for non-git cwds. Cheap — only used once
// per session at adoption time.
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";

export interface GitContext {
  repo_root: string | null;
  branch: string | null;
  worktree_path: string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
}

export function detectGitContext(cwd: string | null): GitContext {
  const nope: GitContext = { repo_root: null, branch: null, worktree_path: null };
  if (!cwd || !existsSync(cwd)) return nope;
  try {
    const branch = git(cwd, ["branch", "--show-current"]).trim() || null;
    // --git-common-dir always points at the MAIN repo's .git, whether we're
    // in the main worktree or a linked one. Parent of that = the main repo
    // root, so all worktrees of the same repo share a stable repo_root.
    const commonRaw = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
    const commonAbs = isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw);
    const repo_root = dirname(commonAbs);

    // A linked worktree's --git-dir differs from --git-common-dir.
    const gitDir = git(cwd, ["rev-parse", "--git-dir"]).trim();
    const isLinkedWorktree = gitDir !== commonRaw;
    const worktree_path = isLinkedWorktree
      ? git(cwd, ["rev-parse", "--show-toplevel"]).trim()
      : null;

    return { repo_root, branch, worktree_path };
  } catch {
    return nope;
  }
}
