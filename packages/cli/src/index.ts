#!/usr/bin/env node
/**
 * daybook — command-line interface
 *
 * Self-hosted crypto wallet auditing and tax reporting.
 * Run `daybook --help` for a list of commands.
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
  .version('0.2.0');

// ─── daybook init ────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create config and database at ~/.daybook/')
  .option('--config <path>', 'config file path (default: ~/.daybook/config.json)')
  .addHelpText('after', `
Examples:
  daybook init
  daybook init --config ~/custom/config.json`)
  .action(initCommand);

// ─── daybook account ─────────────────────────────────────────────────────

const account = program
  .command('account')
  .description('Add and list source accounts');

account
  .command('add <id>')
  .description('Register a new source account')
  .requiredOption('--source <id>', 'source type: coinbase, kraken, eth, polygon')
  .requiredOption('--identifier <id>', 'wallet address or exchange account email')
  .option('--label <text>', 'human-readable label for this account')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook account add main-coinbase --source coinbase --identifier you@example.com
  daybook account add eth-main --source eth --identifier 0xYourAddress --label "Main ETH"`)
  .action(accountAddCommand);

account
  .command('list')
  .description('Show all configured accounts')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .action(accountListCommand);

// ─── daybook sync ────────────────────────────────────────────────────────

program
  .command('sync')
  .description('Pull new events from a source and persist them')
  .requiredOption('--source <id>', 'source type: coinbase, kraken, eth, polygon')
  .option('--file <path>', 'CSV file path (required for coinbase, kraken)')
  .option('--account <id>', 'target account (defaults to first matching source)')
  .option('--include-failed-gas', 'capture gas from failed EVM transactions (requires ETHERSCAN_API_KEY)')
  .option('--from <date|block>', 'sync from this date (ISO 8601) or block number (EVM only)')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook sync --source coinbase --file ~/Downloads/Coinbase.csv
  daybook sync --source kraken --file ~/Downloads/kraken-ledger.csv
  daybook sync --source eth
  daybook sync --source eth --from 2024-01-01
  daybook sync --source eth --include-failed-gas`)
  .action(syncCommand);

// ─── daybook events ──────────────────────────────────────────────────────

const events = program
  .command('events')
  .description('Inspect ingested raw events');

events
  .command('count')
  .description('Count events grouped by type')
  .option('--account <id>', 'filter to one account')
  .option('--source <id>', 'filter to one source')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .action(eventsCountCommand);

events
  .command('list')
  .description('Browse recent events in a table')
  .option('--limit <n>', 'number of events to show', '20')
  .option('--type <t>', 'filter by event type (e.g. trade, income, transfer)')
  .option('--source <id>', 'filter to one source')
  .option('--account <id>', 'filter to one account')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook events list
  daybook events list --type trade --limit 50
  daybook events list --source eth --format json | jq '.[].type'`)
  .action(eventsListCommand);

// ─── daybook classify ────────────────────────────────────────────────────

program
  .command('classify')
  .description('Run the 7-rule classifier chain over all ingested events')
  .option('--dry-run', 'preview changes without writing to the database')
  .option('--review', 'interactively review unclassified entries after classification')
  .option('--no-review', 'skip interactive review')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook classify
  daybook classify --dry-run
  daybook classify --review`)
  .action(classifyCommand);

// ─── daybook export ──────────────────────────────────────────────────────

program
  .command('export <year>')
  .description('Generate a tax-ready export for the given year')
  .option('--method <method>', 'cost-basis method: FIFO, HIFO, LIFO, or specific-id (default: FIFO)')
  .option('--format <fmt>', 'output format: csv, 8949, schedule-d, txf (default: csv)')
  .option('--8949-checkbox <category>', 'Form 8949 checkbox category: A, B, or C (default: C)')
  .option('--output <path>', 'output file path (default: ./daybook-<year>-<method>.<ext>)')
  .option('--lot-selections <path>', 'replay specific-id lot selections from a JSON file')
  .option('--no-wash-sale-flag', 'omit the Wash Sale? column from the CSV')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook export 2024
  daybook export 2024 --method HIFO --output ./taxes-2024.csv
  daybook export 2024 --format 8949
  daybook export 2024 --format 8949 --8949-checkbox A
  daybook export 2024 --format schedule-d
  daybook export 2024 --format txf
  daybook export 2024 --method specific-id
  daybook export 2024 --method specific-id --lot-selections ./selections.json`)
  .action(exportCommand);

// ─── daybook compare ─────────────────────────────────────────────────────

program
  .command('compare <year>')
  .description('Compare FIFO, HIFO, and LIFO tax outcomes side by side')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook compare 2024
  daybook compare 2024 --format json`)
  .action(compareCommand);

// ─── daybook overrides ───────────────────────────────────────────────────

const overrides = program
  .command('overrides')
  .description('Manage manual price overrides for unpriced tokens');

overrides
  .command('set <asset> <date> <price>')
  .description('Set a price override (YYYY-MM-DD, USD)')
  .option('--note <text>', 'optional note explaining this override')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook overrides set SOMETOKEN 2024-03-15 0.50
  daybook overrides set ETH 2024-01-01 2305.73 --note "Manual correction"`)
  .action(overridesSetCommand);

overrides
  .command('list')
  .description('Show all price overrides')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .action(overridesListCommand);

overrides
  .command('remove <id>')
  .description('Delete a price override by its ID')
  .option('--config <path>', 'config file path')
  .action(overridesRemoveCommand);

// ─── Parse and run ───────────────────────────────────────────────────────

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
