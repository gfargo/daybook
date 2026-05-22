# daybook

Self-hosted crypto wallet auditing and tax reporting. Personal tool, MIT licensed.

**Status:** latest release v0.2.0; `main` is preparing v0.3.0 with tax form generation, NFT cost-basis tracking, and Coinbase API sync. All packages are implemented, with 517 tests passing locally.

## What it does

Pulls transactions from your Coinbase account via API or CSV, Kraken account, Binance/Binance.US CSV exports, Crypto.com CSV exports, Gemini CSV exports, Robinhood CSV exports, generic CSV exports, and EVM wallets (Ethereum, Polygon, Base, Arbitrum, Optimism, BNB Chain), normalizes them into a single ledger, classifies the events (transfers, swaps, income, NFT acquisitions/disposals, internal moves), computes cost basis (FIFO/HIFO/LIFO/Specific ID), tracks NFT lots individually, flags wash-sale candidates, and exports tax-ready output (CSV, Form 8949, Schedule D, TXF).

## Architecture

A pnpm-workspace monorepo, four core packages plus a CLI:

```
packages/
  ledger/       — normalized RawEvent + LedgerEntry types, SQLite storage
  sources/      — adapters: Coinbase API/CSV, Binance CSV, Binance.US CSV, Crypto.com CSV, Gemini CSV, Kraken CSV, Robinhood CSV, generic CSV, EVM (Alchemy + Etherscan)
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

# Add your Crypto.com account
daybook account add main-crypto-com \
  --source crypto-com \
  --identifier you@example.com \
  --label "My Crypto.com"

# Add your Gemini account
daybook account add main-gemini \
  --source gemini \
  --identifier you@example.com \
  --label "My Gemini"

# Add your Robinhood account
daybook account add main-robinhood \
  --source robinhood \
  --identifier you@example.com \
  --label "My Robinhood"

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

daybook account add base-main \
  --source base \
  --identifier 0xYourAddress \
  --label "Main Base"
```

### 2. Sync data

```bash
# Sync Coinbase via API (requires Coinbase CDP API key env vars)
export COINBASE_CDP_KEY_NAME="organizations/<org-id>/apiKeys/<key-id>"
export COINBASE_CDP_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
daybook sync --source coinbase
daybook sync --source coinbase --from 2024-01-01

# Or import Coinbase CSV
daybook sync --source coinbase --file ~/Downloads/Coinbase-All-Transactions.csv

# Import Kraken CSV
daybook sync --source kraken --file ~/Downloads/kraken-ledger.csv

# Import Binance / Binance.US CSV
daybook sync --source binance --file ~/Downloads/binance-ledger.csv
daybook sync --source binance-us --file ~/Downloads/binance-us-tax.csv

# Import Crypto.com App / Exchange / DeFi Wallet CSV
daybook sync --source crypto-com --file ~/Downloads/crypto-com-transactions.csv

# Import Gemini CSV converted from Exchange Transaction History XLSX
daybook sync --source gemini --file ~/Downloads/gemini-transactions.csv

# Import Robinhood Crypto CSV
daybook sync --source robinhood --file ~/Downloads/robinhood-crypto.csv

# Import a universal/manual crypto ledger CSV
daybook sync --source csv --file ~/Downloads/universal-ledger.csv

# Sync EVM wallets (requires ALCHEMY_API_KEY env var)
daybook sync --source eth
daybook sync --source polygon
daybook sync --source base
daybook sync --source arbitrum
daybook sync --source optimism
daybook sync --source bnb

# Incremental sync from a specific date or block
daybook sync --source eth --from 2024-01-01
daybook sync --source eth --from 19000000

# Include gas from failed transactions on supported Etherscan-compatible sources
# (requires ETHERSCAN_API_KEY env var)
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

### 4. Reconcile a 1099-DA

Starting with tax year 2025, exchanges issue Form 1099-DA. Compare your computed disposals against the exchange's reported numbers and get a recommended Form 8949 checkbox (A/B/C):

```bash
# Reconcile against an exchange 1099-DA CSV
daybook reconcile 2025 --1099da ~/Downloads/coinbase-1099da.csv

# Tag with an issuer label and write a JSON report
daybook reconcile 2025 --1099da kraken.csv --issuer Kraken --format json --output reconciliation.json

