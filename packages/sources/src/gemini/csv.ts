import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';

export type GeminiCsvRow = Record<string, string>;

export interface ParseGeminiOptions {
  accountId: string;
}

export interface ParseGeminiResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

interface NormalizedRow {
  rowNumber: number;
  original: GeminiCsvRow;
  values: Record<string, string>;
}

const DATE_ALIASES = ['date', 'time utc', 'timestamp', 'created at', 'transaction date'];
const TYPE_ALIASES = ['type', 'transaction type', 'side', 'action'];
const SPECIFICATION_ALIASES = ['specification', 'description', 'details', 'notes'];
const SYMBOL_ALIASES = ['symbol', 'pair', 'market', 'asset', 'currency'];
const QUANTITY_ALIASES = ['quantity', 'amount', 'asset amount', 'base amount'];
const PRICE_ALIASES = ['price', 'trade price', 'unit price', 'price per unit'];
const FIAT_AMOUNT_ALIASES = ['total', 'amount usd', 'usd amount', 'value', 'notional', 'proceeds', 'cost'];
const FEE_AMOUNT_ALIASES = ['fee', 'fee amount'];
const FEE_CURRENCY_ALIASES = ['fee currency', 'fee asset'];
const ID_ALIASES = ['trade id', 'order id', 'transaction id', 'tx hash', 'client order id', 'id'];
const TX_HASH_ALIASES = ['tx hash', 'transaction hash', 'hash'];

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

const GEMINI_METADATA_HEADERS = new Set([
  'btcamountbtc',
  'feebtcbtc',
  'btcbalancebtc',
  'tradeid',
  'orderid',
  'txhash',
]);

