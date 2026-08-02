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
import Decimal from 'decimal.js';
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

  // ─── Parity / scale test ─────────────────────────────────────────────
  // Verifies that the indexed implementation produces identical washSaleFlag
  // results to a straightforward naïve reference on a large, deterministic
  // dataset.  This is the CI regression guard for the O(A+D·W) rewrite.
  describe('parity with naïve reference on large dataset', () => {
    /**
     * Deterministic LCG pseudo-random number generator so the test is
     * reproducible across environments without any external library.
     * Returns a function that yields floats in [0, 1).
     */
    function makeLcg(seed: number): () => number {
      // Numerical Recipes LCG constants
      const a = 1_664_525;
      const c = 1_013_904_223;
      const m = 2 ** 32;
      let state = seed >>> 0;
      return () => {
        state = (a * state + c) >>> 0;
        return state / m;
      };
    }

    /** Naïve O(D×A) reference — equivalent to the original implementation. */
    function naiveApplyWashSaleFlags(
      disposals: DisposalResult[],
      acquisitions: ReadonlyArray<AcquisitionRecord>,
    ): DisposalResult[] {
      const MS = 86_400_000;
      const WINDOW = 30;
      const dayOf = (d: Date) => Math.floor(d.getTime() / MS);
      return disposals.map((d) => {
        if (new Decimal(d.gainLoss).gte(0)) return { ...d, washSaleFlag: false };
        const disposalDay = dayOf(d.disposedAt);
        const flag = acquisitions.some(
          (a) => a.asset === d.asset && Math.abs(dayOf(a.acquiredAt) - disposalDay) <= WINDOW,
        );
        return { ...d, washSaleFlag: flag };
      });
    }

    it('produces identical flags to the naïve reference for 2 000 disposals × 5 000 acquisitions', () => {
      const rand = makeLcg(0xdeadbeef);

      const assets = ['BTC', 'ETH', 'SOL', 'MATIC', 'AVAX'];
      // Epoch base: 2024-01-01 UTC
      const BASE_DAY = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 86_400_000);
      const SPREAD = 500; // days spread around base

      const acquisitions: AcquisitionRecord[] = Array.from({ length: 5_000 }, () => ({
        asset: assets[Math.floor(rand() * assets.length)]!,
        acquiredAt: new Date((BASE_DAY + Math.floor(rand() * SPREAD * 2 - SPREAD)) * 86_400_000),
      }));

      const disposals: DisposalResult[] = Array.from({ length: 2_000 }, (_, i) => {
        // Mix losses (~70%) and gains (~30%) so the short-circuit path is exercised
        const isLoss = rand() < 0.7;
        return makeDisposal({
          asset: assets[Math.floor(rand() * assets.length)]!,
          gainLoss: isLoss ? (-1 * (rand() * 1000 + 1)).toFixed(2) : (rand() * 1000 + 1).toFixed(2),
          disposedAt: new Date((BASE_DAY + Math.floor(rand() * SPREAD * 2 - SPREAD)) * 86_400_000),
          sourceEntryId: `entry-${i}`,
        });
      });

      const expected = naiveApplyWashSaleFlags(disposals, acquisitions);
      const actual = applyWashSaleFlags(disposals, acquisitions);

      expect(actual).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]!.washSaleFlag).toBe(expected[i]!.washSaleFlag);
      }
    });

    it('boundary parity: exactly-30-day and 31-day edges hold across many assets', () => {
      // For each of several assets build one disposal and acquisitions at
      // exactly -30, -31, +30, +31 days relative to the disposal. Confirm
      // the indexed result matches the naïve result for every case.
      const rand = makeLcg(0xcafebabe);
      const ASSET_COUNT = 20;
      const BASE = new Date('2024-06-01T00:00:00Z');

      const assetNames = Array.from({ length: ASSET_COUNT }, (_, i) => `TOKEN${i}`);

      const disposals: DisposalResult[] = assetNames.map((asset, i) =>
        makeDisposal({
          asset,
          gainLoss: '-1',
          disposedAt: new Date(BASE.getTime() + i * 86_400_000 * 2),
          sourceEntryId: `disp-${i}`,
        }),
      );

      const acquisitions: AcquisitionRecord[] = disposals.flatMap((d) => [
        { asset: d.asset, acquiredAt: daysFrom(d.disposedAt, -30) },
        { asset: d.asset, acquiredAt: daysFrom(d.disposedAt, -31) },
        { asset: d.asset, acquiredAt: daysFrom(d.disposedAt, 30) },
        { asset: d.asset, acquiredAt: daysFrom(d.disposedAt, 31) },
        // random noise from other assets
        { asset: assetNames[Math.floor(rand() * assetNames.length)]!, acquiredAt: daysFrom(d.disposedAt, 5) },
      ]);

      const expected = naiveApplyWashSaleFlags(disposals, acquisitions);
      const actual = applyWashSaleFlags(disposals, acquisitions);

      expect(actual).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        // -30 and +30 are inside the window → true; -31 and +31 are outside
        // but -30/+30 acquisitions exist so all should be true here
        expect(actual[i]!.washSaleFlag).toBe(expected[i]!.washSaleFlag);
      }
    });
  });
});
