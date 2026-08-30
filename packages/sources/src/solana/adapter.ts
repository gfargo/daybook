/**
 * Chain-agnostic Solana adapter.
 *
 * Translates `RawSolanaTransfer` (provider-agnostic intermediate) into
 * daybook's `RawEvent` shape. Handles:
 *
 *   - Direction assignment: positive delta → `crypto_in`, negative → `crypto_out`
 *   - Fee legs: isFeeLeg → feeFlag on the AssetLeg
 *   - Deterministic IDs: `solana:<providerId-suffix>` using the provider's ID
 *   - Deduplication: same providerId seen twice is counted and skipped
 *
 * The adapter never guesses intent. Every SOL / SPL transfer becomes
 * `crypto_in` or `crypto_out`. The classifier upgrades these later:
 *   - Matching `crypto_out` + `crypto_in` in the same tx → `trade`
 *   - `crypto_out` to own address → `transfer_self`
 *   - `crypto_in` from staking program → `income`
 *
 * Asset naming for SPL tokens:
 *   - The `asset` field from the provider is the mint address.
 *   - Well-known mints (USDC, USDT, etc.) can be resolved by the pricing
 *     layer; unknown mints fall back to displaying the mint address.
 *
 * Fee leg attribution:
 *   - Only the fee payer (tx signer at index 0) pays the SOL fee.
 *   - The provider emits a separate isFeeLeg=true transfer for this.
 *   - The adapter maps it to an AssetLeg with feeFlag=true and type
 *     `fee_only` to keep the fee separated from the principal movement.
 */

import type { AssetLeg, RawEvent } from '@daybook/ledger';
import type { RawSolanaTransfer, SolanaTransferProvider } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/** Options for the Solana adapter. */
export interface SolanaAdapterOptions {
  /** The provider to fetch transfers from. */
  provider: SolanaTransferProvider;
  /** Wallet address (base-58 public key) to query. */
  address: string;
  /** daybook account ID this maps to. */
  accountId: string;
  /**
   * Opaque cursor from a previous run (a transaction signature).
   * When provided, only transactions newer than this signature are fetched.
   */
  sinceSignature?: string;
}

/** Counts and dedup stats from a Solana ingestion run. */
export interface SolanaIngestStats {
  native: number;
  spl: number;
  fee: number;
  deduped: number;
}

/** Result of a Solana ingestion run. */
export interface SolanaIngestResult {
  /** Translated RawEvents ready for repo.insertRawEvents(). */
  events: RawEvent[];
  /** Per-category counts and dedup stats. */
  stats: SolanaIngestStats;
  /**
   * The newest transaction signature seen in this run.
   * Persist this as the cursor for the next incremental sync.
   * Undefined if no events were fetched.
   */
  newestSignature: string | undefined;
}

/**
 * Ingest all transfers for a Solana wallet, translate to RawEvents,
 * and deduplicate.
 *
 * This is the main entry point for Solana data ingestion. The returned
 * events are ready to be passed to `repo.insertRawEvents()`.
 */
export async function ingestSolana(
  opts: SolanaAdapterOptions,
): Promise<SolanaIngestResult> {
  const seen = new Set<string>();
  const events: RawEvent[] = [];
  const stats: SolanaIngestStats = {
    native: 0,
    spl: 0,
    fee: 0,
    deduped: 0,
  };

  let newestSignature: string | undefined;

  for await (const transfer of opts.provider.fetchTransfers({
    address: opts.address,
    ...(opts.sinceSignature ? { until: opts.sinceSignature } : {}),
  })) {
    // Track the newest signature we've seen (first result = newest, since
    // Solana RPC returns newest-first).
    if (newestSignature === undefined) {
      newestSignature = transfer.signature;
    }

    // Deduplicate by providerId.
    if (seen.has(transfer.providerId)) {
      stats.deduped++;
      continue;
    }
    seen.add(transfer.providerId);

    const event = translate(transfer, opts);
    if (!event) continue;

    events.push(event);
    incrementStat(stats, transfer);
  }

  return { events, stats, newestSignature };
}

// ─────────────────────────────────────────────────────────────────────────
// Translation logic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Translate a single RawSolanaTransfer into a RawEvent.
 */
function translate(
  t: RawSolanaTransfer,
  opts: SolanaAdapterOptions,
): RawEvent | null {
  const id = `solana:${t.providerId}`;
  const timestamp = new Date(t.blockTime * 1000);
  const delta = parseFloat(t.delta);

  // ─── Fee leg ──────────────────────────────────────────────────────
  if (t.isFeeLeg) {
    const leg: AssetLeg = {
      asset: t.asset,
      amount: t.delta, // always negative (fee is a cost)
      feeFlag: true,
    };
    return {
      id,
      source: 'solana',
      accountId: opts.accountId,
      timestamp,
      type: 'fee_only',
      legs: [leg],
      txHash: t.signature,
      raw: t.raw,
    };
  }

  // ─── Zero delta ───────────────────────────────────────────────────
  // Shouldn't happen (provider should filter), but guard.
  if (delta === 0) return null;

  // ─── SPL / native transfer ────────────────────────────────────────
  const isReceived = delta > 0;

  const leg: AssetLeg = {
    asset: t.asset,
    amount: t.delta,
    ...(t.mintAddress ? { contractAddress: t.mintAddress } : {}),
  };

  return {
    id,
    source: 'solana',
    accountId: opts.accountId,
    timestamp,
    type: isReceived ? 'crypto_in' : 'crypto_out',
    legs: [leg],
    txHash: t.signature,
    raw: t.raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Increment the appropriate category counter. */
function incrementStat(
  stats: SolanaIngestStats,
  transfer: RawSolanaTransfer,
): void {
  if (transfer.isFeeLeg) {
    stats.fee++;
  } else if (transfer.category === 'native') {
    stats.native++;
  } else if (transfer.category === 'spl') {
    stats.spl++;
  }
}
