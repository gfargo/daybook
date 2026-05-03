/**
 * Kraken CSV row → RawEvent.
 *
 * Kraken's "Export Ledger" CSV has one row per ledger movement. Trades appear
 * as two rows sharing the same `refid` (one per side). Deposits, withdrawals,
 * staking, and other types are single-row events.
 *
 * Sign convention: Kraken's `amount` column is already signed — negative for
 * outflows, positive for inflows. We preserve that signing in the resulting
 * AssetLeg amounts.
 */

import type { AssetLeg, RawEvent } from '@daybook/ledger';

// ─────────────────────────────────────────────────────────────────────────
// CSV row type — verbatim from the Kraken "Export Ledger" columns
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row from the Kraken "Export Ledger" CSV.
 *
 * Columns: txid, refid, time, type, subtype, aclass, asset, amount, fee, balance
 */
export interface KrakenRow {
  /** Kraken transaction ID (unique per ledger entry). */
  txid: string;
  /** Reference ID — shared by both sides of a trade pair. */
  refid: string;
  /** Timestamp string: "YYYY-MM-DD HH:MM:SS" (UTC). */
  time: string;
  /** Row type: trade, deposit, withdrawal, staking, transfer, etc. */
  type: string;
  /** Subtype: e.g. "stakingfromspot", "spottostaking". */
  subtype: string;
  /** Asset class — usually "currency". */
  aclass: string;
  /** Kraken asset ticker (may need normalization, e.g. XXBT → BTC). */
  asset: string;
  /** Signed decimal amount as string. Negative = outflow. */
  amount: string;
  /** Fee amount as string. "0.0000000000" when no fee. */
  fee: string;
  /** Post-transaction balance as string. */
  balance: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Asset normalization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Kraken uses non-standard tickers for many assets. This map converts them
 * to daybook canonical symbols.
 */
const KRAKEN_ASSET_MAP: Record<string, string> = {
  XXBT: 'BTC',
  XBT: 'BTC',
  XETH: 'ETH',
  XLTC: 'LTC',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XXMR: 'XMR',
  XZEC: 'ZEC',
  XDAO: 'DAO',
  XETC: 'ETC',
  XREP: 'REP',
  XMLN: 'MLN',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZCAD: 'CAD',
  ZJPY: 'JPY',
  ZAUD: 'AUD',
  'ETH2': 'ETH',
  'ETH2.S': 'ETH',
};

/**
 * Normalize a Kraken asset ticker to daybook canonical form.
 *
 * Falls through to the raw value if no mapping exists (most modern Kraken
 * tickers like DOT, ADA, SOL are already standard).
 */
export function normalizeKrakenAsset(raw: string): string {
  return KRAKEN_ASSET_MAP[raw] ?? raw;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-type builders
// ─────────────────────────────────────────────────────────────────────────

export interface BuildEventOptions {
  /** Account ID this row belongs to. */
  accountId: string;
}

/**
 * Build a `trade` RawEvent from a paired refid group (exactly 2 rows).
 *
 * The two rows represent opposite sides of the trade — one negative (sold),
 * one positive (bought). Both share the same `refid`.
 */
export function buildTradeEvent(
  refid: string,
  pair: [KrakenRow, KrakenRow],
  opts: BuildEventOptions,
): RawEvent {
  const [a, b] = pair;
  // Use the earlier timestamp
  const timestamp = parseKrakenTimestamp(a.time) <= parseKrakenTimestamp(b.time)
    ? parseKrakenTimestamp(a.time)
    : parseKrakenTimestamp(b.time);

  const legs: AssetLeg[] = [
    buildLeg(a),
    buildLeg(b),
  ];

  // Append fee legs for each side that has a non-zero fee
  const feeA = buildFeeLeg(a);
  if (feeA) legs.push(feeA);
  const feeB = buildFeeLeg(b);
  if (feeB) legs.push(feeB);

  return {
    id: `kraken:${refid}`,
    source: 'kraken',
    accountId: opts.accountId,
    timestamp,
    type: 'trade',
    legs,
    raw: { rows: pair },
  };
}

/**
 * Build a `crypto_in` RawEvent from a deposit row.
 */
export function buildDepositEvent(
  row: KrakenRow,
  opts: BuildEventOptions,
): RawEvent {
  const legs: AssetLeg[] = [buildLeg(row)];
  const fee = buildFeeLeg(row);
  if (fee) legs.push(fee);

  return {
    id: `kraken:${row.txid}`,
    source: 'kraken',
    accountId: opts.accountId,
    timestamp: parseKrakenTimestamp(row.time),
    type: 'crypto_in',
    legs,
    raw: row,
  };
}

/**
 * Build a `crypto_out` RawEvent from a withdrawal row.
 */
export function buildWithdrawalEvent(
  row: KrakenRow,
  opts: BuildEventOptions,
): RawEvent {
  const legs: AssetLeg[] = [buildLeg(row)];
  const fee = buildFeeLeg(row);
  if (fee) legs.push(fee);

  return {
    id: `kraken:${row.txid}`,
    source: 'kraken',
    accountId: opts.accountId,
    timestamp: parseKrakenTimestamp(row.time),
    type: 'crypto_out',
    legs,
    raw: row,
  };
}

/**
 * Build an `income` RawEvent from a staking row.
 */
export function buildStakingEvent(
  row: KrakenRow,
  opts: BuildEventOptions,
): RawEvent {
  const legs: AssetLeg[] = [buildLeg(row)];
  const fee = buildFeeLeg(row);
  if (fee) legs.push(fee);

  return {
    id: `kraken:${row.txid}`,
    source: 'kraken',
    accountId: opts.accountId,
    timestamp: parseKrakenTimestamp(row.time),
    type: 'income',
    legs,
    notes: row.subtype || 'staking',
    raw: row,
  };
}

/**
 * Build an `unknown` RawEvent for unrecognized row types.
 */
export function buildUnknownEvent(
  row: KrakenRow,
  opts: BuildEventOptions,
): RawEvent {
  const legs: AssetLeg[] = [buildLeg(row)];
  const fee = buildFeeLeg(row);
  if (fee) legs.push(fee);

  return {
    id: `kraken:${row.txid}`,
    source: 'kraken',
    accountId: opts.accountId,
    timestamp: parseKrakenTimestamp(row.time),
    type: 'unknown',
    legs,
    notes: `Unrecognized Kraken type: ${row.type}`,
    raw: row,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a principal AssetLeg from a Kraken row.
 */
function buildLeg(row: KrakenRow): AssetLeg {
  return {
    asset: normalizeKrakenAsset(row.asset),
    amount: row.amount,
  };
}

/**
 * Build a fee AssetLeg from a Kraken row, or null if fee is zero.
 *
 * Fee is always expressed as a negative amount in the same asset.
 */
function buildFeeLeg(row: KrakenRow): AssetLeg | null {
  if (isZero(row.fee)) return null;
  return {
    asset: normalizeKrakenAsset(row.asset),
    amount: negate(row.fee),
    feeFlag: true,
  };
}

/**
 * Check if a decimal string is zero (handles "0", "0.00", "0.0000000000", etc).
 */
function isZero(s: string): boolean {
  return /^-?0+(\.0+)?$/.test(s.trim());
}

/**
 * Negate a decimal string. "1.5" → "-1.5", "-1.5" → "1.5", "0" → "0".
 */
function negate(s: string): string {
  if (isZero(s)) return '0';
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}

/**
 * Parse a Kraken timestamp string to a Date.
 *
 * Kraken format: "YYYY-MM-DD HH:MM:SS" (always UTC, no timezone suffix).
 */
export function parseKrakenTimestamp(s: string): Date {
  const iso = `${s.trim().replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new Error(`Unparsable Kraken timestamp: ${s}`);
  }
  return d;
}
