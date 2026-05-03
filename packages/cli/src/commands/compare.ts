/**
 * `daybook compare <year>` — compare tax outcomes across cost-basis methods.
 *
 * Workflow:
 *   1. Parse and validate the year argument
 *   2. Load config, open DB, create repo
 *   3. Verify ledger_entries exist (error if empty)
 *   4. Load all LedgerEntries (full history for lot tracking)
 *   5. Set up pricing chain (source-reported → CoinGecko → manual override)
 *   6. Hydrate entries with USD prices
 *   7. Run compareMethods() from @daybook/tax
 *   8. Render comparison table using Ink (with plain-text fallback)
 *   9. Highlight the method with the lowest total taxable amount
 */

import React from 'react';
import { render } from 'ink';
import Decimal from 'decimal.js';
import { createRepo, openDatabase } from '@daybook/ledger';
import {
    compareMethods,
    summarizeResults,
    PriceCache,
    PricingChain,
    SourceReportedProvider,
    CoinGeckoProvider,
    ManualOverrideProvider,
} from '@daybook/tax';
import type { MethodSummary } from '@daybook/tax';
import { expandPath, loadConfig } from '../config.js';
import { CompareTable } from './CompareTable.js';
import { writeJson } from '../ui/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface CompareOptions {
  config?: string;
  format?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Table rendering helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Format a decimal string as a USD value with two decimal places.
 *
 * @param value - Decimal string to format.
 * @returns Formatted USD string (e.g. '$1,234.56' or '-$42.00').
 */
function formatUsd(value: string): string {
  const d = new Decimal(value);
  const abs = d.abs().toFixed(2);
  // Add thousands separators
  const [whole, frac] = abs.split('.');
  const withCommas = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = `$${withCommas}.${frac}`;
  return d.isNegative() ? `-${formatted}` : formatted;
}

/**
 * Render a plain-text comparison table to stdout.
 *
 * Columns: Metric | FIFO | HIFO
 * Rows: Disposal count, Short-term gain, Long-term gain, Total taxable, Income
 * The method with the lowest total taxable amount is marked with ← lowest.
 *
 * @param summaries - Array of MethodSummary objects from summarizeResults().
 * @param lowestTaxMethod - The method name with the lowest total taxable.
 */
