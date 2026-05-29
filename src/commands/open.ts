import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { callDaemon } from "./hook.ts";
import { wave } from "../daemon/wave-bridge.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { AgentKind } from "../types.ts";

export interface PreparedSession {
  agentKind: AgentKind;
  branch: string;
  workCwd: string;
  worktreePath: string | null;
  launchArgv: string[];
}

/** Pure-ish helper: resolves the worktree (if requested) and builds the launch argv.
 *  No DB writes, no Wave calls — safe to call from CLI or the HTTP handler. */
export function prepareSession(
  branch: string,
  opts: { worktree?: boolean; agent?: string; cwd?: string },
): PreparedSession {
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

    // LIMITATION: if the worktree path exists but tracks a *different* branch than `branch`, we reuse it as-is without warning.
    if (!existsSync(worktreePath)) {
      let branchExists = false;
      try {
        execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repoRoot, stdio: "pipe" });
        branchExists = true;
      } catch {
        branchExists = false;
      }
      const args = branchExists
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", worktreePath, "-b", branch];
      execFileSync("git", args, { cwd: repoRoot, stdio: "inherit" });
    }
    workCwd = worktreePath;
  }

  const adapter = getAdapter(agentKind);
  const launchArgv = adapter.resumeCommand({
    id: "", agent_kind: agentKind, agent_session_id: null,
    workspace_id: null, wave_tab_id: null, wave_block_id: null,
    cwd: workCwd, repo_root: null, branch, worktree_path: worktreePath,
    launch_argv: ["claude"], display_name: null,
    status: "idle", auto_resume: true, pinned: false,
    created_at: 0, last_active_at: 0, transcript_path: null,
  });

  return { agentKind, branch, workCwd, worktreePath, launchArgv };
}

export async function runOpen(
  branch: string,
  opts: { worktree?: boolean; agent?: string; cwd?: string },
): Promise<void> {
  const prep = prepareSession(branch, opts);

  const { id } = await callDaemon("registerPlannedSession", {
    kind: prep.agentKind,
    cwd: prep.workCwd,
    branch: prep.branch,
    worktree_path: prep.worktreePath,
    launch_argv: prep.launchArgv,
    display_name: prep.branch,
  }) as { id: string };

  await wave.createBlock({
    tabName: prep.branch,
    cwd: prep.workCwd,
    argv: prep.launchArgv,
    envExtra: { WAVECREST_SESSION_ID: id },
  });

  console.log(`opened session ${id} on branch ${branch}`);
}
