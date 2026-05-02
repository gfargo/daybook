/**
 * Coinbase CSV file → RawEvent[].
 *
 * The "All Transactions" export from Coinbase is *not* a standard CSV. The first
 * few rows are a user-info preamble:
 *
 *   <empty line>
 *   Transactions
 *   User,Griffen Fargo,379fd5b1-...
 *   ID,Timestamp,Transaction Type,Asset,...                ← actual column header
 *   <data rows>
 *
 * We detect the header line by looking for the literal `ID,Timestamp,Transaction Type`,
 * then parse data rows from there.
 *
 * Notes column may contain commas inside quoted strings (e.g. bank names like
 * `"Withdrawal to Community Bank, N.A./ ... *******9407"`). Use a real CSV
 * parser (`csv-parse/sync`) rather than naive split.
 *
 * Pair-merger pass: after all rows are converted, group the preliminary internal_move
 * events (Retail Staking Transfer / Retail Eth2 Deprecation pairs) by
 * `(timestamp, |amount|)` and merge each opposite-sign pair into one event.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import type { RawEvent } from '@daybook/ledger';
import {
  type CoinbaseCsvRow,
  parseCoinbaseRow,
  type ParseRowResult,
} from './row.js';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface ParseFileOptions {
  /** Account ID assigned to all events from this file. */
  accountId: string;
  /** Optional logger sink; default: silent. */
  warn?: (msg: string) => void;
}

export interface ParseFileResult {
  events: RawEvent[];
  /** How many raw CSV data rows we read. */
  totalRows: number;
  /** Per-type counts (post-pairing). */
  countsByType: Record<string, number>;
  /** Rows that didn't yield an event (e.g. completely malformed). */
  unparsedRowCount: number;
  /** Warnings collected during parsing (unknown types, suspect data). */
  warnings: string[];
}

/**
 * Parse a Coinbase "All Transactions" CSV file.
 *
 * Idempotent: same input → same output (events with same IDs).
 */
