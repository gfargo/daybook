-- daybook schema, migration 001_initial
--
-- Design notes:
--   * All decimal amounts are stored as TEXT (decimal.js string form).
--   * All timestamps are unix seconds (INTEGER).
--   * raw_events is append-only — never UPDATE or DELETE rows here.
--   * ledger_entries is fully rebuildable from raw_events; can be DROPped + recomputed.

-- ─── Accounts ──────────────────────────────────────────────────────────
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                  -- user-chosen, e.g. 'main-coinbase'
  source TEXT NOT NULL,                 -- SourceId
  identifier TEXT NOT NULL,             -- exchange account id or wallet address
  label TEXT,                           -- optional display label
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_source ON accounts(source);

-- ─── Raw events (append-only) ──────────────────────────────────────────
CREATE TABLE raw_events (
  id TEXT PRIMARY KEY,                  -- '${source}:${nativeId}'
  source TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,                   -- RawEventType
  tx_hash TEXT,
  log_index INTEGER,
  counterparty TEXT,
  notes TEXT,
  raw_json TEXT NOT NULL                -- full original payload
);

CREATE INDEX idx_raw_events_timestamp ON raw_events(timestamp);
CREATE INDEX idx_raw_events_account ON raw_events(account_id);
CREATE INDEX idx_raw_events_type ON raw_events(type);
CREATE INDEX idx_raw_events_tx_hash ON raw_events(tx_hash) WHERE tx_hash IS NOT NULL;

-- ─── Raw event legs ────────────────────────────────────────────────────
CREATE TABLE raw_event_legs (
  event_id TEXT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE,
  leg_index INTEGER NOT NULL,
  asset TEXT NOT NULL,                  -- 'ETH', 'USDC', or contract address
  amount TEXT NOT NULL,                 -- decimal as string, signed
  amount_usd_at_time TEXT,              -- hydrated by pricing layer, nullable
  amount_usd_reported_by_source TEXT,   -- when source provides it
  fee_flag INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  contract_address TEXT,                -- for ERC-20/721/1155
  token_id TEXT,                        -- for NFTs
  PRIMARY KEY (event_id, leg_index)
);

CREATE INDEX idx_legs_asset ON raw_event_legs(asset);

-- ─── Ledger entries (classifier output, rebuildable) ──────────────────
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,                   -- LedgerEntryType
  reason TEXT,                          -- classifier explanation
  override_id TEXT REFERENCES classifier_overrides(id)
);

CREATE INDEX idx_ledger_entries_timestamp ON ledger_entries(timestamp);
CREATE INDEX idx_ledger_entries_type ON ledger_entries(type);

-- Many-to-many: a ledger entry is built from N raw events
CREATE TABLE ledger_entry_raw_events (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
  PRIMARY KEY (entry_id, raw_event_id)
);

CREATE INDEX idx_lere_raw_event ON ledger_entry_raw_events(raw_event_id);

-- Legs on ledger entries (may differ from raw_event_legs after classifier work)
CREATE TABLE ledger_entry_legs (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  leg_index INTEGER NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  amount_usd_at_time TEXT,
  amount_usd_reported_by_source TEXT,
  fee_flag INTEGER NOT NULL DEFAULT 0,
  contract_address TEXT,
  token_id TEXT,
  PRIMARY KEY (entry_id, leg_index)
);

CREATE INDEX idx_ledger_legs_asset ON ledger_entry_legs(asset);

-- ─── User overrides (first-class, never lost on re-sync) ──────────────
CREATE TABLE classifier_overrides (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                   -- LedgerEntryType the user says it is
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE classifier_override_raw_events (
  override_id TEXT NOT NULL REFERENCES classifier_overrides(id) ON DELETE CASCADE,
  raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
  PRIMARY KEY (override_id, raw_event_id)
);

-- ─── Price cache ───────────────────────────────────────────────────────
-- Keyed by (asset, day) — daily prices are sufficient for tax purposes,
-- and we cache aggressively to avoid hammering price APIs.
CREATE TABLE prices (
  asset TEXT NOT NULL,                  -- ticker or contract address
  day INTEGER NOT NULL,                 -- unix seconds at 00:00 UTC of the day
  source TEXT NOT NULL,                 -- 'coingecko', 'cryptocompare', 'source-reported', etc
  price_usd TEXT NOT NULL,              -- decimal as string
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (asset, day, source)
);

CREATE INDEX idx_prices_asset_day ON prices(asset, day);
