-- Add account_id to ledger_entry_legs for per-account lot pooling.
-- Existing rows get NULL; re-running `daybook classify` backfills them.
ALTER TABLE ledger_entry_legs ADD COLUMN account_id TEXT;
