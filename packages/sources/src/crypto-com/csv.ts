import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';

export type CryptoComCsvRow = Record<string, string>;

export interface ParseCryptoComOptions {
  accountId: string;
}

export interface ParseCryptoComResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

interface NormalizedRow {
  rowNumber: number;
  original: CryptoComCsvRow;
  values: Record<string, string>;
}

type Profile = 'app' | 'exchange-trades' | 'wallet';

const APP_HEADERS = [
  'timestamputc',
  'transactiondescription',
  'currency',
  'amount',
  'transactionkind',
];

const EXCHANGE_TRADE_HEADERS = [
  'tradeid',
  'timeutc',
  'symbol',
  'side',
  'tradeprice',
  'tradeamount',
];

const WALLET_HEADERS = [
  'date',
  'sentamount',
  'sentcurrency',
  'receivedamount',
  'receivedcurrency',
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
]);

export function parseCryptoComCsv(
  contents: string,
  options: ParseCryptoComOptions,
): ParseCryptoComResult {
  const rows = parseRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (rows.length > 0 && !profile) {
    throw new Error(
      'Crypto.com CSV header not recognized. Expected App transaction history, Exchange trade history, or DeFi wallet transaction columns.',
    );
  }

  for (const row of rows) {
    const event = profile === 'exchange-trades'
      ? buildExchangeTradeEvent(row, options.accountId, warnings)
      : profile === 'wallet'
        ? buildWalletEvent(row, options.accountId, warnings)
        : buildAppEvent(row, options.accountId, warnings);
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
  }) as CryptoComCsvRow[];

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
  if (EXCHANGE_TRADE_HEADERS.every(header => headers.has(header))) return 'exchange-trades';
  if (APP_HEADERS.every(header => headers.has(header))) return 'app';
  if (WALLET_HEADERS.every(header => headers.has(header))) return 'wallet';
  return undefined;
}

function buildAppEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const time = pick(row, ['timestamp utc', 'time utc', 'date', 'timestamp']);
  const timestamp = time ? parseTimestamp(time) : undefined;
  if (!time || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Crypto.com timestamp`);
    return undefined;
  }

  const kind = pick(row, ['transaction kind', 'type']) ?? '';
  const description = pick(row, ['transaction description', 'description']);
  const currency = normalizeAsset(pick(row, ['currency']));
  const amount = parseAmount(pick(row, ['amount']));
  const toCurrency = normalizeAsset(pick(row, ['to currency']));
  const toAmount = parseAmount(pick(row, ['to amount']));
  const txHash = pick(row, ['transaction hash', 'tx hash', 'hash']);
  const legs: AssetLeg[] = [];

  if (currency && amount) {
    legs.push(assetLeg(currency, signedAppAmount(amount, kind)));
  }
  if (toCurrency && toAmount) {
    legs.push(assetLeg(toCurrency, signedAppAmount(toAmount, kind)));
  }

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Crypto.com asset movement columns could be parsed`);
    return undefined;
  }

  return {
    id: txHash
      ? `crypto-com:${sanitizeNativeId(txHash)}`
      : `crypto-com:row:${hashRows([row.original])}`,
    source: 'crypto-com',
    accountId,
    timestamp,
    type: inferType([kind, description].filter(Boolean).join(' '), legs),
    legs,
    ...(txHash ? { txHash } : {}),
    ...([description, kind].filter(Boolean).length > 0
      ? { notes: [description, kind].filter(Boolean).join(': ') }
      : {}),
    raw: row.original,
  };
}

function buildExchangeTradeEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const time = pick(row, ['time utc', 'timestamp utc', 'date']);
  const timestamp = time ? parseTimestamp(time) : undefined;
  if (!time || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Crypto.com Exchange timestamp`);
    return undefined;
  }

  const side = pick(row, ['side']) ?? '';
  const { base, quote } = parsePair(pick(row, ['symbol']));
  const tradeAmount = parseAmount(pick(row, ['trade amount']));
  const volume = parseAmount(pick(row, ['volume of business', 'volume', 'total']));
  const fee = parseAmount(pick(row, ['fee']))?.abs();
  const feeCurrency = normalizeAsset(pick(row, ['fee currency'])) ?? quote ?? 'USD';
  const legs: AssetLeg[] = [];

  if (base && quote && tradeAmount && volume) {
    const amount = tradeAmount.abs();
    const quoteAmount = volume.abs();
    if (normalizeHeader(side).includes('sell')) {
      legs.push(assetLeg(base, amount.negated()));
      legs.push(assetLeg(quote, quoteAmount));
    } else {
      legs.push(assetLeg(base, amount));
      legs.push(assetLeg(quote, quoteAmount.negated()));
    }
  }
  if (fee) {
    legs.push(assetLeg(feeCurrency, fee.negated(), true));
  }

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Crypto.com Exchange trade columns could be parsed`);
    return undefined;
  }

  const nativeId = pick(row, ['trade id', 'order id']);
  return {
    id: nativeId
      ? `crypto-com:${sanitizeNativeId(nativeId)}`
      : `crypto-com:row:${hashRows([row.original])}`,
    source: 'crypto-com',
    accountId,
    timestamp,
    type: inferType(side, legs),
    legs,
    ...(side ? { notes: side } : {}),
    raw: row.original,
  };
}

function buildWalletEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const time = pick(row, ['date', 'timestamp']);
  const timestamp = time ? parseTimestamp(time) : undefined;
  if (!time || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Crypto.com wallet timestamp`);
    return undefined;
  }

  const label = pick(row, ['label', 'type']) ?? '';
  const description = pick(row, ['description', 'notes']);
  const txHash = pick(row, ['tx hash', 'txhash', 'transaction hash']);
  const legs: AssetLeg[] = [];
  const sentAmount = parseAmount(pick(row, ['sent amount']))?.abs();
  const sentCurrency = normalizeAsset(pick(row, ['sent currency']));
  const receivedAmount = parseAmount(pick(row, ['received amount']))?.abs();
  const receivedCurrency = normalizeAsset(pick(row, ['received currency']));
  const feeAmount = parseAmount(pick(row, ['fee amount', 'fee']))?.abs();
  const feeCurrency = normalizeAsset(pick(row, ['fee currency']));

  if (sentAmount && sentCurrency) legs.push(assetLeg(sentCurrency, sentAmount.negated()));
  if (receivedAmount && receivedCurrency) legs.push(assetLeg(receivedCurrency, receivedAmount));
  if (feeAmount && feeCurrency) legs.push(assetLeg(feeCurrency, feeAmount.negated(), true));

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Crypto.com wallet movement columns could be parsed`);
    return undefined;
  }

  return {
    id: txHash
      ? `crypto-com:${sanitizeNativeId(txHash)}`
      : `crypto-com:row:${hashRows([row.original])}`,
    source: 'crypto-com',
    accountId,
    timestamp,
    type: inferType(label, legs),
    legs,
    ...(txHash ? { txHash } : {}),
    ...([description, label].filter(Boolean).length > 0
      ? { notes: [description, label].filter(Boolean).join(': ') }
      : {}),
    raw: row.original,
  };
}

function signedAppAmount(amount: Decimal, kind: string): Decimal {
  if (!amount.isPositive()) return amount;
  const normalized = normalizeHeader(kind);
  if (isOutbound(normalized)) return amount.negated();
  return amount;
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

function isOutbound(value: string): boolean {
  return (
    value.includes('withdraw') ||
    value.includes('send') ||
    value.includes('sent') ||
    value.includes('debit') ||
    value.includes('cardspend') ||
    value.includes('cardpurchase')
  );
}

function isIncome(value: string): boolean {
  return (
    value.includes('reward') ||
    value.includes('cashback') ||
    value.includes('rebate') ||
    value.includes('staking') ||
    value.includes('interest') ||
    value.includes('earn') ||
    value.includes('referral') ||
    value.includes('bonus')
  );
}

function parsePair(value: string | undefined): { base?: string; quote?: string } {
  if (!value) return {};
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const delimited = value.trim().toUpperCase().split(/[-/_\s]+/).filter(Boolean);
  if (delimited.length === 2) {
    return compactPair(normalizeAsset(delimited[0]), normalizeAsset(delimited[1]));
  }

  const quote = [...FIAT_CURRENCIES, 'BTC', 'ETH', 'CRO', 'USDC', 'USDT'].find(candidate => (
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

function hashRows(rows: CryptoComCsvRow[]): string {
  const stable = rows
    .map(row => Object.keys(row)
      .sort()
      .map(key => `${key}=${row[key] ?? ''}`)
      .join('\n'))
    .join('\n---\n');
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}
