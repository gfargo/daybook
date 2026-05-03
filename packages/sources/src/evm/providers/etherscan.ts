/**
 * Etherscan-backed implementation of EvmTransferProvider.
 *
 * Only emits RawTransfers for **failed** transactions (`isError === '1'`).
 * Successful transactions are already captured by the Alchemy provider —
 * this provider exists solely to surface gas costs from reverted txs that
 * would otherwise be silently dropped.
 *
 * Gas cost is computed as `gasUsed × gasPrice / 1e18` using decimal.js
 * for precision-safe math. Never floating-point.
 *
 * Provider IDs use the format `etherscan-failed:<txHash>` to avoid
 * collisions with Alchemy's `uniqueId` scheme.
 */

import Decimal from 'decimal.js';
import type {
    ChainId,
    EvmTransferProvider,
    FetchTransfersOpts,
    RawTransfer,
    TokenMetadata,
} from '../provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Etherscan API types
// ─────────────────────────────────────────────────────────────────────────

/** Shape of a single transaction in the Etherscan `txlist` response. */
interface EtherscanTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  gasUsed: string;
  gasPrice: string;
  isError: string;
}

/** Shape of the Etherscan API JSON response. */
interface EtherscanApiResponse {
  status: string;
  message: string;
  result: EtherscanTx[] | string;
}

// ─────────────────────────────────────────────────────────────────────────
// Chain → Etherscan base URL mapping
// ─────────────────────────────────────────────────────────────────────────

const BASE_URL_BY_CHAIN_ID: Record<number, string> = {
  1: 'https://api.etherscan.io/api',
  137: 'https://api.polygonscan.com/api',
};

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Number of results per page. Etherscan max is 10000. */
const PAGE_OFFSET = 10_000;

/** Maximum retry attempts for rate-limited requests. */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
const BASE_DELAY_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Etherscan-backed EVM transfer provider for failed transaction gas tracking.
 *
 * Only emits RawTransfers for failed (reverted) transactions. Successful
 * transactions are skipped since Alchemy already captures those.
 */
export class EtherscanTransferProvider implements EvmTransferProvider {
  readonly name = 'etherscan' as const;

  /** Overridable sleep function for testing. */
  private _sleep: (ms: number) => Promise<void> = sleep;

  constructor(
    private readonly apiKey: string,
    private readonly chainId: ChainId,
  ) {
    if (!apiKey) {
      throw new Error(
        'ETHERSCAN_API_KEY is required for failed-transaction gas tracking. ' +
        'Get a free key at https://etherscan.io/apis',
      );
    }
  }

  // ─── fetchTransfers ──────────────────────────────────────────────────

  /**
   * Stream failed-transaction gas costs for an address.
   *
   * Fetches the normal transaction list from Etherscan, filters to only
   * failed transactions, and emits a RawTransfer for each with the gas
   * cost as the amount.
   */
  async *fetchTransfers(opts: FetchTransfersOpts): AsyncIterable<RawTransfer> {
    const baseUrl = BASE_URL_BY_CHAIN_ID[this.chainId];
    if (!baseUrl) {
      throw new Error(
        `EtherscanTransferProvider does not support chainId ${this.chainId}. ` +
        `Supported: ${Object.keys(BASE_URL_BY_CHAIN_ID).join(', ')}`,
      );
    }

    let page = 1;

    while (true) {
      const url = this.buildUrl(baseUrl, opts.address, page);
      const response = await this.fetchWithRetry(url);

      // Etherscan returns "No transactions found" as a string result
      // when there are no results, or an empty array.
      if (!Array.isArray(response.result)) break;

      const txs = response.result;

      for (const tx of txs) {
        // Only emit failed transactions — successful ones are handled by Alchemy.
        if (tx.isError !== '1') continue;

        // Skip if gasUsed is zero (shouldn't happen, but guard).
        if (tx.gasUsed === '0') continue;

        yield this.toRawTransfer(tx);
      }

      // Stop paginating when we got fewer results than the page size.
      if (txs.length < PAGE_OFFSET) break;

      page++;
    }
  }

  // ─── getTokenMetadata ────────────────────────────────────────────────

  /**
   * Not needed for failed-tx gas tracking. Always returns `null`.
   */
  async getTokenMetadata(): Promise<TokenMetadata | null> {
    return null;
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /**
   * Build the Etherscan API URL for the `txlist` endpoint.
   */
  private buildUrl(baseUrl: string, address: string, page: number): string {
    return (
      `${baseUrl}?module=account&action=txlist` +
      `&address=${address}` +
      `&startblock=0&endblock=99999999` +
      `&page=${page}&offset=${PAGE_OFFSET}` +
      `&sort=asc` +
      `&apikey=${this.apiKey}`
    );
  }

  /**
   * Fetch a URL with exponential backoff on rate limit (HTTP 429 or
   * Etherscan's status "0" with rate-limit message).
   */
  private async fetchWithRetry(url: string): Promise<EtherscanApiResponse> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(url);

      // HTTP-level rate limit
      if (res.status === 429) {
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(
            'Etherscan API rate limit exceeded after 3 retries. ' +
            'Try again later or use a paid API key.',
          );
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await this._sleep(delay);
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `Etherscan API returned HTTP ${res.status}: ${res.statusText}`,
        );
      }

      const body = (await res.json()) as EtherscanApiResponse;

      // Etherscan-level rate limit (returns 200 with status "0" and a message)
      if (
        body.status === '0' &&
        typeof body.result === 'string' &&
        body.result.toLowerCase().includes('rate limit')
      ) {
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(
            'Etherscan API rate limit exceeded after 3 retries. ' +
            'Try again later or use a paid API key.',
          );
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await this._sleep(delay);
        continue;
      }

      return body;
    }

    // Should be unreachable, but TypeScript needs it.
    throw new Error('Etherscan API: unexpected retry loop exit');
  }

  /**
   * Map an Etherscan transaction to a RawTransfer.
   *
   * Gas cost = gasUsed × gasPrice / 1e18, computed via decimal.js.
   */
  private toRawTransfer(tx: EtherscanTx): RawTransfer {
    const gasCost = new Decimal(tx.gasUsed)
      .mul(tx.gasPrice)
      .div('1e18');

    return {
      providerId: `etherscan-failed:${tx.hash}`,
      chainId: this.chainId,
      blockNum: BigInt(tx.blockNumber),
      txHash: tx.hash,
      logIndex: null,
      timestamp: new Date(Number(tx.timeStamp) * 1000),
      category: 'native',
      from: tx.from.toLowerCase(),
      to: tx.to ? tx.to.toLowerCase() : null,
      amount: gasCost.toString(),
      asset: 'ETH',
      raw: tx,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

/** Promise-based sleep for backoff delays. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
