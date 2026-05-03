/**
 * Rule 01 — Coinbase pair merger.
 *
 * Safety net for Retail Staking Transfer / Retail Eth2 Deprecation pairs
 * that were not already merged by the Coinbase CSV adapter's pair-merger pass.
 *
 * Groups coinbase `internal_move` events by (timestamp, abs(amount of first leg))
 * and merges pairs into one `transfer_self` LedgerEntry with both legs.
 */

import Decimal from 'decimal.js';
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

export const cbPairMerger: ClassifierRule = {
  name: '01-cb-pair-merger',

  apply(
    events: ReadonlyArray<RawEvent>,
    _context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Only look at coinbase internal_move events
    const candidates = events.filter(
      e => e.source === 'coinbase' && e.type === 'internal_move',
    );

    // Group by (timestamp in seconds, abs(amount of first leg))
    const groups = new Map<string, RawEvent[]>();
    for (const evt of candidates) {
      const firstLeg = evt.legs[0];
      if (!firstLeg) continue;
      const ts = Math.floor(evt.timestamp.getTime() / 1000);
      const absAmt = new Decimal(firstLeg.amount).abs().toString();
      const key = `${ts}|${absAmt}`;
      const group = groups.get(key);
      if (group) {
        group.push(evt);
      } else {
        groups.set(key, [evt]);
      }
    }

    // Merge pairs
    for (const group of groups.values()) {
      if (group.length !== 2) continue;

      const [a, b] = group as [RawEvent, RawEvent];
      const ids = [a.id, b.id];
      const earliest = a.timestamp < b.timestamp ? a.timestamp : b.timestamp;

      const entry: LedgerEntry = {
        id: entryId(ids),
        timestamp: earliest,
        type: 'transfer_self',
        legs: [...a.legs, ...b.legs],
        rawEventIds: ids,
        reason: 'CB pair merger: matched internal_move pair by timestamp + amount',
      };

      entries.push(entry);
      consumedEventIds.add(a.id);
      consumedEventIds.add(b.id);
    }

    return { entries, consumedEventIds };
  },
};
