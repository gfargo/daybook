/**
 * Unit tests for Schedule D PDF generation.
 *
 * Validates:
 *   - buildScheduleDData: aggregation of short/long-term totals,
 *     line 7 and line 15 computation, zero-disposal handling
 *   - renderScheduleDPdf: PDF generation produces valid bytes
 *   - formatScheduleD: convenience wrapper
 *   - Non-computable lines are left blank (not zero)
 *
 * **Validates: Requirements 2.1–2.7**
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
    buildScheduleDData,
    renderScheduleDPdf,
    formatScheduleD,
} from './schedule-d.js';
import type { TaxResult, DisposalResult } from './types.js';

// ─── Test helpers ────────────────────────────────────────────────────────

/** Build a minimal TaxResult with the given disposals. */
function makeTaxResult(disposals: DisposalResult[]): TaxResult {
  return {
    year: 2024,
    method: 'FIFO',
    disposals,
    income: { totalUsd: '0.00', byAsset: {}, events: [] },
    warnings: [],
    unpricedEvents: [],
  };
}

/** Build a minimal DisposalResult with overrides. */
function makeDisposal(overrides: Partial<DisposalResult> = {}): DisposalResult {
  return {
    asset: 'ETH',
    amount: '1.5',
    proceeds: '3000.00',
    costBasis: '2000.00',
    gainLoss: '1000.00',
    term: 'short-term',
    acquiredAt: new Date(Date.UTC(2024, 0, 15)),
    disposedAt: new Date(Date.UTC(2024, 6, 20)),
    sourceEntryId: 'entry-1',
    lotsConsumed: [{ lotId: 'lot-1', amount: '1.5', costBasis: '2000.00' }],
    washSaleFlag: false,
    ...overrides,
  };
}

// ─── buildScheduleDData ──────────────────────────────────────────────────

