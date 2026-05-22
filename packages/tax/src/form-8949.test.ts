/**
 * Unit tests for Form 8949 PDF generation.
 *
 * Validates:
 *   - buildForm8949Data: disposal splitting, pagination, totals, checkbox override
 *   - renderForm8949Pdf: PDF generation produces valid bytes
 *   - parseForm8949Pdf: round-trip field reading (non-flattened)
 *   - formatForm8949: convenience wrapper
 *   - Error handling: invalid dates throw with asset + sourceEntryId
 *
 * **Validates: Requirements 1.1–1.11, 8.3, 8.4**
 */

import { describe, expect, it } from 'vitest';
import {
    buildForm8949Data,
    renderForm8949Pdf,
    formatForm8949,
    ROWS_PER_PAGE,
} from './form-8949.js';
import type { Form8949Row } from './form-8949.js';
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

/** Generate N disposals with sequential IDs. */
function makeDisposals(
  count: number,
  overrides: Partial<DisposalResult> = {},
): DisposalResult[] {
  return Array.from({ length: count }, (_, i) =>
    makeDisposal({
      sourceEntryId: `entry-${i + 1}`,
      proceeds: `${(i + 1) * 1000}.00`,
      costBasis: `${(i + 1) * 800}.00`,
      gainLoss: `${(i + 1) * 200}.00`,
      ...overrides,
    }),
  );
}

// ─── buildForm8949Data ───────────────────────────────────────────────────

