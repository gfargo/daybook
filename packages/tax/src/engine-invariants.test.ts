/**
 * Property-based invariants for the tax engine (computeTax) and exporters.
 *
 * Extends the existing lot-book property tests (lot-book.test.ts) and
 * formatter property tests (form-8949.test.ts, schedule-d.test.ts) with
 * engine-level assertions that run `computeTax()` directly.
 *
 * ## Invariants tested here (engine-level — not covered elsewhere)
 *
 * 1. **Basis conservation** — for every DisposalResult,
 *    `Σ lotsConsumed[].costBasis === disposal.costBasis`.
 *    Guards against the LotBook emitting a rounded aggregate that diverges
 *    from its own per-lot records.
 *
 * 2. **Fee conservation** — for a single sell with a known fee under
 *    `subtract-from-proceeds`, the fee reduces proceeds by the exact fee
 *    amount: `rawProceeds - netProceeds === feeUsd`. A second case covers
 *    a single trade with two out-legs (e.g. ETH and BTC sold together)
 *    and asserts the fee is deducted exactly once in total across the
 *    trade's disposals — a single-out-leg trade can't distinguish "once
 *    per trade" from "once per leg".
 *    Guards against bug B5 (fee allocated once per trade vs once per leg).
 *
 * 3. **Term partitioning** — every DisposalResult produced by computeTax
 *    has `disposal.term` agreeing with an independent reference calendar-
 *    anniversary calculation (not a call to `classifyTerm` itself, so a
 *    regression inside `classifyTerm` is actually caught).
 *    Guards against bug B4 (365-day threshold vs calendar anniversary).
 *
 * 4. **Method ordering** — for a pure-gain history, HIFO total gain <=
 *    FIFO total gain. HIFO sells highest-cost lots first, minimising gain.
 *
 * 5. **Determinism** — `computeTax(h, cfg)` called twice on the same
 *    input produces deep-equal `TaxResult` objects. A permutation variant
 *    also asserts the result is unchanged when the same entries are
 *    shuffled into a different input order (computeTax sorts internally,
 *    so order must not matter). Guards against bug B30.
 *
 * 6. **Cross-format agreement** — CSV footer, Form 8949 page totals,
 *    Schedule D lines, and TXF records all reconcile to the same
 *    short/long-term gain totals as `arbTaxResult` disposals. TXF is
 *    checked across all three checkbox categories (A, B, C) so the full
 *    short/long tax-line mapping table is exercised, not just checkbox C.
 *    (Uses arbTaxResult — already 2 dp — so rounding is exact.)
 *
 * ## What is NOT tested here (already covered)
 * - Quantity/lot conservation at LotBook level — lot-book.test.ts CP3.
 * - Decimal precision at LotBook level — lot-book.test.ts CP4.
 * - Form 8949 row/term partitioning and pagination — form-8949.test.ts.
 * - Schedule D ↔ Form 8949 reconciliation — schedule-d.test.ts P5/P6.
 * - classifyTerm boundary correctness — holding-period.test.ts.
 *
 * @see packages/tax/src/lot-book.test.ts
 * @see packages/tax/src/form-8949.test.ts
 * @see packages/tax/src/schedule-d.test.ts
 * @see packages/tax/src/holding-period.test.ts
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { parse as parseCsv } from 'csv-parse/sync';

import { computeTax } from './compute.js';
import { FIFO, HIFO } from './cost-basis.js';
import { formatCsv } from './csv-export.js';
import { buildForm8949Data } from './form-8949.js';
import { buildScheduleDData } from './schedule-d.js';
import { formatTxf, parseTxf } from './txf-export.js';
import { arbTaxResult, arbLedgerHistory, arbPureGainHistory, HISTORY_TAX_YEAR } from './test-helpers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Small epsilon for Decimal comparisons that may accumulate tiny rounding. */
const EPSILON = new Decimal('1e-9');

/**
 * Sum gainLoss for all disposals split by term.
 *
 * @returns `{ short, long }` as Decimal values.
 */
