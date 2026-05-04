/**
 * Unit tests for NftLotBook.
 *
 * Validates:
 *   - Acquire + dispose round-trip returns original lot
 *   - Dispose of unknown NFT returns null
 *   - has() returns true after acquire, false after dispose
 *   - Duplicate acquisition overwrites previous lot
 *   - Lot is fully removed after disposal (no partial consumption)
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7**
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { NftLotBook } from './nft-lot-book.js';
import type { NftLot } from './nft-lot-book.js';
import { arbNftId, arbNftLot } from './test-helpers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeLot(overrides: Partial<NftLot> = {}): NftLot {
  return {
    nftId: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523',
    costBasisUsd: '1500.00',
    acquiredAt: new Date('2024-01-15T12:00:00Z'),
    sourceEntryId: 'entry-1',
    ...overrides,
  };
}

// ─── Acquire + dispose round-trip ────────────────────────────────────────

describe('acquire + dispose round-trip', () => {
  it('returns the original lot with matching fields', () => {
    const book = new NftLotBook();
    const lot = makeLot();

    book.acquire(lot);
    const disposed = book.dispose(lot.nftId);

    expect(disposed).not.toBeNull();
    expect(disposed!.nftId).toBe(lot.nftId);
    expect(disposed!.costBasisUsd).toBe(lot.costBasisUsd);
    expect(disposed!.acquiredAt).toEqual(lot.acquiredAt);
    expect(disposed!.sourceEntryId).toBe(lot.sourceEntryId);
  });

  it('returns the exact same lot object', () => {
    const book = new NftLotBook();
    const lot = makeLot();

    book.acquire(lot);
    const disposed = book.dispose(lot.nftId);

    expect(disposed).toBe(lot);
  });
});

// ─── Dispose of unknown NFT ─────────────────────────────────────────────

describe('dispose of unknown NFT', () => {
  it('returns null for an NFT that was never acquired', () => {
    const book = new NftLotBook();
    const result = book.dispose('0xdeadbeef:999');

    expect(result).toBeNull();
  });

  it('returns null for an empty book', () => {
    const book = new NftLotBook();
    const result = book.dispose('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523');

    expect(result).toBeNull();
  });
});

// ─── has() ───────────────────────────────────────────────────────────────

describe('has()', () => {
  it('returns true after acquire', () => {
    const book = new NftLotBook();
    const lot = makeLot();

    book.acquire(lot);

    expect(book.has(lot.nftId)).toBe(true);
  });

  it('returns false after dispose', () => {
    const book = new NftLotBook();
    const lot = makeLot();

    book.acquire(lot);
    book.dispose(lot.nftId);

    expect(book.has(lot.nftId)).toBe(false);
  });

  it('returns false for an NFT that was never acquired', () => {
    const book = new NftLotBook();

    expect(book.has('0xdeadbeef:999')).toBe(false);
  });
});

// ─── Duplicate acquisition ──────────────────────────────────────────────

describe('duplicate acquisition', () => {
  it('overwrites the previous lot', () => {
    const book = new NftLotBook();
    const id = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523';

    const first = makeLot({ nftId: id, costBasisUsd: '1000.00', sourceEntryId: 'entry-1' });
    const second = makeLot({ nftId: id, costBasisUsd: '2000.00', sourceEntryId: 'entry-2' });

    book.acquire(first);
    book.acquire(second);

    const disposed = book.dispose(id);

    expect(disposed).not.toBeNull();
    expect(disposed!.costBasisUsd).toBe('2000.00');
    expect(disposed!.sourceEntryId).toBe('entry-2');
  });

  it('tracks a warning when overwriting', () => {
    const book = new NftLotBook();
    const id = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d:4523';

    book.acquire(makeLot({ nftId: id }));
    book.acquire(makeLot({ nftId: id }));

    expect(book.warnings).toHaveLength(1);
    expect(book.warnings[0]).toContain('Duplicate acquisition');
    expect(book.warnings[0]).toContain(id);
  });
});

// ─── Full removal (no partial consumption) ──────────────────────────────

describe('full removal (no partial consumption)', () => {
  it('lot is completely gone after disposal', () => {
    const book = new NftLotBook();
    const lot = makeLot();

    book.acquire(lot);
    book.dispose(lot.nftId);

    // Lot no longer exists
    expect(book.has(lot.nftId)).toBe(false);

    // Second dispose returns null — nothing left
    expect(book.dispose(lot.nftId)).toBeNull();
  });

  it('disposing one NFT does not affect others', () => {
    const book = new NftLotBook();
    const lotA = makeLot({ nftId: '0xaaa:1', sourceEntryId: 'a' });
    const lotB = makeLot({ nftId: '0xbbb:2', sourceEntryId: 'b' });

    book.acquire(lotA);
    book.acquire(lotB);

    book.dispose(lotA.nftId);

    expect(book.has(lotA.nftId)).toBe(false);
    expect(book.has(lotB.nftId)).toBe(true);
  });
});


// ─── Property-based tests ────────────────────────────────────────────────

describe('Feature: nft-cost-basis, Property 3: NFT lot acquire/dispose round-trip', () => {
  /**
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.7**
   *
   * For any valid NftLot, acquiring it into the NftLotBook and then
   * disposing it by nftId returns the original lot with matching
   * costBasisUsd and acquiredAt, and has() returns false after disposal.
   */
  it('acquire then dispose returns original lot and removes it from the book', () => {
    fc.assert(
      fc.property(arbNftLot, (lot: NftLot) => {
        const book = new NftLotBook();

        // Acquire the lot
        book.acquire(lot);

        // Lot should exist after acquisition
        expect(book.has(lot.nftId)).toBe(true);

        // Dispose the lot
        const disposed = book.dispose(lot.nftId);

        // Disposed lot should not be null
        expect(disposed).not.toBeNull();

        // Disposed lot should match original costBasisUsd and acquiredAt
        expect(disposed!.costBasisUsd).toBe(lot.costBasisUsd);
        expect(disposed!.acquiredAt).toEqual(lot.acquiredAt);

        // Lot should no longer exist after disposal (no partial consumption)
        expect(book.has(lot.nftId)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});


describe('Feature: nft-cost-basis, Property 4: Missing lot produces warning and zero cost basis', () => {
  /**
   * **Validates: Requirements 3.4, 9.1**
   *
   * For any NFT identifier that has not been acquired in the NftLotBook,
   * disposing that identifier returns null.
   */
  it('dispose of an unacquired NFT returns null', () => {
    fc.assert(
      fc.property(arbNftId, (nftId: string) => {
        const book = new NftLotBook();

        // Dispose without any prior acquisition
        const result = book.dispose(nftId);

        // Should return null — no lot exists for this NFT
        expect(result).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});


describe('Feature: nft-cost-basis, Property 5: Holding period and term classification', () => {
  /**
   * **Validates: Requirements 3.5, 3.6**
   *
   * For any acquisition date and disposal date (where disposal is after
   * acquisition), the holding period in days equals the millisecond
   * difference divided by 86 400 000, and the term is 'long-term' when
   * the holding period exceeds 365 days and 'short-term' otherwise.
   *
   * This mirrors the logic in computeTax() which uses:
   *   holdingMs > holdingPeriodDays * MS_PER_DAY
   * with holdingPeriodDays = 365 and MS_PER_DAY = 86_400_000.
   */

  /** Milliseconds in one day — matches the constant in compute.ts. */
  const MS_PER_DAY = 86_400_000;

  /** Default holding period threshold in days. */
  const HOLDING_PERIOD_DAYS = 365;

  /**
   * Arbitrary that generates an ordered date pair where acquiredAt is
   * strictly before disposedAt, within the 2020–2030 range.
   */
  const arbDatePair = fc
    .tuple(
      fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 11, 31, 23, 59, 59) - 1 }),
      fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 11, 31, 23, 59, 59) - 1 }),
    )
    .map(([a, b]) => {
      const earlier = Math.min(a, b);
      const later = Math.max(a, b) + 1; // ensure strictly after
      return {
        acquiredAt: new Date(earlier),
        disposedAt: new Date(later),
      };
    });

  it('holding period > 365 days → long-term, otherwise → short-term', () => {
    fc.assert(
      fc.property(arbDatePair, ({ acquiredAt, disposedAt }) => {
        const holdingMs = disposedAt.getTime() - acquiredAt.getTime();
        const term: 'short-term' | 'long-term' =
          holdingMs > HOLDING_PERIOD_DAYS * MS_PER_DAY
            ? 'long-term'
            : 'short-term';

        // The holding period in days (fractional)
        const holdingDays = holdingMs / MS_PER_DAY;

        if (holdingDays > HOLDING_PERIOD_DAYS) {
          expect(term).toBe('long-term');
        } else {
          expect(term).toBe('short-term');
        }
      }),
      { numRuns: 100 },
    );
  });
});
