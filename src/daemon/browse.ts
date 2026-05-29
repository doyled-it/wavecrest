import { readdirSync, statSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";

export interface BrowseEntry {
  name: string;
  isDir: boolean;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export function browseDir(reqPath: string): BrowseResult {
  const path = resolve(reqPath);
  if (!existsSync(path)) throw new Error(`path not found: ${path}`);
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error(`not a directory: ${path}`);

  const items = readdirSync(path, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const item of items) {
    if (item.name.startsWith(".")) continue;             // hide dotfiles by default
    const child = `${path}/${item.name}`;
    const isDir = item.isDirectory();
    if (!isDir) continue;                                 // only directories for the picker
    const isGitRepo = existsSync(`${child}/.git`);
    entries.push({ name: item.name, isDir, isGitRepo });
  }
  entries.sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path === "/" ? null : dirname(path);
  return { path, parent, entries };
}

export function pathBasename(p: string): string {
  return basename(p) || p;
}