function splitGains(disposals: { gainLoss: string; term: string }[]): {
  short: Decimal;
  long: Decimal;
} {
  let short = new Decimal(0);
  let long = new Decimal(0);
  for (const d of disposals) {
    if (d.term === 'short-term') {
      short = short.plus(new Decimal(d.gainLoss));
    } else {
      long = long.plus(new Decimal(d.gainLoss));
    }
  }
  return { short, long };
}

/**
 * Parse the CSV footer produced by `formatCsv()` and return
 * short-term gain and long-term gain as Decimal strings.
 *
 * The footer section format is:
 * ```
 * Summary
 * Short-Term Gain,<value>
 * Long-Term Gain,<value>
 * Total Income,<value>
 * ```
 */
function parseCsvFooterGains(csv: string): { short: Decimal; long: Decimal } {
  // Parse with the same library (csv-parse) that formatCsv's csv-stringify
  // counterpart writes with, rather than hand-rolling quote handling. Rows
  // have varying column counts (data rows vs. 1-2 col summary rows), so
  // relax_column_count is required.
  const records: string[][] = parseCsv(csv, { relax_column_count: true });
  let short = new Decimal(0);
  let long = new Decimal(0);

  for (const row of records) {
    if (row[0] === 'Short-Term Gain' && row[1] !== undefined) {
      short = new Decimal(row[1]);
    } else if (row[0] === 'Long-Term Gain' && row[1] !== undefined) {
      long = new Decimal(row[1]);
    }
  }

  return { short, long };
}

/**
 * Independent reference implementation of "held more than one year" by
 * calendar anniversary — deliberately NOT calling `classifyTerm` (the
 * function under test), so a regression inside `classifyTerm` (e.g. B4's
 * fixed-365-day threshold) is actually caught rather than trivially
 * agreeing with itself.
 *
 * Builds the one-year-anniversary instant via a fresh `Date.UTC(...)` call
 * from `acquiredAt`'s extracted UTC components (year+1, same month/day/time),
 * rather than mutating a cloned Date via `setUTCFullYear` as the engine
 * does. A holding is long-term only if `disposedAt` is strictly after that
 * anniversary.
 */
function referenceClassifyTerm(acquiredAt: Date, disposedAt: Date): 'short-term' | 'long-term' {
  const anniversaryMs = Date.UTC(
    acquiredAt.getUTCFullYear() + 1,
    acquiredAt.getUTCMonth(),
    acquiredAt.getUTCDate(),
    acquiredAt.getUTCHours(),
    acquiredAt.getUTCMinutes(),
    acquiredAt.getUTCSeconds(),
    acquiredAt.getUTCMilliseconds(),
  );
  return disposedAt.getTime() > anniversaryMs ? 'long-term' : 'short-term';
}

/**
 * Deterministic pseudo-random number generator (mulberry32), seeded by a
 * plain integer so permutation tests are reproducible from a fast-check
 * seed without depending on fast-check's own shuffling internals.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically shuffle an array (Fisher-Yates) using a seeded PRNG.
 * Used to test that `computeTax` output is invariant under input-order
 * permutation (guards bug B30).
 */
function shuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ─── Invariant 1: Basis conservation ─────────────────────────────────────

