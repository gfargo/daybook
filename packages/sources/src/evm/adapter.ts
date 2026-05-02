/**
 * Chain-agnostic EVM adapter.
 *
 * Translates `RawTransfer` (provider-agnostic intermediate) into daybook's
 * `RawEvent` shape. Handles:
 *
 *   - Direction assignment: `to = user` → positive, `from = user` → negative
 *   - NFT placeholders: erc721/erc1155 → `nft_event` with amount ±1
 *   - Deduplication: bidirectional queries can overlap for self-transfers
 *   - Deterministic IDs: `${source}:${providerId}`
 *
 * The adapter never guesses intent. Every fungible transfer becomes `crypto_in`
 * or `crypto_out`. The classifier (Phase 1F) upgrades these later:
 *   - `crypto_out` to a DEX router → part of a `trade`
 *   - `crypto_out` to user's own address → `transfer_self`
 *   - `crypto_in` from a bridge contract → part of a cross-chain move
 */

import type { AssetLeg, RawEvent, SourceId } from '@daybook/ledger';
import type { ChainId, EvmTransferProvider, RawTransfer } from './provider.js';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/** Options for the EVM adapter. */
export interface EvmAdapterOptions {
  /** The provider to fetch transfers from. */
  provider: EvmTransferProvider;
  /** Wallet address to query. Lowercased internally for comparison. */
  address: string;
  /** Chain to query. */
  chainId: ChainId;
  /** daybook account ID this maps to. */
  accountId: string;
  /** daybook source ID ('eth', 'polygon', ...). */
  source: SourceId;
}

/** Per-category transfer counts plus dedup stats. */
export interface EvmIngestStats {
  native: number;
  internal: number;
  erc20: number;
  erc721: number;
  erc1155: number;
  deduped: number;
}

/** Result of an EVM ingestion run. */
export interface EvmIngestResult {
  /** Translated RawEvents ready for repo.insertRawEvents(). */
  events: RawEvent[];
  /** Per-category counts and dedup stats. */
  stats: EvmIngestStats;
}

/**
 * Ingest all transfers for a wallet via the given provider, translate to
 * RawEvents, and deduplicate.
 *
 * This is the main entry point for EVM data ingestion. The returned events
 * are ready to be passed to `repo.insertRawEvents()`.
 */
export async function ingestEvm(opts: EvmAdapterOptions): Promise<EvmIngestResult> {
  const userAddr = opts.address.toLowerCase();
  const seen = new Set<string>();
  const events: RawEvent[] = [];
  const stats: EvmIngestStats = {
    native: 0,
    internal: 0,
    erc20: 0,
    erc721: 0,
    erc1155: 0,
    deduped: 0,
  };

  for await (const transfer of opts.provider.fetchTransfers({
    address: opts.address,
    chainId: opts.chainId,
  })) {
    // Dedupe — bidirectional queries overlap for self-transfers.
    if (seen.has(transfer.providerId)) {
      stats.deduped++;
      continue;
    }
    seen.add(transfer.providerId);

    const event = translate(transfer, userAddr, opts);
    if (!event) continue;

    events.push(event);
    incrementStat(stats, transfer.category);
  }

  return { events, stats };
}

// ─────────────────────────────────────────────────────────────────────────
// Translation logic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Translate a single RawTransfer into a RawEvent.
 *
 * Returns `null` if the transfer doesn't involve the user's address
 * (shouldn't happen since we queried by address, but guard anyway).
 */
function translate(
  t: RawTransfer,
  userAddrLower: string,
  opts: EvmAdapterOptions,
): RawEvent | null {
  const fromIsUser = t.from.toLowerCase() === userAddrLower;
  const toIsUser = (t.to ?? '').toLowerCase() === userAddrLower;

  // Should be impossible since we queried by address, but guard anyway.
  if (!fromIsUser && !toIsUser) return null;

  // Direction: positive = received, negative = sent.
  const sign = toIsUser ? '' : '-';
  const counterparty = toIsUser ? t.from : t.to;

  const id = `${opts.source}:${t.providerId}`;

  // ─── NFT branch ────────────────────────────────────────────────────
  // ERC-721/1155 → `nft_event` placeholder. Tax engine ignores in v1.
  if (t.category === 'erc721' || t.category === 'erc1155') {
    const leg: AssetLeg = {
      asset: t.asset ?? t.contractAddress ?? 'NFT',
      amount: sign + '1',
      ...(t.contractAddress ? { contractAddress: t.contractAddress } : {}),
      ...(t.tokenId ? { tokenId: t.tokenId } : {}),
    };
    return {
      id,
      source: opts.source,
      accountId: opts.accountId,
      timestamp: t.timestamp,
      type: 'nft_event',
      legs: [leg],
      txHash: t.txHash,
      ...(counterparty ? { counterparty } : {}),
      raw: t.raw,
    };
  }

  // ─── Unknown branch ────────────────────────────────────────────────
  // Genuinely amountless event (failed enrichment). Surface as unknown.
  if (!t.amount) {
    return {
      id,
      source: opts.source,
      accountId: opts.accountId,
      timestamp: t.timestamp,
      type: 'unknown',
      legs: [{ asset: t.asset ?? t.contractAddress ?? 'UNKNOWN', amount: '0' }],
      txHash: t.txHash,
      ...(counterparty ? { counterparty } : {}),
      raw: t.raw,
    };
  }

  // ─── Fungible branch ──────────────────────────────────────────────
  // Native ETH/MATIC, internal, ERC-20.
  const leg: AssetLeg = {
    asset: t.asset ?? t.contractAddress ?? 'UNKNOWN',
    amount: sign + t.amount,
    ...(t.contractAddress ? { contractAddress: t.contractAddress } : {}),
  };

  return {
    id,
    source: opts.source,
    accountId: opts.accountId,
    timestamp: t.timestamp,
    type: toIsUser ? 'crypto_in' : 'crypto_out',
    legs: [leg],
    txHash: t.txHash,
    ...(counterparty ? { counterparty } : {}),
    raw: t.raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Increment the appropriate category counter. */
function incrementStat(
  stats: EvmIngestStats,
  category: RawTransfer['category'],
): void {
  switch (category) {
    case 'native':
      stats.native++;
      break;
    case 'internal':
      stats.internal++;
      break;
    case 'erc20':
      stats.erc20++;
      break;
    case 'erc721':
      stats.erc721++;
      break;
    case 'erc1155':
      stats.erc1155++;
      break;
  }
}
