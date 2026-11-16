-- JARVIS Ultimate Upgrade: alarms, notifications, activity, notes, documents, research folders, finance goals/debts,
-- business management, saved locations, automations, focus/goals/habits, smart home, diagnostics.

-- ---------------------------------------------------------------- Alarms
CREATE TABLE alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT 'Alarm',
  time TEXT NOT NULL,                        -- HH:MM, local time in the user's time zone
  repeat TEXT NOT NULL DEFAULT 'once',       -- once | daily | weekdays | weekends | custom
  days TEXT NOT NULL DEFAULT '[]',           -- custom repeat days, 0 = Sunday … 6 = Saturday
  date TEXT,                                 -- one-off alarms: local YYYY-MM-DD
  enabled INTEGER NOT NULL DEFAULT 1,
  sound TEXT NOT NULL DEFAULT 'chime',       -- built-in sound id or custom:<id>
  volume INTEGER NOT NULL DEFAULT 80,        -- 0–100
  gradual INTEGER NOT NULL DEFAULT 1,        -- ramp volume up over 30 s
  snooze_minutes INTEGER NOT NULL DEFAULT 10,
  message TEXT NOT NULL DEFAULT '',          -- spoken after the sound starts
  next_at TEXT,                              -- UTC ISO of the next scheduled ring
  snoozed_until TEXT,                        -- UTC ISO when snoozed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE alarm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_id INTEGER,
  label TEXT,
  scheduled_for TEXT,
  event TEXT NOT NULL,                       -- rang | snoozed | dismissed | missed | test | audio_verified
  device_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX alarm_events_alarm ON alarm_events(alarm_id, at);
CREATE TABLE alarm_sounds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- Notifications & activity
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                        -- alarm | reminder | event | task | automation | project | system | research | idea | focus | habit | briefing | finance
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  dismissed_at TEXT,
  snooze_until TEXT
);
CREATE INDEX notifications_created ON notifications(created_at);
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  device_id TEXT
);
CREATE INDEX activity_at ON activity(at);

-- ---------------------------------------------------------------- Tasks, reminders, calendar
ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';   -- none | daily | weekdays | weekly | monthly
ALTER TABLE reminders ADD COLUMN times_fired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN recurrence TEXT;                          -- JSON {freq: daily|weekly|monthly|yearly, interval, until}

-- ---------------------------------------------------------------- Notes, documents, research
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  file TEXT NOT NULL,                        -- stored under <data>/documents
  text TEXT NOT NULL DEFAULT '',             -- extracted text for text formats
  summary TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'General',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE research ADD COLUMN folder TEXT NOT NULL DEFAULT 'General';
ALTER TABLE research ADD COLUMN kind TEXT NOT NULL DEFAULT 'research'; -- research | compare | document
CREATE TABLE saved_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'General',
  research_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- Finance additions
-- Manual entries ("I just spent £12.50 on food") live in a 'manual' account. When the same spend later arrives
-- from the bank feed, the manual entry is linked to it (matched_id) and no longer counted twice.
ALTER TABLE fin_transactions ADD COLUMN matched_id TEXT;
ALTER TABLE fin_transactions ADD COLUMN note TEXT NOT NULL DEFAULT '';
CREATE TABLE savings_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target INTEGER NOT NULL,                   -- pence
  saved INTEGER NOT NULL DEFAULT 0,          -- pence
  deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  balance INTEGER NOT NULL,                  -- pence owed
  apr REAL NOT NULL DEFAULT 0,
  min_payment INTEGER NOT NULL DEFAULT 0,    -- pence per month
  due_day INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- Business & clients
CREATE TABLE businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'lead',        -- lead | contacted | qualified | proposal | won | lost | active | past
  value INTEGER NOT NULL DEFAULT 0,          -- pence, estimated deal value
  next_follow_up TEXT,
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | sent | accepted | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  business_id INTEGER,
  client_id INTEGER,
  items TEXT NOT NULL DEFAULT '[]',          -- [{description, quantity, unit (pence)}]
  total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | sent | paid | void
  issued TEXT,
  due TEXT,
  paid_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE business_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',         -- call | email | meeting | note
  summary TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- Projects
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal';  -- personal | business | idea | goal | plan
ALTER TABLE projects ADD COLUMN deadline TEXT;

-- ---------------------------------------------------------------- World
CREATE TABLE saved_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  timezone TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- Automations
CREATE TABLE routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule TEXT NOT NULL,                    -- JSON {type: daily|weekdays|weekends|weekly|interval, time, days, everyMinutes}
  actions TEXT NOT NULL DEFAULT '[]',        -- JSON [{type, ...}]
  builtin TEXT,                              -- morning | evening | weekly (seeded defaults)
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual | voice
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',    -- running | ok | error
  output TEXT NOT NULL DEFAULT '',
  error TEXT
);

-- ---------------------------------------------------------------- Focus, goals, habits
CREATE TABLE focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT 'Focus',
  kind TEXT NOT NULL DEFAULT 'work',         -- work | break
  planned_minutes INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  ended_at TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal',     -- short | long | career | financial | learning | personal
  description TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | done
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE goal_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly
  target INTEGER NOT NULL DEFAULT 1,         -- times per day (daily) or per week (weekly)
  reminder_time TEXT,                        -- HH:MM local
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE habit_checks (
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                        -- local YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (habit_id, date)
);

-- ---------------------------------------------------------------- Smart home (Home Assistant)
CREATE TABLE smart_devices (
  entity_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
  allowed INTEGER NOT NULL DEFAULT 0,        -- the user must allow each device before JARVIS may control it
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- Diagnostics
CREATE TABLE diag_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,                      -- ok | warn | error | off
  latency_ms INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX diag_history_at ON diag_history(at);
CREATE TABLE error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX api_calls_at ON api_calls(at);

-- ---------------------------------------------------------------- Briefings (history of generated briefings)
CREATE TABLE briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'morning',      -- morning | afternoon | evening | weekly
  text TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
