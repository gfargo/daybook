/**
 * Pricing chain runner.
 *
 * Tries pricing providers in priority order, caches the winning result,
 * and applies the unpriced policy (auto-zero below a USD threshold).
 *
 * The default v1 chain is:
 *   1. source-reported (from exchange data)
 *   2. CoinGecko (historical API)
 *   3. manual-override (user-entered)
 *
 * The chain checks the cache before calling any provider. A cache hit
 * short-circuits the entire chain.
 */

import type { PriceResult, PricingProvider } from './provider.js';
import type { PriceCache } from './cache.js';
import { dayUtc } from './cache.js';
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
  /**
   * USD threshold below which unpriced assets are automatically zeroed.
   * Decimal string (e.g. '1.00'). Events above this threshold are flagged
   * as unpriced rather than silently zeroed.
   */
  autoZeroBelowUsd: string;
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
  private readonly autoZeroBelowUsd: string;
  private readonly cache: PriceCache;

  constructor(config: PricingChainConfig, cache: PriceCache) {
    this.providers = config.providers;
    this.autoZeroBelowUsd = config.autoZeroBelowUsd;
    this.cache = cache;
  }

  /**
   * Resolve the USD price of an asset at a given timestamp.
   *
   * 1. Canonicalizes the asset via asset-aliases (POL→MATIC, ETH2→ETH).
   * 2. Checks the cache for a hit on the canonical asset + day.
   * 3. Tries each provider in order until one returns a result.
   * 4. Caches the winning result.
   * 5. Returns `null` if all providers return null.
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

    // 1. Check cache
    const cached = this.cache.get(canonical, day);
    if (cached) return cached;

    // 2. Try each provider in order
    for (const provider of this.providers) {
      const result = await provider.getPrice(canonical, timestamp, contractAddress);
      if (result) {
        // 3. Cache the winning result
        this.cache.set(canonical, day, result.source, result.priceUsd);
        return result;
      }
    }

    // 4. All providers returned null
    return null;
  }
}
