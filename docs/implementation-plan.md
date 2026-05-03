# V1 Implementation Plan

Decomposes the remaining work into discrete phases with dependencies, effort estimates, and "done" criteria. Honest about scope — total v1 is ~10–12 weekends of focused work. The point of this document is to make every step legible enough that picking up the project after a two-week break costs nothing.

## What's already done

All v1 phases are complete:

- ✅ Repo scaffold (pnpm workspaces, 5 packages, TS project references, vitest)
- ✅ **Phase 1A** — Coinbase CSV ingestion (1,948 rows → 1,945 RawEvents)
- ✅ **Phase 1B** — Account & config model (`daybook init`, `daybook account add/list`)
- ✅ **Phase 1C** — Ledger repository pattern (idempotent batch insert, filtered queries)
- ✅ **Phase 1D** — EVM adapter (Alchemy provider, Ethereum + Polygon, precision math, dedup)
- ✅ **Phase 1E** — Pricing module (source-reported → CoinGecko → manual override, SQLite cache)
- ✅ **Phase 1F** — Classifier rules (7-rule chain + override system, DEX/bridge catalogs)
- ✅ **Phase 1G** — Tax engine (LotBook, FIFO/HIFO, CSV export, method comparison)
- ✅ **Phase 1H** — CLI plumbing (all commands wired, Ink table rendering for compare)
- Research/decision artifacts (data-model-spec, tax-strategy-config, decisions)

**Test suite:** 205 tests across 15 test files, all passing. Includes unit tests, property-based tests (lot conservation, decimal precision), wash sale logic, Specific ID strategy, Kraken adapter, Etherscan provider, block resolver, and end-to-end integration test.

## v1.1 Enhancements (complete)

All eight v1.1 enhancements have been implemented and verified:

- ✅ **Kraken CSV Adapter** — full adapter with trade pairing, asset normalization, fee handling
- ✅ **Events List Ink Upgrade** — structured table with `--type`, `--source`, `--account` filters
- ✅ **Failed Transaction Gas Tracking** — Etherscan provider for reverted tx gas costs
- ✅ **Classify Dry-Run** — preview mode with diff against current database state
- ✅ **Interactive Unclassified Review** — Ink-based override UI after classification
- ✅ **Incremental Sync** — `--from <date|block>` with block resolver
- ✅ **Specific ID Lot Selection** — interactive picker + JSON replay
- ✅ **Wash Sale Flagging** — ±30 calendar day window, informational only

## Dependency graph

```
                        ┌─ 1B (account model) ──┐
                        │                       │
   Phase 1C (repo) ─────┼──────────────────────┐│
        │               │                      ││
        ↓               ↓                      ↓↓
   Phase 1A      Phase 1D            Phase 1E (pricing)
   (Coinbase)    (EVM/Alchemy)               │
        │               │                    │
        └───────┬───────┴────────────┬───────┘
                ↓                    ↓
          Phase 1F (classifier) ──→ Phase 1G (tax engine)
                                          │
                                          ↓
                                    Phase 1H (CLI plumbing)
```

Critical path: 1C → 1A → 1F → 1G → 1H. 1B/1D/1E can run in parallel after 1C.

## Phase 1A — Coinbase CSV ingestion

**Goal:** Load all 1,948 rows of the user's CSV as `RawEvent`s into the database, with no rows lost or duplicated.

**Tasks:**
1. `packages/sources/src/coinbase/row.ts` — pure function `parseRow(csvRow): RawEvent | null`. Handles all 13 transaction types. Uses Notes parsers.
2. `packages/sources/src/coinbase/csv.ts` — file-level parser. Strips Coinbase's user-info preamble (3 rows), parses column header, calls `parseRow` for each data row. Handles the embedded-quote case in Notes (e.g. bank withdrawal strings with commas).
3. Pair-merger pass: groups `Retail Staking Transfer` and `Retail Eth2 Deprecation` rows by `(timestamp, abs(quantity))` and emits one `internal_move` event per pair.
4. Tests against the real CSV: row counts per type, total event count after pair-merger, zero unparsed rows.

