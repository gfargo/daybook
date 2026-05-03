/**
 * Alchemy-backed implementation of EvmTransferProvider.
 *
 * Uses `alchemy-sdk`'s `getAssetTransfers` with `withMetadata: true` to pull
 * all transfer categories for a wallet address. Queries are bidirectional
 * (fromAddress + toAddress) and paginated independently.
 *
 * Critical implementation rules:
 *   1. Always use `rawContract.value` (hex) + `rawContract.decimal` (hex) for
 *      amount math. The SDK's `value: number` field loses precision above 2^53.
 *   2. `uniqueId` is stable across calls — used as our `RawEvent.id` source.
 *   3. Internal transfers only available on ETH mainnet + Polygon mainnet.
 *   4. Token metadata is cached in-memory keyed by `${chainId}:${contractAddress}`.
 *
 * Note: The alchemy-sdk-js repo was archived March 2026. Package still works.
 * Plan B is a viem-based custom client behind the same interface.
 */

import {
    Alchemy,
    AssetTransfersCategory,
    Network,
} from 'alchemy-sdk';
import type {
    AssetTransfersWithMetadataParams,
    AssetTransfersWithMetadataResponse,
    AssetTransfersWithMetadataResult,
} from 'alchemy-sdk';
import Decimal from 'decimal.js';
import type {
    ChainId,
    EvmTransferProvider,
    FetchTransfersOpts,
    RawTransfer,
    TokenMetadata,
} from '../provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Chain → Alchemy Network mapping
// ─────────────────────────────────────────────────────────────────────────

const NETWORK_BY_CHAIN_ID: Record<number, Network> = {
  1: Network.ETH_MAINNET,
  137: Network.MATIC_MAINNET,
  42161: Network.ARB_MAINNET,
  10: Network.OPT_MAINNET,
  8453: Network.BASE_MAINNET,
};

// ─────────────────────────────────────────────────────────────────────────
// Transfer category mapping
// ─────────────────────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, RawTransfer['category']> = {
  [AssetTransfersCategory.EXTERNAL]: 'native',
  [AssetTransfersCategory.INTERNAL]: 'internal',
  [AssetTransfersCategory.ERC20]: 'erc20',
  [AssetTransfersCategory.ERC721]: 'erc721',
  [AssetTransfersCategory.ERC1155]: 'erc1155',
};

// ─────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Alchemy-backed EVM transfer provider.
 *
 * Streams all 5 transfer categories for a wallet address, handling pagination
 * and precision math internally.
 */
export class AlchemyTransferProvider implements EvmTransferProvider {
  readonly name = 'alchemy' as const;

  /** Lazily-created Alchemy clients, one per chain. */
  private readonly clientByChain = new Map<ChainId, Alchemy>();

