/**
 * Coinbase CSV row → RawEvent.
 *
 * One pure function per supported transaction type. Each takes a parsed CSV row
 * (already split into fields) and returns a single RawEvent. Pair-merging for
 * Retail Staking Transfer / Retail Eth2 Deprecation happens *after* this module
 * runs, in `csv.ts`, because it requires looking at multiple rows.
 *
 * Sign convention (matches the source data exactly):
 *   - Quantity Transacted from CB is signed: negative when the user spent
 *     the asset, positive when they received it.
 *   - We preserve that signing in the resulting AssetLeg amounts.
 */

import type { AssetLeg, RawEvent } from '@daybook/ledger';
import {
  parseAdvancedBuyNote,
  parseBuyNote,
  parseConvertNote,
  parseReceiveNote,
  parseSendNote,
  parseWithdrawalNote,
} from './notes.js';

// ─────────────────────────────────────────────────────────────────────────
// CSV row type — verbatim from the Coinbase export columns
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row from the Coinbase "All Transactions" CSV.
 *
 * Source columns (the export is stable since at least 2023):
 *   ID, Timestamp, Transaction Type, Asset, Quantity Transacted,
 *   Price Currency, Price at Transaction, Subtotal,
 *   Total (inclusive of fees and/or spread),
 *   Fees and/or Spread, Notes
 *
 * All money columns arrive as strings like "$2521.605" or "-$10.54058".
 * `id` and `notes` are kept verbatim; everything else is parsed lazily on use.
 */
export interface CoinbaseCsvRow {
  /** 24-hex-char Coinbase transaction ID. */
  id: string;
  /** ISO-ish timestamp string from the file: "YYYY-MM-DD HH:MM:SS UTC". */
  timestamp: string;
  /** One of the 13 known Coinbase transaction types. */
  transactionType: CoinbaseTransactionType;
  /** Ticker — 'BTC', 'ETH', 'USDC', 'USD', etc. */
  asset: string;
  /** Signed quantity. Negative when spent, positive when received. */
  quantityTransacted: string;
  /** Always 'USD' in current exports, but we don't assume. */
  priceCurrency: string;
  /** Money string. May be empty for some types. */
  priceAtTransaction: string;
  subtotal: string;
  total: string;
  feesAndSpread: string;
  notes: string;
}

/** All Coinbase "Transaction Type" values seen in the wild. */
export type CoinbaseTransactionType =
  | 'Buy'
  | 'Sell'
  | 'Send'
  | 'Receive'
  | 'Convert'
  | 'Deposit'
  | 'Withdrawal'
  | 'Staking Income'
  | 'Reward Income'
  | 'Inflation Reward'
  | 'Advanced Trade Buy'
  | 'Advanced Trade Sell'
  | 'Retail Staking Transfer'
  | 'Retail Eth2 Deprecation'
  // Catch-all for forward compatibility
  | (string & {});

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface ParseRowOptions {
  /** Account ID this row belongs to. Defaults to a stable `coinbase:<csvId>` pattern. */
  accountId: string;
}

export interface ParseRowResult {
  /** The produced raw event, or null if the row couldn't be classified. */
  event: RawEvent | null;
  /**
   * For paired transaction types (Retail Staking Transfer / Retail Eth2 Deprecation),
   * the event is marked preliminary; the file-level parser is expected to merge
   * pairs in a post-pass. Set true for those rows.
   */
  needsPairing: boolean;
  /** Optional warning the caller might want to log. */
  warning?: string;
}

/**
 * Parse one CSV row into a RawEvent.
 *
 * Returns `event: null` only for genuinely unrecognized transaction types —
 * known types that fail Notes parsing throw, so format drift surfaces immediately.
 */
export function parseCoinbaseRow(
  row: CoinbaseCsvRow,
  options: ParseRowOptions,
): ParseRowResult {
  const ts = parseTimestamp(row.timestamp);
  const id = `coinbase:${row.id}`;

  switch (row.transactionType) {
    case 'Buy':
      return ok(buildBuy(row, id, ts, options.accountId));

    case 'Advanced Trade Buy':
      return ok(buildAdvancedBuy(row, id, ts, options.accountId));

    case 'Sell':
      return ok(buildSell(row, id, ts, options.accountId));

    case 'Convert':
      return ok(buildConvert(row, id, ts, options.accountId));

    case 'Send':
      return ok(buildSend(row, id, ts, options.accountId));

    case 'Receive':
      return ok(buildReceive(row, id, ts, options.accountId));

    case 'Deposit':
      return ok(buildFiatOrCryptoDeposit(row, id, ts, options.accountId));

    case 'Withdrawal':
      return ok(buildWithdrawal(row, id, ts, options.accountId));

    case 'Staking Income':
    case 'Reward Income':
    case 'Inflation Reward':
      return ok(buildIncome(row, id, ts, options.accountId));

    case 'Retail Staking Transfer':
    case 'Retail Eth2 Deprecation':
      return {
        event: buildPreliminaryInternalMove(row, id, ts, options.accountId),
        needsPairing: true,
      };

    default:
      return {
        event: buildUnknown(row, id, ts, options.accountId),
        needsPairing: false,
        warning: `Unknown Coinbase transaction type: ${row.transactionType}`,
      };
  }
}

