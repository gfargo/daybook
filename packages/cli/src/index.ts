#!/usr/bin/env node
/**
 * daybook — command-line interface
 *
 * Available commands:
 *   daybook init                                   — create config + DB
 *   daybook account add <id> --source <s> --identifier <addr>  — add account
 *   daybook account list                           — show all accounts
 *   daybook sync --source coinbase --file <path>   — import a Coinbase CSV
 *   daybook events count                           — counts by RawEventType
 *   daybook events list [--limit N]                — preview recent events
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { accountAddCommand, accountListCommand } from './commands/account.js';
import { syncCommand } from './commands/sync.js';
import {
  eventsCountCommand,
  eventsListCommand,
} from './commands/events.js';

const program = new Command();

program
  .name('daybook')
  .description('Self-hosted crypto wallet auditing and tax reporting')
  .version('0.0.0');

// daybook init
program
  .command('init')
  .description('Initialize a new daybook workspace (config + database)')
  .option('--config <path>', 'Path to config file (default: ~/.daybook/config.json)')
  .action(initCommand);

// daybook account ...
const account = program.command('account').description('Manage accounts');

account
  .command('add <id>')
  .description('Add an account')
  .requiredOption('--source <id>', 'Source: coinbase, eth, polygon, etc.')
  .requiredOption('--identifier <id>', 'Wallet address or exchange account identifier')
  .option('--label <text>', 'Optional human-readable label')
  .option('--config <path>')
  .action(accountAddCommand);

account
  .command('list')
  .description('List configured accounts')
  .option('--config <path>')
  .action(accountListCommand);

// daybook sync
program
  .command('sync')
  .description('Sync events from a configured source')
  .requiredOption('--source <id>', 'Source: coinbase, eth, polygon, ...')
  .option('--file <path>', 'For CSV-import sources, path to the CSV file')
  .option('--account <id>', 'Account to sync into (defaults to first matching source)')
  .option('--config <path>')
  .action(syncCommand);

// daybook events ...
const events = program.command('events').description('Inspect ingested events');

events
  .command('count')
  .description('Count events grouped by RawEventType')
  .option('--account <id>', 'Filter to one account')
  .option('--source <id>', 'Filter to one source')
  .option('--config <path>')
  .action(eventsCountCommand);

events
  .command('list')
  .description('List recent events (default 20)')
  .option('--limit <n>', 'How many events to show', '20')
  .option('--type <t>', 'Filter to one RawEventType')
  .option('--config <path>')
  .action(eventsListCommand);

program.parseAsync(process.argv).catch(err => {
  console.error(formatError(err));
  process.exit(1);
});

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `error: ${err.message}`;
  }
  return `error: ${String(err)}`;
}
