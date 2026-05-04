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


// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';
import Decimal from 'decimal.js';

/**
 * Property 6: Counterpart leg pricing derivation
 *
 * For any nft_acquisition or nft_disposal LedgerEntry that includes a
 * fungible counterpart leg with a resolved USD value (amountUsdAtTime),
 * the tax engine uses the absolute value of that USD amount as the NFT's
 * cost basis (for acquisitions) or proceeds (for disposals).
 *
 * **Validates: Requirements 4.1, 4.2**
 *
 * Feature: nft-cost-basis, Property 6: Counterpart leg pricing derivation
 */
describe('Feature: nft-cost-basis, Property 6: Counterpart leg pricing derivation', () => {
  // ─── Generators ──────────────────────────────────────────────────────

  /** Hex character set for building Ethereum addresses. */
  const HEX_CHARS = '0123456789abcdef'.split('');

  /** Arbitrary valid lowercased Ethereum address (0x + 40 hex chars). */
  const arbContractAddress: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
    .map((chars) => `0x${chars.join('')}`);

  /** Arbitrary NFT token ID string (numeric, 0–99999). */
  const arbTokenId: fc.Arbitrary<string> = fc
    .integer({ min: 0, max: 99999 })
    .map(String);

  /** Arbitrary positive USD value as a decimal string (0.01–999999.99). */
  const arbUsdValue: fc.Arbitrary<string> = fc
    .float({ min: Math.fround(0.01), max: Math.fround(999999.99), noNaN: true })
    .map((n) => new Decimal(n.toFixed(2)).toString());

  /** Arbitrary fungible asset ticker for counterpart legs. */
  const arbFungibleAsset: fc.Arbitrary<string> = fc.constantFrom('ETH', 'WETH', 'MATIC', 'LINK');

  /** Arbitrary positive fungible amount as a decimal string. */
  const arbFungibleAmount: fc.Arbitrary<string> = fc
    .float({ min: Math.fround(0.001), max: Math.fround(100.0), noNaN: true })
    .map((n) => new Decimal(n.toFixed(6)).toString());

  /** Build a LedgerEntry with sensible defaults (same helper as unit tests). */
  function makePbtEntry(overrides: {
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

  // ─── Property 6a: Acquisition cost basis from counterpart leg ────────

  it('nft_acquisition cost basis equals counterpart leg USD value', () => {
    fc.assert(
      fc.property(
        arbContractAddress,
        arbTokenId,
        arbFungibleAsset,
        arbFungibleAmount,
        arbUsdValue,
        (contractAddress, tokenId, fungibleAsset, fungibleAmount, usdValue) => {
          const entry = makePbtEntry({
            id: `acq-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-06-15T00:00:00Z'),
            type: 'nft_acquisition',
            legs: [
              {
                asset: contractAddress,
                amount: '1',
                contractAddress,
                tokenId,
              },
              {
                asset: fungibleAsset,
                amount: `-${fungibleAmount}`,
                amountUsdAtTime: usdValue,
              },
            ],
          });

          // Dispose the NFT later so we can observe the cost basis
          const disposalEntry = makePbtEntry({
            id: `disp-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-09-15T00:00:00Z'),
            type: 'nft_disposal',
            legs: [
              {
                asset: contractAddress,
                amount: '-1',
                contractAddress,
                tokenId,
              },
              {
                asset: 'ETH',
                amount: '1',
                amountUsdAtTime: '5000',
              },
            ],
          });

          const result = computeTax([entry, disposalEntry], {
            method: FIFO,
            holdingPeriodDays: 365,
            year: 2024,
          });

          // The disposal should exist and its cost basis should match
          // the absolute value of the counterpart leg's USD value
          const disposal = result.disposals.find(
            (d) => d.sourceEntryId === `disp-${contractAddress}:${tokenId}`,
          );

          expect(disposal).toBeDefined();
          expect(disposal!.costBasis).toBe(
            new Decimal(usdValue).abs().toString(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // ─── Property 6b: Disposal proceeds from counterpart leg ─────────────

  it('nft_disposal proceeds equals counterpart leg USD value', () => {
    fc.assert(
      fc.property(
        arbContractAddress,
        arbTokenId,
        arbFungibleAsset,
        arbFungibleAmount,
        arbUsdValue,
        (contractAddress, tokenId, fungibleAsset, fungibleAmount, usdValue) => {
          // First acquire the NFT (with a known cost basis)
          const acquisitionEntry = makePbtEntry({
            id: `acq-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-03-15T00:00:00Z'),
            type: 'nft_acquisition',
            legs: [
              {
                asset: contractAddress,
                amount: '1',
                contractAddress,
                tokenId,
              },
              {
                asset: 'ETH',
                amount: '-0.5',
                amountUsdAtTime: '1000',
              },
            ],
          });

          // Then dispose with the generated counterpart leg USD value
          const disposalEntry = makePbtEntry({
            id: `disp-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-09-15T00:00:00Z'),
            type: 'nft_disposal',
            legs: [
              {
                asset: contractAddress,
                amount: '-1',
                contractAddress,
                tokenId,
              },
              {
                asset: fungibleAsset,
                amount: fungibleAmount,
                amountUsdAtTime: usdValue,
              },
            ],
          });

          const result = computeTax([acquisitionEntry, disposalEntry], {
            method: FIFO,
            holdingPeriodDays: 365,
            year: 2024,
          });

          const disposal = result.disposals.find(
            (d) => d.sourceEntryId === `disp-${contractAddress}:${tokenId}`,
          );

          expect(disposal).toBeDefined();
          expect(disposal!.proceeds).toBe(
            new Decimal(usdValue).abs().toString(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 7: Unpriced NFT event tracking
 *
 * For any nft_acquisition or nft_disposal LedgerEntry that includes a
 * fungible counterpart leg with NO resolved USD value (no amountUsdAtTime),
 * the tax engine adds the entry's ID to the unpricedEvents array in the
 * TaxResult.
 *
 * **Validates: Requirements 4.4, 9.2**
 *
 * Feature: nft-cost-basis, Property 7: Unpriced NFT event tracking
 */
describe('Feature: nft-cost-basis, Property 7: Unpriced NFT event tracking', () => {
  // ─── Generators ──────────────────────────────────────────────────────

  /** Hex character set for building Ethereum addresses. */
  const HEX_CHARS = '0123456789abcdef'.split('');

  /** Arbitrary valid lowercased Ethereum address (0x + 40 hex chars). */
  const arbContractAddress: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
    .map((chars) => `0x${chars.join('')}`);

  /** Arbitrary NFT token ID string (numeric, 0–99999). */
  const arbTokenId: fc.Arbitrary<string> = fc
    .integer({ min: 0, max: 99999 })
    .map(String);

  /** Arbitrary fungible asset ticker for counterpart legs. */
  const arbFungibleAsset: fc.Arbitrary<string> = fc.constantFrom('ETH', 'WETH', 'MATIC', 'LINK');

  /** Arbitrary positive fungible amount as a decimal string. */
  const arbFungibleAmount: fc.Arbitrary<string> = fc
    .float({ min: Math.fround(0.001), max: Math.fround(100.0), noNaN: true })
    .map((n) => new Decimal(n.toFixed(6)).toString());

  /** Build a LedgerEntry with sensible defaults. */
  function makePbtEntry(overrides: {
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

  // ─── Property 7a: Unpriced nft_acquisition with counterpart leg ──────

  it('nft_acquisition with unpriced counterpart leg is added to unpricedEvents', () => {
    fc.assert(
      fc.property(
        arbContractAddress,
        arbTokenId,
        arbFungibleAsset,
        arbFungibleAmount,
        (contractAddress, tokenId, fungibleAsset, fungibleAmount) => {
          const entryId = `acq-unpriced-${contractAddress}:${tokenId}`;

          // NFT acquisition with a counterpart leg that has NO amountUsdAtTime
          const entry = makePbtEntry({
            id: entryId,
            timestamp: new Date('2024-06-15T00:00:00Z'),
            type: 'nft_acquisition',
            legs: [
              {
                asset: contractAddress,
                amount: '1',
                contractAddress,
                tokenId,
              },
              {
                asset: fungibleAsset,
                amount: `-${fungibleAmount}`,
                // No amountUsdAtTime — this leg is unpriced
              },
            ],
          });

          const result = computeTax([entry], {
            method: FIFO,
            holdingPeriodDays: 365,
            year: 2024,
          });

          // The entry ID should appear in unpricedEvents
          expect(result.unpricedEvents).toContain(entryId);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ─── Property 7b: Unpriced nft_disposal with counterpart leg ─────────

  it('nft_disposal with unpriced counterpart leg is added to unpricedEvents', () => {
    fc.assert(
      fc.property(
        arbContractAddress,
        arbTokenId,
        arbFungibleAsset,
        arbFungibleAmount,
        (contractAddress, tokenId, fungibleAsset, fungibleAmount) => {
          const acqId = `acq-for-disp-${contractAddress}:${tokenId}`;
          const dispId = `disp-unpriced-${contractAddress}:${tokenId}`;

          // First acquire the NFT with a known cost basis
          const acquisitionEntry = makePbtEntry({
            id: acqId,
            timestamp: new Date('2024-03-15T00:00:00Z'),
            type: 'nft_acquisition',
            legs: [
              {
                asset: contractAddress,
                amount: '1',
                contractAddress,
                tokenId,
              },
              {
                asset: 'ETH',
                amount: '-0.5',
                amountUsdAtTime: '1000',
              },
            ],
          });

          // Then dispose with a counterpart leg that has NO amountUsdAtTime
          const disposalEntry = makePbtEntry({
            id: dispId,
            timestamp: new Date('2024-09-15T00:00:00Z'),
            type: 'nft_disposal',
            legs: [
              {
                asset: contractAddress,
                amount: '-1',
                contractAddress,
                tokenId,
              },
              {
                asset: fungibleAsset,
                amount: fungibleAmount,
                // No amountUsdAtTime — this leg is unpriced
              },
            ],
          });

          const result = computeTax([acquisitionEntry, disposalEntry], {
            method: FIFO,
            holdingPeriodDays: 365,
            year: 2024,
          });

          // The disposal entry ID should appear in unpricedEvents
          expect(result.unpricedEvents).toContain(dispId);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 8: Airdrop zero cost basis
 *
 * For any nft_acquisition classified as an airdrop (no fungible counterpart
 * leg and no price override), the NftLot created has a costBasisUsd of '0'.
 * We verify this by disposing the NFT after acquisition and checking that
 * the disposal's costBasis is '0'.
 *
 * **Validates: Requirements 2.6**
 *
 * Feature: nft-cost-basis, Property 8: Airdrop zero cost basis
 */
describe('Feature: nft-cost-basis, Property 8: Airdrop zero cost basis', () => {
  // ─── Generators ──────────────────────────────────────────────────────

  /** Hex character set for building Ethereum addresses. */
  const HEX_CHARS = '0123456789abcdef'.split('');

  /** Arbitrary valid lowercased Ethereum address (0x + 40 hex chars). */
  const arbContractAddress: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
    .map((chars) => `0x${chars.join('')}`);

  /** Arbitrary NFT token ID string (numeric, 0–99999). */
  const arbTokenId: fc.Arbitrary<string> = fc
    .integer({ min: 0, max: 99999 })
    .map(String);

  /** Build a LedgerEntry with sensible defaults. */
  function makePbtEntry(overrides: {
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

  // ─── Property 8: Airdrop acquisition → zero cost basis on disposal ───

  it('airdrop nft_acquisition (no counterpart, no override) produces zero cost basis', () => {
    fc.assert(
      fc.property(
        arbContractAddress,
        arbTokenId,
        (contractAddress, tokenId) => {
          // Airdrop: nft_acquisition with only an NFT leg (no payment leg, no amountUsdAtTime)
          const airdropEntry = makePbtEntry({
            id: `airdrop-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-04-01T00:00:00Z'),
            type: 'nft_acquisition',
            legs: [
              {
                asset: contractAddress,
                amount: '1',
                contractAddress,
                tokenId,
                // No amountUsdAtTime — no price override
              },
            ],
          });

          // Dispose the NFT so we can observe the cost basis from the lot
          const disposalEntry = makePbtEntry({
            id: `disp-${contractAddress}:${tokenId}`,
            timestamp: new Date('2024-08-01T00:00:00Z'),
            type: 'nft_disposal',
            legs: [
              {
                asset: contractAddress,
                amount: '-1',
                contractAddress,
                tokenId,
              },
              {
                asset: 'ETH',
                amount: '2',
                amountUsdAtTime: '6000',
              },
            ],
          });

          const result = computeTax([airdropEntry, disposalEntry], {
            method: FIFO,
            holdingPeriodDays: 365,
            year: 2024,
          });

          const disposal = result.disposals.find(
            (d) => d.sourceEntryId === `disp-${contractAddress}:${tokenId}`,
          );

          expect(disposal).toBeDefined();
          // Airdrop cost basis must be zero
          expect(disposal!.costBasis).toBe('0');
        },
      ),
      { numRuns: 100 },
    );
  });
});
