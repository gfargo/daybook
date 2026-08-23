/**
 * Tests for the CLI pricing-chain helpers: hydratePrices dedup, concurrency
 * cap, progress reporting, and result application.
 *
 * We mock PricingChain.priceAt entirely so these tests have no SQLite or
 * network dependency.
 */

import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import type { LedgerEntry, LedgerLeg } from '@daybook/ledger';
import { hydratePrices } from './pricing-chain.js';
import type { PricingChain } from '@daybook/tax';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Build a minimal LedgerLeg. */
function makeLeg(
  asset: string,
  amount: string,
  overrides: Partial<LedgerLeg> = {},
): LedgerLeg {
  return {
    asset,
    amount,
    amountUsdAtTime: undefined,
    amountUsdReportedBySource: undefined,
    contractAddress: undefined,
    ...overrides,
  } as LedgerLeg;
}

/** Build a minimal LedgerEntry with the given legs. */
function makeEntry(timestamp: Date, legs: LedgerLeg[]): LedgerEntry {
  return {
    id: `entry-${Math.random()}`,
    rawEventId: 'evt-1',
    source: 'coinbase',
    accountId: 'acct-1',
    timestamp,
    type: 'trade',
    legs,
  } as unknown as LedgerEntry;
}

/** Build a mock PricingChain that returns the given per-asset prices. */
function makeMockChain(
  prices: Record<string, string>,
  opts?: { onCall?: (asset: string) => void },
): PricingChain {
  return {
    async priceAt(asset: string): Promise<{ priceUsd: string; source: string } | null> {
      opts?.onCall?.(asset);
      const key = asset.toUpperCase();
      const price = prices[key];
      return price ? { priceUsd: price, source: 'mock' } : null;
    },
  } as unknown as PricingChain;
}

const JAN_15 = new Date('2024-01-15T12:00:00Z');
const JAN_16 = new Date('2024-01-16T12:00:00Z');

// ─────────────────────────────────────────────────────────────────────────
// De-duplication tests
// ─────────────────────────────────────────────────────────────────────────

