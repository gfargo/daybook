# Structure Steering

## Repository Layout

```text
packages/
  ledger/       Core RawEvent/LedgerEntry types, migrations, repository
  sources/      Coinbase, Kraken, Binance, Binance.US, generic CSV, EVM adapters
  classifier/   Rule chain and manual override application
  tax/          Pricing, lot books, cost basis, forms, TXF, CSV export
  cli/          daybook commands and terminal UI
```

Nested repositories are maintained separately:

- `.www/` is the marketing/documentation site repo.
- `.wiki/` is the GitHub wiki repo.

Do not mix commits across those repositories.

## Source Adapter Shape

Each adapter should live under:

```text
packages/sources/src/<source>/
  index.ts
  csv.ts or adapter.ts
  *.test.ts
```

Package exports must be updated in:

- `packages/sources/src/index.ts`
- `packages/sources/package.json`

Implemented account sources must also update:

- `packages/ledger/src/types.ts`
- `packages/cli/src/config.ts`
- `packages/cli/src/commands/account.ts`
- `packages/cli/src/commands/sync.ts`
- `packages/cli/src/index.ts`
- README and wiki docs

## Documentation Surfaces

- `README.md` is the canonical repo overview and quickstart.
- `.wiki/Home.md` summarizes current status and feature highlights.
- `.wiki/Getting-Started.md`, `.wiki/CLI-Reference.md`, `.wiki/Configuration.md`, and `.wiki/Source-Adapters.md` must stay aligned with supported sources.
- `.kiro/steering/` records product, technical, and structure decisions for agent work.
