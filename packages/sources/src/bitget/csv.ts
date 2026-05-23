/**
 * Bitget exchange CSV parser.
 *
 * Bitget has no unified ledger — exports are siloed by product. This
 * adapter targets the three CSVs most spot users need:
 *
 *   - **trades** — Spot order/trade history. Two coexisting header
 *     conventions are recognized:
 *       * UI export: `Order ID, Trading Pair, Side, Filled Price,
 *         Filled Amount, Total, Fee, Fee Currency, Order Time, Order Type`
 *       * API-style export: `orderId, symbol, side, priceAvg, size,
 *         baseVolume, quoteVolume, fee, feeCurrency, cTime`
 *     Bitget emits one row per fill; rows that share an `Order ID` are
 *     grouped into a single trade event with summed legs.
 *
 *   - **deposits** — Headers vary, but `Coin, Amount, TXID, Time, Status`
 *     are the load-bearing fields. Only `success` rows produce events.
 *
 *   - **withdrawals** — `Coin, Amount, TXID, Time, Status, Fee`. Only
 *     `success` rows; `Fee` is added as a fee leg in the same asset.
 *
 * Spot pair symbols are concatenated (`BTCUSDT`) and may carry legacy
 * product suffixes (`BTCUSDT_SPBL`). The parser strips suffixes from
 * `_` onward, then peels a known quote ticker off the end.
 *
 * Timestamps may be `yyyy-MM-dd HH:mm:ss` (UI export, UTC) or 13-digit
 * Unix milliseconds (API export). Both forms are accepted.
 */

import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';

export type BitgetCsvRow = Record<string, string>;

export interface ParseBitgetOptions {
  accountId: string;
}

export interface ParseBitgetResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

interface NormalizedRow {
  rowNumber: number;
  original: BitgetCsvRow;
  values: Record<string, string>;
}

type Profile = 'trades' | 'deposits' | 'withdrawals';

// Trade headers — either UI export ("filled amount") or API-style ("size", "basevolume")
const TRADE_REQUIRED = ['side'];
const TRADE_ID_KEYS = ['orderid', 'order id'];
const TRADE_PAIR_KEYS = ['trading pair', 'symbol', 'tradingpair'];

const DEPOSIT_REQUIRED = ['coin', 'amount', 'time', 'status'];
const DEPOSIT_DISCRIMINATOR_KEYS = ['from address', 'fromaddress'];

const WITHDRAWAL_REQUIRED = ['coin', 'amount', 'time', 'status'];
const WITHDRAWAL_DISCRIMINATOR_KEYS = ['to address', 'toaddress', 'fee'];

const FIAT_CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'CHF',
  'CNY',
  'HKD',
  'SGD',
]);

const QUOTE_CANDIDATES = [
  ...FIAT_CURRENCIES,
  'USDT',
  'USDC',
  'BUSD',
  'DAI',
  'TUSD',
  'BTC',
  'ETH',
];

const SUCCESS_STATUSES = new Set(['success', 'successful', 'completed', 'credited successfully']);

// ─── Entry point ─────────────────────────────────────────────────────────

export function parseBitgetCsv(
  contents: string,
  options: ParseBitgetOptions,
): ParseBitgetResult {
  const rows = parseRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (rows.length > 0 && !profile) {
    throw new Error(
      'Bitget CSV header not recognized. Expected spot trade history (Order ID, Trading Pair, Side, Filled Amount, Total, Fee), deposit history (Coin, Amount, Time, Status, From Address), or withdrawal history (Coin, Amount, Time, Status, To Address, Fee).',
    );
  }

  if (profile === 'trades') {
    const { events: tradeEvents, unparsed } = buildTradeEvents(rows, options.accountId, warnings);
    events.push(...tradeEvents);
    unparsedRowCount += unparsed;
  } else if (profile === 'deposits') {
    for (const row of rows) {
      const event = buildDepositEvent(row, options.accountId, warnings);
      if (event) events.push(event);
      else unparsedRowCount++;
    }
  } else if (profile === 'withdrawals') {
    for (const row of rows) {
      const event = buildWithdrawalEvent(row, options.accountId, warnings);
      if (event) events.push(event);
      else unparsedRowCount++;
    }
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    events: suffixDuplicateIds(events),
    totalRows: rows.length,
    unparsedRowCount,
    warnings,
  };
}

// ─── Row parsing ─────────────────────────────────────────────────────────

function parseRows(contents: string): NormalizedRow[] {
  const records = parseCsv(contents, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as BitgetCsvRow[];

  return records.map((record, index) => {
    const values: Record<string, string> = {};
    for (const [header, rawValue] of Object.entries(record)) {
      values[normalizeHeader(header)] = String(rawValue ?? '').trim();
    }
    return {
      rowNumber: index + 2,
      original: record,
      values,
    };
  });
}

function detectProfile(rows: NormalizedRow[]): Profile | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const headers = new Set(Object.keys(first.values));

  const has = (alias: string) => headers.has(normalizeHeader(alias));
  const hasAny = (aliases: string[]) => aliases.some((a) => has(a));

  // Withdrawals first (most specific: has a fee column on top of common keys)
  if (
    WITHDRAWAL_REQUIRED.every((k) => has(k)) &&
    hasAny(WITHDRAWAL_DISCRIMINATOR_KEYS)
  ) {
    return 'withdrawals';
  }

  if (
    DEPOSIT_REQUIRED.every((k) => has(k)) &&
    hasAny(DEPOSIT_DISCRIMINATOR_KEYS)
  ) {
    return 'deposits';
  }

  if (
    TRADE_REQUIRED.every((k) => has(k)) &&
    hasAny(TRADE_ID_KEYS) &&
    hasAny(TRADE_PAIR_KEYS)
  ) {
    return 'trades';
  }

  return undefined;
}