describe('Invariant 1: Basis conservation — lotsConsumed sums match disposal.costBasis', () => {
  /**
   * For every DisposalResult produced by computeTax, the sum of each
   * lot's costBasis entry equals disposal.costBasis.
   *
   * The LotBook computes per-lot costBasis as `consumedAmount * unitCostUsd`
   * and the disposal result inherits the aggregate.  This invariant ensures
   * both stay in sync even after partial-lot splits.
   */
  it('holds for FIFO over random histories', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const result = computeTax(entries, {
          method: FIFO,
          holdingPeriodDays: 365,
          year: HISTORY_TAX_YEAR,
        });

        for (const disposal of result.disposals) {
          const sumFromLots = disposal.lotsConsumed.reduce(
            (sum, lc) => sum.plus(new Decimal(lc.costBasis)),
            new Decimal(0),
          );
          const reportedBasis = new Decimal(disposal.costBasis);
          const diff = sumFromLots.minus(reportedBasis).abs();
          expect(diff.lte(EPSILON)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('holds for HIFO over random histories', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const result = computeTax(entries, {
          method: HIFO,
          holdingPeriodDays: 365,
          year: HISTORY_TAX_YEAR,
        });

        for (const disposal of result.disposals) {
          const sumFromLots = disposal.lotsConsumed.reduce(
            (sum, lc) => sum.plus(new Decimal(lc.costBasis)),
            new Decimal(0),
          );
          const reportedBasis = new Decimal(disposal.costBasis);
          const diff = sumFromLots.minus(reportedBasis).abs();
          expect(diff.lte(EPSILON)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Invariant 2: Fee conservation ───────────────────────────────────────

describe('Invariant 2: Fee conservation — subtract-from-proceeds reduces proceeds by exact fee', () => {
  /**
   * For a single-leg sell with a known fee under subtract-from-proceeds,
   * `rawProceeds - netProceeds === feeUsd`.
   *
   * The generator builds a controlled single-asset history:
   *   buy N units at buyPrice → sell N units at sellPrice with fee feeUsd.
   *
   * Guards bug B5: fee allocated once per trade vs once per out-leg.
   */
  it('fee deduction equals the fee leg USD value for a single-leg sell', () => {
    // Use a controlled arbitrary: one buy followed by one sell with fee
    const singleFeeTradeArb = fc.record({
      qtyHundredths: fc.integer({ min: 1, max: 10_000 }),
      buyPriceHundredths: fc.integer({ min: 1, max: 100_000 }),
      sellPriceHundredths: fc.integer({ min: 1, max: 100_000 }),
      feeHundredths: fc.integer({ min: 1, max: 500 }),
    }).map(({ qtyHundredths, buyPriceHundredths, sellPriceHundredths, feeHundredths }) => {
      const qty = new Decimal(qtyHundredths).div(100).toFixed(2);
      const buyPrice = new Decimal(buyPriceHundredths).div(100).toFixed(2);
      const sellPrice = new Decimal(sellPriceHundredths).div(100).toFixed(2);
      const feeUsd = new Decimal(feeHundredths).div(100).toFixed(2);
      const buyTotal = new Decimal(qty).mul(new Decimal(buyPrice)).toFixed(2);
      const sellTotal = new Decimal(qty).mul(new Decimal(sellPrice)).toFixed(2);

      return {
        feeUsd,
        rawProceeds: new Decimal(sellTotal),
        entries: [
          {
            id: 'fee-buy',
            timestamp: new Date(Date.UTC(2022, 0, 1)),
            type: 'trade' as const,
            legs: [
              { asset: 'ETH', amount: qty, amountUsdAtTime: buyTotal },
              { asset: 'USD', amount: `-${buyTotal}`, amountUsdAtTime: buyTotal },
            ],
            rawEventIds: ['fee-buy'],
          },
          {
            id: 'fee-sell',
            timestamp: new Date(Date.UTC(2023, 0, 1)),
            type: 'trade' as const,
            legs: [
              { asset: 'ETH', amount: `-${qty}`, amountUsdAtTime: sellTotal },
              { asset: 'USD', amount: sellTotal, amountUsdAtTime: sellTotal },
              // Fee leg: reduces proceeds
              { asset: 'USD', amount: `-${feeUsd}`, amountUsdAtTime: feeUsd, feeFlag: true as const },
            ],
            rawEventIds: ['fee-sell'],
          },
        ],
      };
    });

    fc.assert(
      fc.property(singleFeeTradeArb, ({ feeUsd, rawProceeds, entries }) => {
        const result = computeTax(entries, {
          method: FIFO,
          holdingPeriodDays: 365,
          year: 2023,
          feeAllocation: 'subtract-from-proceeds',
        });

        expect(result.disposals).toHaveLength(1);
        const disposal = result.disposals[0]!;

        // Net proceeds = rawProceeds - feeUsd
        const netProceeds = new Decimal(disposal.proceeds);
        const deducted = rawProceeds.minus(netProceeds);
        const feeDec = new Decimal(feeUsd);

        const diff = deducted.minus(feeDec).abs();
        expect(diff.lte(EPSILON)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  /**
   * B5 (commit efc84aa) only manifests when a single trade has more than
   * one out-leg: the bug applied the full trade fee to *each* out-leg
   * instead of splitting it once across the trade. A single-out-leg trade
   * can't distinguish "once per trade" from "once per leg" — this test
   * builds one trade entry with two out-legs (ETH and BTC sold together)
   * and a single fee leg, and asserts the fee is deducted exactly once in
   * total across the trade's resulting disposals.
   */
  it('fee deduction sums to exactly the trade fee across a multi-out-leg trade', () => {
    const multiLegFeeTradeArb = fc.record({
      qty1Hundredths: fc.integer({ min: 1, max: 10_000 }),
      qty2Hundredths: fc.integer({ min: 1, max: 10_000 }),
      buyPrice1Hundredths: fc.integer({ min: 1, max: 100_000 }),
      buyPrice2Hundredths: fc.integer({ min: 1, max: 100_000 }),
      sellPrice1Hundredths: fc.integer({ min: 1, max: 100_000 }),
      sellPrice2Hundredths: fc.integer({ min: 1, max: 100_000 }),
      feeHundredths: fc.integer({ min: 1, max: 500 }),
    }).map(
      ({
        qty1Hundredths,
        qty2Hundredths,
        buyPrice1Hundredths,
        buyPrice2Hundredths,
        sellPrice1Hundredths,
        sellPrice2Hundredths,
        feeHundredths,
      }) => {
        const qty1 = new Decimal(qty1Hundredths).div(100).toFixed(2);
        const qty2 = new Decimal(qty2Hundredths).div(100).toFixed(2);
        const buyPrice1 = new Decimal(buyPrice1Hundredths).div(100).toFixed(2);
        const buyPrice2 = new Decimal(buyPrice2Hundredths).div(100).toFixed(2);
        const sellPrice1 = new Decimal(sellPrice1Hundredths).div(100).toFixed(2);
        const sellPrice2 = new Decimal(sellPrice2Hundredths).div(100).toFixed(2);
        const feeUsd = new Decimal(feeHundredths).div(100).toFixed(2);

        const buyTotal1 = new Decimal(qty1).mul(new Decimal(buyPrice1)).toFixed(2);
        const buyTotal2 = new Decimal(qty2).mul(new Decimal(buyPrice2)).toFixed(2);
        const sellTotal1 = new Decimal(qty1).mul(new Decimal(sellPrice1)).toFixed(2);
        const sellTotal2 = new Decimal(qty2).mul(new Decimal(sellPrice2)).toFixed(2);

        return {
          feeUsd,
          rawProceedsTotal: new Decimal(sellTotal1).plus(new Decimal(sellTotal2)),
          entries: [
            {
              id: 'multi-fee-buy-eth',
              timestamp: new Date(Date.UTC(2022, 0, 1)),
              type: 'trade' as const,
              legs: [
                { asset: 'ETH', amount: qty1, amountUsdAtTime: buyTotal1 },
                { asset: 'USD', amount: `-${buyTotal1}`, amountUsdAtTime: buyTotal1 },
              ],
              rawEventIds: ['multi-fee-buy-eth'],
            },
            {
              id: 'multi-fee-buy-btc',
              timestamp: new Date(Date.UTC(2022, 0, 2)),
              type: 'trade' as const,
              legs: [
                { asset: 'BTC', amount: qty2, amountUsdAtTime: buyTotal2 },
                { asset: 'USD', amount: `-${buyTotal2}`, amountUsdAtTime: buyTotal2 },
              ],
              rawEventIds: ['multi-fee-buy-btc'],
            },
            {
              // A single trade entry with two out-legs (ETH and BTC sold
              // together) and one fee leg — the shape that distinguishes
              // "fee once per trade" from "fee once per out-leg".
              id: 'multi-fee-sell',
              timestamp: new Date(Date.UTC(2023, 0, 1)),
              type: 'trade' as const,
              legs: [
                { asset: 'ETH', amount: `-${qty1}`, amountUsdAtTime: sellTotal1 },
                { asset: 'USD', amount: sellTotal1, amountUsdAtTime: sellTotal1 },
                { asset: 'BTC', amount: `-${qty2}`, amountUsdAtTime: sellTotal2 },
                { asset: 'USD', amount: sellTotal2, amountUsdAtTime: sellTotal2 },
                { asset: 'USD', amount: `-${feeUsd}`, amountUsdAtTime: feeUsd, feeFlag: true as const },
              ],
              rawEventIds: ['multi-fee-sell'],
            },
          ],
        };
      },
    );

    fc.assert(
      fc.property(multiLegFeeTradeArb, ({ feeUsd, rawProceedsTotal, entries }) => {
        const result = computeTax(entries, {
          method: FIFO,
          holdingPeriodDays: 365,
          year: 2023,
          feeAllocation: 'subtract-from-proceeds',
        });

        // Both out-legs (ETH and BTC) belong to the same trade entry.
        const tradeDisposals = result.disposals.filter((d) => d.sourceEntryId === 'multi-fee-sell');
        expect(tradeDisposals).toHaveLength(2);

        const netProceedsTotal = tradeDisposals.reduce(
          (sum, d) => sum.plus(new Decimal(d.proceeds)),
          new Decimal(0),
        );
        const deducted = rawProceedsTotal.minus(netProceedsTotal);
        const feeDec = new Decimal(feeUsd);

        // If the fee were (incorrectly) applied once per out-leg instead of
        // once per trade, `deducted` would be ~2x feeUsd instead of feeUsd.
        const diff = deducted.minus(feeDec).abs();
        expect(diff.lte(EPSILON)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Invariant 3: Term partitioning ──────────────────────────────────────

describe('Invariant 3: Term partitioning — disposal.term matches an independent calendar-anniversary reference', () => {
  /**
   * For every DisposalResult produced by computeTax, the reported term
   * equals `referenceClassifyTerm(disposal.acquiredAt, disposal.disposedAt)`
   * — a reference implementation independent of the engine's own
   * `classifyTerm`, so a regression inside `classifyTerm` is caught rather
   * than silently agreeing with itself.
   *
   * Guards bug B4: the engine used to classify by day count (365) rather
   * than calendar anniversary, misclassifying leap-year holdings.
   * Commit ee9e5c8 fixed this; this invariant keeps it fixed.
   */
  it('holds for FIFO over random histories', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const result = computeTax(entries, {
          method: FIFO,
          holdingPeriodDays: 365,
          year: HISTORY_TAX_YEAR,
        });

        for (const disposal of result.disposals) {
          const expected = referenceClassifyTerm(disposal.acquiredAt, disposal.disposedAt);
          expect(disposal.term).toBe(expected);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('holds for HIFO over random histories', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const result = computeTax(entries, {
          method: HIFO,
          holdingPeriodDays: 365,
          year: HISTORY_TAX_YEAR,
        });

        for (const disposal of result.disposals) {
          const expected = referenceClassifyTerm(disposal.acquiredAt, disposal.disposedAt);
          expect(disposal.term).toBe(expected);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Invariant 4: Method ordering ────────────────────────────────────────

describe('Invariant 4: Method ordering — HIFO total gain <= FIFO total gain for pure-gain histories', () => {
  /**
   * For a history where every disposal produces a positive gain
   * (sell price > buy price for all lots), HIFO minimises total gain
   * by consuming the highest-cost lots first.
   *
   * Therefore `totalGain(HIFO) <= totalGain(FIFO)`.
   *
   * This test verifies that the method selection is meaningful — if HIFO
   * ever produced a higher gain than FIFO on a pure-gain history, the
   * lot selection strategy would be broken.
   */
  it('HIFO total gain <= FIFO total gain for pure-gain histories', () => {
    fc.assert(
      fc.property(arbPureGainHistory, (entries) => {
        const cfg = { holdingPeriodDays: 365, year: HISTORY_TAX_YEAR };

        const fifoResult = computeTax(entries, { method: FIFO, ...cfg });
        const hifoResult = computeTax(entries, { method: HIFO, ...cfg });

        const fifoGain = fifoResult.disposals.reduce(
          (sum, d) => sum.plus(new Decimal(d.gainLoss)),
          new Decimal(0),
        );
        const hifoGain = hifoResult.disposals.reduce(
          (sum, d) => sum.plus(new Decimal(d.gainLoss)),
          new Decimal(0),
        );

        // HIFO gain should never exceed FIFO gain on a pure-gain history
        expect(hifoGain.lte(fifoGain.plus(EPSILON))).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Invariant 5: Determinism ─────────────────────────────────────────────

describe('Invariant 5: Determinism — same input produces identical output, invariant under permutation', () => {
  /**
   * Calling `computeTax` twice on the same entry list produces
   * deep-equal `TaxResult` objects (ignoring Date reference identity —
   * we compare via toISOString()).
   *
   * The engine resets its internal `lotIdCounter` at the start of each
   * call, guaranteeing lot IDs are identical across runs.
   */
  it('computeTax is deterministic for FIFO', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const cfg = { method: FIFO, holdingPeriodDays: 365, year: HISTORY_TAX_YEAR };
        const result1 = computeTax(entries, cfg);
        const result2 = computeTax(entries, cfg);

        // Compare disposal arrays element-by-element using stable fields
        expect(result1.disposals.length).toBe(result2.disposals.length);
        for (let i = 0; i < result1.disposals.length; i++) {
          const d1 = result1.disposals[i]!;
          const d2 = result2.disposals[i]!;
          expect(d1.asset).toBe(d2.asset);
          expect(d1.amount).toBe(d2.amount);
          expect(d1.proceeds).toBe(d2.proceeds);
          expect(d1.costBasis).toBe(d2.costBasis);
          expect(d1.gainLoss).toBe(d2.gainLoss);
          expect(d1.term).toBe(d2.term);
          expect(d1.acquiredAt.toISOString()).toBe(d2.acquiredAt.toISOString());
          expect(d1.disposedAt.toISOString()).toBe(d2.disposedAt.toISOString());
          expect(d1.sourceEntryId).toBe(d2.sourceEntryId);
          expect(d1.lotsConsumed).toEqual(d2.lotsConsumed);
        }

        expect(result1.income.totalUsd).toBe(result2.income.totalUsd);
        expect(result1.warnings).toEqual(result2.warnings);
        expect(result1.unpricedEvents).toEqual(result2.unpricedEvents);
      }),
      { numRuns: 150 },
    );
  });

  it('computeTax is deterministic for HIFO', () => {
    fc.assert(
      fc.property(arbLedgerHistory, (entries) => {
        const cfg = { method: HIFO, holdingPeriodDays: 365, year: HISTORY_TAX_YEAR };
        const result1 = computeTax(entries, cfg);
        const result2 = computeTax(entries, cfg);

        expect(result1.disposals.length).toBe(result2.disposals.length);
        for (let i = 0; i < result1.disposals.length; i++) {
          const d1 = result1.disposals[i]!;
          const d2 = result2.disposals[i]!;
          expect(d1.proceeds).toBe(d2.proceeds);
          expect(d1.costBasis).toBe(d2.costBasis);
          expect(d1.gainLoss).toBe(d2.gainLoss);
          expect(d1.lotsConsumed).toEqual(d2.lotsConsumed);
        }
      }),
      { numRuns: 150 },
    );
  });

  /**
   * `computeTax` sorts entries chronologically before processing, so the
   * *order in which entries are passed in* must not affect the result.
   * `arbLedgerHistory` already uses strictly increasing per-entry
   * timestamps, so shuffling the input array is a pure permutation test
   * with no timestamp ties to complicate it.
   *
   * Guards bug B30: output must be invariant under input permutation.
   */
  it('computeTax output is invariant under input-order permutation (FIFO)', () => {
    fc.assert(
      fc.property(arbLedgerHistory, fc.integer(), (entries, seed) => {
        const cfg = { method: FIFO, holdingPeriodDays: 365, year: HISTORY_TAX_YEAR };
        const original = computeTax(entries, cfg);
        const permuted = computeTax(shuffle(entries, seed), cfg);

        expect(permuted.disposals.length).toBe(original.disposals.length);
        for (let i = 0; i < original.disposals.length; i++) {
          const d1 = original.disposals[i]!;
          const d2 = permuted.disposals[i]!;
          expect(d2.asset).toBe(d1.asset);
          expect(d2.amount).toBe(d1.amount);
          expect(d2.proceeds).toBe(d1.proceeds);
          expect(d2.costBasis).toBe(d1.costBasis);
          expect(d2.gainLoss).toBe(d1.gainLoss);
          expect(d2.term).toBe(d1.term);
          expect(d2.acquiredAt.toISOString()).toBe(d1.acquiredAt.toISOString());
          expect(d2.disposedAt.toISOString()).toBe(d1.disposedAt.toISOString());
          expect(d2.sourceEntryId).toBe(d1.sourceEntryId);
          expect(d2.lotsConsumed).toEqual(d1.lotsConsumed);
        }

        expect(permuted.income.totalUsd).toBe(original.income.totalUsd);
        expect(permuted.warnings).toEqual(original.warnings);
        expect(permuted.unpricedEvents).toEqual(original.unpricedEvents);
      }),
      { numRuns: 150 },
    );
  });

  it('computeTax output is invariant under input-order permutation (HIFO)', () => {
    fc.assert(
      fc.property(arbLedgerHistory, fc.integer(), (entries, seed) => {
        const cfg = { method: HIFO, holdingPeriodDays: 365, year: HISTORY_TAX_YEAR };
        const original = computeTax(entries, cfg);
        const permuted = computeTax(shuffle(entries, seed), cfg);

        expect(permuted.disposals.length).toBe(original.disposals.length);
        for (let i = 0; i < original.disposals.length; i++) {
          const d1 = original.disposals[i]!;
          const d2 = permuted.disposals[i]!;
          expect(d2.proceeds).toBe(d1.proceeds);
          expect(d2.costBasis).toBe(d1.costBasis);
          expect(d2.gainLoss).toBe(d1.gainLoss);
          expect(d2.lotsConsumed).toEqual(d1.lotsConsumed);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Invariant 6: Cross-format agreement ────────────────────────────────

describe('Invariant 6: Cross-format agreement — CSV, Form 8949, Schedule D, TXF reconcile', () => {
  /**
   * For any arbTaxResult (already 2-dp), the short-term gain and
   * long-term gain totals are consistent across all four export formats.
   *
   * Note: This test uses arbTaxResult (synthetic, 2-dp values) rather
   * than computeTax output because the formatters apply formatMoney
   * (toFixed(2)) and comparing against non-2dp computeTax output would
   * require additional normalization. The arbTaxResult approach validates
   * the formatter pipeline in isolation — the engine-level consistency
   * is validated by Invariants 1–5.
   *
   * ## Format sources for each term's totals
   * - **CSV**: `Short-Term Gain` / `Long-Term Gain` rows in summary footer.
   * - **Form 8949**: sum of `partITotals.gainLoss` (Part I = short-term)
   *   and `partIITotals.gainLoss` (Part II = long-term) across all pages.
   * - **Schedule D**: `line7` = short-term net, `line15` = long-term net.
   * - **TXF**: parsed records, grouped by SHORT_TERM_LINES / LONG_TERM_LINES,
   *   sum `proceeds - costBasis` as a proxy for gain.
   *
   * ## What the test checks
   * CSV, 8949, and Schedule D all reconcile to the same toFixed(2) totals
   * as the sum of disposal gainLoss values split by term.
   * TXF records are checked for internal consistency (proceeds − costBasis
   * matches the disposal gainLoss, summed by term).
   */
  it('CSV footer, Form 8949 page totals, and Schedule D lines agree on short/long gains', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const { short: expectedShort, long: expectedLong } = splitGains(taxResult.disposals);
        const expectedShortStr = expectedShort.toFixed(2);
        const expectedLongStr = expectedLong.toFixed(2);

        // ── CSV footer ──────────────────────────────────────────────
        const csv = formatCsv(taxResult);
        const { short: csvShort, long: csvLong } = parseCsvFooterGains(csv);
        expect(csvShort.toFixed(2)).toBe(expectedShortStr);
        expect(csvLong.toFixed(2)).toBe(expectedLongStr);

        // ── Form 8949 page totals ───────────────────────────────────
        const form8949 = buildForm8949Data(taxResult);
        let partIGainLoss = new Decimal(0);
        let partIIGainLoss = new Decimal(0);
        for (const page of form8949.pages) {
          partIGainLoss = partIGainLoss.plus(new Decimal(page.partITotals.gainLoss));
          partIIGainLoss = partIIGainLoss.plus(new Decimal(page.partIITotals.gainLoss));
        }
        expect(partIGainLoss.toFixed(2)).toBe(expectedShortStr);
        expect(partIIGainLoss.toFixed(2)).toBe(expectedLongStr);

        // ── Schedule D ──────────────────────────────────────────────
        const schedD = buildScheduleDData(taxResult);
        expect(schedD.line7).toBe(expectedShortStr);
        expect(schedD.line15).toBe(expectedLongStr);
      }),
      { numRuns: 100 },
    );
  });

  it('TXF parsed records produce proceeds and cost basis that reconcile to disposal gainLoss totals', () => {
    /** Short-term TXF tax line numbers. */
    const SHORT_TERM_LINES = new Set([321, 711, 712]);
    /** Long-term TXF tax line numbers. */
    const LONG_TERM_LINES = new Set([323, 713, 714]);

    fc.assert(
      // Cover all three checkbox categories, not just the 'C' default —
      // otherwise the A/B rows of the tax-line mapping table (321/323,
      // 711/713) stay dead and a short/long swap there would go uncaught.
      fc.property(arbTaxResult, fc.constantFrom('A', 'B', 'C'), (taxResult, checkbox) => {
        const txf = formatTxf(taxResult, { checkbox });
        const parsed = parseTxf(txf);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return; // type-narrow; already asserted above

        // Sum proceeds − costBasis by term from TXF records
        let txfShort = new Decimal(0);
        let txfLong = new Decimal(0);
        for (const rec of parsed.records) {
          const gainLoss = new Decimal(rec.proceeds).minus(new Decimal(rec.costBasis));
          if (SHORT_TERM_LINES.has(rec.taxLine)) {
            txfShort = txfShort.plus(gainLoss);
          } else if (LONG_TERM_LINES.has(rec.taxLine)) {
            txfLong = txfLong.plus(gainLoss);
          }
        }

        // Compare against the disposal-level totals (2-dp normalised)
        const { short: expectedShort, long: expectedLong } = splitGains(taxResult.disposals);
        expect(txfShort.toFixed(2)).toBe(expectedShort.toFixed(2));
        expect(txfLong.toFixed(2)).toBe(expectedLong.toFixed(2));
      }),
      { numRuns: 100 },
    );
  });
});
