/**
 * OKX exchange CSV parser.
 *
 * Handles the three CSV exports OKX users commonly download:
 *
 *   - **trades-v2** (post-2023 unified-account export). Each fill is split
 *     across two or more rows that share the same `Order id`: one leg row
 *     per asset moved plus optional fee rows (`Trade Type=fee`). Parser
 *     groups by `Order id` and combines legs.
 *
 *   - **trades-v1** (legacy single-row format). One row per trade, with
 *     `Total` and `Fee` carrying concatenated "value currency" strings
 *     (e.g., "1500 USDT"). Headers may have a BOM and a stray CR.
 *
 *   - **funding** (deposit/withdrawal/transfer ledger). One row per
 *     movement; `Type` indicates direction.
 *
 * All timestamps are UTC in `yyyy-MM-dd HH:mm:ss` form (no offset).
 *
 * Asset symbols are uppercase plain tickers (BTC, USDT, ETH). Pair
 * separators differ by version: `BTC-USDT` (V2) vs `BTC_USDT` (V1).
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

export type OkxCsvRow = CsvRow;

export interface ParseOkxOptions {
  accountId: string;
}

export interface ParseOkxResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

type Profile = 'trades-v2' | 'trades-v1' | 'funding';

const TRADES_V2_HEADERS = ['orderid', 'tradetype', 'action', 'tradingunit'];
const TRADES_V1_HEADERS = ['tradeid', 'tradetime', 'pairs', 'price', 'unit'];
const FUNDING_HEADERS = ['time', 'type', 'amount', 'symbol'];

const QUOTE_CANDIDATES = [
  ...FIAT_CURRENCIES,
  'USDT',
  'USDC',
  'USDK',
  'FDUSD',
  'PYUSD',
  'DAI',
  'BTC',
  'ETH',
  'OKB',
];

// ─── Entry point ─────────────────────────────────────────────────────────

export function parseOkxCsv(
  contents: string,
  options: ParseOkxOptions,
): ParseOkxResult {
  const rows = parseCsvRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (rows.length > 0 && !profile) {
    throw new Error(
      'OKX CSV header not recognized. Expected V2 trade history (Order id, Trade Type, Action, Trading Unit), V1 trade history (Trade ID, Pairs, Price, unit), or funding history (Time, Type, Amount, Symbol).',
    );
  }

  if (profile === 'trades-v2') {
    const { events: tradeEvents, unparsed } = buildTradesV2Events(rows, options.accountId, warnings);
    events.push(...tradeEvents);
    unparsedRowCount += unparsed;
  } else if (profile === 'trades-v1') {
    for (const row of rows) {
      const event = buildTradesV1Event(row, options.accountId, warnings);
      if (event) events.push(event);
      else unparsedRowCount++;
    }
  } else if (profile === 'funding') {
    for (const row of rows) {
      const event = buildFundingEvent(row, options.accountId, warnings);
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
  if (TRADES_V2_HEADERS.every((h) => headers.has(h))) return 'trades-v2';
  if (TRADES_V1_HEADERS.every((h) => headers.has(h))) return 'trades-v1';
  if (FUNDING_HEADERS.every((h) => headers.has(h))) return 'funding';
  return undefined;
}

// ─── V2 trades — multi-row grouped by Order id ───────────────────────────

function buildTradesV2Events(
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): { events: RawEvent[]; unparsed: number } {
  // Group rows by Order id
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
    const event = buildTradesV2Group(orderId, groupRows, accountId, warnings);
    if (event) events.push(event);
    else unparsed += groupRows.length;
  }

  for (const row of orderless) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX V2 trade row missing Order id`);
    unparsed++;
  }

  return { events, unparsed };
}

function buildTradesV2Group(
  orderId: string,
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  // Earliest timestamp in the group
  let earliest: Date | undefined;
  let symbol: string | undefined;
  const legs: AssetLeg[] = [];

  for (const row of rows) {
    const timeStr = pick(row, ['time']);
    const ts = timeStr ? parseTimestamp(timeStr) : undefined;
    if (ts && (!earliest || ts < earliest)) earliest = ts;

    const sym = pick(row, ['symbol']);
    if (sym && !symbol) symbol = sym;

    const tradeType = (pick(row, ['trade type', 'tradetype']) ?? '').toLowerCase();
    const action = (pick(row, ['action']) ?? '').toLowerCase();
    const asset = normalizeAsset(pick(row, ['trading unit', 'tradingunit']));
    const amount = parseAmount(pick(row, ['amount']));

    if (!asset || !amount) continue;

    const isFee = tradeType.includes('fee');
    let signedAmount = amount;

    // V2 amounts are usually signed already, but fall back to action when zero-signed
    if (signedAmount.isZero()) continue;
    if (!isFee) {
      if (signedAmount.isPositive() && action === 'sell') {
        signedAmount = signedAmount.negated();
      } else if (signedAmount.isNegative() && action === 'buy') {
        signedAmount = signedAmount.abs();
      }
    } else {
      // Fees should be negative
      signedAmount = signedAmount.isPositive() ? signedAmount.negated() : signedAmount;
    }

    legs.push(assetLeg(asset, signedAmount, isFee));
  }

  if (!earliest) {
    warnings.push(`OKX V2 trade order ${orderId} skipped: no parsable timestamps`);
    return undefined;
  }
  if (legs.length === 0) {
    warnings.push(`OKX V2 trade order ${orderId} skipped: no asset movements parsed`);
    return undefined;
  }

  const principal = legs.filter((l) => !l.feeFlag);
  const type: RawEventType =
    principal.some((l) => new Decimal(l.amount).isPositive()) &&
    principal.some((l) => new Decimal(l.amount).isNegative())
      ? 'trade'
      : inferDirectionalType(principal);

  return {
    id: `okx:order:${sanitizeNativeId(orderId)}`,
    source: 'okx',
    accountId,
    timestamp: earliest,
    type,
    legs: combineLegs(legs),
    ...(symbol ? { notes: `pair ${symbol}` } : {}),
    raw: { orderId, rows: rows.map((r) => r.original) } as unknown as Record<string, unknown>,
  };
}

// ─── V1 trades — single row per trade ────────────────────────────────────

function buildTradesV1Event(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const timeStr = pick(row, ['trade time', 'tradetime', 'time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX V1 trade missing timestamp`);
    return undefined;
  }

  const pairValue = pick(row, ['pairs', 'pair']);
  const { base, quote } = parsePair(pairValue);
  if (!base || !quote) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX V1 pair "${pairValue ?? ''}" not recognized`);
    return undefined;
  }

  // OKX V1 doesn't have an explicit side column — Amount sign indicates direction
  const baseAmount = parseAmount(pick(row, ['amount']));
  const totalRaw = pick(row, ['total']);
  const feeRaw = pick(row, ['fee']);
  const explicitFeeUnit = normalizeAsset(pick(row, ['unit', 'fee unit', 'feecurrency']));

  if (!baseAmount) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX V1 trade missing Amount`);
    return undefined;
  }

  const totalParsed = parseValueWithUnit(totalRaw);
  const feeParsed = parseValueWithUnit(feeRaw);
  const quoteAmount = totalParsed?.amount;
  if (!quoteAmount) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX V1 trade missing Total`);
    return undefined;
  }
  const quoteAsset = totalParsed.unit ?? quote;

  const legs: AssetLeg[] = [];
  // baseAmount sign tells us direction. Positive = received base (buy). Negative = sold base.
  const isBuy = baseAmount.isPositive();
  legs.push(assetLeg(base, baseAmount));
  legs.push(
    assetLeg(
      quoteAsset,
      isBuy ? quoteAmount.abs().negated() : quoteAmount.abs(),
    ),
  );
  if (feeParsed?.amount) {
    legs.push(
      assetLeg(
        feeParsed.unit ?? explicitFeeUnit ?? quoteAsset,
        feeParsed.amount.abs().negated(),
        true,
      ),
    );
  }

  const tradeId = pick(row, ['trade id', 'tradeid']);
  return {
    id: tradeId
      ? `okx:trade:${sanitizeNativeId(tradeId)}`
      : `okx:row:${hashRows([row.original])}`,
    source: 'okx',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    ...(pairValue ? { notes: `pair ${pairValue}` } : {}),
    raw: row.original,
  };
}

// ─── Funding history — deposits, withdrawals, transfers ─────────────────

function buildFundingEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const timeStr = pick(row, ['time']);
  const timestamp = timeStr ? parseTimestamp(timeStr) : undefined;
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX funding row missing Time`);
    return undefined;
  }

  const type = (pick(row, ['type']) ?? '').toLowerCase();
  const symbol = normalizeAsset(pick(row, ['symbol']));
  const amount = parseAmount(pick(row, ['amount']));

  if (!symbol || !amount) {
    warnings.push(`Row ${row.rowNumber} skipped: OKX funding row missing Symbol or Amount`);
    return undefined;
  }

  const legs: AssetLeg[] = [];
  const direction = directionFromFundingType(type, amount);
  legs.push(assetLeg(symbol, direction));

  const nativeId = pick(row, ['id']);
  return {
    id: nativeId
      ? `okx:funding:${sanitizeNativeId(nativeId)}`
      : `okx:row:${hashRows([row.original])}`,
    source: 'okx',
    accountId,
    timestamp,
    type: inferFundingType(type, symbol, direction),
    legs,
    ...(type ? { notes: type } : {}),
    raw: row.original,
  };
}

function directionFromFundingType(type: string, amount: Decimal): Decimal {
  // If type explicitly says outbound, force negative.
  if (
    type.includes('withdraw') ||
    type.includes('send') ||
    type.includes('debit') ||
    type.includes('redemption')
  ) {
    return amount.isNegative() ? amount : amount.negated();
  }
  // If type says inbound, force positive.
  if (
    type.includes('deposit') ||
    type.includes('reward') ||
    type.includes('rebate') ||
    type.includes('distribution') ||
    type.includes('credit')
  ) {
    return amount.isPositive() ? amount : amount.abs();
  }
  // Transfer / conversion / earn subscription — trust the sign on Amount.
  return amount;
}

function inferFundingType(
  type: string,
  asset: string,
  signed: Decimal,
): RawEventType {
  if (type.includes('reward') || type.includes('rebate') || type.includes('distribution')) {
    return 'income';
  }
  const isFiat = FIAT_CURRENCIES.has(asset.toUpperCase());
  if (signed.isPositive()) {
    return isFiat ? 'fiat_deposit' : 'crypto_in';
  }
  if (signed.isNegative()) {
    return isFiat ? 'fiat_withdrawal' : 'crypto_out';
  }
  return 'unknown';
}

function inferDirectionalType(principal: AssetLeg[]): RawEventType {
  const hasPositive = principal.some((l) => new Decimal(l.amount).isPositive());
  const hasNegative = principal.some((l) => new Decimal(l.amount).isNegative());
  if (hasPositive && !hasNegative) {
    const first = principal[0];
    return first && FIAT_CURRENCIES.has(first.asset.toUpperCase()) ? 'fiat_deposit' : 'crypto_in';
  }
  if (hasNegative && !hasPositive) {
    const first = principal[0];
    return first && FIAT_CURRENCIES.has(first.asset.toUpperCase()) ? 'fiat_withdrawal' : 'crypto_out';
  }
  return 'unknown';
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Combine multiple legs for the same asset into a single signed leg.
 *
 * OKX V2 sometimes emits separate rows for the principal movement and a
 * partial-fill follow-up; merging keeps the RawEvent compact while
 * preserving the net amount.
 */