// ─── Trade events — grouped by Order ID ─────────────────────────────────

function buildTradeEvents(
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): { events: RawEvent[]; unparsed: number } {
  const groups = new Map<string, NormalizedRow[]>();
  const orderless: NormalizedRow[] = [];

  for (const row of rows) {
    const orderId = pick(row, ['order id', 'orderid']);
    if (!orderId) {
      orderless.push(row);
      continue;
    }
    const list = groups.get(orderId);
    if (list) list.push(row);
    else groups.set(orderId, [row]);
  }

  const events: RawEvent[] = [];
  let unparsed = 0;

  for (const [orderId, groupRows] of groups) {
    const event = buildTradeGroup(orderId, groupRows, accountId, warnings);
    if (event) events.push(event);
    else unparsed += groupRows.length;
  }

  for (const row of orderless) {
    warnings.push(`Row ${row.rowNumber} skipped: Bitget trade row missing Order ID`);
    unparsed++;
  }

  return { events, unparsed };
}

function buildTradeGroup(
  orderId: string,
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  let earliest: Date | undefined;
  let symbol: string | undefined;
  let side: string | undefined;
  let baseTotal = new Decimal(0);
  let quoteTotal = new Decimal(0);
  const feeBuckets = new Map<string, Decimal>();

  for (const row of rows) {
    const timeStr = pick(row, ['order time', 'ordertime', 'time', 'ctime']);
    const ts = timeStr ? parseTimestamp(timeStr) : undefined;
    if (ts && (!earliest || ts < earliest)) earliest = ts;

    const sym = pick(row, ['trading pair', 'symbol', 'tradingpair']);
    if (sym && !symbol) symbol = sym;

    const sideRaw = pick(row, ['side']);
    if (sideRaw && !side) side = sideRaw.toLowerCase();

    const base = parseAmount(pick(row, ['filled amount', 'filledamount', 'size', 'basevolume', 'base volume']));
    const quote = parseAmount(pick(row, ['total', 'quotevolume', 'quote volume']));
    const fee = parseAmount(pick(row, ['fee']));
    const feeCurrency = normalizeAsset(pick(row, ['fee currency', 'feecurrency']));

    if (base) baseTotal = baseTotal.plus(base.abs());
    if (quote) quoteTotal = quoteTotal.plus(quote.abs());
    if (fee && feeCurrency) {
      const current = feeBuckets.get(feeCurrency) ?? new Decimal(0);
      feeBuckets.set(feeCurrency, current.plus(fee.abs()));
    }
  }

  if (!earliest) {
    warnings.push(`Bitget trade order ${orderId} skipped: no parsable timestamps`);
    return undefined;
  }
  if (!symbol) {
    warnings.push(`Bitget trade order ${orderId} skipped: missing Trading Pair`);
    return undefined;
  }

  const { base: baseAsset, quote: quoteAsset } = parsePair(symbol);
  if (!baseAsset || !quoteAsset) {
    warnings.push(`Bitget trade order ${orderId} skipped: symbol "${symbol}" not recognized`);
    return undefined;
  }
  if (baseTotal.isZero() || quoteTotal.isZero()) {
    warnings.push(`Bitget trade order ${orderId} skipped: zero base or quote total`);
    return undefined;
  }

  const isBuy = side === 'buy' || side === '买入';
  const legs: AssetLeg[] = [];
  legs.push(assetLeg(baseAsset, isBuy ? baseTotal : baseTotal.negated()));
  legs.push(assetLeg(quoteAsset, isBuy ? quoteTotal.negated() : quoteTotal));
  for (const [feeAsset, feeAmount] of feeBuckets) {
    if (feeAmount.isZero()) continue;
    legs.push(assetLeg(feeAsset, feeAmount.negated(), true));
  }

  return {
    id: `bitget:order:${sanitizeNativeId(orderId)}`,
    source: 'bitget',
    accountId,
    timestamp: earliest,
    type: 'trade',
    legs,
    notes: `${side ?? ''} ${symbol}`.trim(),
    raw: { orderId, rows: rows.map((r) => r.original) } as unknown as Record<string, unknown>,
  };
}

// ─── Deposits ────────────────────────────────────────────────────────────

function buildDepositEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const status = (pick(row, ['status']) ?? '').toLowerCase();
  if (status && !SUCCESS_STATUSES.has(status)) {
    return undefined;
  }

  const timeStr = pick(row, ['time', 'ctime']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: Bitget deposit row missing Time`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['coin', 'currency', 'asset']));
  const amount = parseAmount(pick(row, ['amount']));
  const txId = pick(row, ['txid', 'tx id', 'tx hash']);

  if (!coin || !amount) {
    warnings.push(`Row ${row.rowNumber} skipped: Bitget deposit row missing Coin or Amount`);
    return undefined;
  }

  return {
    id: txId
      ? `bitget:deposit:${sanitizeNativeId(txId)}`
      : `bitget:deposit:${hashRows([row.original])}`,
    source: 'bitget',
    accountId,
    timestamp,
    type: FIAT_CURRENCIES.has(coin) ? 'fiat_deposit' : 'crypto_in',
    legs: [assetLeg(coin, amount.abs())],
    ...(txId ? { txHash: txId } : {}),
    raw: row.original,
  };
}

// ─── Withdrawals ─────────────────────────────────────────────────────────

function buildWithdrawalEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const status = (pick(row, ['status']) ?? '').toLowerCase();
  if (status && !SUCCESS_STATUSES.has(status)) {
    return undefined;
  }

  const timeStr = pick(row, ['time', 'ctime']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: Bitget withdrawal row missing Time`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['coin', 'currency', 'asset']));
  const amount = parseAmount(pick(row, ['amount']));
  const fee = parseAmount(pick(row, ['fee']));
  const txId = pick(row, ['txid', 'tx id', 'tx hash']);

  if (!coin || !amount) {
    warnings.push(`Row ${row.rowNumber} skipped: Bitget withdrawal row missing Coin or Amount`);
    return undefined;
  }

  const legs: AssetLeg[] = [assetLeg(coin, amount.abs().negated())];
  if (fee && fee.abs().gt(0)) {
    legs.push(assetLeg(coin, fee.abs().negated(), true));
  }

  return {
    id: txId
      ? `bitget:withdrawal:${sanitizeNativeId(txId)}`
      : `bitget:withdrawal:${hashRows([row.original])}`,
    source: 'bitget',
    accountId,
    timestamp,
    type: FIAT_CURRENCIES.has(coin) ? 'fiat_withdrawal' : 'crypto_out',
    legs,
    ...(txId ? { txHash: txId } : {}),
    raw: row.original,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a Bitget spot symbol: strip legacy product suffixes
 * (`_SPBL`, `_UMCBL`, `_DMCBL`) and peel a known quote ticker off the
 * concatenated form.
 */
function parsePair(value: string): { base?: string; quote?: string } {
  const stripped = value.trim().toUpperCase().split('_')[0]!;
  const delimited = stripped.split(/[-/\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    const [base, quote] = delimited;
    const out: { base?: string; quote?: string } = {};
    if (base) out.base = base;
    if (quote) out.quote = quote;
    return out;
  }
  const normalized = stripped.replace(/[^A-Z0-9]+/g, '');
  const quote = QUOTE_CANDIDATES.find(
    (c) => normalized.length > c.length && normalized.endsWith(c),
  );
  if (!quote) return {};
  return { base: normalized.slice(0, -quote.length), quote };
}

function assetLeg(asset: string, amount: Decimal, feeFlag = false): AssetLeg {
  return {
    asset,
    amount: amount.toFixed(),
    ...(feeFlag ? { feeFlag: true } : {}),
  };
}

function pick(row: NormalizedRow, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = row.values[normalizeHeader(alias)];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function parseAmount(value: string | undefined): Decimal | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return undefined;
  const negativeByParens = trimmed.startsWith('(') && trimmed.endsWith(')');
  const sanitized = trimmed
    .replace(/^\((.*)\)$/, '$1')
    .replace(/[$£€¥,\s]/g, '');
  if (!sanitized) return undefined;
  try {
    const decimal = new Decimal(sanitized);
    return negativeByParens ? decimal.negated() : decimal;
  } catch {
    return undefined;
  }
}

/**
 * Accepts `yyyy-MM-dd HH:mm:ss` UTC (UI export) or 13-digit Unix ms
 * (API export). Returns `undefined` on unparsable input.
 */
function parseTimestamp(value: string): Date | undefined {
  const trimmed = value.trim().replace(/\r$/, '');
  if (!trimmed) return undefined;
  // 13-digit Unix ms
  if (/^\d{13}$/.test(trimmed)) {
    const ms = Number(trimmed);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // "2024-01-15 12:34:56" → "2024-01-15T12:34:56Z"
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}${hasTimeZone(trimmed) ? '' : 'Z'}`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function hasTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function normalizeAsset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^﻿/, '')
    .replace(/\r$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function suffixDuplicateIds(events: RawEvent[]): RawEvent[] {
  const counts = new Map<string, number>();
  return events.map((event) => {
    const count = counts.get(event.id) ?? 0;
    counts.set(event.id, count + 1);
    return count === 0 ? event : { ...event, id: `${event.id}:${count + 1}` };
  });
}

function sanitizeNativeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return sanitized || hashRows([{ value }]);
}

function hashRows(rows: BitgetCsvRow[]): string {
  const stable = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => `${key}=${row[key] ?? ''}`)
        .join('\n'),
    )
    .join('\n---\n');
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}
