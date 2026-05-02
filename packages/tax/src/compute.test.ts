/**
 * Unit tests for the computeTax entry point.
 *
 * Validates FIFO/HIFO gain/loss, fee subtraction from proceeds,
 * holding period classification, income lot creation, and unpriced
 * event tracking.
 *
 * **Validates: Requirements 18.1, 19.1, 21.3, 24.2**
 */

import { describe, expect, it } from 'vitest';
import type { LedgerEntry, LedgerEntryType, AssetLeg } from '@daybook/ledger';
import { computeTax } from './compute.js';
import { FIFO, HIFO } from './cost-basis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Build a LedgerEntry with sensible defaults. */
function makeEntry(overrides: {
  id: string;
  timestamp: Date;
  type: LedgerEntryType;
  legs: AssetLeg[];
  rawEventIds?: string[];
}): LedgerEntry {
  return {
    rawEventIds: [overrides.id],
    ...overrides,
  };
}

// ─── Shared fixtures ─────────────────────────────────────────────────────

/**
 * Two buys + one sell scenario used by FIFO and HIFO tests.
 *
 * Buy 1: 1 ETH at $1,000 on 2023-01-15
 * Buy 2: 1 ETH at $2,000 on 2023-06-15
 * Sell:  1 ETH at $2,500 on 2024-03-15
 */
