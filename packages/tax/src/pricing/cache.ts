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
// Constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * How long (in seconds) a negative-cache miss entry is considered fresh.
 *
 * During this window, priceAt() returns null immediately without hitting
 * any provider. After expiry the entry stays in the DB but is ignored,
 * so the provider is re-queried on the next run.
 *
 * 7 days: generous enough that CoinGecko won't suddenly have data for a
 * long-tail token overnight, but short enough that any new listing picks
 * up within a week.
 */
export const NEGATIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

// ─────────────────────────────────────────────────────────────────────────
// Negative-miss cache
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cache for genuine "no data" misses, backed by the `price_lookup_misses`
 * SQLite table (migration 005).
 *
 * A miss is recorded only when ALL cacheable providers return null cleanly
 * (i.e. the asset is genuinely unpriced, not a network failure). Transient
 * errors (429-after-retries, network down) must NOT produce a miss entry —
 * the provider must throw for those cases so PricingChain can distinguish them.
 *
 * Miss entries are respected for `NEGATIVE_CACHE_TTL_SECONDS` after being
 * recorded. Expired entries remain in the table but are ignored; a re-query
 * is attempted on the next run, and if still null the entry is refreshed.
 *
 * ```sql
 * CREATE TABLE price_lookup_misses (
 *   asset      TEXT    NOT NULL,
 *   day        INTEGER NOT NULL,
 *   source     TEXT    NOT NULL,
 *   checked_at INTEGER NOT NULL,
 *   PRIMARY KEY (asset, day, source)
 * );
 * ```
 */
export class PriceMissCache {
  private readonly checkStmt;
  private readonly recordStmt;

  constructor(private readonly db: DatabaseInstance) {
    this.checkStmt = db.prepare(`
      SELECT checked_at
      FROM price_lookup_misses
      WHERE asset = ? AND day = ? AND source = ?
      LIMIT 1
    `);

    this.recordStmt = db.prepare(`
      INSERT OR REPLACE INTO price_lookup_misses (asset, day, source, checked_at)
      VALUES (?, ?, ?, ?)
    `);
  }

  /**
   * Return `true` if there is a fresh (within TTL) miss entry for this
   * (asset, day) pair. The `source` value used is `'chain'` — one entry
   * per (asset, day) regardless of how many providers were tried.
   *
   * @param asset - Canonical ticker.
   * @param day   - Unix seconds at 00:00 UTC.
   * @param ttlSeconds - How old (in seconds) a miss may be before it expires.
   */
  hasFreshMiss(asset: string, day: number, ttlSeconds: number): boolean {
    const row = this.checkStmt.get(asset, day, 'chain') as
      | { checked_at: number }
      | undefined;
    if (!row) return false;
    const ageSeconds = Math.floor(Date.now() / 1000) - row.checked_at;
    return ageSeconds < ttlSeconds;
  }

  /**
   * Record a clean all-null miss for (asset, day).
   *
   * Only call this when providers returned null without throwing — i.e. there
   * was no data, not a transient failure.
   *
   * @param asset - Canonical ticker.
   * @param day   - Unix seconds at 00:00 UTC.
   */
  recordMiss(asset: string, day: number): void {
    this.recordStmt.run(asset, day, 'chain', Math.floor(Date.now() / 1000));
  }
}
