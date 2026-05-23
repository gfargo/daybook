/**
 * Bybit exchange CSV parser.
 *
 * Handles the spot-trading and asset-movement CSVs Bybit users download
 * from Account → Data Export. Three profiles are recognized:
 *
 *   - **trades-spot** — `Bybit_unifiedAccount_spotTradeHistory.csv` (UTA)
 *     or `Bybit_spotOrders_spotTradeHistory.csv` (Classic). Bybit emits
 *     one row per partial fill; rows that share an `Order ID` are
 *     grouped into a single trade event.
 *
 *   - **funding-v2** — current Bybit asset deposit/withdrawal export
 *     with `Date & Time(UTC), Coin, QTY, Type, Account Balance, Description`.
 *     `Description` carries the directional label ("Deposit",
 *     "Withdrawal", "Transfer to/from Derivatives Account", etc.).
 *
 *   - **funding-v1** — legacy deposit/withdrawal export with `Type,
 *     Coin, Amount, Wallet Balance, Time(UTC)`. `Type` values are
 *     camelCase: `userDeposit`, `internalAccountTransferDeposit`,
 *     `internalAccountTransferWithdrawal`.
 *
 * Bybit timestamps are UTC `YYYY-MM-DD HH:MM:SS`. Spot pair symbols are
 * concatenated (`BTCUSDT`) with no separator; the parser peels a known
 * quote ticker off the end. Derivatives/perp rows in spot exports are
 * skipped — daybook is spot/transfer focused.
 */

import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';
import {
  FIAT_CURRENCIES,
  assetLeg,
  hashRows,
  normalizeAsset,
  parseAmount,
  parseCsvRows,
  parseTimestamp,
  pick,
  sanitizeNativeId,
  suffixDuplicateIds,
  type CsvRow,
  type NormalizedRow,
} from '../_shared/csv-helpers.js';

export type BybitCsvRow = CsvRow;

export interface ParseBybitOptions {
  accountId: string;
}

export interface ParseBybitResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

type Profile = 'trades-spot' | 'funding-v2' | 'funding-v1';

const TRADES_SPOT_HEADERS = ['orderid', 'symbol', 'side', 'quantity', 'execvalue'];
const FUNDING_V2_HEADERS = ['datetimeutc', 'coin', 'qty', 'type', 'description'];
const FUNDING_V1_HEADERS = ['type', 'coin', 'amount', 'walletbalance', 'timeutc'];

const QUOTE_CANDIDATES = [
  ...FIAT_CURRENCIES,
  'USDT',
  'USDC',
  'USDK',
  'TUSD',
  'FDUSD',
  'PYUSD',
  'DAI',
  'BTC',
  'ETH',
  'BNB',
];

// ─── Entry point ─────────────────────────────────────────────────────────

