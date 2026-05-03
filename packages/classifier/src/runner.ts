/**
 * Classifier runner.
 *
 * Pure function — no DB access. The CLI command handles loading events,
 * overrides, and context, then calls `classify()` and persists the result.
 *
 * Execution order:
 *   1. Apply user overrides (first-class, always win)
 *   2. Run rules 01–07 in order, each receiving only unconsumed events
 *   3. Return all produced LedgerEntries
 */

import { createHash } from 'node:crypto';
import type {
    ClassifierOverride,
    LedgerEntry, RawEvent
} from '@daybook/ledger';
import type {
    ClassifierContext,
    ClassifierRule,
    ClassifyResult,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Entry ID generation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic LedgerEntry ID from backing raw event IDs.
 *
 * SHA-256 hash of the sorted, pipe-joined event IDs, truncated to 24 hex chars.
 * Stable across runs as long as the same raw events back the entry.
 */
export function entryId(rawEventIds: string[]): string {
  const sorted = [...rawEventIds].sort();
  return createHash('sha256')
    .update(sorted.join('|'))
    .digest('hex')
    .slice(0, 24);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classify raw events into ledger entries.
 *
 * @param events    All raw events to classify.
 * @param overrides User overrides — applied before any automatic rule.
 * @param context   Classifier context (own addresses, DEX routers, bridges).
 * @param rules     Ordered list of classifier rules to run.
 */
export function classify(
  events: ReadonlyArray<RawEvent>,
  overrides: ReadonlyArray<ClassifierOverride>,
  context: ClassifierContext,
  rules: ReadonlyArray<ClassifierRule>,
): ClassifyResult {
  const allEntries: LedgerEntry[] = [];
  const consumed = new Set<string>();
  const perRuleCounts: Record<string, number> = {};

  // ── Step 1: Apply overrides ──────────────────────────────────────────
  for (const override of overrides) {
    const overrideEvents = events.filter(e =>
      override.rawEventIds.includes(e.id),
    );
    if (overrideEvents.length === 0) continue;

    const ids = override.rawEventIds;
    const earliest = overrideEvents.reduce(
      (min, e) => (e.timestamp < min ? e.timestamp : min),
      overrideEvents[0]!.timestamp,
    );

    const entry: LedgerEntry = {
      id: entryId(ids),
      timestamp: earliest,
      type: override.type,
      legs: override.legs ?? overrideEvents.flatMap(e => e.legs),
      rawEventIds: ids,
      overrideId: override.id,
      ...(override.note ? { reason: `Override: ${override.note}` } : { reason: 'User override' }),
    };

    allEntries.push(entry);
    for (const eid of ids) consumed.add(eid);

    perRuleCounts['override'] = (perRuleCounts['override'] ?? 0) + 1;
  }

  // ── Step 2: Run rules in order ───────────────────────────────────────
  for (const rule of rules) {
    const unconsumed = events.filter(e => !consumed.has(e.id));
    if (unconsumed.length === 0) break;

    const result = rule.apply(unconsumed, context);

    allEntries.push(...result.entries);
    for (const eid of result.consumedEventIds) consumed.add(eid);

    perRuleCounts[rule.name] = result.entries.length;
  }

  // ── Count unclassified ───────────────────────────────────────────────
  const unclassifiedCount = allEntries.filter(
    e => e.type === 'unclassified',
  ).length;

  return { entries: allEntries, unclassifiedCount, perRuleCounts };
}
