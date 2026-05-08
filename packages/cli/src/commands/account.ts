/**
 * `daybook account add` and `daybook account list`.
 *
 * Account state lives in two places:
 *   - config.json (so the user can edit it / version-control it)
 *   - DB accounts table (so foreign keys on raw_events work)
 *
 * `add` writes both. `list` reads the DB (more reliable; config could be stale).
 */

import { createRepo, openDatabase } from '@daybook/ledger';
import { type Config, expandPath, loadConfig, saveConfig } from '../config.js';
import { writeJson } from '../ui/index.js';

const SUPPORTED_ACCOUNT_SOURCES = ['coinbase', 'kraken', 'eth', 'polygon'] as const;
type SupportedAccountSource = typeof SUPPORTED_ACCOUNT_SOURCES[number];

export interface AccountAddOptions {
  source: string;
  identifier: string;
  label?: string;
  config?: string;
}

export function resolveAccountSource(source: string): SupportedAccountSource {
  if ((SUPPORTED_ACCOUNT_SOURCES as readonly string[]).includes(source)) {
    return source as SupportedAccountSource;
  }

  throw new Error(
    `Unsupported account source: "${source}". ` +
    `Supported sources: ${SUPPORTED_ACCOUNT_SOURCES.join(', ')}`,
  );
}

export async function accountAddCommand(
  id: string,
  opts: AccountAddOptions,
): Promise<void> {
  const configPath = opts.config;
  const config = loadConfig(configPath);
  const source = resolveAccountSource(opts.source);

  // Reject duplicate IDs in config; user can edit JSON if they really want a change.
  if (config.accounts.some(a => a.id === id)) {
    throw new Error(
      `Account "${id}" already exists. Edit ${configPath ?? '~/.daybook/config.json'} to modify it.`,
    );
  }

  const newAccount = {
    id,
    source,
    identifier: opts.identifier,
    ...(opts.label ? { label: opts.label } : {}),
  };

  // Persist to config
  const updatedConfig: Config = {
    ...config,
    accounts: [...config.accounts, newAccount],
  };
  saveConfig(updatedConfig, configPath);

  // Mirror into DB
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);
  repo.upsertAccount(newAccount);
  db.close();

  console.log(`Added account "${id}" (${source} / ${opts.identifier}).`);
}

export interface AccountListOptions {
  config?: string;
  format?: string;
}

export async function accountListCommand(
  opts: AccountListOptions,
): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);
  const accounts = repo.listAccounts();
  db.close();

  if (writeJson(opts.format, accounts)) return;

  if (accounts.length === 0) {
    console.log('No accounts configured. Add one with `daybook account add ...`');
    return;
  }
  console.log(`${accounts.length} account(s):`);
  console.log('');
  console.log('  ID                 SOURCE              IDENTIFIER                                            LABEL');
  console.log('  ' + '-'.repeat(105));
  for (const a of accounts) {
    const id = a.id.padEnd(18);
    const source = a.source.padEnd(20);
    const identifier = a.identifier.length > 50 ? a.identifier.slice(0, 47) + '...' : a.identifier.padEnd(50);
    const label = a.label ?? '';
    console.log(`  ${id} ${source}${identifier}  ${label}`);
  }
}
