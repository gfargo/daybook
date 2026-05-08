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

import { readFileSync, writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { render } from 'ink';
import React from 'react';
import { createRepo, openDatabase } from '@daybook/ledger';
import {
    computeTax,
    formatCsv,
    formatForm8949,
    formatScheduleD,
    formatTxf,
    FIFO,
    HIFO,
    LIFO,
    SpecificId,
    LotBook,
    PriceCache,
    PricingChain,
    SourceReportedProvider,
    CoinGeckoProvider,
    ManualOverrideProvider
} from '@daybook/tax';
import type { CostBasisStrategy, DisposalResult, CheckboxCategory } from '@daybook/tax';
import { expandPath, loadConfig } from '../config.js';
import { LotPicker } from './LotPicker.js';
import type { PendingDisposal } from './LotPicker.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  method?: string;
  output?: string;
  config?: string;
  lotSelections?: string;
  noWashSaleFlag?: boolean;
  format?: string;
  '8949Checkbox'?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Supported export formats. */
export const SUPPORTED_FORMATS = ['csv', '8949', 'schedule-d', 'txf'] as const;
export type ExportFormat = typeof SUPPORTED_FORMATS[number];

/**
 * Validate and resolve the --format flag.
 *
 * @param flag - The raw --format value, if provided.
 * @returns The resolved export format.
 * @throws {Error} If the format is not supported.
 */
export function resolveFormat(flag: string | undefined): ExportFormat {
  if (!flag) return 'csv';
  const lower = flag.toLowerCase();
  if (SUPPORTED_FORMATS.includes(lower as ExportFormat)) {
    return lower as ExportFormat;
  }
  throw new Error(
    `Unsupported format: "${flag}". Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
  );
}

/**
 * Validate and resolve the --8949-checkbox flag.
 *
 * @param flag - The raw --8949-checkbox value, if provided.
 * @returns The resolved checkbox category.
 * @throws {Error} If the value is not A, B, or C.
 */
export function resolveCheckbox(flag: string | undefined): CheckboxCategory {
  if (!flag) return 'C';
  const upper = flag.toUpperCase();
  if (upper === 'A' || upper === 'B' || upper === 'C') {
    return upper as CheckboxCategory;
  }
  throw new Error(
    `Invalid checkbox category: "${flag}". Supported values: A, B, C`,
  );
}

/**
 * Build the default output file path for a given format.
 *
 * @param year - The tax year.
 * @param method - The cost-basis method name.
 * @param format - The export format.
 * @returns The default output file path.
 */
export function defaultOutputPath(year: number, method: string, format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return `./daybook-${year}-${method}.csv`;
    case '8949':
      return `./daybook-${year}-${method}-8949.pdf`;
    case 'schedule-d':
      return `./daybook-${year}-${method}-schedule-d.pdf`;
    case 'txf':
      return `./daybook-${year}-${method}.txf`;
  }
}

/**
 * Resolve the cost-basis strategy from the --method flag or config default.
 *
 * For FIFO and HIFO, returns the strategy directly. For Specific ID,
 * returns `null` — the caller must handle the interactive or file-based
 * lot selection flow separately.
 *
 * @param flag - The --method flag value (case-insensitive), if provided.
 * @param configDefault - The default method from config.tax.costBasisMethod.
 * @returns The resolved CostBasisStrategy, or `null` for Specific ID.
 */
function resolveMethod(flag: string | undefined, configDefault: string): CostBasisStrategy | null {
  const raw = (flag ?? configDefault).toLowerCase().replace(/[\s_]/g, '-');
  switch (raw) {
    case 'fifo':
      return FIFO;
    case 'hifo':
      return HIFO;
    case 'lifo':
      return LIFO;
    case 'specific-id':
      return null; // handled separately
    default:
      throw new Error(`Unknown cost-basis method: "${flag ?? configDefault}". Supported methods: FIFO, HIFO, LIFO, specific-id.`);
  }
}

/**
 * Load a lot selection map from a JSON file.
 *
 * The file should contain a JSON object mapping lot IDs to decimal
 * string amounts, e.g. `{ "lot-1": "0.5", "lot-2": "1.0" }`.
 *
 * @param filePath - Path to the JSON file.
 * @returns A Map from lot ID to amount string.
 */
function loadLotSelections(filePath: string): Map<string, string> {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, string>;
  return new Map(Object.entries(parsed));
}

/**
 * Validate that all lot IDs in the selection map exist in the given
 * lot pool. The caller collects known lot IDs from a FIFO dry-run
 * and checks against the selection map.
 *
 * @param selections - The lot selection map to validate.
 * @param knownLotIds - Set of lot IDs known to exist.
 * @returns Array of missing lot IDs (empty if all valid).
 */
function findMissingLotIds(selections: Map<string, string>, knownLotIds: Set<string>): string[] {
  const missing: string[] = [];
  for (const lotId of selections.keys()) {
    if (!knownLotIds.has(lotId)) {
      missing.push(lotId);
    }
  }
  return missing;
}

/**
 * Run the interactive LotPicker flow and return the selections.
 *
 * @param pendingDisposals - Disposals that need lot selection.
 * @returns A promise resolving to the lot selections and skipped indices.
 */
async function runLotPicker(
  pendingDisposals: PendingDisposal[],
): Promise<{ selections: Map<string, string>; skippedIndices: Set<number> }> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      React.createElement(LotPicker, {
        disposals: pendingDisposals,
        onDone: (selections: Map<string, string>, skippedIndices: Set<number>) => {
          unmount();
          resolve({ selections, skippedIndices });
        },
      }),
    );
    void waitUntilExit();
  });
}

/**
 * Build the list of pending disposals with available lots for the
 * interactive lot picker.
 *
 * Replays the tax engine's lot acquisition logic (without disposals)
 * to reconstruct the lot book state at each disposal point, then
 * captures a snapshot of available lots for each disposal.
 *
 * @param entries - All hydrated LedgerEntries (prior + current year).
 * @param year - The tax year.
 * @returns Array of PendingDisposal objects for the picker.
 */
function buildPendingDisposals(
  entries: import('@daybook/ledger').LedgerEntry[],
  year: number,
): PendingDisposal[] {
  const yearStart = new Date(`${year}-01-01T00:00:00Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`);

  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const lotBook = new LotBook();
  const pending: PendingDisposal[] = [];
  let lotCounter = 0;

  /** Check if a leg is USD fiat. Stablecoins are crypto assets. */
  function isUsdLeg(leg: import('@daybook/ledger').AssetLeg): boolean {
    return leg.asset.toUpperCase() === 'USD';
  }

  /** Resolve USD value for a leg. */
  function resolveUsd(leg: import('@daybook/ledger').AssetLeg): string | null {
    return leg.amountUsdAtTime ?? leg.amountUsdReportedBySource ?? null;
  }

  /** Compute unit cost. */
  function unitCost(leg: import('@daybook/ledger').AssetLeg, totalUsd: string): string {
    const absAmount = new Decimal(leg.amount).abs();
    if (absAmount.isZero()) return '0';
    return new Decimal(totalUsd).abs().div(absAmount).toString();
  }

  for (const entry of sorted) {
    switch (entry.type) {
      case 'trade': {
        const inLegs = entry.legs.filter(
          (l) => !l.feeFlag && new Decimal(l.amount).isPositive() && !isUsdLeg(l),
        );
        const outLegs = entry.legs.filter(
          (l) => !l.feeFlag && new Decimal(l.amount).isNegative() && !isUsdLeg(l),
        );

        // Acquire lots for buy legs
        for (const leg of inLegs) {
          const usd = resolveUsd(leg);
          if (!usd) continue;
          lotCounter++;
          lotBook.acquire({
            id: `lot-${entry.id}-${leg.asset}-${lotCounter}`,
            asset: leg.asset.toUpperCase(),
            amount: new Decimal(leg.amount).abs().toString(),
            unitCostUsd: unitCost(leg, usd),
            acquiredAt: entry.timestamp,
            sourceEntryId: entry.id,
          });
        }

        // For sell legs in the tax year, capture available lots before disposing
        for (const leg of outLegs) {
          const absAmount = new Decimal(leg.amount).abs();
          const asset = leg.asset.toUpperCase();

          if (entry.timestamp >= yearStart && entry.timestamp < yearEnd) {
            // Snapshot available lots for the picker
            const available = [...lotBook.getAvailable(asset)];
            pending.push({
              disposal: {
                asset,
                amount: absAmount.toString(),
                proceeds: '0',
                costBasis: '0',
                gainLoss: '0',
                term: 'short-term',
                acquiredAt: entry.timestamp,
                disposedAt: entry.timestamp,
                sourceEntryId: entry.id,
                lotsConsumed: [],
                washSaleFlag: false,
              },
              availableLots: available,
            });
          }

          // Dispose with FIFO to advance the lot book state
          lotBook.dispose(asset, absAmount, FIFO, entry.timestamp);
        }
        break;
      }

      case 'income': {
        for (const leg of entry.legs) {
          if (isUsdLeg(leg)) continue;
          const usd = resolveUsd(leg);
          if (!usd) continue;
          lotCounter++;
          lotBook.acquire({
            id: `lot-${entry.id}-${leg.asset}-${lotCounter}`,
            asset: leg.asset.toUpperCase(),
            amount: new Decimal(leg.amount).abs().toString(),
            unitCostUsd: unitCost(leg, usd),
            acquiredAt: entry.timestamp,
            sourceEntryId: entry.id,
          });
        }
        break;
      }

      case 'fee_disposal': {
        for (const leg of entry.legs) {
          if (new Decimal(leg.amount).isZero()) continue;
          const absAmount = new Decimal(leg.amount).abs();
          const asset = leg.asset.toUpperCase();

          if (entry.timestamp >= yearStart && entry.timestamp < yearEnd) {
            const available = [...lotBook.getAvailable(asset)];
            pending.push({
              disposal: {
                asset,
                amount: absAmount.toString(),
                proceeds: '0',
                costBasis: '0',
                gainLoss: '0',
                term: 'short-term',
                acquiredAt: entry.timestamp,
                disposedAt: entry.timestamp,
                sourceEntryId: entry.id,
                lotsConsumed: [],
                washSaleFlag: false,
              },
              availableLots: available,
            });
          }

          lotBook.dispose(asset, absAmount, FIFO, entry.timestamp);
        }
        break;
      }

      default:
        break;
    }
  }

  return pending;
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
    const strategyOrNull = resolveMethod(opts.method, config.tax.costBasisMethod);
    const isSpecificId = strategyOrNull === null;

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

    // 7. Run computeTax() — handle Specific ID specially
    let strategy: CostBasisStrategy;

    if (isSpecificId) {
      if (opts.lotSelections) {
        // Load selections from file
        const selections = loadLotSelections(opts.lotSelections);

        // Validate lot IDs exist by rebuilding the lot book
        const validationResult = computeTax(allHydratedEntries, {
          method: FIFO,
          holdingPeriodDays: 365,
          year: yearNum,
        });

        // Collect all lot IDs that appear in disposal results
        const knownLotIds = new Set<string>();
        for (const d of validationResult.disposals) {
          for (const lc of d.lotsConsumed) {
            knownLotIds.add(lc.lotId);
          }
        }

        const missingIds = findMissingLotIds(selections, knownLotIds);

        if (missingIds.length > 0) {
          throw new Error(
            `Lot IDs not found in current LotBook:\n${missingIds.map(id => `  - ${id}`).join('\n')}\n\nThese lots may have been consumed by reclassification. Re-run without --lot-selections to pick new lots.`,
          );
        }

        strategy = new SpecificId(selections);
      } else {
        // Interactive lot picker flow
        if (!process.stdout.isTTY) {
          throw new Error(
            'Specific ID requires an interactive terminal or --lot-selections <path>.',
          );
        }

        // Build pending disposals with available lots for the picker
        // We need to replay the lot book to know what's available at each disposal
        const pendingDisposals = buildPendingDisposals(allHydratedEntries, yearNum);

        if (pendingDisposals.length === 0) {
          console.log('No disposals found for the tax year. Nothing to select.');
          return;
        }

        const { selections } = await runLotPicker(pendingDisposals);

        // Serialize selections for replay
        const selectionsObj = Object.fromEntries(selections);
        const selectionsPath = `./daybook-${yearNum}-specific-id-selections.json`;
        writeFileSync(selectionsPath, JSON.stringify(selectionsObj, null, 2), 'utf-8');
        console.log(`Lot selections saved to: ${selectionsPath}`);
        console.log('  (Use --lot-selections to replay without the interactive picker)\n');

        strategy = new SpecificId(selections);
      }
    } else {
      strategy = strategyOrNull;
    }

    const taxResult = computeTax(allHydratedEntries, {
      method: strategy,
      holdingPeriodDays: 365,
      year: yearNum,
    });

    // 8. Resolve format and checkbox options
    const format = resolveFormat(opts.format);
    const checkbox = resolveCheckbox(opts['8949Checkbox']);

    // 9. Dispatch to the appropriate formatter and write output
    const methodName = strategy.name;
    const outputPath = opts.output ?? defaultOutputPath(yearNum, methodName, format);

    switch (format) {
      case 'csv': {
        const csv = formatCsv(taxResult, { noWashSaleFlag: opts.noWashSaleFlag });
        writeFileSync(outputPath, csv, 'utf-8');
        break;
      }

      case '8949': {
        if (taxResult.disposals.length === 0) {
          console.log(`No disposals found for ${yearNum}. Skipping Form 8949 generation.`);
          return;
        }
        const pdfBytes = await formatForm8949(taxResult, { checkbox });
        writeFileSync(outputPath, pdfBytes);
        break;
      }

      case 'schedule-d': {
        if (taxResult.disposals.length === 0) {
          console.log(`No disposals found for ${yearNum}. Skipping Schedule D generation.`);
          return;
        }
        const pdfBytes = await formatScheduleD(taxResult);
        writeFileSync(outputPath, pdfBytes);
        break;
      }

      case 'txf': {
        const txf = formatTxf(taxResult, { checkbox });
        writeFileSync(outputPath, txf, 'utf-8');
        break;
      }
    }

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

    // Separate unpriced events into NFT and fungible categories
    const entryById = new Map(allHydratedEntries.map(e => [e.id, e]));
    const unpricedNftIds: string[] = [];
    const unpricedFungibleIds: string[] = [];
    for (const eid of taxResult.unpricedEvents) {
      const entry = entryById.get(eid);
      if (entry && (entry.type === 'nft_acquisition' || entry.type === 'nft_disposal')) {
        unpricedNftIds.push(eid);
      } else {
        unpricedFungibleIds.push(eid);
      }
    }

    console.log(`Export complete (${yearNum}, ${methodName}, ${format}):`);
    console.log(`  Format:              ${format}`);
    console.log(`  Disposals:           ${taxResult.disposals.length}`);
    console.log(`  Short-term gain:     ${shortTermGain.toString()}`);
    console.log(`  Long-term gain:      ${longTermGain.toString()}`);
    console.log(`  Total income:        ${taxResult.income.totalUsd}`);
    console.log(`  Unpriced events:     ${taxResult.unpricedEvents.length}`);
    if (unpricedNftIds.length > 0) {
      console.log(`  Unpriced NFT events: ${unpricedNftIds.length}`);
    }
    console.log(`  Output written to:   ${outputPath}`);

    // Wash sale candidate summary
    if (!opts.noWashSaleFlag) {
      const washSaleCount = taxResult.disposals.filter((d: DisposalResult) => d.washSaleFlag).length;
      if (washSaleCount > 0) {
        console.log(`  Wash sale candidates: ${washSaleCount} (see Wash Sale? column)`);
      }
    }

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
      if (unpricedFungibleIds.length > 0) {
        console.log('  Use `daybook overrides set <asset> <date> <price>` to set prices for unpriced events.');
      }
      if (unpricedNftIds.length > 0) {
        console.log(`  Use 'daybook overrides set <contractAddress>:<tokenId> <date> <price>' to set NFT prices`);
      }
    }
  } finally {
    db.close();
  }
}