export function parseCoinbaseCsv(
  contents: string,
  options: ParseFileOptions,
): ParseFileResult {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    warnings.push(msg);
    options.warn?.(msg);
  };

  const rows = extractDataRows(contents);
  const preliminary: RawEvent[] = [];
  const needsPairing: RawEvent[] = [];
  let unparsed = 0;

  for (const row of rows) {
    let result: ParseRowResult;
    try {
      result = parseCoinbaseRow(row, { accountId: options.accountId });
    } catch (err) {
      warn(`Row ${row.id}: ${(err as Error).message}`);
      unparsed++;
      continue;
    }

    if (result.warning) warn(result.warning);

    if (result.event) {
      if (result.needsPairing) {
        needsPairing.push(result.event);
      } else {
        preliminary.push(result.event);
      }
    } else {
      unparsed++;
    }
  }

  // Pair-merger pass for Retail Staking Transfer / Retail Eth2 Deprecation
  const paired = mergeInternalMovePairs(needsPairing, warn);

  const events = [...preliminary, ...paired].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const countsByType = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  return {
    events,
    totalRows: rows.length,
    countsByType,
    unparsedRowCount: unparsed,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

const HEADER_MARKER = 'ID,Timestamp,Transaction Type';

/**
 * Strip Coinbase's user-info preamble and parse the remainder as CSV.
 */
function extractDataRows(contents: string): CoinbaseCsvRow[] {
  const lines = contents.split(/\r?\n/);
  const headerIndex = lines.findIndex(l => l.startsWith(HEADER_MARKER));
  if (headerIndex === -1) {
    throw new Error(
      'Coinbase CSV header not found. Expected a line starting with: ' +
      HEADER_MARKER,
    );
  }

  const csvBody = lines.slice(headerIndex).join('\n');
  const records = parseCsv(csvBody, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  return records.map(rec => ({
    id: rec['ID'] ?? '',
    timestamp: rec['Timestamp'] ?? '',
    transactionType: rec['Transaction Type'] ?? '',
    asset: rec['Asset'] ?? '',
    quantityTransacted: rec['Quantity Transacted'] ?? '',
    priceCurrency: rec['Price Currency'] ?? '',
    priceAtTransaction: rec['Price at Transaction'] ?? '',
    subtotal: rec['Subtotal'] ?? '',
    total: rec['Total (inclusive of fees and/or spread)'] ?? '',
    feesAndSpread: rec['Fees and/or Spread'] ?? '',
    notes: rec['Notes'] ?? '',
  })).filter(r => r.id);
}

/**
 * Merge preliminary internal_move events into pairs.
 *
 * Two distinct shapes show up in real Coinbase data:
 *
 *   - `Retail Staking Transfer` — same-asset pair (e.g. SOL/SOL), exact same
 *     timestamp, opposite signs. The asset never changes; only the
 *     "staked vs spendable" location does.
 *
 *   - `Retail Eth2 Deprecation` — CROSS-asset pair (ETH2 → ETH), with
 *     timestamps that may drift by ±5s in observed data. Different assets
 *     by design — it's an unwrap.
 *
 * The merger dispatches on the original Coinbase transactionType (preserved
 * in `event.notes` for these preliminary events) so each shape gets the
 * right pairing rule.
 *
 * Unmatched events are kept as singletons and a warning is logged.
 */
function mergeInternalMovePairs(
  events: RawEvent[],
  warn: (msg: string) => void,
): RawEvent[] {
  const merged: RawEvent[] = [];
  const consumed = new Set<string>();

  for (const e of events) {
    if (consumed.has(e.id)) continue;

    const partner = findPartner(e, events, consumed);
    if (!partner) {
      warn(`Internal-move event ${e.id} (${e.notes}) has no matching pair`);
      merged.push(e);
      consumed.add(e.id);
      continue;
    }

    // Merge — emit one event with both legs. Use the EARLIER ID for stability.
    const [first, second] = e.id < partner.id ? [e, partner] : [partner, e];
    merged.push({
      id: `${first.id}+${second.id.split(':')[1]}`,
      source: 'coinbase',
      accountId: e.accountId,
      timestamp: first.timestamp, // earlier of the two
      type: 'internal_move',
      legs: [...first.legs, ...second.legs],
      notes: first.notes,
      raw: { firstRow: first.raw, secondRow: second.raw },
    });
    consumed.add(first.id);
    consumed.add(second.id);
  }

  return merged;
}

/** ±5 seconds — observed real-world drift on Retail Eth2 Deprecation pairs. */
const ETH2_TIMESTAMP_TOLERANCE_MS = 5_000;

function findPartner(
  e: RawEvent,
  pool: RawEvent[],
  consumed: ReadonlySet<string>,
): RawEvent | undefined {
  const note = e.notes;
  if (note === 'Retail Staking Transfer') {
    return pool.find(
      c =>
        c.id !== e.id &&
        !consumed.has(c.id) &&
        c.notes === note &&
        c.timestamp.getTime() === e.timestamp.getTime() &&
        sameAsset(c, e) &&
        sameAbsAmount(c, e) &&
        oppositeSigns(c, e),
    );
  }
  if (note === 'Retail Eth2 Deprecation') {
    return pool.find(
      c =>
        c.id !== e.id &&
        !consumed.has(c.id) &&
        c.notes === note &&
        Math.abs(c.timestamp.getTime() - e.timestamp.getTime()) <=
          ETH2_TIMESTAMP_TOLERANCE_MS &&
        sameAbsAmount(c, e) &&
        oppositeSigns(c, e),
      // Note: assets differ by design (ETH2 → ETH), so we don't compare them.
    );
  }
  // Unknown internal_move shape — don't try to pair.
  return undefined;
}

function sameAsset(a: RawEvent, b: RawEvent): boolean {
  return a.legs[0]?.asset === b.legs[0]?.asset;
}

function sameAbsAmount(a: RawEvent, b: RawEvent): boolean {
  const aAmt = a.legs[0]?.amount;
  const bAmt = b.legs[0]?.amount;
  if (!aAmt || !bAmt) return false;
  return abs(aAmt) === abs(bAmt);
}

function oppositeSigns(a: RawEvent, b: RawEvent): boolean {
  const aAmt = a.legs[0]?.amount;
  const bAmt = b.legs[0]?.amount;
  if (!aAmt || !bAmt) return false;
  return aAmt.startsWith('-') !== bAmt.startsWith('-');
}

function abs(s: string): string {
  return s.startsWith('-') ? s.slice(1) : s;
}
