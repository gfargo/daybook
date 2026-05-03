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
import { renderClassifyOutput, renderClassifyDryRun } from './ClassifyOutput.js';

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
      // Compute diff against current DB
      const existing = repo.getLedgerEntries({ limit: 1_000_000 });
      let diff: { added: number; removed: number; unchanged: number } | undefined;
      if (existing.length > 0) {
        const existingIds = new Set(existing.map(e => e.id));
        const newIds = new Set(result.entries.map(e => e.id));
        diff = {
          added: result.entries.filter(e => !existingIds.has(e.id)).length,
          removed: existing.filter(e => !newIds.has(e.id)).length,
          unchanged: result.entries.filter(e => existingIds.has(e.id)).length,
        };
      }
      renderClassifyDryRun(result, events.length, overrides.length, diff);
    } else {
      repo.rebuildLedgerEntries(result.entries);
      renderClassifyOutput(result, events.length, overrides.length);

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
// (Output rendering moved to ClassifyOutput.tsx)
// ─────────────────────────────────────────────────────────────────────────
