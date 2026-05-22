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
import { reconcileCommand } from './commands/reconcile.js';
import { compareCommand } from './commands/compare.js';
import {
    overridesSetCommand,
    overridesListCommand,
    overridesRemoveCommand,
} from './commands/overrides.js';

const program = new Command();
const SOURCE_HELP = 'source type: coinbase, kraken, crypto-com, csv, binance, binance-us, gemini, okx, robinhood, eth, polygon, arbitrum, base, optimism, bnb';

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
  .requiredOption('--source <id>', SOURCE_HELP)
  .requiredOption('--identifier <id>', 'wallet address or exchange account email')
  .option('--label <text>', 'human-readable label for this account')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook account add main-coinbase --source coinbase --identifier you@example.com
  daybook account add main-binance --source binance --identifier you@example.com
  daybook account add main-crypto-com --source crypto-com --identifier you@example.com
  daybook account add main-gemini --source gemini --identifier you@example.com
  daybook account add main-robinhood --source robinhood --identifier you@example.com
  daybook account add main-okx --source okx --identifier you@example.com
  daybook account add csv-imports --source csv --identifier manual-ledger
  daybook account add base-main --source base --identifier 0xYourAddress --label "Main Base"
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
  .requiredOption('--source <id>', SOURCE_HELP)
  .option('--file <path>', 'CSV file path (required for kraken, crypto-com, csv, binance, binance-us, gemini, okx, robinhood; optional for coinbase CSV import)')
  .option('--account <id>', 'target account (defaults to first matching source)')
  .option('--include-failed-gas', 'capture gas from failed EVM transactions (requires ETHERSCAN_API_KEY)')
  .option('--from <date|block>', 'sync from this date (Coinbase API) or date/block number (EVM)')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook sync --source binance --file ~/Downloads/binance-ledger.csv
  daybook sync --source binance-us --file ~/Downloads/binance-us-tax.csv
  daybook sync --source crypto-com --file ~/Downloads/crypto-com-transactions.csv
  daybook sync --source gemini --file ~/Downloads/gemini-transactions.csv
  daybook sync --source robinhood --file ~/Downloads/robinhood-crypto.csv
  daybook sync --source okx --file ~/Downloads/okx-trades.csv
  daybook sync --source coinbase
  daybook sync --source coinbase --file ~/Downloads/Coinbase.csv
  daybook sync --source kraken --file ~/Downloads/kraken-ledger.csv
  daybook sync --source csv --file ~/Downloads/universal-ledger.csv
  daybook sync --source eth
  daybook sync --source base
  daybook sync --source coinbase --from 2024-01-01
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
  .option('--type <t>', 'filter by event type (e.g. trade, income, nft_acquisition, nft_disposal)')
  .option('--source <id>', 'filter to one source')
  .option('--account <id>', 'filter to one account')
  .option('--format <fmt>', 'output format: json')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook events list
  daybook events list --type trade --limit 50
  daybook events list --type nft_acquisition
  daybook events list --type nft_disposal
  daybook events list --source eth --format json | jq '.[].type'`)
  .action(eventsListCommand);

// ─── daybook classify ────────────────────────────────────────────────────

program
  .command('classify')
  .description('Run the 8-rule classifier chain over all ingested events')
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
  .option('--8949-checkbox <category>', 'Form 8949 checkbox category for unreconciled disposals: A, B, or C (default: C)')
  .option('--1099da <path>', 'reconcile against a 1099-DA CSV and assign Form 8949 box A/B/C per disposal (use with --format 8949)')
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
  daybook export 2025 --format 8949 --1099da ~/Downloads/coinbase-1099da.csv
  daybook export 2024 --format schedule-d
  daybook export 2024 --format txf
  daybook export 2024 --method specific-id
  daybook export 2024 --method specific-id --lot-selections ./selections.json`)
  .action(exportCommand);

// ─── daybook reconcile ───────────────────────────────────────────────────

program
  .command('reconcile <year>')
  .description('Reconcile daybook disposals against a 1099-DA from an exchange')
  .requiredOption('--1099da <path>', 'path to 1099-DA CSV file')
  .option('--method <method>', 'cost-basis method: FIFO, HIFO, LIFO (default from config)')
  .option('--format <fmt>', 'output format: text, json (default: text)')
  .option('--output <path>', 'write report to this file instead of stdout')
  .option('--issuer <name>', 'override issuer name (e.g. Coinbase, Kraken)')
  .option('--date-tolerance <days>', 'date tolerance for matching (default: 1)')
  .option('--amount-tolerance <ratio>', 'amount tolerance for matching as a ratio (default: 0.001)')
  .option('--money-tolerance <usd>', 'USD tolerance for proceeds/basis comparison (default: 0.01)')
  .option('--config <path>', 'config file path')
  .addHelpText('after', `
Examples:
  daybook reconcile 2025 --1099da ~/Downloads/coinbase-1099da.csv
  daybook reconcile 2025 --1099da kraken.csv --issuer Kraken
  daybook reconcile 2025 --1099da coinbase.csv --format json --output reconciliation.json
  daybook reconcile 2025 --1099da coinbase.csv --money-tolerance 1.00`)
  .action(reconcileCommand);

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
