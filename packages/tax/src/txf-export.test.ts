/**
 * Unit tests for TXF export and parser.
 *
 * Validates:
 *   - formatTxf: header format, CRLF line endings, tax line mapping,
 *     checkbox category overrides, empty disposals
 *   - parseTxf: round-trip correctness, malformed input error reporting
 *
 * **Validates: Requirements 3.1–3.7, 7.1–7.4**
 */

import { describe, expect, it } from 'vitest';
import { formatTxf, parseTxf } from './txf-export.js';
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

// ─── formatTxf ───────────────────────────────────────────────────────────

describe('formatTxf', () => {
  describe('header format', () => {
    it('starts with V042 version line', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      expect(lines[0]).toBe('V042');
    });

    it('includes software identifier "Adaybook"', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      expect(lines[1]).toBe('Adaybook');
    });

    it('includes date line starting with "D" in MM/DD/YYYY format', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      expect(lines[2]).toMatch(/^D\d{2}\/\d{2}\/\d{4}$/);
    });

    it('terminates header with "^"', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      expect(lines[3]).toBe('^');
    });
  });

  describe('CRLF line endings', () => {
    it('uses CRLF throughout the output', () => {
      const result = makeTaxResult([makeDisposal()]);
      const txf = formatTxf(result);

      // Every line break should be CRLF
      // Strip the final CRLF, then check no bare LF remains
      const withoutFinalCrlf = txf.slice(0, -2);
      const stripped = withoutFinalCrlf.replace(/\r\n/g, '');
      expect(stripped).not.toContain('\n');
      expect(stripped).not.toContain('\r');
    });

    it('ends with a final CRLF', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      expect(txf.endsWith('\r\n')).toBe(true);
    });
  });

  describe('tax line mapping — default checkbox C', () => {
    it('maps short-term disposal to tax line 712', () => {
      const result = makeTaxResult([makeDisposal({ term: 'short-term' })]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      // Record starts after header (4 lines: V042, Adaybook, D..., ^)
      // Record: TD, N<taxLine>, C1, L1, P..., D..., D..., $..., $..., ^
      expect(lines[5]).toBe('N712');
    });

    it('maps long-term disposal to tax line 714', () => {
      const result = makeTaxResult([makeDisposal({ term: 'long-term' })]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');
      expect(lines[5]).toBe('N714');
    });
  });

  describe('checkbox A override', () => {
    it('maps short-term to tax line 321', () => {
      const result = makeTaxResult([makeDisposal({ term: 'short-term' })]);
      const txf = formatTxf(result, { checkbox: 'A' });
      const lines = txf.split('\r\n');
      expect(lines[5]).toBe('N321');
    });

    it('maps long-term to tax line 323', () => {
      const result = makeTaxResult([makeDisposal({ term: 'long-term' })]);
      const txf = formatTxf(result, { checkbox: 'A' });
      const lines = txf.split('\r\n');
      expect(lines[5]).toBe('N323');
    });
  });

  describe('checkbox B override', () => {
    it('maps short-term to tax line 711', () => {
      const result = makeTaxResult([makeDisposal({ term: 'short-term' })]);
      const txf = formatTxf(result, { checkbox: 'B' });
      const lines = txf.split('\r\n');
      expect(lines[5]).toBe('N711');
    });

    it('maps long-term to tax line 713', () => {
      const result = makeTaxResult([makeDisposal({ term: 'long-term' })]);
      const txf = formatTxf(result, { checkbox: 'B' });
      const lines = txf.split('\r\n');
      expect(lines[5]).toBe('N713');
    });
  });

  describe('record format', () => {
    it('produces correct record block structure', () => {
      const disposal = makeDisposal({
        asset: 'BTC',
        amount: '0.5',
        proceeds: '25000.50',
        costBasis: '20000.00',
        acquiredAt: new Date(Date.UTC(2023, 2, 10)),
        disposedAt: new Date(Date.UTC(2024, 8, 15)),
        term: 'long-term',
      });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');

      // Record starts at line index 4 (after header)
      expect(lines[4]).toBe('TD');
      expect(lines[5]).toBe('N714');
      expect(lines[6]).toBe('C1');
      expect(lines[7]).toBe('L1');
      expect(lines[8]).toBe('P0.5 BTC');
      expect(lines[9]).toBe('D03/10/2023');
      expect(lines[10]).toBe('D09/15/2024');
      expect(lines[11]).toBe('$20000.00');
      expect(lines[12]).toBe('$25000.50');
      expect(lines[13]).toBe('^');
    });

    it('formats monetary values with exactly 2 decimal places', () => {
      const disposal = makeDisposal({
        proceeds: '1234.5',
        costBasis: '999',
      });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');

      expect(lines[11]).toBe('$999.00');
      expect(lines[12]).toBe('$1234.50');
    });

    it('formats dates as MM/DD/YYYY', () => {
      const disposal = makeDisposal({
        acquiredAt: new Date(Date.UTC(2024, 0, 5)),
        disposedAt: new Date(Date.UTC(2024, 11, 31)),
      });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n');

      expect(lines[9]).toBe('D01/05/2024');
      expect(lines[10]).toBe('D12/31/2024');
    });
  });

  describe('multiple disposals', () => {
    it('produces one record block per disposal', () => {
      const d1 = makeDisposal({ asset: 'ETH', term: 'short-term' });
      const d2 = makeDisposal({ asset: 'BTC', term: 'long-term' });
      const result = makeTaxResult([d1, d2]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n').filter((l) => l !== '');

      // Header: 4 lines, each record: 10 lines → 4 + 20 = 24
      expect(lines).toHaveLength(24);

      // First record
      expect(lines[4]).toBe('TD');
      expect(lines[8]).toBe('P1.5 ETH');

      // Second record
      expect(lines[14]).toBe('TD');
      expect(lines[18]).toBe('P1.5 BTC');
    });
  });

  describe('empty disposals', () => {
    it('produces header-only TXF with no records', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const lines = txf.split('\r\n').filter((l) => l !== '');

      // Only header: V042, Adaybook, D<date>, ^
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('V042');
      expect(lines[3]).toBe('^');
    });
  });
});

