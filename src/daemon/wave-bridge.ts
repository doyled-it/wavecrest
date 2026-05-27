import { spawn, execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { paths } from "../lib/paths.ts";
import { log } from "../lib/logger.ts";

function resolveWshPath(): string {
  if (process.env.WAVECREST_WSH_PATH) return process.env.WAVECREST_WSH_PATH;
  const candidates = [
    join(homedir(), "Library", "Application Support", "waveterm", "bin", "wsh"),
    "/usr/local/bin/wsh",
    "/opt/homebrew/bin/wsh",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "wsh"; // fall back to PATH lookup
}

const WSH = resolveWshPath();

export interface CreateSessionTabOpts {
  displayName: string;
  cwd: string;
  argv: string[];
  envExtra: Record<string, string>;
  includeDashboard: boolean;
}

export interface CreateSessionTabResult {
  ok: boolean;
  error?: string;
  tabId?: string;
  terminalBlockId?: string;
  dashboardBlockId?: string;
}

export interface WaveBridge {
  available(): Promise<boolean>;
  hasJwt(): boolean;
  capturedKeys(): string[];
  setWaveEnv(env: Record<string, string>): void;
  createBlock(opts: { cwd: string; argv: string[]; envExtra: Record<string, string>; targetTabId?: string }): Promise<{ ok: boolean; error?: string }>;
  focusBlock(blockId: string): Promise<{ ok: boolean; error?: string }>;
  createTab(): Promise<{ ok: boolean; error?: string; tabId?: string }>;
  renameTab(tabId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  launchWidget(widgetName: string, targetTabId: string): Promise<{ ok: boolean; error?: string }>;
  createSessionTab(opts: CreateSessionTabOpts): Promise<CreateSessionTabResult>;
}

const WAVE_ENV_PATH = join(paths.root, "wave-env.json");
const LEGACY_JWT_PATH = join(paths.root, "wave-jwt");

let cachedEnv: Record<string, string> = readWaveEnv();

function readWaveEnv(): Record<string, string> {
  // Prefer the new JSON env file.
  if (existsSync(WAVE_ENV_PATH)) {
    try { return JSON.parse(readFileSync(WAVE_ENV_PATH, "utf8")); }
    catch { return {}; }
  }
  // Back-compat: legacy file held JWT only.
  if (existsSync(LEGACY_JWT_PATH)) {
    try {
      const jwt = readFileSync(LEGACY_JWT_PATH, "utf8").trim();
      if (jwt) return { WAVETERM_JWT: jwt };
    } catch { /* ignore */ }
  }
  return {};
}

function writeWaveEnv(env: Record<string, string>): void {
  mkdirSync(dirname(WAVE_ENV_PATH), { recursive: true });
  writeFileSync(WAVE_ENV_PATH, JSON.stringify(env, null, 2));
  chmodSync(WAVE_ENV_PATH, 0o600);
}

function envWithWave(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...cachedEnv, ...extra };
}

function run(
  argv: [string, ...string[]],
  opts: { cwd?: string; envExtra?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    const [cmd, ...args] = argv;
    const p = spawn(cmd, args, {
      cwd: opts.cwd,
      env: envWithWave(opts.envExtra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d; });
    p.stderr.on("data", (d: Buffer) => { stderr += d; });
    p.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? -1 }));
    p.on("error", e => resolve({ stdout: "", stderr: String(e), code: -1 }));
  });
}