  /** In-memory token metadata cache keyed by `${chainId}:${contractAddress}`. */
  private readonly metadataCache = new Map<string, TokenMetadata | null>();

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'AlchemyTransferProvider: apiKey is required. ' +
        'Get a free key at https://dashboard.alchemy.com',
      );
    }
  }

  // ─── fetchTransfers ──────────────────────────────────────────────────

  /**
   * Stream transfers for an address. Queries both directions (from + to)
   * and all 5 categories, paginating each independently.
   */
  async *fetchTransfers(opts: FetchTransfersOpts): AsyncIterable<RawTransfer> {
    const client = this.clientFor(opts.chainId);

    const allCategories = [
      AssetTransfersCategory.EXTERNAL,
      AssetTransfersCategory.INTERNAL,
      AssetTransfersCategory.ERC20,
      AssetTransfersCategory.ERC721,
      AssetTransfersCategory.ERC1155,
    ];

    const fromBlock =
      opts.fromBlock !== undefined
        ? '0x' + opts.fromBlock.toString(16)
        : '0x0';
    const toBlock =
      opts.toBlock !== undefined
        ? '0x' + opts.toBlock.toString(16)
        : 'latest';

    const baseParams = {
      fromBlock,
      toBlock,
      category: allCategories,
      withMetadata: true as const,
      excludeZeroValue: false,
      maxCount: 1000,
    };

    // Stream outgoing transfers (from = user)
    yield* this.paginateAndMap(
      { ...baseParams, fromAddress: opts.address },
      client,
      opts.chainId,
    );

    // Stream incoming transfers (to = user)
    yield* this.paginateAndMap(
      { ...baseParams, toAddress: opts.address },
      client,
      opts.chainId,
    );
  }

  // ─── getTokenMetadata ────────────────────────────────────────────────

  /**
   * Resolve metadata for an ERC-20 contract. Results are cached in-memory.
   * Returns `null` for contracts that can't be resolved (scam tokens, etc).
   */
  async getTokenMetadata(opts: {
    contractAddress: string;
    chainId: ChainId;
  }): Promise<TokenMetadata | null> {
    const cacheKey = `${opts.chainId}:${opts.contractAddress.toLowerCase()}`;

    if (this.metadataCache.has(cacheKey)) {
      return this.metadataCache.get(cacheKey) ?? null;
    }

    const client = this.clientFor(opts.chainId);
    try {
      const meta = await client.core.getTokenMetadata(opts.contractAddress);
      const result: TokenMetadata = {
        contractAddress: opts.contractAddress,
        chainId: opts.chainId,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
      };
      this.metadataCache.set(cacheKey, result);
      return result;
    } catch {
      // Cache the miss so we don't retry on every call.
      this.metadataCache.set(cacheKey, null);
      return null;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  /** Get or create an Alchemy client for a chain. */
  private clientFor(chainId: ChainId): Alchemy {
    let client = this.clientByChain.get(chainId);
    if (!client) {
      const network = NETWORK_BY_CHAIN_ID[chainId];
      if (!network) {
        throw new Error(
          `AlchemyTransferProvider does not support chainId ${chainId}. ` +
          `Supported: ${Object.keys(NETWORK_BY_CHAIN_ID).join(', ')}`,
        );
      }
      client = new Alchemy({ apiKey: this.apiKey, network });
      this.clientByChain.set(chainId, client);
    }
    return client;
  }

  /**
   * Paginate through Alchemy's getAssetTransfers and yield RawTransfers.
   * Handles the pageKey-based pagination loop internally.
   */
  private async *paginateAndMap(
    params: AssetTransfersWithMetadataParams,
    client: Alchemy,
    chainId: ChainId,
  ): AsyncIterable<RawTransfer> {
    let pageKey: string | undefined;
    do {
      const response: AssetTransfersWithMetadataResponse =
        await client.core.getAssetTransfers({
          ...params,
          ...(pageKey ? { pageKey } : {}),
        });
      for (const transfer of response.transfers) {
        yield this.toRawTransfer(transfer, chainId);
      }
      pageKey = response.pageKey;
    } while (pageKey);
  }

  /**
   * Map an Alchemy transfer result to our provider-agnostic RawTransfer.
   *
   * CRITICAL: Uses `rawContract.value` (hex) + `rawContract.decimal` (hex)
   * for precision-safe amount math. Never trusts the lossy `value: number`.
   */
  private toRawTransfer(
    t: AssetTransfersWithMetadataResult,
    chainId: ChainId,
  ): RawTransfer {
    const blockNum = BigInt(t.blockNum);
    const timestamp = new Date(t.metadata.blockTimestamp);

    // Precision-safe amount from raw hex values.
    let amount: string | undefined;
    let decimals: number | undefined;
    if (t.rawContract.value && t.rawContract.decimal) {
      decimals = parseInt(t.rawContract.decimal, 16);
      const rawHex = t.rawContract.value.startsWith('0x')
        ? t.rawContract.value
        : '0x' + t.rawContract.value;
      const rawWei = new Decimal(rawHex);
      amount = rawWei.dividedBy(new Decimal(10).pow(decimals)).toString();
    } else if (t.value !== null && t.value !== undefined) {
      // Fallback for transfers without rawContract data (rare).
      // This uses the lossy JS number — acceptable only for small values.
      amount = t.value.toString();
    }
    // If neither is available (e.g. ERC-721), amount stays undefined.

    const category: RawTransfer['category'] =
      CATEGORY_MAP[t.category] ?? 'erc20';

    return {
      providerId: t.uniqueId,
      chainId,
      blockNum,
      txHash: t.hash,
      logIndex: null, // Alchemy doesn't surface logIndex in transfers; OK for v1
      timestamp,
      category,
      from: t.from,
      to: t.to,
      ...(amount !== undefined ? { amount } : {}),
      asset: t.asset,
      ...(t.rawContract.address
        ? { contractAddress: t.rawContract.address }
        : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(t.tokenId ? { tokenId: t.tokenId } : {}),
      raw: t,
    };
  }
}