describe('hydratePrices — deduplication', () => {
  it('calls priceAt once when multiple legs share the same (asset, day)', async () => {
    let callCount = 0;
    const chain = makeMockChain({ ETH: '2000' }, { onCall: () => callCount++ });

    const legs = [
      makeLeg('ETH', '1'),
      makeLeg('ETH', '2'),
      makeLeg('ETH', '0.5'),
    ];
    const entry = makeEntry(JAN_15, legs);

    await hydratePrices([entry], chain);

    // Three legs, same (ETH, JAN_15) key → exactly 1 provider call
    expect(callCount).toBe(1);
  });

  it('applies the deduplicated price to all matching legs', async () => {
    const chain = makeMockChain({ ETH: '3000' });

    const legs = [
      makeLeg('ETH', '2'),   // → 2 * 3000 = 6000
      makeLeg('ETH', '-1'),  // abs(-1) * 3000 = 3000
      makeLeg('ETH', '0.5'), // 0.5 * 3000 = 1500
    ];
    const entry = makeEntry(JAN_15, legs);

    await hydratePrices([entry], chain);

    expect(legs[0]!.amountUsdAtTime).toBe('6000');
    expect(legs[1]!.amountUsdAtTime).toBe('3000');
    expect(legs[2]!.amountUsdAtTime).toBe('1500');
  });

  it('makes separate calls for the same asset on different days', async () => {
    const calls: string[] = [];
    const chain = makeMockChain({ ETH: '2000' }, {
      onCall: (asset) => calls.push(asset),
    });

    const entry1 = makeEntry(JAN_15, [makeLeg('ETH', '1')]);
    const entry2 = makeEntry(JAN_16, [makeLeg('ETH', '1')]);

    await hydratePrices([entry1, entry2], chain);

    // Two different days → two calls
    expect(calls.length).toBe(2);
  });

  it('makes separate calls for different assets on the same day', async () => {
    const calls: string[] = [];
    const chain = makeMockChain({ ETH: '2000', BTC: '40000' }, {
      onCall: (asset) => calls.push(asset),
    });

    const entry = makeEntry(JAN_15, [makeLeg('ETH', '1'), makeLeg('BTC', '0.1')]);

    await hydratePrices([entry], chain);

    expect(calls.length).toBe(2);
  });

  it('skips legs that already have amountUsdAtTime set', async () => {
    let callCount = 0;
    const chain = makeMockChain({ ETH: '2000' }, { onCall: () => callCount++ });

    const leg = makeLeg('ETH', '1', { amountUsdAtTime: '1900' });
    const entry = makeEntry(JAN_15, [leg]);

    await hydratePrices([entry], chain);

    expect(callCount).toBe(0);
    expect(leg.amountUsdAtTime).toBe('1900'); // unchanged
  });

  it('skips legs that already have amountUsdReportedBySource set', async () => {
    let callCount = 0;
    const chain = makeMockChain({ ETH: '2000' }, { onCall: () => callCount++ });

    const leg = makeLeg('ETH', '1', { amountUsdReportedBySource: '2100' });
    const entry = makeEntry(JAN_15, [leg]);

    await hydratePrices([entry], chain);

    expect(callCount).toBe(0);
  });

  it('returns early with no calls when all legs are already priced', async () => {
    let callCount = 0;
    const chain = makeMockChain({ ETH: '2000' }, { onCall: () => callCount++ });

    const entries = [
      makeEntry(JAN_15, [
        makeLeg('ETH', '1', { amountUsdAtTime: '1000' }),
        makeLeg('BTC', '0.1', { amountUsdReportedBySource: '4000' }),
      ]),
    ];

    await hydratePrices(entries, chain);
    expect(callCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Concurrency tests
// ─────────────────────────────────────────────────────────────────────────

describe('hydratePrices — concurrency', () => {
  it('never exceeds the concurrency cap', async () => {
    let maxInFlight = 0;
    let inFlight = 0;

    // 10 distinct (asset, day) combinations — each takes a microtask
    const assets = Array.from({ length: 10 }, (_, i) => `TKN${i}`);
    const priceMap = Object.fromEntries(assets.map(a => [a, '1.00']));

    const chain: PricingChain = {
      async priceAt(asset: string) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to event loop so concurrency can be measured
        await Promise.resolve();
        inFlight--;
        const price = priceMap[asset.toUpperCase()];
        return price ? { priceUsd: price, source: 'mock' } : null;
      },
    } as unknown as PricingChain;

    const entries = assets.map(asset => makeEntry(JAN_15, [makeLeg(asset, '1')]));
    const cap = 3;
    await hydratePrices(entries, chain, undefined, cap);

    expect(maxInFlight).toBeLessThanOrEqual(cap);
  });

  it('completes all lookups even when concurrency < total items', async () => {
    const resolved: string[] = [];
    const assets = Array.from({ length: 8 }, (_, i) => `TKN${i}`);

    const chain: PricingChain = {
      async priceAt(asset: string) {
        resolved.push(asset.toUpperCase());
        return { priceUsd: '5.00', source: 'mock' };
      },
    } as unknown as PricingChain;

    const entries = assets.map(asset => makeEntry(JAN_15, [makeLeg(asset, '1')]));
    await hydratePrices(entries, chain, undefined, 2);

    expect(resolved.length).toBe(8);
    // Every leg must be priced
    for (const entry of entries) {
      for (const leg of entry.legs) {
        expect(leg.amountUsdAtTime).toBe('5');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Progress callback tests
// ─────────────────────────────────────────────────────────────────────────

describe('hydratePrices — progress reporting', () => {
  it('calls onProgress with increasing done up to total', async () => {
    const progressUpdates: Array<[number, number]> = [];
    const chain = makeMockChain({ ETH: '2000', BTC: '40000', SOL: '100' });

    const entries = [
      makeEntry(JAN_15, [makeLeg('ETH', '1'), makeLeg('BTC', '0.1')]),
      makeEntry(JAN_16, [makeLeg('SOL', '10')]),
    ];

    await hydratePrices(entries, chain, (done, total) => {
      progressUpdates.push([done, total]);
    });

    // 3 distinct keys → total should be 3
    const total = progressUpdates[progressUpdates.length - 1]?.[1];
    expect(total).toBe(3);

    // done values should be monotonically increasing
    const doneValues = progressUpdates.map(([d]) => d);
    for (let i = 1; i < doneValues.length; i++) {
      expect(doneValues[i]).toBeGreaterThan(doneValues[i - 1]!);
    }

    // Final done should equal total
    const [finalDone, finalTotal] = progressUpdates[progressUpdates.length - 1]!;
    expect(finalDone).toBe(finalTotal);
  });

  it('calls onProgress exactly once per distinct key', async () => {
    const progressUpdates: number[] = [];
    const chain = makeMockChain({ ETH: '2000' });

    // 4 legs but all same (ETH, JAN_15) → 1 distinct key
    const legs = [
      makeLeg('ETH', '1'),
      makeLeg('ETH', '2'),
      makeLeg('ETH', '3'),
      makeLeg('ETH', '4'),
    ];
    const entry = makeEntry(JAN_15, legs);

    await hydratePrices([entry], chain, done => progressUpdates.push(done));

    expect(progressUpdates).toHaveLength(1);
    expect(progressUpdates[0]).toBe(1);
  });

  it('does not call onProgress when there are no unpriced legs', async () => {
    const progressCalled = vi.fn();
    const chain = makeMockChain({ ETH: '2000' });

    const entry = makeEntry(JAN_15, [
      makeLeg('ETH', '1', { amountUsdAtTime: '2000' }),
    ]);

    await hydratePrices([entry], chain, progressCalled);

    expect(progressCalled).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Arithmetic tests
// ─────────────────────────────────────────────────────────────────────────

describe('hydratePrices — amount computation', () => {
  it('uses absolute value of amount (negative amounts are correct)', async () => {
    const chain = makeMockChain({ ETH: '2000' });

    const leg = makeLeg('ETH', '-3'); // sell leg
    const entry = makeEntry(JAN_15, [leg]);

    await hydratePrices([entry], chain);

    // |-3| * 2000 = 6000
    const expected = new Decimal('3').mul('2000').toString();
    expect(leg.amountUsdAtTime).toBe(expected);
  });

  it('leaves legs unchanged when priceAt returns null', async () => {
    const chain = makeMockChain({}); // no prices

    const leg = makeLeg('UNKNOWNTOKEN', '1');
    const entry = makeEntry(JAN_15, [leg]);

    await hydratePrices([entry], chain);

    expect(leg.amountUsdAtTime).toBeUndefined();
  });
});
