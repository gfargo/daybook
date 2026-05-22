/**
 * `daybook sync` — pull new events from a source and persist.
 *
 * v1 supports:
 *   --source binance --file <path>    CSV import
 *   --source binance-us --file <path> CSV import
 *   --source bybit --file <path>      CSV import
 *   --source coinbase                 Coinbase API sync
 *   --source coinbase --file <path>   CSV import
 *   --source crypto-com --file <path> CSV import
 *   --source gemini --file <path>     CSV import
 *   --source kraken --file <path>     CSV import
 *   --source okx --file <path>        CSV import
 *   --source robinhood --file <path>  CSV import
 *   --source csv --file <path>        Generic CSV import
 *   --source eth|polygon|base|...     EVM sync via Alchemy
 */

import { readFileSync } from 'node:fs';
import { createRepo, openDatabase } from '@daybook/ledger';
import type { Repo } from '@daybook/ledger';
import { binance, bybit, coinbase, cryptoCom, gemini, genericCsv, kraken, okx, robinhood } from '@daybook/sources';
import type { BinanceCsvSource } from '@daybook/sources/binance';
import { syncCoinbaseApi as syncCoinbaseApiSource } from '@daybook/sources/coinbase';
import {
    AlchemyTransferProvider,
    CHAIN_ID_BY_SOURCE,
    EtherscanTransferProvider,
    ingestEvm,
    resolveFromBlock,
} from '@daybook/sources/evm';
import type { Config } from '../config.js';
import { expandPath, loadConfig } from '../config.js';
import { renderCsvSyncOutput, renderEvmSyncOutput } from './SyncOutput.js';

export interface SyncOptions {
  source: string;
  file?: string;
  account?: string;
  config?: string;
  includeFailedGas?: boolean;
  from?: string;
}

export async function syncCommand(opts: SyncOptions): Promise<void> {
  const config = loadConfig(opts.config);
  const db = openDatabase(expandPath(config.dbPath));
  const repo = createRepo(db.raw);

  try {
    // Guard: --from is only supported for API-backed syncs.
    if (opts.from && isCsvOnlySync(opts)) {
      throw new Error(
        `\`--from\` is not supported for ${formatCsvSourceName(opts.source)} CSV imports. Filter by date after import.`,
      );
    }

    switch (opts.source) {
      case 'binance':
      case 'binance-us':
        await syncBinance(opts, config, repo, opts.source);
        break;
      case 'bybit':
        await syncBybit(opts, config, repo);
        break;
      case 'coinbase':
        await syncCoinbase(opts, config, repo);
        break;
      case 'crypto-com':
        await syncCryptoCom(opts, config, repo);
        break;
      case 'gemini':
        await syncGemini(opts, config, repo);
        break;
      case 'kraken':
        await syncKraken(opts, config, repo);
        break;
      case 'okx':
        await syncOkx(opts, config, repo);
        break;
      case 'robinhood':
        await syncRobinhood(opts, config, repo);
        break;
      case 'csv':
        await syncGenericCsv(opts, config, repo);
        break;
      case 'eth':
      case 'polygon':
      case 'arbitrum':
      case 'base':
      case 'optimism':
      case 'bnb':
        await syncEvm(opts, config, repo);
        break;
      default:
        throw new Error(`Unknown source: ${opts.source}`);
    }
  } finally {
    db.close();
  }
}

function isCsvImportSource(source: string): boolean {
  return ['binance', 'binance-us', 'bybit', 'coinbase', 'crypto-com', 'gemini', 'kraken', 'okx', 'robinhood', 'csv'].includes(source);
}

function isCsvOnlySync(opts: SyncOptions): boolean {
  return isCsvImportSource(opts.source) && !(opts.source === 'coinbase' && !opts.file);
}