// ─── parseTxf ────────────────────────────────────────────────────────────

describe('parseTxf', () => {
  describe('valid input round-trip', () => {
    it('parses a single short-term record correctly', () => {
      const disposal = makeDisposal({
        asset: 'ETH',
        amount: '2.0',
        proceeds: '5000.00',
        costBasis: '3000.00',
        term: 'short-term',
        acquiredAt: new Date(Date.UTC(2024, 0, 1)),
        disposedAt: new Date(Date.UTC(2024, 5, 15)),
      });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result);
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.records).toHaveLength(1);
      expect(parsed.records[0]).toEqual({
        taxLine: 712,
        description: '2.0 ETH',
        dateAcquired: '01/01/2024',
        dateSold: '06/15/2024',
        costBasis: '3000.00',
        proceeds: '5000.00',
      });
    });

    it('parses multiple records with mixed terms', () => {
      const d1 = makeDisposal({
        asset: 'ETH',
        amount: '1.0',
        proceeds: '2000.00',
        costBasis: '1500.00',
        term: 'short-term',
        acquiredAt: new Date(Date.UTC(2024, 0, 1)),
        disposedAt: new Date(Date.UTC(2024, 3, 1)),
      });
      const d2 = makeDisposal({
        asset: 'BTC',
        amount: '0.1',
        proceeds: '6000.00',
        costBasis: '4000.00',
        term: 'long-term',
        acquiredAt: new Date(Date.UTC(2022, 5, 1)),
        disposedAt: new Date(Date.UTC(2024, 7, 1)),
      });
      const result = makeTaxResult([d1, d2]);
      const txf = formatTxf(result);
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.records).toHaveLength(2);
      expect(parsed.records[0]!.taxLine).toBe(712);
      expect(parsed.records[0]!.description).toBe('1.0 ETH');
      expect(parsed.records[1]!.taxLine).toBe(714);
      expect(parsed.records[1]!.description).toBe('0.1 BTC');
    });

    it('round-trips amounts to 2 decimal places', () => {
      const disposal = makeDisposal({
        proceeds: '12345.67',
        costBasis: '9876.54',
      });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result);
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.records[0]!.proceeds).toBe('12345.67');
      expect(parsed.records[0]!.costBasis).toBe('9876.54');
    });

    it('parses header-only TXF (empty disposals) as zero records', () => {
      const result = makeTaxResult([]);
      const txf = formatTxf(result);
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.records).toHaveLength(0);
    });

    it('round-trips with checkbox A override', () => {
      const disposal = makeDisposal({ term: 'short-term' });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result, { checkbox: 'A' });
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.records[0]!.taxLine).toBe(321);
    });

    it('round-trips with checkbox B override', () => {
      const disposal = makeDisposal({ term: 'long-term' });
      const result = makeTaxResult([disposal]);
      const txf = formatTxf(result, { checkbox: 'B' });
      const parsed = parseTxf(txf);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.records[0]!.taxLine).toBe(713);
    });
  });

  describe('malformed input', () => {
    it('rejects missing version line', () => {
      const parsed = parseTxf('X042\r\nAdaybook\r\nD01/01/2024\r\n^\r\n');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.line).toBe(1);
      expect(parsed.field).toBe('version');
      expect(parsed.error).toContain('V042');
    });

    it('rejects missing software identifier', () => {
      const parsed = parseTxf('V042\r\nXdaybook\r\nD01/01/2024\r\n^\r\n');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.line).toBe(2);
      expect(parsed.field).toBe('software');
    });

    it('rejects missing header date', () => {
      const parsed = parseTxf('V042\r\nAdaybook\r\nX01/01/2024\r\n^\r\n');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.line).toBe(3);
      expect(parsed.field).toBe('date');
    });

    it('rejects missing header terminator', () => {
      const parsed = parseTxf('V042\r\nAdaybook\r\nD01/01/2024\r\nX\r\n');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.line).toBe(4);
      expect(parsed.field).toBe('terminator');
    });

    it('rejects file that is too short', () => {
      const parsed = parseTxf('V042\r\n');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('header');
    });

    it('rejects invalid tax line number', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        'TD', 'N999', 'C1', 'L1', 'P1.0 ETH',
        'D01/01/2024', 'D06/01/2024', '$1000.00', '$2000.00', '^',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('taxLine');
      expect(parsed.error).toContain('999');
    });

    it('rejects invalid date format in record', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        'TD', 'N712', 'C1', 'L1', 'P1.0 ETH',
        'D2024-01-01', 'D06/01/2024', '$1000.00', '$2000.00', '^',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('dateAcquired');
      expect(parsed.error).toContain('MM/DD/YYYY');
    });

    it('rejects non-numeric amount', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        'TD', 'N712', 'C1', 'L1', 'P1.0 ETH',
        'D01/01/2024', 'D06/01/2024', '$abc', '$2000.00', '^',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('costBasis');
      expect(parsed.error).toContain('abc');
    });

    it('rejects incomplete record', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        'TD', 'N712', 'C1',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('record');
      expect(parsed.error).toContain('Incomplete');
    });

    it('rejects empty description', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        'TD', 'N712', 'C1', 'L1', 'P',
        'D01/01/2024', 'D06/01/2024', '$1000.00', '$2000.00', '^',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('description');
      expect(parsed.error).toContain('Empty');
    });

    it('reports correct line number for errors in second record', () => {
      const txf = [
        'V042', 'Adaybook', 'D01/01/2024', '^',
        // Valid first record (10 lines: index 4–13)
        'TD', 'N712', 'C1', 'L1', 'P1.0 ETH',
        'D01/01/2024', 'D06/01/2024', '$1000.00', '$2000.00', '^',
        // Invalid second record — bad tax line
        'TD', 'N999', 'C1', 'L1', 'P0.5 BTC',
        'D01/01/2023', 'D06/01/2024', '$500.00', '$1000.00', '^',
      ].join('\r\n') + '\r\n';

      const parsed = parseTxf(txf);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('taxLine');
      // Line 16 (1-indexed): header 4 + first record 10 + TD(15) + N999(16)
      expect(parsed.line).toBe(16);
    });
  });
});

// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';
import { arbTaxResult } from './test-helpers.js';
import { formatMoney } from './format-helpers.js';

describe('property-based tests', () => {
  // Feature: tax-form-generation, Property 7: TXF record count equals disposal count
  it('TXF record count equals disposal count', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const txf = formatTxf(taxResult);
        const parsed = parseTxf(txf);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        expect(parsed.records.length).toBe(taxResult.disposals.length);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 8: TXF round-trip amounts
  it('TXF round-trip amounts match originals to 2 decimal places', () => {
    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const txf = formatTxf(taxResult);
        const parsed = parseTxf(txf);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        for (let i = 0; i < taxResult.disposals.length; i++) {
          const disposal = taxResult.disposals[i]!;
          const record = parsed.records[i]!;

          expect(record.proceeds).toBe(formatMoney(disposal.proceeds));
          expect(record.costBasis).toBe(formatMoney(disposal.costBasis));
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: tax-form-generation, Property 10: TXF tax line correctness
  it('short-term disposals use short-term tax lines, long-term use long-term tax lines', () => {
    const SHORT_TERM_LINES = new Set([321, 711, 712]);
    const LONG_TERM_LINES = new Set([323, 713, 714]);

    fc.assert(
      fc.property(arbTaxResult, (taxResult) => {
        const txf = formatTxf(taxResult);
        const parsed = parseTxf(txf);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        for (let i = 0; i < taxResult.disposals.length; i++) {
          const disposal = taxResult.disposals[i]!;
          const record = parsed.records[i]!;

          if (disposal.term === 'short-term') {
            expect(SHORT_TERM_LINES.has(record.taxLine)).toBe(true);
          } else {
            expect(LONG_TERM_LINES.has(record.taxLine)).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
