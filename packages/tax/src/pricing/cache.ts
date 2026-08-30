/**
 * Price cache backed by the existing `prices` SQLite table.
 *
 * Keyed by `(asset, day, source)` where `day` is unix seconds at 00:00 UTC.
 * Daily granularity is sufficient for tax purposes — we don't need intraday
 * prices, and caching aggressively avoids hammering external APIs.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3';
import type { PriceResult } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Truncate a Date to 00:00 UTC and return unix seconds.
 *
 * All price cache keys use this day-level granularity so that lookups
 * for the same calendar day always hit the same cache entry regardless
 * of the exact time of the original event.
 *
 * @param timestamp - Any Date object.
 * @returns Unix seconds at midnight UTC of that date.
 */
export function dayUtc(timestamp: Date): number {
  const d = new Date(timestamp);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ─────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read/write cache for USD prices, backed by the `prices` SQLite table.
 *
 * The table schema (from 001_initial.sql):
 * ```sql
 * CREATE TABLE prices (
 *   asset TEXT NOT NULL,
 *   day INTEGER NOT NULL,
 *   source TEXT NOT NULL,
 *   price_usd TEXT NOT NULL,
 *   fetched_at INTEGER NOT NULL,
 *   PRIMARY KEY (asset, day, source)
 * );
 * ```
 */
export class PriceCache {
  private readonly getAllForDayStmt;
  private readonly setStmt;

  constructor(private readonly db: DatabaseInstance) {
    // Fetch all cached rows for (asset, day) so the caller can apply its
    // own provider-preference ordering deterministically.
    this.getAllForDayStmt = db.prepare(`
      SELECT price_usd, source, fetched_at
      FROM prices
      WHERE asset = ? AND day = ?
      ORDER BY source ASC, fetched_at DESC
    `);

    this.setStmt = db.prepare(`
      INSERT OR REPLACE INTO prices (asset, day, source, price_usd, fetched_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  /**
   * Look up a cached price for an asset on a given day.
   *
   * When `preferredSources` is provided the row whose source has the
   * lowest index in that list wins. If multiple rows share the same
   * source, the most recently fetched one is used (fetched_at DESC).
   * Rows whose source does not appear in `preferredSources` are kept as
   * a last-resort fallback, ordered by source ASC for stability.
   *
   * When `preferredSources` is omitted, the best-ranked row in the
   * preference list is still used (empty preference = pure fallback
   * order: source ASC, fetched_at DESC).
   *
   * @param asset - Canonical ticker (e.g. 'ETH').
   * @param day - Unix seconds at 00:00 UTC (use `dayUtc()` to compute).
   * @param preferredSources - Optional provider preference order, highest
   *   priority first (e.g. `['coingecko', 'manual-override']`).
   * @returns The cached price result, or `null` if not cached.
   */
  get(
    asset: string,
    day: number,
    preferredSources?: string[],
  ): PriceResult | null {
    type Row = { price_usd: string; source: string; fetched_at: number };
    const rows = this.getAllForDayStmt.all(asset, day) as Row[];
    if (rows.length === 0) return null;

    if (!preferredSources || preferredSources.length === 0) {
      // No preference list: deterministic fallback — source ASC, fetched_at DESC.
      // getAllForDayStmt already orders by source ASC; within the same source
      // the most recent row appears first due to fetched_at DESC ordering.
      const row = rows[0]!;
      return { priceUsd: row.price_usd, source: row.source };
    }

    // Build an index of source → preference rank (lower = better).
    const rankOf = new Map<string, number>(
      preferredSources.map((s, i) => [s, i]),
    );

    // Sort by: (rank in preferredSources ASC, fallback position for unknowns,
    // fetched_at DESC for same-source tie-break).
    const UNKNOWN_RANK = preferredSources.length; // push unlisted sources to end
    const sorted = [...rows].sort((a, b) => {
      const ra = rankOf.get(a.source) ?? UNKNOWN_RANK;
      const rb = rankOf.get(b.source) ?? UNKNOWN_RANK;
      if (ra !== rb) return ra - rb;
      // Same rank — pick the most recently fetched row.
      return b.fetched_at - a.fetched_at;
    });

    const winner = sorted[0]!;
    return { priceUsd: winner.price_usd, source: winner.source };
  }

  /**
   * Write a price to the cache.
   *
   * Uses INSERT OR REPLACE so re-caching the same (asset, day, source)
   * updates the price and fetched_at timestamp.
   *
   * @param asset - Canonical ticker (e.g. 'ETH').
   * @param day - Unix seconds at 00:00 UTC.
   * @param source - Provider name (e.g. 'coingecko').
   * @param priceUsd - USD price as a decimal string.
   */
  set(asset: string, day: number, source: string, priceUsd: string): void {
    this.setStmt.run(asset, day, source, priceUsd, Math.floor(Date.now() / 1000));
  }
}
