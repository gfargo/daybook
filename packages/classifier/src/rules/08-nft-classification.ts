/**
 * Rule 08 — NFT classification.
 *
 * Detects NFT acquisition and disposal patterns by grouping `nft_event`
 * raw events by `txHash` and pairing them with fungible counterpart legs
 * (`crypto_in`, `crypto_out`) in the same transaction.
 *
 * Classification logic:
 *
 *   NFT in + fungible out  → nft_acquisition (purchase or mint)
 *   NFT in alone           → nft_acquisition (airdrop)
 *   NFT out + fungible in  → nft_disposal (sale)
 *   NFT out alone          → nft_disposal (transfer_out)
 *   NFT in + NFT out       → nft_disposal + nft_acquisition (NFT-for-NFT trade)
 *
 * Mint detection: NFT counterparty is the null address (0x000…000).
 *
 * Consumes both NFT events and their paired fungible events so later
 * rules (default passthrough) do not double-count them.
 */

import Decimal from 'decimal.js';
import type { AssetLeg, LedgerEntry, RawEvent } from '@daybook/ledger';
import type {
    ClassifierContext,
    ClassifierRule,
    ClassifierRuleResult,
} from '../types.js';
import { entryId } from '../runner.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** The Ethereum null address — mints come from here. */
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Check whether an NFT event represents an incoming transfer (positive amount). */
function isNftIn(evt: RawEvent): boolean {
  const leg = evt.legs.find(l => l.contractAddress || l.tokenId);
  if (!leg) return new Decimal(evt.legs[0]?.amount ?? '0').gt(0);
  return new Decimal(leg.amount).gt(0);
}

/** Check whether an NFT event represents an outgoing transfer (negative amount). */
function isNftOut(evt: RawEvent): boolean {
  const leg = evt.legs.find(l => l.contractAddress || l.tokenId);
  if (!leg) return new Decimal(evt.legs[0]?.amount ?? '0').lt(0);
  return new Decimal(leg.amount).lt(0);
}

/** Check if the NFT was minted (counterparty is the null address). */
function isMint(evt: RawEvent): boolean {
  return evt.counterparty?.toLowerCase() === NULL_ADDRESS;
}