export function parseBybitCsv(
  contents: string,
  options: ParseBybitOptions,
): ParseBybitResult {
  const rows = parseCsvRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (rows.length > 0 && !profile) {
    throw new Error(
      'Bybit CSV header not recognized. Expected spot trade history (Order ID, Symbol, Side, Quantity, Exec Value), funding v2 (Date & Time(UTC), Coin, QTY, Type, Description), or funding v1 (Type, Coin, Amount, Wallet Balance, Time(UTC)).',
    );
  }

  if (profile === 'trades-spot') {
    const { events: tradeEvents, unparsed } = buildSpotTradeEvents(rows, options.accountId, warnings);
    events.push(...tradeEvents);
    unparsedRowCount += unparsed;
  } else if (profile === 'funding-v2') {
    for (const row of rows) {
      const event = buildFundingV2Event(row, options.accountId, warnings);
      if (event) events.push(event);
      else unparsedRowCount++;
    }
  } else if (profile === 'funding-v1') {
    for (const row of rows) {
      const event = buildFundingV1Event(row, options.accountId, warnings);
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

// ─── Profile detection ──────────────────────────────────────────────────

function detectProfile(rows: NormalizedRow[]): Profile | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const headers = new Set(Object.keys(first.values));
  if (TRADES_SPOT_HEADERS.every((h) => headers.has(h))) return 'trades-spot';
  if (FUNDING_V2_HEADERS.every((h) => headers.has(h))) return 'funding-v2';
  if (FUNDING_V1_HEADERS.every((h) => headers.has(h))) return 'funding-v1';
  return undefined;
}

// ─── Spot trades — multi-row grouped by Order ID ────────────────────────

function buildSpotTradeEvents(
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
    const event = buildSpotTradeGroup(orderId, groupRows, accountId, warnings);
    if (event) events.push(event);
    else unparsed += groupRows.length;
  }

  for (const row of orderless) {
    warnings.push(`Row ${row.rowNumber} skipped: Bybit spot trade row missing Order ID`);
    unparsed++;
  }

  return { events, unparsed };
}

function buildSpotTradeGroup(
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
    const timeStr = pick(row, ['filled time', 'time', 'trade time']);
    const ts = timeStr ? parseTimestamp(timeStr) : undefined;
    if (ts && (!earliest || ts < earliest)) earliest = ts;

    const sym = pick(row, ['symbol']);
    if (sym && !symbol) symbol = sym;

    const sideRaw = pick(row, ['side']);
    if (sideRaw && !side) side = sideRaw.toLowerCase();

    const qty = parseAmount(pick(row, ['quantity', 'qty']));
    const execValue = parseAmount(pick(row, ['exec value', 'execvalue']));
    const fee = parseAmount(pick(row, ['fee']));
    const feeCurrency = normalizeAsset(pick(row, ['fee currency', 'feecurrency']));

    if (qty) baseTotal = baseTotal.plus(qty.abs());
    if (execValue) quoteTotal = quoteTotal.plus(execValue.abs());
    if (fee && feeCurrency) {
      const current = feeBuckets.get(feeCurrency) ?? new Decimal(0);
      feeBuckets.set(feeCurrency, current.plus(fee.abs()));
    }
  }

  if (!earliest) {
    warnings.push(`Bybit spot trade order ${orderId} skipped: no parsable Filled Time`);
    return undefined;
  }
  if (!symbol) {
    warnings.push(`Bybit spot trade order ${orderId} skipped: missing Symbol`);
    return undefined;
  }

  const { base, quote } = parsePair(symbol);
  if (!base || !quote) {
    warnings.push(`Bybit spot trade order ${orderId} skipped: symbol "${symbol}" not recognized`);
    return undefined;
  }
  if (baseTotal.isZero() || quoteTotal.isZero()) {
    warnings.push(`Bybit spot trade order ${orderId} skipped: zero quantity or exec value`);
    return undefined;
  }

  const isBuy = side === 'buy';
  const legs: AssetLeg[] = [];
  legs.push(assetLeg(base, isBuy ? baseTotal : baseTotal.negated()));
  legs.push(assetLeg(quote, isBuy ? quoteTotal.negated() : quoteTotal));
  for (const [feeAsset, feeAmount] of feeBuckets) {
    if (feeAmount.isZero()) continue;
    legs.push(assetLeg(feeAsset, feeAmount.negated(), true));
  }

  return {
    id: `bybit:order:${sanitizeNativeId(orderId)}`,
    source: 'bybit',
    accountId,
    timestamp: earliest,
    type: 'trade',
    legs,
    notes: `${side ?? ''} ${symbol}`.trim(),
    raw: { orderId, rows: rows.map((r) => r.original) } as unknown as Record<string, unknown>,
  };
}

// ─── Funding v2 — current deposit/withdrawal export ─────────────────────

