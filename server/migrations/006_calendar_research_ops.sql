CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'local',      -- local | google
  external_id TEXT,
  title TEXT NOT NULL,
  start TEXT NOT NULL,                       -- ISO 8601 (UTC) or YYYY-MM-DD for all-day
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  important INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX events_external ON events(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX events_start ON events(start);
CREATE TABLE research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  report TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',       -- running | done | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | confirmed | rejected | expired | failed
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE service_status (
  name TEXT PRIMARY KEY,
  last_run TEXT,
  last_ok TEXT,
  last_error TEXT,
  last_error_at TEXT,
  detail TEXT DEFAULT '{}'
);