function ok(event: RawEvent): ParseRowResult {
  return { event, needsPairing: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-type builders
// ─────────────────────────────────────────────────────────────────────────

function buildBuy(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  // Coinbase exports use three distinct Notes formats for Buy-shape rows:
  //
  //   1. Simple                  "Bought 0.001 BTC for 150 USD"
  //   2. With bank account       "Bought 3.22 AVAX for 125 USD using bank account ..."
  //   3. Advanced Trade format   "Bought 0.0029 BTC for 124.74 USD on BTC-USD at 41874.83 USD/BTC"
  //
  // And — counterintuitively — `Transaction Type` can be either "Buy" or
  // "Advanced Trade Buy" for the format-3 rows. We treat all three as the
  // same logical event (a fiat→crypto trade); only the embedded metadata
  // differs. Try the simple parser first, fall back to advanced.
  const note = parseBuyNote(row.notes) ?? parseAdvancedBuyNote(row.notes);
  if (!note) {
    throw new Error(`Buy row ${row.id} has unparsable notes: ${row.notes}`);
  }
  // Buy: spent fiat, received crypto. CB stores ONLY the crypto leg in the
  // primary columns, with `Total` showing the fiat side.
  const legs: AssetLeg[] = [
    // Crypto received (positive)
    {
      asset: row.asset,
      amount: row.quantityTransacted,
      amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
    },
    // Fiat spent (negative)
    {
      asset: note.fiatCurrency,
      amount: negate(parseDollarString(row.total) ?? '0'),
      amountUsdReportedBySource: parseDollarString(row.total) ?? undefined,
    },
  ];
  // Fee leg, if any
  const fee = parseDollarString(row.feesAndSpread);
  if (fee && fee !== '0') {
    legs.push({
      asset: note.fiatCurrency,
      amount: negate(fee),
      amountUsdReportedBySource: fee,
      feeFlag: true,
    });
  }
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    notes: row.notes,
    raw: row,
  };
}

function buildAdvancedBuy(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  // Same logic — buildBuy now handles all three Note formats.
  return buildBuy(row, id, timestamp, accountId);
}

function buildSell(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  // Sell: spent crypto (quantity is negative), received fiat
  const legs: AssetLeg[] = [
    {
      asset: row.asset,
      amount: row.quantityTransacted, // already negative
      amountUsdReportedBySource: absDollarString(row.subtotal) ?? undefined,
    },
    {
      asset: 'USD',
      amount: parseDollarString(row.total) ?? '0',
      amountUsdReportedBySource: parseDollarString(row.total) ?? undefined,
    },
  ];
  const fee = parseDollarString(row.feesAndSpread);
  if (fee && fee !== '0') {
    legs.push({
      asset: 'USD',
      amount: negate(fee),
      amountUsdReportedBySource: fee,
      feeFlag: true,
    });
  }
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    notes: row.notes,
    raw: row,
  };
}

function buildConvert(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  const note = parseConvertNote(row.notes);
  // Convert: spent USDC (quantity negative), received e.g. BTC.
  // The ONLY place the receive leg is structured is the Notes string.
  const legs: AssetLeg[] = [
    {
      asset: note.sentAsset,
      amount: negate(note.sentQuantity),
      amountUsdReportedBySource: absDollarString(row.subtotal) ?? undefined,
    },
    {
      asset: note.receivedAsset,
      amount: note.receivedQuantity,
      amountUsdReportedBySource: parseDollarString(row.total) ?? undefined,
    },
  ];
  // Convert fees/spread are baked into the total/subtotal diff.
  // Surface as a fee leg in the spent-asset's currency for transparency.
  const fee = parseDollarString(row.feesAndSpread);
  if (fee && fee !== '0' && fee !== '-0') {
    legs.push({
      asset: 'USD',
      amount: parseDollarString(row.feesAndSpread) ?? '0',
      amountUsdReportedBySource: fee,
      feeFlag: true,
    });
  }
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'trade',
    legs,
    notes: row.notes,
    raw: row,
  };
}

