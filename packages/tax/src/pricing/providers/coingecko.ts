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
 * Returns `null` on any error or missing data — never throws.
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
// Provider
// ─────────────────────────────────────────────────────────────────────────

export interface CoinGeckoProviderOptions {
  /** Optional API key for the pro tier. */
  apiKey?: string;
  /** CoinGecko platform for contract lookups (default: 'ethereum'). */
  platform?: string;
}

/**
 * CoinGecko historical price provider.
 *
 * Tries ticker-based lookup first, then falls back to contract-address
 * lookup if a `contractAddress` is provided.
 */
export class CoinGeckoProvider implements PricingProvider {
  readonly name = 'coingecko';

  private readonly apiKey: string | undefined;
  private readonly platform: string;

  constructor(options: CoinGeckoProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.platform = options.platform ?? 'ethereum';
  }

  /**
   * Look up the historical USD price for an asset.
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

    try {
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
    } catch {
      return null;
    }
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

    // Try each known platform
    for (const platformId of Object.values(PLATFORM_IDS)) {
      const url =
        `${BASE_URL}/coins/${platformId}/contract/${contractAddress.toLowerCase()}/market_chart/range` +
        `?vs_currency=usd&from=${from}&to=${to}`;

      try {
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
      } catch {
        continue;
      }
    }

    return null;
  }

  // ─── HTTP with exponential backoff ───────────────────────────────────

  private async fetchWithRetry(
    url: string,
    maxRetries = 3,
  ): Promise<Record<string, unknown> | null> {
    let delay = 1000; // start at 1s

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          return null;
        }

        if (!response.ok) return null;

        return (await response.json()) as Record<string, unknown>;
      } catch {
        // Network error — retry with backoff
        if (attempt < maxRetries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        return null;
      }
    }

    return null;
  }
}
