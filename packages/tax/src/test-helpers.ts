/**
 * Shared fast-check arbitrary generators for property-based testing.
 *
 * Provides `Arbitrary<TaxResult>`, `Arbitrary<DisposalResult>`, and
 * `Arbitrary<Date>` (2020–2030 range) generators used across
 * form-8949, schedule-d, txf-export, and format-helpers property tests.
 *
 * All generated values satisfy the invariants expected by the tax
 * formatters: valid dates, positive decimal amounts, and
 * `gainLoss === proceeds - costBasis`.
 */

import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import type { DisposalResult, IncomeSummary, TaxResult } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────

/** Minimum timestamp: 2020-01-01T00:00:00Z */
const MIN_DATE_MS = Date.UTC(2020, 0, 1);

/** Maximum timestamp: 2030-12-31T23:59:59Z */
const MAX_DATE_MS = Date.UTC(2030, 11, 31, 23, 59, 59);

/** Common crypto asset tickers for generated data. */
const ASSETS = ['BTC', 'ETH', 'SOL', 'MATIC', 'AVAX', 'LINK', 'UNI', 'DOGE'];

/** Cost-basis methods used in TaxResult. */
const METHODS = ['FIFO', 'HIFO', 'SpecificId'];

// ─── Date arbitrary ──────────────────────────────────────────────────────

/**
 * Arbitrary that generates valid `Date` objects in the 2020–2030 range.
 *
 * Useful for the IRS date format property test and any test needing
 * realistic tax-year dates.
 */
export const arbDate: fc.Arbitrary<Date> = fc
  .integer({ min: MIN_DATE_MS, max: MAX_DATE_MS })
  .map((ms) => new Date(ms));

// ─── Decimal string arbitrary ────────────────────────────────────────────

/**
 * Arbitrary that generates a positive decimal string with exactly
 * two decimal places, in the range [0.01, 999999.99].
 */
const arbDecimalString: fc.Arbitrary<string> = fc
  .float({ min: Math.fround(0.01), max: Math.fround(999999.99), noNaN: true })
  .map((n) => n.toFixed(2));

// ─── Ordered date pair arbitrary ─────────────────────────────────────────

/**
 * Arbitrary that generates a pair of dates where the first (acquiredAt)
 * is strictly before the second (disposedAt).
 */
const arbDatePair: fc.Arbitrary<{ acquiredAt: Date; disposedAt: Date }> = fc
  .tuple(
    fc.integer({ min: MIN_DATE_MS, max: MAX_DATE_MS - 1 }),
    fc.integer({ min: MIN_DATE_MS, max: MAX_DATE_MS - 1 }),
  )
  .map(([a, b]) => {
    const earlier = Math.min(a, b);
    const later = Math.max(a, b) + 1; // ensure strictly after
    return {
      acquiredAt: new Date(earlier),
      disposedAt: new Date(later),
    };
  });

// ─── DisposalResult arbitrary ────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `DisposalResult`.
 *
 * The `gainLoss` field is computed as `proceeds - costBasis` using
 * decimal.js to ensure numerical consistency with the formatters.
 * Dates are valid objects in the 2020–2030 range with `acquiredAt`
 * strictly before `disposedAt`.
 */
export const arbDisposalResult: fc.Arbitrary<DisposalResult> = fc
  .record({
    asset: fc.constantFrom(...ASSETS),
    amount: arbDecimalString,
    proceeds: arbDecimalString,
    costBasis: arbDecimalString,
    term: fc.constantFrom('short-term' as const, 'long-term' as const),
    dates: arbDatePair,
    sourceEntryId: fc.uuid(),
    lotCount: fc.integer({ min: 1, max: 3 }),
    washSaleFlag: fc.boolean(),
  })
  .map(({ asset, amount, proceeds, costBasis, term, dates, sourceEntryId, lotCount, washSaleFlag }) => {
    const gainLoss = new Decimal(proceeds).minus(new Decimal(costBasis)).toFixed(2);

    const lotsConsumed = Array.from({ length: lotCount }, (_, i) => ({
      lotId: `lot-${sourceEntryId}-${i}`,
      amount: new Decimal(amount).div(lotCount).toFixed(2),
      costBasis: new Decimal(costBasis).div(lotCount).toFixed(2),
    }));

    return {
      asset,
      amount,
      proceeds,
      costBasis,
      gainLoss,
      term,
      acquiredAt: dates.acquiredAt,
      disposedAt: dates.disposedAt,
      sourceEntryId,
      lotsConsumed,
      washSaleFlag,
    };
  });

// ─── IncomeSummary arbitrary ─────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `IncomeSummary` with 0–5 income events.
 */
const arbIncomeSummary: fc.Arbitrary<IncomeSummary> = fc
  .array(
    fc.record({
      entryId: fc.uuid(),
      asset: fc.constantFrom(...ASSETS),
      amount: arbDecimalString,
      usdValue: arbDecimalString,
    }),
    { minLength: 0, maxLength: 5 },
  )
  .map((events) => {
    const totalUsd = events
      .reduce((sum, e) => sum.plus(new Decimal(e.usdValue)), new Decimal('0'))
      .toFixed(2);

    const byAsset: Record<string, string> = {};
    for (const e of events) {
      byAsset[e.asset] = new Decimal(byAsset[e.asset] ?? '0')
        .plus(new Decimal(e.usdValue))
        .toFixed(2);
    }

    return { totalUsd, byAsset, events };
  });

// ─── TaxResult arbitrary ────────────────────────────────────────────────

/**
 * Arbitrary that generates a valid `TaxResult` with 0–100 disposals.
 *
 * All generated values satisfy the invariants expected by the tax
 * formatters: valid dates, positive decimal amounts, consistent
 * `gainLoss` computation, and realistic field values.
 */
export const arbTaxResult: fc.Arbitrary<TaxResult> = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    method: fc.constantFrom(...METHODS),
    disposals: fc.array(arbDisposalResult, { minLength: 0, maxLength: 100 }),
    income: arbIncomeSummary,
    warnings: fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 0, maxLength: 5 }),
    unpricedEvents: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
  });
