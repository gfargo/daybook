/**
 * Manual override pricing provider.
 *
 * Reads user-entered price overrides from the `price_overrides` table.
 * This is the last-resort provider in the priority chain — used for
 * long-tail tokens that no API covers (scam airdrops, obscure DeFi tokens).
 *
 * Overrides are set via `daybook overrides set <asset> <date> <price>`.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { PriceResult, PricingProvider } from '../provider.js';
import { dayUtc } from '../cache.js';

// ─────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reads manual price overrides from the `price_overrides` table.
 *
 * Matches by asset (case-insensitive) and day (00:00 UTC).
 */
export class ManualOverrideProvider implements PricingProvider {
  readonly name = 'manual-override';
  readonly cacheMode = 'bypass';

  private readonly stmt;

  constructor(private readonly db: DatabaseInstance) {
    this.stmt = db.prepare(`
      SELECT price_usd
      FROM price_overrides
      WHERE UPPER(asset) = UPPER(?)
        AND day = ?
      LIMIT 1
    `);
  }

  /**
   * Look up a manual price override for the given asset and date.
   *
   * @param asset - Ticker symbol (e.g. 'KITTYINU').
   * @param timestamp - Date of the event.
   * @returns The override price, or `null` if none exists.
   */
  async getPrice(
    asset: string,
    timestamp: Date,
  ): Promise<PriceResult | null> {
    const day = dayUtc(timestamp);

    const row = this.stmt.get(asset, day) as
      | { price_usd: string }
      | undefined;

    if (!row) return null;

    return {
      priceUsd: row.price_usd,
      source: this.name,
    };
  }
}
