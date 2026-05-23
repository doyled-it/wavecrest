import { spawn } from "child_process";
import { log } from "../lib/logger.ts";

export interface WaveBridge {
  available(): Promise<boolean>;
  createBlock(opts: { tabName: string; cwd: string; argv: string[]; envExtra: Record<string, string> }): Promise<{ tabId?: string; blockId?: string }>;
  focusBlock(blockId: string): Promise<void>;
}

function run(argv: [string, ...string[]], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    const [cmd, ...args] = argv;
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d; });
    p.on("close", (code: number | null) => resolve({ stdout: out, code: code ?? -1 }));
    p.on("error", () => resolve({ stdout: "", code: -1 }));
  });
}

async function _available(): Promise<boolean> {
  return (await run(["wsh", "--version"])).code === 0;
}

export const wave: WaveBridge = {
  async available() {
    return _available();
  },
  async createBlock({ tabName, cwd, argv, envExtra }) {
    if (!(await _available())) {
      log.warn("wave bridge: wsh not available");
      return {};
    }
    await run(["wsh", "tab", "new", "--name", tabName]);
    const cmd = argv.map(a => JSON.stringify(a)).join(" ");
    await run(["wsh", "createblock", "--view", "term", "--cwd", cwd, "--cmd", cmd], {
      env: { ...process.env, ...envExtra },
    });
    return {}; // TODO: parse `wsh listblock` to get ids
  },
  async focusBlock(blockId: string) {
    await run(["wsh", "block", "focus", blockId]);
  },
};
