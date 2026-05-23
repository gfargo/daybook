/**
 * MEXC exchange CSV parser.
 *
 * MEXC delivers transaction data as separate files per category — there
 * is no combined ledger. This parser auto-detects four profiles by
 * header signature:
 *
 *   - **trades** — Spot Trade History. One row per fill aggregate.
 *     Headers: `[UID,] Pairs, Time, Side, Filled Price, Executed Amount,
 *     Total, Fee, Role`. The `Fee` column packs an amount and ticker
 *     into one cell (e.g., "0.12345USDT"); we split it. Fees are always
 *     denominated in the quote asset.
 *
 *   - **orders** — Spot Order History. Headers include `Type, Direction,
 *     Filled Quantity, Order Amount, Status`. Used when a user only has
 *     order history (no fees recorded).
 *
 *   - **deposits** — Headers: `UID, Status, Time, Crypto, Network,
 *     Deposit Amount, TxID, Progress`. Only `Status == "Credited
 *     Successfully"` rows produce events.
 *
 *   - **withdrawals** — Headers: `UID, Status, Time, Crypto, Network,
 *     Request Amount, Withdrawal Address, memo, TxID, Trading Fee,
 *     Settlement Amount, Withdrawal Descriptions`. Only `Status ==
 *     "Withdrawal Successful"` rows produce events. The withdrawal
 *     amount is the `Settlement Amount` (post-fee) and the `Trading
 *     Fee` (same asset as `Crypto`) is added as a fee leg.
 *
 * Timestamps are `yyyy-MM-dd HH:mm:ss` UTC. Spot pairs are concatenated
 * (`BTCUSDT`) or underscore-separated (`BTC_USDT`); the parser splits
 * on underscore first, then peels a known quote ticker off the end.
 */

import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';

export type MexcCsvRow = Record<string, string>;

export interface ParseMexcOptions {
  accountId: string;
}

export interface ParseMexcResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

interface NormalizedRow {
  rowNumber: number;
  original: MexcCsvRow;
  values: Record<string, string>;
}

type Profile = 'trades' | 'orders' | 'deposits' | 'withdrawals';

const TRADE_HEADERS = ['pairs', 'side', 'filledprice', 'executedamount', 'total'];
const ORDER_HEADERS = ['pairs', 'direction', 'filledquantity', 'orderamount', 'status'];
const DEPOSIT_HEADERS = ['status', 'crypto', 'depositamount', 'txid'];
const WITHDRAWAL_HEADERS = [
  'status',
  'crypto',
  'requestamount',
  'tradingfee',
  'settlementamount',
];

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
  'BRL',
]);

const QUOTE_CANDIDATES = [
  ...FIAT_CURRENCIES,
  'USDT',
  'USDC',
  'USDE',
  'USDF',
  'USD1',
  'TUSD',
  'FDUSD',
  'PYUSD',
  'DAI',
  'BTC',
  'ETH',
  'BNB',
];

const DEPOSIT_SUCCESS_STATUSES = new Set([
  'credited successfully',
  'completed',
  'success',
  'successful',
]);

const WITHDRAWAL_SUCCESS_STATUSES = new Set([
  'withdrawal successful',
  'completed',
  'success',
  'successful',
]);

// ─── Entry point ─────────────────────────────────────────────────────────

export function parseMexcCsv(
  contents: string,
  options: ParseMexcOptions,
): ParseMexcResult {
  const rows = parseRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (rows.length > 0 && !profile) {
    throw new Error(
      'MEXC CSV header not recognized. Expected spot trade history (Pairs, Side, Filled Price, Executed Amount, Total), spot order history (Pairs, Direction, Filled Quantity, Order Amount, Status), deposit history (Status, Crypto, Deposit Amount, TxID), or withdrawal history (Status, Crypto, Request Amount, Trading Fee, Settlement Amount).',
    );
  }

  for (const row of rows) {
    let event: RawEvent | undefined;
    if (profile === 'trades') event = buildTradeEvent(row, options.accountId, warnings);
    else if (profile === 'orders') event = buildOrderEvent(row, options.accountId, warnings);
    else if (profile === 'deposits') event = buildDepositEvent(row, options.accountId, warnings);
    else if (profile === 'withdrawals') event = buildWithdrawalEvent(row, options.accountId, warnings);

    if (event) events.push(event);
    else unparsedRowCount++;
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
  }) as MexcCsvRow[];

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
  // Order check matters: 'orders' has 'pairs' + 'status' but no 'crypto'.
  // 'deposits' / 'withdrawals' both have 'crypto'. Disambiguate by withdrawal-specific fields.
  if (WITHDRAWAL_HEADERS.every((h) => headers.has(h))) return 'withdrawals';
  if (DEPOSIT_HEADERS.every((h) => headers.has(h))) return 'deposits';
  if (TRADE_HEADERS.every((h) => headers.has(h))) return 'trades';
  if (ORDER_HEADERS.every((h) => headers.has(h))) return 'orders';
  return undefined;
}

