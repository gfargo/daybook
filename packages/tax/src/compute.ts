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
import { NftLotBook } from './nft-lot-book.js';
import { nftId, formatNftDescription } from './nft-helpers.js';
import type { TaxResult, DisposalResult, IncomeSummary } from './types.js';
import { applyWashSaleFlags } from './wash-sale.js';
import type { AcquisitionRecord } from './wash-sale.js';
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
 * Check if a leg represents USD fiat. Stablecoins such as USDC and USDT are
 * crypto assets for lot tracking and must not be treated as cash.
 *
 * @param leg - The asset leg to check.
 * @returns True if the leg is a USD fiat leg.
 */
function isUsdLeg(leg: AssetLeg): boolean {
  return leg.asset.toUpperCase() === 'USD';
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
  const nftLotBook = new NftLotBook();
  const disposals: DisposalResult[] = [];
  const incomeEvents: IncomeEvent[] = [];
  const acquisitions: AcquisitionRecord[] = [];
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

          // Track acquisition for wash-sale pass
          acquisitions.push({ asset, acquiredAt: entry.timestamp });
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

          // Track acquisition for wash-sale pass
          acquisitions.push({ asset, acquiredAt: entry.timestamp });

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

      // ─── NFT Acquisition ─────────────────────────────────────────
      case 'nft_acquisition': {
        // Find the NFT leg (has contractAddress and tokenId)
        const nftLeg = entry.legs.find(
          (l) => l.contractAddress != null && l.tokenId != null,
        );
        if (!nftLeg) break;

        // Find the optional payment leg (fungible counterpart with negative amount)
        const paymentLeg = entry.legs.find(
          (l) =>
            l !== nftLeg &&
            !l.feeFlag &&
            new Decimal(l.amount).isNegative(),
        );

        // Derive cost basis from payment leg USD, or zero for airdrops
        let costBasisUsd = '0';
        let isUnpriced = false;

        if (paymentLeg) {
          const paymentUsd = resolveUsd(paymentLeg);
          if (paymentUsd) {
            costBasisUsd = new Decimal(paymentUsd).abs().toString();
          } else {
            isUnpriced = true;
          }
        }
        // If no payment leg (airdrop), check if the NFT leg itself has a USD value
        // (from a price override resolved upstream)
        if (!paymentLeg) {
          const nftUsd = resolveUsd(nftLeg);
          if (nftUsd) {
            costBasisUsd = new Decimal(nftUsd).abs().toString();
          } else {
            // Airdrop with no price override → zero cost basis, not unpriced
            // (airdrops default to zero unless overridden)
            costBasisUsd = '0';
          }
        }

        if (isUnpriced) {
          unpricedEvents.push(entry.id);
        }

        const nftIdentifier = nftId(nftLeg.contractAddress!, nftLeg.tokenId!);

        nftLotBook.acquire({
          nftId: nftIdentifier,
          costBasisUsd,
          acquiredAt: entry.timestamp,
          sourceEntryId: entry.id,
        });

        // Track acquisition for wash-sale pass (use formatted description as asset)
        const nftAssetKey = formatNftDescription(nftLeg.contractAddress!, nftLeg.tokenId!);
        acquisitions.push({ asset: nftAssetKey, acquiredAt: entry.timestamp });

        break;
      }

      // ─── NFT Disposal ──────────────────────────────────────────────
      case 'nft_disposal': {
        // Find the NFT leg (has contractAddress and tokenId)
        const nftLeg = entry.legs.find(
          (l) => l.contractAddress != null && l.tokenId != null,
        );
        if (!nftLeg) break;

        // Find the optional proceeds leg (fungible counterpart with positive amount)
        const proceedsLeg = entry.legs.find(
          (l) =>
            l !== nftLeg &&
            !l.feeFlag &&
            new Decimal(l.amount).isPositive(),
        );

        const nftIdentifier = nftId(nftLeg.contractAddress!, nftLeg.tokenId!);
        const nftAssetKey = formatNftDescription(nftLeg.contractAddress!, nftLeg.tokenId!);

        // Look up the lot
        const lot = nftLotBook.dispose(nftIdentifier);

        let costBasis: Decimal;
        let acquiredAt: Date;

        if (lot) {
          costBasis = new Decimal(lot.costBasisUsd);
          acquiredAt = lot.acquiredAt;
        } else {
          // No matching lot — warning + zero cost basis
          const dateStr = entry.timestamp.toISOString().split('T')[0]!;
          warnings.push(
            `Missing cost basis for NFT ${nftIdentifier} disposed on ${dateStr}`,
          );
          costBasis = new Decimal(0);
          acquiredAt = entry.timestamp;
        }

        // Compute proceeds from counterpart leg USD or zero
        let proceeds = new Decimal(0);
        let isUnpriced = false;

        if (proceedsLeg) {
          const proceedsUsd = resolveUsd(proceedsLeg);
          if (proceedsUsd) {
            proceeds = new Decimal(proceedsUsd).abs();
          } else {
            isUnpriced = true;
          }
        } else {
          // No proceeds leg — check if the NFT leg itself has a USD value
          // (from a price override resolved upstream)
          const nftUsd = resolveUsd(nftLeg);
          if (nftUsd) {
            proceeds = new Decimal(nftUsd).abs();
          }
          // Transfer out with no price → zero proceeds, not unpriced
        }

        if (isUnpriced) {
          unpricedEvents.push(entry.id);
        }

        const gainLoss = proceeds.minus(costBasis);

        // Determine holding period
        const holdingMs =
          entry.timestamp.getTime() - acquiredAt.getTime();
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
            asset: nftAssetKey,
            amount: '1',
            proceeds: proceeds.toString(),
            costBasis: costBasis.toString(),
            gainLoss: gainLoss.toString(),
            term,
            acquiredAt,
            disposedAt: entry.timestamp,
            sourceEntryId: entry.id,
            lotsConsumed: lot
              ? [{ lotId: nftIdentifier, amount: '1', costBasis: costBasis.toString() }]
              : [],
            washSaleFlag: false,
          });
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

  // Collect NftLotBook warnings (duplicate acquisitions, etc.)
  warnings.push(...nftLotBook.warnings);

  // ─── Wash-sale pass ────────────────────────────────────────────
  const flaggedDisposals = applyWashSaleFlags(disposals, acquisitions);

  return {
    year,
    method: method.name,
    disposals: flaggedDisposals,
    income: buildIncomeSummary(incomeEvents),
    warnings,
    unpricedEvents: uniqueUnpriced,
  };
}
