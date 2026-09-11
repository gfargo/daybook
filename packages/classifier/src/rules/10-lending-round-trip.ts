/**
 * Rule 10 — Lending round-trip (Aave / Compound deposit + withdrawal).
 *
 * Detects supply (deposit) and redeem (withdrawal) transactions for known
 * lending protocols — currently Aave V2/V3 and Compound V2 — and classifies
 * them as `trade` LedgerEntries for the PRINCIPAL amount only.
 *
 *   Deposit:    underlying crypto_out + receipt-token crypto_in  →  trade
 *   Withdrawal: receipt-token crypto_out + underlying crypto_in  →  trade
 *
 * Why a separate rule (not extending rule 09):
 *   Rule 09 processes events individually and is purpose-built for
 *   staking/income. Lending detection requires txHash grouping — the same
 *   pattern used by rules 04 (DEX swap) and 08 (NFT) — so a group-aware
 *   rule is the right abstraction.
 *
 * Detection strategy:
 *   A txHash group is a lending round-trip when AT LEAST ONE non-fee leg
 *   in the group has a contractAddress that appears in the DeFi catalog
 *   with kind === 'lending-pool', OR a counterparty that matches the same.
 *   Using contractAddress (the aToken/cToken contract on the received token)
 *   is the robust path because on Aave V2/V3 the aTokens are minted from the
 *   null address — the LendingPool/Pool contract never appears as the ERC-20
 *   transfer counterparty. On Compound V2 the cToken contract IS the
 *   counterparty on the underlying leg, so both paths fire.
 *
 * IMPORTANT — out of scope for this rule:
 *   aToken and Compound cToken BALANCE GROWTH from interest accrual /
 *   rebasing is NOT captured here. Aave V2 aTokens rebase continuously;
 *   Aave V3 and cTokens accrue via an exchange rate. Either way, the extra
 *   tokens that appear in the wallet without a corresponding on-chain
 *   transfer are NOT classified by this rule. That accrual / yield income
 *   classification is deferred to sub-item 5 of OSS-128.
 *
 * Determinism:
 *   entryId is derived from the sorted raw event IDs of the group, matching
 *   the approach used by rules 04 and 08. Re-syncing the same source data
 *   always produces the same entry ID (inserts=0 on the second run).
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
 * Return the lending-pool catalog entry that matches any leg of `evt`,
 * searching by:
 *   1. leg.contractAddress (robust: catches aToken mint from null address)
 *   2. evt.counterparty    (catches Compound cETH / underlying-leg routing)
 *
 * Returns `undefined` if no match is found or the source is not an EVM chain.
 */
function lendingEntryFor(
  evt: RawEvent,
  ctx: ClassifierContext,
): DeFiContractEntry | undefined {
  const chainId = CHAIN_ID_BY_SOURCE[evt.source];
  if (chainId === undefined) return undefined;

  // Check each non-fee leg's contractAddress first (aToken/cToken leg)
  for (const leg of evt.legs) {
    if (!leg.feeFlag && leg.contractAddress) {
      const entry = ctx.defiContracts.get(
        `${chainId}:${leg.contractAddress.toLowerCase()}`,
      );
      if (entry?.kind === 'lending-pool') return entry;
    }
  }

  // Fall back to counterparty match (Compound cETH underlying, etc.)
  if (evt.counterparty) {
    const entry = ctx.defiContracts.get(
      `${chainId}:${evt.counterparty.toLowerCase()}`,
    );
    if (entry?.kind === 'lending-pool') return entry;
  }

  return undefined;
}

/**
 * Return a human-readable label for the matched lending entry + direction.
 */
function reasonLabel(entry: DeFiContractEntry, isDeposit: boolean): string {
  const direction = isDeposit ? 'supply' : 'redeem';
  return `${entry.protocol} ${entry.version} ${direction}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lending round-trip rule.
 *
 * Groups `crypto_in` / `crypto_out` events by txHash. For each group that
 * touches a known lending-pool contract, collapses all legs into a single
 * `trade` LedgerEntry (principal + fee legs preserved).
 */
export const lendingRoundTrip: ClassifierRule = {
  name: '10-lending-round-trip',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    // Only consider crypto_in / crypto_out — other types are irrelevant here
    const eligible = events.filter(
      e => e.type === 'crypto_in' || e.type === 'crypto_out',
    );

    // Group by txHash; skip events with no txHash (non-EVM or synthetic)
    const byTxHash = new Map<string, RawEvent[]>();
    for (const evt of eligible) {
      if (!evt.txHash) continue;
      const group = byTxHash.get(evt.txHash);
      if (group) {
        group.push(evt);
      } else {
        byTxHash.set(evt.txHash, [evt]);
      }
    }

    for (const [txHash, group] of byTxHash) {
      // A round-trip requires at least one inflow AND one outflow (ignoring fees)
      const principalIns = group.filter(
        e => e.type === 'crypto_in',
      );
      const principalOuts = group.filter(
        e => e.type === 'crypto_out',
      );

      if (principalIns.length === 0 || principalOuts.length === 0) continue;

      // Check whether ANY event in this group touches a cataloged lending contract
      let matchedEntry: DeFiContractEntry | undefined;
      for (const evt of group) {
        const found = lendingEntryFor(evt, context);
        if (found) {
          matchedEntry = found;
          break;
        }
      }

      if (!matchedEntry) continue;

      // Determine direction for the reason label:
      //   Deposit  (supply)  — crypto_out of the underlying precedes crypto_in of receipt token
      //   Withdrawal (redeem) — crypto_out of the receipt token precedes crypto_in of underlying
      // We detect the direction by checking whether a known lending-pool contract
      // appears as the contractAddress on the OUT legs (withdrawal: receipt token
      // being burned/sent) vs the IN legs (deposit: receipt token being received).
      const chainId = CHAIN_ID_BY_SOURCE[group[0]!.source] ?? 0;
      const receiptTokenOut = principalOuts.some(e =>
        e.legs.some(
          l =>
            !l.feeFlag &&
            l.contractAddress &&
            context.defiContracts.get(`${chainId}:${l.contractAddress.toLowerCase()}`)?.kind ===
              'lending-pool',
        ),
      );
      // If the receipt token (aToken/cToken) is being sent OUT → withdrawal (redeem)
      // Otherwise → deposit (supply)
      const isDeposit = !receiptTokenOut;

      const ids = group.map(e => e.id);
      const earliest = group.reduce(
        (min, e) => (e.timestamp < min ? e.timestamp : min),
        group[0]!.timestamp,
      );

      // Collect all legs, keeping principal and fee legs together (same
      // structure as rule 04 — tax engine handles fee separation internally)
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

      const entry: LedgerEntry = {
        id: entryId(ids),
        timestamp: earliest,
        type: 'trade',
        legs: [...principalLegs, ...feeLegs],
        rawEventIds: ids,
        reason: `${reasonLabel(matchedEntry, isDeposit)} (tx ${txHash.slice(0, 10)}…)`,
      };

      entries.push(entry);
      for (const eid of ids) consumedEventIds.add(eid);
    }

    return { entries, consumedEventIds };
  },
};
