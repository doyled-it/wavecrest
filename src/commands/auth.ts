import { execFileSync } from "child_process";
import { callDaemon } from "./hook.ts";

export async function runAuthSet(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("WAVETERM_") && typeof v === "string") env[k] = v;
  }
  if (!env.WAVETERM_JWT) {
    console.error("WAVETERM_JWT is not set in this shell.");
    console.error("Open a fresh Wave terminal block (not inside tmux/screen) and run this again.");
    process.exit(1);
  }

  // Also capture interactive PATH and resolve agent binaries so the daemon can
  // launch them from non-interactive shells (where ~/.zshrc isn't sourced).
  if (process.env.PATH) env.INTERACTIVE_PATH = process.env.PATH;
  for (const bin of ["claude", "codex", "gemini"]) {
    try {
      const out = execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (out) env[`AGENT_PATH_${bin.toUpperCase()}`] = out;
    } catch { /* not installed — fine */ }
  }

  await callDaemon("setAuth", { env });
  const keys = Object.keys(env).sort();
  console.log(`wavecrest: captured ${keys.length} entries`);
  for (const k of keys) {
    const v = env[k]!;
    const preview = k === "WAVETERM_JWT" ? `<${v.length} chars>` : (v.length > 60 ? v.slice(0, 57) + "..." : v);
    console.log(`  ${k} = ${preview}`);
  }
  console.log("New blocks will land in the tab where this command ran.");
}
