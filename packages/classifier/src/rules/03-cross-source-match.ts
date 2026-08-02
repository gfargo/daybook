/**
 * Rule 03 — Cross-source self-transfer matching.
 *
 * Matches `crypto_out` from one source with `crypto_in` from another source.
 *
 * Criteria:
 *   - Same asset
 *   - Timestamps within the configured window (default ±30 minutes)
 *   - Amounts within the configured tolerance after subtracting same-asset fee legs
 *     from the out event (default ±1%)
 *   - Different sources
 *
 * Pairing is deterministic regardless of input order:
 *   - Events are sorted by (timestamp, id) before processing.
 *   - For each out, the eligible in with the minimum |Δt| is chosen.
 *   - Ties in Δt are broken by ascending event ID (lexicographic).
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
// Default constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * Default maximum time difference in seconds for a cross-source match.
 * 1800 s = 30 minutes, accommodating slow chains and exchange confirmation delays.
 */
const DEFAULT_TIME_TOLERANCE_SECONDS = 1800;

/**
 * Default maximum relative amount difference (1%).
 * Wider than the original 0.5% to accommodate typical withdrawal fees.
 */
const DEFAULT_AMOUNT_TOLERANCE = 0.01;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function primaryAsset(evt: RawEvent): string | undefined {
  const leg = evt.legs.find(l => !l.feeFlag);
  return leg?.asset;
}

/**
 * Net principal amount for an out event.
 *
 * Takes the absolute value of the primary (non-fee) leg, then subtracts the
 * sum of all fee legs whose asset matches the principal asset. This lets a
 * 0.01 BTC send with a 0.0005 BTC fee leg match a 0.0095 BTC receive.
 *
 * Gas paid in a different asset (e.g. ETH gas on a BTC send) is ignored so
 * cross-asset gas does not corrupt the comparison.
 */
function principalNetOfFees(evt: RawEvent): Decimal | undefined {
  const primaryLeg = evt.legs.find(l => !l.feeFlag);
  if (!primaryLeg) return undefined;

  const principal = new Decimal(primaryLeg.amount).abs();
  const asset = primaryLeg.asset;

  const feesInSameAsset = evt.legs
    .filter(l => l.feeFlag && l.asset === asset)
    .reduce((sum, l) => sum.plus(new Decimal(l.amount).abs()), new Decimal(0));

  return principal.minus(feesInSameAsset);
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

/**
 * Sort events deterministically: by timestamp ascending, then by id ascending.
 * This ensures the processing order (and thus greedy pairing choices) is
 * invariant under any permutation of the input array.
 */
function sortDeterministically(events: RawEvent[]): RawEvent[] {
  return [...events].sort((a, b) => {
    const tDiff = a.timestamp.getTime() - b.timestamp.getTime();
    if (tDiff !== 0) return tDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const crossSourceMatch: ClassifierRule = {
  name: '03-cross-source-match',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Resolve effective tolerances (fall back to defaults when not configured).
    const windowSec =
      context.crossSourceMatchWindowSeconds ?? DEFAULT_TIME_TOLERANCE_SECONDS;
    const amountTol =
      context.crossSourceAmountTolerance ?? DEFAULT_AMOUNT_TOLERANCE;

    // Sort both lists deterministically so pairing is order-invariant.
    const outs = sortDeterministically(
      events.filter(e => e.type === 'crypto_out'),
    );
    const ins = sortDeterministically(
      events.filter(e => e.type === 'crypto_in'),
    );

    for (const out of outs) {
      if (consumedEventIds.has(out.id)) continue;

      const outAsset = primaryAsset(out);
      const outAmount = principalNetOfFees(out);
      // Skip if there's no principal leg, or if fees consumed the entire principal
      // (net-of-fees ≤ 0). Decimal objects are always truthy, so !outAmount only
      // catches `undefined`; the explicit .gt(0) rejects zero and negative values.
      if (!outAsset || !outAmount || !outAmount.gt(0)) continue;

      // Collect all eligible in-events for this out.
      const candidates = ins.filter(inEvt => {
        if (consumedEventIds.has(inEvt.id)) return false;
        if (inEvt.source === out.source) return false;

        const inAsset = primaryAsset(inEvt);
        const inAmount = principalNetOfFees(inEvt);
        // Same guard as the out side: reject undefined, zero, or negative principal.
        if (!inAsset || !inAmount || !inAmount.gt(0)) return false;

        return (
          inAsset === outAsset &&
          withinTimeTolerance(out.timestamp, inEvt.timestamp, windowSec) &&
          withinAmountTolerance(outAmount, inAmount, amountTol)
        );
      });

      if (candidates.length === 0) continue;

      // Pick the nearest candidate by |Δt|; break ties by ascending event ID.
      const match = candidates.reduce<RawEvent>((best, candidate) => {
        const bestDt = Math.abs(
          out.timestamp.getTime() - best.timestamp.getTime(),
        );
        const candDt = Math.abs(
          out.timestamp.getTime() - candidate.timestamp.getTime(),
        );
        if (candDt < bestDt) return candidate;
        if (candDt === bestDt) {
          // Deterministic tie-break: prefer the lexicographically smaller id.
          return candidate.id < best.id ? candidate : best;
        }
        return best;
      }, candidates[0]!);

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

    return { entries, consumedEventIds };
  },
};
