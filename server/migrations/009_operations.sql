-- Mission Control operations (Blackbox, Wayfinder, Sentinel, Orbit, situation reports): one shared record table
-- rather than four separate stores. Each record's operation-specific content lives in `data` (JSON).
CREATE TABLE op_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,                       -- blackbox | wayfinder | sentinel | orbit | report
  kind TEXT NOT NULL,                     -- dossier | trip | expedition | watchlist | satellite | situation_report
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',   -- ready | working | failed | refused
  data TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX op_records_op_kind ON op_records(op, kind, updated_at);