**Done when:**
- All 1,948 rows produce events (with pair-merger reducing the 6 paired rows to 3 events → 1,945 final).
- Frequency table matches the manual count we did earlier.
- `pnpm test` passes against fixture rows (anonymized addresses).

**Effort:** ~1 evening.
**Risk:** low. We've already done all the hard parsing.

## Phase 1B — Account & config model

**Goal:** A `~/.daybook/config.json` schema and corresponding DB rows so the user can declare "I have a Coinbase account, and these wallets on ETH and Polygon" once.

**Tasks:**
1. Define `Config` zod schema (accounts list, default tax config, paths).
2. `packages/cli/src/config.ts` — load + validate, ergonomic error messages.
3. `daybook init` writes a starter config + creates SQLite DB.
4. `daybook account add` / `account list` commands.

**Config shape sketch:**
```json
{
  "accounts": [
    { "id": "main-coinbase", "source": "coinbase", "identifier": "ghfargo@gmail.com", "label": "My Coinbase" },
    { "id": "eth-main", "source": "eth", "identifier": "0x1296Df1A...", "label": "Main ETH" },
    { "id": "polygon-main", "source": "polygon", "identifier": "0x1296Df1A...", "label": "Main Polygon" }
  ],
  "tax": { "costBasisMethod": "FIFO", "lotPool": "universal" },
  "providers": {
    "alchemy": { "apiKeyEnv": "ALCHEMY_API_KEY" },
    "coingecko": { "apiKeyEnv": "COINGECKO_API_KEY" }
  },
  "dbPath": "~/.daybook/data.db"
}
```

**Done when:** `daybook init` creates a working config, `account list` reads it back.
**Effort:** ~1 evening.
**Risk:** low.

## Phase 1C — Ledger repository pattern

**Goal:** Idempotent persistence and retrieval of `RawEvent` and `LedgerEntry` records.

**Tasks:**
1. `packages/ledger/src/repo.ts` — typed methods: `insertRawEvents(events: RawEvent[])`, `getRawEvents(filter)`, `getRawEventById(id)`.
2. Transactional batch insert with `INSERT OR IGNORE` semantics — re-running an adapter against the same data is a no-op.
3. Same for `LedgerEntry` (but the classifier *does* update these on reclassify).
4. `getAccount`, `upsertAccount` for accounts table.

**Done when:** Inserting the same `RawEvent` twice produces no change. Re-running an adapter produces zero net writes.
**Effort:** ~1 evening.
**Risk:** low.

## Phase 1D — EVM adapter (Alchemy primary, behind a provider interface)

**Goal:** Pull all transfers for one or more EVM addresses on Ethereum and Polygon, normalize to `RawEvent`s, persist. Architected so the provider can be swapped (Etherscan, pure RPC) without rewriting the rest.

**Tasks:**
1. `packages/sources/src/evm/provider.ts` — `EvmTransferProvider` interface:
   ```ts
   interface EvmTransferProvider {
     name: string;
     fetchTransfers(opts: { address: string; chainId: number; fromBlock?: bigint }):
       AsyncIterable<RawTransfer>;
     getTokenMetadata(opts: { contractAddress: string; chainId: number }):
       Promise<TokenMetadata | null>;
   }
   ```
   Returns a normalized `RawTransfer` shape, NOT `RawEvent` — the adapter layer above translates.
2. `packages/sources/src/evm/providers/alchemy.ts` — implementation backed by `alchemy.core.getAssetTransfers`:
   - Auto-paginate via `pageKey` until done.
   - Categories: `external`, `internal`, `erc20`, `erc721`, `erc1155`. (Internal only on ETH and Polygon mainnet — both covered for v1.)
   - **Use `rawContract.value` (hex) + `rawContract.decimal` (hex) for precise amounts.** The SDK's `value: number` field loses precision above 2^53.
   - Token metadata via `alchemy.core.getTokenMetadata` for null `asset` cases. Cache.
