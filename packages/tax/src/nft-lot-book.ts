/**
 * NftLotBook — per-NFT lot tracking with acquire/dispose operations.
 *
 * Unlike the fungible {@link LotBook} which maintains arrays of lots per
 * asset (supporting partial consumption), the NftLotBook tracks each NFT
 * as a unique, indivisible lot keyed by `<contractAddress>:<tokenId>`.
 *
 * Each NFT has exactly one lot at a time. Lots are consumed entirely on
 * disposal — no partial consumption is possible.
 *
 * All monetary values are stored as decimal strings and converted to
 * `Decimal` at math boundaries — never JavaScript floating-point.
 */


// ─────────────────────────────────────────────────────────────────────────
// NftLot interface
// ─────────────────────────────────────────────────────────────────────────

/**
 * A record of an NFT acquisition.
 *
 * Created when the tax engine processes an `nft_acquisition` entry.
 * Consumed entirely when the engine processes an `nft_disposal` for
 * the same NFT identifier.
 */
export interface NftLot {
  /** NFT identifier: `<contractAddress>:<tokenId>` (lowercased). */
  nftId: string;
  /** Cost basis in USD. Decimal string. */
  costBasisUsd: string;
  /** When the NFT was acquired. */
  acquiredAt: Date;
  /** The LedgerEntry.id that created this lot. */
  sourceEntryId: string;
}

// ─────────────────────────────────────────────────────────────────────────
// NftLotBook
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tracks NFT lots — one lot per unique NFT identifier.
 *
 * Usage:
 * ```ts
 * const book = new NftLotBook();
 * book.acquire({ nftId: '0xbc4c...f13d:4523', costBasisUsd: '1500', acquiredAt: new Date(), sourceEntryId: 'entry-1' });
 * const lot = book.dispose('0xbc4c...f13d:4523');
 * ```
 */
export class NftLotBook {
  /** NFT identifier → lot. One lot per NFT — no pooling. */
  private lots: Map<string, NftLot> = new Map();

  /** Warnings accumulated during acquire/dispose operations. */
  private _warnings: string[] = [];

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Record an NFT acquisition.
   *
   * If the same NFT identifier already exists in the book (acquired
   * again without a prior disposal), the previous lot is overwritten
   * and a warning is tracked.
   *
   * @param lot - The NFT lot to record. Must have a valid `nftId`.
   */
  acquire(lot: NftLot): void {
    if (this.lots.has(lot.nftId)) {
      this._warnings.push(
        `Duplicate acquisition for NFT ${lot.nftId} — previous lot overwritten`,
      );
    }
    this.lots.set(lot.nftId, lot);
  }

  /**
   * Dispose of an NFT by its identifier.
   *
   * Removes and returns the lot if found. The lot is consumed entirely
   * — no partial consumption is possible for NFTs.
   *
   * @param nftId - The canonical NFT identifier (`<contractAddress>:<tokenId>`).
   * @returns The lot if found, or `null` if no matching lot exists.
   */
  dispose(nftId: string): NftLot | null {
    const lot = this.lots.get(nftId);
    if (!lot) {
      return null;
    }
    this.lots.delete(nftId);
    return lot;
  }

  /**
   * Check if a lot exists for the given NFT identifier.
   *
   * @param nftId - The canonical NFT identifier.
   * @returns `true` if a lot exists, `false` otherwise.
   */
  has(nftId: string): boolean {
    return this.lots.has(nftId);
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────

  /**
   * Get all warnings accumulated during acquire/dispose operations.
   *
   * Includes duplicate acquisition warnings.
   *
   * @returns Array of warning strings.
   */
  get warnings(): ReadonlyArray<string> {
    return this._warnings;
  }
}
