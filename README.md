# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** latest release v0.2.0; `main` is preparing v0.3.0 with tax form generation and NFT cost-basis tracking. All packages are implemented, with 464 tests passing locally.

## What it does

Pulls transactions from your Coinbase account, Kraken account, Binance/Binance.US CSV exports, generic CSV exports, and EVM wallets (Ethereum, Polygon), normalizes them into a single ledger, classifies the events (transfers, swaps, income, NFT acquisitions/disposals, internal moves), computes cost basis (FIFO/HIFO/LIFO/Specific ID), tracks NFT lots individually, flags wash-sale candidates, and exports tax-ready output (CSV, Form 8949, Schedule D, TXF).

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Binance CSV, Binance.US CSV, Coinbase CSV, Kraken CSV, generic CSV, EVM (Alchemy + Etherscan)
  classifier/   — transfer matching, swap reconstruction, NFT classification, classification rules
  tax/          — cost-basis (FIFO/HIFO/LIFO/Specific ID), NFT lot tracking, wash sale, gain/loss, pricing, Form 8949/Schedule D PDF, TXF, CSV exporter
  cli/          — daybook commands (sync, classify, export, compare, overrides)
```

Packages depend in one direction: `cli → tax → classifier → ledger`, with `sources → ledger`. No cycles.

## Setup

Install the CLI:

```bash
npm install -g @gfargo/daybook
```

Or run from source:

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

# Add your Binance account
daybook account add main-binance \
  --source binance \
  --identifier you@example.com \
  --label "My Binance"

# Add your Binance.US account
daybook account add main-binance-us \
  --source binance-us \
  --identifier you@example.com \
  --label "My Binance.US"

# Add a generic CSV import bucket
daybook account add csv-imports \
  --source csv \
  --identifier manual-ledger \
  --label "Universal CSV"

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

# Import Binance / Binance.US CSV
daybook sync --source binance --file ~/Downloads/binance-ledger.csv
daybook sync --source binance-us --file ~/Downloads/binance-us-tax.csv

# Import a universal/manual crypto ledger CSV
daybook sync --source csv --file ~/Downloads/universal-ledger.csv

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

### Generic CSV format

There is no single industry-standard crypto ledger CSV, so `--source csv` accepts the common universal/manual ledger shape used by crypto tax tools. Preferred columns are:

```csv
Date,Type,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Description,TxHash
```

Aliases like `Timestamp`, `Label`, `Tag`, `Sent Quantity`, `Received Quantity`, `Buy Amount`, `Sell Amount`, `Transaction ID`, and `Fee` are also accepted. Fiat currencies such as `USD`, `EUR`, and `GBP` are treated as fiat; stablecoins such as `USDC` and `USDT` are treated as crypto assets.

### Binance CSV formats

`--source binance` accepts Binance ledger-style exports with:

```csv
User_ID,UTC_Time,Account,Operation,Coin,Change,Remark
```

Rows sharing a timestamp, account, and remark are grouped into trades when they include both positive and negative trade legs. Fee rows in the same group are attached as fee legs.

`--source binance-us` also accepts tax-report style exports with primary/base/quote/fee asset columns such as:

```csv
Time,Category,Operation,Order_ID,Transaction_ID,Primary_Asset,Realized_Amount_For_Primary_Asset,Quote_Asset,Realized_Amount_For_Quote_Asset,Fee_Asset,Realized_Amount_For_Fee_Asset
```

## CLI Commands

| Command | Description |
| --- | --- |
| `daybook init` | Create config and database |
| `daybook account add/list` | Manage source accounts |
| `daybook sync --source <src>` | Ingest transactions from a source |
| `daybook events count/list` | Inspect raw events (with `--type`, `--source`, `--account` filters) |
| `daybook classify` | Run classifier rules (with `--dry-run`, `--review`) |
| `daybook export <year>` | Export tax-ready CSV (with `--method`, `--lot-selections`, `--no-wash-sale-flag`) |
| `daybook compare <year>` | Compare FIFO, HIFO, and LIFO side by side |
| `daybook overrides set/list/remove` | Manage manual price overrides |

## Roadmap

See [open issues](https://github.com/gfargo/daybook/issues) for planned features and enhancements.

## Changelog

See [GitHub Releases](https://github.com/gfargo/daybook/releases) for version history and release notes.

## Testing

464 tests across 31 test files. Run with:

```bash
pnpm test
```

Coverage includes unit tests per module, property-based tests for lot conservation, decimal precision, NFT classification correctness, NFT lot round-trips, holding period classification, and identifier formatting. Also covers wash sale logic, Specific ID strategy, stablecoin lot accounting, Kraken adapter, Alchemy and Etherscan providers, CoinGecko pricing, block resolver, and an end-to-end integration test (sync → classify → export → verify CSV).
