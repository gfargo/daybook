/**
 * Rule 06 — Approval gas accounting.
 *
 * Events with type `crypto_out`, zero/negligible principal amount, and a
 * counterparty that is a contract address produce `fee_disposal` with one
 * negative ETH leg marked feeFlag.
 *
 * Also catches `fee_only` events from the EVM adapter.
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

/** Threshold below which an amount is considered negligible (gas-only). */
const NEGLIGIBLE_THRESHOLD = new Decimal('0.0000001');

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

      // Match crypto_out with negligible principal amount
      if (evt.type !== 'crypto_out') continue;
      if (!evt.counterparty) continue;

      // Check if all non-fee legs have negligible amounts
      const principalLegs = evt.legs.filter(l => !l.feeFlag);
      const allNegligible = principalLegs.every(l =>
        new Decimal(l.amount).abs().lte(NEGLIGIBLE_THRESHOLD),
      );

      if (!allNegligible) continue;

      // This looks like a gas-only event (approval, etc.)
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
