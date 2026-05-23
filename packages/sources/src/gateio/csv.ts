/**
 * Gate.io exchange CSV parser.
 *
 * Gate.io exposes a single unified **Billing Details** ledger that
 * captures every wallet movement — trades, deposits, withdrawals, fees,
 * airdrops, interest, dust swaps. This is the authoritative export per
 * the BittyTax reference parser; the standalone Trade History / Deposit
 * / Withdrawal exports silently drop partial fills.
 *
 * Headers (in this exact order):
 *
 *     no, time, action_desc, action_data, type, change_amount, amount, total
 *
 *   - `time`           — `yyyy-MM-dd HH:mm:ss` UTC.
 *   - `action_desc`    — event-type label (see ACTION enum below).
 *   - `action_data`    — correlation ID. Multiple rows that share an
 *                        `action_data` belong to the same logical event
 *                        (e.g., a spot trade emits a buy-leg row, a
 *                        sell-leg row, and a fee row, all with the same
 *                        `action_data`).
 *   - `type`           — the **asset symbol** (e.g., `BTC`, `USDT`).
 *                        NOT a transaction type. Naming is unfortunate.
 *   - `change_amount`  — signed delta (negative = outflow).
 *
 * The parser groups rows by `action_data` and reconstructs trades by
 * combining the resulting legs. The "Order Fullfilled" misspelling in
 * Gate's data is matched literally.
 *
 * Pair symbols are not present in the Billing Details CSV — the parser
 * infers base/quote from the asset legs in each group (positive
 * change_amount = base bought, negative = quote spent, or vice-versa).
 */

import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent, RawEventType } from '@daybook/ledger';
import {
  FIAT_CURRENCIES,
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

export type GateioCsvRow = CsvRow;

export interface ParseGateioOptions {
  accountId: string;
}

export interface ParseGateioResult {
  events: RawEvent[];
  totalRows: number;
  unparsedRowCount: number;
  warnings: string[];
}

const BILLING_HEADERS = ['actiondesc', 'actiondata', 'type', 'changeamount'];

const TRADE_DESCS = new Set([
  'order filled',
  'order fullfilled',
  'order placed',
]);
const FEE_DESCS = new Set(['trading fees', 'trade fee', 'trading fee']);
const DEPOSIT_DESCS = new Set(['deposits', 'deposit']);
const WITHDRAWAL_DESCS = new Set(['withdrawals', 'withdraw', 'withdrawal']);
const INCOME_DESCS = new Set([
  'airdrop',
  'airdrop bonus',
  'hodl interest',
  'interest income',
  'referral superior rebate',
  'staking reward',
  'staking rewards',
]);
const DUST_DEBIT_DESCS = new Set(['dust swap-small balances deducted', 'small balance swap-deducted']);
const DUST_CREDIT_DESCS = new Set(['dust swap-gt added', 'small balance swap-added']);

// ─── Entry point ─────────────────────────────────────────────────────────

export function parseGateioCsv(
  contents: string,
  options: ParseGateioOptions,
): ParseGateioResult {
  const rows = parseCsvRows(contents);
  const warnings: string[] = [];
  const events: RawEvent[] = [];
  let unparsedRowCount = 0;

  if (rows.length > 0 && !looksLikeBillingDetails(rows)) {
    throw new Error(
      'Gate.io CSV header not recognized. Expected Billing Details columns: no, time, action_desc, action_data, type, change_amount, amount, total.',
    );
  }

  // Group rows by action_data correlation ID. Rows without an action_data
  // are emitted as singletons (each row becomes its own group).
  const groups = new Map<string, NormalizedRow[]>();
  let syntheticGroupIndex = 0;
  for (const row of rows) {
    const key = pick(row, ['action_data', 'actiondata']) || `__row__${syntheticGroupIndex++}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  for (const [actionData, groupRows] of groups) {
    const built = buildEventFromGroup(actionData, groupRows, options.accountId, warnings);
    if (built) {
      events.push(...built);
    } else {
      unparsedRowCount += groupRows.length;
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

function looksLikeBillingDetails(rows: NormalizedRow[]): boolean {
  const first = rows[0];
  if (!first) return false;
  const headers = new Set(Object.keys(first.values));
  return BILLING_HEADERS.every((h) => headers.has(h));
}

// ─── Group classification ───────────────────────────────────────────────

interface GroupLeg {
  asset: string;
  amount: Decimal;
  desc: string;
  rowNumber: number;
}

function buildEventFromGroup(
  actionData: string,
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): RawEvent[] | undefined {
  const legs: GroupLeg[] = [];
  let earliest: Date | undefined;

  for (const row of rows) {
    const timeStr = pick(row, ['time']);
    const ts = timeStr ? parseTimestamp(timeStr) : undefined;
    if (ts && (!earliest || ts < earliest)) earliest = ts;

    const desc = (pick(row, ['action_desc', 'actiondesc']) ?? '').toLowerCase();
    const asset = normalizeAsset(pick(row, ['type', 'currency', 'coin']));
    const change = parseAmount(pick(row, ['change_amount', 'changeamount']));

    if (!asset || !change || change.isZero()) continue;

    legs.push({ asset, amount: change, desc, rowNumber: row.rowNumber });
  }

  if (!earliest || legs.length === 0) {
    return undefined;
  }

  const isTradeGroup = legs.some((l) => TRADE_DESCS.has(l.desc) || FEE_DESCS.has(l.desc));

  if (isTradeGroup) {
    return [buildTradeEvent(actionData, earliest, legs, rows, accountId, warnings)].filter(
      Boolean,
    ) as RawEvent[];
  }

  // Dust swaps: paired credit + debit under one action_data
  const isDustGroup = legs.some((l) => DUST_DEBIT_DESCS.has(l.desc) || DUST_CREDIT_DESCS.has(l.desc));
  if (isDustGroup) {
    const event = buildDustSwapEvent(actionData, earliest, legs, rows, accountId);
    return event ? [event] : undefined;
  }

  // Single-row events: deposit, withdrawal, income, etc.
  // Emit one RawEvent per leg (each row carries exactly one asset movement).
  const events: RawEvent[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const row = rows.find((r) => r.rowNumber === leg.rowNumber)!;
    const type = inferStandaloneType(leg.desc, leg.asset, leg.amount);
    if (!type) {
      warnings.push(`Row ${leg.rowNumber} skipped: unrecognized Gate.io action_desc "${leg.desc}"`);
      continue;
    }
    events.push({
      id: `gateio:${type}:${sanitizeNativeId(actionData)}${legs.length > 1 ? `:${i}` : ''}`,
      source: 'gateio',
      accountId,
      timestamp: earliest,
      type,
      legs: [{ asset: leg.asset, amount: leg.amount.toFixed() }],
      ...(leg.desc ? { notes: leg.desc } : {}),
      raw: row.original,
    });
  }

  return events.length > 0 ? events : undefined;
}

function buildTradeEvent(
  actionData: string,
  timestamp: Date,
  legs: GroupLeg[],
  rows: NormalizedRow[],
  accountId: string,
  warnings: string[],
): RawEvent | undefined {
  // Sum legs per (asset, isFee) bucket. Fee legs flagged separately from
  // principal so partial fills aggregate correctly.
  type Bucket = { asset: string; amount: Decimal; fee: boolean };
  const buckets = new Map<string, Bucket>();
  for (const leg of legs) {
    const isFee = FEE_DESCS.has(leg.desc);
    const key = `${leg.asset}|${isFee ? 'fee' : 'principal'}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.amount = existing.amount.plus(leg.amount);
    } else {
      buckets.set(key, { asset: leg.asset, amount: leg.amount, fee: isFee });
    }
  }

  const outLegs: AssetLeg[] = [];
  for (const b of buckets.values()) {
    if (b.amount.isZero()) continue;
    outLegs.push({
      asset: b.asset,
      amount: b.amount.toFixed(),
      ...(b.fee ? { feeFlag: true } : {}),
    });
  }

  const principal = outLegs.filter((l) => !l.feeFlag);
  const hasBuy = principal.some((l) => new Decimal(l.amount).isPositive());
  const hasSell = principal.some((l) => new Decimal(l.amount).isNegative());

  if (!hasBuy || !hasSell) {
    warnings.push(
      `Gate.io trade group ${actionData} skipped: incomplete legs (need both buy and sell sides)`,
    );
    return undefined;
  }

  return {
    id: `gateio:trade:${sanitizeNativeId(actionData)}`,
    source: 'gateio',
    accountId,
    timestamp,
    type: 'trade',
    legs: outLegs,
    raw: { actionData, rows: rows.map((r) => r.original) } as unknown as Record<string, unknown>,
  };
}

