/**
 * Rule 03 — Cross-source self-transfer matching.
 *
 * Matches `crypto_out` from one source with `crypto_in` from another source.
 *
 * Criteria:
 *   - Same asset
 *   - Timestamps within ±10 minutes (600 seconds)
 *   - Amounts within ±0.5%
 *   - Different sources
 *
 * Produces `transfer_self` LedgerEntry with both event IDs.
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
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** Maximum time difference in seconds for a cross-source match. */
const TIME_TOLERANCE_SECONDS = 600;

/** Maximum relative amount difference (0.5%). */
const AMOUNT_TOLERANCE = 0.005;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function primaryAsset(evt: RawEvent): string | undefined {
  const leg = evt.legs.find(l => !l.feeFlag);
  return leg?.asset;
}

function primaryAmount(evt: RawEvent): Decimal | undefined {
  const leg = evt.legs.find(l => !l.feeFlag);
  return leg ? new Decimal(leg.amount).abs() : undefined;
}

function withinTimeTolerance(a: Date, b: Date, toleranceSec: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= toleranceSec * 1000;
}

function withinAmountTolerance(
  amtA: Decimal,
  amtB: Decimal,
  tolerance: number,
): boolean {
  if (amtA.isZero() && amtB.isZero()) return true;
  const max = Decimal.max(amtA, amtB);
  if (max.isZero()) return true;
  const diff = amtA.minus(amtB).abs();
  return diff.dividedBy(max).lte(tolerance);
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const crossSourceMatch: ClassifierRule = {
  name: '03-cross-source-match',

  apply(
    events: ReadonlyArray<RawEvent>,
    _context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    const outs = events.filter(e => e.type === 'crypto_out');
    const ins = events.filter(e => e.type === 'crypto_in');

    for (const out of outs) {
      if (consumedEventIds.has(out.id)) continue;

      const outAsset = primaryAsset(out);
      const outAmount = primaryAmount(out);
      if (!outAsset || !outAmount) continue;

      const match = ins.find(inEvt => {
        if (consumedEventIds.has(inEvt.id)) return false;
        if (inEvt.source === out.source) return false;

        const inAsset = primaryAsset(inEvt);
        const inAmount = primaryAmount(inEvt);
        if (!inAsset || !inAmount) return false;

        return (
          inAsset === outAsset &&
          withinTimeTolerance(
            out.timestamp,
            inEvt.timestamp,
            TIME_TOLERANCE_SECONDS,
          ) &&
          withinAmountTolerance(outAmount, inAmount, AMOUNT_TOLERANCE)
        );
      });

      if (match) {
        const ids = [out.id, match.id];
        const earliest =
          out.timestamp < match.timestamp ? out.timestamp : match.timestamp;

        const entry: LedgerEntry = {
          id: entryId(ids),
          timestamp: earliest,
          type: 'transfer_self',
          legs: [...out.legs, ...match.legs],
          rawEventIds: ids,
          reason: `Cross-source match: ${out.source} → ${match.source}, ${outAsset}`,
        };

        entries.push(entry);
        consumedEventIds.add(out.id);
        consumedEventIds.add(match.id);
      }
    }

    return { entries, consumedEventIds };
  },
};
