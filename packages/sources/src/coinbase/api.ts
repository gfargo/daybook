import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';
import { CoinbaseApiClient, type CoinbaseFetch } from './api-client.js';
import { type CoinbaseApiCredentials } from './api-auth.js';
import {
    CoinbaseTrackApi,
    type CoinbaseTrackTransaction,
    type CoinbaseTrackTransactionRecord,
} from './track-api.js';
import {
    CoinbaseAdvancedTradeApi,
    type CoinbaseAdvancedFill,
} from './advanced-api.js';

export interface SyncCoinbaseApiOptions {
  accountId: string;
  credentials: CoinbaseApiCredentials;
  fetch?: CoinbaseFetch;
  from?: Date;
}

export interface SyncCoinbaseApiResult {
  events: RawEvent[];
  totalRows: number;
  countsByType: Record<string, number>;
  unparsedRowCount: number;
  warnings: string[];
  fetched: {
    accounts: number;
    transactions: number;
    fills: number;
  };
}

export async function syncCoinbaseApi(
  options: SyncCoinbaseApiOptions,
): Promise<SyncCoinbaseApiResult> {
  const client = new CoinbaseApiClient({
    credentials: options.credentials,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const trackApi = new CoinbaseTrackApi(client);
  const advancedApi = new CoinbaseAdvancedTradeApi(client);

  const accounts = await trackApi.listAccounts();
  const records = (
    await Promise.all(accounts.map(account => trackApi.listTransactions(account)))
  ).flat();
  const filteredRecords = options.from
    ? records.filter(record => isOnOrAfter(record.transaction.created_at, options.from!))
    : records;

  const fills = await advancedApi.listFills({
    ...(options.from ? { startSequenceTimestamp: options.from.toISOString() } : {}),
  });

  return mapCoinbaseApiData({
    accountId: options.accountId,
    records: filteredRecords,
    fills,
  }, {
    fetched: {
      accounts: accounts.length,
      transactions: records.length,
      fills: fills.length,
    },
  });
}

export interface MapCoinbaseApiDataOptions {
  accountId: string;
  records: CoinbaseTrackTransactionRecord[];
  fills?: CoinbaseAdvancedFill[];
}

export function mapCoinbaseApiData(
  options: MapCoinbaseApiDataOptions,
  metadata: { fetched?: SyncCoinbaseApiResult['fetched'] } = {},
): SyncCoinbaseApiResult {
  const warnings: string[] = [];
  const fills = options.fills ?? [];
  const fillIndex = buildFillIndex(fills);
  const usedFillIds = new Set<string>();
  const grouped = groupRecords(options.records);
  const events: RawEvent[] = [];
  let unparsed = 0;

  for (const group of grouped) {
    const fill = findMatchingFill(group.records, fillIndex);
    if (fill) markFillUsed(fill, usedFillIds);

    const event = fill
      ? buildFillBackedEvent(group, fill, options.accountId, warnings)
      : buildTransactionBackedEvent(group, options.accountId, warnings);

    if (event) {
      events.push(event);
    } else {
      unparsed++;
    }
  }

  for (const fill of fills) {
    if (fillIdentityKeys(fill).some(key => usedFillIds.has(key))) continue;
    const event = buildFillOnlyEvent(fill, options.accountId, warnings);
    if (event) {
      events.push(event);
    }
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));

  return {
    events,
    totalRows: options.records.length,
    countsByType: countByType(events),
    unparsedRowCount: unparsed,
    warnings,
    fetched: metadata.fetched ?? {
      accounts: new Set(options.records.map(r => r.account.id)).size,
      transactions: options.records.length,
      fills: fills.length,
    },
  };
}

interface TransactionGroup {
  id: string;
  records: CoinbaseTrackTransactionRecord[];
}

function groupRecords(records: CoinbaseTrackTransactionRecord[]): TransactionGroup[] {
  const groups = new Map<string, CoinbaseTrackTransactionRecord[]>();
  for (const record of records) {
    const id = record.transaction.id || `${record.account.id}:${record.transaction.created_at ?? ''}`;
    const existing = groups.get(id) ?? [];
    existing.push(record);
    groups.set(id, existing);
  }
  return [...groups.entries()].map(([id, groupedRecords]) => ({
    id,
    records: groupedRecords,
  }));
}

function buildFillBackedEvent(
  group: TransactionGroup,
  fill: CoinbaseAdvancedFill,
  accountId: string,
  warnings: string[],
): RawEvent | null {
  const product = parseProductId(fill.product_id);
  if (!product || !fill.price || !fill.size) {
    warnings.push(`Coinbase fill ${fillKey(fill)} is missing product, price, or size`);
    return null;
  }
  const side = fill.side?.toUpperCase();
  const price = new Decimal(fill.price);
  const size = new Decimal(fill.size);
  const quoteAmount = size.mul(price);
  const fee = parseOptionalDecimal(fill.commission);
  const legs: AssetLeg[] = [];

  if (side === 'BUY') {
    legs.push({ asset: product.base, amount: size.toString() });
    legs.push({
      asset: product.quote,
      amount: quoteAmount.negated().toString(),
      ...(product.quote === 'USD'
        ? { amountUsdReportedBySource: quoteAmount.toString() }
        : {}),
    });
  } else if (side === 'SELL') {
    legs.push({ asset: product.base, amount: size.negated().toString() });
    legs.push({
      asset: product.quote,
      amount: quoteAmount.toString(),
      ...(product.quote === 'USD'
        ? { amountUsdReportedBySource: quoteAmount.toString() }
        : {}),
    });
  } else {
    warnings.push(`Coinbase fill ${fillKey(fill)} has unsupported side "${fill.side ?? ''}"`);
    return buildTransactionBackedEvent(group, accountId, warnings);
  }

  if (fee && !fee.isZero()) {
    legs.push({
      asset: product.quote,
      amount: fee.negated().toString(),
      ...(product.quote === 'USD'
        ? { amountUsdReportedBySource: fee.toString() }
        : {}),
      feeFlag: true,
    });
  }

  const timestamp = parseTimestamp(fill.trade_time)
    ?? earliestTransactionTimestamp(group.records)
    ?? new Date(0);
  const notes = buildNotes(group.records);
  return {
    id: `coinbase:api:v3:fill:${fillKey(fill)}`,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    ...(notes ? { notes } : {}),
    raw: { transactions: group.records, fill },
  };
}

function buildFillOnlyEvent(
  fill: CoinbaseAdvancedFill,
  accountId: string,
  warnings: string[],
): RawEvent | null {
  const syntheticGroup: TransactionGroup = { id: fillKey(fill), records: [] };
  return buildFillBackedEvent(syntheticGroup, fill, accountId, warnings);
}

function buildTransactionBackedEvent(
  group: TransactionGroup,
  accountId: string,
  warnings: string[],
): RawEvent | null {
  const representative = group.records[0]?.transaction;
  if (!representative) return null;
  if (representative.status && !isCompletedStatus(representative.status)) {
    warnings.push(`Skipped Coinbase transaction ${representative.id} with status ${representative.status}`);
    return null;
  }

  const legs = transactionLegs(group.records);
  if (legs.length === 0) {
    warnings.push(`Coinbase transaction ${representative.id} has no parseable amount`);
    return null;
  }

  const type = inferRawEventType(representative, legs);
  const txHash = group.records.find(r => r.transaction.network?.hash)?.transaction.network?.hash;
  const notes = buildNotes(group.records);
  return {
    id: `coinbase:api:v2:${group.id}`,
    source: 'coinbase',
    accountId,
    timestamp: earliestTransactionTimestamp(group.records) ?? new Date(0),
    type,
    legs,
    ...(txHash ? { txHash } : {}),
    ...(notes ? { notes } : {}),
    raw: { transactions: group.records },
  };
}

function transactionLegs(records: CoinbaseTrackTransactionRecord[]): AssetLeg[] {
  const legs: AssetLeg[] = [];
  for (const record of records) {
    const amount = record.transaction.amount?.amount;
    const asset = record.transaction.amount?.currency
      ?? record.account.currency?.code;
    if (!amount || !asset) continue;
    const leg: AssetLeg = {
      asset,
      amount: normalizeDecimal(amount),
    };
    const native = record.transaction.native_amount;
    if (native?.currency === 'USD' && native.amount) {
      leg.amountUsdReportedBySource = absDecimal(native.amount);
    }
    legs.push(leg);
  }

  return collapseDuplicateLegs(legs);
}

function collapseDuplicateLegs(legs: AssetLeg[]): AssetLeg[] {
  const byAsset = new Map<string, AssetLeg>();
  for (const leg of legs) {
    const existing = byAsset.get(leg.asset);
    if (!existing) {
      byAsset.set(leg.asset, { ...leg });
      continue;
    }
    existing.amount = new Decimal(existing.amount).plus(leg.amount).toString();
    if (!existing.amountUsdReportedBySource && leg.amountUsdReportedBySource) {
      existing.amountUsdReportedBySource = leg.amountUsdReportedBySource;
    }
  }
  return [...byAsset.values()].filter(leg => !new Decimal(leg.amount).isZero());
}

function inferRawEventType(
  transaction: CoinbaseTrackTransaction,
  legs: AssetLeg[],
): RawEventType {
  const type = transaction.type.toLowerCase();
  if (type.includes('reward') || type.includes('earn') || type.includes('staking')) {
    return 'income';
  }
  if (type === 'buy' || type === 'sell' || type.includes('trade') || legs.length > 1) {
    return 'trade';
  }
  if (type.includes('fiat_deposit')) return 'fiat_deposit';
  if (type.includes('fiat_withdrawal')) return 'fiat_withdrawal';
  const firstAmount = new Decimal(legs[0]?.amount ?? '0');
  if (type.includes('send') || type.includes('withdrawal')) return 'crypto_out';
  if (type.includes('receive') || type.includes('deposit')) return 'crypto_in';
  if (firstAmount.isPositive()) return 'crypto_in';
  if (firstAmount.isNegative()) return 'crypto_out';
  return 'unknown';
}

function buildFillIndex(fills: CoinbaseAdvancedFill[]): Map<string, CoinbaseAdvancedFill> {
  const index = new Map<string, CoinbaseAdvancedFill>();
  for (const fill of fills) {
    for (const key of fillIdentityKeys(fill)) {
      index.set(key, fill);
    }
  }
  return index;
}

function findMatchingFill(
  records: CoinbaseTrackTransactionRecord[],
  index: Map<string, CoinbaseAdvancedFill>,
): CoinbaseAdvancedFill | undefined {
  for (const record of records) {
    for (const key of transactionFillKeys(record.transaction)) {
      const fill = index.get(key);
      if (fill) return fill;
    }
  }
  return undefined;
}

function transactionFillKeys(transaction: CoinbaseTrackTransaction): string[] {
  return [
    transaction.advanced_trade_fill?.fill_id,
    transaction.advanced_trade_fill?.order_id,
    transaction.advanced_trade_fill?.trade_id,
    transaction.buy?.id,
    transaction.sell?.id,
    transaction.trade?.id,
  ].filter((key): key is string => Boolean(key));
}

function fillIdentityKeys(fill: CoinbaseAdvancedFill): string[] {
  return [
    fill.entry_id,
    fill.order_id,
    fill.trade_id,
  ].filter((key): key is string => Boolean(key));
}

function markFillUsed(fill: CoinbaseAdvancedFill, used: Set<string>): void {
  for (const key of fillIdentityKeys(fill)) used.add(key);
}

function fillKey(fill: CoinbaseAdvancedFill): string {
  return fill.entry_id ?? fill.trade_id ?? fill.order_id ?? 'unknown';
}

function parseProductId(productId: string | undefined): { base: string; quote: string } | null {
  const [base, quote] = productId?.split('-') ?? [];
  if (!base || !quote) return null;
  return { base, quote };
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function earliestTransactionTimestamp(
  records: CoinbaseTrackTransactionRecord[],
): Date | null {
  const timestamps = records
    .map(record => parseTimestamp(record.transaction.created_at))
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return timestamps[0] ?? null;
}

function isOnOrAfter(value: string | undefined, from: Date): boolean {
  const date = parseTimestamp(value);
  if (!date) return true;
  return date.getTime() >= from.getTime();
}

function isCompletedStatus(status: string): boolean {
  return ['completed', 'done', 'settled'].includes(status.toLowerCase());
}

function buildNotes(records: CoinbaseTrackTransactionRecord[]): string | undefined {
  const notes = records
    .flatMap(record => [
      record.transaction.details?.title,
      record.transaction.details?.subtitle,
      record.transaction.description,
      record.transaction.type,
    ])
    .filter((note): note is string => Boolean(note));
  return notes[0];
}

function normalizeDecimal(value: string): string {
  return new Decimal(value).toString();
}

function absDecimal(value: string): string {
  return new Decimal(value).abs().toString();
}

function parseOptionalDecimal(value: string | undefined): Decimal | null {
  if (!value) return null;
  return new Decimal(value);
}

function countByType(events: RawEvent[]): Record<string, number> {
  return events.reduce<Record<string, number>>((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});
}
