import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';
import {
  assetLeg,
  hashRows,
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

export type RobinhoodCsvRow = CsvRow;

export interface ParseRobinhoodOptions {
  accountId: string;
}

export interface ParseRobinhoodResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

const DATE_ALIASES = [
  'date',
  'timestamp',
  'created at',
  'activity date',
  'transaction date',
  'transaction date/time',
  'transaction date and time',
  'executed at',
];

const TYPE_ALIASES = [
  'type',
  'transaction type',
  'activity type',
  'description',
  'trans code',
  'side',
];

const SYMBOL_ALIASES = [
  'symbol',
  'crypto symbol',
  'asset',
  'currency',
  'instrument',
  'name',
];

const QUANTITY_ALIASES = [
  'quantity',
  'crypto amount',
  'asset quantity',
  'amount of crypto',
  'filled asset quantity',
];

const PRICE_ALIASES = [
  'price',
  'crypto price',
  'price per coin',
  'average price',
  'effective price',
];

const FIAT_AMOUNT_ALIASES = [
  'amount',
  'net amount',
  'usd amount',
  'total',
  'total value',
  'fiat amount',
  'value',
  'proceeds',
  'cost',
];

const FEE_AMOUNT_ALIASES = [
  'fee',
  'fees',
  'fee amount',
  'network fee',
  'commission',
];

const FEE_CURRENCY_ALIASES = [
  'fee currency',
  'fee asset',
  'fee coin',
];

const ID_ALIASES = [
  'id',
  'transaction id',
  'transaction id / hash',
  'order id',
  'activity id',
  'reference id',
];

const NOTES_ALIASES = ['notes', 'note', 'description', 'memo', 'details'];

const ASSET_NAME_TO_SYMBOL: Record<string, string> = {
  '1inch': '1INCH',
  aave: 'AAVE',
  avalanche: 'AVAX',
  'avalanche c-chain': 'AVAX',
  bitcoin: 'BTC',
  'bitcoin cash': 'BCH',
  cardano: 'ADA',
  chainlink: 'LINK',
  compound: 'COMP',
  dogecoin: 'DOGE',
  ethereum: 'ETH',
  'ethereum classic': 'ETC',
  litecoin: 'LTC',
  optimism: 'OP',
  pepe: 'PEPE',
  polygon: 'POL',
  'polygon ecosystem token': 'POL',
  shiba: 'SHIB',
  'shiba inu': 'SHIB',
  solana: 'SOL',
  stellar: 'XLM',
  'stellar lumens': 'XLM',
  tezos: 'XTZ',
  uniswap: 'UNI',
  'usd coin': 'USDC',
};

export function parseRobinhoodCsv(
  contents: string,
  options: ParseRobinhoodOptions,
): ParseRobinhoodResult {
  const rows = parseCsvRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  if (rows.length > 0 && !looksLikeRobinhoodCsv(rows[0]!)) {
    throw new Error(
      'Robinhood CSV header not recognized. Expected transaction-history columns like Date, Transaction Type, Crypto Symbol, Crypto Amount, Price, Amount, or Fee.',
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


function looksLikeRobinhoodCsv(row: NormalizedRow): boolean {
  const headers = new Set(Object.keys(row.values));
  const hasDate = DATE_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasType = TYPE_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasSymbol = SYMBOL_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasQuantity = QUANTITY_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  const hasAmount = FIAT_AMOUNT_ALIASES.some(alias => headers.has(normalizeHeader(alias)));
  return hasDate && hasType && (hasSymbol || hasQuantity || hasAmount);
}

function buildEvent(
  row: NormalizedRow,
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  const dateValue = pick(row, DATE_ALIASES);
  const timestamp = dateValue ? parseTimestamp(dateValue) : undefined;
  if (!dateValue || !timestamp) {
    warnings.push(`Row ${row.rowNumber} skipped: missing or unparsable Robinhood timestamp`);
    return undefined;
  }

  const typeValue = pick(row, TYPE_ALIASES) ?? '';
  const symbol = normalizeAsset(pick(row, SYMBOL_ALIASES));
  const quantity = parseAmountSkipZero(pick(row, QUANTITY_ALIASES));
  const fiatAmount = parseAmountSkipZero(pick(row, FIAT_AMOUNT_ALIASES));
  const price = parseAmountSkipZero(pick(row, PRICE_ALIASES));
  const feeAmount = parseAmountSkipZero(pick(row, FEE_AMOUNT_ALIASES))?.abs();
  const feeAsset = normalizeAsset(pick(row, FEE_CURRENCY_ALIASES)) ?? 'USD';
  const notes = pick(row, NOTES_ALIASES);

  const legs = buildLegs({
    row,
    typeValue,
    symbol,
    quantity,
    fiatAmount,
    price,
    feeAmount,
    feeAsset,
    warnings,
  });

  if (legs.length === 0) {
    warnings.push(`Row ${row.rowNumber} skipped: no Robinhood asset movement columns could be parsed`);
    return undefined;
  }

  const nativeId = pick(row, ID_ALIASES);
  const eventType = inferType(typeValue, legs);

  return {
    id: nativeId
      ? `robinhood:${sanitizeNativeId(nativeId)}`
      : `robinhood:row:${hashRows([row.original])}`,
    source: 'robinhood',
    accountId,
    timestamp,
    type: eventType,
    legs,
    ...(notes ? { notes } : {}),
    raw: row.original,
  };
}

function buildLegs(input: {
  row: NormalizedRow;
  typeValue: string;
  symbol: string | undefined;
  quantity: Decimal | undefined;
  fiatAmount: Decimal | undefined;
  price: Decimal | undefined;
  feeAmount: Decimal | undefined;
  feeAsset: string;
  warnings: string[];
}): AssetLeg[] {
  const normalizedType = normalizeHeader(input.typeValue);
  const quantity = input.quantity?.abs();
  const fiatAmount = input.fiatAmount?.abs() ?? deriveFiatAmount(quantity, input.price);
  const legs: AssetLeg[] = [];

  if (isBuy(normalizedType)) {
    if (input.symbol && quantity) legs.push(assetLeg(input.symbol, quantity));
    if (fiatAmount) legs.push(assetLeg('USD', fiatAmount.negated()));
  } else if (isSell(normalizedType)) {
    if (input.symbol && quantity) legs.push(assetLeg(input.symbol, quantity.negated()));
    if (fiatAmount) legs.push(assetLeg('USD', fiatAmount));
  } else if (isInbound(normalizedType)) {
    if (input.symbol && quantity) legs.push(assetLeg(input.symbol, quantity));
  } else if (isOutbound(normalizedType)) {
    if (input.symbol && quantity) legs.push(assetLeg(input.symbol, quantity.negated()));
  } else if (isIncome(normalizedType)) {
    if (input.symbol && quantity) legs.push(assetLeg(input.symbol, quantity));
  } else if (input.symbol && input.quantity) {
    const signedQuantity = input.quantity.isNegative() ? quantity?.negated() : quantity;
    if (signedQuantity) legs.push(assetLeg(input.symbol, signedQuantity));
  }

  if (input.feeAmount) {
    legs.push(assetLeg(input.feeAsset, input.feeAmount.negated(), true));
  }

  if ((isBuy(normalizedType) || isSell(normalizedType)) && (!input.symbol || !quantity || !fiatAmount)) {
    input.warnings.push(
      `Row ${input.row.rowNumber}: Robinhood trade is missing symbol, quantity, or USD amount/price`,
    );
  }

  return legs;
}

function deriveFiatAmount(
  quantity: Decimal | undefined,
  price: Decimal | undefined,
): Decimal | undefined {
  if (!quantity || !price) return undefined;
  return quantity.mul(price).abs();
}

function inferType(typeValue: string, legs: AssetLeg[]): RawEventType {
  const normalizedType = normalizeHeader(typeValue);
  const principal = legs.filter(leg => !leg.feeFlag);
  const hasPositive = principal.some(leg => new Decimal(leg.amount).isPositive());
  const hasNegative = principal.some(leg => new Decimal(leg.amount).isNegative());

  if (principal.length === 0 && legs.every(leg => leg.feeFlag)) return 'fee_only';
  if (hasPositive && hasNegative) return 'trade';
  if (isIncome(normalizedType) && hasPositive) return 'income';
  if (hasPositive) return principal[0]?.asset === 'USD' ? 'fiat_deposit' : 'crypto_in';
  if (hasNegative) return principal[0]?.asset === 'USD' ? 'fiat_withdrawal' : 'crypto_out';
  return 'unknown';
}

function isBuy(value: string): boolean {
  return value.includes('buy') || value.includes('bought');
}

function isSell(value: string): boolean {
  return value.includes('sell') || value.includes('sold');
}

function isInbound(value: string): boolean {
  return (
    value.includes('deposit') ||
    value.includes('receive') ||
    value.includes('received') ||
    value.includes('transferin') ||
    value.includes('incoming')
  );
}

function isOutbound(value: string): boolean {
  return (
    value.includes('withdraw') ||
    value.includes('send') ||
    value.includes('sent') ||
    value.includes('transferout') ||
    value.includes('outgoing')
  );
}

function isIncome(value: string): boolean {
  return (
    value.includes('reward') ||
    value.includes('staking') ||
    value.includes('interest') ||
    value.includes('earn') ||
    value.includes('airdrop') ||
    value.includes('bonus')
  );
}

/** Legacy behavior: zero-amount rows are skipped at the parser level. */
function parseAmountSkipZero(value: string | undefined): Decimal | undefined {
  return parseAmount(value, { zeroAsUndefined: true });
}

function normalizeAsset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const bracketedSymbol = trimmed.match(/\(([A-Z0-9]{2,12})\)/);
  if (bracketedSymbol?.[1]) return bracketedSymbol[1].toUpperCase();

  const normalizedName = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const mapped = ASSET_NAME_TO_SYMBOL[normalizedName];
  if (mapped) return mapped;

  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

