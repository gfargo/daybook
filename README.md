# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** v0.3.0 — feature-complete. All packages implemented, 437 tests passing.

## What it does

Pulls transactions from your Coinbase account, Kraken account, and EVM wallets (Ethereum, Polygon), normalizes them into a single ledger, classifies the events (transfers, swaps, income, NFT acquisitions/disposals, internal moves), computes cost basis (FIFO/HIFO/LIFO/Specific ID), tracks NFT lots individually, flags wash-sale candidates, and exports tax-ready output (CSV, Form 8949, Schedule D, TXF).

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Coinbase CSV, Kraken CSV, EVM (Alchemy + Etherscan)
  classifier/   — transfer matching, swap reconstruction, NFT classification, classification rules
  tax/          — cost-basis (FIFO/HIFO/LIFO/Specific ID), NFT lot tracking, wash sale, gain/loss, pricing, Form 8949/Schedule D PDF, TXF, CSV exporter
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

# Set a manual price for an NFT (using contractAddress:tokenId format)
daybook overrides set 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523 2024-03-15 50000

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

## Roadmap

See [open issues](https://github.com/gfargo/daybook/issues) for planned features and enhancements.

## Changelog

See [GitHub Releases](https://github.com/gfargo/daybook/releases) for version history and release notes.

## Testing

437 tests across 25 test files. Run with:

```bash
pnpm test
```

Coverage includes unit tests per module, property-based tests for lot conservation, decimal precision, NFT classification correctness, NFT lot round-trips, holding period classification, and identifier formatting. Also covers wash sale logic, Specific ID strategy, Kraken adapter, Etherscan provider, block resolver, and an end-to-end integration test (sync → classify → export → verify CSV).
