/**
 * LotBook — per-asset lot pool with acquire/dispose operations.
 *
 * Supports two pooling modes:
 *
 *   Universal (default) — all accounts share a single pool per asset.
 *     Callers pass no `account` argument; the pool key is just the asset ticker.
 *
 *   Per-account — each account has its own pool per asset.
 *     Callers pass an `account` string; the pool key is `${asset}\0${account}`.
 *     Self-transfers move lots between accounts via `transfer()` with no
 *     disposal event.
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
 * Tracks asset lots across accounts.
 *
 * Universal mode (no `account` passed): one pool per asset — unchanged
 * from prior behaviour. All existing callers continue to work.
 *
 * Per-account mode (`account` passed): pool key is `${asset}\0${account}`.
 * `transfer()` moves lots between pools without creating a disposal event.
 *
 * Usage (universal):
 * ```ts
 * const book = new LotBook();
 * book.acquire({ id: 'lot-1', asset: 'ETH', amount: '1.5', ... });
 * const result = book.dispose('ETH', new Decimal('0.5'), fifo, new Date());
 * ```
 *
 * Usage (per-account):
 * ```ts
 * book.acquire(lot, 'acct-coinbase');
 * book.dispose('ETH', amount, fifo, date, 'acct-coinbase');
 * book.transfer('ETH', amount, 'acct-coinbase', 'acct-wallet', fifo, date);
 * ```
 */
export class LotBook {
  /** Internal pool map. Key is either `asset` (universal) or `asset\0account`. */
  private pools: Map<string, Lot[]> = new Map();

  /** Monotonically-increasing counter for generating unique transferred lot IDs. */
  private _xfrSeq = 0;

  /** Build the pool key for a given asset + optional account. */
  private poolKey(asset: string, account?: string): string {
    return account ? `${asset}\0${account}` : asset;
  }

  /**
   * Add a lot to the pool for the given asset (and optional account).
   *
   * @param lot - The lot to add. Must have a positive amount.
   * @param account - Optional account ID for per-account pooling.
   */
  acquire(lot: Lot, account?: string): void {
    const key = this.poolKey(lot.asset, account);
    const existing = this.pools.get(key);
    if (existing) {
      existing.push(lot);
    } else {
      this.pools.set(key, [lot]);
    }
  }

  /**
   * Dispose of an asset amount using the given cost-basis strategy.
   *
   * @param asset - Ticker symbol of the asset to dispose.
   * @param amount - Amount to dispose (positive Decimal).
   * @param strategy - Which lots to consume (FIFO, HIFO, etc.).
   * @param disposedAt - When the disposal occurred.
   * @param account - Optional account ID for per-account pooling.
   * @returns The disposal result with proceeds defaulting to '0'.
   */
  dispose(
    asset: string,
    amount: Decimal,
    strategy: CostBasisStrategy,
    disposedAt: Date,
    account?: string,
  ): DisposalResult {
    const key = this.poolKey(asset, account);
    const available = this.pools.get(key) ?? [];

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
        const pool = this.pools.get(key);
        if (pool) {
          const idx = pool.indexOf(lot);
          if (idx !== -1) {
            pool.splice(idx, 1);
          }
        }
      } else {
        // Partially consumed — update the lot's remaining amount in place
        (lot as { amount: string }).amount = remaining.toString();
      }
    }

    // Determine holding period
    const acquiredAt = earliestAcquiredAt ?? disposedAt;
    const holdingDays = (disposedAt.getTime() - acquiredAt.getTime()) / MS_PER_DAY;
    const term: 'short-term' | 'long-term' =
      holdingDays > HOLDING_PERIOD_DAYS ? 'long-term' : 'short-term';

    // Proceeds default to '0' — the caller (computeTax) sets actual proceeds
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
   * Move lots from one account's pool to another without creating a disposal.
   *
   * Used for per-account self-transfers: when the user sends ETH from Coinbase
   * to a wallet, the lots move to the wallet's pool preserving their original
   * cost basis and acquisition date.
   *
   * Skips silently if `fromAccount === toAccount` (intra-account move).
   *
   * @param asset - Ticker symbol of the asset to transfer.
   * @param amount - Amount to transfer (positive Decimal).
   * @param fromAccount - Source account ID.
   * @param toAccount - Destination account ID.
   * @param strategy - Which lots to select from the source pool.
   * @param date - Date of the transfer (currently unused; reserved for future ordering support).
   * @returns `{ moved, shortfall }` — moved amount and any unmet shortfall.
   */
  transfer(
    asset: string,
    amount: Decimal,
    fromAccount: string,
    toAccount: string,
    strategy: CostBasisStrategy,
    _date: Date,
  ): { moved: Decimal; shortfall: Decimal } {
    if (fromAccount === toAccount) {
      return { moved: amount, shortfall: new Decimal(0) };
    }

    const sourceKey = this.poolKey(asset, fromAccount);
    const destKey = this.poolKey(asset, toAccount);
    const available = this.pools.get(sourceKey) ?? [];

    const selection = strategy.selectLots(available, amount);

    let moved = new Decimal(0);

    for (const { lot, amount: consumedAmountStr } of selection.consumed) {
      const consumedAmount = new Decimal(consumedAmountStr);
      const lotAmount = new Decimal(lot.amount);

      // Create a new lot in the dest pool with the same basis / acquisition date.
      // Use a class-level sequence so IDs stay unique across repeated transfer() calls.
      const transferredLot: Lot = {
        id: `${lot.id}-xfr${++this._xfrSeq}`,
        asset: lot.asset,
        amount: consumedAmountStr,
        unitCostUsd: lot.unitCostUsd,
        acquiredAt: lot.acquiredAt,
        sourceEntryId: lot.sourceEntryId,
      };

      const destPool = this.pools.get(destKey);
      if (destPool) {
        destPool.push(transferredLot);
      } else {
        this.pools.set(destKey, [transferredLot]);
      }

      // Remove consumed amount from source pool
      const remaining = lotAmount.minus(consumedAmount);
      if (remaining.isZero()) {
        const srcPool = this.pools.get(sourceKey);
        if (srcPool) {
          const idx = srcPool.indexOf(lot);
          if (idx !== -1) srcPool.splice(idx, 1);
        }
      } else {
        (lot as { amount: string }).amount = remaining.toString();
      }

      moved = moved.plus(consumedAmount);
    }

    const shortfall = amount.minus(moved);
    return { moved, shortfall };
  }

  /**
   * Get a read-only view of available lots for an asset.
   *
   * @param asset - Ticker symbol.
   * @param account - Optional account ID for per-account pooling.
   * @returns Array of lots (may be empty).
   */
  getAvailable(asset: string, account?: string): ReadonlyArray<Lot> {
    return this.pools.get(this.poolKey(asset, account)) ?? [];
  }

  /**
   * Sum the total remaining amount across all lots for an asset.
   *
   * @param asset - Ticker symbol.
   * @param account - Optional account ID for per-account pooling.
   * @returns Total amount as a Decimal.
   */
  totalAmount(asset: string, account?: string): Decimal {
    const lots = this.pools.get(this.poolKey(asset, account)) ?? [];
    return lots.reduce(
      (sum, lot) => sum.plus(new Decimal(lot.amount)),
      new Decimal(0),
    );
  }
}
