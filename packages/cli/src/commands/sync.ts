/**
 * `daybook sync` — pull new events from a source and persist.
 *
 * v1 supports:
 *   --source coinbase --file <path>   CSV import
 *   --source eth|polygon              EVM sync via Alchemy
 */

import { readFileSync } from 'node:fs';
import { createRepo, openDatabase } from '@daybook/ledger';
import type { Repo } from '@daybook/ledger';
import { coinbase } from '@daybook/sources';
import {
    AlchemyTransferProvider,
    CHAIN_ID_BY_SOURCE,
    ingestEvm,
} from '@daybook/sources/evm';
import type { Config } from '../config.js';
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
        await syncEvm(opts, config, repo);
        break;
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

// ─────────────────────────────────────────────────────────────────────────
// EVM sync (Ethereum, Polygon)
// ─────────────────────────────────────────────────────────────────────────

async function syncEvm(
  opts: SyncOptions,
  config: Config,
  repo: Repo,
): Promise<void> {
  // Resolve account: explicit --account, or the first matching source in config.
  const accountId =
    opts.account ??
    config.accounts.find(a => a.source === opts.source)?.id;
  if (!accountId) {
    throw new Error(
      `No ${opts.source} account configured. ` +
      `Add one with \`daybook account add <id> --source ${opts.source} --identifier <address>\` first.`,
    );
  }

  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(
      `Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`,
    );
  }
  if (account.source !== opts.source) {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not ${opts.source}.`,
    );
  }

  // Resolve Alchemy API key from env.
  const apiKeyEnv = config.providers?.alchemy?.apiKeyEnv ?? 'ALCHEMY_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${apiKeyEnv} environment variable is required for EVM sync. ` +
      'Get a free key at https://dashboard.alchemy.com',
    );
  }

  // Resolve chain ID.
  const chainId = CHAIN_ID_BY_SOURCE[opts.source];
  if (chainId === undefined) {
    throw new Error(`No chain ID mapping for source "${opts.source}".`);
  }

  const provider = new AlchemyTransferProvider(apiKey);

  console.log(`EVM sync (${accountId}, ${opts.source}):`);
  const { events, stats } = await ingestEvm({
    provider,
    address: account.identifier,
    chainId,
    accountId,
    source: account.source,
  });

  console.log(`  Native: ${stats.native}`);
  console.log(`  Internal: ${stats.internal}`);
  console.log(`  ERC-20: ${stats.erc20}`);
  console.log(`  ERC-721: ${stats.erc721} (nft_event placeholders)`);
  console.log(`  ERC-1155: ${stats.erc1155}`);
  if (stats.deduped > 0) {
    console.log(`  (${stats.deduped} duplicate transfers skipped)`);
  }

  const insertResult = repo.insertRawEvents(events);
  console.log(`  Total: ${events.length}`);
  console.log(`  Inserted: ${insertResult.inserted}`);
  console.log(`  Skipped (already in DB): ${insertResult.skipped}`);

  // Per-type breakdown of what's now in the DB
  console.log('');
  console.log(`  Events in DB for ${accountId}:`);
  const counts = repo.countByType({ accountId });
  for (const c of counts) {
    console.log(`    ${(c.type + ':').padEnd(20)} ${c.count}`);
  }
}
