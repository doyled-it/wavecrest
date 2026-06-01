// src/commands/install.ts
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { claudeInstallInstructions } from "../adapters/claude/hooks.ts";

const HOOK_PREFIX = "wavecrest:";

// Homebrew installs the real binary inside a versioned Cellar directory
// (e.g. /opt/homebrew/Cellar/wavecrest/0.3.0/libexec/wavecrest) and exposes
// it via a stable shim at /opt/homebrew/bin/<formula>, which brew repoints
// on every upgrade. If process.execPath looks like the versioned Cellar
// path, prefer the shim — that way managed entries (hooks, MCP server,
// launchd plist) survive `brew upgrade` transparently. Otherwise return
// the path unchanged (dev builds, curl-installer paths, user-provided
// --bin-path).
export function resolveStableBinPath(execPath: string): string {
  const m = execPath.match(/^(.+)\/Cellar\/([^/]+)\/[^/]+\/(?:bin|libexec)\/[^/]+$/);
  if (!m) return execPath;
  const [, prefix, formula] = m;
  const shim = `${prefix}/bin/${formula}`;
  return existsSync(shim) ? shim : execPath;
}

// Write `next` to `path` only if it differs from what's already there. Returns
// true if a write happened. Used so daemon-startup reconciliation doesn't churn
// mtimes when there's nothing to change.
function writeIfChanged(path: string, next: string): boolean {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === next) return false;
    } catch {
      // Fall through to write.
    }
  }
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, next, "utf8");
  return true;
}

// ─── Testable helpers (accept explicit paths) ─────────────────────────────────

