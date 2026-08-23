/**
 * CoinGecko pricing provider.
 *
 * Resolves historical USD prices via the CoinGecko public API:
 *   - By ticker: `/coins/{id}/history?date=DD-MM-YYYY&localization=false`
 *   - By ERC-20 contract: `/coins/{platform}/contract/{address}/market_chart/range`
 *
 * Free tier allows ~30 requests/minute without an API key.
 * Implements exponential backoff on 429 responses, max 3 retries.
 *
 * Returns `null` for genuine no-data (unknown asset, missing market_data, empty
 * price array). Throws `CoinGeckoTransientError` on unrecoverable errors
 * (429-after-all-retries, non-2xx, network failure) so the caller can
 * distinguish transient failure from a real "no data" miss and avoid
 * negative-caching transient failures.
 *
 * A token-bucket rate limiter is built in; only actual HTTP calls are
 * throttled — synchronous cache reads and manual-override lookups are
 * unaffected.
 */

import type { PriceResult, PricingProvider } from '../provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Ticker → CoinGecko ID mapping
// ─────────────────────────────────────────────────────────────────────────

/**
 * Static map of common asset tickers to CoinGecko coin IDs.
 *
 * CoinGecko's historical API requires the internal coin ID, not the ticker.
 * This covers the assets present in the user's real data. Unknown tickers
 * fall through to contract-address lookup or return null.
 */
const TICKER_TO_COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  MATIC: 'matic-network',
  POL: 'matic-network',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  COMP: 'compound-governance-token',
  ALGO: 'algorand',
  ENS: 'ethereum-name-service',
  GRT: 'the-graph',
  INJ: 'injective-protocol',
  DOGE: 'dogecoin',
  XLM: 'stellar',
  AAVE: 'aave',
  ICP: 'internet-computer',
  MANA: 'decentraland',
  TRAC: 'origintrail',
  KNC: 'kyber-network-crystal',
  NU: 'nucypher',
  UMA: 'uma',
  CGLD: 'celo',
  ALCX: 'alchemix',
  WETH: 'weth',
  WBTC: 'wrapped-bitcoin',
  TEL: 'telcoin',
};

// ─────────────────────────────────────────────────────────────────────────
// Platform mapping for contract-address lookups
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map of chain identifiers to CoinGecko platform IDs.
 * Used for ERC-20 contract address price lookups.
 */
const PLATFORM_IDS: Record<string, string> = {
  ethereum: 'ethereum',
  polygon: 'polygon-pos',
};

// ─────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────

/**
 * Thrown by CoinGeckoProvider on unrecoverable / transient errors:
 * - 429 exhausted after all retries
 * - Non-2xx HTTP response
 * - Network / connection failure
 *
 * Callers (PricingChain) catch this and DO NOT record a negative-cache miss
 * for these cases, so a retry on the next run is attempted.
 */
export class CoinGeckoTransientError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CoinGeckoTransientError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.coingecko.com/api/v3';

/**
 * Format a Date as DD-MM-YYYY for the CoinGecko history endpoint.
 */
function formatDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────
// Token-bucket rate limiter
// ─────────────────────────────────────────────────────────────────────────

/**
 * Minimal token-bucket rate limiter. Tracks when tokens were last consumed
 * and delays the next request to stay within the per-minute cap.
 *
 * Only used internally by CoinGeckoProvider to gate actual HTTP calls.
 */
class RateLimiter {
  private readonly minIntervalMs: number;
  private lastCallMs = 0;

  constructor(requestsPerMinute: number) {
    // Spread requests evenly across the minute window.
    this.minIntervalMs = Math.ceil(60_000 / requestsPerMinute);
  }

  /**
   * Wait until enough time has passed since the last call, then resolve.
   */
  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallMs = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────

export interface CoinGeckoProviderOptions {
  /** Optional API key for the pro tier. */
  apiKey?: string;
  /** CoinGecko platform for contract lookups (default: 'ethereum'). */
  platform?: string;
  /**
   * Maximum HTTP calls per minute (default: 25 to stay safely under the
   * free-tier 30 req/min cap). Only actual network calls count; cached
   * lookups and manual overrides are not throttled.
   */
  requestsPerMinute?: number;
}

/**
 * CoinGecko historical price provider.
 *
 * Tries ticker-based lookup first, then falls back to contract-address
 * lookup if a `contractAddress` is provided.
 *
 * Returns `null` for genuine no-data. Throws `CoinGeckoTransientError` for
 * transient/unrecoverable failures so callers can avoid negative-caching them.
 */
export class CoinGeckoProvider implements PricingProvider {
  readonly name = 'coingecko';

  private readonly apiKey: string | undefined;
  private readonly platform: string;
  private readonly rateLimiter: RateLimiter;

  constructor(options: CoinGeckoProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.platform = options.platform ?? 'ethereum';
    this.rateLimiter = new RateLimiter(options.requestsPerMinute ?? 25);
  }

