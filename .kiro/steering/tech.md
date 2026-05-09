# Technical Steering

## Stack

- TypeScript, strict mode, ESM-only.
- Node.js >= 20.
- pnpm workspace.
- tsup for package builds and declaration output.
- Vitest for colocated tests.
- better-sqlite3 for local storage.
- decimal.js for all monetary and asset arithmetic.
- commander and Ink for CLI surfaces.

## Architecture Rules

- `ledger` owns core types, SQLite migrations, and repository APIs.
- `sources` turns external exports/API data into normalized `RawEvent[]` and depends only on `ledger`.
- `classifier` consumes raw events and produces rebuildable `LedgerEntry[]`.
- `tax` consumes ledger entries for pricing, cost basis, forms, TXF, and CSV exports.
- `cli` wires commands to all packages.

Dependency direction stays one-way:

```text
cli -> tax -> classifier -> ledger
        sources -> ledger
```

## Adapter Rules

- Use structured CSV parsers, not manual string splitting.
- Preserve the original row payload in `RawEvent.raw`.
- IDs must be deterministic and stable across re-syncs.
- Re-syncing the same source data must produce inserts=0 after the first run.
- Treat fiat tickers as fiat only when they are actual fiat currencies. Stablecoins remain crypto assets.
- Unknown or incomplete rows should warn and skip or emit `unknown`; they should not be silently coerced into a confident type.

## Validation Baseline

Before publishing a source or tax behavior change, run:

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

Current baseline after Binance/Binance.US support: 464 tests across 31 test files.
