/**
 * Rule 02 — Self-transfer detection from Coinbase Send events.
 *
 * For coinbase `crypto_out` events, check if `event.counterparty` matches
 * any address in `context.ownAddresses` (case-insensitive).
 *
 * If match → `transfer_self`
 * If no match → `transfer_external_out`
 */

import type { LedgerEntry, RawEvent } from '@daybook/ledger';
import type {
    ClassifierContext,
    ClassifierRule,
    ClassifierRuleResult,
} from '../types.js';
import { entryId } from '../runner.js';

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const cbSelfTransfer: ClassifierRule = {
  name: '02-cb-self-transfer',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Precompute lowercased own addresses for fast lookup
    const ownSet = new Set(context.ownAddresses.map(a => a.toLowerCase()));

    // Only look at coinbase crypto_out events
    const candidates = events.filter(
      e => e.source === 'coinbase' && e.type === 'crypto_out',
    );

    for (const evt of candidates) {
      if (!evt.counterparty) continue;

      const counterpartyLower = evt.counterparty.toLowerCase();
      const isSelf = ownSet.has(counterpartyLower);

      const entry: LedgerEntry = {
        id: entryId([evt.id]),
        timestamp: evt.timestamp,
        type: isSelf ? 'transfer_self' : 'transfer_external_out',
        legs: [...evt.legs],
        rawEventIds: [evt.id],
        reason: isSelf
          ? `CB Send to own address ${evt.counterparty}`
          : `CB Send to external address ${evt.counterparty}`,
      };

      entries.push(entry);
      consumedEventIds.add(evt.id);
    }

    return { entries, consumedEventIds };
  },
};
