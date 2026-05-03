/**
 * Rule 05 — Bridge detection.
 *
 * Matches outbound transfers to bridge catalog addresses. Looks for a
 * corresponding inbound within 24h on a different chain (different source).
 *
 * If found → `transfer_self` with both event IDs.
 * If not found → leave for later rules (don't consume).
 */

import type { LedgerEntry, RawEvent } from '@daybook/ledger';
import type {
    ClassifierContext,
    ClassifierRule,
    ClassifierRuleResult,
} from '../types.js';
import { entryId } from '../runner.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Maximum time window for bridge matching: 24 hours in milliseconds. */
const BRIDGE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function primaryAsset(evt: RawEvent): string | undefined {
  const leg = evt.legs.find(l => !l.feeFlag);
  return leg?.asset;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const bridgeDetection: ClassifierRule = {
  name: '05-bridge-detection',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Find outbound events to bridge addresses
    const outbounds = events.filter(evt => {
      if (evt.type !== 'crypto_out') return false;
      if (!evt.counterparty) return false;
      return context.bridges.has(evt.counterparty.toLowerCase());
    });

    // Find inbound events (potential bridge receives)
    const inbounds = events.filter(e => e.type === 'crypto_in');

    for (const out of outbounds) {
      if (consumedEventIds.has(out.id)) continue;

      const outAsset = primaryAsset(out);
      if (!outAsset) continue;

      // Look for a matching inbound on a different source within 24h
      const match = inbounds.find(inEvt => {
        if (consumedEventIds.has(inEvt.id)) return false;
        if (inEvt.source === out.source) return false;

        const inAsset = primaryAsset(inEvt);
        if (!inAsset) return false;

        // Assets should be the same (or equivalent — e.g. ETH on both chains)
        if (inAsset !== outAsset) return false;

        // Inbound should be after outbound, within 24h
        const timeDiff = inEvt.timestamp.getTime() - out.timestamp.getTime();
        return timeDiff >= 0 && timeDiff <= BRIDGE_WINDOW_MS;
      });

      if (match) {
        const ids = [out.id, match.id];
        const bridge = context.bridges.get(out.counterparty!.toLowerCase());
        const bridgeLabel = bridge
          ? `${bridge.protocol} ${bridge.version}`
          : 'unknown bridge';

        const entry: LedgerEntry = {
          id: entryId(ids),
          timestamp: out.timestamp,
          type: 'transfer_self',
          legs: [...out.legs, ...match.legs],
          rawEventIds: ids,
          reason: `Bridge via ${bridgeLabel}: ${out.source} → ${match.source}`,
        };

        entries.push(entry);
        consumedEventIds.add(out.id);
        consumedEventIds.add(match.id);
      }
      // If no match found, leave for later rules (don't consume)
    }

    return { entries, consumedEventIds };
  },
};