/** Build an NFT leg for a LedgerEntry, preserving metadata. */
function buildNftLeg(evt: RawEvent, amount: string): AssetLeg {
  const sourceLeg = evt.legs.find(l => l.contractAddress || l.tokenId) ?? evt.legs[0];
  return {
    asset: sourceLeg?.asset ?? 'NFT',
    amount,
    ...(sourceLeg?.contractAddress ? { contractAddress: sourceLeg.contractAddress } : {}),
    ...(sourceLeg?.tokenId ? { tokenId: sourceLeg.tokenId } : {}),
    ...(sourceLeg?.amountUsdAtTime ? { amountUsdAtTime: sourceLeg.amountUsdAtTime } : {}),
    ...(sourceLeg?.amountUsdReportedBySource ? { amountUsdReportedBySource: sourceLeg.amountUsdReportedBySource } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * NFT classification rule.
 *
 * Groups `nft_event` raw events by `txHash`, pairs them with fungible
 * counterpart events in the same transaction, and produces typed
 * `nft_acquisition` or `nft_disposal` ledger entries.
 */
export const nftClassification: ClassifierRule = {
  name: '08-nft-classification',

  apply(
    events: ReadonlyArray<RawEvent>,
    _context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Separate NFT events from fungible events
    const nftEvents = events.filter(e => e.type === 'nft_event');
    const fungibleEvents = events.filter(
      e => e.type === 'crypto_in' || e.type === 'crypto_out',
    );

    // Group NFT events by txHash
    const nftByTxHash = new Map<string, RawEvent[]>();
    const nftWithoutTxHash: RawEvent[] = [];

    for (const evt of nftEvents) {
      if (!evt.txHash) {
        nftWithoutTxHash.push(evt);
        continue;
      }
      const group = nftByTxHash.get(evt.txHash);
      if (group) {
        group.push(evt);
      } else {
        nftByTxHash.set(evt.txHash, [evt]);
      }
    }

    // Index fungible events by txHash for quick lookup
    const fungibleByTxHash = new Map<string, RawEvent[]>();
    for (const evt of fungibleEvents) {
      if (!evt.txHash) continue;
      const group = fungibleByTxHash.get(evt.txHash);
      if (group) {
        group.push(evt);
      } else {
        fungibleByTxHash.set(evt.txHash, [evt]);
      }
    }

    // Process each txHash group
    for (const [txHash, nftGroup] of nftByTxHash) {
      const fungibleGroup = (fungibleByTxHash.get(txHash) ?? []).filter(
        e => !consumedEventIds.has(e.id),
      );

      const nftIns = nftGroup.filter(isNftIn);
      const nftOuts = nftGroup.filter(isNftOut);

      // Find fungible counterparts
      const fungibleIns = fungibleGroup.filter(e => e.type === 'crypto_in');
      const fungibleOuts = fungibleGroup.filter(e => e.type === 'crypto_out');

      // ── NFT-for-NFT trade: NFT in + NFT out in same tx ──────────────
      if (nftIns.length > 0 && nftOuts.length > 0) {
        // Produce disposal for each outgoing NFT
        for (const nftOut of nftOuts) {
          const rawIds = [nftOut.id];
          const nftLeg = buildNftLeg(nftOut, '-1');

          const entry: LedgerEntry = {
            id: entryId(rawIds),
            timestamp: nftOut.timestamp,
            type: 'nft_disposal',
            legs: [nftLeg],
            rawEventIds: rawIds,
            reason: 'NFT sale',
          };

          entries.push(entry);
          consumedEventIds.add(nftOut.id);
        }

        // Produce acquisition for each incoming NFT
        for (const nftIn of nftIns) {
          const rawIds = [nftIn.id];
          const nftLeg = buildNftLeg(nftIn, '1');

          const entry: LedgerEntry = {
            id: entryId(rawIds),
            timestamp: nftIn.timestamp,
            type: 'nft_acquisition',
            legs: [nftLeg],
            rawEventIds: rawIds,
            reason: 'NFT purchase',
          };

          entries.push(entry);
          consumedEventIds.add(nftIn.id);
        }

        // Consume any fungible events in the same tx
        for (const f of [...fungibleIns, ...fungibleOuts]) {
          consumedEventIds.add(f.id);
        }

        continue;
      }

      // ── NFT acquisitions (NFT in) ──────────────────────────────────
      for (const nftIn of nftIns) {
        const rawIds = [nftIn.id];
        const legs: AssetLeg[] = [buildNftLeg(nftIn, '1')];
        let reason: string;

        if (fungibleOuts.length > 0) {
          // Purchase or mint — has a fungible payment
          const payment = fungibleOuts[0]!;
          rawIds.push(payment.id);
          legs.push(...payment.legs);
          consumedEventIds.add(payment.id);

          reason = isMint(nftIn) ? 'NFT mint' : 'NFT purchase';
        } else {
          // Airdrop — no fungible outflow
          reason = isMint(nftIn) ? 'NFT mint' : 'NFT airdrop';
        }

        const entry: LedgerEntry = {
          id: entryId(rawIds),
          timestamp: nftIn.timestamp,
          type: 'nft_acquisition',
          legs,
          rawEventIds: rawIds,
          reason,
        };

        entries.push(entry);
        consumedEventIds.add(nftIn.id);
      }

      // ── NFT disposals (NFT out) ────────────────────────────────────
      for (const nftOut of nftOuts) {
        const rawIds = [nftOut.id];
        const legs: AssetLeg[] = [buildNftLeg(nftOut, '-1')];
        let reason: string;

        if (fungibleIns.length > 0) {
          // Sale — has fungible proceeds
          const proceeds = fungibleIns[0]!;
          rawIds.push(proceeds.id);
          legs.push(...proceeds.legs);
          consumedEventIds.add(proceeds.id);

          reason = 'NFT sale';
        } else {
          // Transfer out — no fungible inflow
          reason = 'NFT transfer out';
        }

        const entry: LedgerEntry = {
          id: entryId(rawIds),
          timestamp: nftOut.timestamp,
          type: 'nft_disposal',
          legs,
          rawEventIds: rawIds,
          reason,
        };

        entries.push(entry);
        consumedEventIds.add(nftOut.id);
      }
    }

    // NFT events without txHash fall through to default passthrough
    // (not consumed by this rule)

    return { entries, consumedEventIds };
  },
};
