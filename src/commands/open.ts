import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { callDaemon } from "./hook.ts";
import { wave } from "../daemon/wave-bridge.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { AgentKind } from "../types.ts";

export async function runOpen(
  branch: string,
  opts: { worktree?: boolean; agent?: string; cwd?: string }
): Promise<void> {
  const agentKind = (opts.agent ?? "claude") as AgentKind;
  const baseCwd = resolve(opts.cwd ?? process.cwd());
  let workCwd = baseCwd;
  let worktreePath: string | null = null;

  if (opts.worktree) {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: baseCwd })
      .toString()
      .trim();
    worktreePath = join(repoRoot, ".worktrees", branch);
    mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });

    if (!existsSync(worktreePath)) {
      // Check if the branch already exists (e.g. from a previous interrupted run where
      // the worktree path was deleted but the branch ref was kept). If it does, use
      // `git worktree add <path> <branch>` (no -b) so we don't try to re-create it.
      // If it doesn't exist, create it with -b.
      let branchExists = false;
      try {
        execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repoRoot, stdio: "pipe" });
        branchExists = true;
      } catch {
        branchExists = false;
      }

      if (branchExists) {
        execFileSync("git", ["worktree", "add", worktreePath, branch], {
          cwd: repoRoot,
          stdio: "inherit",
        });
      } else {
        execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
          cwd: repoRoot,
          stdio: "inherit",
        });
      }
    }
    workCwd = worktreePath;
  }

  const adapter = getAdapter(agentKind);

  // Build the launch argv. For a brand-new session (no agent_session_id yet), resumeCommand
  // returns just ["claude"] — we pass a minimal Session-shaped object so we can reuse the
  // adapter's command-building logic without needing a separate launchCommand() API.
  const launchArgv = adapter.resumeCommand({
    id: "", agent_kind: agentKind, agent_session_id: null,
    workspace_id: null, wave_tab_id: null, wave_block_id: null,
    cwd: workCwd, repo_root: null, branch, worktree_path: worktreePath,
    launch_argv: ["claude"], display_name: null,
    status: "idle", auto_resume: true, pinned: false,
    created_at: 0, last_active_at: 0, transcript_path: null,
  });

  const { id } = await callDaemon("registerPlannedSession", {
    kind: agentKind, cwd: workCwd, branch, worktree_path: worktreePath,
    launch_argv: launchArgv, display_name: branch,
  }) as { id: string };

  await wave.createBlock({
    tabName: branch, cwd: workCwd, argv: launchArgv,
    envExtra: { WAVECREST_SESSION_ID: id },
  });

  console.log(`opened session ${id} on branch ${branch}`);
}