function buildSend(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  const note = parseSendNote(row.notes);
  // Send: crypto leaving CB. Quantity is negative.
  const legs: AssetLeg[] = [
    {
      asset: row.asset,
      amount: row.quantityTransacted,
      amountUsdReportedBySource: absDollarString(row.subtotal) ?? undefined,
    },
  ];
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'crypto_out',
    legs,
    ...(note?.destinationAddress ? { counterparty: note.destinationAddress } : {}),
    notes: row.notes,
    raw: row,
  };
}

function buildReceive(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  const note = parseReceiveNote(row.notes);
  const legs: AssetLeg[] = [
    {
      asset: row.asset,
      amount: row.quantityTransacted, // positive
      amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
    },
  ];
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'crypto_in',
    legs,
    ...(note?.source ? { counterparty: note.source } : {}),
    notes: row.notes,
    raw: row,
  };
}

function buildFiatOrCryptoDeposit(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  const isFiat = row.asset === 'USD' || row.asset === 'EUR' || row.asset === 'GBP';
  const legs: AssetLeg[] = [
    {
      asset: row.asset,
      amount: row.quantityTransacted,
      amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
    },
  ];
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: isFiat ? 'fiat_deposit' : 'crypto_in',
    legs,
    notes: row.notes,
    raw: row,
  };
}

function buildWithdrawal(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  const note = parseWithdrawalNote(row.notes);
  const isFiat = row.asset === 'USD' || row.asset === 'EUR' || row.asset === 'GBP';
  const legs: AssetLeg[] = [
    {
      asset: row.asset,
      amount: row.quantityTransacted, // negative
      amountUsdReportedBySource: absDollarString(row.subtotal) ?? undefined,
    },
  ];
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: isFiat ? 'fiat_withdrawal' : 'crypto_out',
    legs,
    ...(note?.bankName ? { counterparty: note.bankName } : {}),
    notes: row.notes,
    raw: row,
  };
}

function buildIncome(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  // Staking, Reward, Inflation — all single-leg income at FMV.
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'income',
    legs: [
      {
        asset: row.asset,
        amount: row.quantityTransacted,
        amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
      },
    ],
    notes: row.notes || row.transactionType,
    raw: row,
  };
}

function buildPreliminaryInternalMove(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  // One leg only at this stage — the file-level pair-merger will combine
  // the matching opposite-sign row into a 2-leg internal_move.
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'internal_move',
    legs: [
      {
        asset: row.asset,
        amount: row.quantityTransacted,
        amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
      },
    ],
    notes: row.transactionType,
    raw: row,
  };
}

function buildUnknown(
  row: CoinbaseCsvRow,
  id: string,
  timestamp: Date,
  accountId: string,
): RawEvent {
  return {
    id,
    source: 'coinbase',
    accountId,
    timestamp,
    type: 'unknown',
    legs: [
      {
        asset: row.asset,
        amount: row.quantityTransacted,
        amountUsdReportedBySource: parseDollarString(row.subtotal) ?? undefined,
      },
    ],
    notes: row.notes,
    raw: row,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Field-level helpers
// ─────────────────────────────────────────────────────────────────────────

/** "$2521.605" → "2521.605"; "-$10.54058" → "-10.54058"; "" → null. */
export function parseDollarString(s: string): string | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/^-?\$/, m => (m === '-$' ? '-' : ''));
  if (!cleaned || isNaN(Number(cleaned))) return null;
  return cleaned;
}

/** Absolute value of a dollar string. */
export function absDollarString(s: string): string | null {
  const v = parseDollarString(s);
  if (!v) return null;
  return v.startsWith('-') ? v.slice(1) : v;
}

/** Negate a Decimal-string. "1.5" → "-1.5", "-1.5" → "1.5", "0" → "0". */
export function negate(s: string): string {
  if (s === '0' || s === '0.0' || s === '') return '0';
  return s.startsWith('-') ? s.slice(1) : '-' + s;
}

/** "2026-01-31 16:28:29 UTC" → Date. */
export function parseTimestamp(s: string): Date {
  // Coinbase format: "YYYY-MM-DD HH:MM:SS UTC"
  // Convert to ISO: "YYYY-MM-DDTHH:MM:SSZ"
  const iso = s.trim().replace(' UTC', 'Z').replace(' ', 'T');
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new Error(`Unparsable Coinbase timestamp: ${s}`);
  }
  return d;
}
