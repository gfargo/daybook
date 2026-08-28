/**
 * Classifier types.
 *
 * The classifier turns RawEvents into LedgerEntries by running a chain of
 * rules in priority order. Each rule claims events it can classify and
 * returns LedgerEntries for them. Unclaimed events pass to the next rule.
 */

import type {
    LedgerEntry,
    RawEvent
} from '@daybook/ledger';

// ─────────────────────────────────────────────────────────────────────────
// Catalog entry shapes
// ─────────────────────────────────────────────────────────────────────────

/** One entry in the DEX router address catalog. */
export interface DexRouterEntry {
  chain: number;
  address: string;
  protocol: string;
  version: string;
}

/** One entry in the bridge contract address catalog. */
export interface BridgeEntry {
  chain: number;
  address: string;
  protocol: string;
  version: string;
}

/**
 * One entry in the DeFi contract catalog.
 *
 * `kind` drives the classification rule:
 *   - `staking`             — native-asset deposits/withdrawals are transfer_self;
 *                             token inflows (reward tokens) are income.
 *   - `reward-distributor`  — all crypto_in events are income.
 *   - `lp-router`           — reserved for future LP rules; falls through for now.
 *   - `lending-pool`        — reserved for future lending rules; falls through for now.
 */
export interface DeFiContractEntry {
  chain: number;
  address: string;
  protocol: string;
  version: string;
  kind: 'lp-router' | 'lending-pool' | 'staking' | 'reward-distributor';
}

// ─────────────────────────────────────────────────────────────────────────
// Classifier context — everything rules need besides the events themselves
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifierContext {
  /** All user wallet addresses (lowercased) for self-transfer detection. */
  ownAddresses: string[];
  /** All configured account IDs. */
  accountIds: string[];
  /** DEX router addresses — key is `${chainId}:${lowercasedAddress}`. */
  dexRouters: Map<string, DexRouterEntry>;
  /** Bridge contract addresses — key is `${chainId}:${lowercasedAddress}`. */
  bridges: Map<string, BridgeEntry>;
  /** DeFi contract addresses — key is `${chainId}:${lowercasedAddress}`. */
  defiContracts: Map<string, DeFiContractEntry>;
  /**
   * Maximum time difference in seconds for Rule 03 cross-source matching.
   * Default: 1800 (30 minutes). Increase for slower chains or exchanges with
   * long confirmation times.
   */
  crossSourceMatchWindowSeconds?: number;
  /**
   * Maximum relative amount difference for Rule 03 cross-source matching.
   * Default: 0.01 (1%). Set higher to accommodate large withdrawal fees.
   */
  crossSourceAmountTolerance?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule interface
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single classifier rule.
 *
 * Rules receive only unconsumed events (events not yet claimed by a
 * higher-priority rule). They return entries for the events they can
 * classify, plus the set of event IDs they consumed.
 */
export interface ClassifierRule {
  readonly name: string;
  apply(
    events: ReadonlyArray<RawEvent>,
    context: ClassifierContext,
  ): ClassifierRuleResult;
}

/** What a single rule returns after processing. */
export interface ClassifierRuleResult {
  entries: LedgerEntry[];
  consumedEventIds: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level classify result
// ─────────────────────────────────────────────────────────────────────────

/** The full output of running the classifier. */
export interface ClassifyResult {
  entries: LedgerEntry[];
  unclassifiedCount: number;
  perRuleCounts: Record<string, number>;
}
