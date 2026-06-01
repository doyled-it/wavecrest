// Smoke test: spawn `bun run src/cli.ts mcp` as a child, drive the MCP
// stdio transport by hand (newline-delimited JSON-RPC), and assert tool
// listing comes back. We do NOT invoke list_sessions because that hits the
// daemon over HTTP and would fail in CI; this is purely a protocol smoke.
import { expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: any;
  method?: string;
  params?: any;
}

test("`wavecrest mcp` answers initialize and tools/list over stdio", async () => {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src/cli.ts"), "mcp"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const messages: JsonRpc[] = [];
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // stderr-ish noise; ignore
      }
    }
  });

  const send = (msg: JsonRpc) => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  const waitFor = (predicate: (m: JsonRpc) => boolean, timeoutMs = 10000): Promise<JsonRpc> => {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for MCP message")), timeoutMs);
      const tick = () => {
        const found = messages.find(predicate);
        if (found) { clearTimeout(t); resolve(found); return; }
        setTimeout(tick, 25);
      };
      tick();
    });
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "wavecrest-smoke", version: "1" },
      },
    });
    const initResp = await waitFor((m) => m.id === 1);
    expect(initResp.result?.serverInfo?.name).toBe("wavecrest");

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResp = await waitFor((m) => m.id === 2);
    const names = (toolsResp.result?.tools ?? []).map((t: any) => t.name).sort();
    expect(names).toEqual([
      "delete_session",
      "focus_session",
      "get_session",
      "get_usage",
      "index_repo",
      "list_sessions",
      "open_session",
      "pin_session",
      "query_repo",
      "recent_events",
      "rename_session",
    ]);
  } finally {
    child.kill("SIGTERM");
  }
}, 20000);
