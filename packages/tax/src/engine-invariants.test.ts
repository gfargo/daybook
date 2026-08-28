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
 *    amount: `rawProceeds - netProceeds === feeUsd`.
 *    Guards against bug B5 (fee allocated once per trade vs once per leg).
 *
 * 3. **Term partitioning** — every DisposalResult produced by computeTax
 *    has `disposal.term === classifyTerm(disposal.acquiredAt, disposal.disposedAt)`.
 *    Guards against bug B4 (365-day threshold vs calendar anniversary).
 *
 * 4. **Method ordering** — for a pure-gain history, HIFO total gain <=
 *    FIFO total gain. HIFO sells highest-cost lots first, minimising gain.
 *
 * 5. **Determinism** — `computeTax(h, cfg)` called twice on the same
 *    input produces deep-equal `TaxResult` objects.
 *
 * 6. **Cross-format agreement** — CSV footer, Form 8949 page totals,
 *    Schedule D lines, and TXF records all reconcile to the same
 *    short/long-term gain totals as `arbTaxResult` disposals.
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

import { computeTax } from './compute.js';
import { FIFO, HIFO } from './cost-basis.js';
import { classifyTerm } from './holding-period.js';
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
  const lines = csv.split('\n').map((l) => l.trim());
  let short = new Decimal(0);
  let long = new Decimal(0);

  for (const line of lines) {
    // csv-stringify quotes values that contain commas or quotes; strip them
    const bare = line.replace(/^"|"$/g, '');

    if (bare.startsWith('Short-Term Gain,')) {
      const val = bare.slice('Short-Term Gain,'.length).replace(/"/g, '').trim();
      short = new Decimal(val);
    } else if (bare.startsWith('Long-Term Gain,')) {
      const val = bare.slice('Long-Term Gain,'.length).replace(/"/g, '').trim();
      long = new Decimal(val);
    }
  }

  return { short, long };
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
});

// ─── Invariant 3: Term partitioning ──────────────────────────────────────

describe('Invariant 3: Term partitioning — disposal.term matches classifyTerm', () => {
  /**
   * For every DisposalResult produced by computeTax, the reported term
   * equals `classifyTerm(disposal.acquiredAt, disposal.disposedAt)`.
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
          const expected = classifyTerm(disposal.acquiredAt, disposal.disposedAt);
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
          const expected = classifyTerm(disposal.acquiredAt, disposal.disposedAt);
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

describe('Invariant 5: Determinism — same input produces identical output', () => {
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
      fc.property(arbTaxResult, (taxResult) => {
        const txf = formatTxf(taxResult, { checkbox: 'C' });
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