3. `packages/sources/src/evm/adapter.ts` — chain-agnostic adapter that:
   - Takes a provider + an address + chainId.
   - Streams `RawTransfer`s, maps each to a `RawEvent` with one or two legs:
     - `external`/`internal`/`erc20` → 1 leg with signed amount based on direction
     - `erc721`/`erc1155` → emits `nft_event` placeholder (per decisions)
   - Sets `RawEvent.id = `${source}:${uniqueId}` for idempotency.
   - Stores original payload in `RawEvent.raw` for debugging.
4. CLI integration: `daybook sync --source eth --account <id>`.
5. Failed-tx note: Alchemy returns only *successful* transfers. Failed txs (gas spent, no movement) need a separate Etherscan-style call. Documented as a v1 limitation; user warned in CLI output.

**Provider strategy (per decisions.md):**
- **Default in v1:** Alchemy. Free tier (~25M CU/month) covers ~16k syncs/month. User adds `ALCHEMY_API_KEY` to env.
- **Future:** `etherscan` and `rpc` providers implementing the same interface. v1.1 / v2.

**Done when:**
- `EvmTransferProvider` interface is defined and Alchemy implements it.
- Adapter, given an Alchemy provider, produces ≥120 `RawEvent`s for `0x1296Df1A...` on Ethereum (matches Etherscan tx count).
- Same address on Polygon produces ≥16 events.
- Re-running is idempotent (same events, no duplicates).
- Adding a stub `EtherscanTransferProvider` requires only implementing the interface — no changes to the adapter.

**Effort:** ~2 evenings (interface adds maybe 30–60 minutes vs. Alchemy-hardcoded; pays back forever).
**Risk:** medium. Alchemy's token-metadata coverage on long-tail tokens is uncertain; expect ~5% null `asset` requiring contract-address fallback.

## Phase 1E — Pricing module (NEW package)

**Goal:** A standalone `@daybook/pricing` package implementing the priority chain from `tax-strategy-config.md`.

**Architecture:**
```
@daybook/pricing/
├── src/
│   ├── index.ts                 — public API: `priceAt(asset, timestamp)`
│   ├── provider.ts              — PricingProvider interface
│   ├── providers/
│   │   ├── source-reported.ts   — extract from RawEvent legs
│   │   ├── coingecko.ts         — historical price by date + symbol/contract
│   │   └── manual-override.ts   — read from price_overrides table
│   ├── chain.ts                 — runs providers in priority order
│   └── cache.ts                 — wraps the prices SQLite table
```

**Tasks:**
1. `PricingProvider` interface with `getPrice(asset, timestamp): Promise<PriceResult | null>`.
2. Source-reported provider — passively records prices the source itself reported when adapters insert events. Free, fast, defensible.
3. CoinGecko provider — `GET /coins/{id}/history?date=DD-MM-YYYY` for top assets; `GET /coins/ethereum/contract/{address}/market_chart/range` for ERC-20s. Honest about rate limits (free tier ~30/min).
4. Manual override provider — reads from a new `price_overrides` table.
5. Chain runner — try providers in priority order, cache the winning result.
6. CLI integration: `daybook overrides set ETH 2024-01-15 2305.73`.

**Done when:**
- Calling `priceAt('ETH', date)` for 2023-09-22 returns the source-reported price ($1,594.155 from the user's Receive row).
- Calling for an asset not in source data falls through to CoinGecko successfully.
- Cache hits skip the network call.

**Effort:** ~2 evenings.
**Risk:** medium. CoinGecko coverage of long-tail tokens is the swingy part; punt to manual override.

## Phase 1F — Classifier rules

**Goal:** Turn `RawEvent`s into `LedgerEntry`s using the seven rules from `data-model-spec.md`.

**Pre-work — research (see Knowledge gaps section below):**
- DEX router address catalog (~30 addresses across ETH + Polygon)
- Bridge contract address catalog (~10 across both chains)
- Optional: known CEX hot wallet addresses (Coinbase 10, Coinbase 11, Binance, etc.)

**Tasks:**
1. Rule registry — each rule is a function `(events, context) => { entries, consumedEventIds }`. Run in order.
2. Rule 1: CB pair merger (already in the adapter, but a safety net here for misordered files).
3. Rule 2: Self-transfer from CB Send notes — uses the parsed destination address + user's known wallet list.
4. Rule 3: Cross-source self-transfer matching — fuzzy match on `(direction, |amount| ± 0.5%, timestamp ± 10 min)`.
5. Rule 4: DEX swap collapse — group on-chain events by `txHash`, fold into one trade if `to` matches a known router.
6. Rule 5: Bridge detection — outbound to known bridge contract + matching inbound on destination chain within 24h.
7. Rule 6: Approval gas — produce `fee_disposal` events for `approve()` calls.
8. Rule 7: Default to `unclassified`.
9. Override mechanism: before any rule runs, check for a user override on the events; if present, emit per the override and skip rules.

**Done when:**
- Test fixture: the May 2023 wallet activity (CB Send + on-chain receive) collapses to one `transfer_self` ledger entry.
- A Uniswap router tx with 3 raw events collapses to 1 `trade` entry.
- A `Retail Eth2 Deprecation` pair becomes one `internal_move`.

**Effort:** ~3 evenings + half a day on the address catalogs.
**Risk:** **high.** The hardest part of the project. Plan for iteration — your real data will surface edge cases that aren't in the spec.

## Phase 1G — Tax engine

**Goal:** Compute cost basis, gain/loss, and produce a tax-ready CSV from `LedgerEntry`s.

**Tasks:**
1. `Lot` data structure (`asset`, `amount`, `unitCostUsd`, `acquiredAt`, `sourceEntryId`).
2. `LotBook` — per-asset queue with operations: `acquire(lot)`, `dispose(amount, strategy) → DisposalResult`.
3. `CostBasisStrategy` interface (FIFO, HIFO impls). Trivial to add LIFO/SpecificID later.
4. `computeTax(entries, config) → TaxResult` — iterates entries chronologically, calls `lotBook.acquire` on income/trade-in, `lotBook.dispose` on trade-out/transfer-external-out.
5. CSV exporter: one row per disposal, columns matching what a CPA (or Form 8949) wants — date acquired, date sold, proceeds, basis, gain/loss, term.
6. Income summary: totals by asset, by classifier-determined source.
7. `daybook compare 2024 --vary=method` — runs `computeTax` N times with different methods, formats as a table.

**Done when:**
- Synthetic fixture (2 buys + 1 sell across years) produces correct FIFO and HIFO outputs by hand-calculation.
- Comparison output looks like the table sketched in `tax-strategy-config.md`.

**Effort:** ~3 evenings.
**Risk:** medium. Math has to be right — use BigDecimal (decimal.js) everywhere, never floats.

## Phase 1H — CLI plumbing

**Goal:** All commands actually work end-to-end with appropriate UX per command type.

**Stack — Ink (hybrid pattern):**
- `commander` (or `meow`) handles argv parsing and command dispatch — already in place.
- Each command's handler decides what to render:
  - **One-shot commands** (`init`, `account add/list`) → plain `console.log`. No React tree.
  - **Long-running commands** (`sync`, `classify`) → render an Ink component that shows live progress (categories fetched, events processed, dedup count, etc.).
  - **Tabular output** (`events list`, `compare`, `overrides list`) → Ink components using `ink-table` or hand-rolled `<Box>` layouts.
  - **Interactive flows** (`overrides set` for unpriced tokens) → Ink components using `ink-text-input` and `ink-select-input`.
- `ink-testing-library` for unit-testable components.

**Tasks:**
1. Wire `daybook init` to write config + create DB. *(Plain output. Done.)*
2. Wire `daybook sync` to call adapters based on config, persist via repo. *(Plain output for now; upgrade to Ink progress component in a polish pass.)*
3. `daybook sync --source=coinbase --file=<path>` for CSV import. *(Done.)*
4. `daybook classify` runs the rule chain over the latest events. **Ink component** showing per-rule progress: events processed, ledger entries produced, unclassified count.
5. `daybook export <year> [--method=FIFO|HIFO]` produces CSV. *(Plain output, summary of what was written.)*
6. `daybook compare <year>` produces side-by-side table. **Ink component** with a `<CompareTable>` that renders FIFO/LIFO/HIFO/SpecificID columns and highlights the lowest-tax row.
7. `daybook overrides set/list/remove` for classifier and price overrides. **Ink interactive prompt** for `set` when called without all args; `list` is an Ink table.
8. `daybook events list` and `count` upgraded to Ink for nicer formatting (current versions use plain `console.log`).
9. Add `ink`, `react`, `ink-table` (or build) to the cli package's deps. Configure tsup/esbuild to handle JSX in `.tsx` files.

**Done when:** A new user can `daybook init`, `daybook account add`, `daybook sync`, `daybook compare 2024` and `daybook export 2024` and end up with a CSV — and the long-running commands provide meaningful live feedback rather than freezing the terminal until they finish.

**Effort:** ~2 evenings (interleaved across other phases). The Ink upgrade per command is incremental — start with `compare` (best ROI: tabular output of method comparison is naturally Ink-shaped).
**Risk:** low. Ink is well-trodden; failure modes are mostly TTY edge cases (CI logs, redirect to file).

## Recommended sequencing (as solo evenings)

| Evening | Phase | Output |
|---|---|---|
| 1 | 1A | Coinbase CSV loadable; 1,948 RawEvents in DB |
| 2 | 1C + 1B | Repo pattern, account model, `daybook init` works |
| 3–4 | 1D | EVM adapter — your wallet's history loads |
| 5–6 | 1E | Pricing module + CoinGecko |
| 7 | DEX/bridge research | Catalogs as JSON files |
| 8–10 | 1F | Classifier rules |
| 11–13 | 1G | Tax engine + CSV export |
| 14 | 1H polish | End-to-end CLI works |

Total: ~14 evenings. Realistic over a few months of weekends.

## What NOT to do in v1

Re-stating from `decisions.md` for orientation:

- ❌ Form 8949 / Schedule D / TXF — v2
- ❌ Live sync daemon — v2
- ✅ ~~Kraken adapter — v1.1~~ (complete)
- ❌ Solana, Bitcoin, other chains — v2+
- ❌ NFT cost basis — emit placeholder `nft_event`, don't compute
- ✅ ~~Wash sale rule — flag in API, no-op~~ (v1.1: informational flagging implemented)
- ❌ Web dashboard — v2
- ❌ Multi-user / family / LLC — v2

## Verification approach for each phase

Every phase should ship with:

1. **A real-data fixture test.** Either anonymized snippets of the user's actual CSV/wallet, or property-based tests if synthesis is easier.
2. **An integration test** that runs the phase end-to-end against the SQLite DB.
3. **A README in the package** documenting public exports and gotchas discovered during implementation.

Skip none of the three. The "did we lose 12 transactions silently?" failure mode is exactly what these tests prevent.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Alchemy SDK is archived (Mar 2026) | certain | medium | Use it anyway; it works. Plan a swap to viem-based custom client if the upstream RPC changes break it. |
| CoinGecko free-tier rate limit hit during a big sync | high | low | Cache hard; defer to manual override on miss. |
| Long-tail tokens with no price source | certain | low | Default policy already handles this (`zero` below $1, `prompt` above). |
| Coinbase CSV format changes between exports | possible | medium | Strict regex parsers fail loudly. Easy to patch. |
| User has wallets on chains we don't support | likely | low | Out of scope; surface as "import skipped" with a note. |
| The 7 NFTs in the wallet show up as `nft_event` and clutter output | certain | low | Filter from default exports; user can opt in. |
| Classifier mis-classifies real disposals as transfers | possible | **high** | Real data fixtures + visual sanity check on first export. |
| Tax math has off-by-one errors | possible | **high** | BigDecimal everywhere, exhaustive synthetic fixtures, hand-verify first run. |

---

## EVM adapter gotchas

Things that will surprise future-you if not flagged. Captured during Phase 1D implementation.

1. **`value` is a JS number — precision loss above 2^53.** Always use `rawContract.value` (hex) + `rawContract.decimal` (hex) for amount math. Critical for high-decimal tokens (USDT 6dp, WBTC 8dp) on large transfers, and for any ETH transfer above ~10,000 ETH.
2. **`value: null` is normal for ERC-721.** No amount is sensible — it's 1 NFT. Don't mistake this for an error.
3. **Failed transactions are not returned.** Alchemy's `getAssetTransfers` returns only *successful* transfers. Failed txs (gas spent, no movement) require a separate Etherscan-style `txlist` call. v1 documents this gap and warns the user. v1.x adds an Etherscan supplemental fetch.
4. **Internal transfers only on ETH and Polygon mainnet.** Other chains return empty for `category: 'internal'`. The query is still safe; just don't be surprised to see 0 internal txs on Arbitrum/Base later.
5. **POL vs MATIC.** Polygon's native token migrated from MATIC to POL in 2024. The `asset` field returns whichever name is current at query time. Both should be treated as the same asset for tax purposes — this is a Phase 1F classifier issue, not a 1D issue.
6. **Wrapped ≠ native.** WETH on Polygon is a separate asset from ETH on Ethereum, even though they're meant to represent the same thing. Tax-wise they're separate cost-basis pools. The wrapping/unwrapping itself is technically a swap.
7. **Pagination cursor is opaque.** The `pageKey` UUID is server-side state. Don't persist it across syncs; just paginate to completion within a single sync call.
8. **Rate limits.** Free tier: 300 CU/sec. `getAssetTransfers` is 150 CU. So ~2 calls/sec sustained. Pagination bursts within that limit are fine. If you hit a 429, back off exponentially (alchemy-sdk retries automatically by default).
9. **Bidirectional dedup.** A self-transfer (you sending to yourself) appears in both the `fromAddress` and `toAddress` queries. The adapter dedupes by `providerId`.
10. **The alchemy-sdk-js repo was archived March 2026.** Package still works. If RPC-level changes ever break it, plan B is to swap to viem-based custom calls behind the same interface.
11. **Token metadata can be null forever.** Some scam tokens never call `name()`/`symbol()`. The provider returns null, the adapter falls back to using the contract address as the asset name. Manual override applies.

---

## Knowledge gaps

All P0 gaps have been resolved during v1 implementation. P1 gaps are documented as known limitations.

### Resolved

**G0 — Alchemy `getAssetTransfers` response shape.** Resolved. `uniqueId` is stable (use as `RawEvent.id`). Always use `rawContract.value` hex + `rawContract.decimal` hex for precision. `withMetadata: true` gives `blockTimestamp`. Pagination: 1000/page via `pageKey`. Internal transfers only on ETH + Polygon mainnet.

**Coinbase CSV transaction-type enumeration.** Resolved. 13 distinct types verified against 1,948-row file. Notes-string formats documented and tested in `packages/sources/src/coinbase/notes.ts` with 100% coverage.

**G1 — DEX router address catalog.** Resolved. Curated JSON at `packages/classifier/src/dex-routers.json` covering Uniswap V2/V3, MetaMask Swap Router, QuickSwap (Polygon).

**G2 — Bridge contract address catalog.** Resolved. Curated JSON at `packages/classifier/src/bridges.json` covering Celer cBridge V2, Polygon PoS Bridge.

**G3 — CoinGecko historical price API.** Resolved. Implemented in `packages/tax/src/pricing/providers/coingecko.ts` with exponential backoff on 429s (max 3 retries), contract-address endpoint for ERC-20s.

**G4 — ERC-20 token metadata fallback.** Resolved. Using `alchemy.core.getTokenMetadata()` with in-memory cache keyed by `${chainId}:${contractAddress}`. Null cached on failure; adapter falls back to contract address as asset name.

**G5 — Coinbase Receive note variants.** Resolved during Phase 1A. Parser is permissive with loose capture groups.

### Known limitations (v1)

**G6 — Failed transaction handling.** Resolved in v1.1. Etherscan provider (`packages/sources/src/evm/providers/etherscan.ts`) fetches failed transactions and computes gas costs with decimal.js precision. Activated via `--include-failed-gas` flag.

**G7 — NFT market value resolution.** Deferred to v2. v1 stubs as `nft_event` placeholder.

### Deferred to v2+

- **G8.** Coinbase Advanced Trade API auth + pagination — v2 (live sync).
- **G9.** Alchemy webhooks for live sync — v2 (daemon).
- **G10.** Polygon-specific quirks: POL/MATIC migration handled via asset aliasing. zkEVM vs PoS, bridge-wrapped assets deferred.
- **G11.** Tax law: 1099-DA reconciliation — v2 tax forms.
