// src/adapters/registry.ts
import type { AgentAdapter } from "./types.ts";
import type { AgentKind } from "../types.ts";
import { claudeAdapter } from "./claude/index.ts";

const adapters = new Map<AgentKind, AgentAdapter>([
  ["claude", claudeAdapter],
]);

export function getAdapter(kind: AgentKind): AgentAdapter {
  const a = adapters.get(kind);
  if (!a) throw new Error(`no adapter for ${kind}`);
  return a;
}

export function allAdapters(): AgentAdapter[] {
  return Array.from(adapters.values());
}
