/**
 * @daybook/classifier
 *
 * Turns RawEvents into LedgerEntries.
 *
 * Rules run in this order (see data-model-spec.md §"Classifier rules"):
 *   1. Coinbase pair merger    — merge Retail Staking Transfer / Eth2 Deprecation pairs
 *   2. Self-transfer from CB   — parse Send notes, match to user's own addresses
 *   3. Cross-source self match — match CB Send to on-chain receive (and vice versa)
 *   4. DEX swap collapse       — group by txHash, fold N transfers into 1 trade
 *   5. Bridge detection        — match outbound bridge tx to destination-chain receive
 *   6. Approval gas accounting — produce fee_disposal events for approve() calls
 *   7. Default passthrough     — direct mapping for everything else
 */

export { classify, entryId } from './runner.js';
export type {
  ClassifierContext,
  ClassifierRule,
  ClassifierRuleResult,
  ClassifyResult,
  DexRouterEntry,
  BridgeEntry,
} from './types.js';

// ─── Individual rules (for custom pipelines or testing) ──────────────────
export { cbPairMerger } from './rules/01-cb-pair-merger.js';
export { cbSelfTransfer } from './rules/02-cb-self-transfer.js';
export { crossSourceMatch } from './rules/03-cross-source-match.js';
export { dexSwapCollapse } from './rules/04-dex-swap-collapse.js';
export { bridgeDetection } from './rules/05-bridge-detection.js';
export { approvalGas } from './rules/06-approval-gas.js';
export { defaultPassthrough } from './rules/07-default.js';

// ─── Convenience: the default rule chain ─────────────────────────────────
import { cbPairMerger } from './rules/01-cb-pair-merger.js';
import { cbSelfTransfer } from './rules/02-cb-self-transfer.js';
import { crossSourceMatch } from './rules/03-cross-source-match.js';
import { dexSwapCollapse } from './rules/04-dex-swap-collapse.js';
import { bridgeDetection } from './rules/05-bridge-detection.js';
import { approvalGas } from './rules/06-approval-gas.js';
import { defaultPassthrough } from './rules/07-default.js';
import type { ClassifierRule } from './types.js';

/** The default rule chain in execution order. */
export const DEFAULT_RULES: ReadonlyArray<ClassifierRule> = [
  cbPairMerger,
  cbSelfTransfer,
  crossSourceMatch,
  dexSwapCollapse,
  bridgeDetection,
  approvalGas,
  defaultPassthrough,
];

// ─── Catalog loaders ─────────────────────────────────────────────────────
import type { DexRouterEntry, BridgeEntry } from './types.js';
import dexRoutersData from './dex-routers.json' with { type: 'json' };
import bridgesData from './bridges.json' with { type: 'json' };

/** Load the DEX router catalog as a Map keyed by lowercased address. */
export function loadDexRouters(): Map<string, DexRouterEntry> {
  const map = new Map<string, DexRouterEntry>();
  for (const entry of dexRoutersData as DexRouterEntry[]) {
    map.set(entry.address.toLowerCase(), entry);
  }
  return map;
}

/** Load the bridge catalog as a Map keyed by lowercased address. */
export function loadBridges(): Map<string, BridgeEntry> {
  const map = new Map<string, BridgeEntry>();
  for (const entry of bridgesData as BridgeEntry[]) {
    map.set(entry.address.toLowerCase(), entry);
  }
  return map;
}
