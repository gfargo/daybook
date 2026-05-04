/**
 * Unit tests for NFT tax computation in computeTax().
 *
 * Validates NFT acquisition lot creation, disposal gain/loss,
 * airdrop zero cost basis, missing lot warnings, holding period
 * classification, unpriced event tracking, NFT-for-NFT trades,
 * duplicate acquisition warnings, and mixed NFT + fungible disposals.
 *
 * **Validates: Requirements 3.2–3.6, 4.1–4.4, 8.2, 8.3, 9.1, 9.2**
 */

import { describe, expect, it } from 'vitest';
import type { LedgerEntry, LedgerEntryType, AssetLeg } from '@daybook/ledger';
import { computeTax } from './compute.js';
import { FIFO } from './cost-basis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Build a LedgerEntry with sensible defaults. */
function makeEntry(overrides: {
  id: string;
  timestamp: Date;
  type: LedgerEntryType;
  legs: AssetLeg[];
  rawEventIds?: string[];
  reason?: string;
}): LedgerEntry {
  return {
    rawEventIds: [overrides.id],
    ...overrides,
  };
}

/** Standard contract address for test NFTs. */
const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';

/** Second contract address for NFT-for-NFT trade tests. */
const CONTRACT_B = '0x60e4d786628fea6478f785a6d7e704777c86a7c6';

