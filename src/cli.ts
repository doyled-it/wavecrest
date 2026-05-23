import { cac } from "cac";
import { runDaemon } from "./commands/daemon.ts";

const cli = cac("wavecrest");
cli.command("daemon", "Run the wavecrest daemon in the foreground").action(runDaemon);
cli.help();
cli.version("0.1.0");
cli.parse();
