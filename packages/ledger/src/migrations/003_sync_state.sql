-- Persistent source sync cursors and watermarks.

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cursor TEXT,
  last_synced_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, account_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_state_account ON sync_state(account_id);
