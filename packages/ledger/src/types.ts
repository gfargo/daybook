/**
 * Core data types for daybook.
 *
 * Two layers of events:
 *
 *   RawEvent      — what the source produced, normalized to one shape.
 *                   Append-only. Re-syncing produces the same RawEvents.
 *
 *   LedgerEntry   — what the classifier decided the events MEAN.
 *                   Rebuildable from RawEvents at any time.
 *                   Tax engine consumes these.
 *
 * The leg-list approach (RawEvent.legs, LedgerEntry.legs) handles the
 * full diversity of source shapes:
 *   - 1 leg:   income (staking reward), fiat deposit
 *   - 2 legs:  trade (one out, one in), self-transfer (one out, one in same asset)
 *   - 3+ legs: trade with explicit fee, multi-asset operations
 *
 * Decimal amounts are stored as `string` to avoid float drift.
 * Convert to `Decimal` (decimal.js) at the boundaries of math operations.
 */

import type Decimal from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────
// Source identification
// ─────────────────────────────────────────────────────────────────────────

/** All sources daybook knows about. New sources are added here. */
export type SourceId =
  | 'coinbase'
  | 'coinbase-advanced'
  | 'kraken'  // v1.1
  | 'eth'
  | 'polygon'
  // Future:
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'solana'
  | 'bitcoin';