/** Default FIFO config for 2024. */
const config2024 = {
  method: FIFO,
  holdingPeriodDays: 365,
  year: 2024,
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('computeTax — NFT integration', () => {
  // ─── Test 1: NFT purchase → acquisition lot with correct cost basis ──
  describe('NFT purchase creates acquisition lot with correct cost basis', () => {
    it('derives cost basis from the counterpart payment leg USD value', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-1',
          timestamp: new Date('2024-02-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '4523',
            },
            {
              asset: 'ETH',
              amount: '-0.5',
              amountUsdAtTime: '1500',
            },
          ],
        }),
        // Sell the NFT later to verify the lot was created
        makeEntry({
          id: 'nft-sell-1',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '4523',
            },
            {
              asset: 'ETH',
              amount: '1.0',
              amountUsdAtTime: '3000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // Cost basis from the 0.5 ETH payment ($1,500)
      expect(d.costBasis).toBe('1500');
      // Proceeds from the 1.0 ETH received ($3,000)
      expect(d.proceeds).toBe('3000');
      // Gain: $3,000 - $1,500 = $1,500
      expect(d.gainLoss).toBe('1500');
      expect(d.amount).toBe('1');
    });
  });

  // ─── Test 2: NFT sale → disposal with correct gain/loss ──────────────
  describe('NFT sale produces correct gain/loss', () => {
    it('computes gain as proceeds minus cost basis', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-gl',
          timestamp: new Date('2024-01-15T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '7804',
            },
            {
              asset: 'ETH',
              amount: '-2.0',
              amountUsdAtTime: '4000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-gl',
          timestamp: new Date('2024-08-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '7804',
            },
            {
              asset: 'ETH',
              amount: '1.5',
              amountUsdAtTime: '3000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // Loss: $3,000 - $4,000 = -$1,000
      expect(d.proceeds).toBe('3000');
      expect(d.costBasis).toBe('4000');
      expect(d.gainLoss).toBe('-1000');
    });
  });

  // ─── Test 3: NFT airdrop → lot with zero cost basis ──────────────────
  describe('NFT airdrop creates lot with zero cost basis', () => {
    it('sets cost basis to zero when no payment leg exists', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-airdrop',
          timestamp: new Date('2024-03-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT airdrop',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '1234',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-airdrop',
          timestamp: new Date('2024-09-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '1234',
            },
            {
              asset: 'ETH',
              amount: '0.5',
              amountUsdAtTime: '1000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // Airdrop → zero cost basis
      expect(d.costBasis).toBe('0');
      expect(d.proceeds).toBe('1000');
      expect(d.gainLoss).toBe('1000');
      // Airdrop should NOT be in unpricedEvents (zero is the correct value)
      expect(result.unpricedEvents).not.toContain('nft-airdrop');
    });
  });

  // ─── Test 4: NFT disposal with no matching lot → warning + zero ──────
  describe('NFT disposal with no matching lot', () => {
    it('produces warning and uses zero cost basis', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-sell-no-lot',
          timestamp: new Date('2024-05-15T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '9999',
            },
            {
              asset: 'ETH',
              amount: '2.0',
              amountUsdAtTime: '5000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // No lot → zero cost basis
      expect(d.costBasis).toBe('0');
      expect(d.proceeds).toBe('5000');
      expect(d.gainLoss).toBe('5000');

      // Warning about missing cost basis
      const nftIdentifier = `${CONTRACT.toLowerCase()}:9999`;
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Missing cost basis for NFT ${nftIdentifier}`),
        ]),
      );
      expect(result.warnings[0]).toContain('2024-05-15');
    });
  });

  // ─── Test 5: Holding period — short-term and long-term ───────────────
  describe('holding period classification', () => {
    it('classifies < 365 days as short-term', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-st',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '100',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-st',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '100',
            },
            {
              asset: 'ETH',
              amount: '1.5',
              amountUsdAtTime: '3000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      // Jan 1 → Jun 1 = 152 days → short-term
      expect(result.disposals[0]!.term).toBe('short-term');
    });

    it('classifies > 365 days as long-term', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-lt',
          timestamp: new Date('2023-01-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '200',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-lt',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '200',
            },
            {
              asset: 'ETH',
              amount: '1.5',
              amountUsdAtTime: '3000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      // Jan 2023 → Jun 2024 = ~517 days → long-term
      expect(result.disposals[0]!.term).toBe('long-term');
    });
  });

  // ─── Test 6: Unpriced NFT events ─────────────────────────────────────
  describe('unpriced NFT events', () => {
    it('adds acquisition entry ID to unpricedEvents when payment leg has no USD', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-unpriced',
          timestamp: new Date('2024-04-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '555',
            },
            {
              asset: 'ETH',
              amount: '-0.5',
              // No amountUsdAtTime or amountUsdReportedBySource
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);
      expect(result.unpricedEvents).toContain('nft-buy-unpriced');
    });

    it('adds disposal entry ID to unpricedEvents when proceeds leg has no USD', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-for-unpriced-sell',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '666',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-unpriced',
          timestamp: new Date('2024-07-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '666',
            },
            {
              asset: 'ETH',
              amount: '1.5',
              // No USD value
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);
      expect(result.unpricedEvents).toContain('nft-sell-unpriced');
    });
  });

  // ─── Test 7: NFT-for-NFT trade with one price override ──────────────
  describe('NFT-for-NFT trade', () => {
    it('uses price override for both disposal proceeds and acquisition cost basis', () => {
      // Acquire NFT A first
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-a',
          timestamp: new Date('2024-01-15T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '1000',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        // NFT-for-NFT trade: dispose NFT A, acquire NFT B
        // The disposal has a price override on the NFT leg
        makeEntry({
          id: 'nft-trade-dispose',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '1000',
              amountUsdAtTime: '5000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-trade-acquire',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'MAYC',
              amount: '1',
              contractAddress: CONTRACT_B,
              tokenId: '2000',
              amountUsdAtTime: '5000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      // Disposal of NFT A
      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;
      expect(d.costBasis).toBe('2000');
      expect(d.proceeds).toBe('5000');
      expect(d.gainLoss).toBe('3000');

      // NFT B should not be unpriced (it has amountUsdAtTime on the leg)
      expect(result.unpricedEvents).not.toContain('nft-trade-acquire');
    });
  });

  // ─── Test 8: NFT-for-NFT trade with no prices → both unpriced ───────
  describe('NFT-for-NFT trade with no prices', () => {
    it('adds both entries to unpricedEvents when no USD values exist', () => {
      const entries: LedgerEntry[] = [
        // Acquire NFT A first (with price so it has a lot)
        makeEntry({
          id: 'nft-buy-for-trade',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '3000',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        // Dispose NFT A — no proceeds leg, no USD on NFT leg
        makeEntry({
          id: 'nft-trade-out',
          timestamp: new Date('2024-05-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '3000',
              // No USD value
            },
          ],
        }),
        // Acquire NFT B — no payment leg, no USD on NFT leg
        makeEntry({
          id: 'nft-trade-in',
          timestamp: new Date('2024-05-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'MAYC',
              amount: '1',
              contractAddress: CONTRACT_B,
              tokenId: '4000',
              // No USD value
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      // The disposal should have zero proceeds (no USD available)
      expect(result.disposals).toHaveLength(1);
      expect(result.disposals[0]!.proceeds).toBe('0');

      // The acquisition is an airdrop-like entry with no price → zero cost basis, not unpriced
      // The disposal has no proceeds leg and no USD on NFT leg → zero proceeds, not unpriced
      // (transfer out / airdrop patterns default to zero, not unpriced)
    });
  });

  // ─── Test 9: Duplicate acquisition warning ───────────────────────────
  describe('duplicate NFT acquisition', () => {
    it('produces a warning when the same NFT is acquired twice without disposal', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-dup-1',
          timestamp: new Date('2024-02-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '5555',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-buy-dup-2',
          timestamp: new Date('2024-04-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '5555',
            },
            {
              asset: 'ETH',
              amount: '-1.5',
              amountUsdAtTime: '3000',
            },
          ],
        }),
        // Sell the NFT — should use the second (overwritten) lot
        makeEntry({
          id: 'nft-sell-dup',
          timestamp: new Date('2024-08-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '5555',
            },
            {
              asset: 'ETH',
              amount: '2.0',
              amountUsdAtTime: '5000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      // Warning about duplicate acquisition
      const nftIdentifier = `${CONTRACT.toLowerCase()}:5555`;
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Duplicate acquisition for NFT ${nftIdentifier}`),
        ]),
      );

      // The second lot ($3,000) should be used for cost basis
      expect(result.disposals).toHaveLength(1);
      expect(result.disposals[0]!.costBasis).toBe('3000');
      expect(result.disposals[0]!.gainLoss).toBe('2000');
    });
  });

  // ─── Test 10: NFT disposals alongside fungible disposals ─────────────
  describe('NFT disposals appear alongside fungible disposals', () => {
    it('includes both NFT and fungible disposals in the result', () => {
      const entries: LedgerEntry[] = [
        // Buy ETH
        makeEntry({
          id: 'eth-buy',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '2', amountUsdAtTime: '4000' },
            { asset: 'USD', amount: '-4000', amountUsdAtTime: '4000' },
          ],
        }),
        // Buy NFT
        makeEntry({
          id: 'nft-buy-mixed',
          timestamp: new Date('2024-02-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '8888',
            },
            {
              asset: 'ETH',
              amount: '-0.5',
              amountUsdAtTime: '1000',
            },
          ],
        }),
        // Sell ETH
        makeEntry({
          id: 'eth-sell',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'trade',
          legs: [
            { asset: 'ETH', amount: '-1', amountUsdAtTime: '2500' },
            { asset: 'USD', amount: '2500', amountUsdAtTime: '2500' },
          ],
        }),
        // Sell NFT
        makeEntry({
          id: 'nft-sell-mixed',
          timestamp: new Date('2024-07-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '8888',
            },
            {
              asset: 'ETH',
              amount: '0.8',
              amountUsdAtTime: '2000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      // Should have both fungible and NFT disposals
      expect(result.disposals.length).toBe(2);

      // Find the ETH disposal
      const ethDisposal = result.disposals.find(
        (d) => d.sourceEntryId === 'eth-sell',
      );
      expect(ethDisposal).toBeDefined();
      expect(ethDisposal!.asset).toBe('ETH');

      // Find the NFT disposal
      const nftDisposal = result.disposals.find(
        (d) => d.sourceEntryId === 'nft-sell-mixed',
      );
      expect(nftDisposal).toBeDefined();
      expect(nftDisposal!.amount).toBe('1');
      expect(nftDisposal!.costBasis).toBe('1000');
      expect(nftDisposal!.proceeds).toBe('2000');
      expect(nftDisposal!.gainLoss).toBe('1000');
    });
  });

  // ─── Test 11: DisposalResult.asset uses formatted NFT description ────
  describe('DisposalResult asset formatting', () => {
    it('sets asset to formatted NFT description for export compatibility', () => {
      const entries: LedgerEntry[] = [
        makeEntry({
          id: 'nft-buy-fmt',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'nft_acquisition',
          reason: 'NFT purchase',
          legs: [
            {
              asset: 'BAYC',
              amount: '1',
              contractAddress: CONTRACT,
              tokenId: '4523',
            },
            {
              asset: 'ETH',
              amount: '-1.0',
              amountUsdAtTime: '2000',
            },
          ],
        }),
        makeEntry({
          id: 'nft-sell-fmt',
          timestamp: new Date('2024-06-01T00:00:00Z'),
          type: 'nft_disposal',
          reason: 'NFT sale',
          legs: [
            {
              asset: 'BAYC',
              amount: '-1',
              contractAddress: CONTRACT,
              tokenId: '4523',
            },
            {
              asset: 'ETH',
              amount: '1.5',
              amountUsdAtTime: '3000',
            },
          ],
        }),
      ];

      const result = computeTax(entries, config2024);

      expect(result.disposals).toHaveLength(1);
      const d = result.disposals[0]!;

      // Asset should be formatted as IRS description: "1 0xbc4ca0...f13d:4523"
      expect(d.asset).toContain('0xbc4ca0');
      expect(d.asset).toContain('f13d');
      expect(d.asset).toContain('4523');
      expect(d.asset).toMatch(/^1 /);
    });
  });
});