// ─── Spot trade history ─────────────────────────────────────────────────

function buildTradeEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const timeStr = pick(row, ['time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC trade row missing Time`);
    return undefined;
  }

  const pair = pick(row, ['pairs', 'pair']);
  const side = (pick(row, ['side']) ?? '').toLowerCase();
  const filledAmount = parseAmount(pick(row, ['executed amount', 'executedamount', 'filled amount']));
  const total = parseAmount(pick(row, ['total']));
  const feeRaw = pick(row, ['fee']);

  if (!pair || !filledAmount || !total) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC trade row missing pair/amount/total`);
    return undefined;
  }

  const { base, quote } = parsePair(pair);
  if (!base || !quote) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC pair "${pair}" not recognized`);
    return undefined;
  }

  const isBuy = side === 'buy';
  const legs: AssetLeg[] = [];
  legs.push(assetLeg(base, isBuy ? filledAmount.abs() : filledAmount.abs().negated()));
  legs.push(assetLeg(quote, isBuy ? total.abs().negated() : total.abs()));

  // Fee: packed string "0.12345USDT" or bare number (always quote asset).
  if (feeRaw) {
    const fee = parsePackedFee(feeRaw, quote);
    if (fee && fee.amount.abs().gt(0)) {
      legs.push(assetLeg(fee.asset, fee.amount.abs().negated(), true));
    }
  }

  // ID uses only the load-bearing fields (not the full row) so that a
  // future MEXC export which adds or reorders columns still produces
  // stable IDs for the same logical trade.
  const idSeed = `${pair}|${timestamp.toISOString()}|${side}|${baseAmount(filledAmount)}|${baseAmount(total)}|${feeRaw ?? ''}`;
  return {
    id: `mexc:trade:${hashString(idSeed)}`,
    source: 'mexc',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    notes: `${side} ${pair}`.trim(),
    raw: row.original,
  };
}

function baseAmount(d: Decimal): string {
  return d.toFixed();
}

function hashString(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Parse a MEXC packed fee cell like "0.12345USDT" or "0.12345".
 *
 * Returns `undefined` if the value is empty or unparsable. When the cell
 * is bare numeric (no trailing ticker), uses `defaultAsset` (the quote
 * currency) per MEXC's documented behavior.
 */
function parsePackedFee(
  value: string,
  defaultAsset: string,
): { amount: Decimal; asset: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9]*)?$/.exec(trimmed);
  if (!match) return undefined;
  const amount = parseAmount(match[1]);
  if (!amount) return undefined;
  const asset = match[2] ? normalizeAsset(match[2])! : defaultAsset;
  return { amount, asset };
}

// ─── Spot order history (no fees) ───────────────────────────────────────

function buildOrderEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const statusRaw = (pick(row, ['status']) ?? '').toLowerCase();
  if (statusRaw && !statusRaw.includes('filled') && !statusRaw.includes('success')) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC order status "${statusRaw}" is not Filled/Successful`);
    return undefined;
  }

  const timeStr = pick(row, ['time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC order row missing Time`);
    return undefined;
  }

  const pair = pick(row, ['pairs', 'pair']);
  const direction = (pick(row, ['direction', 'side']) ?? '').toLowerCase();
  const filledQty = parseAmount(pick(row, ['filled quantity', 'filledquantity']));
  const orderAmount = parseAmount(pick(row, ['order amount', 'orderamount', 'total']));

  if (!pair || !filledQty || !orderAmount || filledQty.isZero()) {
    return undefined;
  }

  const { base, quote } = parsePair(pair);
  if (!base || !quote) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC pair "${pair}" not recognized`);
    return undefined;
  }

  const isBuy = direction === 'buy';
  const legs: AssetLeg[] = [];
  legs.push(assetLeg(base, isBuy ? filledQty.abs() : filledQty.abs().negated()));
  legs.push(assetLeg(quote, isBuy ? orderAmount.abs().negated() : orderAmount.abs()));

  const idSeed = `${pair}|${timestamp.toISOString()}|${direction}|${baseAmount(filledQty)}|${baseAmount(orderAmount)}`;
  return {
    id: `mexc:order:${hashString(idSeed)}`,
    source: 'mexc',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    notes: `${direction} ${pair}`.trim(),
    raw: row.original,
  };
}

// ─── Deposits ────────────────────────────────────────────────────────────

function buildDepositEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const status = (pick(row, ['status']) ?? '').toLowerCase();
  if (status && !DEPOSIT_SUCCESS_STATUSES.has(status)) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC deposit status "${status}" is not a success state`);
    return undefined;
  }

  const timeStr = pick(row, ['time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC deposit row missing Time`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['crypto', 'coin', 'currency']));
  const amount = parseAmount(pick(row, ['deposit amount', 'depositamount', 'amount']));
  const txId = pick(row, ['txid', 'tx id', 'tx hash']);

  if (!coin || !amount) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC deposit row missing Crypto or Amount`);
    return undefined;
  }

  const legs: AssetLeg[] = [assetLeg(coin, amount.abs())];

  return {
    id: txId
      ? `mexc:deposit:${sanitizeNativeId(txId)}`
      : `mexc:deposit:${hashRows([row.original])}`,
    source: 'mexc',
    accountId,
    timestamp,
    type: FIAT_CURRENCIES.has(coin) ? 'fiat_deposit' : 'crypto_in',
    legs,
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
  if (status && !WITHDRAWAL_SUCCESS_STATUSES.has(status)) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC withdrawal status "${status}" is not a success state`);
    return undefined;
  }

  const timeStr = pick(row, ['time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC withdrawal row missing Time`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['crypto', 'coin', 'currency']));
  const settlement = parseAmount(pick(row, ['settlement amount', 'settlementamount']));
  const request = parseAmount(pick(row, ['request amount', 'requestamount']));
  const fee = parseAmount(pick(row, ['trading fee', 'tradingfee', 'fee']));
  const txId = pick(row, ['txid', 'tx id', 'tx hash']);

  if (!coin || (!settlement && !request)) {
    warnings.push(`Row ${row.rowNumber} skipped: MEXC withdrawal row missing Crypto or amount`);
    return undefined;
  }

  // Prefer Settlement Amount (post-fee) as the principal outbound leg.
  const principal = settlement ?? request!;
  const legs: AssetLeg[] = [assetLeg(coin, principal.abs().negated())];
  if (fee && fee.abs().gt(0)) {
    legs.push(assetLeg(coin, fee.abs().negated(), true));
  }

  return {
    id: txId
      ? `mexc:withdrawal:${sanitizeNativeId(txId)}`
      : `mexc:withdrawal:${hashRows([row.original])}`,
    source: 'mexc',
    accountId,
    timestamp,
    type: FIAT_CURRENCIES.has(coin) ? 'fiat_withdrawal' : 'crypto_out',
    legs,
    ...(txId ? { txHash: txId } : {}),
    raw: row.original,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parsePair(value: string): { base?: string; quote?: string } {
  const upper = value.trim().toUpperCase();
  // Try common delimiters first
  const delimited = upper.split(/[-/_\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    const [base, quote] = delimited;
    const out: { base?: string; quote?: string } = {};
    if (base) out.base = base;
    if (quote) out.quote = quote;
    return out;
  }
  // Concatenated form, peel a known quote off the end
  const normalized = upper.replace(/[^A-Z0-9]+/g, '');
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

function parseTimestamp(value: string): Date | undefined {
  const trimmed = value.trim().replace(/\r$/, '');
  if (!trimmed) return undefined;
  // MEXC format: "2024-01-15 12:34:56" (UTC, no offset)
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

function hashRows(rows: MexcCsvRow[]): string {
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