function buildFundingV2Event(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const timeStr = pick(row, ['date & time(utc)', 'date time utc', 'date and time utc', 'datetimeutc']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: Bybit funding row missing Date & Time(UTC)`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['coin', 'currency']));
  const qty = parseAmount(pick(row, ['qty', 'quantity', 'amount']));
  const description = (pick(row, ['description']) ?? '').toLowerCase();
  const type = (pick(row, ['type']) ?? '').toLowerCase();

  if (!coin || !qty) {
    warnings.push(`Row ${row.rowNumber} skipped: Bybit funding row missing Coin or QTY`);
    return undefined;
  }

  const signed = directionFromBybitDescription(description, type, qty);
  const legs: AssetLeg[] = [assetLeg(coin, signed)];

  return {
    id: `bybit:funding:${hashRows([row.original])}`,
    source: 'bybit',
    accountId,
    timestamp,
    type: inferFundingEventType(description, type, coin, signed),
    legs,
    ...(description ? { notes: description } : type ? { notes: type } : {}),
    raw: row.original,
  };
}

// ─── Funding v1 — legacy deposit/withdrawal export ──────────────────────

function buildFundingV1Event(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const timeStr = pick(row, ['time(utc)', 'time utc', 'timeutc']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: Bybit legacy funding row missing Time(UTC)`);
    return undefined;
  }

  const coin = normalizeAsset(pick(row, ['coin', 'currency']));
  const amount = parseAmount(pick(row, ['amount']));
  const type = (pick(row, ['type']) ?? '').toLowerCase();

  if (!coin || !amount) {
    warnings.push(`Row ${row.rowNumber} skipped: Bybit legacy funding row missing Coin or Amount`);
    return undefined;
  }

  const signed = directionFromBybitDescription(type, type, amount);
  const legs: AssetLeg[] = [assetLeg(coin, signed)];

  return {
    id: `bybit:funding:${hashRows([row.original])}`,
    source: 'bybit',
    accountId,
    timestamp,
    type: inferFundingEventType(type, type, coin, signed),
    legs,
    ...(type ? { notes: type } : {}),
    raw: row.original,
  };
}

// ─── Direction / type inference ─────────────────────────────────────────

function directionFromBybitDescription(
  description: string,
  type: string,
  amount: Decimal,
): Decimal {
  const text = `${description} ${type}`.toLowerCase();
  if (
    text.includes('withdraw') ||
    text.includes('transfer to') ||
    text.includes('transferout') ||
    text.includes('redemption') ||
    text.includes('debit')
  ) {
    return amount.isNegative() ? amount : amount.negated();
  }
  if (
    text.includes('deposit') ||
    text.includes('transfer from') ||
    text.includes('transferin') ||
    text.includes('reward') ||
    text.includes('rebate') ||
    text.includes('bonus') ||
    text.includes('airdrop') ||
    text.includes('credit')
  ) {
    return amount.isPositive() ? amount : amount.abs();
  }
  return amount;
}

function inferFundingEventType(
  description: string,
  type: string,
  asset: string,
  signed: Decimal,
): RawEventType {
  const text = `${description} ${type}`.toLowerCase();
  if (
    text.includes('reward') ||
    text.includes('rebate') ||
    text.includes('bonus') ||
    text.includes('airdrop')
  ) {
    return 'income';
  }
  const isFiat = FIAT_CURRENCIES.has(asset.toUpperCase());
  if (signed.isPositive()) return isFiat ? 'fiat_deposit' : 'crypto_in';
  if (signed.isNegative()) return isFiat ? 'fiat_withdrawal' : 'crypto_out';
  return 'unknown';
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parsePair(value: string): { base?: string; quote?: string } {
  const upper = value.trim().toUpperCase();
  const delimited = upper.split(/[-/_\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    const [base, quote] = delimited;
    const out: { base?: string; quote?: string } = {};
    if (base) out.base = base;
    if (quote) out.quote = quote;
    return out;
  }
  const normalized = upper.replace(/[^A-Z0-9]+/g, '');
  const quote = QUOTE_CANDIDATES.find(
    (c) => normalized.length > c.length && normalized.endsWith(c),
  );
  if (!quote) return {};
  return { base: normalized.slice(0, -quote.length), quote };
}

