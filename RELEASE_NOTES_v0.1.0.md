# daybook v0.1.0

First public release. A self-hosted CLI for crypto wallet auditing and tax reporting.

Pull transactions from Coinbase, Kraken, and EVM wallets, normalize them into a single ledger, classify events automatically, compute cost basis, and export a tax-ready CSV.

## Data sources

- **Coinbase** — CSV import with automatic pair-merging for internal moves
- **Kraken** — CSV import with trade pairing by refid and asset normalization (XXBT→BTC, XETH→ETH, etc.)
- **Ethereum mainnet** — via Alchemy SDK (external, internal, and ERC-20/721/1155 transfers in one paginated call)
- **Polygon** — via Alchemy SDK (same provider interface as Ethereum)
- **Failed transaction gas** — optional Etherscan provider captures gas spent on reverted EVM transactions (`--include-failed-gas`)

All syncs are idempotent. Re-running with the same data is a no-op.

## Event classification

A 7-rule chain processes raw events into typed ledger entries:

1. Coinbase pair merger — collapses staking transfer / Eth2 deprecation pairs
2. Coinbase self-transfer detection — parses Send notes, matches to user's own addresses
3. Cross-source matching — fuzzy match between exchange withdrawals and on-chain receives (±10 min, ±0.5%)
4. DEX swap collapse — groups transfers by txHash against a curated router catalog (Uniswap V2/V3, MetaMask Swap Router, QuickSwap)
5. Bridge detection — matches outbound bridge transactions to destination-chain receives within a 24h window (Celer cBridge, Polygon PoS Bridge)
6. Approval gas accounting — produces `fee_disposal` entries for token approve() calls
7. Default passthrough — direct mapping for everything else

Manual overrides are first-class and survive re-classification.

## Tax engine

- **Cost-basis methods:** FIFO (default), HIFO, and Specific ID with an interactive terminal lot picker
- **Specific ID replay:** save lot selections to JSON, replay them on future exports (`--lot-selections`)
- **Wash sale flagging:** flags loss disposals where an acquisition of the same asset occurs within ±30 calendar days (informational only, no disallowance computation)
- **Pricing chain:** source-reported price → CoinGecko historical API → manual override, with SQLite caching
- **Asset aliasing:** POL↔MATIC and ETH2↔ETH treated as equivalent for cost-basis purposes
- **CSV export:** one row per disposal with proceeds, cost basis, gain/loss, short/long-term split, holding period, and optional Wash Sale? column
- **Method comparison:** `daybook compare <year>` runs FIFO and HIFO side-by-side so you can pick the better outcome before exporting

## CLI commands

```
daybook init                          Create config + database
daybook account add <id>              Add a source account
daybook account list                  List configured accounts
daybook sync --source <src>           Ingest transactions
daybook events count                  Count events by type
daybook events list                   Browse events (Ink table with filters)
daybook classify                      Run classifier rules
daybook classify --dry-run            Preview classification without writing
daybook classify --review             Interactively review unclassified events
daybook export <year>                 Export tax-ready CSV
daybook compare <year>                Compare FIFO vs HIFO
daybook overrides set <asset> ...     Set a manual price override
daybook overrides list                List all overrides
daybook overrides remove <id>         Remove an override
```

## Incremental sync

EVM sources support `--from <date|block>` for incremental syncing:

```bash
daybook sync --source eth --from 2024-01-01
daybook sync --source eth --from 19000000
```

## Install

```bash
npm install -g daybook
```

Requires Node.js 20+. EVM sync requires `ALCHEMY_API_KEY`. Failed-gas tracking requires `ETHERSCAN_API_KEY`. CoinGecko pricing works without an API key (public rate limits apply).

## What's not in this release

- Form 8949 / Schedule D PDF generation
- NFT cost-basis tracking (events are ingested but classified as placeholders)
- DeFi positions (LP, lending, staking-with-validators) — classified as `unknown`, surfaced for manual override
- Solana, Bitcoin, and other non-EVM chains
- LIFO cost-basis method

## License

MIT
