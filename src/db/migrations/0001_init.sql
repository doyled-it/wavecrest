CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT, color TEXT, icon TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_kind TEXT NOT NULL,
  agent_session_id TEXT,
  workspace_id TEXT REFERENCES workspaces(id),
  wave_tab_id TEXT,
  wave_block_id TEXT,
  cwd TEXT NOT NULL,
  repo_root TEXT,
  branch TEXT,
  worktree_path TEXT,
  launch_argv TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  auto_resume INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY,
  agent_kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  used REAL NOT NULL,
  limit_ REAL NOT NULL,
  resets_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_snapshots(ts);

CREATE TABLE IF NOT EXISTS session_token_rollup (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

