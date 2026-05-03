/**
 * Tests for `daybook compare <year>` command.
 *
 * Uses an in-memory SQLite database with synthetic LedgerEntries
 * to verify the compare command renders correct output.
 */

import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@daybook/ledger';
import { compareMethods, summarizeResults } from '@daybook/tax';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build synthetic LedgerEntries for testing:
 *   - 2 buys (income) of ETH at different prices
 *   - 1 sell (trade) of ETH
 *
 * This lets us verify FIFO vs HIFO produce different results.
 */
function buildTestEntries(): LedgerEntry[] {
  return [
    // Buy 1: 1 ETH at $1000 (2024-01-15)
    {
      id: 'entry-buy-1',
      timestamp: new Date('2024-01-15T12:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USD', amount: '-1000', amountUsdAtTime: '1000', amountUsdReportedBySource: '1000' },
        { asset: 'ETH', amount: '1', amountUsdAtTime: '1000', amountUsdReportedBySource: '1000' },
      ],
      rawEventIds: ['raw-1'],
    },
    // Buy 2: 1 ETH at $2000 (2024-03-15)
    {
      id: 'entry-buy-2',
      timestamp: new Date('2024-03-15T12:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'USD', amount: '-2000', amountUsdAtTime: '2000', amountUsdReportedBySource: '2000' },
        { asset: 'ETH', amount: '1', amountUsdAtTime: '2000', amountUsdReportedBySource: '2000' },
      ],
      rawEventIds: ['raw-2'],
    },
    // Sell: 1 ETH at $2500 (2024-06-15)
    {
      id: 'entry-sell-1',
      timestamp: new Date('2024-06-15T12:00:00Z'),
      type: 'trade',
      legs: [
        { asset: 'ETH', amount: '-1', amountUsdAtTime: '2500', amountUsdReportedBySource: '2500' },
        { asset: 'USD', amount: '2500', amountUsdAtTime: '2500', amountUsdReportedBySource: '2500' },
      ],
      rawEventIds: ['raw-3'],
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('compareMethods integration', () => {
  it('should produce different results for FIFO vs HIFO', () => {
    const entries = buildTestEntries();
    const result = compareMethods(entries, 2024);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.method).toBe('FIFO');
    expect(result.results[1]!.method).toBe('HIFO');

    // FIFO sells the $1000 lot → gain = $2500 - $1000 = $1500
    // HIFO sells the $2000 lot → gain = $2500 - $2000 = $500
    const fifoResult = result.results[0]!.result;
    const hifoResult = result.results[1]!.result;

    expect(fifoResult.disposals).toHaveLength(1);
    expect(hifoResult.disposals).toHaveLength(1);

    expect(fifoResult.disposals[0]!.gainLoss).toBe('1500');
    expect(hifoResult.disposals[0]!.gainLoss).toBe('500');

    // HIFO should be the lowest tax method
    expect(result.lowestTaxMethod).toBe('HIFO');
  });

  it('should summarize results correctly', () => {
    const entries = buildTestEntries();
    const result = compareMethods(entries, 2024);
    const summaries = summarizeResults(result);

    expect(summaries).toHaveLength(2);

    const fifoSummary = summaries.find(s => s.method === 'FIFO')!;
    const hifoSummary = summaries.find(s => s.method === 'HIFO')!;

    expect(fifoSummary.disposalCount).toBe(1);
    expect(hifoSummary.disposalCount).toBe(1);

    expect(fifoSummary.totalTaxable).toBe('1500');
    expect(hifoSummary.totalTaxable).toBe('500');

    // Both are short-term (< 365 days)
    expect(fifoSummary.shortTermGain).toBe('1500');
    expect(hifoSummary.shortTermGain).toBe('500');
    expect(fifoSummary.longTermGain).toBe('0');
    expect(hifoSummary.longTermGain).toBe('0');
  });

  it('should handle entries with no disposals in the target year', () => {
    const entries = buildTestEntries();
    // Query for a year with no disposals
    const result = compareMethods(entries, 2023);

    expect(result.results).toHaveLength(2);
    const summaries = summarizeResults(result);

    for (const s of summaries) {
      expect(s.disposalCount).toBe(0);
      expect(s.totalTaxable).toBe('0');
    }
  });

  it('should handle income entries in the summary', () => {
    const entries: LedgerEntry[] = [
      // Income: 0.5 ETH staking reward at $1500 (2024-02-01)
      {
        id: 'entry-income-1',
        timestamp: new Date('2024-02-01T12:00:00Z'),
        type: 'income',
        legs: [
          { asset: 'ETH', amount: '0.5', amountUsdAtTime: '750', amountUsdReportedBySource: '750' },
        ],
        rawEventIds: ['raw-income-1'],
      },
    ];

    const result = compareMethods(entries, 2024);
    const summaries = summarizeResults(result);

    for (const s of summaries) {
      expect(s.disposalCount).toBe(0);
      expect(s.incomeTotal).toBe('750');
    }
  });
});

describe('compareCommand year validation', () => {
  it('should reject non-numeric year', async () => {
    const { compareCommand } = await import('./compare.js');
    await expect(
      compareCommand('abc', { config: '/nonexistent/config.json' }),
    ).rejects.toThrow('Invalid year');
  });

  it('should reject year out of range', async () => {
    const { compareCommand } = await import('./compare.js');
    await expect(
      compareCommand('1999', { config: '/nonexistent/config.json' }),
    ).rejects.toThrow('Invalid year');
  });
});
