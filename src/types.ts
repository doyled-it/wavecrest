// src/types.ts
// Written as part of Task 3 (SQLite layer) so queries.ts compiles cleanly.
// Task 4 is a no-op on this file — all types it needs are already here.

export type AgentKind = "claude" | "codex" | "gemini" | "custom";

export type SessionStatus =
  | "working" | "awaiting" | "idle" | "finished" | "error" | "crashed" | "stopped";

export interface Session {
  id: string;
  agent_kind: AgentKind;
  agent_session_id: string | null;
  workspace_id: string | null;
  wave_tab_id: string | null;
  wave_block_id: string | null;
  cwd: string;
  repo_root: string | null;
  branch: string | null;
  worktree_path: string | null;
  launch_argv: string[];
  display_name: string | null;
  status: SessionStatus;
  auto_resume: boolean;
  pinned: boolean;
  created_at: number;
  last_active_at: number;
  transcript_path: string | null;
}

export interface Event {
  session_id: string;
  ts: number;
  kind: string;
  payload_json: string | null;
}

export interface TokenRollup {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  updated_at: number;
}

export interface UsageSnapshot {
  id?: number;
  agent_kind: AgentKind;
  ts: number;
  scope: "session" | "weekly" | "model";
  scope_key: string | null;
  used: number;
  limit: number;
  resets_at: number | null;
}

export interface SessionUpdate {
  status?: SessionStatus;
  agent_session_id?: string;
  transcript_path?: string;
  last_active_at?: number;
  cwd?: string;
}

export interface NormalizedMessage {
  role: "user" | "assistant" | "system";
  ts: number;
  text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  model?: string;
}

export interface HookConfig {
  // shape that wavecrest install writes into ~/.claude/settings.json
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string }> }>>;
}
