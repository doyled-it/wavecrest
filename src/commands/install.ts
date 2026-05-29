// src/commands/install.ts
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { claudeInstallInstructions } from "../adapters/claude/hooks.ts";

const HOOK_PREFIX = "wavecrest:";

// ─── Testable helpers (accept explicit paths) ─────────────────────────────────

export function installClaudeHooks(settingsPath: string, binPath: string): void {
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

  const dir = settingsPath.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
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

export function installWaveWidget(widgetsPath: string): void {
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

  const dir = widgetsPath.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });

  writeFileSync(widgetsPath, JSON.stringify(widgets, null, 2) + "\n", "utf8");
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
    binPath = execPath;
  }

  const settingsPath = join(home, ".claude", "settings.json");
  const settingsBackup = join(home, ".claude", "settings.json.wavecrest.bak");
  const widgetsPath = join(home, ".config", "waveterm", "widgets.json");
  const wavecrestHome = process.env.WAVECREST_HOME ?? join(home, ".wavecrest");

  // Step 1: Backup claude settings
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, settingsBackup);
    console.log(`Backed up ${settingsPath} → ${settingsBackup}`);
  }

  // Step 2: Merge hooks
  installClaudeHooks(settingsPath, binPath);
  console.log(`Merged wavecrest hooks into ${settingsPath}`);

  // Step 3: Write Wave widget
  installWaveWidget(widgetsPath);
  console.log(`Wrote wavecrest widget to ${widgetsPath}`);

  // Step 4: Launchd (darwin only)
  if (process.platform === "darwin") {
    const plistPath = join(home, "Library", "LaunchAgents", "com.doyled-it.wavecrest.plist");
    installLaunchd(binPath, plistPath, wavecrestHome);
    console.log(`Installed and loaded LaunchAgent: ${plistPath}`);
  } else {
    console.warn(
      "NOTE: Auto-start via launchd is only supported on macOS in phase 1.\n" +
      "Start the daemon manually with: wavecrest daemon",
    );
  }

  console.log("\nwavecrest install complete.");
}
