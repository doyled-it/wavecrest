// src/commands/doctor.ts
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { paths } from "../lib/paths.ts";

type Status = "pass" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function sym(status: Status): string {
  if (status === "pass") return `${C.green}✓${C.reset}`;
  if (status === "warn") return `${C.yellow}!${C.reset}`;
  return `${C.red}×${C.reset}`;
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function whichInteractive(bin: string): string | null {
  try {
    // Best-effort: run user's login shell so PATH is closer to interactive.
    const shell = process.env.SHELL || "/bin/sh";
    const out = execSync(`${shell} -lic 'command -v ${bin}' 2>/dev/null`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString().trim();
    return out || null;
  } catch {
    try {
      const out = execSync(`command -v ${bin}`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function daemonPort(): number {
  if (existsSync(paths.port)) {
    const raw = readFileSync(paths.port, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 17321;
}

async function checkDaemonHealth(): Promise<Check> {
  const port = daemonPort();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      return { name: "daemon running", status: "pass", detail: `http://127.0.0.1:${port}/api/health` };
    }
    return {
      name: "daemon running",
      status: "fail",
      detail: `health check returned ${res.status}`,
      fix: "tail ~/.wavecrest/daemon.log and consider `launchctl kickstart -k gui/$UID/com.doyled-it.wavecrest`",
    };
  } catch (e) {
    return {
      name: "daemon running",
      status: "fail",
      detail: `no response on 127.0.0.1:${port}`,
      fix: "run `wavecrest install` to install the LaunchAgent, or `wavecrest daemon` to start in the foreground",
    };
  }
}

export async function runDoctor(): Promise<void> {
  const home = homedir();
  const checks: Check[] = [];

  // 1. Wave installed
  const waveDir = join(home, "Library", "Application Support", "waveterm");
  checks.push(existsSync(waveDir)
    ? { name: "Wave Terminal installed", status: "pass", detail: waveDir }
    : { name: "Wave Terminal installed", status: "fail", detail: `${waveDir} not found`, fix: "install Wave Terminal from https://www.waveterm.dev/" });

  // 2. wsh available
  const wshPath = process.env.WAVECREST_WSH_PATH || join(waveDir, "bin", "wsh");
  if (existsSync(wshPath) && isExecutable(wshPath)) {
    checks.push({ name: "wsh available", status: "pass", detail: wshPath });
  } else if (existsSync(wshPath)) {
    checks.push({ name: "wsh available", status: "warn", detail: `${wshPath} not executable`, fix: `chmod +x ${wshPath}` });
  } else {
    checks.push({ name: "wsh available", status: "fail", detail: `${wshPath} not found`, fix: "reinstall Wave, or set WAVECREST_WSH_PATH to the wsh location" });
  }

  // 3. Claude on PATH (prefer captured wave-env.json, fall back to interactive shell)
  const envPath = join(paths.root, "wave-env.json");
  const env = readJson(envPath);
  const claudeFromEnv = env?.AGENT_PATH_CLAUDE as string | undefined;
  if (claudeFromEnv && existsSync(claudeFromEnv)) {
    checks.push({ name: "claude binary on PATH", status: "pass", detail: `${claudeFromEnv} (from wave-env.json)` });
  } else {
    const claudePath = whichInteractive("claude");
    if (claudePath) {
      checks.push({ name: "claude binary on PATH", status: "pass", detail: claudePath });
    } else {
      checks.push({ name: "claude binary on PATH", status: "fail", detail: "claude not found via interactive shell", fix: "install Claude Code and make sure `which claude` resolves, then rerun `wavecrest auth-set`" });
    }
  }

  // 4. wave-env.json
  if (env && typeof env.WAVETERM_JWT === "string" && env.WAVETERM_JWT.length > 0) {
    checks.push({ name: "wave env captured", status: "pass", detail: envPath });
  } else if (env) {
    checks.push({ name: "wave env captured", status: "warn", detail: "wave-env.json present but WAVETERM_JWT missing", fix: "open a fresh Wave terminal block and run `wavecrest auth-set`" });
  } else {
    checks.push({ name: "wave env captured", status: "warn", detail: `${envPath} not found`, fix: "open a fresh Wave terminal block and run `wavecrest auth-set`" });
  }

  // 5. Daemon health
  checks.push(await checkDaemonHealth());

  // 6. Claude hooks installed
  const settingsPath = join(home, ".claude", "settings.json");
  const settings = readJson(settingsPath);
  if (settings && JSON.stringify(settings.hooks ?? {}).includes("wavecrest:")) {
    checks.push({ name: "Claude hooks installed", status: "pass", detail: settingsPath });
  } else {
    checks.push({ name: "Claude hooks installed", status: "fail", detail: "no wavecrest-tagged hooks in settings.json", fix: "run `wavecrest install`" });
  }

  // 6b. wavecrest MCP server registered
  if (settings && settings.mcpServers && settings.mcpServers.wavecrest) {
    checks.push({ name: "wavecrest MCP server registered", status: "pass", detail: `${settingsPath} (mcpServers.wavecrest)` });
  } else {
    checks.push({ name: "wavecrest MCP server registered", status: "warn", detail: `no wavecrest entry under mcpServers in ${settingsPath}`, fix: "run `wavecrest install` (or add the MCP entry manually for other MCP hosts)" });
  }

  // 7. Wave widget installed
  const widgetsPath = join(home, ".config", "waveterm", "widgets.json");
  const widgets = readJson(widgetsPath);
  if (widgets && widgets.wavecrest) {
    checks.push({ name: "Wave widget registered", status: "pass", detail: widgetsPath });
  } else {
    checks.push({ name: "Wave widget registered", status: "fail", detail: `no wavecrest entry in ${widgetsPath}`, fix: "run `wavecrest install`" });
  }

  // 8. launchd agent loaded
  if (process.platform === "darwin") {
    try {
      const out = execSync("launchctl list", { stdio: ["ignore", "pipe", "ignore"] }).toString();
      if (out.includes("com.doyled-it.wavecrest")) {
        checks.push({ name: "launchd agent loaded", status: "pass", detail: "com.doyled-it.wavecrest" });
      } else {
        checks.push({ name: "launchd agent loaded", status: "fail", detail: "com.doyled-it.wavecrest not loaded", fix: "run `wavecrest install`" });
      }
    } catch {
      checks.push({ name: "launchd agent loaded", status: "warn", detail: "could not query launchctl" });
    }
  }

  // 9. cliclick
  const cliclickPath = whichInteractive("cliclick");
  if (cliclickPath) {
    checks.push({ name: "cliclick installed (optional)", status: "pass", detail: cliclickPath });
    // 10. Accessibility hint
    checks.push({
      name: "cliclick Accessibility grant",
      status: "warn",
      detail: "cannot be detected programmatically",
      fix: `verify in System Settings → Privacy & Security → Accessibility (add ${cliclickPath})`,
    });
  } else {
    checks.push({
      name: "cliclick installed (optional)",
      status: "warn",
      detail: "not installed",
      fix: "brew install cliclick (only required for one-keystroke new-tab; user-keystroke modal works without it)",
    });
  }

  // Print report
  console.log(`${C.bold}wavecrest doctor${C.reset}\n`);
  let fails = 0;
  let warns = 0;
  for (const c of checks) {
    if (c.status === "fail") fails++;
    if (c.status === "warn") warns++;
    console.log(`  ${sym(c.status)} ${C.bold}${c.name}${C.reset}`);
    console.log(`      ${C.dim}${c.detail}${C.reset}`);
    if (c.fix && c.status !== "pass") {
      console.log(`      ${C.cyan}fix:${C.reset} ${c.fix}`);
    }
  }

  console.log();
  if (fails === 0 && warns === 0) {
    console.log(`${C.green}All checks passed.${C.reset}`);
  } else {
    console.log(`${fails} fail, ${warns} warn, ${checks.length - fails - warns} pass`);
  }

  if (fails > 0) process.exit(1);
}
