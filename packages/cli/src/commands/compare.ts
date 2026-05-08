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
