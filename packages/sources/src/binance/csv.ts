import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';
import {
  FIAT_CURRENCIES,
  assetLeg,
  hashRows,
  normalizeAsset,
  normalizeHeader,
  parseAmount,
  parseCsvRows,
  parseTimestamp,
  pick,
  sanitizeNativeId,
  suffixDuplicateIds,
  type CsvRow,
  type NormalizedRow,
} from '../_shared/csv-helpers.js';

export type BinanceCsvSource = 'binance' | 'binance-us';
export type BinanceCsvRow = CsvRow;

export interface ParseBinanceOptions {
  accountId: string;
  source: BinanceCsvSource;
}

export interface ParseBinanceResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

interface LedgerRow extends NormalizedRow {
  time: string;
  account: string;
  operation: string;
  coin: string;
  change: Decimal;
  remark?: string;
}

const BINANCE_LEDGER_HEADERS = ['userid', 'utctime', 'account', 'operation', 'coin', 'change'];
const BINANCE_US_REPORT_HEADERS = ['time', 'operation', 'primaryasset', 'realizedamountforprimaryasset'];

export function parseBinanceCsv(
  contents: string,
  options: ParseBinanceOptions,
): ParseBinanceResult {
  const rows = parseCsvRows(contents);
  const warnings: string[] = [];
  let unparsedRowCount = 0;

  const profile = detectProfile(rows);
  if (!profile) {
    throw new Error(
      'Binance CSV header not recognized. Expected Binance ledger columns ' +
      '(User_ID, UTC_Time, Account, Operation, Coin, Change) or Binance.US tax-report columns.',
    );
  }

  const events = profile === 'ledger'
    ? parseLedgerRows(rows, options, warnings)
    : parseTaxReportRows(rows, options, warnings);

  unparsedRowCount = warnings.filter(w => w.includes('skipped')).length;
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    events,
    totalRows: rows.length,
    unparsedRowCount,
    warnings,
  };
}


function detectProfile(rows: NormalizedRow[]): 'ledger' | 'tax-report' | undefined {
  const first = rows[0];
  if (!first) return undefined;

  const headers = new Set(Object.keys(first.values));
  if (BINANCE_LEDGER_HEADERS.every(header => headers.has(header))) return 'ledger';
  if (BINANCE_US_REPORT_HEADERS.every(header => headers.has(header))) return 'tax-report';
  return undefined;
}

function parseLedgerRows(
  rows: NormalizedRow[],
  options: ParseBinanceOptions,
  warnings: string[],
): RawEvent[] {
  const ledgerRows: LedgerRow[] = [];
  for (const row of rows) {
    const parsed = toLedgerRow(row, warnings);
    if (parsed) ledgerRows.push(parsed);
  }

  const events: RawEvent[] = [];
  const consumed = new Set<number>();
  const groups = groupLedgerRows(ledgerRows);

  for (const group of groups) {
    if (group.length > 1 && canBuildGroupedTrade(group)) {
      const event = buildLedgerGroupEvent(group, options, warnings);
      if (event) {
        events.push(event);
        for (const row of group) consumed.add(row.rowNumber);
      }
    }
  }

  for (const row of ledgerRows) {
    if (consumed.has(row.rowNumber)) continue;
    const event = buildSingleLedgerEvent(row, options, warnings);
    if (event) events.push(event);
  }

  return suffixDuplicateIds(events);
}

function toLedgerRow(row: NormalizedRow, warnings: string[]): LedgerRow | undefined {
  const time = pick(row, ['utc time', 'utc_time', 'time', 'date']);
  const account = pick(row, ['account']) ?? '';
  const operation = pick(row, ['operation', 'type']) ?? '';
  const coin = normalizeAsset(pick(row, ['coin', 'asset', 'currency']));
  const change = parseAmountSkipZero(pick(row, ['change', 'amount']));
  const remark = pick(row, ['remark', 'notes', 'comment']);

  if (!time || !operation || !coin || !change) {
    warnings.push(`Row ${row.rowNumber} skipped: missing Binance ledger time, operation, coin, or change`);
    return undefined;
  }

  return {
    ...row,
    time,
    account,
    operation,
    coin,
    change,
    ...(remark ? { remark } : {}),
  };
}

