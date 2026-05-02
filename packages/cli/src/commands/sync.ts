/**
 * `daybook sync` — pull new events from a source and persist.
 *
 * v1 supports:
 *   --source coinbase --file <path>   CSV import
 *
 * v1.x will add EVM (Alchemy-backed) sync via account.identifier.
 */

import { readFileSync } from 'node:fs';
import { createRepo, openDatabase } from '@daybook/ledger';
import { coinbase } from '@daybook/sources';
import { expandPath, loadConfig } from '../config.js';

export interface SyncOptions {
  source: string;
  file?: string;
  account?: string;
  config?: string;
}

export async function syncCommand(opts: SyncOptions): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    switch (opts.source) {
      case 'coinbase':
        await syncCoinbase(opts, config, repo);
        break;
      case 'eth':
      case 'polygon':
        throw new Error(
          `${opts.source} sync isn't implemented yet (Phase 1D in implementation-plan.md).`,
        );
      default:
        throw new Error(`Unknown source: ${opts.source}`);
    }
  } finally {
    db.close();
  }
}

async function syncCoinbase(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Coinbase sync requires --file <path-to-csv>');
  }

  // Resolve account: explicit --account, or the first coinbase account in config.
  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'coinbase')?.id;
  if (!accountId) {
    throw new Error(
      'No Coinbase account configured. Add one with `daybook account add <id> --source coinbase --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'coinbase') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not coinbase.`,
    );
  }

  // Parse CSV
  const csvContents = readFileSync(opts.file, 'utf-8');
  const warnings: string[] = [];
  const result = coinbase.parseCoinbaseCsv(csvContents, {
    accountId,
    warn: (w: string) => warnings.push(w),
  });

  // Persist
  const insertResult = repo.insertRawEvents(result.events);

  // Report
  console.log(`Coinbase sync (${accountId}):`);
  console.log(`  Read ${result.totalRows} CSV rows → ${result.events.length} events`);
  console.log(`  Inserted: ${insertResult.inserted}`);
  console.log(`  Skipped (already in DB): ${insertResult.skipped}`);
  if (result.unparsedRowCount > 0) {
    console.log(`  ⚠ Unparsed rows: ${result.unparsedRowCount}`);
  }
  if (warnings.length) {
    console.log(`  Warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 10)) {
      console.log(`    - ${w}`);
    }
    if (warnings.length > 10) {
      console.log(`    ... and ${warnings.length - 10} more`);
    }
  }

  // Per-type breakdown of what's now in the DB
  console.log('');
  console.log(`  Events in DB for ${accountId}:`);
  const counts = repo.countByType({ accountId });
  for (const c of counts) {
    console.log(`    ${(c.type + ':').padEnd(20)} ${c.count}`);
  }
}
