/**
 * Rule 10 — LP deposit/withdrawal collapse.
 *
 * Groups on-chain events by txHash. If any event's counterparty matches a
 * known LP router/factory address in the DeFi contract catalog (kind:
 * 'lp-router'), and the principal-leg shape matches an LP deposit or
 * withdrawal pattern, collapse all events into one `trade` LedgerEntry.
 *
 * LP deposit pattern (add liquidity):
 *   2 principal-out legs (two distinct assets sent) +
 *   1 principal-in  leg  (one LP token received)
 *   → trade: dispose both underlying assets, acquire the LP token
 *
 * LP withdrawal pattern (remove liquidity):
 *   1 principal-out leg  (one LP token sent) +
 *   2 principal-in  legs (two distinct assets received)
 *   → trade: dispose the LP token, acquire both underlying assets
 *
 * Fee legs (feeFlag: true) are preserved and separated, matching the
 * behaviour of rule 04 (dex-swap-collapse).
 *
 * Known limitation: LP tokens (e.g. UNI-V2, SLP) have no market ticker,
 * so the pricing chain cannot resolve their FMV. The LP leg of the
 * resulting trade entry will land in `unpricedEvents` (compute.ts:268/314)
 * until a price override or a future sub-item ships an LP token pricing
 * strategy. The existing CLI export command already counts and reports
 * unpriced entries — LP trades will surface there automatically.
 *
 * Note on scope:
 *   - Uniswap V2 addLiquidity is typically routed through the V2 Router
 *     (0x7a250d…), which is already cataloged in dex-routers.json and
 *     consumed by rule 04. Rule 10 targets position managers and factories
 *     that are not swap routers (e.g. Uniswap V3 NonfungiblePositionManager,
 *     V2 Factory, QuickSwap, PancakeSwap V3 NonfungiblePositionManager).
 *   - Uniswap V3 mint() issues an ERC-721 position NFT. That NFT is emitted
 *     as an `nft_event` by the EVM adapter and may be claimed by rule 08
 *     (nft-classification). Rule 10 therefore targets the V2-style fungible
 *     LP token shape; V3 NFT positions are out of scope.
 *   - Multi-hop swaps and swap-plus-refund transactions can also produce
 *     2-in/1-out or 2-out/1-in leg shapes. Gating on a known lp-router
 *     counterparty AND requiring the 2-asset side to be two distinct assets
 *     reduces false positives significantly. LP interactions that go through
 *     an intermediary contract (not the position manager) will not be
 *     detected by this rule.
 */

import type { AssetLeg, LedgerEntry, RawEvent } from '@daybook/ledger';
import { CHAIN_ID_BY_SOURCE } from '@daybook/ledger';
import type {
  ClassifierContext,
  ClassifierRule,
  ClassifierRuleResult,
  DeFiContractEntry,
} from '../types.js';
import { entryId } from '../runner.js';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Return the LP router catalog entry for the contract that `evt` interacted
 * with, or `undefined` if:
 *   - the event has no counterparty
 *   - the source is not an EVM chain (not in CHAIN_ID_BY_SOURCE)
 *   - the counterparty address is not in the catalog for that chain
 *   - the catalog entry has a kind other than 'lp-router'
 */
function lpRouterFor(
  evt: RawEvent,
  ctx: ClassifierContext,
): DeFiContractEntry | undefined {
  if (!evt.counterparty) return undefined;
  const chainId = CHAIN_ID_BY_SOURCE[evt.source];
  if (chainId === undefined) return undefined;
  const entry = ctx.defiContracts.get(
    `${chainId}:${evt.counterparty.toLowerCase()}`,
  );
  return entry?.kind === 'lp-router' ? entry : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

export const lpSwap: ClassifierRule = {
  name: '10-lp-swap',

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
      // Require at least 2 events in the group
      if (group.length < 2) continue;

      // Find the first event whose counterparty matches an lp-router
      let lpRouter: DeFiContractEntry | undefined;
      for (const evt of group) {
        const r = lpRouterFor(evt, context);
        if (r !== undefined) {
          lpRouter = r;
          break;
        }
      }
      if (lpRouter === undefined) continue;

      // Collect all legs, separating principal from fee legs
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

      // Classify principal legs by direction
      const outLegs = principalLegs.filter(
        (l) => parseFloat(l.amount) < 0,
      );
      const inLegs = principalLegs.filter(
        (l) => parseFloat(l.amount) > 0,
      );

      // Determine shape: deposit (2-out + 1-in) or withdrawal (1-out + 2-in)
      let reason: string;

      if (outLegs.length === 2 && inLegs.length >= 1) {
        // LP deposit: two distinct assets out → LP token in
        const outAssets = new Set(outLegs.map((l) => l.asset.toLowerCase()));
        if (outAssets.size < 2) continue; // same asset on both sides — not an LP deposit
        reason = `LP deposit via ${lpRouter.protocol} ${lpRouter.version} (tx ${txHash.slice(0, 10)}…)`;
      } else if (outLegs.length >= 1 && inLegs.length === 2) {
        // LP withdrawal: LP token out → two distinct assets in
        const inAssets = new Set(inLegs.map((l) => l.asset.toLowerCase()));
        if (inAssets.size < 2) continue; // same asset on both sides — not an LP withdrawal
        reason = `LP withdrawal via ${lpRouter.protocol} ${lpRouter.version} (tx ${txHash.slice(0, 10)}…)`;
      } else {
        // Shape not recognized — leave unconsumed
        continue;
      }

      const ids = group.map((e) => e.id);
      const earliest = group.reduce(
        (min, e) => (e.timestamp < min ? e.timestamp : min),
        group[0]!.timestamp,
      );

      const entry: LedgerEntry = {
        id: entryId(ids),
        timestamp: earliest,
        type: 'trade',
        legs: [...principalLegs, ...feeLegs],
        rawEventIds: ids,
        reason,
      };

      entries.push(entry);
      for (const eid of ids) consumedEventIds.add(eid);
    }

    return { entries, consumedEventIds };
  },
};
