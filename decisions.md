# Decisions

Locked-in product decisions for daybook v1. Living document — update when something changes, with date + rationale.

Last updated: 2026-05-01

## v1 scope

| Decision | Choice | Rationale |
|---|---|---|
| **Tax output** | Tax-ready CSV first; Form 8949 + Schedule D + TXF in v2 | Hand to CPA initially. Forms generation is significant work that doesn't block having a working tool. |
| **Sync model** | On-demand CLI only (`daybook sync`) | Year-end-tax-prep mental model. Each run is a snapshot. No daemon, no reorg handling, no missed-event paranoia. |
| **Sources in v1** | Coinbase + Ethereum mainnet + Polygon | Smallest set that covers the bulk of activity. |
| **Sources in v1.1** | Kraken (adapter is small lift, validates double-entry handling) | First post-v1 milestone. Data model already supports it. |
| **License** | MIT | Maximum reusability. Easy to relicense later if needed. |

## Defaults (override if these don't fit)

| Default | Rationale |
|---|---|
| **Multi-account from day 1** | Data model has `account` as first-class. v1 ships supporting N wallets + N exchange accounts in config. Free architecturally. |
| **NFTs stubbed for v1** | Classifier produces `nft_event` placeholders, no cost-basis attempt. NFT tax treatment is a research project of its own; doesn't block ingestion or fungible-asset taxes. |
| **Distribution: npm + CLI binary** | `bin` field in package.json. `npm install -g daybook` works. No Docker for v1. |
| **Codename: daybook** | Descriptive placeholder. Trivially renameable later with a workspace-wide find-replace. |
| **EVM provider: Alchemy, behind a provider interface** | Alchemy free tier covers ~16,000 syncs/month — irrelevant for personal use. SDK call collapses external + internal + ERC-20/721/1155 transfers into one paginated call (vs. 4-5 separate Etherscan endpoints). Provider interface from day one means Etherscan / pure-RPC fallbacks can be added later without rewriting Phase 1D. Requires a free Alchemy account + `$ALCHEMY_API_KEY`. |
| **CLI rendering: Ink (hybrid pattern)** | Use Ink (the React-for-terminal library) for output that benefits from structure or live updates: sync progress, `compare` tables, events browser, interactive prompts. Keep a small argv parser (`commander`, possibly swapping to `meow` later) for command dispatch. One-shot commands like `init` and `account add` stay as plain `console.log` — no React tree needed for "wrote a file, here's the path." Pastel (file-based Ink router) is on the table if the hybrid gets unwieldy, but it's heavier upfront. |

## Things explicitly deferred

These are *known* concerns that v1 will not address. Captured here so future-us doesn't re-derive them:

- **Wash-sale rules.** Currently don't apply to crypto under US tax law. Bills have been proposed for years. Ship a flag in the `tax` package output but don't compute disallowances.
- **Like-kind treatment.** Pre-2018 trade-for-trade swaps. Not relevant for current activity.
- **Reorg handling.** v1 is on-demand only; reorgs are a daemon-mode concern.
- **Multi-user / family / LLC accounts.** v1 is single-identity. Multi-account support is *separate accounts under one identity*, not multi-identity.
- **Live cost-basis optimization.** No "you should sell from this lot to minimize tax." Just FIFO and HIFO computation, user picks.
- **DeFi: LPing, lending positions (Aave aTokens, Compound cTokens), staking-with-validators.** v1 detects the events but classifies as `unknown` and surfaces to user for manual override. Proper treatment is v2+.
- **Solana, Bitcoin, other chains.** Out of scope. Architecture supports adding later (new adapter, same `RawEvent` shape).

## Open questions parking lot

Things to decide before relevant work, not blocking now:

1. Pricing source(s) — CoinGecko vs CryptoCompare vs Alchemy vs Coinbase Spot. (See pricing-strategy doc when written.)
2. Cost-basis default — FIFO or HIFO? (FIFO is the IRS default. HIFO usually minimizes tax. The CSV exporter should support both via a flag.)
3. DEX router catalog — do we ship a curated JSON file or detect routers via heuristic + user override?
4. Repo public from day one or private until v1 ships?
