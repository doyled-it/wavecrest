import { cac } from "cac";
import { runDaemon } from "./commands/daemon.ts";
import { runHook } from "./commands/hook.ts";
import { runStatus } from "./commands/status.ts";

const cli = cac("wavecrest");
cli.command("daemon", "Run the wavecrest daemon in the foreground").action(runDaemon);
cli.command("hook <event>", "Hook entrypoint for Claude Code (reads JSON from stdin)").action(runHook);
cli.command("status", "Print a table of active sessions").action(runStatus);
cli.help();
cli.version("0.1.0");
cli.parse();
