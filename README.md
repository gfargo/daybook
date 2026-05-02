# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** scaffolding. v1 not yet shipped.

## What it does (when finished)

Pulls transactions from your Coinbase account and EVM wallets (Ethereum, Polygon), normalizes them into a single ledger, classifies the events (transfers, swaps, income, internal moves), computes cost basis, and exports a tax-ready CSV.

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Coinbase CSV, Coinbase API, EVM (Alchemy)
  classifier/   — transfer matching, swap reconstruction, classification rules
  tax/          — cost-basis (FIFO/HIFO), gain/loss, CSV exporter
  cli/          — `daybook sync`, `daybook export`
```

Packages depend in one direction: `cli → tax → classifier → ledger`, with `sources → ledger`. No cycles.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Quickstart (Coinbase CSV import)

After installing, the first end-to-end flow:

```bash
# 1. Create config + database (~/.daybook/)
daybook init

# 2. Tell daybook about your Coinbase account
daybook account add main-coinbase \
  --source coinbase \
  --identifier you@example.com \
  --label "My Coinbase"

# 3. Import the "All Transactions" CSV from Coinbase
daybook sync --source coinbase --file ~/Downloads/Coinbase\ -\ All\ Transactions.csv

# 4. See what loaded
daybook events count
daybook events list --type trade --limit 10
```

The sync is idempotent — running it twice with the same file is a no-op. You can re-export the CSV and re-sync to pick up new transactions without duplicates.

## Documents

Read in this order to understand what we're building:

1. **`../crypto-audit-research-and-plan.md`** — landscape research, library picks, phased roadmap.
2. **`../data-model-spec.md`** — concrete data model from inspecting real Coinbase + Kraken + on-chain data.
3. **`../implementation-plan.md`** — v1 phase decomposition with effort estimates and risk register.
4. **`../knowledge-gaps.md`** — research questions still outstanding.
5. **`../tax-strategy-config.md`** — configurable tax-treatment dimensions for v2.
6. **`./decisions.md`** — locked-in product decisions (tax scope, sync model, license).

## Scope for v1

- ✅ Coinbase (CSV import)
- ✅ Ethereum mainnet (via Alchemy)
- ✅ Polygon (via Alchemy)
- ✅ Tax-ready CSV output (FIFO + HIFO)
- ❌ Form 8949 / Schedule D PDF generation (v2)
- ❌ Live sync daemon (v2)
- ❌ Kraken (v1.1)
- ❌ NFT cost basis (deferred — emits placeholder events)

See `decisions.md` for full scope and explicit deferrals.

## Status by package

- `ledger/` — ✅ types, SQL migration, repo with idempotent batch insert.
- `sources/` — ✅ Coinbase: full CSV import working end-to-end (1,948 rows → 1,945 RawEvents on real fixture). EVM adapter pending (Phase 1D).
- `classifier/` — stubbed. Rules from `data-model-spec.md` to be implemented (Phase 1F).
- `tax/` — stubbed (Phase 1G).
- `cli/` — ✅ `init`, `account add/list`, `sync`, `events count/list` all working.
