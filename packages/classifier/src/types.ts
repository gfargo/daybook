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

// ─────────────────────────────────────────────────────────────────────────
// Classifier context — everything rules need besides the events themselves
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifierContext {
  /** All user wallet addresses (lowercased) for self-transfer detection. */
  ownAddresses: string[];
  /** All configured account IDs. */
  accountIds: string[];
  /** DEX router addresses — key is lowercased address. */
  dexRouters: Map<string, DexRouterEntry>;
  /** Bridge contract addresses — key is lowercased address. */
  bridges: Map<string, BridgeEntry>;
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
