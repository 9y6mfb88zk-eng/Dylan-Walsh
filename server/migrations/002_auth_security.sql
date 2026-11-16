CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'browser',      -- desktop | iphone | browser
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT,
  last_ip TEXT,
  revoked_at TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256 of the bearer/cookie token; raw token never stored
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                  -- sliding idle expiry
  absolute_expires_at TEXT NOT NULL,         -- hard cap regardless of activity
  rotated_at TEXT,                           -- set when replaced by a newer token (grace window)
  revoked_at TEXT
);
CREATE INDEX sessions_device ON sessions(device_id);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  short_code TEXT NOT NULL,
  created_by TEXT REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '{}',
  ip TEXT
);
CREATE INDEX audit_at ON audit_log(at);
