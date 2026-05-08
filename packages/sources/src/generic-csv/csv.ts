import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';

export interface ParseGenericCsvOptions {
  /** Account ID assigned to all events from this file. */
  accountId: string;
}

export interface ParseGenericCsvResult {
  /** Produced RawEvents, sorted by timestamp ascending. */
  events: RawEvent[];
  /** How many raw CSV data rows were read. */
  totalRows: number;
  /** Rows that did not have enough data to become events. */
  unparsedRowCount: number;
  /** Warnings collected during parsing. */
  warnings: string[];
}

export type GenericCsvRow = Record<string, string>;

interface NormalizedRow {
  rowNumber: number;
  original: GenericCsvRow;
  values: Record<string, string>;
}

const DATE_ALIASES = [
  'date',
  'timestamp',
  'time',
  'datetime',
  'date utc',
  'utc date',
  'operation date',
];

const TYPE_ALIASES = [
  'type',
  'label',
  'tag',
  'category',
  'transaction type',
  'operation type',
  'description type',
];

const SENT_AMOUNT_ALIASES = [
  'sent amount',
  'sent quantity',
  'send amount',
  'out amount',
  'outgoing amount',
  'sell amount',
  'sold amount',
  'debit amount',
  'amount sent',
];

const SENT_CURRENCY_ALIASES = [
  'sent currency',
  'sent asset',
  'sent coin',
  'sent token',
  'out currency',
  'out asset',
  'sell currency',
  'sold currency',
  'debit currency',
  'currency sent',
];

const RECEIVED_AMOUNT_ALIASES = [
  'received amount',
  'received quantity',
  'receive amount',
  'in amount',
  'incoming amount',
  'buy amount',
  'bought amount',
  'credit amount',
  'amount received',
];

const RECEIVED_CURRENCY_ALIASES = [
  'received currency',
  'received asset',
  'received coin',
  'received token',
  'in currency',
  'in asset',
  'buy currency',
  'bought currency',
  'credit currency',
  'currency received',
];

const FEE_AMOUNT_ALIASES = [
  'fee amount',
  'fee',
  'fees',
  'network fee amount',
  'network fee',
  'gas fee amount',
  'gas fee',
];

const FEE_CURRENCY_ALIASES = [
  'fee currency',
  'fee asset',
  'fee coin',
  'network fee currency',
  'network fee asset',
  'gas fee currency',
  'gas fee asset',
];

const SINGLE_AMOUNT_ALIASES = ['amount', 'quantity', 'qty'];
const SINGLE_CURRENCY_ALIASES = ['currency', 'asset', 'coin', 'token', 'symbol'];

const NET_WORTH_AMOUNT_ALIASES = [
  'net worth amount',
  'net value amount',
  'net worth',
  'value',
  'value usd',
  'usd value',
  'cost basis usd',
  'proceeds usd',
];

const NET_WORTH_CURRENCY_ALIASES = [
  'net worth currency',
  'net value currency',
  'value currency',
];

const SENT_VALUE_USD_ALIASES = ['sent value usd', 'sent usd value', 'sell value usd'];
const RECEIVED_VALUE_USD_ALIASES = ['received value usd', 'received usd value', 'buy value usd'];
const FEE_VALUE_USD_ALIASES = ['fee value usd', 'fee usd value', 'gas value usd'];

const ID_ALIASES = ['id', 'transaction id', 'tx id', 'native id', 'record id'];
const TX_HASH_ALIASES = ['tx hash', 'txhash', 'transaction hash', 'hash', 'txid'];
const NOTES_ALIASES = ['notes', 'note', 'description', 'memo', 'comment'];

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

/**
 * Parse a broad, exchange-neutral CSV ledger into daybook RawEvents.
 *
 * The preferred columns are:
 * Date, Type/Label, Sent Amount, Sent Currency, Received Amount,
 * Received Currency, Fee Amount, Fee Currency, Net Worth Amount,
 * Net Worth Currency, Description, TxHash.
 */