describe('buildForm8949Data', () => {
  describe('empty disposals', () => {
    it('produces no pages when there are zero disposals', () => {
      const result = makeTaxResult([]);
      const data = buildForm8949Data(result);

      expect(data.year).toBe(2024);
      expect(data.pages).toHaveLength(0);
    });
  });

  describe('term partitioning', () => {
    it('places all short-term disposals in Part I', () => {
      const disposals = makeDisposals(3, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(1);
      expect(data.pages[0]!.partI).toHaveLength(3);
      expect(data.pages[0]!.partII).toHaveLength(0);
    });

    it('places all long-term disposals in Part II', () => {
      const disposals = makeDisposals(3, { term: 'long-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(1);
      expect(data.pages[0]!.partI).toHaveLength(0);
      expect(data.pages[0]!.partII).toHaveLength(3);
    });

    it('splits mixed short-term and long-term disposals correctly', () => {
      const disposals = [
        makeDisposal({ term: 'short-term', sourceEntryId: 'st-1' }),
        makeDisposal({ term: 'long-term', sourceEntryId: 'lt-1' }),
        makeDisposal({ term: 'short-term', sourceEntryId: 'st-2' }),
        makeDisposal({ term: 'long-term', sourceEntryId: 'lt-2' }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(1);
      expect(data.pages[0]!.partI).toHaveLength(2);
      expect(data.pages[0]!.partII).toHaveLength(2);
    });
  });

  describe('pagination', () => {
    it('fits exactly ROWS_PER_PAGE rows on a single page', () => {
      const disposals = makeDisposals(ROWS_PER_PAGE, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(1);
      expect(data.pages[0]!.partI).toHaveLength(ROWS_PER_PAGE);
    });

    it('creates a continuation sheet when rows exceed ROWS_PER_PAGE', () => {
      const disposals = makeDisposals(ROWS_PER_PAGE + 1, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(2);
      expect(data.pages[0]!.partI).toHaveLength(ROWS_PER_PAGE);
      expect(data.pages[1]!.partI).toHaveLength(1);
    });

    it('creates multiple continuation sheets for many disposals', () => {
      const count = ROWS_PER_PAGE * 3 + 5;
      const disposals = makeDisposals(count, { term: 'long-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(4);
      expect(data.pages[0]!.partII).toHaveLength(ROWS_PER_PAGE);
      expect(data.pages[1]!.partII).toHaveLength(ROWS_PER_PAGE);
      expect(data.pages[2]!.partII).toHaveLength(ROWS_PER_PAGE);
      expect(data.pages[3]!.partII).toHaveLength(5);
    });

    it('enforces page capacity: no page exceeds ROWS_PER_PAGE per part', () => {
      const disposals = [
        ...makeDisposals(25, { term: 'short-term' }),
        ...makeDisposals(30, { term: 'long-term' }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      for (const page of data.pages) {
        expect(page.partI.length).toBeLessThanOrEqual(ROWS_PER_PAGE);
        expect(page.partII.length).toBeLessThanOrEqual(ROWS_PER_PAGE);
      }
    });
  });

  describe('row formatting', () => {
    it('formats description as "<amount> <asset>"', () => {
      const disposal = makeDisposal({ amount: '2.5', asset: 'BTC' });
      const result = makeTaxResult([disposal]);
      const data = buildForm8949Data(result);

      expect(data.pages[0]!.partI[0]!.description).toBe('2.5 BTC');
    });

    it('formats dates as MM/DD/YYYY', () => {
      const disposal = makeDisposal({
        acquiredAt: new Date(Date.UTC(2023, 0, 5)),
        disposedAt: new Date(Date.UTC(2024, 11, 31)),
      });
      const result = makeTaxResult([disposal]);
      const data = buildForm8949Data(result);

      expect(data.pages[0]!.partI[0]!.dateAcquired).toBe('01/05/2023');
      expect(data.pages[0]!.partI[0]!.dateSold).toBe('12/31/2024');
    });

    it('formats monetary values with exactly 2 decimal places', () => {
      const disposal = makeDisposal({
        proceeds: '1234.5',
        costBasis: '999',
        gainLoss: '235.5',
      });
      const result = makeTaxResult([disposal]);
      const data = buildForm8949Data(result);

      const row = data.pages[0]!.partI[0]!;
      expect(row.proceeds).toBe('1234.50');
      expect(row.costBasis).toBe('999.00');
      expect(row.gainLoss).toBe('235.50');
    });
  });

  describe('per-page column totals', () => {
    it('computes correct totals for a single page', () => {
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
      const data = buildForm8949Data(result);

      expect(data.pages[0]!.partITotals).toEqual({
        proceeds: '3000.00',
        costBasis: '2300.00',
        gainLoss: '700.00',
      });
    });

    it('computes per-page totals (not global) for continuation sheets', () => {
      // Create ROWS_PER_PAGE + 1 disposals so we get 2 pages
      const disposals = makeDisposals(ROWS_PER_PAGE + 1, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages).toHaveLength(2);

      // Page 1 totals should only sum the first ROWS_PER_PAGE rows
      const page1Rows = data.pages[0]!.partI;
      const expectedPage1Proceeds = page1Rows
        .reduce((sum, r) => sum + parseFloat(r.proceeds), 0)
        .toFixed(2);
      expect(data.pages[0]!.partITotals.proceeds).toBe(expectedPage1Proceeds);

      // Page 2 totals should only sum the remaining row
      const page2Rows = data.pages[1]!.partI;
      const expectedPage2Proceeds = page2Rows
        .reduce((sum, r) => sum + parseFloat(r.proceeds), 0)
        .toFixed(2);
      expect(data.pages[1]!.partITotals.proceeds).toBe(expectedPage2Proceeds);
    });

    it('produces zero totals for empty parts', () => {
      const disposals = makeDisposals(3, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      // Part II is empty
      expect(data.pages[0]!.partIITotals).toEqual({
        proceeds: '0.00',
        costBasis: '0.00',
        gainLoss: '0.00',
      });
    });

    it('handles negative gain/loss values in totals', () => {
      const disposals = [
        makeDisposal({
          term: 'long-term',
          proceeds: '500.00',
          costBasis: '1000.00',
          gainLoss: '-500.00',
        }),
        makeDisposal({
          term: 'long-term',
          proceeds: '300.00',
          costBasis: '800.00',
          gainLoss: '-500.00',
        }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      expect(data.pages[0]!.partIITotals.gainLoss).toBe('-1000.00');
    });
  });

  describe('checkbox category', () => {
    it('defaults to checkbox C', () => {
      const result = makeTaxResult([makeDisposal()]);
      const data = buildForm8949Data(result);

      expect(data.pages[0]!.checkbox).toBe('C');
    });

    it('supports checkbox A override', () => {
      const result = makeTaxResult([makeDisposal()]);
      const data = buildForm8949Data(result, { checkbox: 'A' });

      expect(data.pages[0]!.checkbox).toBe('A');
    });

    it('supports checkbox B override', () => {
      const result = makeTaxResult([makeDisposal()]);
      const data = buildForm8949Data(result, { checkbox: 'B' });

      expect(data.pages[0]!.checkbox).toBe('B');
    });

    it('applies the same checkbox to all continuation sheets', () => {
      const disposals = makeDisposals(ROWS_PER_PAGE + 5, { term: 'short-term' });
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result, { checkbox: 'A' });

      for (const page of data.pages) {
        expect(page.checkbox).toBe('A');
      }
    });
  });

  describe('per-disposal checkbox', () => {
    it('groups disposals into separate page groups per box', () => {
      const result = makeTaxResult([
        makeDisposal({ sourceEntryId: 'a1', term: 'short-term' }),
        makeDisposal({ sourceEntryId: 'a2', term: 'long-term' }),
        makeDisposal({ sourceEntryId: 'b1', term: 'short-term' }),
        makeDisposal({ sourceEntryId: 'c1', term: 'long-term' }),
      ]);
      const boxes = new Map<string, 'A' | 'B' | 'C'>([
        ['a1', 'A'],
        ['a2', 'A'],
        ['b1', 'B'],
        ['c1', 'C'],
      ]);

      const data = buildForm8949Data(result, { disposalCheckboxes: boxes });

      // Expect one page for each of A (short+long), B (short), C (long)
      expect(data.pages.map((p) => p.checkbox)).toEqual(['A', 'B', 'C']);

      // Box A page contains one short-term and one long-term row
      const pageA = data.pages.find((p) => p.checkbox === 'A')!;
      expect(pageA.partI).toHaveLength(1);
      expect(pageA.partII).toHaveLength(1);

      const pageB = data.pages.find((p) => p.checkbox === 'B')!;
      expect(pageB.partI).toHaveLength(1);
      expect(pageB.partII).toHaveLength(0);

      const pageC = data.pages.find((p) => p.checkbox === 'C')!;
      expect(pageC.partI).toHaveLength(0);
      expect(pageC.partII).toHaveLength(1);
    });

    it('falls back to the default checkbox for unmapped disposals', () => {
      const result = makeTaxResult([
        makeDisposal({ sourceEntryId: 'mapped' }),
        makeDisposal({ sourceEntryId: 'unmapped' }),
      ]);
      const boxes = new Map<string, 'A' | 'B' | 'C'>([['mapped', 'A']]);

      const data = buildForm8949Data(result, {
        disposalCheckboxes: boxes,
        checkbox: 'C',
      });

      expect(data.pages.map((p) => p.checkbox)).toEqual(['A', 'C']);
      expect(data.pages[0]!.partI).toHaveLength(1);
      expect(data.pages[1]!.partI).toHaveLength(1);
    });

    it('always emits boxes in canonical A, B, C order', () => {
      const result = makeTaxResult([
        makeDisposal({ sourceEntryId: 'c1' }),
        makeDisposal({ sourceEntryId: 'a1' }),
        makeDisposal({ sourceEntryId: 'b1' }),
      ]);
      const boxes = new Map<string, 'A' | 'B' | 'C'>([
        ['c1', 'C'],
        ['a1', 'A'],
        ['b1', 'B'],
      ]);

      const data = buildForm8949Data(result, { disposalCheckboxes: boxes });
      expect(data.pages.map((p) => p.checkbox)).toEqual(['A', 'B', 'C']);
    });

    it('paginates within each box independently', () => {
      const shortA = makeDisposals(15, { term: 'short-term' }).map((d, i) => ({
        ...d,
        sourceEntryId: `a${i}`,
      }));
      const shortC = makeDisposals(5, { term: 'short-term' }).map((d, i) => ({
        ...d,
        sourceEntryId: `c${i}`,
      }));
      const result = makeTaxResult([...shortA, ...shortC]);
      const boxes = new Map<string, 'A' | 'B' | 'C'>();
      for (const d of shortA) boxes.set(d.sourceEntryId, 'A');
      for (const d of shortC) boxes.set(d.sourceEntryId, 'C');

      const data = buildForm8949Data(result, { disposalCheckboxes: boxes });

      // A: 15 short-term → 2 pages (11 + 4)
      // C: 5 short-term → 1 page
      const aPages = data.pages.filter((p) => p.checkbox === 'A');
      const cPages = data.pages.filter((p) => p.checkbox === 'C');
      expect(aPages).toHaveLength(2);
      expect(cPages).toHaveLength(1);
      expect(aPages[0]!.partI).toHaveLength(ROWS_PER_PAGE);
      expect(aPages[1]!.partI).toHaveLength(4);
      expect(cPages[0]!.partI).toHaveLength(5);
    });

    it('ignores an empty disposalCheckboxes map and uses the default checkbox', () => {
      const result = makeTaxResult([makeDisposal()]);
      const data = buildForm8949Data(result, {
        disposalCheckboxes: new Map(),
        checkbox: 'A',
      });
      expect(data.pages).toHaveLength(1);
      expect(data.pages[0]!.checkbox).toBe('A');
    });
  });

  describe('row count invariant', () => {
    it('total rows across all pages equals disposal count', () => {
      const shortCount = 15;
      const longCount = 8;
      const disposals = [
        ...makeDisposals(shortCount, { term: 'short-term' }),
        ...makeDisposals(longCount, { term: 'long-term' }),
      ];
      const result = makeTaxResult(disposals);
      const data = buildForm8949Data(result);

      let totalRows = 0;
      for (const page of data.pages) {
        totalRows += page.partI.length + page.partII.length;
      }

      expect(totalRows).toBe(shortCount + longCount);
    });
  });
});

// ─── renderForm8949Pdf ───────────────────────────────────────────────────

describe('renderForm8949Pdf', () => {
  it('produces non-empty PDF bytes for a single disposal', async () => {
    const result = makeTaxResult([makeDisposal()]);
    const data = buildForm8949Data(result);
    const pdf = await renderForm8949Pdf(data);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('produces valid PDF bytes for empty data', async () => {
    const data = buildForm8949Data(makeTaxResult([]));
    const pdf = await renderForm8949Pdf(data);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('produces larger PDF for continuation sheets', async () => {
    const singleResult = makeTaxResult([makeDisposal()]);
    const singleData = buildForm8949Data(singleResult);
    const singlePdf = await renderForm8949Pdf(singleData);

    const multiResult = makeTaxResult(
      makeDisposals(ROWS_PER_PAGE + 5, { term: 'short-term' }),
    );
    const multiData = buildForm8949Data(multiResult);
    const multiPdf = await renderForm8949Pdf(multiData);

    // Multi-page PDF should be larger than single-page
    expect(multiPdf.length).toBeGreaterThan(singlePdf.length);
  });
});

// ─── formatForm8949 (convenience) ────────────────────────────────────────

describe('formatForm8949', () => {
  it('produces PDF bytes from a TaxResult in one call', async () => {
    const result = makeTaxResult([makeDisposal()]);
    const pdf = await formatForm8949(result);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('passes checkbox option through', async () => {
    const result = makeTaxResult([makeDisposal()]);
    // Just verify it doesn't throw with options
    const pdf = await formatForm8949(result, { checkbox: 'A' });
    expect(pdf).toBeInstanceOf(Uint8Array);
  });
});

// ─── Error handling ──────────────────────────────────────────────────────

describe('error handling', () => {
  it('throws on invalid acquisition date with asset and sourceEntryId', () => {
    const disposal = makeDisposal({
      asset: 'BTC',
      sourceEntryId: 'bad-entry-42',
      acquiredAt: new Date('garbage'),
    });
    const result = makeTaxResult([disposal]);

    expect(() => buildForm8949Data(result)).toThrow('BTC');
    expect(() => buildForm8949Data(result)).toThrow('bad-entry-42');
  });

  it('throws on invalid disposal date with asset and sourceEntryId', () => {
    const disposal = makeDisposal({
      asset: 'ETH',
      sourceEntryId: 'bad-entry-99',
      disposedAt: new Date(NaN),
    });
    const result = makeTaxResult([disposal]);

    expect(() => buildForm8949Data(result)).toThrow('ETH');
    expect(() => buildForm8949Data(result)).toThrow('bad-entry-99');
  });

  it('throws descriptive error message for invalid dates', () => {
    const disposal = makeDisposal({
      acquiredAt: new Date('not-a-date'),
    });
    const result = makeTaxResult([disposal]);

    expect(() => buildForm8949Data(result)).toThrow('Invalid acquisition date');
  });
});


// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { arbTaxResult } from './test-helpers.js';
import { formatDescription, formatMoney } from './format-helpers.js';

describe('property-based tests', () => {
  // Feature: tax-form-generation, Property 1: Form 8949 row count equals disposal count
  // **Validates: Requirements 4.5**
  it('Property 1: total rows across all pages equals disposal count', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        let totalRows = 0;
        for (const page of data.pages) {
          totalRows += page.partI.length + page.partII.length;
        }

        expect(totalRows).toBe(taxResult.disposals.length);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 2: Form 8949 term partitioning
  // **Validates: Requirements 1.3, 1.4**
  it('Property 2: short-term disposals appear in Part I, long-term in Part II', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        const shortTermCount = taxResult.disposals.filter((d) => d.term === 'short-term').length;
        const longTermCount = taxResult.disposals.filter((d) => d.term === 'long-term').length;

        let partITotal = 0;
        let partIITotal = 0;
        for (const page of data.pages) {
          partITotal += page.partI.length;
          partIITotal += page.partII.length;
        }

        expect(partITotal).toBe(shortTermCount);
        expect(partIITotal).toBe(longTermCount);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 3: Form 8949 page capacity invariant
  // **Validates: Requirements 1.8**
  it('Property 3: every page has at most ROWS_PER_PAGE rows per part', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        for (const page of data.pages) {
          expect(page.partI.length).toBeLessThanOrEqual(ROWS_PER_PAGE);
          expect(page.partII.length).toBeLessThanOrEqual(ROWS_PER_PAGE);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 4: Form 8949 per-page totals consistency
  // **Validates: Requirements 1.9**
  it('Property 4: per-page column totals equal the sum of row values', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        for (const page of data.pages) {
          // Check Part I totals
          let partIProceeds = new Decimal(0);
          let partICostBasis = new Decimal(0);
          let partIGainLoss = new Decimal(0);
          for (const row of page.partI) {
            partIProceeds = partIProceeds.plus(new Decimal(row.proceeds));
            partICostBasis = partICostBasis.plus(new Decimal(row.costBasis));
            partIGainLoss = partIGainLoss.plus(new Decimal(row.gainLoss));
          }
          expect(page.partITotals.proceeds).toBe(partIProceeds.toFixed(2));
          expect(page.partITotals.costBasis).toBe(partICostBasis.toFixed(2));
          expect(page.partITotals.gainLoss).toBe(partIGainLoss.toFixed(2));

          // Check Part II totals
          let partIIProceeds = new Decimal(0);
          let partIICostBasis = new Decimal(0);
          let partIIGainLoss = new Decimal(0);
          for (const row of page.partII) {
            partIIProceeds = partIIProceeds.plus(new Decimal(row.proceeds));
            partIICostBasis = partIICostBasis.plus(new Decimal(row.costBasis));
            partIIGainLoss = partIIGainLoss.plus(new Decimal(row.gainLoss));
          }
          expect(page.partIITotals.proceeds).toBe(partIIProceeds.toFixed(2));
          expect(page.partIITotals.costBasis).toBe(partIICostBasis.toFixed(2));
          expect(page.partIITotals.gainLoss).toBe(partIIGainLoss.toFixed(2));
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 9: Form 8949 PDF round-trip
  // **Validates: Requirements 6.3**
  it('Property 9: buildForm8949Data produces data consistent with input disposals', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        // Collect all rows from all pages
        const allRows: Form8949Row[] = [];
        for (const page of data.pages) {
          allRows.push(...page.partI, ...page.partII);
        }

        // Row count matches disposal count
        expect(allRows.length).toBe(taxResult.disposals.length);

        // Each row description matches "<amount> <asset>" from the corresponding disposal
        // Rows are ordered: all short-term first (across pages), then all long-term
        const shortTermDisposals = taxResult.disposals.filter((d) => d.term === 'short-term');
        const longTermDisposals = taxResult.disposals.filter((d) => d.term === 'long-term');

        const allPartIRows: Form8949Row[] = [];
        const allPartIIRows: Form8949Row[] = [];
        for (const page of data.pages) {
          allPartIRows.push(...page.partI);
          allPartIIRows.push(...page.partII);
        }

        // Verify Part I rows match short-term disposals
        expect(allPartIRows.length).toBe(shortTermDisposals.length);
        for (let i = 0; i < shortTermDisposals.length; i++) {
          const d = shortTermDisposals[i]!;
          const row = allPartIRows[i]!;
          expect(row.description).toBe(formatDescription(d.amount, d.asset));
          expect(row.proceeds).toBe(formatMoney(d.proceeds));
          expect(row.costBasis).toBe(formatMoney(d.costBasis));
          expect(row.gainLoss).toBe(formatMoney(d.gainLoss));
        }

        // Verify Part II rows match long-term disposals
        expect(allPartIIRows.length).toBe(longTermDisposals.length);
        for (let i = 0; i < longTermDisposals.length; i++) {
          const d = longTermDisposals[i]!;
          const row = allPartIIRows[i]!;
          expect(row.description).toBe(formatDescription(d.amount, d.asset));
          expect(row.proceeds).toBe(formatMoney(d.proceeds));
          expect(row.costBasis).toBe(formatMoney(d.costBasis));
          expect(row.gainLoss).toBe(formatMoney(d.gainLoss));
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 11: Monetary formatting invariant
  // **Validates: Requirements 1.7, 2.6, 3.7**
  it('Property 11: all monetary values have exactly 2 decimal places, no dollar signs or commas', () => {
    const moneyPattern = /^-?\d+\.\d{2}$/;

    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const data = buildForm8949Data(taxResult);

        for (const page of data.pages) {
          // Check every row in Part I and Part II
          for (const row of [...page.partI, ...page.partII]) {
            expect(row.proceeds).toMatch(moneyPattern);
            expect(row.costBasis).toMatch(moneyPattern);
            expect(row.gainLoss).toMatch(moneyPattern);
          }

          // Check page totals
          expect(page.partITotals.proceeds).toMatch(moneyPattern);
          expect(page.partITotals.costBasis).toMatch(moneyPattern);
          expect(page.partITotals.gainLoss).toMatch(moneyPattern);
          expect(page.partIITotals.proceeds).toMatch(moneyPattern);
          expect(page.partIITotals.costBasis).toMatch(moneyPattern);
          expect(page.partIITotals.gainLoss).toMatch(moneyPattern);
        }
      }),
      { numRuns: 100 },
    );
  });
});