function renderTable(summaries: MethodSummary[], lowestTaxMethod: string): void {
  // Build a map for easy lookup
  const byMethod = new Map<string, MethodSummary>();
  for (const s of summaries) {
    byMethod.set(s.method, s);
  }

  const fifo = byMethod.get('FIFO');
  const hifo = byMethod.get('HIFO');

  if (!fifo || !hifo) {
    console.log('Comparison requires both FIFO and HIFO results.');
    return;
  }

  // Build row data: [label, fifoValue, hifoValue]
  const rows: Array<[string, string, string]> = [
    ['Disposal count', String(fifo.disposalCount), String(hifo.disposalCount)],
    ['Short-term gain', formatUsd(fifo.shortTermGain), formatUsd(hifo.shortTermGain)],
    ['Long-term gain', formatUsd(fifo.longTermGain), formatUsd(hifo.longTermGain)],
    ['Total taxable', formatUsd(fifo.totalTaxable), formatUsd(hifo.totalTaxable)],
    ['Income', formatUsd(fifo.incomeTotal), formatUsd(hifo.incomeTotal)],
  ];

  // Compute column widths
  const headers = ['Metric', 'FIFO', 'HIFO'];
  const colWidths = headers.map((h, i) => {
    const dataMax = Math.max(...rows.map(r => r[i]!.length));
    return Math.max(h.length, dataMax);
  });

  // Add space for the marker on the method columns
  const marker = ' ← lowest';
  const markerLen = marker.length;

  // Adjust column widths for the marker on total taxable row
  // We'll add the marker after the value, so ensure enough space
  const fifoTotalMarked = lowestTaxMethod === 'FIFO';
  const hifoTotalMarked = lowestTaxMethod === 'HIFO';

  if (fifoTotalMarked) {
    colWidths[1] = Math.max(colWidths[1]!, formatUsd(fifo.totalTaxable).length + markerLen);
  }
  if (hifoTotalMarked) {
    colWidths[2] = Math.max(colWidths[2]!, formatUsd(hifo.totalTaxable).length + markerLen);
  }

  // Render
  const sep = '─';
  const pad = (s: string, w: number) => s.padEnd(w);

  const headerLine = `  ${pad(headers[0]!, colWidths[0]!)}  │  ${pad(headers[1]!, colWidths[1]!)}  │  ${pad(headers[2]!, colWidths[2]!)}`;
  const divider = `  ${sep.repeat(colWidths[0]!)}──┼──${sep.repeat(colWidths[1]!)}──┼──${sep.repeat(colWidths[2]!)}`;

  console.log('');
  console.log(`  Tax Method Comparison (${fifo.disposalCount > 0 ? 'with' : 'no'} disposals)`);
  console.log('');
  console.log(headerLine);
  console.log(divider);

  for (const [label, fifoVal, hifoVal] of rows) {
    let fifoDisplay = fifoVal;
    let hifoDisplay = hifoVal;

    // Add marker to the total taxable row
    if (label === 'Total taxable') {
      if (fifoTotalMarked) fifoDisplay = fifoVal + marker;
      if (hifoTotalMarked) hifoDisplay = hifoVal + marker;
    }

    console.log(`  ${pad(label, colWidths[0]!)}  │  ${pad(fifoDisplay, colWidths[1]!)}  │  ${pad(hifoDisplay, colWidths[2]!)}`);
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────────────────
// Ink table rendering
// ─────────────────────────────────────────────────────────────────────────

/**
 * Render the comparison table using Ink components.
 *
 * Uses the CompareTable React component for styled terminal output
 * with color highlighting on the lowest total taxable method.
 *
 * @param summaries - Array of MethodSummary objects from summarizeResults().
 * @param lowestTaxMethod - The method name with the lowest total taxable.
 */
function renderInkTable(summaries: MethodSummary[], lowestTaxMethod: string): void {
  const { unmount } = render(
    React.createElement(CompareTable, { summaries, lowestTaxMethod }),
  );
  unmount();
}

// ─────────────────────────────────────────────────────────────────────────
// Plain-text fallback table rendering
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Command handler
// ─────────────────────────────────────────────────────────────────────────

/** Handler for `daybook compare <year>`. */
export async function compareCommand(
  year: string,
  opts: CompareOptions,
): Promise<void> {
  // 1. Parse and validate year
  const yearNum = Number(year);
  if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
    throw new Error(`Invalid year: "${year}". Provide a four-digit year (e.g. 2024).`);
  }

  // 2. Load config, open DB, create repo
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    // 3. Check that ledger_entries exist
    const probe = repo.getLedgerEntries({ limit: 1 });
    if (probe.length === 0) {
      throw new Error('No classified events found. Run `daybook classify` first.');
    }

    // 4. Load all LedgerEntries (full history for lot tracking)
    const allEntries = repo.getLedgerEntries({ limit: 1_000_000 });

    if (allEntries.length === 0) {
      console.log('No ledger entries found. Nothing to compare.');
      return;
    }

    // 5. Set up pricing chain (source-reported → CoinGecko → manual override)
    const cache = new PriceCache(db.raw);
    const coingeckoApiKeyEnv = config.providers?.coingecko?.apiKeyEnv ?? 'COINGECKO_API_KEY';
    const coingeckoApiKey = process.env[coingeckoApiKeyEnv];

    const coingeckoOpts = coingeckoApiKey
      ? { apiKey: coingeckoApiKey }
      : {};

    const pricingChain = new PricingChain(
      {
        providers: [
          new SourceReportedProvider(db.raw),
          new CoinGeckoProvider(coingeckoOpts),
          new ManualOverrideProvider(db.raw),
        ],
        autoZeroBelowUsd: '1.00',
      },
      cache,
    );

    // 6. Hydrate entries with USD prices
    for (const entry of allEntries) {
      for (const leg of entry.legs) {
        if (leg.amountUsdAtTime || leg.amountUsdReportedBySource) continue;

        const result = await pricingChain.priceAt(
          leg.asset,
          entry.timestamp,
          leg.contractAddress,
        );
        if (result) {
          const absAmount = new Decimal(leg.amount).abs();
          const totalUsd = absAmount.mul(new Decimal(result.priceUsd));
          leg.amountUsdAtTime = totalUsd.toString();
        }
      }
    }

    // 7. Run compareMethods()
    const compareResult = compareMethods(allEntries, yearNum);

    // 8. Summarize and render table using Ink
    const summaries = summarizeResults(compareResult);

    if (writeJson(opts.format, {
      lowestTaxMethod: compareResult.lowestTaxMethod,
      summaries,
    })) {
      return;
    }

    renderInkTable(summaries, compareResult.lowestTaxMethod);

    // Print warnings if any
    const allWarnings = compareResult.results.flatMap(r => r.result.warnings);
    const uniqueWarnings = [...new Set(allWarnings)];
    if (uniqueWarnings.length > 0) {
      console.log(`  Warnings (${uniqueWarnings.length}):`);
      for (const w of uniqueWarnings.slice(0, 10)) {
        console.log(`    - ${w}`);
      }
      if (uniqueWarnings.length > 10) {
        console.log(`    ... and ${uniqueWarnings.length - 10} more`);
      }
      console.log('');
    }

    // Print unpriced events if any
    const allUnpriced = compareResult.results.flatMap(r => r.result.unpricedEvents);
    const uniqueUnpriced = [...new Set(allUnpriced)];
    if (uniqueUnpriced.length > 0) {
      console.log(`  Unpriced events: ${uniqueUnpriced.length}`);
      console.log('  Use `daybook overrides set <asset> <date> <price>` to set prices for unpriced events.');
      console.log('');
    }
  } finally {
    db.close();
  }
}
