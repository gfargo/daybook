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
// Override validation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validate classifier overrides before applying them.
 *
 * Throws an Error with a readable multi-line message when any of the
 * following problems are found:
 *
 *   - A `rawEventId` in an override does not exist in the provided events
 *     ("stale override")
 *   - Two overrides reference the same `rawEventId` ("overlapping overrides")
 *   - Two overrides would produce the same `entryId` (identical event sets,
 *     i.e. duplicate overrides)
 *
 * Overrides that match zero events are silently skipped by `classify()`;
 * they are not an error here (those events may have been deleted).
 *
 * @param overrides  Overrides to validate.
 * @param events     The full set of raw events that will be classified.
 * @throws {Error}   If any validation problem is found. The message names
 *                   every offending override ID.
 */
export function validateOverrides(
  overrides: ReadonlyArray<ClassifierOverride>,
  events: ReadonlyArray<RawEvent>,
): void {
  const eventIdSet = new Set(events.map(e => e.id));
  const problems: string[] = [];

  // Track which rawEventId is claimed by which override (for overlap detection)
  const claimedBy = new Map<string, string>(); // rawEventId → first override.id

  // Track which entryId (sorted event set hash) is claimed (for duplicate detection)
  const entryIdClaimedBy = new Map<string, string>(); // entryId → first override.id

  for (const override of overrides) {
    const { id, rawEventIds } = override;

    // Check for stale rawEventIds (IDs not present in events)
    const stale = rawEventIds.filter(rid => !eventIdSet.has(rid));
    if (stale.length > 0) {
      problems.push(
        `Override "${id}" references ${stale.length} raw event(s) that no longer exist: ${stale.join(', ')}. ` +
        `Run \`daybook overrides prune\` to remove stale overrides.`,
      );
    }

    // Check for overlapping rawEventIds across overrides (one message per
    // offending pair, not one per shared rawEventId)
    const overlapsReported = new Set<string>();
    for (const rid of rawEventIds) {
      const prior = claimedBy.get(rid);
      if (prior !== undefined) {
        if (!overlapsReported.has(prior)) {
          overlapsReported.add(prior);
          problems.push(
            `Override "${id}" overlaps with override "${prior}": both reference raw event "${rid}".`,
          );
        }
      } else {
        claimedBy.set(rid, id);
      }
    }

    // Check for duplicate overrides (same entryId = identical sorted event
    // sets). Skipped for empty rawEventIds, since entryId([]) is a constant
    // and such overrides are already skipped downstream by classify().
    if (rawEventIds.length > 0) {
      const eid = entryId(rawEventIds);
      const priorEntry = entryIdClaimedBy.get(eid);
      if (priorEntry !== undefined) {
        // Only report as a duplicate if the overlap check didn't already cover it
        if (!overlapsReported.has(priorEntry)) {
          problems.push(
            `Override "${id}" is a duplicate of override "${priorEntry}": both reference the same set of raw events.`,
          );
        }
      } else {
        entryIdClaimedBy.set(eid, id);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Classifier override validation failed with ${problems.length} problem(s):\n` +
      problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n'),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classify raw events into ledger entries.
 *
 * Validates overrides before applying them. Throws if any override
 * references a non-existent event, two overrides share a rawEventId,
 * or two overrides would produce the same entryId (duplicate event set).
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
  // Validate overrides before doing anything — fail fast with a clear message
  validateOverrides(overrides, events);

  const allEntries: LedgerEntry[] = [];
  const consumed = new Set<string>();
  const perRuleCounts: Record<string, number> = {};

  // ── Step 1: Apply overrides ──────────────────────────────────────────
  for (const override of overrides) {
    const overrideEvents = events.filter(e =>
      override.rawEventIds.includes(e.id),
    );
    if (overrideEvents.length === 0) continue;

    // Derive ids only from events that actually exist (defence-in-depth:
    // validateOverrides already rejects stale ids, but this ensures the
    // entry's rawEventIds never reference a non-existent event).
    const ids = overrideEvents.map(e => e.id);
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
