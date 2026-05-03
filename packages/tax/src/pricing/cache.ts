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
  private readonly getStmt;
  private readonly setStmt;

  constructor(private readonly db: DatabaseInstance) {
    this.getStmt = db.prepare(`
      SELECT price_usd, source
      FROM prices
      WHERE asset = ? AND day = ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `);

    this.setStmt = db.prepare(`
      INSERT OR REPLACE INTO prices (asset, day, source, price_usd, fetched_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  /**
   * Look up a cached price for an asset on a given day.
   *
   * @param asset - Canonical ticker (e.g. 'ETH').
   * @param day - Unix seconds at 00:00 UTC (use `dayUtc()` to compute).
   * @returns The cached price result, or `null` if not cached.
   */
  get(asset: string, day: number): PriceResult | null {
    const row = this.getStmt.get(asset, day) as
      | { price_usd: string; source: string }
      | undefined;
    if (!row) return null;
    return { priceUsd: row.price_usd, source: row.source };
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
