/**
 * Source-reported pricing provider.
 *
 * Extracts USD prices that the original data source reported alongside
 * the transaction — e.g. Coinbase's `Subtotal` column or Kraken's
 * `amountusd` field. These are stored in `raw_event_legs.amount_usd_reported_by_source`.
 *
 * This is the highest-priority provider because source-reported prices
 * are the most tax-defensible: they reflect what the exchange actually
 * used at the moment of the transaction.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { PriceResult, PricingProvider } from '../provider.js';
import { dayUtc } from '../cache.js';

// ─────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────

/**
 * Looks up source-reported USD prices from the `raw_event_legs` table.
 *
 * Matches by asset ticker (case-insensitive) and calendar day (UTC).
 * Returns the first non-null `amount_usd_reported_by_source` found.
 */
export class SourceReportedProvider implements PricingProvider {
  readonly name = 'source-reported';

  private readonly stmt;

  constructor(private readonly db: DatabaseInstance) {
    // Join raw_event_legs with raw_events to filter by day.
    // The timestamp in raw_events is unix seconds; we compare the day
    // boundaries to match any event on the same calendar day.
    this.stmt = db.prepare(`
      SELECT rel.amount_usd_reported_by_source
      FROM raw_event_legs rel
      JOIN raw_events re ON re.id = rel.event_id
      WHERE UPPER(rel.asset) = UPPER(?)
        AND re.timestamp >= ?
        AND re.timestamp < ?
        AND rel.amount_usd_reported_by_source IS NOT NULL
      LIMIT 1
    `);
  }

  /**
   * Look up a source-reported price for the given asset and date.
   *
   * @param asset - Ticker symbol (e.g. 'ETH').
   * @param timestamp - Date of the event.
   * @returns The source-reported price, or `null` if none exists.
   */
  async getPrice(
    asset: string,
    timestamp: Date,
  ): Promise<PriceResult | null> {
    const day = dayUtc(timestamp);
    const nextDay = day + 86400; // +24h in seconds

    const row = this.stmt.get(asset, day, nextDay) as
      | { amount_usd_reported_by_source: string }
      | undefined;

    if (!row) return null;

    return {
      priceUsd: row.amount_usd_reported_by_source,
      source: this.name,
    };
  }
}