export function parseGenericCsv(
  contents: string,
  options: ParseGenericCsvOptions,
): ParseGenericCsvResult {
  const warnings: string[] = [];
  const rows = parseRows(contents);
  const events: RawEvent[] = [];
  const idCounts = new Map<string, number>();
  let unparsed = 0;

  for (const row of rows) {
    const event = buildEvent(row, options.accountId, warnings);
    if (!event) {
      unparsed++;
      continue;
    }

    const count = idCounts.get(event.id) ?? 0;
    idCounts.set(event.id, count + 1);
    events.push(count === 0 ? event : { ...event, id: `${event.id}:${count + 1}` });
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    events,
    totalRows: rows.length,
    unparsedRowCount: unparsed,
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
  }) as GenericCsvRow[];

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

function buildEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const dateValue = pick(row, DATE_ALIASES);
  if (!dateValue) {
    warnings.push(`Row ${row.rowNumber}: missing date/timestamp`);
    return undefined;
  }

  const timestamp = parseTimestamp(dateValue);
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber}: unparsable date/timestamp "${dateValue}"`);
    return undefined;
  }

  const label = pick(row, TYPE_ALIASES) ?? '';
  const notes = pick(row, NOTES_ALIASES);
  const txHash = pick(row, TX_HASH_ALIASES);
  const netWorthUsd = pickUsdValue(
    pickDecimal(row, NET_WORTH_AMOUNT_ALIASES),
    pick(row, NET_WORTH_CURRENCY_ALIASES),
  );
  const sentValueUsd = pickDecimal(row, SENT_VALUE_USD_ALIASES) ?? netWorthUsd;
  const receivedValueUsd = pickDecimal(row, RECEIVED_VALUE_USD_ALIASES) ?? netWorthUsd;
  const feeValueUsd = pickDecimal(row, FEE_VALUE_USD_ALIASES);

  let sentAmount = pickDecimal(row, SENT_AMOUNT_ALIASES);
  let sentAsset = normalizeAsset(pick(row, SENT_CURRENCY_ALIASES));
  let receivedAmount = pickDecimal(row, RECEIVED_AMOUNT_ALIASES);
  let receivedAsset = normalizeAsset(pick(row, RECEIVED_CURRENCY_ALIASES));

  if (!sentAmount && !receivedAmount) {
    const singleAmount = pickDecimal(row, SINGLE_AMOUNT_ALIASES);
    const singleAsset = normalizeAsset(pick(row, SINGLE_CURRENCY_ALIASES));
    if (singleAmount && singleAsset) {
      const direction = inferSingleAmountDirection(singleAmount, label);
      if (direction === 'sent') {
        sentAmount = singleAmount.abs();
        sentAsset = singleAsset;
      } else {
        receivedAmount = singleAmount.abs();
        receivedAsset = singleAsset;
      }
    }
  }

  const feeAmount = pickDecimal(row, FEE_AMOUNT_ALIASES)?.abs();
  const feeAsset = normalizeAsset(pick(row, FEE_CURRENCY_ALIASES));

  const legs: AssetLeg[] = [];
  if (sentAmount && sentAsset) {
    legs.push(assetLeg(sentAsset, sentAmount.abs().negated(), sentValueUsd));
  } else if (sentAmount && !sentAsset) {
    warnings.push(`Row ${row.rowNumber}: sent amount has no sent currency`);
  }

  if (receivedAmount && receivedAsset) {
    legs.push(assetLeg(receivedAsset, receivedAmount.abs(), receivedValueUsd));
  } else if (receivedAmount && !receivedAsset) {
    warnings.push(`Row ${row.rowNumber}: received amount has no received currency`);
  }

  if (feeAmount && feeAsset) {
    const feeUsd = feeValueUsd ?? (feeAsset === 'USD' ? feeAmount : undefined);
    legs.push(assetLeg(feeAsset, feeAmount.negated(), feeUsd, true));
  } else if (feeAmount && !feeAsset) {
    warnings.push(`Row ${row.rowNumber}: fee amount has no fee currency`);
  }

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber}: no asset movement columns could be parsed`);
    return undefined;
  }

  const explicitId = pick(row, ID_ALIASES);
  return {
    id: buildEventId(row, explicitId, txHash),
    source: 'csv',
    accountId,
    timestamp,
    type: inferEventType({
      label,
      hasSent: Boolean(sentAmount && sentAsset),
      sentAsset,
      hasReceived: Boolean(receivedAmount && receivedAsset),
      receivedAsset,
      hasFeeOnly: legs.every(leg => leg.feeFlag),
    }),
    legs,
    ...(txHash ? { txHash } : {}),
    ...(notes ? { notes } : {}),
    raw: row.original,
  };
}

