/**
 * Pricing chain runner.
 *
 * Tries pricing providers in priority order and caches normal provider
 * results.
 *
 * The default v1 chain is:
 *   1. source-reported (from exchange data)
 *   2. CoinGecko (historical API)
 *   3. manual-override (user-entered)
 *
 * Providers with `cacheMode: 'bypass'` are checked before the cache and are
 * not cached. This lets user-entered corrections override stale cached data.
 *
 * Negative-cache integration:
 *   When an optional PriceMissCache is provided, priceAt() will:
 *   - Return null early (without hitting providers) if a fresh miss entry
 *     exists for the (asset, day) pair.
 *   - Record a miss entry when all cacheable providers return null cleanly
 *     (i.e. no data — not a transient failure).
 *   - NOT record a miss when a provider throws (transient/unrecoverable
 *     error), so the next run will retry.
 */

import type { PriceResult, PricingProvider } from './provider.js';
import type { PriceCache, PriceMissCache } from './cache.js';
import { dayUtc, NEGATIVE_CACHE_TTL_SECONDS } from './cache.js';
import { canonicalAsset } from './asset-aliases.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the pricing chain.
 */
export interface PricingChainConfig {
  /** Providers to try, in priority order. */
  providers: PricingProvider[];
}

// ─────────────────────────────────────────────────────────────────────────
// Chain
// ─────────────────────────────────────────────────────────────────────────

/**
 * Runs pricing providers in priority order with caching.
 *
 * Usage:
 * ```ts
 * const chain = new PricingChain(config, cache);
 * const result = await chain.priceAt('ETH', new Date('2024-01-15'));
 * ```
 */
export class PricingChain {
  private readonly providers: PricingProvider[];
  private readonly cache: PriceCache;
  private readonly missCache: PriceMissCache | null;
  private readonly negativeCacheTtl: number;

  constructor(
    config: PricingChainConfig,
    cache: PriceCache,
    missCache?: PriceMissCache,
    negativeCacheTtlSeconds?: number,
  ) {
    this.providers = config.providers;
    this.cache = cache;
    this.missCache = missCache ?? null;
    this.negativeCacheTtl = negativeCacheTtlSeconds ?? NEGATIVE_CACHE_TTL_SECONDS;
  }

  /**
   * Resolve the USD price of an asset at a given timestamp.
   *
   * 1. Canonicalizes the asset via asset-aliases (POL→MATIC, ETH2→ETH).
   * 2. Checks cache-bypassing providers.
   * 3. Checks the negative-miss cache — returns null early if a fresh miss
   *    entry exists (only when a PriceMissCache was provided).
   * 4. Checks the positive cache for a hit on the canonical asset + day.
   * 5. Tries cacheable providers in order until one returns a result.
   *    Providers that throw (transient errors) are skipped; the failure
   *    is NOT negative-cached so it retries on the next run.
   * 6. Caches the winning cacheable result.
   * 7. If all cacheable providers returned null (no throw), records a miss.
   * 8. Returns `null` if all providers return null.
   *
   * @param asset - Ticker symbol or contract address.
   * @param timestamp - Date to price at.
   * @param contractAddress - Optional ERC-20 contract address.
   * @returns The price result, or `null` if no provider has data.
   */
  async priceAt(
    asset: string,
    timestamp: Date,
    contractAddress?: string,
  ): Promise<PriceResult | null> {
    const canonical = canonicalAsset(asset);
    const day = dayUtc(timestamp);

    // ── 1. Bypass providers (e.g. manual override) ────────────────────
    for (const provider of this.providers) {
      if (provider.cacheMode !== 'bypass') continue;

      const result = await provider.getPrice(canonical, timestamp, contractAddress);
      if (result) return result;
    }

    // ── 2. Fresh negative-cache miss — skip all providers early ───────
    if (this.missCache?.hasFreshMiss(canonical, day, this.negativeCacheTtl)) {
      return null;
    }

    // ── 3. Positive cache hit ─────────────────────────────────────────
    const cached = this.cache.get(canonical, day);
    if (cached) return cached;

    // ── 4. Try each cacheable provider in order ───────────────────────
    let hadTransientFailure = false;

    for (const provider of this.providers) {
      if (provider.cacheMode === 'bypass') continue;

      let result: PriceResult | null;
      try {
        result = await provider.getPrice(canonical, timestamp, contractAddress);
      } catch {
        // Transient/unrecoverable error — skip this provider, mark failure,
        // do NOT write a miss entry (let the next run retry).
        hadTransientFailure = true;
        continue;
      }

      if (result) {
        // Cache the winning result
        this.cache.set(canonical, day, result.source, result.priceUsd);
        return result;
      }
    }

    // ── 5. All cacheable providers returned null ──────────────────────
    // Only record a miss if there were no transient failures — a transient
    // failure means "we couldn't check", not "there's no data".
    if (!hadTransientFailure && this.missCache) {
      this.missCache.recordMiss(canonical, day);
    }

    return null;
  }
}