export function parseGeminiCsv(
  contents: string,
  options: ParseGeminiOptions,
): ParseGeminiResult {
  const rows = parseRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  if (rows.length > 0 && !looksLikeGeminiCsv(rows[0]!)) {
    throw new Error(
      'Gemini CSV header not recognized. Expected columns like Date, Type, Symbol, Quantity, Price, Amount, or Gemini transaction-history asset amount columns.',
    );
  }

  for (const row of rows) {
    const event = buildEvent(row, options.accountId, warnings);
    if (event) {
      events.push(event);
    } else {
      unparsedRowCount++;
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

function parseRows(contents: string): NormalizedRow[] {
  const records = parseCsv(contents, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as GeminiCsvRow[];

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

function looksLikeGeminiCsv(row: NormalizedRow): boolean {
  const headers = new Set(Object.keys(row.values));
  const hasDate = DATE_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasType = TYPE_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasSimpleTrade = SYMBOL_ALIASES.some(alias => headers.has(normalizeHeader(alias)))
    && QUANTITY_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasGeminiAmounts = [...headers].some(header => GEMINI_METADATA_HEADERS.has(header) || parseAssetAmountHeader(header));
  return hasDate && hasType && (hasSimpleTrade || hasGeminiAmounts);
}

function buildEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const dateValue = pick(row, DATE_ALIASES);
  const timestamp = dateValue ? parseTimestamp(dateValue) : undefined;
  if (!dateValue || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Gemini timestamp`);
    return undefined;
  }

  const typeValue = pick(row, TYPE_ALIASES) ?? '';
  const specification = pick(row, SPECIFICATION_ALIASES);
  const notes = [typeValue, specification].filter(Boolean).join(': ');
  const legs = buildLegs(row, typeValue, warnings);

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Gemini asset movement columns could be parsed`);
    return undefined;
  }

  const nativeId = pick(row, ID_ALIASES);
  const txHash = pick(row, TX_HASH_ALIASES);

  return {
    id: nativeId
      ? `gemini:${sanitizeNativeId(nativeId)}`
      : `gemini:row:${hashRows([row.original])}`,
    source: 'gemini',
    accountId,
    timestamp,
    type: inferType([typeValue, specification].filter(Boolean).join(' '), legs),
    legs,
    ...(txHash ? { txHash } : {}),
    ...(notes ? { notes } : {}),
    raw: row.original,
  };
}

function buildLegs(
  row: NormalizedRow,
  typeValue: string,
  warnings: string[],
): AssetLeg[] {
  const wideLegs = extractWideGeminiLegs(row);
  if (wideLegs.length > 0) return wideLegs;

  const normalizedType = normalizeHeader(typeValue);
  const symbol = pick(row, SYMBOL_ALIASES);
  const { base, quote } = parsePair(symbol);
  const asset = base ?? normalizeAsset(symbol);
  const quantity = parseAmount(pick(row, QUANTITY_ALIASES))?.abs();
  const price = parseAmount(pick(row, PRICE_ALIASES));
  const fiatAmount = parseAmount(pick(row, FIAT_AMOUNT_ALIASES))?.abs()
    ?? deriveQuoteAmount(quantity, price);
  const feeAmount = parseAmount(pick(row, FEE_AMOUNT_ALIASES))?.abs();
  const feeAsset = normalizeAsset(pick(row, FEE_CURRENCY_ALIASES)) ?? quote ?? 'USD';
  const quoteAsset = quote ?? 'USD';
  const legs: AssetLeg[] = [];

  if (isBuy(normalizedType)) {
    if (asset && quantity) legs.push(assetLeg(asset, quantity));
    if (fiatAmount) legs.push(assetLeg(quoteAsset, fiatAmount.negated()));
  } else if (isSell(normalizedType)) {
    if (asset && quantity) legs.push(assetLeg(asset, quantity.negated()));
    if (fiatAmount) legs.push(assetLeg(quoteAsset, fiatAmount));
  } else if (isInbound(normalizedType) || isIncome(normalizedType)) {
    if (asset && quantity) legs.push(assetLeg(asset, quantity));
  } else if (isOutbound(normalizedType)) {
    if (asset && quantity) legs.push(assetLeg(asset, quantity.negated()));
  } else if (asset && quantity) {
    legs.push(assetLeg(asset, quantity));
  }

  if (feeAmount) {
    legs.push(assetLeg(feeAsset, feeAmount.negated(), true));
  }

  if ((isBuy(normalizedType) || isSell(normalizedType)) && (!asset || !quantity || !fiatAmount)) {
    warnings.push(
      `Row ${row.rowNumber}: Gemini trade is missing symbol, quantity, or quote amount/price`,
    );
  }

  return legs;
}

function extractWideGeminiLegs(row: NormalizedRow): AssetLeg[] {
  const legs: AssetLeg[] = [];
  for (const [header, value] of Object.entries(row.values)) {
    const amount = parseAmount(value);
    if (!amount) continue;

    const feeAsset = parseFeeHeader(header);
    if (feeAsset) {
      legs.push(assetLeg(feeAsset, amount.abs().negated(), true));
      continue;
    }

    const amountAsset = parseAssetAmountHeader(header);
    if (amountAsset) {
      legs.push(assetLeg(amountAsset, amount));
    }
  }
  return legs;
}

function parseAssetAmountHeader(header: string): string | undefined {
  const match = header.match(/^([a-z0-9]+)amount\1$/);
  if (!match?.[1]) return undefined;
  return normalizeAsset(match[1]);
}

function parseFeeHeader(header: string): string | undefined {
  const match = header.match(/^fee([a-z0-9]+)\1$/);
  if (!match?.[1]) return undefined;
  return normalizeAsset(match[1]);
}

function inferType(typeValue: string, legs: AssetLeg[]): RawEventType {
  const normalizedType = normalizeHeader(typeValue);
  const principal = legs.filter(leg => !leg.feeFlag);
  const hasPositive = principal.some(leg => new Decimal(leg.amount).isPositive());
  const hasNegative = principal.some(leg => new Decimal(leg.amount).isNegative());

  if (principal.length === 0 && legs.every(leg => leg.feeFlag)) return 'fee_only';
  if (hasPositive && hasNegative) return 'trade';
  if (isIncome(normalizedType) && hasPositive) return 'income';
  if (hasPositive) return principal[0]?.asset && isFiatCurrency(principal[0].asset) ? 'fiat_deposit' : 'crypto_in';
  if (hasNegative) return principal[0]?.asset && isFiatCurrency(principal[0].asset) ? 'fiat_withdrawal' : 'crypto_out';
  return 'unknown';
}

function parsePair(value: string | undefined): { base?: string; quote?: string } {
  if (!value) return {};
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const delimited = value.trim().toUpperCase().split(/[-/_\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    return compactPair(normalizeAsset(delimited[0]), normalizeAsset(delimited[1]));
  }

  const quote = [...FIAT_CURRENCIES, 'BTC', 'ETH', 'GUSD', 'USDC', 'USDT'].find(candidate => (
    normalized.length > candidate.length && normalized.endsWith(candidate)
  ));
  if (!quote) return {};
  return compactPair(normalizeAsset(normalized.slice(0, -quote.length)), quote);
}

function compactPair(
  base: string | undefined,
  quote: string | undefined,
): { base?: string; quote?: string } {
  return {
    ...(base ? { base } : {}),
    ...(quote ? { quote } : {}),
  };
}

function deriveQuoteAmount(
  quantity: Decimal | undefined,
  price: Decimal | undefined,
): Decimal | undefined {
  if (!quantity || !price) return undefined;
  return quantity.mul(price).abs();
}

function isBuy(value: string): boolean {
  return value.includes('buy') || value.includes('bought');
}

function isSell(value: string): boolean {
  return value.includes('sell') || value.includes('sold');
}

function isInbound(value: string): boolean {
  return value.includes('deposit') || value.includes('receive') || value.includes('credit');
}

function isOutbound(value: string): boolean {
  return value.includes('withdraw') || value.includes('send') || value.includes('debit');
}

function isIncome(value: string): boolean {
  return (
    value.includes('reward') ||
    value.includes('staking') ||
    value.includes('interest') ||
    value.includes('earn') ||
    value.includes('bonus') ||
    value.includes('referral')
  );
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
    if (decimal.isZero()) return undefined;
    return negativeByParens ? decimal.negated() : decimal;
  } catch {
    return undefined;
  }
}

function parseTimestamp(value: string): Date | undefined {
  const trimmed = value.trim();
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

function isFiatCurrency(asset: string): boolean {
  return FIAT_CURRENCIES.has(asset.toUpperCase());
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function suffixDuplicateIds(events: RawEvent[]): RawEvent[] {
  const counts = new Map<string, number>();
  return events.map(event => {
    const count = counts.get(event.id) ?? 0;
    counts.set(event.id, count + 1);
    return count === 0 ? event : { ...event, id: `${event.id}:${count + 1}` };
  });
}

function sanitizeNativeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return sanitized || hashRows([{ value }]);
}

function hashRows(rows: GeminiCsvRow[]): string {
  const stable = rows
    .map(row => Object.keys(row)
      .sort()
      .map(key => `${key}=${row[key] ?? ''}`)
      .join('\n'))
    .join('\n---\n');
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}