function assetLeg(
  asset: string,
  amount: Decimal,
  amountUsdReportedBySource?: Decimal,
  feeFlag?: boolean,
): AssetLeg {
  return {
    asset,
    amount: amount.toFixed(),
    ...(amountUsdReportedBySource
      ? { amountUsdReportedBySource: amountUsdReportedBySource.abs().toFixed() }
      : {}),
    ...(feeFlag ? { feeFlag: true } : {}),
  };
}

function inferEventType(input: {
  label: string;
  hasSent: boolean;
  sentAsset: string | undefined;
  hasReceived: boolean;
  receivedAsset: string | undefined;
  hasFeeOnly: boolean;
}): RawEventType {
  if (input.hasFeeOnly) return 'fee_only';
  if (input.hasSent && input.hasReceived) return 'trade';

  if (input.hasReceived) {
    if (input.receivedAsset && isFiatCurrency(input.receivedAsset)) return 'fiat_deposit';
    return isIncomeLabel(input.label) ? 'income' : 'crypto_in';
  }

  if (input.hasSent) {
    if (input.sentAsset && isFiatCurrency(input.sentAsset)) return 'fiat_withdrawal';
    return 'crypto_out';
  }

  return 'unknown';
}

function inferSingleAmountDirection(amount: Decimal, label: string): 'sent' | 'received' {
  if (amount.isNegative()) return 'sent';

  const normalized = normalizeHeader(label);
  if (
    normalized.includes('withdraw') ||
    normalized.includes('send') ||
    normalized.includes('sent') ||
    normalized.includes('debit') ||
    normalized.includes('transferout')
  ) {
    return 'sent';
  }

  return 'received';
}

function isIncomeLabel(label: string): boolean {
  const normalized = normalizeHeader(label);
  return (
    normalized.includes('income') ||
    normalized.includes('reward') ||
    normalized.includes('staking') ||
    normalized.includes('stake') ||
    normalized.includes('airdrop') ||
    normalized.includes('mining') ||
    normalized.includes('interest') ||
    normalized.includes('earn') ||
    normalized.includes('referral')
  );
}

function isFiatCurrency(asset: string): boolean {
  return FIAT_CURRENCIES.has(asset.toUpperCase());
}

function pick(row: NormalizedRow, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = row.values[normalizeHeader(alias)];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function pickDecimal(row: NormalizedRow, aliases: readonly string[]): Decimal | undefined {
  const value = pick(row, aliases);
  return parseAmount(value);
}

function pickUsdValue(
  amount: Decimal | undefined,
  currency: string | undefined,
): Decimal | undefined {
  if (!amount) return undefined;
  if (!currency) return amount;
  return normalizeAsset(currency) === 'USD' ? amount : undefined;
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

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function buildEventId(
  row: NormalizedRow,
  explicitId: string | undefined,
  txHash: string | undefined,
): string {
  const nativeId = explicitId ?? txHash;
  if (nativeId) {
    return `csv:${sanitizeNativeId(nativeId)}`;
  }

  return `csv:row:${hashRow(row.original)}`;
}

function sanitizeNativeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return sanitized || hashRow({ value });
}

function hashRow(row: GenericCsvRow): string {
  const stable = Object.keys(row)
    .sort()
    .map(key => `${key}=${row[key] ?? ''}`)
    .join('\n');
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}
