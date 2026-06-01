// `wavecrest mcp` — start the MCP server on stdio. Designed to be spawned by
// an MCP host (Claude Code, Codex, etc.) rather than run directly.
import { runMcpStdio } from "../mcp/server.ts";

export async function runMcp(): Promise<void> {
  await runMcpStdio();
}
