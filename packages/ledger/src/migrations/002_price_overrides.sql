-- daybook schema, migration 002_price_overrides
--
-- Adds the price_overrides table for user-entered manual price data.
-- Used by the manual-override pricing provider for long-tail tokens
-- that no API covers.

CREATE TABLE IF NOT EXISTS price_overrides (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  day INTEGER NOT NULL,           -- unix seconds at 00:00 UTC
  price_usd TEXT NOT NULL,        -- decimal as string
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_overrides_asset_day ON price_overrides(asset, day);
