# Contributing to daybook

daybook is a personal tool under MIT license. Issues and pull requests are welcome — here's how to make them most useful.

## Reporting bugs

File issues at https://github.com/gfargo/daybook/issues. Helpful bug reports include:

- The daybook version (`daybook --version`)
- The command you ran and the full output
- For adapter issues: the **header row** of your CSV (with personal data redacted) and one or two **sanitized example rows**
- The expected vs actual behavior

For sample-CSV-dependent issues (like [#35](https://github.com/gfargo/daybook/issues/35) and [#36](https://github.com/gfargo/daybook/issues/36)), please redact any wallet addresses, transaction IDs, and account identifiers before sharing.

## Suggesting features

Open a discussion or issue describing the use case. Crypto tax tooling has many edge cases — a real example of what you're trying to solve makes prioritization much easier than abstract requests.

## Pull requests

Smaller, focused PRs land faster. A useful one usually:

1. **References an existing issue** or starts a discussion first for non-trivial changes
2. **Has tests** — daybook has 655+ passing tests; please don't lower that. Use `pnpm test` to run them, `pnpm vitest run <file>` for a single file.
3. **Passes typecheck and lint** — `pnpm typecheck && pnpm lint`
4. **Keeps commits focused** — one logical change per commit, with a clear message explaining the *why*

### Adding a new exchange adapter

The pattern is well-established. Look at `packages/sources/src/okx/` as a template:

1. Create `packages/sources/src/<exchange>/csv.ts`
2. Use the shared helpers from `packages/sources/src/_shared/csv-helpers.ts` — don't inline `parseAmount`, `parseTimestamp`, etc.
3. Add `csv.test.ts` with at least: happy-path trade, deposit, withdrawal, idempotency, header rejection
4. Wire through `packages/sources/src/index.ts`, `packages/ledger/src/types.ts` (`SourceId`), `packages/cli/src/commands/sync.ts`, `packages/cli/src/config.ts`, `packages/cli/src/commands/account.ts`, README

### Touching the tax engine

Changes to lot tracking, cost-basis methods, or Form 8949 / Schedule D output need extra care — they directly affect users' tax filings. Please:

- Add property-based tests using the existing `fast-check` arbitraries where applicable
- Cite the IRS publication or form instruction backing the change
- Note any behavior change clearly in the PR description

## Development setup

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Node 20+ required.

## Code style

We don't enforce a heavy style guide. A few things:

- Use TypeScript strict mode (already configured)
- Prefer named exports
- Use `Decimal` from `decimal.js` for monetary math, never floating-point
- No comments that describe *what* the code does — only *why* when it's non-obvious

## License

By contributing, you agree your contributions will be MIT-licensed.
