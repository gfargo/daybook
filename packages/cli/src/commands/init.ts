/**
 * `daybook init`
 *
 * Creates a starter config (if absent) and an empty SQLite DB. Idempotent —
 * running on an existing workspace is a no-op (and prints what's already there).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRepo, openDatabase } from '@daybook/ledger';
import { defaultConfigPath, expandPath, initConfig } from '../config.js';

export interface InitOptions {
  config?: string;
}

/**
 * Initialize a daybook workspace.
 *
 * Idempotent and self-healing: re-running on an existing config is fine,
 * and any accounts present in the config are mirrored into the DB. So if
 * the user deletes the DB, `init` rebuilds the account table from config —
 * you don't have to re-add every account.
 */
export async function initCommand(opts: InitOptions): Promise<void> {
  const configPath = opts.config ?? defaultConfigPath();
  const configCreated = !existsSync(configPath);
  const config = initConfig(configPath);

  // Ensure DB directory exists, then open (which applies migrations).
  const dbPath = expandPath(config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const repo = createRepo(db.raw);

  // Mirror accounts from config → DB. Idempotent (upsert).
  let mirrored = 0;
  for (const account of config.accounts) {
    if (!repo.getAccount(account.id)) mirrored++;
    repo.upsertAccount(account);
  }
  db.close();

  if (configCreated) {
    console.log('Initialized daybook workspace.');
  } else {
    console.log('daybook workspace already initialized.');
  }
  console.log(`  config:   ${configPath}`);
  console.log(`  db:       ${dbPath}`);
  console.log(`  accounts: ${config.accounts.length}` +
    (mirrored > 0 ? ` (${mirrored} mirrored from config to DB)` : ''));
  if (configCreated) {
    console.log('');
    console.log('Next: add an account with `daybook account add ...`');
  }
}
