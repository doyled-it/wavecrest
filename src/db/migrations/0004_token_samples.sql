-- Per-message token samples. Powers the per-card sparkline (bucketed by ts)
-- and subagent breakdown (grouped by subagent_type). session_token_rollup
-- stays as the O(1) total — this table is the granular source.
--
-- subagent_type is the value Claude passes in Task tool input.subagent_type
-- (e.g. "general-purpose", "Explore", "Plan"). NULL/"main" means the message
-- came from the top-level conversation (isSidechain=false).
CREATE TABLE IF NOT EXISTS session_token_samples (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  subagent_type TEXT,
  message_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_samples_session_ts ON session_token_samples(session_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_samples_uuid ON session_token_samples(session_id, message_uuid);
