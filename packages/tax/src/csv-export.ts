/**
 * CSV export for tax-ready output.
 *
 * Converts a `TaxResult` into a CSV string with one row per disposal
 * and a summary footer with short-term gain, long-term gain, and
 * total income totals.
 *
 * Uses csv-stringify/sync for proper field escaping.
 * All monetary values are decimal strings — no floating-point.
 */

import { stringify } from 'csv-stringify/sync';
import Decimal from 'decimal.js';
import type { TaxResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for CSV export formatting.
 */
export interface FormatCsvOptions {
  /** When true, omit the `Wash Sale?` column from the CSV output. */
  noWashSaleFlag?: boolean | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Format a Date as a YYYY-MM-DD string in UTC.
 *
 * @param date - The date to format.
 * @returns Date string in YYYY-MM-DD format.
 */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────

/**
 * Format a TaxResult as a CSV string.
 *
 * Produces a header row, one data row per disposal, then a summary
 * section with total short-term gain, long-term gain, and income.
 *
 * By default includes a `Wash Sale?` column after `Term` with values
 * `Y` or `N`. Pass `{ noWashSaleFlag: true }` to omit it.
 *
 * @param result - The complete tax computation result.
 * @param opts - Optional formatting options.
 * @returns A CSV-formatted string ready for file output.
 */
export function formatCsv(result: TaxResult, opts?: FormatCsvOptions): string {
  const includeWashSale = !(opts?.noWashSaleFlag);

  const headers = [
    'Date Acquired',
    'Date Sold',
    'Asset',
    'Amount',
    'Proceeds (USD)',
    'Cost Basis (USD)',
    'Gain/Loss (USD)',
    'Term',
    ...(includeWashSale ? ['Wash Sale?'] : []),
  ];

  const rows: string[][] = result.disposals.map((d) => [
    formatDate(d.acquiredAt),
    formatDate(d.disposedAt),
    d.asset,
    d.amount,
    d.proceeds,
    d.costBasis,
    d.gainLoss,
    d.term,
    ...(includeWashSale ? [d.washSaleFlag ? 'Y' : 'N'] : []),
  ]);

  // Build data section (header + rows)
  const dataCsv = stringify([headers, ...rows]);

  // Compute summary totals
  let shortTermGain = new Decimal(0);
  let longTermGain = new Decimal(0);

  for (const d of result.disposals) {
    if (d.term === 'short-term') {
      shortTermGain = shortTermGain.plus(new Decimal(d.gainLoss));
    } else {
      longTermGain = longTermGain.plus(new Decimal(d.gainLoss));
    }
  }

  // Build summary section
  const summaryRows: string[][] = [
    ['Summary'],
    ['Short-Term Gain', shortTermGain.toString()],
    ['Long-Term Gain', longTermGain.toString()],
    ['Total Income', result.income.totalUsd],
  ];

  const summaryCsv = stringify(summaryRows);

  return dataCsv + '\n' + summaryCsv;
}
