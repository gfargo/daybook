/**
 * Rule 06 — Approval gas accounting.
 *
 * Events with type `crypto_out`, zero principal amount (every non-fee leg
 * carries amount === 0), and a counterparty produce `fee_disposal` with
 * every leg marked feeFlag.
 *
 * Also catches `fee_only` events from the EVM adapter.
 *
 * Note: the previous absolute-magnitude heuristic (NEGLIGIBLE_THRESHOLD ≤ 1e-7)
 * was asset-blind — it misclassified real small-value transfers of 6-decimal
 * stablecoins (e.g. -0.00000005 USDC) as fee_disposal.  Exact zero is the
 * only portable signal that is unambiguous across token decimal precisions.
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
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const approvalGas: ClassifierRule = {
  name: '06-approval-gas',

  apply(
    events: ReadonlyArray<RawEvent>,
    _context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    for (const evt of events) {
      // Match fee_only events directly
      if (evt.type === 'fee_only') {
        const legs: AssetLeg[] = evt.legs.map(l => ({
          ...l,
          feeFlag: true,
        }));

        entries.push({
          id: entryId([evt.id]),
          timestamp: evt.timestamp,
          type: 'fee_disposal',
          legs,
          rawEventIds: [evt.id],
          reason: 'Gas-only event (approval or failed tx)',
        });
        consumedEventIds.add(evt.id);
        continue;
      }

      // Match crypto_out with zero principal amount to a counterparty
      if (evt.type !== 'crypto_out') continue;
      if (!evt.counterparty) continue;

      // Require at least one principal leg (guard against vacuous [].every())
      const principalLegs = evt.legs.filter(l => !l.feeFlag);
      if (principalLegs.length === 0) continue;

      // All principal legs must carry exactly zero (asset-agnostic: 0 is 0
      // regardless of token decimal precision)
      const allZero = principalLegs.every(l =>
        new Decimal(l.amount).isZero(),
      );
      if (!allZero) continue;

      // This is a zero-value transfer — treat as approval gas
      const legs: AssetLeg[] = evt.legs.map(l => ({
        ...l,
        feeFlag: true,
      }));

      entries.push({
        id: entryId([evt.id]),
        timestamp: evt.timestamp,
        type: 'fee_disposal',
        legs,
        rawEventIds: [evt.id],
        reason: `Approval gas to ${evt.counterparty}`,
      });
      consumedEventIds.add(evt.id);
    }

    return { entries, consumedEventIds };
  },
};
