CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Conversation',
  summary TEXT DEFAULT '',
  summarized_until INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE messages ADD COLUMN conversation_id TEXT;
ALTER TABLE messages ADD COLUMN device_id TEXT;
ALTER TABLE messages ADD COLUMN client_id TEXT;
ALTER TABLE messages ADD COLUMN sources TEXT;
CREATE UNIQUE INDEX messages_client ON messages(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX messages_conv ON messages(conversation_id, id);

ALTER TABLE tasks ADD COLUMN client_id TEXT;
ALTER TABLE tasks ADD COLUMN project_id INTEGER;
ALTER TABLE tasks ADD COLUMN milestone_id INTEGER;
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 2;   -- 1 high, 2 normal, 3 low
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX tasks_client ON tasks(client_id) WHERE client_id IS NOT NULL;

ALTER TABLE reminders ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX reminders_client ON reminders(client_id) WHERE client_id IS NOT NULL;

ALTER TABLE push_subs ADD COLUMN device_id TEXT;
