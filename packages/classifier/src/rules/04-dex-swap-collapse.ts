/**
 * Rule 04 — DEX swap collapse.
 *
 * Groups on-chain events by txHash. If any event's counterparty matches
 * a DEX router address from the catalog, collapse all events in that tx
 * into one `trade` LedgerEntry.
 *
 * The trade has:
 *   - Positive legs (assets received)
 *   - Negative legs (assets sent)
 *   - Fee legs separated (gas)
 */

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

export const dexSwapCollapse: ClassifierRule = {
  name: '04-dex-swap-collapse',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Group on-chain events by txHash
    const byTxHash = new Map<string, RawEvent[]>();
    for (const evt of events) {
      if (!evt.txHash) continue;
      const group = byTxHash.get(evt.txHash);
      if (group) {
        group.push(evt);
      } else {
        byTxHash.set(evt.txHash, [evt]);
      }
    }

    for (const [txHash, group] of byTxHash) {
      // Check if any event's counterparty matches a DEX router
      const hasDexRouter = group.some(evt => {
        if (!evt.counterparty) return false;
        return context.dexRouters.has(evt.counterparty.toLowerCase());
      });

      if (!hasDexRouter) continue;
      if (group.length < 2) continue;

      const ids = group.map(e => e.id);
      const earliest = group.reduce(
        (min, e) => (e.timestamp < min ? e.timestamp : min),
        group[0]!.timestamp,
      );

      // Collect all legs, separating fee legs from principal legs
      const principalLegs: AssetLeg[] = [];
      const feeLegs: AssetLeg[] = [];

      for (const evt of group) {
        for (const leg of evt.legs) {
          if (leg.feeFlag) {
            feeLegs.push({ ...leg });
          } else {
            principalLegs.push({ ...leg });
          }
        }
      }

      // Find the DEX router protocol for the reason string
      const routerEvt = group.find(
        e => e.counterparty && context.dexRouters.has(e.counterparty.toLowerCase()),
      );
      const router = routerEvt?.counterparty
        ? context.dexRouters.get(routerEvt.counterparty.toLowerCase())
        : undefined;
      const routerLabel = router
        ? `${router.protocol} ${router.version}`
        : 'unknown DEX';

      const entry: LedgerEntry = {
        id: entryId(ids),
        timestamp: earliest,
        type: 'trade',
        legs: [...principalLegs, ...feeLegs],
        rawEventIds: ids,
        reason: `DEX swap via ${routerLabel} (tx ${txHash.slice(0, 10)}…)`,
      };

      entries.push(entry);
      for (const eid of ids) consumedEventIds.add(eid);
    }

    return { entries, consumedEventIds };
  },
};
