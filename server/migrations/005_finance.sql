CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,                    -- monzo | google | demo
  status TEXT NOT NULL,                      -- pending_approval | active | expired | error | disconnected
  access_token_enc TEXT,                     -- AES-256-GCM, never sent to clients
  refresh_token_enc TEXT,
  expires_at TEXT,
  scope TEXT,
  external_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_sync_at TEXT,
  last_error TEXT
);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  device_id TEXT,
  verifier TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE fin_accounts (
  id TEXT PRIMARY KEY,                       -- provider account id
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                        -- current | savings | credit
  currency TEXT NOT NULL DEFAULT 'GBP',
  balance INTEGER,                           -- minor units (pence). For current accounts: spendable balance excluding pots
  total_balance INTEGER,                     -- including pots, where the provider reports it
  shared INTEGER NOT NULL DEFAULT 1,         -- user chose to share with JARVIS
  closed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE fin_pots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  balance INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE fin_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  amount INTEGER NOT NULL,                   -- minor units, negative = money out
  currency TEXT NOT NULL DEFAULT 'GBP',
  description TEXT DEFAULT '',
  merchant TEXT DEFAULT '',
  provider_category TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',    -- JARVIS category (auto)
  category_override TEXT,                    -- user correction
  internal INTEGER NOT NULL DEFAULT 0,       -- movement between the user's own accounts/pots
  pot_transfer INTEGER NOT NULL DEFAULT 0,   -- deposit to (negative) or withdrawal from (positive) a savings pot
  declined INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX fin_tx_created ON fin_transactions(created);
CREATE TABLE bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,                   -- pence, positive
  kind TEXT NOT NULL DEFAULT 'bill',         -- bill | saving | debt
  frequency TEXT NOT NULL DEFAULT 'monthly', -- monthly | weekly | yearly | once
  day_of_month INTEGER,                      -- monthly / yearly
  month INTEGER,                             -- yearly
  weekday INTEGER,                           -- weekly (0 = Sunday)
  date TEXT,                                 -- once
  certainty TEXT NOT NULL DEFAULT 'estimated', -- estimated | confirmed
  match_text TEXT DEFAULT '',                -- matches a transaction description to mark it paid
  category TEXT NOT NULL DEFAULT 'bills',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE budgets (
  category TEXT PRIMARY KEY,
  amount INTEGER NOT NULL
);
