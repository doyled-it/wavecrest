import { cac } from "cac";
import { runDaemon } from "./commands/daemon.ts";
import { runHook } from "./commands/hook.ts";
import { runStatus } from "./commands/status.ts";
import { runOpen } from "./commands/open.ts";
import { runRestore } from "./commands/restore.ts";
import { runInstall } from "./commands/install.ts";
import { runUninstall } from "./commands/uninstall.ts";

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
cli.command("install", "Install hooks, widget, and login agent")
   .option("--bin-path <path>", "Path to the wavecrest binary (defaults to current executable)")
   .action(runInstall);
cli.command("uninstall", "Remove hooks, widget, and login agent")
   .option("--purge", "Also delete ~/.wavecrest state")
   .action(runUninstall);
cli.help();
cli.version("0.1.0");
cli.parse();
