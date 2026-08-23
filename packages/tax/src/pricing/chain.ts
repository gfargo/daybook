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

  constructor(config: PricingChainConfig, cache: PriceCache) {
    this.providers = config.providers;
    this.cache = cache;
  }

  /**
   * Resolve the USD price of an asset at a given timestamp.
   *
   * 1. Canonicalizes the asset via asset-aliases (POL→MATIC, ETH2→ETH).
   * 2. Checks cache-bypassing providers.
   * 3. Checks the cache for a hit on the canonical asset + day,
   *    preferring the highest-priority cacheable provider's source.
   * 4. Tries cacheable providers in order until one returns a result.
   * 5. Caches the winning cacheable result.
   * 6. Returns `null` if all providers return null.
   *
   * @param asset - Ticker symbol or contract address.
   * @param timestamp - Date to price at.
   * @param contractAddress - Optional ERC-20 contract address.
   * @param platform - Optional CoinGecko platform ID for contract lookups
   *   (e.g. 'polygon-pos', 'arbitrum-one'). Forwarded to providers that
   *   support per-chain contract address resolution.
   * @returns The price result, or `null` if no provider has data.
   */
  async priceAt(
    asset: string,
    timestamp: Date,
    contractAddress?: string,
    platform?: string,
  ): Promise<PriceResult | null> {
    const canonical = canonicalAsset(asset);
    const day = dayUtc(timestamp);

    for (const provider of this.providers) {
      if (provider.cacheMode !== 'bypass') continue;

      const result = await provider.getPrice(canonical, timestamp, contractAddress, platform);
      if (result) return result;
    }

    // Build the ordered list of cacheable provider names for deterministic
    // cache resolution — earlier in the chain = higher priority.
    const cacheableProviderNames = this.providers
      .filter(p => p.cacheMode !== 'bypass')
      .map(p => p.name);

    // 1. Check cache (source-aware, deterministic)
    const cached = this.cache.get(canonical, day, cacheableProviderNames);
    if (cached) return cached;

    // 2. Try each provider in order
    for (const provider of this.providers) {
      if (provider.cacheMode === 'bypass') continue;

      const result = await provider.getPrice(canonical, timestamp, contractAddress, platform);
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