function groupLedgerRows(rows: LedgerRow[]): LedgerRow[][] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = [
      row.time,
      row.account,
      row.remark && row.remark.trim() ? row.remark.trim() : normalizeOperationFamily(row.operation),
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function canBuildGroupedTrade(rows: LedgerRow[]): boolean {
  const principal = rows.filter(row => !isFeeOperation(row.operation));
  const hasPositive = principal.some(row => row.change.isPositive());
  const hasNegative = principal.some(row => row.change.isNegative());
  const tradeLike = principal.some(row => isTradeOperation(row.operation));
  const blocked = principal.some(row => isStandaloneOperation(row.operation));
  return hasPositive && hasNegative && tradeLike && !blocked;
}

function buildLedgerGroupEvent(
  rows: LedgerRow[],
  options: ParseBinanceOptions,
  warnings: string[],
): RawEvent | undefined {
  const sorted = [...rows].sort((a, b) => a.rowNumber - b.rowNumber);
  const first = sorted[0]!;
  const principal = sorted.filter(row => !isFeeOperation(row.operation));
  const fees = sorted.filter(row => isFeeOperation(row.operation));
  const timestamp = parseTimestamp(first.time);
  if (!timestamp) {
    warnings.push(`Rows ${sorted.map(row => row.rowNumber).join(', ')} skipped: unparsable Binance timestamp "${first.time}"`);
    return undefined;
  }

  return {
    id: `${options.source}:group:${hashRows(sorted.map(row => row.original))}`,
    source: options.source,
    accountId: options.accountId,
    timestamp,
    type: 'trade',
    legs: [
      ...principal.map(row => assetLeg(row.coin, row.change)),
      ...fees.map(row => assetLeg(row.coin, row.change.isNegative() ? row.change : row.change.negated(), true)),
    ],
    notes: summarizeLedgerRows(sorted),
    raw: sorted.map(row => row.original),
  };
}

function buildSingleLedgerEvent(
  row: LedgerRow,
  options: ParseBinanceOptions,
  warnings: string[],
): RawEvent | undefined {
  const timestamp = parseTimestamp(row.time);
  if (!timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: unparsable Binance timestamp "${row.time}"`);
    return undefined;
  }

  const fee = isFeeOperation(row.operation);
  const amount = fee && row.change.isPositive() ? row.change.negated() : row.change;
  const type = inferSingleType(row.operation, row.coin, amount);

  return {
    id: `${options.source}:row:${hashRows([row.original])}`,
    source: options.source,
    accountId: options.accountId,
    timestamp,
    type,
    legs: [assetLeg(row.coin, amount, fee)],
    notes: row.remark ? `${row.operation}: ${row.remark}` : row.operation,
    raw: row.original,
  };
}

function parseTaxReportRows(
  rows: NormalizedRow[],
  options: ParseBinanceOptions,
  warnings: string[],
): RawEvent[] {
  const events: RawEvent[] = [];
  for (const row of rows) {
    const event = buildTaxReportEvent(row, options, warnings);
    if (event) events.push(event);
  }
  return suffixDuplicateIds(events);
}

function buildTaxReportEvent(
  row: NormalizedRow,
  options: ParseBinanceOptions,
  warnings: string[],
): RawEvent | undefined {
  const time = pick(row, ['time', 'utc time', 'date']);
  const operation = pick(row, ['operation', 'type']) ?? '';
  const category = pick(row, ['category']);
  const timestamp = time ? parseTimestamp(time) : undefined;
  if (!time || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Binance.US timestamp`);
    return undefined;
  }

  const legs = [
    reportLeg(row, 'primary'),
    reportLeg(row, 'base'),
    reportLeg(row, 'quote'),
    reportLeg(row, 'fee', true),
  ].filter((leg): leg is AssetLeg => Boolean(leg));

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Binance.US asset movement columns could be parsed`);
    return undefined;
  }

  const transactionId = pick(row, ['transaction id', 'transaction_id', 'txid']);
  const orderId = pick(row, ['order id', 'order_id']);
  const nativeId = transactionId ?? orderId;

  return {
    id: nativeId
      ? `${options.source}:${sanitizeNativeId(nativeId)}`
      : `${options.source}:row:${hashRows([row.original])}`,
    source: options.source,
    accountId: options.accountId,
    timestamp,
    type: inferTypeFromLegs(operation, legs),
    legs,
    ...([category, operation].filter(Boolean).length > 0
      ? { notes: [category, operation].filter(Boolean).join(': ') }
      : {}),
    raw: row.original,
  };
}

function reportLeg(row: NormalizedRow, prefix: 'primary' | 'base' | 'quote' | 'fee', feeFlag = false): AssetLeg | undefined {
  const asset = normalizeAsset(pick(row, [
    `${prefix} asset`,
    `${prefix}_asset`,
    `${prefix} currency`,
    `${prefix}_currency`,
    `asset ${prefix}`,
  ]));
  const amount = parseAmountSkipZero(pick(row, [
    `realized amount for ${prefix} asset`,
    `realized_amount_for_${prefix}_asset`,
    `${prefix} amount`,
    `${prefix}_amount`,
    `amount ${prefix}`,
  ]));

  if (!asset || !amount) return undefined;
  const signedAmount = feeFlag ? amount.abs().negated() : amount;
  return assetLeg(asset, signedAmount, feeFlag);
}

function inferSingleType(operation: string, asset: string, amount: Decimal): RawEventType {
  if (isFeeOperation(operation)) return 'fee_only';
  if (isIncomeOperation(operation) && amount.isPositive()) return 'income';

  if (amount.isPositive()) {
    return isFiatCurrency(asset) ? 'fiat_deposit' : 'crypto_in';
  }

  if (amount.isNegative()) {
    return isFiatCurrency(asset) ? 'fiat_withdrawal' : 'crypto_out';
  }

  return 'unknown';
}

function inferTypeFromLegs(operation: string, legs: AssetLeg[]): RawEventType {
  const principal = legs.filter(leg => !leg.feeFlag);
  const hasPositive = principal.some(leg => new Decimal(leg.amount).isPositive());
  const hasNegative = principal.some(leg => new Decimal(leg.amount).isNegative());
  if (hasPositive && hasNegative) return 'trade';
  if (legs.every(leg => leg.feeFlag)) return 'fee_only';

  const onlyPrincipal = principal[0];
  if (!onlyPrincipal) return 'unknown';
  const amount = new Decimal(onlyPrincipal.amount);
  if (amount.isPositive()) {
    if (isFiatCurrency(onlyPrincipal.asset)) return 'fiat_deposit';
    return isIncomeOperation(operation) ? 'income' : 'crypto_in';
  }
  if (amount.isNegative()) {
    return isFiatCurrency(onlyPrincipal.asset) ? 'fiat_withdrawal' : 'crypto_out';
  }

  return 'unknown';
}

/** Legacy behavior: zero-amount rows are skipped at the parser level. */
function parseAmountSkipZero(value: string | undefined): Decimal | undefined {
  return parseAmount(value, { zeroAsUndefined: true });
}

function isFiatCurrency(asset: string): boolean {
  return FIAT_CURRENCIES.has(asset.toUpperCase());
}

function isTradeOperation(operation: string): boolean {
  const value = normalizeHeader(operation);
  return (
    value.includes('buy') ||
    value.includes('sell') ||
    value.includes('trade') ||
    value.includes('convert') ||
    value.includes('transactionrelated') ||
    value.includes('smallassetsexchange')
  );
}

function isFeeOperation(operation: string): boolean {
  const value = normalizeHeader(operation);
  return value.includes('fee') || value.includes('commission');
}

function isIncomeOperation(operation: string): boolean {
  const value = normalizeHeader(operation);
  return (
    value.includes('reward') ||
    value.includes('staking') ||
    value.includes('interest') ||
    value.includes('airdrop') ||
    value.includes('distribution') ||
    value.includes('earn') ||
    value.includes('cashback') ||
    value.includes('referral')
  );
}

function isStandaloneOperation(operation: string): boolean {
  const value = normalizeHeader(operation);
  return (
    value.includes('deposit') ||
    value.includes('withdraw') ||
    value.includes('fiatdeposit') ||
    value.includes('fiatwithdraw')
  );
}

function normalizeOperationFamily(operation: string): string {
  if (isTradeOperation(operation)) return 'trade';
  if (isFeeOperation(operation)) return 'fee';
  if (isIncomeOperation(operation)) return 'income';
  return normalizeHeader(operation);
}

function summarizeLedgerRows(rows: LedgerRow[]): string {
  const operations = [...new Set(rows.map(row => row.operation).filter(Boolean))];
  return operations.join(', ');
}