function buildDustSwapEvent(
  actionData: string,
  timestamp: Date,
  legs: GroupLeg[],
  rows: NormalizedRow[],
  accountId: string,
): RawEvent | undefined {
  // Dust swaps act like trades — collapse many tiny debit rows + one
  // credit row into a trade event.
  const outLegs: AssetLeg[] = legs
    .map((l) => ({ asset: l.asset, amount: l.amount.toFixed() }))
    .filter((l) => !new Decimal(l.amount).isZero());
  if (outLegs.length < 2) return undefined;
  return {
    id: `gateio:dustswap:${sanitizeNativeId(actionData)}`,
    source: 'gateio',
    accountId,
    timestamp,
    type: 'trade',
    legs: outLegs,
    notes: 'dust swap',
    raw: { actionData, rows: rows.map((r) => r.original) } as unknown as Record<string, unknown>,
  };
}

function inferStandaloneType(
  desc: string,
  asset: string,
  amount: Decimal,
): RawEventType | undefined {
  if (DEPOSIT_DESCS.has(desc)) {
    return FIAT_CURRENCIES.has(asset) ? 'fiat_deposit' : 'crypto_in';
  }
  if (WITHDRAWAL_DESCS.has(desc)) {
    return FIAT_CURRENCIES.has(asset) ? 'fiat_withdrawal' : 'crypto_out';
  }
  if (INCOME_DESCS.has(desc)) {
    return 'income';
  }
  // Fallback for unknown desc: trust the change_amount sign.
  if (amount.isPositive()) {
    return FIAT_CURRENCIES.has(asset) ? 'fiat_deposit' : 'crypto_in';
  }
  if (amount.isNegative()) {
    return FIAT_CURRENCIES.has(asset) ? 'fiat_withdrawal' : 'crypto_out';
  }
  return undefined;
}

