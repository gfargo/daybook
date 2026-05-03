/**
 * `daybook classify` — run the classifier rule chain over all ingested events.
 *
 * Performs a full rebuild each run:
 *   1. Load all RawEvents from the DB
 *   2. Load classifier overrides
 *   3. Build ClassifierContext from config (own addresses, DEX routers, bridges)
 *   4. Run the classifier (overrides first, then rules 01–07)
 *   5. Persist LedgerEntries via repo.rebuildLedgerEntries()
 *   6. Print summary
 *
 * With `--dry-run`: runs steps 1–4, computes a diff against the current DB,
 * prints the summary and diff, but skips step 5 (no writes).
 */

import crypto from 'node:crypto';
import React from 'react';
import { render } from 'ink';
import {
    classify,
    DEFAULT_RULES,
    loadBridges,
    loadDexRouters,
    type ClassifierContext,
} from '@daybook/classifier';
import {
    createRepo,
    openDatabase,
    type LedgerEntry,
    type LedgerEntryType,
    type Repo,
} from '@daybook/ledger';
import { expandPath, loadConfig } from '../config.js';
import { UnclassifiedReview } from './UnclassifiedReview.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifyOptions {
  config?: string;
  dryRun?: boolean;
  review?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Command handler
// ─────────────────────────────────────────────────────────────────────────

/** Handler for `daybook classify`. */
export async function classifyCommand(opts: ClassifyOptions): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    // 1. Load all raw events (no filter, high limit for full rebuild)
    const events = repo.getRawEvents({ limit: 1_000_000 });

    if (events.length === 0) {
      console.log('No events to classify. Run `daybook sync ...` first.');
      return;
    }

    // 2. Load classifier overrides
    const overrides = repo.getClassifierOverrides();

    // 3. Build ClassifierContext from config
    const ownAddresses = config.accounts
      .map(a => a.identifier.toLowerCase());
    const accountIds = config.accounts.map(a => a.id);
    const dexRouters = loadDexRouters();
    const bridges = loadBridges();

    const context: ClassifierContext = {
      ownAddresses,
      accountIds,
      dexRouters,
      bridges,
    };

    // 4. Run classifier
    const result = classify(events, overrides, context, DEFAULT_RULES);

    // 5. Persist or dry-run
    if (opts.dryRun) {
      printDryRunOutput(result, repo, events.length, overrides.length);
    } else {
      repo.rebuildLedgerEntries(result.entries);
      printNormalOutput(result, events.length, overrides.length);

      // 6. Interactive review of unclassified entries
      if (opts.review !== false) {
        const unclassified = result.entries.filter(e => e.type === 'unclassified');
        if (unclassified.length > 0 && process.stdout.isTTY) {
          await runUnclassifiedReview(unclassified, repo);
        } else if (unclassified.length === 0 && opts.review) {
          console.log('\nNo unclassified events to review.');
        }
      }
    }
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Interactive unclassified review
// ─────────────────────────────────────────────────────────────────────────

/**
 * Launch the interactive Ink-based review for unclassified entries.
 * Returns a promise that resolves when the user exits the review.
 */
function runUnclassifiedReview(
  unclassified: LedgerEntry[],
  repo: Repo,
): Promise<void> {
  return new Promise<void>(resolve => {
    const { unmount } = render(
      React.createElement(UnclassifiedReview, {
        entries: unclassified,
        onOverride: (entry: LedgerEntry, selectedType: LedgerEntryType) => {
          repo.insertClassifierOverride({
            id: crypto.randomUUID(),
            rawEventIds: entry.rawEventIds,
            type: selectedType,
            createdAt: new Date(),
            note: 'Set via interactive review',
          });
        },
        onDone: (overridesCreated: number) => {
          unmount();
          if (overridesCreated > 0) {
            console.log(`\n  Overrides created: ${overridesCreated}`);
            console.log('  Run `daybook classify` again to apply them.');
          }
          resolve();
        },
      }),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Dry-run output
// ─────────────────────────────────────────────────────────────────────────

/**
 * Print dry-run summary with diff against current persisted entries.
 * No database writes occur.
 */
function printDryRunOutput(
  result: { entries: { id: string; type: string }[]; unclassifiedCount: number; perRuleCounts: Record<string, number> },
  repo: ReturnType<typeof createRepo>,
  eventCount: number,
  overrideCount: number,
): void {
  console.log('[dry-run] No changes written to database');
  console.log('');

  // Summary
  console.log(`  Events processed:    ${eventCount}`);
  console.log(`  Entries computed:    ${result.entries.length}`);

  // Per-type breakdown
  const typeCounts = new Map<string, number>();
  for (const entry of result.entries) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
  }
  const sortedTypes = [...typeCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [type, count] of sortedTypes) {
    console.log(`    ${(type + ':').padEnd(28)} ${count}`);
  }

  // Unclassified warning
  if (result.unclassifiedCount > 0) {
    console.log('');
    console.log(
      `  ⚠ Unclassified events: ${result.unclassifiedCount}`,
    );
  }

  if (overrideCount > 0) {
    console.log('');
    console.log(`  Overrides applied:   ${overrideCount}`);
  }

  // Diff against current DB
  const existing = repo.getLedgerEntries({ limit: 1_000_000 });

  if (existing.length === 0) {
    console.log('');
    console.log('  All entries are new (no existing entries in database).');
    return;
  }

  const existingIds = new Set(existing.map(e => e.id));
  const newIds = new Set(result.entries.map(e => e.id));

  const added = result.entries.filter(e => !existingIds.has(e.id));
  const removed = existing.filter(e => !newIds.has(e.id));
  const unchanged = result.entries.filter(e => existingIds.has(e.id));

  console.log('');
  console.log('  Changes vs current DB:');
  console.log(`    + ${added.length} new entries`);
  console.log(`    - ${removed.length} removed entries`);
  console.log(`    = ${unchanged.length} unchanged`);
}

// ─────────────────────────────────────────────────────────────────────────
// Normal (non-dry-run) output
// ─────────────────────────────────────────────────────────────────────────

/** Print the standard classification summary and persist entries. */
function printNormalOutput(
  result: { entries: { id: string; type: string }[]; unclassifiedCount: number; perRuleCounts: Record<string, number> },
  eventCount: number,
  overrideCount: number,
): void {
  console.log('Classification complete.');
  console.log(`  Events processed:    ${eventCount}`);
  console.log(`  Ledger entries:      ${result.entries.length}`);
  console.log('');

  // Per-type breakdown
  const typeCounts = new Map<string, number>();
  for (const entry of result.entries) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
  }
  const sortedTypes = [...typeCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [type, count] of sortedTypes) {
    console.log(`    ${(type + ':').padEnd(28)} ${count}`);
  }

  // Per-rule breakdown
  if (Object.keys(result.perRuleCounts).length > 0) {
    console.log('');
    console.log('  Per-rule counts:');
    for (const [rule, count] of Object.entries(result.perRuleCounts)) {
      console.log(`    ${(rule + ':').padEnd(28)} ${count}`);
    }
  }

  // Unclassified warning
  if (result.unclassifiedCount > 0) {
    console.log('');
    console.log(
      `  ⚠ Unclassified events: ${result.unclassifiedCount}`,
    );
    console.log(
      '    Use `daybook overrides` to manually classify these.',
    );
  }

  if (overrideCount > 0) {
    console.log('');
    console.log(`  Overrides applied:   ${overrideCount}`);
  }
}
