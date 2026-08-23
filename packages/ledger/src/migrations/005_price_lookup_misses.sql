-- Track genuine "no data" misses from pricing providers.
--
-- A miss is recorded when all cacheable providers return null (no data
-- available) for a given (asset, day) pair. This lets subsequent runs
-- skip re-querying providers until the TTL expires, without masking
-- transient/unrecoverable failures (which are NOT recorded here).
--
-- Keyed the same way as the `prices` positive cache so the two tables
-- stay in sync.

CREATE TABLE IF NOT EXISTS price_lookup_misses (
  asset       TEXT    NOT NULL,   -- canonical ticker/asset (same convention as prices.asset)
  day         INTEGER NOT NULL,   -- unix seconds at 00:00 UTC (dayUtc)
  source      TEXT    NOT NULL,   -- provider name that reported "no data", or 'chain' for all-null
  checked_at  INTEGER NOT NULL,   -- unix seconds when the miss was recorded
  PRIMARY KEY (asset, day, source)
);

CREATE INDEX IF NOT EXISTS idx_price_misses_asset_day
  ON price_lookup_misses(asset, day);
