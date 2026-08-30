/**
 * Solana transfer provider interface and types.
 *
 * Mirrors the EVM provider boundary: the provider handles RPC communication
 * and amount math (lamports → SOL, SPL raw amounts → decimal), while the
 * adapter decides direction, sign conventions, and event types.
 *
 * Why balance-delta approach instead of walking instructions?
 *   - Using meta.preBalances/postBalances for native SOL and
 *     meta.preTokenBalances/postTokenBalances for SPL tokens captures
 *     movements surfaced via inner instructions (DeFi programs like Raydium
 *     and Orca) without having to parse CPI instruction trees.
 *   - The adapter receives one RawSolanaTransfer per net asset delta for
 *     the owner address, which is the same philosophy as the EVM adapter.
 *
 * Deferred (not in this adapter):
 *   - NFT (Metaplex) classification — category 'nft' reserved for future use
 *   - DeFi / staking specific semantics — classifier handles intent
 */

import Decimal from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────
// Solana RPC response types (jsonParsed encoding)
// ─────────────────────────────────────────────────────────────────────────

/** A single entry from getSignaturesForAddress. */
export interface SolanaSignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: unknown | null;
  memo: string | null;
}

/** Token balance entry from meta.preTokenBalances / meta.postTokenBalances. */
export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;      // raw integer string (use this, not uiAmount)
    decimals: number;
    uiAmount: number | null; // lossy float — ignore
    uiAmountString: string;
  };
}

/** The parsed transaction message as returned by jsonParsed encoding. */
export interface SolanaTransactionMeta {
  err: unknown | null;
  fee: number;                     // lamports, paid by fee payer
  preBalances: number[];           // lamports per account, before tx
  postBalances: number[];          // lamports per account, after tx
  preTokenBalances: SolanaTokenBalance[];
  postTokenBalances: SolanaTokenBalance[];
}

/** Subset of a parsed Solana transaction. */
export interface SolanaTransaction {
  slot: number;
  blockTime: number | null;
  meta: SolanaTransactionMeta | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{
        pubkey: string;
        signer: boolean;
        writable: boolean;
      }>;
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Provider-agnostic intermediate shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * One asset movement as seen by the Solana provider, before the adapter
 * applies direction and sign conventions.
 *
 * The provider computes the delta (post − pre) for the owner address and
 * emits one RawSolanaTransfer per non-zero asset delta. For native SOL,
 * the fee leg is always separated and emitted as a distinct transfer with
 * `isFeeLeg: true` so the adapter can apply the correct feeFlag.
 *
 * Sign of `delta`:
 *   positive = owner received this asset
 *   negative = owner sent this asset
 */
export interface RawSolanaTransfer {
  /** Stable ID. Format: `solana:<signature>` for the main event, `solana:<sig>:fee` for fee leg. */
  providerId: string;
  /** The transaction signature (base-58). */
  signature: string;
  /** Unix timestamp seconds. */
  blockTime: number;
  /** Slot number. */
  slot: number;
  /**
   * Transfer category.
   * 'native' = SOL
   * 'spl'    = SPL token (ERC-20 equivalent)
   * 'nft'    = reserved for future Metaplex support
   */
  category: 'native' | 'spl' | 'nft';
  /**
   * Net asset delta for the owner, as a signed decimal string.
   * Positive = received, negative = sent.
   * Uses raw integer + decimals math — never the lossy uiAmount float.
   */
  delta: string;
  /** Asset symbol or mint address fallback. */
  asset: string;
  /** Mint address for SPL tokens. Undefined for native SOL. */
  mintAddress?: string;
  /** Number of decimal places for the SPL token amount. Undefined for native SOL. */
  decimals?: number;
  /**
   * True when this transfer represents the transaction fee paid by the owner.
   * Only emitted when the owner is the fee payer.
   */
  isFeeLeg: boolean;
  /** The original parsed transaction payload. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Fetch options
// ─────────────────────────────────────────────────────────────────────────

export interface FetchSolanaTransfersOpts {
  /** The wallet address (base-58 public key) to query. */
  address: string;
  /**
   * Opaque cursor: a transaction signature.
   * When provided, only signatures OLDER than this are returned
   * (getSignaturesForAddress `before` parameter).
   * Used for forward-pagination from oldest to newest.
   */
  before?: string;
  /**
   * Stop when a signature equal to this is encountered.
   * Used to implement incremental sync: pass the newest-seen signature
   * as `until` and only new transactions are fetched.
   */
  until?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────────────────

/**
 * Abstraction over Solana JSON-RPC providers.
 *
 * Implementations MUST:
 *   - Handle getSignaturesForAddress pagination (newest-first, page by
 *     `before` cursor) internally.
 *   - Fetch each transaction via getTransaction with jsonParsed encoding
 *     and maxSupportedTransactionVersion: 0.
 *   - Compute balance deltas from meta.preBalances/postBalances (native SOL)
 *     and meta.preTokenBalances/postTokenBalances (SPL tokens).
 *   - Emit one RawSolanaTransfer per non-zero asset delta for the owner.
 *   - Handle fee payer attribution (only emit fee leg when owner = fee payer).
 *   - Use Decimal arithmetic — never floating-point — for all amount math.
 */
export interface SolanaTransferProvider {
  readonly name: string;

  /**
   * Stream transfers for an address.
   * Implementations handle RPC pagination internally; the consumer iterates
   * until the stream ends.
   *
   * Results are newest-first (matching Solana RPC's natural ordering).
   */
  fetchTransfers(opts: FetchSolanaTransfersOpts): AsyncIterable<RawSolanaTransfer>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Convert lamport integer delta to a decimal SOL amount string.
 * Uses Decimal for precision-safe arithmetic.
 */
export function lamportsToSol(lamports: number): Decimal {
  return new Decimal(lamports).div(LAMPORTS_PER_SOL);
}

/**
 * Convert a raw SPL token amount (integer string) to a human-readable
 * decimal string using the token's decimal places.
 *
 * Never uses uiAmount (lossy float) — always raw integer + decimals.
 */
export function rawTokenToDecimal(rawAmount: string, decimals: number): Decimal {
  return new Decimal(rawAmount).div(new Decimal(10).pow(decimals));
}
