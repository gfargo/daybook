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
 *   daybook classify                               — run classifier rules
 *   daybook export <year>                          — export tax-ready CSV
 *   daybook compare <year>                         — compare cost-basis methods
 *   daybook overrides set|list|remove              — manage price overrides
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { accountAddCommand, accountListCommand } from './commands/account.js';
import { syncCommand } from './commands/sync.js';
import {
    eventsCountCommand,
    eventsListCommand,
} from './commands/events.js';
import { classifyCommand } from './commands/classify.js';
import { exportCommand } from './commands/export.js';
import { compareCommand } from './commands/compare.js';
import {
    overridesSetCommand,
    overridesListCommand,
    overridesRemoveCommand,
} from './commands/overrides.js';

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
  .option('--format <fmt>', 'Output format: json')
  .option('--config <path>')
  .action(accountListCommand);

// daybook sync
program
  .command('sync')
  .description('Sync events from a configured source')
  .requiredOption('--source <id>', 'Source: coinbase, eth, polygon, ...')
  .option('--file <path>', 'For CSV-import sources, path to the CSV file')
  .option('--account <id>', 'Account to sync into (defaults to first matching source)')
  .option('--include-failed-gas', 'Include gas costs from failed EVM transactions (requires ETHERSCAN_API_KEY)')
  .option('--from <date|block>', 'Sync only transfers after this date (ISO 8601) or block number (EVM sources only)')
  .option('--config <path>')
  .action(syncCommand);

// daybook events ...
const events = program.command('events').description('Inspect ingested events');

events
  .command('count')
  .description('Count events grouped by RawEventType')
  .option('--account <id>', 'Filter to one account')
  .option('--source <id>', 'Filter to one source')
  .option('--format <fmt>', 'Output format: json')
  .option('--config <path>')
  .action(eventsCountCommand);

events
  .command('list')
  .description('List recent events (default 20)')
  .option('--limit <n>', 'How many events to show', '20')
  .option('--type <t>', 'Filter to one RawEventType')
  .option('--source <id>', 'Filter to one source')
  .option('--account <id>', 'Filter to one account')
  .option('--format <fmt>', 'Output format: json')
  .option('--config <path>')
  .action(eventsListCommand);

// daybook classify
program
  .command('classify')
  .description('Run classifier rules over ingested events')
  .option('--dry-run', 'Preview what would change without writing to the database')
  .option('--review', 'Interactively review and override unclassified entries after classification')
  .option('--no-review', 'Skip interactive review of unclassified entries')
  .option('--config <path>')
  .action(classifyCommand);

// daybook export <year>
program
  .command('export <year>')
  .description('Export tax-ready CSV for a given year')
  .option('--method <FIFO|HIFO|LIFO|specific-id>', 'Cost-basis method')
  .option('--output <path>', 'CSV output path')
  .option('--lot-selections <path>', 'JSON file with lot selections for specific-id method')
  .option('--no-wash-sale-flag', 'Omit the Wash Sale? column from the CSV export')
  .option('--config <path>')
  .action(exportCommand);

// daybook compare <year>
program
  .command('compare <year>')
  .description('Compare tax outcomes across cost-basis methods')
  .option('--format <fmt>', 'Output format: json')
  .option('--config <path>')
  .action(compareCommand);

// daybook overrides ...
const overrides = program.command('overrides').description('Manage price overrides');

overrides
  .command('set <asset> <date> <price>')
  .description('Set a manual price override')
  .option('--note <text>', 'Optional note for this override')
  .option('--config <path>')
  .action(overridesSetCommand);

overrides
  .command('list')
  .description('List all price overrides')
  .option('--format <fmt>', 'Output format: json')
  .option('--config <path>')
  .action(overridesListCommand);

overrides
  .command('remove <id>')
  .description('Remove a price override by ID')
  .option('--config <path>')
  .action(overridesRemoveCommand);

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