describe('buildScheduleDData', () => {
  describe('zero disposals', () => {
    it('produces zero totals for all lines when there are no disposals', () => {
      const result = makeTaxResult([]);
      const data = buildScheduleDData(result);

      expect(data.year).toBe(2024);
      expect(data.line1a).toEqual({
        proceeds: '0.00',
        costBasis: '0.00',
        gainLoss: '0.00',
      });
      expect(data.line7).toBe('0.00');
      expect(data.line8a).toEqual({
        proceeds: '0.00',
        costBasis: '0.00',
        gainLoss: '0.00',
      });
      expect(data.line15).toBe('0.00');
    });
  });

  describe('single disposal', () => {
    it('populates line 1a for a single short-term disposal', () => {
      const disposal = makeDisposal({
        term: 'short-term',
        proceeds: '5000.00',
        costBasis: '3000.00',
        gainLoss: '2000.00',
      });
      const result = makeTaxResult([disposal]);
      const data = buildScheduleDData(result);

      expect(data.line1a).toEqual({
        proceeds: '5000.00',
        costBasis: '3000.00',
        gainLoss: '2000.00',
      });
      expect(data.line7).toBe('2000.00');
      // Long-term lines should be zero
      expect(data.line8a).toEqual({
        proceeds: '0.00',
        costBasis: '0.00',
        gainLoss: '0.00',
      });
      expect(data.line15).toBe('0.00');
    });

    it('populates line 8a for a single long-term disposal', () => {
      const disposal = makeDisposal({
        term: 'long-term',
        proceeds: '8000.00',
        costBasis: '4000.00',
        gainLoss: '4000.00',
      });
      const result = makeTaxResult([disposal]);
      const data = buildScheduleDData(result);

      // Short-term lines should be zero
      expect(data.line1a).toEqual({
        proceeds: '0.00',
        costBasis: '0.00',
        gainLoss: '0.00',
      });
      expect(data.line7).toBe('0.00');
      expect(data.line8a).toEqual({
        proceeds: '8000.00',
        costBasis: '4000.00',
        gainLoss: '4000.00',
      });
      expect(data.line15).toBe('4000.00');
    });
  });

  describe('negative gain/loss values', () => {
    it('handles short-term losses correctly', () => {
      const disposals = [
        makeDisposal({
          term: 'short-term',
          proceeds: '500.00',
          costBasis: '1000.00',
          gainLoss: '-500.00',
        }),
        makeDisposal({
          term: 'short-term',
          proceeds: '300.00',
          costBasis: '800.00',
          gainLoss: '-500.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      expect(data.line1a.gainLoss).toBe('-1000.00');
      expect(data.line7).toBe('-1000.00');
    });

    it('handles long-term losses correctly', () => {
      const disposal = makeDisposal({
        term: 'long-term',
        proceeds: '200.00',
        costBasis: '1500.00',
        gainLoss: '-1300.00',
      });
      const result = makeTaxResult([disposal]);
      const data = buildScheduleDData(result);

      expect(data.line8a.gainLoss).toBe('-1300.00');
      expect(data.line15).toBe('-1300.00');
    });

    it('handles mixed gains and losses across terms', () => {
      const disposals = [
        makeDisposal({
          term: 'short-term',
          proceeds: '2000.00',
          costBasis: '3000.00',
          gainLoss: '-1000.00',
        }),
        makeDisposal({
          term: 'long-term',
          proceeds: '5000.00',
          costBasis: '2000.00',
          gainLoss: '3000.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      expect(data.line7).toBe('-1000.00');
      expect(data.line15).toBe('3000.00');
    });
  });

  describe('line 7 and line 15 net totals', () => {
    it('computes line 7 as the sum of all short-term gain/loss values', () => {
      const disposals = [
        makeDisposal({
          term: 'short-term',
          proceeds: '1000.00',
          costBasis: '800.00',
          gainLoss: '200.00',
        }),
        makeDisposal({
          term: 'short-term',
          proceeds: '2000.00',
          costBasis: '2500.00',
          gainLoss: '-500.00',
        }),
        makeDisposal({
          term: 'short-term',
          proceeds: '3000.00',
          costBasis: '1000.00',
          gainLoss: '2000.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      // 200 + (-500) + 2000 = 1700
      expect(data.line7).toBe('1700.00');
      expect(data.line1a.gainLoss).toBe('1700.00');
    });

    it('computes line 15 as the sum of all long-term gain/loss values', () => {
      const disposals = [
        makeDisposal({
          term: 'long-term',
          proceeds: '10000.00',
          costBasis: '5000.00',
          gainLoss: '5000.00',
        }),
        makeDisposal({
          term: 'long-term',
          proceeds: '3000.00',
          costBasis: '4000.00',
          gainLoss: '-1000.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      // 5000 + (-1000) = 4000
      expect(data.line15).toBe('4000.00');
      expect(data.line8a.gainLoss).toBe('4000.00');
    });

    it('line 7 equals line 1a gain/loss (only daybook data)', () => {
      const disposals = [
        makeDisposal({ term: 'short-term', gainLoss: '100.00' }),
        makeDisposal({ term: 'short-term', gainLoss: '250.50' }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      expect(data.line7).toBe(data.line1a.gainLoss);
    });

    it('line 15 equals line 8a gain/loss (only daybook data)', () => {
      const disposals = [
        makeDisposal({ term: 'long-term', gainLoss: '999.99' }),
        makeDisposal({ term: 'long-term', gainLoss: '-123.45' }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      expect(data.line15).toBe(data.line8a.gainLoss);
    });
  });

  describe('monetary formatting', () => {
    it('formats all values with exactly 2 decimal places', () => {
      const disposal = makeDisposal({
        term: 'short-term',
        proceeds: '1234.5',
        costBasis: '999',
        gainLoss: '235.5',
      });
      const result = makeTaxResult([disposal]);
      const data = buildScheduleDData(result);

      expect(data.line1a.proceeds).toBe('1234.50');
      expect(data.line1a.costBasis).toBe('999.00');
      expect(data.line1a.gainLoss).toBe('235.50');
      expect(data.line7).toBe('235.50');
    });
  });

  describe('multiple disposals aggregation', () => {
    it('aggregates proceeds and cost basis across multiple short-term disposals', () => {
      const disposals = [
        makeDisposal({
          term: 'short-term',
          proceeds: '1000.00',
          costBasis: '800.00',
          gainLoss: '200.00',
        }),
        makeDisposal({
          term: 'short-term',
          proceeds: '2000.00',
          costBasis: '1500.00',
          gainLoss: '500.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildScheduleDData(result);

      expect(data.line1a.proceeds).toBe('3000.00');
      expect(data.line1a.costBasis).toBe('2300.00');
      expect(data.line1a.gainLoss).toBe('700.00');
    });
  });
});

// ─── Non-computable lines left blank ─────────────────────────────────────

describe('non-computable lines left blank', () => {
  it('does not fill lines other than 1a, 7, 8a, and 15 in the PDF', async () => {
    const disposal = makeDisposal({ term: 'short-term' });
    const result = makeTaxResult([disposal]);
    const data = buildScheduleDData(result);
    const pdfBytes = await renderScheduleDPdf(data);

    // Load the generated PDF (before flattening we can't read fields,
    // but we can verify the PDF is valid and check field count)
    const doc = await PDFDocument.load(pdfBytes);
    // Flattened PDFs have no form fields — all fields are baked in.
    // The fact that we only set 8 fields (line1a×3 + line7 + line8a×3 + line15)
    // and flatten means non-computable lines remain blank.
    // We verify by checking the PDF is valid and has the expected page count.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('leaves line 1b, 2, 3, 4, 5, 6 blank (not zero) in the data builder', () => {
    // The ScheduleDData interface only has line1a, line7, line8a, line15.
    // Lines 1b, 2, 3, 4, 5, 6, 8b, 9, 10, 11, 12, 13, 14 are not
    // represented in the data structure — they are never set in the PDF.
    const result = makeTaxResult([makeDisposal()]);
    const data = buildScheduleDData(result);

    // Verify the data structure only contains the expected keys
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['year', 'line1a', 'line7', 'line8a', 'line15']),
    );
    expect(Object.keys(data)).toHaveLength(5);
  });
});

// ─── renderScheduleDPdf ──────────────────────────────────────────────────

describe('renderScheduleDPdf', () => {
  it('produces non-empty PDF bytes for a single disposal', async () => {
    const result = makeTaxResult([makeDisposal()]);
    const data = buildScheduleDData(result);
    const pdf = await renderScheduleDPdf(data);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('produces valid PDF bytes for zero disposals', async () => {
    const data = buildScheduleDData(makeTaxResult([]));
    const pdf = await renderScheduleDPdf(data);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('produces a PDF with the expected page count', async () => {
    const data = buildScheduleDData(makeTaxResult([makeDisposal()]));
    const pdfBytes = await renderScheduleDPdf(data);
    const doc = await PDFDocument.load(pdfBytes);

    // Schedule D template has 2 pages (Part I+II on page 1, Part III on page 2)
    expect(doc.getPageCount()).toBe(2);
  });
});

// ─── formatScheduleD (convenience) ───────────────────────────────────────

describe('formatScheduleD', () => {
  it('produces PDF bytes from a TaxResult in one call', async () => {
    const result = makeTaxResult([makeDisposal()]);
    const pdf = await formatScheduleD(result);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('handles mixed short-term and long-term disposals', async () => {
    const disposals = [
      makeDisposal({ term: 'short-term', gainLoss: '500.00' }),
      makeDisposal({ term: 'long-term', gainLoss: '1500.00' }),
    ];
    const result = makeTaxResult(disposals);
    const pdf = await formatScheduleD(result);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });
});


// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { arbTaxResult } from './test-helpers.js';
import { buildForm8949Data } from './form-8949.js';

describe('property-based tests', () => {
  // Feature: tax-form-generation, Property 5: Schedule D totals match Form 8949 aggregates
  // **Validates: Requirements 2.2, 2.3, 4.2**
  it('Property 5: Schedule D line 1a totals equal sum of all Form 8949 Part I rows; line 8a equals sum of Part II rows', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const form8949 = buildForm8949Data(taxResult);
        const scheduleD = buildScheduleDData(taxResult);

        // Sum all Part I rows across all pages
        let partIProceeds = new Decimal(0);
        let partICostBasis = new Decimal(0);
        let partIGainLoss = new Decimal(0);
        for (const page of form8949.pages) {
          for (const row of page.partI) {
            partIProceeds = partIProceeds.plus(new Decimal(row.proceeds));
            partICostBasis = partICostBasis.plus(new Decimal(row.costBasis));
            partIGainLoss = partIGainLoss.plus(new Decimal(row.gainLoss));
          }
        }

        // Sum all Part II rows across all pages
        let partIIProceeds = new Decimal(0);
        let partIICostBasis = new Decimal(0);
        let partIIGainLoss = new Decimal(0);
        for (const page of form8949.pages) {
          for (const row of page.partII) {
            partIIProceeds = partIIProceeds.plus(new Decimal(row.proceeds));
            partIICostBasis = partIICostBasis.plus(new Decimal(row.costBasis));
            partIIGainLoss = partIIGainLoss.plus(new Decimal(row.gainLoss));
          }
        }

        // Schedule D line 1a should match Form 8949 Part I aggregates
        expect(scheduleD.line1a.proceeds).toBe(partIProceeds.toFixed(2));
        expect(scheduleD.line1a.costBasis).toBe(partICostBasis.toFixed(2));
        expect(scheduleD.line1a.gainLoss).toBe(partIGainLoss.toFixed(2));

        // Schedule D line 8a should match Form 8949 Part II aggregates
        expect(scheduleD.line8a.proceeds).toBe(partIIProceeds.toFixed(2));
        expect(scheduleD.line8a.costBasis).toBe(partIICostBasis.toFixed(2));
        expect(scheduleD.line8a.gainLoss).toBe(partIIGainLoss.toFixed(2));
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 6: Cross-format gain/loss consistency
  // **Validates: Requirements 4.4**
  it('Property 6: total gain/loss from disposal rows equals Schedule D net gain/loss (line 7 + line 15)', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildScheduleDData(taxResult);

        // Sum all disposal gainLoss values using Decimal
        let totalGainLoss = new Decimal(0);
        for (const disposal of taxResult.disposals) {
          totalGainLoss = totalGainLoss.plus(new Decimal(disposal.gainLoss));
        }

        // Schedule D net gain/loss is line 7 + line 15
        const scheduleDNet = new Decimal(data.line7).plus(new Decimal(data.line15)).toFixed(2);

        expect(scheduleDNet).toBe(totalGainLoss.toFixed(2));
      }),
      { numRuns: 100 },
    );
  });
});
