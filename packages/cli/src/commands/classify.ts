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
 */

import {
    classify,
    DEFAULT_RULES,
    loadBridges,
    loadDexRouters,
    type ClassifierContext,
} from '@daybook/classifier';
import { createRepo, openDatabase } from '@daybook/ledger';
import { expandPath, loadConfig } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────
// Command interface
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifyOptions {
  config?: string;
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

    // 5. Persist — full rebuild (DELETE + INSERT)
    repo.rebuildLedgerEntries(result.entries);

    // 6. Print summary
    console.log('Classification complete.');
    console.log(`  Events processed:    ${events.length}`);
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

    if (overrides.length > 0) {
      console.log('');
      console.log(`  Overrides applied:   ${overrides.length}`);
    }
  } finally {
    db.close();
  }
}
