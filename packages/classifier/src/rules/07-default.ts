/**
 * Rule 07 — Default passthrough.
 *
 * Catch-all rule that maps remaining events directly:
 *
 *   trade           → trade
 *   income          → income
 *   fiat_deposit    → fiat_in
 *   fiat_withdrawal → fiat_out
 *   nft_event       → nft_event
 *   internal_move   → transfer_self
 *   crypto_in       → transfer_external_in
 *   crypto_out      → transfer_external_out
 *   everything else → unclassified
 *
 * Each event produces exactly one LedgerEntry.
 */

import type { LedgerEntry, LedgerEntryType, RawEvent, RawEventType } from '@daybook/ledger';
import type {
    ClassifierContext,
    ClassifierRule,
    ClassifierRuleResult,
} from '../types.js';
import { entryId } from '../runner.js';

// ─────────────────────────────────────────────────────────────────────────
// Type mapping
// ─────────────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<RawEventType, LedgerEntryType> = {
  trade: 'trade',
  income: 'income',
  fiat_deposit: 'fiat_in',
  fiat_withdrawal: 'fiat_out',
  nft_event: 'nft_event',
  internal_move: 'transfer_self',
  crypto_in: 'transfer_external_in',
  crypto_out: 'transfer_external_out',
  fee_only: 'fee_disposal',
  unknown: 'unclassified',
};

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const defaultPassthrough: ClassifierRule = {
  name: '07-default',

  apply(
    events: ReadonlyArray<RawEvent>,
    _context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    for (const evt of events) {
      const mappedType = TYPE_MAP[evt.type] ?? 'unclassified';

      const entry: LedgerEntry = {
        id: entryId([evt.id]),
        timestamp: evt.timestamp,
        type: mappedType,
        legs: [...evt.legs],
        rawEventIds: [evt.id],
        reason: `Default passthrough: ${evt.type} → ${mappedType}`,
      };

      entries.push(entry);
      consumedEventIds.add(evt.id);
    }

    return { entries, consumedEventIds };
  },
};