/** Identifies a specific account belonging to the user. */
export interface AccountRef {
  /** Stable label, e.g. "main-coinbase" or "polygon-0x1296". User-defined. */
  id: string;
  /** Which source this account is on. */
  source: SourceId;
  /** For exchanges: the user's account identifier (often opaque). For chains: the address. */
  identifier: string;
  /** Optional human label for display. */
  label?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Raw events — what adapters produce
// ─────────────────────────────────────────────────────────────────────────

/**
 * The normalized type of a raw event, BEFORE the classifier runs.
 * This is what the source observably did, not what it meant.
 *
 * Adapters set the most specific type they can determine from their data.
 * The classifier may upgrade or override (e.g. classifying a `crypto_out`
 * as `internal_move` once it matches it to a self-receive on chain).
 */
export type RawEventType =
  /** Fiat (USD/EUR/etc) flowing in to an account. Usually non-taxable. */
  | 'fiat_deposit'
  /** Fiat flowing out of an account. Usually non-taxable. */
  | 'fiat_withdrawal'
  /** Crypto received. Could be self-transfer, gift, payment, airdrop — classifier decides. */
  | 'crypto_in'
  /** Crypto sent. Could be self-transfer, gift, payment, sale to peer — classifier decides. */
  | 'crypto_out'
  /** A trade — two assets exchanged. Buys, sells, conversions, DEX swaps. */
  | 'trade'
  /** Income event — staking reward, learn-and-earn, inflation, airdrop confirmed as income. */
  | 'income'
  /** Confirmed internal move (already paired by adapter, e.g. CB Retail Eth2 Deprecation). */
  | 'internal_move'
  /** Approval, failed tx, or other gas-only event. No asset movement. */
  | 'fee_only'
  /** NFT mint/transfer/sale. Stubbed for v1 — surfaced for manual classification. */
  | 'nft_event'
  /** Adapter couldn't determine type. Surface to user for manual override. */
  | 'unknown';

/**
 * One asset movement within an event.
 *
 * Sign convention: positive = received by the account, negative = sent.
 * A trade has one negative leg (asset out) and one positive leg (asset in).
 * Income has one positive leg.
 * A `fee_only` event has one negative leg with `feeFlag = true`.
 */
export interface AssetLeg {
  /** Ticker symbol ('ETH', 'USDC') OR contract address for unknown tokens. */
  asset: string;
  /** Decimal amount as string. Signed. */
  amount: string;
  /**
   * USD value at the time of the event, hydrated by the pricing layer.
   * Undefined until pricing has run; never trust it as a substitute for
   * `amountUsdReportedBySource`.
   */
  amountUsdAtTime?: string;
  /** USD value as reported by the source itself, if available (CB Subtotal, Kraken amountusd). */
  amountUsdReportedBySource?: string;
  /** True if this leg represents a fee rather than principal. */
  feeFlag?: boolean;
  /**
   * For ERC-20 / ERC-721 / ERC-1155 tokens, the contract address.
   * For native assets, undefined.
   */
  contractAddress?: string;
  /** For NFTs: the token ID. */
  tokenId?: string;
}

/**
 * Everything an adapter knows about one event after parsing its source.
 *
 * Identity is `${source}:${nativeId}`. Re-running an adapter against the
 * same source data MUST produce the same RawEvent ids — that's how
 * idempotent re-sync works.
 */
export interface RawEvent {
  /** Deterministic ID: `${source}:${nativeId}`. Required for idempotent re-sync. */
  id: string;
  /** Source that produced this event. */
  source: SourceId;
  /** Account this event belongs to (matches an AccountRef.id). */
  accountId: string;
  /** When the event occurred at the source. */
  timestamp: Date;
  /** What the adapter thinks happened, before the classifier weighs in. */
  type: RawEventType;
  /** One or more asset movements. */
  legs: AssetLeg[];
  /** On-chain only: the transaction hash. */
  txHash?: string;
  /** On-chain only: the log index within the tx (for ERC-20 transfers). */
  logIndex?: number;
  /** On-chain: counterparty address. CB: 'external account', 'Coinbase', or known label. */
  counterparty?: string;
  /** Free-form notes from the source (CB Notes column, Kraken subclass, etc). */
  notes?: string;
  /** The original payload, JSON-serialized. Kept verbatim for debugging and reclassification. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger entries — what the classifier produces
// ─────────────────────────────────────────────────────────────────────────

/**
 * The classifier's decision about what an event (or group of events) means.
 *
 * One LedgerEntry can be backed by:
 *   - One RawEvent  (the simple case — e.g. a Coinbase Buy is one row, one entry)
 *   - N RawEvents   (e.g. a Uniswap swap = 1 router call + N transfer logs collapsed
 *                    into one trade entry)
 *   - 0 RawEvents   (rare — used for manual user-injected entries)
 */
export type LedgerEntryType =
  | 'fiat_in'
  | 'fiat_out'
  /** Self-move between user's own accounts/wallets. Non-taxable. */
  | 'transfer_self'
  /** Sent to a non-self counterparty. Potentially taxable as gift/payment. */
  | 'transfer_external_out'
  /** Received from a non-self counterparty. Potentially taxable as income/gift. */
  | 'transfer_external_in'
  /** Trade — disposes one asset, acquires another. Taxable disposal. */
  | 'trade'
  /** Income — taxable as ordinary income at FMV. */
  | 'income'
  /** Gas/fee disposal (ETH spent on gas is itself a sale). */
  | 'fee_disposal'
  /** NFT-related. Stubbed for v1 — kept for backward compat with unclassified NFTs. */
  | 'nft_event'
  /** NFT acquired: purchase, mint, or airdrop. */
  | 'nft_acquisition'
  /** NFT disposed: sale or transfer out. */
  | 'nft_disposal'
  /** Classifier left this for the user to handle. */
  | 'unclassified';

export interface LedgerEntry {
  /** Stable ID computed from the backing raw events. */
  id: string;
  /** When the underlying event occurred (earliest timestamp if multiple raw events). */
  timestamp: Date;
  /** The classifier's verdict. */
  type: LedgerEntryType;
  /** The asset legs after classification (may differ from raw — gas separated, etc). */
  legs: AssetLeg[];
  /** RawEvent IDs this entry is built from. */
  rawEventIds: string[];
  /** Optional user-provided override that produced this classification. */
  overrideId?: string;
  /** Optional free-form notes from the classifier explaining the decision. */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// User overrides — first-class, never lost on re-sync
// ─────────────────────────────────────────────────────────────────────────

/** Manual user correction to the classifier's output for one or more raw events. */
export interface ClassifierOverride {
  id: string;
  /** Which raw events this override applies to. */
  rawEventIds: string[];
  /** What the user says it actually is. */
  type: LedgerEntryType;
  /** Optional explicit leg overrides (e.g. for unrecognized tokens). */
  legs?: AssetLeg[];
  /** When the override was created. */
  createdAt: Date;
  /** User's note. */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Price overrides — user-entered manual prices
// ─────────────────────────────────────────────────────────────────────────

/** A user-entered manual price override for an asset on a specific date. */
export interface PriceOverride {
  /** Deterministic ID, e.g. `${asset}:${day}`. */
  id: string;
  /** Ticker symbol (uppercase). */
  asset: string;
  /** Unix seconds at 00:00 UTC of the date. */
  day: number;
  /** USD price as a decimal string. */
  priceUsd: string;
  /** Optional user note. */
  note?: string;
  /** When the override was created (Date). */
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** A `Decimal` instance is the right type for amount math. We just store as string. */
export type DecimalLike = Decimal | string | number;
