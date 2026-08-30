/**
 * Rule 09 — DeFi classification.
 *
 * Checks whether the counterparty of a `crypto_in` or `crypto_out` event
 * matches a known DeFi contract address (staking contract or reward distributor)
 * and classifies it accordingly:
 *
 *   reward-distributor + crypto_in  → income (at FMV)
 *   staking + crypto_out (native)   → transfer_self (stake)
 *   staking + crypto_in  (native)   → transfer_self (unstake)
 *   staking + crypto_in  (token)    → income (staking reward token)
 *
 * Native-asset detection: a leg is native when it has no `contractAddress`
 * and no `feeFlag`. This matches how EVM adapters emit ETH/MATIC/BNB legs.
 *
 * Events whose counterparty is not in the catalog, or whose source is not
 * an EVM chain, are left unconsumed and fall through to the default
 * passthrough rule (07-default.ts).
 *
 * lp-router and lending-pool catalog entries are intentionally not consumed
 * here — they are reserved for future rules.
 */

import type { LedgerEntry, LedgerEntryType, RawEvent } from '@daybook/ledger';
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
 * Return the DeFi catalog entry for the contract that `evt` interacted with,
 * or `undefined` if:
 *   - the event has no counterparty
 *   - the source is not an EVM chain (not in CHAIN_ID_BY_SOURCE)
 *   - the counterparty address is not in the catalog for that chain
 */
function defiContractFor(
  evt: RawEvent,
  ctx: ClassifierContext,
): DeFiContractEntry | undefined {
  if (!evt.counterparty) return undefined;
  const chainId = CHAIN_ID_BY_SOURCE[evt.source];
  if (chainId === undefined) return undefined;
  return ctx.defiContracts.get(`${chainId}:${evt.counterparty.toLowerCase()}`);
}

/**
 * Return true when the given leg represents a native-asset movement
 * (i.e. ETH on Ethereum, MATIC on Polygon, etc.) — no ERC-20 contract
 * address, and not a fee leg.
 */
function isNativeLeg(leg: RawEvent['legs'][number]): boolean {
  return !leg.contractAddress && !leg.feeFlag;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule implementation
// ─────────────────────────────────────────────────────────────────────────

/**
 * DeFi classification rule.
 *
 * Processes `crypto_in` and `crypto_out` events whose counterparty matches
 * a staking contract or reward distributor in the DeFi contract catalog,
 * producing `income` or `transfer_self` LedgerEntries.
 */
export const defiClassification: ClassifierRule = {
  name: '09-defi-classification',

  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult {
    const entries: LedgerEntry[] = [];
    const consumedEventIds = new Set<string>();

    for (const evt of events) {
      if (evt.type !== 'crypto_in' && evt.type !== 'crypto_out') continue;

      const contract = defiContractFor(evt, context);
      if (!contract) continue;

      // lp-router and lending-pool are reserved for future rules — fall through
      if (contract.kind === 'lp-router' || contract.kind === 'lending-pool') continue;

      let entryType: LedgerEntryType;
      let reason: string;

      if (contract.kind === 'reward-distributor') {
        // All crypto_in from a known reward distributor → income
        if (evt.type !== 'crypto_in') continue;
        entryType = 'income';
        reason = `DeFi reward from ${contract.protocol} ${contract.version}`;
      } else {
        // kind === 'staking'
        const principalLegs = evt.legs.filter(isNativeLeg);
        const hasNativePrincipal = principalLegs.length > 0;
        const tokenLegs = evt.legs.filter(
          l => l.contractAddress && !l.feeFlag,
        );
        const hasTokenPrincipal = tokenLegs.length > 0;

        if (evt.type === 'crypto_out' && hasNativePrincipal) {
          // Staking native asset out → transfer_self (stake)
          entryType = 'transfer_self';
          reason = `Stake to ${contract.protocol} ${contract.version}`;
        } else if (evt.type === 'crypto_in' && hasNativePrincipal) {
          // Unstaking native asset in → transfer_self (unstake)
          entryType = 'transfer_self';
          reason = `Unstake from ${contract.protocol} ${contract.version}`;
        } else if (evt.type === 'crypto_in' && hasTokenPrincipal) {
          // Token inflow from a staking contract → income (reward token)
          entryType = 'income';
          reason = `Staking reward token from ${contract.protocol} ${contract.version}`;
        } else {
          // Unrecognised combination — do not consume; let it fall through
          continue;
        }
      }

      const rawIds = [evt.id];
      const entry: LedgerEntry = {
        id: entryId(rawIds),
        timestamp: evt.timestamp,
        type: entryType,
        legs: evt.legs,
        rawEventIds: rawIds,
        reason,
      };

      entries.push(entry);
      consumedEventIds.add(evt.id);
    }

    return { entries, consumedEventIds };
  },
};
