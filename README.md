# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** v1 feature-complete. All packages implemented, 128 tests passing.

## What it does

Pulls transactions from your Coinbase account and EVM wallets (Ethereum, Polygon), normalizes them into a single ledger, classifies the events (transfers, swaps, income, internal moves), computes cost basis (FIFO/HIFO), and exports a tax-ready CSV.

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Coinbase CSV, EVM (Alchemy)
  classifier/   — transfer matching, swap reconstruction, classification rules
  tax/          — cost-basis (FIFO/HIFO), gain/loss, pricing, CSV exporter
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

# Sync EVM wallets (requires ALCHEMY_API_KEY env var)
daybook sync --source eth
daybook sync --source polygon
```

### 3. Classify and export

```bash
# Run the classifier to produce ledger entries
daybook classify

# Compare FIFO vs HIFO tax outcomes
daybook compare 2024

# Export tax-ready CSV
daybook export 2024 --method FIFO --output ./taxes-2024.csv
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
| `daybook events count/list` | Inspect raw events |
| `daybook classify` | Run classifier rules over raw events |
| `daybook export <year>` | Export tax-ready CSV |
| `daybook compare <year>` | Compare FIFO vs HIFO side by side |
| `daybook overrides set/list/remove` | Manage manual price overrides |

## Documents

1. **`docs/data-model-spec.md`** — concrete data model from inspecting real Coinbase + on-chain data.
2. **`docs/implementation-plan.md`** — v1 phase decomposition with effort estimates and risk register.
3. **`docs/tax-strategy-config.md`** — configurable tax-treatment dimensions for v2.
4. **`decisions.md`** — locked-in product decisions (tax scope, sync model, license).

## Scope for v1

- ✅ Coinbase (CSV import)
- ✅ Ethereum mainnet (via Alchemy)
- ✅ Polygon (via Alchemy)
- ✅ Event classification (7-rule chain + manual overrides)
- ✅ Tax-ready CSV output (FIFO + HIFO)
- ✅ Pricing chain (source-reported → CoinGecko → manual override)
- ✅ Cost basis method comparison
- ❌ Form 8949 / Schedule D PDF generation (v2)
- ❌ Live sync daemon (v2)
- ❌ Kraken (v1.1)
- ❌ NFT cost basis (deferred — emits placeholder events)

See `decisions.md` for full scope and explicit deferrals.

## Status by package

- `ledger/` — ✅ Types, SQL migrations (001 initial + 002 price overrides), repo with idempotent batch insert, ledger entry CRUD, classifier override persistence.
- `sources/` — ✅ Coinbase CSV import (full end-to-end). EVM adapter with Alchemy provider (Ethereum + Polygon), bidirectional queries, precision math, token metadata caching.
- `classifier/` — ✅ 7-rule chain: CB pair merger, self-transfer detection (CB Send notes), cross-source matching (fuzzy ±10min/±0.5%), DEX swap collapse, bridge detection, approval gas accounting, default passthrough. Override system. DEX router + bridge address catalogs.
- `tax/` — ✅ LotBook with FIFO/HIFO strategies, lot splitting, universal pooling. Pricing chain (source-reported → CoinGecko → manual override) with SQLite cache. CSV export with disposal details + summary. Method comparison. POL/MATIC + ETH2/ETH asset aliasing.
- `cli/` — ✅ All commands: init, account, sync, events, classify, export, compare, overrides. Ink table rendering for compare output.

## Testing

128 tests across 10 test files. Run with:

```bash
pnpm test
```

Coverage includes unit tests per module, property-based tests for lot conservation and decimal precision, and an end-to-end integration test (sync → classify → export → verify CSV).
