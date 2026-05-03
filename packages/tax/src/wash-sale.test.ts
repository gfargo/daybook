/**
 * Unit tests for the wash-sale flagging pass.
 *
 * Validates:
 *   - Loss disposal with acquisition within ±30 days → washSaleFlag: true
 *   - Loss disposal with acquisition >30 days away → washSaleFlag: false
 *   - Gain disposal → washSaleFlag: false without any lookup
 *   - Different asset acquisition within window → washSaleFlag: false
 *   - Every disposal in the output has washSaleFlag set (completeness)
 *   - Break-even disposal → washSaleFlag: false
 *
 * **Validates: Requirements 8.2, 8.3, 8.4, 8.9, 8.10**
 */

import { describe, expect, it } from 'vitest';
import { applyWashSaleFlags } from './wash-sale.js';
import type { AcquisitionRecord } from './wash-sale.js';
import type { DisposalResult } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create a DisposalResult with sensible defaults. */
function makeDisposal(overrides: Partial<DisposalResult> & { asset: string; gainLoss: string; disposedAt: Date }): DisposalResult {
  return {
    amount: '1.0',
    proceeds: '1000',
    costBasis: '1000',
    term: 'short-term',
    acquiredAt: new Date('2024-01-01T00:00:00Z'),
    sourceEntryId: 'entry-1',
    lotsConsumed: [],
    washSaleFlag: false,
    ...overrides,
  };
}

/** Create a Date offset by a number of days from a base date. */
function daysFrom(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('applyWashSaleFlags', () => {
  const disposalDate = new Date('2024-06-15T12:00:00Z');

  describe('loss disposal with acquisition within window', () => {
    it('flags when same asset acquired 15 days before disposal', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-500',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, -15) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(1);
      expect(result[0]!.washSaleFlag).toBe(true);
    });

    it('flags when same asset acquired 15 days after disposal', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-500',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, 15) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(1);
      expect(result[0]!.washSaleFlag).toBe(true);
    });

    it('flags when acquisition is exactly 30 days before', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'BTC',
          gainLoss: '-100',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'BTC', acquiredAt: daysFrom(disposalDate, -30) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result[0]!.washSaleFlag).toBe(true);
    });

    it('flags when acquisition is exactly 30 days after', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'BTC',
          gainLoss: '-100',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'BTC', acquiredAt: daysFrom(disposalDate, 30) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result[0]!.washSaleFlag).toBe(true);
    });
  });

  describe('loss disposal with acquisition outside window', () => {
    it('does not flag when acquisition is 31 days away', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-500',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, 31) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(1);
      expect(result[0]!.washSaleFlag).toBe(false);
    });

    it('does not flag when acquisition is 31 days before', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-200',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, -31) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result[0]!.washSaleFlag).toBe(false);
    });
  });

  describe('gain disposal', () => {
    it('sets washSaleFlag: false without any lookup', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '500',
          disposedAt: disposalDate,
        }),
      ];

      // Acquisition within window — should still be false for gains
      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, 5) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(1);
      expect(result[0]!.washSaleFlag).toBe(false);
    });

    it('sets washSaleFlag: false for break-even (gainLoss = 0)', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '0',
          disposedAt: disposalDate,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, 1) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result[0]!.washSaleFlag).toBe(false);
    });
  });

  describe('different asset acquisition within window', () => {
    it('does not flag when a different asset is acquired within window', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-500',
          disposedAt: disposalDate,
        }),
      ];

      // BTC acquired within window, but disposal is ETH
      const acquisitions: AcquisitionRecord[] = [
        { asset: 'BTC', acquiredAt: daysFrom(disposalDate, 5) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(1);
      expect(result[0]!.washSaleFlag).toBe(false);
    });
  });

  describe('completeness', () => {
    it('every disposal in the output has washSaleFlag set', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({ asset: 'ETH', gainLoss: '-500', disposedAt: disposalDate }),
        makeDisposal({ asset: 'BTC', gainLoss: '200', disposedAt: disposalDate }),
        makeDisposal({ asset: 'ETH', gainLoss: '-100', disposedAt: daysFrom(disposalDate, 60) }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: daysFrom(disposalDate, 10) },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      expect(result).toHaveLength(3);
      for (const d of result) {
        expect(typeof d.washSaleFlag).toBe('boolean');
      }

      // First ETH loss: acquisition 10 days after → flagged
      expect(result[0]!.washSaleFlag).toBe(true);
      // BTC gain: always false
      expect(result[1]!.washSaleFlag).toBe(false);
      // Second ETH loss: acquisition 50 days before (60 - 10) → outside window
      expect(result[2]!.washSaleFlag).toBe(false);
    });

    it('returns empty array for empty disposals', () => {
      const result = applyWashSaleFlags([], []);
      expect(result).toHaveLength(0);
    });

    it('handles no acquisitions — all losses unflagged', () => {
      const disposals: DisposalResult[] = [
        makeDisposal({ asset: 'ETH', gainLoss: '-500', disposedAt: disposalDate }),
      ];

      const result = applyWashSaleFlags(disposals, []);

      expect(result[0]!.washSaleFlag).toBe(false);
    });
  });

  describe('calendar day comparison (UTC)', () => {
    it('uses UTC calendar days, not 24-hour periods', () => {
      // Disposal at end of day UTC
      const disposalLateUtc = new Date('2024-06-15T23:59:59Z');

      // Acquisition at start of day 30 days later
      const acquisitionEarlyUtc = new Date('2024-07-15T00:00:01Z');

      const disposals: DisposalResult[] = [
        makeDisposal({
          asset: 'ETH',
          gainLoss: '-500',
          disposedAt: disposalLateUtc,
        }),
      ];

      const acquisitions: AcquisitionRecord[] = [
        { asset: 'ETH', acquiredAt: acquisitionEarlyUtc },
      ];

      const result = applyWashSaleFlags(disposals, acquisitions);

      // June 15 to July 15 = 30 calendar days → within window
      expect(result[0]!.washSaleFlag).toBe(true);
    });
  });
});
