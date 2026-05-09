/**
 * EVM transfer provider interface and types.
 *
 * The provider is the boundary between chain-specific data fetching (Alchemy,
 * Etherscan, raw RPC) and the chain-agnostic adapter that translates transfers
 * into daybook's `RawEvent` shape.
 *
 * The provider produces `RawTransfer` — a normalized intermediate that carries
 * enough information for the adapter to decide direction, sign amounts, and
 * assign event types, without knowing which API produced the data.
 *
 * Why `RawTransfer` instead of `RawEvent` directly?
 *   1. The provider doesn't know the user's address list — can't decide
 *      `crypto_in` vs `crypto_out`.
 *   2. NFT placeholder semantics are a product decision, not a provider concern.
 *   3. Keeping the boundary narrow means each new provider is ~50 lines.
 */

import type { SourceId } from '@daybook/ledger';

// ─────────────────────────────────────────────────────────────────────────
// Chain identification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonical EIP-155 chain ID. Globally unique and unambiguous.
 *
 *   1     = Ethereum mainnet
 *   137   = Polygon PoS
 *   42161 = Arbitrum One
 *   10    = Optimism
 *   8453  = Base
 *   56    = BNB Smart Chain
 */
export type ChainId = number;

/** Map daybook source IDs to their canonical chain IDs. */
export const CHAIN_ID_BY_SOURCE: Record<string, ChainId> = {
  eth: 1,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  bnb: 56,
} as const;

/** Reverse map: chain ID → daybook source ID. */
export const SOURCE_BY_CHAIN_ID: Record<ChainId, SourceId> = {
  1: 'eth',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base',
  56: 'bnb',
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Provider-agnostic intermediate shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * One transfer as seen by the provider, before the adapter applies direction
 * and sign conventions.
 *
 * The provider handles unit math (raw hex → decimal string), timestamp
 * normalization, and pagination. The adapter just consumes this.
 */
export interface RawTransfer {
  /** Stable ID assigned by the provider. Used in `RawEvent.id` for idempotency. */
  providerId: string;
  /** Chain the transfer happened on. */
  chainId: ChainId;
  /** Block number. */
  blockNum: bigint;
  /** Transaction hash. */
  txHash: string;
  /** Log index within the tx (for ERC-20/721/1155). `null` for native/internal. */
  logIndex: number | null;
  /** When the block was mined. */
  timestamp: Date;
  /** Transfer category — determines how the adapter interprets the data. */
  category: 'native' | 'internal' | 'erc20' | 'erc721' | 'erc1155';
  /** Sender address (lowercased by convention). */
  from: string;
  /** Receiver address. `null` for contract creation. */
  to: string | null;
  /**
   * Decimal-string amount, unsigned. The adapter signs based on direction.
   * `undefined` for ERC-721 (the asset is the token itself, qty 1) or
   * when the provider couldn't resolve the amount.
   */
  amount?: string;
  /** Symbol like 'ETH', 'USDC'. May be `null` for unknown ERC-20s. */
  asset: string | null;
  /** Contract address for ERC-* transfers. `undefined` for native ETH. */
  contractAddress?: string;
  /** Decimal places for the amount (so the adapter can re-derive raw if needed). */
  decimals?: number;
  /** Token ID for NFT transfers (ERC-721/1155). */
  tokenId?: string;
  /** Original payload from the provider — kept verbatim for debugging. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Token metadata
// ─────────────────────────────────────────────────────────────────────────

/** Cached metadata for an ERC-20 contract. */
export interface TokenMetadata {
  contractAddress: string;
  chainId: ChainId;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Fetch options
// ─────────────────────────────────────────────────────────────────────────

export interface FetchTransfersOpts {
  /** Wallet address to query transfers for. */
  address: string;
  /** Chain to query. */
  chainId: ChainId;
  /** Inclusive lower-bound block. Useful for incremental syncs in v2. */
  fromBlock?: bigint;
  /** Inclusive upper-bound block. Defaults to latest. */
  toBlock?: bigint;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────────────────

/**
 * Abstraction over chain data providers (Alchemy, Etherscan, raw RPC).
 *
 * Implementations MUST:
 *   - Handle pagination internally — the consumer just iterates until done.
 *   - Merge all 5 categories into a single stream.
 *   - Normalize amounts to decimal strings using precision-safe math.
 */
export interface EvmTransferProvider {
  /** Identifier for logs and config. */
  readonly name: 'alchemy' | 'etherscan' | 'rpc';

  /**
   * Stream transfers for an address. Implementations handle pagination
   * internally; the consumer iterates until the stream ends.
   */
  fetchTransfers(opts: FetchTransfersOpts): AsyncIterable<RawTransfer>;

  /**
   * Resolve metadata for an ERC-20 contract.
   * Returning `null` is fine — the adapter falls back to using the contract
   * address as the asset name.
   */
  getTokenMetadata(opts: {
    contractAddress: string;
    chainId: ChainId;
  }): Promise<TokenMetadata | null>;
}
