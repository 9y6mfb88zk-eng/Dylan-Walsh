-- Personal intelligence, diagnostics history, command macros and performance indexes.
ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;      -- part of the always-available personal profile
ALTER TABLE memories ADD COLUMN topic TEXT NOT NULL DEFAULT '';         -- optional subject (e.g. "KILL HOUSE")
CREATE INDEX IF NOT EXISTS memories_status_cat ON memories(status, category);
ALTER TABLE routines ADD COLUMN trigger_phrase TEXT NOT NULL DEFAULT ''; -- "start my working session"
CREATE TABLE diagnostic_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  level TEXT NOT NULL,
  overall TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  narration TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX diagnostic_runs_at ON diagnostic_runs(at);
-- Indexes for the queries that run most often (measured in docs/performance.md)
CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks(done, due);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(fired, due_at);
CREATE INDEX IF NOT EXISTS notifications_live ON notifications(dismissed_at, id);
CREATE INDEX IF NOT EXISTS alarm_events_event ON alarm_events(event, at);
CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routine_id, id);
CREATE INDEX IF NOT EXISTS api_calls_provider ON api_calls(provider, at);
CREATE INDEX IF NOT EXISTS activity_kind ON activity(kind, at);
