# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** v1.1 feature-complete. All packages implemented, 205 tests passing.

## What it does

Pulls transactions from your Coinbase account, Kraken account, and EVM wallets (Ethereum, Polygon), normalizes them into a single ledger, classifies the events (transfers, swaps, income, internal moves), computes cost basis (FIFO/HIFO/Specific ID), flags wash-sale candidates, and exports a tax-ready CSV.

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Coinbase CSV, Kraken CSV, EVM (Alchemy + Etherscan)
  classifier/   — transfer matching, swap reconstruction, classification rules
  tax/          — cost-basis (FIFO/HIFO/Specific ID), wash sale, gain/loss, pricing, CSV exporter
  cli/          — daybook commands (sync, classify, export, compare, overrides)
```

Packages depend in one direction: `cli → tax → classifier → ledger`, with `sources → ledger`. No cycles.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Quickstart

### 1. Initialize

```bash
# Create config + database (~/.daybook/)
daybook init

# Add your Coinbase account
daybook account add main-coinbase \
  --source coinbase \
  --identifier you@example.com \
  --label "My Coinbase"

# Add your Kraken account
daybook account add main-kraken \
  --source kraken \
  --identifier you@example.com \
  --label "My Kraken"

# Add your EVM wallets
daybook account add eth-main \
  --source eth \
  --identifier 0xYourAddress \
  --label "Main ETH"

daybook account add polygon-main \
  --source polygon \
  --identifier 0xYourAddress \
  --label "Main Polygon"
```

### 2. Sync data

```bash
# Import Coinbase CSV
daybook sync --source coinbase --file ~/Downloads/Coinbase-All-Transactions.csv

# Import Kraken CSV
daybook sync --source kraken --file ~/Downloads/kraken-ledger.csv

# Sync EVM wallets (requires ALCHEMY_API_KEY env var)
daybook sync --source eth
daybook sync --source polygon

# Incremental sync from a specific date or block
daybook sync --source eth --from 2024-01-01
daybook sync --source eth --from 19000000

# Include gas from failed transactions (requires ETHERSCAN_API_KEY env var)
daybook sync --source eth --include-failed-gas
```

### 3. Classify and export

```bash
# Run the classifier to produce ledger entries
daybook classify

# Preview what classify would change without writing
daybook classify --dry-run

# Classify and interactively review unclassified events
daybook classify --review

# Compare FIFO vs HIFO tax outcomes
daybook compare 2024

# Export tax-ready CSV
daybook export 2024 --method FIFO --output ./taxes-2024.csv

# Export with Specific ID lot selection (interactive)
daybook export 2024 --method specific-id

# Replay a saved lot selection
daybook export 2024 --method specific-id --lot-selections ./selections.json

# Export without wash sale column
daybook export 2024 --no-wash-sale-flag
```

### 4. Manage overrides

```bash
# Set a manual price for an unpriced token
daybook overrides set SOMETOKEN 2024-03-15 0.50

# List all price overrides
daybook overrides list

# Remove an override
daybook overrides remove <id>
```

All syncs are idempotent — running them twice with the same data is a no-op.

## CLI Commands

| Command | Description |
| --- | --- |
| `daybook init` | Create config and database |
| `daybook account add/list` | Manage source accounts |
| `daybook sync --source <src>` | Ingest transactions from a source |
| `daybook events count/list` | Inspect raw events (with `--type`, `--source`, `--account` filters) |
| `daybook classify` | Run classifier rules (with `--dry-run`, `--review`) |
| `daybook export <year>` | Export tax-ready CSV (with `--method`, `--lot-selections`, `--no-wash-sale-flag`) |
| `daybook compare <year>` | Compare FIFO vs HIFO side by side |
| `daybook overrides set/list/remove` | Manage manual price overrides |

## Documents

1. **`docs/data-model-spec.md`** — concrete data model from inspecting real Coinbase + on-chain data.
2. **`docs/implementation-plan.md`** — v1 phase decomposition and v1.1 enhancements with effort estimates and risk register.
3. **`docs/tax-strategy-config.md`** — configurable tax-treatment dimensions for v2.
4. **`decisions.md`** — locked-in product decisions (tax scope, sync model, license).

## Scope

### v1 (complete)

- ✅ Coinbase (CSV import)
- ✅ Ethereum mainnet (via Alchemy)
- ✅ Polygon (via Alchemy)
- ✅ Event classification (7-rule chain + manual overrides)
- ✅ Tax-ready CSV output (FIFO + HIFO)
- ✅ Pricing chain (source-reported → CoinGecko → manual override)
- ✅ Cost basis method comparison

### v1.1 (complete)

- ✅ Kraken CSV adapter
- ✅ `daybook events list` Ink table with filtering
- ✅ Failed transaction gas tracking (Etherscan)
- ✅ `daybook classify --dry-run`
- ✅ Interactive unclassified event review (`--review`)
- ✅ Incremental sync (`--from <date|block>`)
- ✅ Specific ID lot selection (interactive + JSON replay)
- ✅ Wash sale flagging

### Deferred

- ❌ Form 8949 / Schedule D PDF generation (v2)
- ❌ Live sync daemon (v2)
- ❌ NFT cost basis (emits placeholder events)
- ❌ Solana, Bitcoin, other non-EVM chains

See `decisions.md` for full scope and explicit deferrals.

## Status by package

- `ledger/` — ✅ Types, SQL migrations (001 initial + 002 price overrides), repo with idempotent batch insert, ledger entry CRUD, classifier override persistence.
- `sources/` — ✅ Coinbase CSV import (full end-to-end). Kraken CSV import with trade pairing, asset normalization, and fee handling. EVM adapter with Alchemy provider (Ethereum + Polygon), bidirectional queries, precision math, token metadata caching. Etherscan provider for failed-tx gas tracking. Block resolver for incremental sync by date or block number.
- `classifier/` — ✅ 7-rule chain: CB pair merger, self-transfer detection (CB Send notes), cross-source matching (fuzzy ±10min/±0.5%), DEX swap collapse, bridge detection, approval gas accounting, default passthrough. Override system. DEX router + bridge address catalogs.
- `tax/` — ✅ LotBook with FIFO/HIFO/Specific ID strategies, lot splitting, universal pooling. Wash sale flagging (±30 calendar days, informational only). Pricing chain (source-reported → CoinGecko → manual override) with SQLite cache. CSV export with disposal details, summary footer, and optional Wash Sale? column. Method comparison. POL/MATIC + ETH2/ETH asset aliasing.
- `cli/` — ✅ All commands: init, account, sync (Coinbase, Kraken, EVM with `--from` and `--include-failed-gas`), events (Ink table with filters), classify (`--dry-run`, `--review`), export (Specific ID with interactive picker and JSON replay, `--no-wash-sale-flag`), compare, overrides. Ink table rendering for events and compare output. Interactive Ink components for unclassified review and lot selection.

## Testing

205 tests across 15 test files. Run with:

```bash
pnpm test
```

Coverage includes unit tests per module, property-based tests for lot conservation and decimal precision, wash sale logic, Specific ID strategy, Kraken adapter, Etherscan provider, block resolver, and an end-to-end integration test (sync → classify → export → verify CSV).
