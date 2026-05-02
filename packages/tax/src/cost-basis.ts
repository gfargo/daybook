/**
 * Cost-basis strategy interface and lot selection types.
 *
 * Defines the contract that FIFO, HIFO (and future LIFO / Specific ID)
 * implementations must satisfy. The LotBook calls `selectLots` during
 * disposal to determine which lots to consume.
 *
 * FIFO and HIFO implementations are added in task 7.2.
 */

import Decimal from 'decimal.js';
import type { Lot } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Lot selection result
// ─────────────────────────────────────────────────────────────────────────

/**
 * The result of a cost-basis strategy selecting lots for a disposal.
 *
 * `consumed` lists each lot (or partial lot) to be used, with the
 * amount taken from that lot. `remainder` is '0' when the disposal
 * is fully covered, or a positive decimal string when available lots
 * are insufficient.
 */
export interface LotSelection {
  /** Lots selected for consumption, with the amount taken from each. */
  consumed: Array<{ lot: Lot; amount: string }>;
  /** Amount not covered by available lots. '0' if fully covered. */
  remainder: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Strategy interface
// ─────────────────────────────────────────────────────────────────────────

/**
 * A cost-basis strategy determines which lots to dispose when selling
 * an asset. Different strategies produce different tax outcomes.
 *
 * - FIFO: oldest lots first (IRS default)
 * - HIFO: highest-cost lots first (minimizes current-year tax)
 * - LIFO: newest lots first (v1.1)
 * - Specific ID: user picks (v2)
 */
export interface CostBasisStrategy {
  /** Human-readable name (e.g. 'FIFO', 'HIFO'). */
  readonly name: string;

  /**
   * Select lots to consume for a disposal of the given amount.
   *
   * The strategy sorts or filters the available lots according to its
   * policy, then takes from the front until the amount is covered.
   * Partial lot consumption is handled by the caller (LotBook).
   *
   * @param available - Read-only view of lots for the asset being disposed.
   * @param amount - The total amount to dispose (always positive).
   * @returns The selected lots and any uncovered remainder.
   */
  selectLots(available: ReadonlyArray<Lot>, amount: Decimal): LotSelection;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Consume lots from a pre-sorted queue until the requested amount is
 * covered. Handles partial lot splitting — when a lot has more than
 * enough to cover the remaining need, only the required portion is
 * taken and the lot reference is included with the partial amount.
 *
 * All arithmetic uses decimal.js to avoid floating-point errors.
 *
 * @param sorted - Lots already sorted by the caller's strategy policy.
 * @param amount - Total amount to consume (always positive).
 * @returns A {@link LotSelection} with consumed lots and any uncovered remainder.
 */
function takeFromQueue(sorted: ReadonlyArray<Lot>, amount: Decimal): LotSelection {
  const consumed: Array<{ lot: Lot; amount: string }> = [];
  let remaining = amount;

  for (const lot of sorted) {
    if (remaining.isZero()) break;

    const lotAmount = new Decimal(lot.amount);

    if (lotAmount.lte(remaining)) {
      // Fully consume this lot
      consumed.push({ lot, amount: lotAmount.toString() });
      remaining = remaining.minus(lotAmount);
    } else {
      // Partially consume this lot
      consumed.push({ lot, amount: remaining.toString() });
      remaining = new Decimal(0);
    }
  }

  return { consumed, remainder: remaining.toString() };
}

// ─────────────────────────────────────────────────────────────────────────
// FIFO strategy
// ─────────────────────────────────────────────────────────────────────────

/**
 * First In, First Out — the IRS default cost-basis method.
 *
 * Selects lots in ascending order of acquisition date so that the
 * oldest holdings are disposed first.
 */
export const FIFO: CostBasisStrategy = {
  name: 'FIFO',
  selectLots(available: ReadonlyArray<Lot>, amount: Decimal): LotSelection {
    const sorted = [...available].sort(
      (a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime(),
    );
    return takeFromQueue(sorted, amount);
  },
};

// ─────────────────────────────────────────────────────────────────────────
// HIFO strategy
// ─────────────────────────────────────────────────────────────────────────

/**
 * Highest In, First Out — minimizes current-year tax liability.
 *
 * Selects lots in descending order of unit cost so that the most
 * expensive holdings are disposed first, maximizing cost basis and
 * reducing reported gains.
 */
export const HIFO: CostBasisStrategy = {
  name: 'HIFO',
  selectLots(available: ReadonlyArray<Lot>, amount: Decimal): LotSelection {
    const sorted = [...available].sort(
      (a, b) => new Decimal(b.unitCostUsd).cmp(new Decimal(a.unitCostUsd)),
    );
    return takeFromQueue(sorted, amount);
  },
};
