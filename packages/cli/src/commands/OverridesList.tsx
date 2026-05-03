/**
 * Ink-based overrides list for `daybook overrides list`.
 *
 * Renders price overrides using the shared Table component.
 */

import { render, Box } from 'ink';
import type { PriceOverride } from '@daybook/ledger';
import { Table, EmptyState, Header, formatCount, type TableColumn } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface OverrideRow {
  id: string;
  asset: string;
  date: string;
  priceUsd: string;
  note: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Format unix seconds at 00:00 UTC back to a YYYY-MM-DD string. */
function formatDay(day: number): string {
  const d = new Date(day * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Format an ISO timestamp for display. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

// ─────────────────────────────────────────────────────────────────────────
// Columns
// ─────────────────────────────────────────────────────────────────────────

const columns: TableColumn<OverrideRow>[] = [
  { key: 'id', header: 'ID' },
  { key: 'asset', header: 'Asset' },
  { key: 'date', header: 'Date' },
  { key: 'priceUsd', header: 'Price (USD)', align: 'right' },
  { key: 'note', header: 'Note' },
  { key: 'createdAt', header: 'Created at' },
];

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Render the overrides list using Ink.
 *
 * Called from the `overridesListCommand` handler in overrides.ts.
 */
export function renderOverridesList(overrides: PriceOverride[]): void {
  if (overrides.length === 0) {
    render(
      <EmptyState
        title="No price overrides configured"
        hint="Use daybook overrides set <asset> <date> <price> to add one."
      />,
    );
    return;
  }

  const rows: OverrideRow[] = overrides.map(o => ({
    id: o.id,
    asset: o.asset,
    date: formatDay(o.day),
    priceUsd: o.priceUsd,
    note: o.note ?? '',
    createdAt: formatTimestamp(o.createdAt),
  }));

  render(
    <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Header>{formatCount(overrides.length, 'price override')}</Header>
      <Table columns={columns} rows={rows} />
    </Box>,
  );
}
