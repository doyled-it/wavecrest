-- Track the resulting status on each event so the activity feed can show
-- meaningful state transitions instead of raw hook event kinds. NULL means
-- the event did not change the session's status.
ALTER TABLE events ADD COLUMN status_after TEXT;