export function installClaudeHooks(settingsPath: string, binPath: string): boolean {
  const hooks = claudeInstallInstructions(binPath).hooks;

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }

  const existing: Record<string, any[]> = settings.hooks ?? {};

  for (const [event, blocks] of Object.entries(hooks)) {
    const prev: any[] = existing[event] ?? [];
    // Filter out any block already tagged as wavecrest (idempotency)
    const filtered = prev.filter((b: any) => !JSON.stringify(b).includes(HOOK_PREFIX));
    // Tag the incoming block for future idempotency detection
    const tagged = (blocks as any[]).map((b: any) => ({ ...b, _tag: `${HOOK_PREFIX}${event}` }));
    existing[event] = [...filtered, ...tagged];
  }

  settings.hooks = existing;

  return writeIfChanged(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

export function removeClaudeHooks(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;

  let settings: Record<string, any>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }

  const existing: Record<string, any[]> = settings.hooks ?? {};
  for (const event of Object.keys(existing)) {
    existing[event] = (existing[event] ?? []).filter(
      (b: any) => !JSON.stringify(b).includes(HOOK_PREFIX),
    );
    if (existing[event].length === 0) delete existing[event];
  }

  if (Object.keys(existing).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = existing;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

// ─── MCP server registration in ~/.claude/settings.json ──────────────────────
// Idempotent: keyed by entry name "wavecrest" inside mcpServers. We tag with
// _wavecrest_managed so uninstall can confidently remove only entries we own.

const MCP_KEY = "wavecrest";
const MCP_MANAGED_TAG = "_wavecrest_managed";

export function installMcpServer(settingsPath: string, binPath: string): boolean {
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }

  const mcp: Record<string, any> = settings.mcpServers ?? {};
  mcp[MCP_KEY] = {
    command: binPath,
    args: ["mcp"],
    [MCP_MANAGED_TAG]: true,
  };
  settings.mcpServers = mcp;

  return writeIfChanged(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

export function removeMcpServer(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;
  let settings: Record<string, any>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  const mcp: Record<string, any> = settings.mcpServers ?? {};
  const entry = mcp[MCP_KEY];
  // Only remove if we wrote it (managed tag present) — never blow away a
  // user-customised entry they made themselves.
  if (entry && entry[MCP_MANAGED_TAG]) {
    delete mcp[MCP_KEY];
  }
  if (Object.keys(mcp).length === 0) {
    delete settings.mcpServers;
  } else {
    settings.mcpServers = mcp;
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function installWaveWidget(widgetsPath: string): boolean {
  let widgets: Record<string, any> = {};
  if (existsSync(widgetsPath)) {
    try {
      widgets = JSON.parse(readFileSync(widgetsPath, "utf8"));
    } catch {
      widgets = {};
    }
  }

  widgets["wavecrest"] = {
    icon: "gauge-high",
    label: "wavecrest",
    color: "#7aa2f7",
    description: "wavecrest agent sessions dashboard",
    blockdef: {
      meta: {
        view: "web",
        url: "http://127.0.0.1:17321/ui/",
        pinnedurl: "http://127.0.0.1:17321/ui/",
      },
    },
  };

  return writeIfChanged(widgetsPath, JSON.stringify(widgets, null, 2) + "\n");
}

export function removeWaveWidget(widgetsPath: string): void {
  if (!existsSync(widgetsPath)) return;

  let widgets: Record<string, any>;
  try {
    widgets = JSON.parse(readFileSync(widgetsPath, "utf8"));
  } catch {
    return;
  }

  delete widgets["wavecrest"];
  writeFileSync(widgetsPath, JSON.stringify(widgets, null, 2) + "\n", "utf8");
}

function plistContent(binPath: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.doyled-it.wavecrest</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.log</string>
</dict>
</plist>
`;
}

export function installLaunchd(binPath: string, plistPath: string, logDir: string): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plistPath, plistContent(binPath, logDir), "utf8");

  // Suppress stderr on unload — it errors if not already loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Expected on first install
  }

  execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
}

export function removeLaunchd(plistPath: string): void {
  if (!existsSync(plistPath)) return;
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Not loaded — fine
  }
  execSync(`rm -f "${plistPath}"`);
}

// ─── Daemon-startup reconciliation ───────────────────────────────────────────
// Quietly re-applies the install* helpers for entries we own (hooks, MCP,
// widget) so users who upgraded wavecrest without re-running `wavecrest
// install` still get newly-added managed entries. Each helper is a no-op when
// the merged result already matches the file, so this is cheap on every boot.
// Does NOT touch launchd (we're already running) or back up settings.json
// (we'd litter the directory).

export interface ReconcileResult {
  binPath: string;
  hooksWritten: boolean;
  mcpWritten: boolean;
  widgetWritten: boolean;
}

export function reconcileManagedEntries(): ReconcileResult | null {
  // Don't reconcile when wavecrest is running from `bun run`/`node` rather than
  // the compiled binary — we'd plant the interpreter path into settings.json
  // and break MCP for the next host that reads it.
  const execPath = process.execPath;
  const basename = execPath.split("/").pop() ?? "";
  if (basename === "bun" || basename === "node") return null;
  const binPath = resolveStableBinPath(execPath);

  const home = homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const widgetsPath = join(home, ".config", "waveterm", "widgets.json");

  return {
    binPath,
    hooksWritten: installClaudeHooks(settingsPath, binPath),
    mcpWritten: installMcpServer(settingsPath, binPath),
    widgetWritten: installWaveWidget(widgetsPath),
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

interface InstallOptions {
  binPath?: string;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const home = homedir();

  // Resolve binary path
  let binPath = options.binPath;
  if (!binPath) {
    const execPath = process.execPath;
    const basename = execPath.split("/").pop() ?? "";
    if (basename === "bun" || basename === "node") {
      console.warn(
        "\nWARNING: wavecrest is running via bun/node, not a compiled binary.\n" +
        "Hooks will reference the bun/node interpreter, which may not work correctly.\n" +
        "For a proper install, build the binary first:\n" +
        "  bun run build\n" +
        "Then install using the compiled binary:\n" +
        "  ./dist/wavecrest install\n",
      );
    }
    binPath = resolveStableBinPath(execPath);
  }

  const settingsPath = join(home, ".claude", "settings.json");
  const settingsBackup = join(home, ".claude", "settings.json.wavecrest.bak");
  const widgetsPath = join(home, ".config", "waveterm", "widgets.json");
  const wavecrestHome = process.env.WAVECREST_HOME ?? join(home, ".wavecrest");

  // ANSI symbols (no emojis)
  const C = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", cyan: "\x1b[36m", dim: "\x1b[2m" };
  const ok = `${C.green}✓${C.reset}`;
  const info = `${C.cyan}!${C.reset}`;
  const backedUp: string[] = [];
  const written: string[] = [];

  // Step 1: Backup claude settings
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, settingsBackup);
    backedUp.push(settingsBackup);
  }

  // Step 2: Merge hooks
  installClaudeHooks(settingsPath, binPath);
  written.push(`${ok} Claude hooks installed at ${settingsPath}` +
    (backedUp.length ? ` ${C.dim}(existing backup at ${settingsBackup})${C.reset}` : ""));

  // Step 3: Write Wave widget
  installWaveWidget(widgetsPath);
  written.push(`${ok} Wave widget registered at ${widgetsPath}`);

  // Step 3b: Register MCP server for Claude Code (and any other MCP host that
  // reads ~/.claude/settings.json). External hosts (Codex, etc.) need manual
  // config — see README.
  installMcpServer(settingsPath, binPath);
  written.push(`${ok} MCP server registered in ${settingsPath} (mcpServers.wavecrest)`);

  // Step 4: Launchd (darwin only)
  if (process.platform === "darwin") {
    const plistPath = join(home, "Library", "LaunchAgents", "com.doyled-it.wavecrest.plist");
    installLaunchd(binPath, plistPath, wavecrestHome);
    written.push(`${ok} launchd agent installed at ${plistPath}`);
  } else {
    written.push(`${info} Auto-start via launchd is only supported on macOS in phase 1.\n     Start the daemon manually with: wavecrest daemon`);
  }

  console.log();
  for (const line of written) console.log(line);
  console.log(`
${C.bold}Next steps:${C.reset}
  1. Restart Wave Terminal so it picks up the new widget
  2. In a ${C.bold}FRESH${C.reset} Wave terminal block (not inside tmux/screen), run:
       wavecrest auth-set
  3. Drag the wavecrest widget into a block to see your dashboard
  4. Claude Code (and any MCP host reading ~/.claude/settings.json) can now
     introspect and act on wavecrest via its MCP server.
     Disable by removing the "wavecrest" entry under mcpServers, or run
     ${C.cyan}wavecrest uninstall${C.reset}.

${C.bold}For optional features${C.reset} (one-click new-tab creation):
  brew install cliclick
  System Settings → Privacy & Security → Accessibility → add /opt/homebrew/bin/cliclick

Run ${C.cyan}wavecrest doctor${C.reset} anytime to verify your setup.`);
}