function formatCsvSourceName(source: string): string {
  switch (source) {
    case 'binance':
      return 'Binance';
    case 'binance-us':
      return 'Binance.US';
    case 'bybit':
      return 'Bybit';
    case 'coinbase':
      return 'Coinbase';
    case 'crypto-com':
      return 'Crypto.com';
    case 'gemini':
      return 'Gemini';
    case 'kraken':
      return 'Kraken';
    case 'okx':
      return 'OKX';
    case 'robinhood':
      return 'Robinhood';
    case 'csv':
      return 'Generic';
    default:
      return source;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Binance / Binance.US CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncBinance(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
  source: BinanceCsvSource,
): Promise<void> {
  const sourceName = formatCsvSourceName(source);
  if (!opts.file) {
    throw new Error(`${sourceName} sync requires --file <path-to-csv>`);
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === source)?.id;
  if (!accountId) {
    throw new Error(
      `No ${sourceName} account configured. Add one with \`daybook account add <id> --source ${source} --identifier <email>\` first.`,
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== source) {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not ${source}.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = binance.parseBinanceCsv(csvContents, { accountId, source });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: sourceName,
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Bybit CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncBybit(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Bybit sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'bybit')?.id;
  if (!accountId) {
    throw new Error(
      'No Bybit account configured. Add one with `daybook account add <id> --source bybit --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'bybit') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not bybit.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = bybit.parseBybitCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Bybit',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

async function syncCoinbase(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
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

  if (!opts.file) {
    await syncCoinbaseApi(opts, repo, accountId);
    return;
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
  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Coinbase',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    dbCounts,
  });
}

async function syncCoinbaseApi(
  opts: SyncOptions,
  repo: ReturnType<typeof createRepo>,
  accountId: string,
): Promise<void> {
  const keyName = process.env['COINBASE_CDP_KEY_NAME'];
  const privateKey = process.env['COINBASE_CDP_PRIVATE_KEY']
    ?? process.env['COINBASE_CDP_KEY_SECRET'];
  if (!keyName || !privateKey) {
    throw new Error(
      'COINBASE_CDP_KEY_NAME and COINBASE_CDP_PRIVATE_KEY environment variables are required for Coinbase API sync.',
    );
  }

  const from = resolveCoinbaseApiFrom(opts, repo, accountId);
  const result = await syncCoinbaseApiSource({
    accountId,
    credentials: { keyName, privateKey },
    ...(from ? { from } : {}),
  });

  const insertResult = repo.insertRawEvents(result.events);
  const lastSyncedAt = latestEventTimestamp(result.events)
    ?? Math.floor(Date.now() / 1000);
  repo.upsertSyncState({
    source: 'coinbase',
    accountId,
    lastSyncedAt,
  });

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Coinbase API',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

function resolveCoinbaseApiFrom(
  opts: SyncOptions,
  repo: ReturnType<typeof createRepo>,
  accountId: string,
): Date | undefined {
  if (opts.from) {
    const parsed = new Date(opts.from);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --from date for Coinbase API sync: ${opts.from}`);
    }
    return parsed;
  }

  const state = repo.getSyncState('coinbase', accountId);
  return state?.lastSyncedAt
    ? new Date(state.lastSyncedAt * 1000)
    : undefined;
}

function latestEventTimestamp(events: ReadonlyArray<{ timestamp: Date }>): number | undefined {
  if (events.length === 0) return undefined;
  return Math.max(...events.map(event => Math.floor(event.timestamp.getTime() / 1000)));
}

// ─────────────────────────────────────────────────────────────────────────
// Crypto.com CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncCryptoCom(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Crypto.com sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'crypto-com')?.id;
  if (!accountId) {
    throw new Error(
      'No Crypto.com account configured. Add one with `daybook account add <id> --source crypto-com --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'crypto-com') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not crypto-com.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = cryptoCom.parseCryptoComCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Crypto.com',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Gemini CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncGemini(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Gemini sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'gemini')?.id;
  if (!accountId) {
    throw new Error(
      'No Gemini account configured. Add one with `daybook account add <id> --source gemini --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'gemini') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not gemini.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = gemini.parseGeminiCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Gemini',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Kraken CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncKraken(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Kraken sync requires --file <path-to-csv>');
  }

  // Resolve account: explicit --account, or the first kraken account in config.
  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'kraken')?.id;
  if (!accountId) {
    throw new Error(
      'No Kraken account configured. Add one with `daybook account add <id> --source kraken --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'kraken') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not kraken.`,
    );
  }

  // Parse CSV
  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = kraken.parseKrakenCsv(csvContents, { accountId });

  // Persist
  const insertResult = repo.insertRawEvents(result.events);

  // Report
  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Kraken',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// OKX CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncOkx(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('OKX sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'okx')?.id;
  if (!accountId) {
    throw new Error(
      'No OKX account configured. Add one with `daybook account add <id> --source okx --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'okx') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not okx.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = okx.parseOkxCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'OKX',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Robinhood CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncRobinhood(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Robinhood sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'robinhood')?.id;
  if (!accountId) {
    throw new Error(
      'No Robinhood account configured. Add one with `daybook account add <id> --source robinhood --identifier <email>` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'robinhood') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not robinhood.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = robinhood.parseRobinhoodCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Robinhood',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Generic CSV sync
// ─────────────────────────────────────────────────────────────────────────

async function syncGenericCsv(
  opts: SyncOptions,
  config: ReturnType<typeof loadConfig>,
  repo: ReturnType<typeof createRepo>,
): Promise<void> {
  if (!opts.file) {
    throw new Error('Generic CSV sync requires --file <path-to-csv>');
  }

  const accountId = opts.account
    ?? config.accounts.find(a => a.source === 'csv')?.id;
  if (!accountId) {
    throw new Error(
      'No CSV account configured. Add one with `daybook account add <id> --source csv --identifier manual-ledger` first.',
    );
  }
  const account = repo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account "${accountId}" not found in DB. Was \`init\` run after the last config change?`);
  }
  if (account.source !== 'csv') {
    throw new Error(
      `Account "${accountId}" is on source "${account.source}", not csv.`,
    );
  }

  const csvContents = readFileSync(opts.file, 'utf-8');
  const result = genericCsv.parseGenericCsv(csvContents, { accountId });
  const insertResult = repo.insertRawEvents(result.events);

  const dbCounts = repo.countByType({ accountId });
  renderCsvSyncOutput({
    source: 'Generic CSV',
    accountId,
    totalRows: result.totalRows,
    eventCount: result.events.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    ...(result.unparsedRowCount > 0 ? { unparsedRows: result.unparsedRowCount } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    dbCounts,
  });
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

  // ─── Resolve --from to a block number ──────────────────────────────
  let fromBlock: bigint | undefined;
  let fromBlockInfo: { blockNumber: bigint; date: string } | undefined;
  if (opts.from) {
    const resolved = await resolveFromBlock(opts.from, chainId, apiKey);
    fromBlock = resolved.blockNumber;
    fromBlockInfo = {
      blockNumber: resolved.blockNumber,
      date: resolved.timestamp.toISOString().slice(0, 10),
    };
  }

  const { events, stats } = await ingestEvm({
    provider,
    address: account.identifier,
    chainId,
    accountId,
    source: account.source,
    ...(fromBlock !== undefined ? { fromBlock } : {}),
  });

  // ─── Failed-tx gas via Etherscan ───────────────────────────────────
  const allEvents = [...events];
  let failedGasCount = 0;

  if (opts.includeFailedGas) {
    const etherscanKey = process.env['ETHERSCAN_API_KEY'];
    if (!etherscanKey) {
      throw new Error(
        'ETHERSCAN_API_KEY environment variable is required for --include-failed-gas. ' +
        'Get a free key at https://etherscan.io/apis',
      );
    }

    const etherscanProvider = new EtherscanTransferProvider(etherscanKey, chainId);
    const { events: failedEvents, stats: failedStats } = await ingestEvm({
      provider: etherscanProvider,
      address: account.identifier,
      chainId,
      accountId,
      source: account.source,
      ...(fromBlock !== undefined ? { fromBlock } : {}),
    });

    allEvents.push(...failedEvents);
    failedGasCount = failedStats.native;
  }

  const insertResult = repo.insertRawEvents(allEvents);

  const dbCounts = repo.countByType({ accountId });
  renderEvmSyncOutput({
    source: opts.source,
    accountId,
    eventCount: allEvents.length,
    inserted: insertResult.inserted,
    skipped: insertResult.skipped,
    stats,
    ...(failedGasCount > 0 ? { failedGasCount } : {}),
    ...(fromBlockInfo ? { fromBlock: fromBlockInfo } : {}),
    dbCounts,
  });
}
