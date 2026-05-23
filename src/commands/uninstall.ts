// src/commands/uninstall.ts
import { homedir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { removeClaudeHooks, removeWaveWidget, removeLaunchd } from "./install.ts";

interface UninstallOptions {
  purge?: boolean;
}

export async function runUninstall(options: UninstallOptions): Promise<void> {
  const home = homedir();
  const wavecrestHome = process.env.WAVECREST_HOME ?? join(home, ".wavecrest");

  const settingsPath = join(home, ".claude", "settings.json");
  const widgetsPath = join(home, ".config", "waveterm", "widgets.json");

  // Step 1: Remove claude hooks
  removeClaudeHooks(settingsPath);
  console.log(`Removed wavecrest hooks from ${settingsPath}`);

  // Step 2: Remove Wave widget
  removeWaveWidget(widgetsPath);
  console.log(`Removed wavecrest widget from ${widgetsPath}`);

  // Step 3: Unload and remove launchd plist (darwin only)
  if (process.platform === "darwin") {
    const plistPath = join(home, "Library", "LaunchAgents", "com.doyled-it.wavecrest.plist");
    removeLaunchd(plistPath);
    console.log(`Unloaded and removed LaunchAgent: ${plistPath}`);
  }

  // Step 4: Purge state directory if requested
  if (options.purge) {
    rmSync(wavecrestHome, { recursive: true, force: true });
    console.log(`Purged state directory: ${wavecrestHome}`);
  }

  console.log("\nwavecrest uninstall complete.");
}