function combineLegs(legs: AssetLeg[]): AssetLeg[] {
  const combined = new Map<string, AssetLeg>();
  for (const leg of legs) {
    const key = `${leg.asset}|${leg.feeFlag ? 'fee' : 'principal'}`;
    const existing = combined.get(key);
    if (existing) {
      existing.amount = new Decimal(existing.amount).plus(new Decimal(leg.amount)).toFixed();
    } else {
      combined.set(key, { ...leg });
    }
  }
  return [...combined.values()].filter((l) => !new Decimal(l.amount).isZero());
}

function parsePair(value: string | undefined): { base?: string; quote?: string } {
  if (!value) return {};
  const upper = value.trim().toUpperCase();
  const delimited = upper.split(/[-/_\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    const [base, quote] = delimited;
    const out: { base?: string; quote?: string } = {};
    if (base) out.base = base;
    if (quote) out.quote = quote;
    return out;
  }
  // Concatenated form, try to peel a known quote off the end
  const normalized = upper.replace(/[^A-Z0-9]+/g, '');
  const quote = QUOTE_CANDIDATES.find(
    (c) => normalized.length > c.length && normalized.endsWith(c),
  );
  if (!quote) return {};
  return { base: normalized.slice(0, -quote.length), quote };
}

/**
 * Parse an OKX "value unit" string like "1500.5 USDT" into amount + unit.
 *
 * Returns `undefined` if the input is empty. Returns `{ amount, unit }`
 * even if only one of the two parts is present.
 */
function parseValueWithUnit(value: string | undefined): {
  amount?: Decimal;
  unit?: string;
} | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(-?[\d.,]+)\s*([A-Za-z][A-Za-z0-9]*)?$/.exec(trimmed);
  if (match) {
    const amount = parseAmount(match[1]);
    const unit = match[2] ? normalizeAsset(match[2]) : undefined;
    const out: { amount?: Decimal; unit?: string } = {};
    if (amount) out.amount = amount;
    if (unit) out.unit = unit;
    return out;
  }
  const amount = parseAmount(trimmed);
  return amount ? { amount } : undefined;
}

