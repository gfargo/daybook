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

// ─────────────────────────────────────────────────────────────────────────
// Index builder
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a lookup index from acquisition records.
 *
 * Groups UTC calendar day numbers by asset symbol so that wash-sale
 * window probes are O(1) per day rather than O(acquisitions) per
 * disposal.
 *
 * @param acquisitions - All acquisition records to index.
 * @returns Map from asset symbol → Set of UTC calendar day numbers.
 */
function buildAcquisitionIndex(
  acquisitions: ReadonlyArray<AcquisitionRecord>,
): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const a of acquisitions) {
    let days = index.get(a.asset);
    if (days === undefined) {
      days = new Set<number>();
      index.set(a.asset, days);
    }
    days.add(utcDay(a.acquiredAt));
  }
  return index;
}

// ─────────────────────────────────────────────────────────────────────────
// Wash sale pass
// ─────────────────────────────────────────────────────────────────────────

/**
 * Apply wash-sale flags to all disposals.
 *
 * For each disposal with a negative `gainLoss` (a loss), checks
 * whether the same asset was acquired within ±30 calendar days
 * of the disposal date. Disposals with `gainLoss >= 0` are always
 * flagged `false` without performing any lookup.
 *
 * Complexity: O(A + D × W) where A = acquisitions, D = disposals,
 * W = window width (61). Builds an acquisition index once, then
 * probes 61 calendar days per loss disposal instead of scanning the
 * full acquisition list each time.
 *
 * @param disposals - The disposal results to flag.
 * @param acquisitions - All acquisition records to check against.
 * @returns A new array of DisposalResults with `washSaleFlag` set.
 */
export function applyWashSaleFlags(
  disposals: DisposalResult[],
  acquisitions: ReadonlyArray<AcquisitionRecord>,
): DisposalResult[] {
  // Build the per-asset day index once — O(A)
  const index = buildAcquisitionIndex(acquisitions);

  return disposals.map((d) => {
    // Gains and break-even are never wash-sale candidates
    if (new Decimal(d.gainLoss).gte(0)) {
      return { ...d, washSaleFlag: false };
    }

    const disposalDay = utcDay(d.disposedAt);
    const days = index.get(d.asset);

    // Asset never acquired → no wash-sale candidate
    if (days === undefined) {
      return { ...d, washSaleFlag: false };
    }

    // Probe the ±30-day window: 61 constant-time Set.has() calls — O(W)
    let flag = false;
    for (let delta = -WASH_SALE_WINDOW_DAYS; delta <= WASH_SALE_WINDOW_DAYS; delta++) {
      if (days.has(disposalDay + delta)) {
        flag = true;
        break;
      }
    }

    return { ...d, washSaleFlag: flag };
  });
}