# Loosen the proceeds/basis tolerance (default is $0.01)
daybook reconcile 2025 --1099da coinbase.csv --money-tolerance 1.00
```

The report flags daybook disposals missing from the 1099-DA, 1099-DA rows missing from daybook, and field-level mismatches (proceeds, cost basis, term, acquisition date). It recommends Box A when everything reconciles, Box B when basis is missing or corrections are needed, and Box C when disposals weren't reported on the 1099-DA.

### 5. Manage overrides

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

### Coinbase API sync

`--source coinbase` without `--file` uses Coinbase App Track APIs for accounts and transactions, then enriches Advanced Trade activity with the Advanced Trade fills endpoint. Coinbase CDP keys must use the ECDSA/ES256 key type.

Required environment variables:

```bash
export COINBASE_CDP_KEY_NAME="organizations/<org-id>/apiKeys/<key-id>"
export COINBASE_CDP_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
```

`COINBASE_CDP_KEY_SECRET` is accepted as an alias for `COINBASE_CDP_PRIVATE_KEY`. After a successful API sync, daybook stores a per-account sync watermark and uses it automatically on the next run. Use `--from YYYY-MM-DD` to override the starting point.

CSV import remains available with `--file` and does not use API credentials.

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

### Gemini CSV formats

Gemini currently downloads Exchange Transaction History as XLSX. Convert that sheet to CSV, then import it with `--source gemini`. The adapter accepts simple trade-history columns:

```csv
Date,Type,Symbol,Quantity,Price,Amount,Fee,Fee Currency,Trade ID
```

It also accepts Gemini transaction-history style columns with per-asset amounts and fees, such as:

```csv
Date,Time (UTC),Type,Symbol,Specification,BTC Amount BTC,Fee (BTC) BTC,USD Amount USD,Trade ID,Order ID,Tx Hash
```

Buys, sells, deposits, withdrawals, fees, and reward/credit rows are normalized when the row has enough asset movement data. Ambiguous rows are skipped with warnings.

### Crypto.com CSV formats

`--source crypto-com` accepts Crypto.com App transaction-history exports with columns such as:

```csv
Timestamp (UTC),Transaction Description,Currency,Amount,To Currency,To Amount,Native Currency,Native Amount,Native Amount (in USD),Transaction Kind,Transaction Hash
```

It also accepts Crypto.com Exchange trade exports with:

```csv
Order ID,Trade ID,Time (UTC),Symbol,Side,Trade Price,Trade Amount,Volume of Business,Fee,Fee Currency
```

DeFi Wallet-style exports with sent/received/fee columns are also supported:

```csv
Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Label,Description,TxHash
```

Trades, deposits, withdrawals, card spend, card cashback, rewards, and fees are normalized when enough asset movement data is present. Ambiguous rows are skipped with warnings.

### Robinhood CSV formats

`--source robinhood` accepts Robinhood Crypto transaction-history style exports with columns such as:

```csv
Transaction Date,Transaction Type,Crypto Symbol,Crypto Amount,Crypto Price,Total,Fee,Fee Currency,Transaction ID
```

It also accepts common account-activity aliases such as `Activity Date`, `Trans Code`, `Instrument`, `Quantity`, `Price`, and `Amount`. Buys, sells, transfers, fees, and rewards are normalized when the row has enough asset movement data. Ambiguous rows are skipped with warnings rather than silently imported.

## CLI Commands

| Command | Description |
| --- | --- |
| `daybook init` | Create config and database |
| `daybook account add/list` | Manage source accounts |
| `daybook sync --source <src>` | Ingest transactions from a source |
| `daybook events count/list` | Inspect raw events (with `--type`, `--source`, `--account` filters) |
| `daybook classify` | Run classifier rules (with `--dry-run`, `--review`) |
| `daybook export <year>` | Export tax-ready CSV (with `--method`, `--lot-selections`, `--no-wash-sale-flag`) |
| `daybook reconcile <year> --1099da <file>` | Compare disposals against an exchange 1099-DA and recommend Form 8949 box A/B/C |
| `daybook compare <year>` | Compare FIFO, HIFO, and LIFO side by side |
| `daybook overrides set/list/remove` | Manage manual price overrides |

## Roadmap

See [open issues](https://github.com/gfargo/daybook/issues) for planned features and enhancements.

## Changelog

See [GitHub Releases](https://github.com/gfargo/daybook/releases) for version history and release notes.

## Testing

517 tests across 40 test files. Run with:

```bash
pnpm test
```

Coverage includes unit tests per module, property-based tests for lot conservation, decimal precision, NFT classification correctness, NFT lot round-trips, holding period classification, and identifier formatting. Also covers wash sale logic, Specific ID strategy, stablecoin lot accounting, exchange CSV adapters, Coinbase API auth/client/mapping, sync-state persistence, Alchemy and Etherscan providers, EVM source mappings, CoinGecko pricing, block resolver, and an end-to-end integration test (sync → classify → export → verify CSV).
