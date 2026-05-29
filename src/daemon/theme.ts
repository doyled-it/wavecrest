import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import themesJson from "./termthemes.json" with { type: "text" };

interface TermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  gray?: string;
  cmdtext?: string;
  "display:name"?: string;
}

export interface DashboardPalette {
  name: string;
  themeKey: string;
  bg: string;
  fg: string;
  card: string;
  muted: string;
  ok: string;
  warn: string;
  bad: string;
  accent: string;
}

const FALLBACK: DashboardPalette = {
  name: "Default Dark",
  themeKey: "default-dark",
  bg: "#1a1b26", fg: "#a9b1d6", card: "#24283b", muted: "#565f89",
  ok: "#9ece6a", warn: "#e0af68", bad: "#f7768e", accent: "#7aa2f7",
};

const themes: Record<string, TermTheme> = JSON.parse(themesJson);

/** Mix a hex color with another by ratio (0..1 — how much of `b` to blend in). */
function mixHex(a: string, b: string, ratio: number): string {
  const pa = parseHex(a); const pb = parseHex(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] * (1 - ratio) + pb[0] * ratio);
  const g = Math.round(pa[1] * (1 - ratio) + pb[1] * ratio);
  const bl = Math.round(pa[2] * (1 - ratio) + pb[2] * ratio);
  return "#" + [r, g, bl].map(n => n.toString(16).padStart(2, "0")).join("");
}

function parseHex(h: string): [number, number, number] | null {
  const m = h.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function paletteFromTheme(themeKey: string, theme: TermTheme): DashboardPalette {
  const bg = theme.background || FALLBACK.bg;
  const fg = theme.foreground || theme.cmdtext || theme.white || FALLBACK.fg;
  // Card is bg shifted slightly toward fg for subtle contrast.
  const card = mixHex(bg, fg, 0.08);
  return {
    name: theme["display:name"] ?? themeKey,
    themeKey,
    bg,
    fg,
    card,
    muted: theme.gray || theme.brightBlack || theme.black || FALLBACK.muted,
    ok: theme.brightGreen || theme.green || FALLBACK.ok,
    warn: theme.brightYellow || theme.yellow || FALLBACK.warn,
    bad: theme.brightRed || theme.red || FALLBACK.bad,
    accent: theme.brightBlue || theme.blue || theme.cyan || FALLBACK.accent,
  };
}

/** Read the user's Wave settings to find the active terminal theme name. */
function readSelectedThemeKey(): string {
  const path = join(homedir(), ".config", "waveterm", "settings.json");
  if (!existsSync(path)) return "default-dark";
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const key = json["term:theme"];
    if (typeof key === "string" && key) return key;
  } catch { /* ignore */ }
  return "default-dark";
}

/** Build the current dashboard palette by reading Wave's chosen theme. */
export function getDashboardPalette(): DashboardPalette {
  const key = readSelectedThemeKey();
  const theme = themes[key];
  if (!theme) return FALLBACK;
  return paletteFromTheme(key, theme);
}

/** List all available themes (key + display name). */
export function listThemes(): Array<{ key: string; name: string }> {
  return Object.entries(themes).map(([k, v]) => ({
    key: k,
    name: v["display:name"] ?? k,
  }));
}
