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
 *   6. Approval gas accounting — produce fee_only events for approve() calls
 *   7. Anything left           — `unclassified`, surface to user
 *
 * Pending implementation.
 */

export const TODO = 'classifier rules pending — see data-model-spec.md';