function runOsascript(statements: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  // Each statement is passed as a separate -e flag to osascript.
  const args: string[] = [];
  for (const s of statements) { args.push("-e", s); }
  return new Promise(resolve => {
    execFile("osascript", args, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? -1) : 0,
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fetch the set of tabids currently present in the workspace via wsh blocks list. */
async function getCurrentTabIds(workspaceId: string): Promise<Set<string>> {
  const r = await run([WSH, "blocks", "list", "--workspace", workspaceId, "--json"]);
  if (r.code !== 0) return new Set();
  try {
    const blocks = JSON.parse(r.stdout) as Array<{ tabid?: string }>;
    const ids = new Set<string>();
    for (const b of blocks) if (b.tabid) ids.add(b.tabid);
    return ids;
  } catch {
    return new Set();
  }
}

async function _available(): Promise<boolean> {
  return (await run([WSH, "version"])).code === 0;
}

export const wave: WaveBridge = {
  async available() {
    return _available();
  },

  hasJwt() {
    return typeof cachedEnv.WAVETERM_JWT === "string" && cachedEnv.WAVETERM_JWT.length > 0;
  },

  capturedKeys() {
    return Object.keys(cachedEnv).sort();
  },

  setWaveEnv(env: Record<string, string>) {
    cachedEnv = { ...env };
    writeWaveEnv(cachedEnv);
    log.info("wave bridge: env captured", { keys: Object.keys(cachedEnv) });
  },

  async createBlock({ cwd, argv, envExtra, targetTabId }) {
    if (!(await _available())) {
      return { ok: false, error: "wsh not available" };
    }
    if (!cachedEnv.WAVETERM_JWT) {
      return { ok: false, error: "no WAVETERM_JWT stored — run `wavecrest auth-set` in a fresh Wave block" };
    }

    // Resolve argv[0] to an absolute path using auth-set's captured map, so it works
    // in non-interactive shells where ~/.zshrc isn't sourced.
    const resolved = [...argv];
    if (resolved[0]) {
      const upper = resolved[0].toUpperCase();
      const abs = cachedEnv[`AGENT_PATH_${upper}`];
      if (abs) resolved[0] = abs;
    }
    const quoted = resolved.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");

    // Prepend INTERACTIVE_PATH so additional commands (claude subprocess tools, etc.)
    // can find their dependencies.
    const pathPrefix = cachedEnv.INTERACTIVE_PATH
      ? `export PATH=${`'${cachedEnv.INTERACTIVE_PATH.replace(/'/g, "'\\''")}'`}:"$PATH"; `
      : "";
    const cmd = `${pathPrefix}${quoted}`;

    // If a targetTabId is provided, override WAVETERM_TABID so wsh targets that tab.
    const tabEnv = targetTabId ? { WAVETERM_TABID: targetTabId } : {};
    const r = await run([WSH, "run", "--cwd", cwd, "-c", cmd], { envExtra: { ...envExtra, ...tabEnv } });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "wsh run failed").trim().split("\n")[0];
      log.warn("wave bridge: createBlock failed", { code: r.code, msg });
      return { ok: false, error: msg };
    }
    return { ok: true };
  },

  async focusBlock(blockId: string) {
    if (!(await _available())) return { ok: false, error: "wsh not available" };
    if (!cachedEnv.WAVETERM_JWT) return { ok: false, error: "no WAVETERM_JWT stored — run `wavecrest auth-set`" };
    const r = await run([WSH, "focusblock", "-b", blockId]);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "wsh focusblock failed").trim().split("\n")[0];
      return { ok: false, error: msg };
    }
    return { ok: true };
  },

  async createTab() {
    if (!(await _available())) return { ok: false, error: "wsh not available" };
    if (!cachedEnv.WAVETERM_JWT) return { ok: false, error: "no WAVETERM_JWT stored — run `wavecrest auth-set`" };

    const workspaceId = cachedEnv.WAVETERM_WORKSPACEID;
    if (!workspaceId) return { ok: false, error: "no WAVETERM_WORKSPACEID stored — run `wavecrest auth-set`" };

    // 1. Snapshot existing tabids.
    const beforeTabIds = await getCurrentTabIds(workspaceId);

    // 2. Trigger Cmd+T in Wave via AppleScript.
    //    NOTE: the calling process (wavecrest daemon) must have Accessibility permission
    //    in System Settings → Privacy & Security → Accessibility for this to work.
    const osResult = await runOsascript([
      'tell application "Wave" to activate',
      'delay 0.3',
      'tell application "System Events" to keystroke "t" using {command down}',
    ]);
    if (osResult.code !== 0) {
      const msg = (osResult.stderr || osResult.stdout || "osascript failed").trim();
      // -1743 is the macOS "not authorized for assistive access" error code.
      if (msg.includes("-1743") || msg.includes("not authorized") || msg.includes("assistive")) {
        return {
          ok: false,
          error:
            "wavecrest daemon needs Accessibility permission to create tabs. " +
            "Open System Settings → Privacy & Security → Accessibility, click +, " +
            "and add the wavecrest binary. Then try again.",
        };
      }
      log.warn("wave bridge: createTab osascript failed", { code: osResult.code, msg });
      return { ok: false, error: `osascript failed: ${msg}` };
    }

    // 3. Poll for a new tabid to appear (Wave creates a default block in the new tab
    //    automatically, so it will show up in blocks list). Poll for up to ~3 seconds.
    const pollIntervalMs = 200;
    const maxAttempts = 15;
    let newTabId: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollIntervalMs);
      const afterTabIds = await getCurrentTabIds(workspaceId);
      for (const id of afterTabIds) {
        if (!beforeTabIds.has(id)) {
          newTabId = id;
          break;
        }
      }
      if (newTabId) break;
    }

    if (!newTabId) {
      log.warn("wave bridge: createTab: no new tabid detected after Cmd+T");
      return { ok: false, error: "new tab was not detected — Wave may not have opened a new tab, or the tab has no blocks yet" };
    }

    log.info("wave bridge: createTab: new tab detected", { tabId: newTabId });
    return { ok: true, tabId: newTabId };
  },

  async renameTab(tabId: string, name: string) {
    if (!(await _available())) return { ok: false, error: "wsh not available" };
    if (!cachedEnv.WAVETERM_JWT) return { ok: false, error: "no WAVETERM_JWT stored" };
    const r = await run([WSH, "setmeta", "-b", `tab:${tabId}`, `name=${name}`]);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "wsh setmeta failed").trim().split("\n")[0];
      log.warn("wave bridge: renameTab failed", { code: r.code, msg, tabId, name });
      return { ok: false, error: msg };
    }
    return { ok: true };
  },

  async launchWidget(widgetName: string, targetTabId: string) {
    if (!(await _available())) return { ok: false, error: "wsh not available" };
    if (!cachedEnv.WAVETERM_JWT) return { ok: false, error: "no WAVETERM_JWT stored" };
    const r = await run([WSH, "launch", widgetName], { envExtra: { WAVETERM_TABID: targetTabId } });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "wsh launch failed").trim().split("\n")[0];
      log.warn("wave bridge: launchWidget failed", { code: r.code, msg, widgetName, targetTabId });
      return { ok: false, error: msg };
    }
    return { ok: true };
  },

  async createSessionTab({ displayName, cwd, argv, envExtra, includeDashboard }) {
    // 1. Create a new tab via Cmd+T and detect its id.
    const tabResult = await wave.createTab();
    if (!tabResult.ok || !tabResult.tabId) {
      return { ok: false, error: tabResult.error ?? "failed to create tab" };
    }
    const tabId = tabResult.tabId;

    // 2. Rename the tab.
    const renameResult = await wave.renameTab(tabId, displayName);
    if (!renameResult.ok) {
      // Non-fatal: log and continue.
      log.warn("wave bridge: createSessionTab: renameTab failed", { error: renameResult.error });
    }

    // 3. Optionally launch the dashboard widget in the new tab.
    let dashboardBlockId: string | undefined;
    if (includeDashboard) {
      const widgetResult = await wave.launchWidget("wavecrest", tabId);
      if (!widgetResult.ok) {
        log.warn("wave bridge: createSessionTab: launchWidget failed", { error: widgetResult.error });
        // Non-fatal: proceed with terminal block.
      } else {
        dashboardBlockId = undefined; // wsh launch doesn't return block id
      }
    }

    // 4. Launch the terminal block (claude) in the new tab.
    const blockResult = await wave.createBlock({ cwd, argv, envExtra, targetTabId: tabId });
    if (!blockResult.ok) {
      return { ok: false, error: blockResult.error ?? "terminal block creation failed", tabId };
    }

    return { ok: true, tabId, dashboardBlockId };
  },
};

export function reloadWaveEnvFromDisk(): void {
  cachedEnv = readWaveEnv();
}
