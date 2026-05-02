/**
 * `daybook export <year>` — compute tax and export a tax-ready CSV.
 *
 * Workflow:
 *   1. Parse and validate the year argument
 *   2. Load config, open DB, create repo
 *   3. Verify ledger_entries exist (error if empty)
 *   4. Load LedgerEntries for the specified year
 *   5. Determine cost-basis method from --method flag or config default
 *   6. Set up pricing chain (source-reported → CoinGecko → manual override)
 *   7. Run computeTax() with the entries
 *   8. Generate CSV via formatCsv()
 *   9. Write CSV to --output path or default ./daybook-<year>-<method>.csv
 *  10. Print summary
 */

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { createRepo, openDatabase } from '@daybook/ledger';
import {
    computeTax,
    formatCsv,
    FIFO,
    HIFO,
    PriceCache,
    PricingChain,
    SourceReportedProvider,
    CoinGeckoProvider,
    ManualOverrideProvider,
} from '@daybook/tax';
import type { CostBasisStrategy } from '@daybook/tax';
import { expandPath, loadConfig } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  method?: string;
  output?: string;
  config?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the cost-basis strategy from the --method flag or config default.
 *
 * @param flag - The --method flag value (case-insensitive), if provided.
 * @param configDefault - The default method from config.tax.costBasisMethod.
 * @returns The resolved CostBasisStrategy.
 */
function resolveMethod(flag: string | undefined, configDefault: string): CostBasisStrategy {
  const raw = (flag ?? configDefault).toUpperCase();
  switch (raw) {
    case 'FIFO':
      return FIFO;
    case 'HIFO':
      return HIFO;
    default:
      throw new Error(`Unknown cost-basis method: "${raw}". Supported methods: FIFO, HIFO.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Command handler
// ─────────────────────────────────────────────────────────────────────────

/** Handler for `daybook export <year>`. */
export async function exportCommand(
  year: string,
  opts: ExportOptions,
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
    const allEntries = repo.getLedgerEntries({ limit: 1 });
    if (allEntries.length === 0) {
      throw new Error('No classified events found. Run `daybook classify` first.');
    }

    // 4. Load LedgerEntries for the specified year
    const entries = repo.getLedgerEntries({ year: yearNum });

    if (entries.length === 0) {
      console.log(`No ledger entries found for ${yearNum}. Nothing to export.`);
      return;
    }

    // 5. Determine cost-basis method
    const strategy = resolveMethod(opts.method, config.tax.costBasisMethod);

    // 6. Set up pricing chain (source-reported → CoinGecko → manual override)
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

    // Hydrate entries with USD prices before computing tax.
    // computeTax is synchronous and expects amountUsdAtTime to be set.
    // We need to resolve prices for each leg that doesn't already have one.
    for (const entry of entries) {
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

    // Also hydrate entries from before the tax year that may affect lot tracking.
    // Load all entries up to the end of the tax year for accurate lot history.
    const allEntriesForLots = repo.getLedgerEntries({ limit: 1_000_000 });
    const yearStart = new Date(`${yearNum}-01-01T00:00:00Z`);
    const priorEntries = allEntriesForLots.filter(
      e => e.timestamp < yearStart,
    );

    for (const entry of priorEntries) {
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

    // Combine prior entries + current year entries for full lot history
    const allHydratedEntries = [...priorEntries, ...entries];

    // 7. Run computeTax()
    const taxResult = computeTax(allHydratedEntries, {
      method: strategy,
      holdingPeriodDays: 365,
      year: yearNum,
    });

    // 8. Generate CSV
    const csv = formatCsv(taxResult);

    // 9. Write CSV to output path
    const methodName = strategy.name;
    const outputPath = opts.output ?? `./daybook-${yearNum}-${methodName}.csv`;
    writeFileSync(outputPath, csv, 'utf-8');

    // 10. Print summary
    let shortTermGain = new Decimal(0);
    let longTermGain = new Decimal(0);
    for (const d of taxResult.disposals) {
      if (d.term === 'short-term') {
        shortTermGain = shortTermGain.plus(new Decimal(d.gainLoss));
      } else {
        longTermGain = longTermGain.plus(new Decimal(d.gainLoss));
      }
    }

    console.log(`Export complete (${yearNum}, ${methodName}):`);
    console.log(`  Disposals:           ${taxResult.disposals.length}`);
    console.log(`  Short-term gain:     ${shortTermGain.toString()}`);
    console.log(`  Long-term gain:      ${longTermGain.toString()}`);
    console.log(`  Total income:        ${taxResult.income.totalUsd}`);
    console.log(`  Unpriced events:     ${taxResult.unpricedEvents.length}`);
    console.log(`  CSV written to:      ${outputPath}`);

    if (taxResult.warnings.length > 0) {
      console.log('');
      console.log(`  Warnings (${taxResult.warnings.length}):`);
      for (const w of taxResult.warnings.slice(0, 10)) {
        console.log(`    - ${w}`);
      }
      if (taxResult.warnings.length > 10) {
        console.log(`    ... and ${taxResult.warnings.length - 10} more`);
      }
    }

    if (taxResult.unpricedEvents.length > 0) {
      console.log('');
      console.log('  Use `daybook overrides set <asset> <date> <price>` to set prices for unpriced events.');
    }
  } finally {
    db.close();
  }
}
