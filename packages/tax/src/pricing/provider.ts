/**
 * Pricing provider interface and types.
 *
 * Each provider resolves a USD price for an asset at a given timestamp.
 * Providers are tried in priority order by the PricingChain — the first
 * non-null result wins.
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * The result of a successful price lookup.
 *
 * `priceUsd` is a decimal string (e.g. `'2305.73'`), never a JS number.
 * `source` identifies which provider produced the result.
 */
export interface PriceResult {
  /** USD price as a decimal string. */
  priceUsd: string;
  /** Which provider resolved this price (e.g. 'source-reported', 'coingecko'). */
  source: string;
}

/**
 * A pricing provider resolves USD prices for assets at specific timestamps.
 *
 * Implementations include source-reported (from exchange data), CoinGecko
 * (historical API), and manual overrides (user-entered).
 *
 * Return `null` when the provider has no data for the requested asset/date.
 * Never throw on missing data — only throw on unrecoverable errors.
 */
export interface PricingProvider {
  /** Human-readable name for logging and cache attribution. */
  readonly name: string;

  /**
   * Whether this provider should bypass the shared price cache.
   *
   * Manual overrides use this so a user-entered correction always wins over
   * stale cached market data and does not leave a cached override behind after
   * removal.
   */
  readonly cacheMode?: 'read-write' | 'bypass';

  /**
   * Look up the USD price of an asset at a given timestamp.
   *
   * @param asset - Ticker symbol (e.g. 'ETH', 'BTC') or contract address.
   * @param timestamp - The point in time to price at (daily granularity).
   * @param contractAddress - Optional ERC-20 contract address for on-chain tokens.
   * @returns The price result, or `null` if this provider has no data.
   */
  getPrice(
    asset: string,
    timestamp: Date,
    contractAddress?: string,
  ): Promise<PriceResult | null>;
}