  /**
   * Look up the historical USD price for an asset.
   *
   * Returns `null` when no data is available for the asset/date.
   * Throws `CoinGeckoTransientError` on network/HTTP failures.
   *
   * @param asset - Ticker symbol (e.g. 'ETH').
   * @param timestamp - Date to price at.
   * @param contractAddress - Optional ERC-20 contract address.
   * @returns The price result, or `null` if unavailable.
   */
  async getPrice(
    asset: string,
    timestamp: Date,
    contractAddress?: string,
  ): Promise<PriceResult | null> {
    // Try ticker-based lookup first
    const coinId = TICKER_TO_COINGECKO_ID[asset.toUpperCase()];
    if (coinId) {
      const price = await this.fetchByTicker(coinId, timestamp);
      if (price !== null) return price;
      // null here means no data for this ticker — continue to contract lookup
    }

    // Fall back to contract-address lookup
    if (contractAddress) {
      const price = await this.fetchByContract(contractAddress, timestamp);
      if (price !== null) return price;
    }

    return null;
  }

  // ─── Ticker-based lookup ─────────────────────────────────────────────

  private async fetchByTicker(
    coinId: string,
    timestamp: Date,
  ): Promise<PriceResult | null> {
    const dateStr = formatDate(timestamp);
    const url = `${BASE_URL}/coins/${coinId}/history?date=${dateStr}&localization=false`;

    // fetchWithRetry throws CoinGeckoTransientError on hard failures,
    // returns null for empty/missing data (200 OK but no market_data).
    const data = await this.fetchWithRetry(url);
    if (!data) return null;

    const marketData = data['market_data'] as
      | { current_price?: { usd?: number } }
      | undefined;
    const usd = marketData?.current_price?.usd;
    if (usd === undefined || usd === null) return null;

    return {
      priceUsd: String(usd),
      source: this.name,
    };
  }

  // ─── Contract-address lookup ─────────────────────────────────────────

  private async fetchByContract(
    contractAddress: string,
    timestamp: Date,
  ): Promise<PriceResult | null> {
    // Use market_chart/range with a 24h window around the target date
    const dayStart = new Date(timestamp);
    dayStart.setUTCHours(0, 0, 0, 0);
    const from = Math.floor(dayStart.getTime() / 1000);
    const to = from + 86400;

    // Try each known platform; return the first hit.
    // If a platform throws a transient error, propagate it immediately.
    for (const platformId of Object.values(PLATFORM_IDS)) {
      const url =
        `${BASE_URL}/coins/${platformId}/contract/${contractAddress.toLowerCase()}/market_chart/range` +
        `?vs_currency=usd&from=${from}&to=${to}`;

      // fetchWithRetry throws on transient failures; those propagate up.
      const data = await this.fetchWithRetry(url);
      if (!data) continue;

      const prices = data?.prices as Array<[number, number]> | undefined;
      if (!prices || prices.length === 0) continue;

      // Take the first price point in the range
      const [, usd] = prices[0]!;
      if (usd === undefined || usd === null) continue;

      return {
        priceUsd: String(usd),
        source: this.name,
      };
    }

    return null;
  }

  // ─── HTTP with exponential backoff + rate limiting ───────────────────

  /**
   * Fetch a URL with exponential backoff on 429.
   *
   * - Returns `null` only when the response is 200 OK but the payload has
   *   no useful data (i.e. genuine "no data" from CoinGecko).
   * - Throws `CoinGeckoTransientError` on:
   *     • 429 after all retries exhausted
   *     • Any non-2xx response other than 429
   *     • Network / connection error after all retries
   */
  private async fetchWithRetry(
    url: string,
    maxRetries = 3,
  ): Promise<Record<string, unknown> | null> {
    let delay = 1000; // start at 1s

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Throttle actual HTTP calls to stay within the rate limit.
      await this.rateLimiter.throttle();

      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
        };
        if (this.apiKey) {
          headers['x-cg-demo-api-key'] = this.apiKey;
        }

        const response = await fetch(url, { headers });

        if (response.status === 429) {
          // Rate limited — back off exponentially
          if (attempt < maxRetries) {
            await sleep(delay);
            delay *= 2;
            continue;
          }
          // All retries exhausted: this is a transient failure, not "no data"
          throw new CoinGeckoTransientError(
            `CoinGecko rate limit (429) exhausted after ${maxRetries + 1} attempts`,
          );
        }

        if (!response.ok) {
          // Non-2xx that isn't 429: treat as transient/unrecoverable
          throw new CoinGeckoTransientError(
            `CoinGecko HTTP error ${response.status} for ${url}`,
          );
        }

        // 200 OK — payload may or may not contain useful data
        return (await response.json()) as Record<string, unknown>;
      } catch (err) {
        // Re-throw our own typed errors immediately — don't retry them.
        if (err instanceof CoinGeckoTransientError) throw err;

        // Network / connection error — retry with backoff
        if (attempt < maxRetries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw new CoinGeckoTransientError(
          `CoinGecko network error for ${url}`,
          err,
        );
      }
    }

    // Unreachable, but satisfy TypeScript
    throw new CoinGeckoTransientError(`CoinGecko fetch failed for ${url}`);
  }
}
