-- Store the human-friendly reset string alongside the epoch resets_at so the
-- UI can show "3:20am PT" without re-parsing tz abbreviations on the client.
ALTER TABLE usage_snapshots ADD COLUMN resets_text TEXT;
