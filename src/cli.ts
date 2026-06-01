import { cac } from "cac";
import pkg from "../package.json" with { type: "json" };
import { runDaemon } from "./commands/daemon.ts";
import { runHook } from "./commands/hook.ts";
import { runStatus } from "./commands/status.ts";
import { runOpen } from "./commands/open.ts";
import { runRestore } from "./commands/restore.ts";
import { runInstall } from "./commands/install.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runAuthSet } from "./commands/auth.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runMcp } from "./commands/mcp.ts";

const cli = cac("wavecrest");
cli.command("daemon", "Run the wavecrest daemon in the foreground").action(runDaemon);
cli.command("hook <event>", "Hook entrypoint for Claude Code (reads JSON from stdin)").action(runHook);
cli.command("status", "Print a table of active sessions").action(runStatus);
cli.command("open <branch>", "Open a Wave block with a new agent session")
   .option("--worktree", "Create a git worktree for this branch first")
   .option("--agent <kind>", "claude (default)", { default: "claude" })
   .option("--cwd <path>", "Base directory (default: $PWD)")
   .action(runOpen);
cli.command("restore", "Re-summon Wave blocks for all auto-resume sessions").action(runRestore);
cli.command("auth-set", "Capture WAVETERM_JWT from the current shell and store it for the daemon (run once from a fresh Wave block)")
   .action(runAuthSet);
cli.command("install", "Install hooks, widget, and login agent")
   .option("--bin-path <path>", "Path to the wavecrest binary (defaults to current executable)")
   .action(runInstall);
cli.command("uninstall", "Remove hooks, widget, and login agent")
   .option("--purge", "Also delete ~/.wavecrest state")
   .action(runUninstall);
cli.command("doctor", "Verify wavecrest installation and configuration").action(runDoctor);
cli.command("mcp", "Run the wavecrest MCP server on stdio (spawned by MCP hosts like Claude Code, Codex, etc.)").action(runMcp);
cli.help();
cli.version(pkg.version);
cli.parse();
