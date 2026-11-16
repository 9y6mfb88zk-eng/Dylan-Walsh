CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | done
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'fact';  -- preference|goal|project|date|idea|decision|fact|summary
ALTER TABLE memories ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'saved';   -- saved | pending (awaiting permission)
ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'user';
ALTER TABLE memories ADD COLUMN embedding TEXT;
ALTER TABLE memories ADD COLUMN updated_at TEXT;
