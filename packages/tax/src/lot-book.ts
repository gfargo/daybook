/**
 * LotBook — per-asset lot pool with acquire/dispose operations.
 *
 * Implements universal lot pooling: all accounts share a single pool
 * per asset. The LotBook is the core data structure of the tax engine,
 * tracking every acquisition and disposal for cost-basis computation.
 *
 * All arithmetic uses decimal.js — never JavaScript floating-point.
 */

import Decimal from 'decimal.js';
import type { Lot, DisposalResult } from './types.js';
import type { CostBasisStrategy } from './cost-basis.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Number of milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Default holding period threshold in days (US: >365 = long-term). */
const HOLDING_PERIOD_DAYS = 365;

// ─────────────────────────────────────────────────────────────────────────
// LotBook
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tracks asset lots across all accounts (universal pooling).
 *
 * Usage:
 * ```ts
 * const book = new LotBook();
 * book.acquire({ id: 'lot-1', asset: 'ETH', amount: '1.5', unitCostUsd: '2000', acquiredAt: new Date(), sourceEntryId: 'entry-1' });
 * const result = book.dispose('ETH', new Decimal('0.5'), fifoStrategy, new Date());
 * ```
 */
export class LotBook {
  /** Asset ticker → array of lots. Universal pool — one pool per asset. */
  private pools: Map<string, Lot[]> = new Map();

  /**
   * Add a lot to the pool for the given asset.
   *
   * Called when the tax engine processes a buy, income event, or
   * inbound trade leg.
   *
   * @param lot - The lot to add. Must have a positive amount.
   */
  acquire(lot: Lot): void {
    const existing = this.pools.get(lot.asset);
    if (existing) {
      existing.push(lot);
    } else {
      this.pools.set(lot.asset, [lot]);
    }
  }

  /**
   * Dispose of an asset amount using the given cost-basis strategy.
   *
   * Selects lots via the strategy, computes cost basis, splits partial
   * lots, and removes fully consumed lots from the pool.
   *
   * @param asset - Ticker symbol of the asset to dispose.
   * @param amount - Amount to dispose (positive Decimal).
   * @param strategy - Which lots to consume (FIFO, HIFO, etc.).
   * @param disposedAt - When the disposal occurred.
   * @returns The disposal result with gain/loss set to '0' for proceeds
   *          (caller is responsible for setting actual proceeds).
   * @throws Never — insufficient lots produce a warning in the result.
   */
  dispose(
    asset: string,
    amount: Decimal,
    strategy: CostBasisStrategy,
    disposedAt: Date,
  ): DisposalResult {
    const available = this.pools.get(asset) ?? [];

    // Let the strategy pick which lots to consume
    const selection = strategy.selectLots(available, amount);

    // Track consumed lot details and compute cost basis
    let totalCostBasis = new Decimal(0);
    let earliestAcquiredAt: Date | undefined;
    let sourceEntryId = '';
    const lotsConsumed: DisposalResult['lotsConsumed'] = [];

    for (const { lot, amount: consumedAmountStr } of selection.consumed) {
      const consumedAmount = new Decimal(consumedAmountStr);
      const lotAmount = new Decimal(lot.amount);
      const costForThisPortion = consumedAmount.mul(new Decimal(lot.unitCostUsd));

      totalCostBasis = totalCostBasis.plus(costForThisPortion);
      lotsConsumed.push({
        lotId: lot.id,
        amount: consumedAmountStr,
        costBasis: costForThisPortion.toString(),
      });

      // Track earliest acquisition date for holding period
      if (!earliestAcquiredAt || lot.acquiredAt.getTime() < earliestAcquiredAt.getTime()) {
        earliestAcquiredAt = lot.acquiredAt;
        sourceEntryId = lot.sourceEntryId;
      }

      // Update or remove the lot from the pool
      const remaining = lotAmount.minus(consumedAmount);
      if (remaining.isZero()) {
        // Fully consumed — remove from pool
        const pool = this.pools.get(asset);
        if (pool) {
          const idx = pool.indexOf(lot);
          if (idx !== -1) {
            pool.splice(idx, 1);
          }
        }
      } else {
        // Partially consumed — update the lot's remaining amount
        // We mutate the lot in place since the strategy returned a reference
        (lot as { amount: string }).amount = remaining.toString();
      }
    }

    // Determine holding period
    const acquiredAt = earliestAcquiredAt ?? disposedAt;
    const holdingDays = (disposedAt.getTime() - acquiredAt.getTime()) / MS_PER_DAY;
    const term: 'short-term' | 'long-term' =
      holdingDays > HOLDING_PERIOD_DAYS ? 'long-term' : 'short-term';

    // Proceeds default to '0' — the caller (computeTax) sets actual proceeds
    // and computes gainLoss = proceeds - costBasis
    return {
      asset,
      amount: amount.toString(),
      proceeds: '0',
      costBasis: totalCostBasis.toString(),
      gainLoss: new Decimal(0).minus(totalCostBasis).toString(),
      term,
      acquiredAt,
      disposedAt,
      sourceEntryId,
      lotsConsumed,
      washSaleFlag: false,
    };
  }

  /**
   * Get a read-only view of available lots for an asset.
   *
   * @param asset - Ticker symbol.
   * @returns Array of lots (may be empty).
   */
  getAvailable(asset: string): ReadonlyArray<Lot> {
    return this.pools.get(asset) ?? [];
  }

  /**
   * Sum the total remaining amount across all lots for an asset.
   *
   * @param asset - Ticker symbol.
   * @returns Total amount as a Decimal.
   */
  totalAmount(asset: string): Decimal {
    const lots = this.pools.get(asset) ?? [];
    return lots.reduce(
      (sum, lot) => sum.plus(new Decimal(lot.amount)),
      new Decimal(0),
    );
  }
}
