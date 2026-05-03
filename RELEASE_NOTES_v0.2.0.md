# daybook v0.2.0

Design system implementation, a new cost-basis method, and CLI polish across the board.

## New features

### LIFO cost-basis method

LIFO (Last In, First Out) joins FIFO and HIFO as a supported cost-basis strategy. LIFO disposes the most recently acquired lots first — useful in rising markets where recent purchases carry higher cost basis.

```bash
daybook export 2024 --method LIFO
```

`daybook compare` now shows all three methods side by side:

```
Metric              │       FIFO        HIFO        LIFO
────────────────────┼─────────────────────────────────────
Disposal count      │         47          47          47
Short-term gain     │   $12,400      $4,200      $8,100
Long-term gain      │    $4,760      $4,760      $4,760
Total taxable       │   $17,160      $8,960     $12,860
Income              │    $1,205      $1,205      $1,205
```

### JSON output on all read commands

Every read command now accepts `--format json` for machine-readable output. Data serializes directly to stdout — no colors, no Ink rendering. Decimal values are preserved as strings.

```bash
daybook events list --format json | jq '.[] | select(.type == "trade")'
daybook events count --format json
daybook account list --format json
daybook overrides list --format json
daybook compare 2024 --format json
```

### Usage examples in help text

Every command now includes usage examples in its `--help` output. Help text has been rewritten to follow the design system's voice guidelines: sentence case, active voice, specific option descriptions.

```bash
daybook sync --help
daybook export --help
```

## Design system

This release implements the centralized UI component library specified in `docs/cli-design-system.md`. All CLI output now flows through a shared theme and component set.

### Theme module (`packages/cli/src/ui/theme.ts`)

- 8 semantic color tokens from the ledger-paper palette (ink, paper, rule, note, gain, loss, caution, stamp)
- Spacing scale (0, 1, 2, 4 cells)
- Nerd Font glyph registry with ASCII fallback (controlled by `DAYBOOK_NO_NERDFONT=1`)
- Braille spinner animation frames
- Format helpers: `formatUsd()`, `formatCount()`, `truncateAddress()`, `pluralize()`

### 9 Ink components

| Component | Purpose |
|---|---|
| `<Header>` | Bold + note-color section heading |
| `<Row>` | Label + value pair with shared label width |
| `<Glyph>` | Single icon from the glyph registry |
| `<Spinner>` | Animated braille spinner with label |
| `<Stat>` | Prominent single statistic |
| `<Table>` | Generic table with auto-width and column config |
| `<Section>` | Named group with indented children |
| `<EmptyState>` | Quiet "nothing to show" with hint |
| `<ErrorBlock>` | Structured error with recovery hint |

### Commands migrated to design system

- **CompareTable** — uses `color.paper` for labels, `color.note` for highlighted values, `color.rule` for dividers. Now renders dynamically for any number of methods (not hardcoded to 2).
- **EventsTable** — uses `color.stamp` for source/type labels, `EmptyState` for empty results.
- **UnclassifiedReview** — uses `glyph('chevron')` for cursor, `color.note` for selections, `color.stamp` for source labels.
- **LotPicker** — uses `color.gain`/`color.caution` for holding period, `glyph('check')` for selected lots.
- **overrides list** — migrated from manual `.padEnd()` formatting to the shared `<Table>` component.
- **sync** (Coinbase, Kraken, EVM) — migrated from `console.log` to themed Ink output with `Header`, `Row`, `Section`, status glyphs.
- **classify** (normal + dry-run) — migrated from `console.log` to themed Ink output with type/rule breakdowns and unclassified warnings.

## Non-TTY and degradation

- TTY detection utilities (`isTTY()`, `terminalWidth()`, `isNarrowTerminal()`, `requireInteractive()`) for graceful degradation when piped or in CI.
- chalk auto-handles `NO_COLOR=1` and `TERM=dumb`.
- Glyph registry falls back to ASCII when `DAYBOOK_NO_NERDFONT=1` is set.
- Interactive prompts (classify `--review`, export `--method specific-id`) already guard against non-TTY with clear error messages suggesting the non-interactive alternative.

## Test suite

214 tests across 15 test files (was 205 in v0.1.0). New tests cover LIFO strategy selection, FIFO/HIFO sanity checks, and updated compare integration tests for 3-method output.

## Release tooling

v0.2.0 is the first release using the new `release-it` workflow:

```bash
pnpm release        # interactive version prompt, typecheck, test, build, tag, publish
pnpm release:dry    # preview without side effects
```
