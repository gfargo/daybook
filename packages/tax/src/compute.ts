/**
 * Tax computation entry point.
 *
 * `computeTax()` is the main function of the tax engine. It takes
 * pre-hydrated LedgerEntries (USD values already resolved on legs)
 * and produces a complete TaxResult with disposals, income summary,
 * warnings, and unpriced event tracking.
 *
 * This function is synchronous — all pricing is resolved before it
 * runs. It operates on in-memory data structures only.
 *
 * All arithmetic uses decimal.js — never JavaScript floating-point.
 */

import Decimal from 'decimal.js';
import type { LedgerEntry, AssetLeg } from '@daybook/ledger';
import type { CostBasisStrategy } from './cost-basis.js';
import { LotBook } from './lot-book.js';
import type { TaxResult, DisposalResult, IncomeSummary } from './types.js';
import { canonicalAsset } from './pricing/asset-aliases.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the tax computation.
 */
export interface ComputeTaxConfig {
  /** Cost-basis strategy to use (FIFO, HIFO). */
  method: CostBasisStrategy;
  /** Number of days for long-term holding period threshold. Default 365. */
  holdingPeriodDays: number;
  /** Tax year to compute. */
  year: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/** Counter for generating unique lot IDs within a computation run. */
let lotIdCounter = 0;

/**
 * Generate a unique lot ID for this computation run.
 *
 * @param entryId - The LedgerEntry ID that created this lot.
 * @param asset - The asset ticker.
 * @returns A unique lot ID string.
 */
function nextLotId(entryId: string, asset: string): string {
  lotIdCounter++;
  return `lot-${entryId}-${asset}-${lotIdCounter}`;
}

/**
 * Resolve the USD value for a leg.
 *
 * Prefers `amountUsdAtTime` (hydrated by pricing layer), falls back
 * to `amountUsdReportedBySource` (from exchange data). Returns null
 * if neither is available.
 *
 * @param leg - The asset leg to resolve.
 * @returns The USD value as a string, or null if unpriced.
 */
function resolveUsd(leg: AssetLeg): string | null {
  return leg.amountUsdAtTime ?? leg.amountUsdReportedBySource ?? null;
}

/**
 * Compute the unit cost in USD for a leg.
 *
 * Unit cost = total USD value / absolute amount.
 *
 * @param leg - The asset leg.
 * @param totalUsd - The total USD value for this leg.
 * @returns Unit cost as a decimal string.
 */
function unitCost(leg: AssetLeg, totalUsd: string): string {
  const absAmount = new Decimal(leg.amount).abs();
  if (absAmount.isZero()) return '0';
  return new Decimal(totalUsd).abs().div(absAmount).toString();
}

/**
 * Check if a leg represents USD (fiat). USD legs are skipped in
 * lot tracking since fiat is not a crypto asset.
 *
 * @param leg - The asset leg to check.
 * @returns True if the leg is a USD fiat leg.
 */
function isUsdLeg(leg: AssetLeg): boolean {
  const asset = leg.asset.toUpperCase();
  return asset === 'USD' || asset === 'USDC' || asset === 'USDT';
}

// ─────────────────────────────────────────────────────────────────────────
// Income tracking
// ─────────────────────────────────────────────────────────────────────────

/** Internal income event for building the summary. */
interface IncomeEvent {
  entryId: string;
  asset: string;
  amount: string;
  usdValue: string;
}

/**
 * Build the income summary from tracked income events.
 *
 * @param events - All income events collected during computation.
 * @returns The IncomeSummary with totals, per-asset breakdown, and event list.
 */
function buildIncomeSummary(events: IncomeEvent[]): IncomeSummary {
  let totalUsd = new Decimal(0);
  const byAsset: Record<string, Decimal> = {};

  for (const evt of events) {
    const usd = new Decimal(evt.usdValue);
    totalUsd = totalUsd.plus(usd);

    const canonical = canonicalAsset(evt.asset);
    if (byAsset[canonical]) {
      byAsset[canonical] = byAsset[canonical]!.plus(usd);
    } else {
      byAsset[canonical] = usd;
    }
  }

  const byAssetStr: Record<string, string> = {};
  for (const [asset, amount] of Object.entries(byAsset)) {
    byAssetStr[asset] = amount.toString();
  }

  return {
    totalUsd: totalUsd.toString(),
    byAsset: byAssetStr,
    events: events.map((evt) => ({
      entryId: evt.entryId,
      asset: evt.asset,
      amount: evt.amount,
      usdValue: evt.usdValue,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Main computation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute tax results from pre-hydrated LedgerEntries.
 *
 * Processes entries chronologically, tracking lot acquisitions and
 * disposals. Produces a complete TaxResult with all disposals,
 * income summary, warnings, and unpriced event IDs.
 *
 * This function is synchronous — all USD values must be resolved
 * on the entry legs before calling (via `amountUsdAtTime` or
 * `amountUsdReportedBySource`).
 *
 * @param entries - LedgerEntries with USD values already hydrated.
 * @param config - Tax computation configuration.
 * @returns Complete tax result for the configured year.
 */
export function computeTax(
  entries: LedgerEntry[],
  config: ComputeTaxConfig,
): TaxResult {
  // Reset lot ID counter for deterministic output
  lotIdCounter = 0;

  const { method, holdingPeriodDays, year } = config;
  const yearStart = new Date(`${year}-01-01T00:00:00Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`);

  // Sort entries chronologically
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const lotBook = new LotBook();
  const disposals: DisposalResult[] = [];
  const incomeEvents: IncomeEvent[] = [];
  const warnings: string[] = [];
  const unpricedEvents: string[] = [];

  for (const entry of sorted) {
    switch (entry.type) {
      // ─── Trade ───────────────────────────────────────────────────
      case 'trade': {
        const inLegs = entry.legs.filter(
          (l) => !l.feeFlag && new Decimal(l.amount).isPositive() && !isUsdLeg(l),
        );
        const outLegs = entry.legs.filter(
          (l) => !l.feeFlag && new Decimal(l.amount).isNegative() && !isUsdLeg(l),
        );
        const feeLegs = entry.legs.filter((l) => l.feeFlag);

        // Sum fee USD values
        let totalFeeUsd = new Decimal(0);
        for (const fee of feeLegs) {
          const feeUsd = resolveUsd(fee);
          if (feeUsd) {
            totalFeeUsd = totalFeeUsd.plus(new Decimal(feeUsd).abs());
          }
        }

        // Acquire lots for positive (buy) legs
        for (const leg of inLegs) {
          const usd = resolveUsd(leg);
          if (!usd) {
            unpricedEvents.push(entry.id);
            continue;
          }
          const asset = canonicalAsset(leg.asset);
          lotBook.acquire({
            id: nextLotId(entry.id, asset),
            asset,
            amount: new Decimal(leg.amount).abs().toString(),
            unitCostUsd: unitCost(leg, usd),
            acquiredAt: entry.timestamp,
            sourceEntryId: entry.id,
          });
        }

        // Dispose lots for negative (sell) legs — only in the tax year
        for (const leg of outLegs) {
          const absAmount = new Decimal(leg.amount).abs();
          const asset = canonicalAsset(leg.asset);

          const disposal = lotBook.dispose(
            asset,
            absAmount,
            method,
            entry.timestamp,
          );

          // Check for insufficient basis
          const consumed = disposal.lotsConsumed.reduce(
            (sum, lc) => sum.plus(new Decimal(lc.amount)),
            new Decimal(0),
          );
          if (consumed.lt(absAmount)) {
            warnings.push(
              `Insufficient basis for ${asset}: needed ${absAmount.toString()}, had ${consumed.toString()} (entry ${entry.id})`,
            );
          }

          // Compute proceeds from the leg's USD value
          const legUsd = resolveUsd(leg);
          if (!legUsd) {
            unpricedEvents.push(entry.id);
          }

          const rawProceeds = legUsd ? new Decimal(legUsd).abs() : new Decimal(0);
          // Subtract fees from proceeds (v1 policy: fees reduce proceeds)
          const netProceeds = rawProceeds.minus(totalFeeUsd);
          const costBasis = new Decimal(disposal.costBasis);
          const gainLoss = netProceeds.minus(costBasis);

          // Determine holding period
          const holdingMs =
            entry.timestamp.getTime() - disposal.acquiredAt.getTime();
          const term: 'short-term' | 'long-term' =
            holdingMs > holdingPeriodDays * MS_PER_DAY
              ? 'long-term'
              : 'short-term';

          // Only record disposals that fall within the tax year
          if (
            entry.timestamp >= yearStart &&
            entry.timestamp < yearEnd
          ) {
            disposals.push({
              ...disposal,
              proceeds: netProceeds.toString(),
              costBasis: costBasis.toString(),
              gainLoss: gainLoss.toString(),
              term,
              sourceEntryId: entry.id,
            });
          }
        }
        break;
      }

      // ─── Income ──────────────────────────────────────────────────
      case 'income': {
        for (const leg of entry.legs) {
          if (isUsdLeg(leg)) continue;

          const usd = resolveUsd(leg);
          if (!usd) {
            unpricedEvents.push(entry.id);
            continue;
          }

          const asset = canonicalAsset(leg.asset);
          const amount = new Decimal(leg.amount).abs();

          // Acquire lot at FMV
          lotBook.acquire({
            id: nextLotId(entry.id, asset),
            asset,
            amount: amount.toString(),
            unitCostUsd: unitCost(leg, usd),
            acquiredAt: entry.timestamp,
            sourceEntryId: entry.id,
          });

          // Track income event (only for the tax year)
          if (
            entry.timestamp >= yearStart &&
            entry.timestamp < yearEnd
          ) {
            incomeEvents.push({
              entryId: entry.id,
              asset: leg.asset,
              amount: amount.toString(),
              usdValue: new Decimal(usd).abs().toString(),
            });
          }
        }
        break;
      }

      // ─── Fee disposal (gas) ──────────────────────────────────────
      case 'fee_disposal': {
        for (const leg of entry.legs) {
          if (new Decimal(leg.amount).isZero()) continue;

          const absAmount = new Decimal(leg.amount).abs();
          const asset = canonicalAsset(leg.asset);

          const disposal = lotBook.dispose(
            asset,
            absAmount,
            method,
            entry.timestamp,
          );

          // Check for insufficient basis
          const consumed = disposal.lotsConsumed.reduce(
            (sum, lc) => sum.plus(new Decimal(lc.amount)),
            new Decimal(0),
          );
          if (consumed.lt(absAmount)) {
            warnings.push(
              `Insufficient basis for ${asset}: needed ${absAmount.toString()}, had ${consumed.toString()} (entry ${entry.id})`,
            );
          }

          // Fee disposal proceeds = USD value of the gas spent
          const legUsd = resolveUsd(leg);
          if (!legUsd) {
            unpricedEvents.push(entry.id);
          }

          const proceeds = legUsd ? new Decimal(legUsd).abs() : new Decimal(0);
          const costBasis = new Decimal(disposal.costBasis);
          const gainLoss = proceeds.minus(costBasis);

          // Determine holding period
          const holdingMs =
            entry.timestamp.getTime() - disposal.acquiredAt.getTime();
          const term: 'short-term' | 'long-term' =
            holdingMs > holdingPeriodDays * MS_PER_DAY
              ? 'long-term'
              : 'short-term';

          // Only record disposals that fall within the tax year
          if (
            entry.timestamp >= yearStart &&
            entry.timestamp < yearEnd
          ) {
            disposals.push({
              ...disposal,
              proceeds: proceeds.toString(),
              costBasis: costBasis.toString(),
              gainLoss: gainLoss.toString(),
              term,
              sourceEntryId: entry.id,
            });
          }
        }
        break;
      }

      // ─── No tax impact ──────────────────────────────────────────
      case 'transfer_self':
      case 'fiat_in':
      case 'fiat_out':
      case 'nft_event':
      case 'unclassified':
      case 'transfer_external_in':
      case 'transfer_external_out':
        // No tax impact for v1 — skip
        break;
    }
  }

  // Deduplicate unpriced events
  const uniqueUnpriced = [...new Set(unpricedEvents)];

  return {
    year,
    method: method.name,
    disposals,
    income: buildIncomeSummary(incomeEvents),
    warnings,
    unpricedEvents: uniqueUnpriced,
  };
}