function twobuysOneSellEntries(): LedgerEntry[] {
  return [
    makeEntry({
      id: 'buy-1',
      timestamp: new Date('2023-01-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '1', amountUsdAtTime: '1000' },
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
      ],
    }),
    makeEntry({
      id: 'buy-2',
      timestamp: new Date('2023-06-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '1', amountUsdAtTime: '2000' },
        { asset: 'USD', amount: '-2000', amountUsdAtTime: '2000' },
      ],
    }),
    makeEntry({
      id: 'sell-1',
      timestamp: new Date('2024-03-15T00:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-1', amountUsdAtTime: '2500' },
        { asset: 'USD', amount: '2500', amountUsdAtTime: '2500' },
      ],
    }),
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('computeTax', () => {
  // ─── Test 1: FIFO gain/loss ──────────────────────────────────────────
  describe('FIFO produces correct gain/loss', () => {
    it('disposes the $1,000 lot first → $1,500 long-term gain', () => {
      const entries = twobuysOneSellEntries();
      const result = computeTax(entries, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // FIFO picks the oldest lot (buy-1 at $1,000)
      expect(d.proceeds).toBe('2500');
      expect(d.costBasis).toBe('1000');
      expect(d.gainLoss).toBe('1500');
      // Jan 2023 → Mar 2024 = >365 days → long-term
      expect(d.term).toBe('long-term');
    });
  });

  // ─── Test 2: HIFO gain/loss ──────────────────────────────────────────
  describe('HIFO produces correct gain/loss', () => {
    it('disposes the $2,000 lot first → $500 short-term gain', () => {
      const entries = twobuysOneSellEntries();
      const result = computeTax(entries, {
        method: HIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // HIFO picks the highest-cost lot (buy-2 at $2,000)
      expect(d.proceeds).toBe('2500');
      expect(d.costBasis).toBe('2000');
      expect(d.gainLoss).toBe('500');
      // Jun 2023 → Mar 2024 = ~274 days → short-term
      expect(d.term).toBe('short-term');
    });
  });

  // ─── Test 3: Fee subtraction from proceeds ───────────────────────────
  describe('fee subtraction from proceeds', () => {
    it('subtracts fee USD from proceeds before computing gain', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'buy-fee',
          timestamp: new Date('2023-01-15T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '1', amountUsdAtTime: '1000' },
            { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
          ],
        }),
        makeEntry({
          id: 'sell-fee',
          timestamp: new Date('2024-06-15T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '-1', amountUsdAtTime: '1500' },
            { asset: 'USD', amount: '1500', amountUsdAtTime: '1500' },
            { asset: 'ETH', amount: '-0.001', amountUsdAtTime: '50', feeFlag: true },
          ],
        }),
      ];

      const result = computeTax(entries, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      // The sell leg disposal
      expect(result.disposals.length).toBeGreaterThanOrEqual(1);
      const sellDisposal = result.disposals.find(
        (d) => d.sourceEntryId === 'sell-fee' && d.amount === '1',
      );
      expect(sellDisposal).toBeDefined();

      // Proceeds: $1,500 - $50 fee = $1,450
      expect(sellDisposal!.proceeds).toBe('1450');
      // Cost basis: $1,000
      expect(sellDisposal!.costBasis).toBe('1000');
      // Gain: $1,450 - $1,000 = $450
      expect(sellDisposal!.gainLoss).toBe('450');
    });
  });

  // ─── Test 4: Holding period classification ───────────────────────────
  describe('holding period classification', () => {
    it('classifies < 365 days as short-term', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'buy-hp',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '1', amountUsdAtTime: '1000' },
            { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000' },
          ],
        }),
        makeEntry({
          id: 'sell-hp',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '-1', amountUsdAtTime: '1500' },
            { asset: 'USD', amount: '1500', amountUsdAtTime: '1500' },
          ],
        }),
      ];

      const result = computeTax(entries, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      expect(result.disposals).toHaveLength(1);
      // Jan 1 → Jun 1 = 152 days → short-term
      expect(result.disposals[0]!.term).toBe('short-term');
    });
  });

  // ─── Test 5: Income creates lots and appears in summary ──────────────
  describe('income creates lots and appears in summary', () => {
    it('records income at FMV and creates a lot for future disposal', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'income-1',
          timestamp: new Date('2024-03-01T00:00:00Z'),
          type: 'income',
          legs: [
            { asset: 'ETH', amount: '0.5', amountUsdAtTime: '1000' },
          ],
        }),
      ];

      const result = computeTax(entries, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      // Income summary
      expect(result.income.totalUsd).toBe('1000');
      expect(result.income.byAsset['ETH']).toBe('1000');
      expect(result.income.events).toHaveLength(1);
      expect(result.income.events[0]!.entryId).toBe('income-1');
      expect(result.income.events[0]!.asset).toBe('ETH');
      expect(result.income.events[0]!.amount).toBe('0.5');
      expect(result.income.events[0]!.usdValue).toBe('1000');

      // The lot should be disposable — sell it in the same year
      const entriesWithSell: LedgerEntry[] = [
        ...entries,
        makeEntry({
          id: 'sell-income-lot',
          timestamp: new Date('2024-09-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '-0.5', amountUsdAtTime: '1500' },
            { asset: 'USD', amount: '1500', amountUsdAtTime: '1500' },
          ],
        }),
      ];

      const result2 = computeTax(entriesWithSell, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      expect(result2.disposals).toHaveLength(1);
      const d = result2.disposals[0]!;
      // Cost basis from income lot: $1000 / 0.5 ETH = $2000/ETH unit cost
      // Disposing 0.5 ETH → cost basis = 0.5 * $2000 = $1000
      expect(d.costBasis).toBe('1000');
      expect(d.proceeds).toBe('1500');
      expect(d.gainLoss).toBe('500');
    });
  });

  // ─── Test 6: Unpriced events tracked ─────────────────────────────────
  describe('unpriced events tracked', () => {
    it('adds entry ID to unpricedEvents when legs have no USD values', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'unpriced-trade',
          timestamp: new Date('2024-05-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '1' },
            { asset: 'BTC', amount: '-0.05' },
          ],
        }),
      ];

      const result = computeTax(entries, {
        method: FIFO,
        holdingPeriodDays: 365,
        year: 2024,
      });

      expect(result.unpricedEvents).toContain('unpriced-trade');
    });
  });
});
