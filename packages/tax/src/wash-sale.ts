/**
 * Wash sale flagging pass.
 *
 * Scans DisposalResults for potential wash-sale candidates: disposals
 * with a loss where the same asset was acquired within ±30 calendar
 * days (UTC). Sets `washSaleFlag` on every disposal — `true` for
 * candidates, `false` otherwise.
 *
 * This is informational only — no disallowance amounts are computed.
 * The flag helps users identify disposals to discuss with their
 * accountant.
 *
 * All date comparisons use UTC calendar days (floor of ms / 86 400 000).
 */

import Decimal from 'decimal.js';
import type { DisposalResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Milliseconds in one day, used for UTC calendar-day conversion. */
const MS_PER_DAY = 86_400_000;

/** Wash sale window in calendar days (before and after). */
const WASH_SALE_WINDOW_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert a Date to a UTC calendar day number.
 *
 * @param date - The date to convert.
 * @returns Integer day number (days since epoch, UTC).
 */
function utcDay(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

// ─────────────────────────────────────────────────────────────────────────
// Wash sale pass
// ─────────────────────────────────────────────────────────────────────────

/**
 * An acquisition record used for wash-sale window matching.
 */
export interface AcquisitionRecord {
  /** Ticker symbol of the acquired asset. */
  asset: string;
  /** When the acquisition occurred. */
  acquiredAt: Date;
}

/**
 * Apply wash-sale flags to all disposals.
 *
 * For each disposal with a negative `gainLoss` (a loss), checks
 * whether the same asset was acquired within ±30 calendar days
 * of the disposal date. Disposals with `gainLoss >= 0` are always
 * flagged `false` without performing any lookup.
 *
 * @param disposals - The disposal results to flag.
 * @param acquisitions - All acquisition records to check against.
 * @returns A new array of DisposalResults with `washSaleFlag` set.
 */
export function applyWashSaleFlags(
  disposals: DisposalResult[],
  acquisitions: ReadonlyArray<AcquisitionRecord>,
): DisposalResult[] {
  return disposals.map((d) => {
    // Gains and break-even are never wash-sale candidates
    if (new Decimal(d.gainLoss).gte(0)) {
      return { ...d, washSaleFlag: false };
    }

    const disposalDay = utcDay(d.disposedAt);

    const flag = acquisitions.some(
      (a) =>
        a.asset === d.asset &&
        Math.abs(utcDay(a.acquiredAt) - disposalDay) <= WASH_SALE_WINDOW_DAYS,
    );

    return { ...d, washSaleFlag: flag };
  });
}
