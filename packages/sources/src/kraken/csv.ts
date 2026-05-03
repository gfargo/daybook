/**
 * Kraken CSV file → RawEvent[].
 *
 * The "Export Ledger" CSV from Kraken is a standard CSV with a header row:
 *
 *   "txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"
 *
 * Some exports may have preamble rows before the header. We detect the header
 * by looking for the literal `"txid"` column.
 *
 * Trade pairing: Kraken emits two rows per trade (one per side), linked by
 * `refid`. We group all `type === 'trade'` rows by `refid`, then for each
 * group of exactly 2 rows produce one `trade` RawEvent. Groups with ≠ 2 rows
 * are emitted as `unknown` with a warning.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import type { RawEvent } from '@daybook/ledger';
import {
    type KrakenRow,
    buildTradeEvent,
    buildDepositEvent,
    buildWithdrawalEvent,
    buildStakingEvent,
    buildUnknownEvent,
} from './row.js';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface ParseKrakenOptions {
  /** Account ID assigned to all events from this file. */
  accountId: string;
}

export interface ParseKrakenResult {
  /** Produced RawEvents, sorted by timestamp ascending. */
  events: RawEvent[];
  /** How many raw CSV data rows were read. */
  totalRows: number;
  /** Warnings collected during parsing (unpaired trades, unknown types). */
  warnings: string[];
}

/**
 * Parse a Kraken "Export Ledger" CSV file.
 *
 * Idempotent: same input → same output (events with same IDs).
 */
export function parseKrakenCsv(
  contents: string,
  options: ParseKrakenOptions,
): ParseKrakenResult {
  const warnings: string[] = [];
  const rows = extractDataRows(contents);
  const opts = { accountId: options.accountId };

  // Separate trade rows (need pairing) from single-row event types
  const tradeGroups = new Map<string, KrakenRow[]>();
  const singles: KrakenRow[] = [];

  for (const row of rows) {
    if (row.type === 'trade') {
      const group = tradeGroups.get(row.refid) ?? [];
      group.push(row);
      tradeGroups.set(row.refid, group);
    } else {
      singles.push(row);
    }
  }

  const events: RawEvent[] = [];

  // Process trade pairs
  for (const [refid, group] of tradeGroups) {
    if (group.length === 2) {
      events.push(buildTradeEvent(refid, group as [KrakenRow, KrakenRow], opts));
    } else {
      warnings.push(
        `Trade refid ${refid} has ${group.length} rows (expected 2) — emitting as unknown`,
      );
      for (const row of group) {
        events.push(buildUnknownEvent(row, opts));
      }
    }
  }

  // Process single-row events
  for (const row of singles) {
    events.push(buildSingleEvent(row, opts, warnings));
  }

  // Sort by timestamp ascending for stable output
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    events,
    totalRows: rows.length,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Route a non-trade row to the appropriate builder.
 */
function buildSingleEvent(
  row: KrakenRow,
  opts: { accountId: string },
  warnings: string[],
): RawEvent {
  switch (row.type) {
    case 'deposit':
      return buildDepositEvent(row, opts);

    case 'withdrawal':
      return buildWithdrawalEvent(row, opts);

    case 'staking':
      return buildStakingEvent(row, opts);

    default:
      // Also catch staking via subtype (some exports use transfer + stakingfromspot)
      if (row.subtype === 'stakingfromspot') {
        return buildStakingEvent(row, opts);
      }
      warnings.push(`Unknown Kraken row type: ${row.type} (txid: ${row.txid})`);
      return buildUnknownEvent(row, opts);
  }
}

const HEADER_MARKER = '"txid"';

/**
 * Strip any preamble rows before the header and parse the CSV body.
 */
function extractDataRows(contents: string): KrakenRow[] {
  const lines = contents.split(/\r?\n/);
  const headerIndex = lines.findIndex(l => l.trimStart().startsWith(HEADER_MARKER));

  // If no quoted header found, try unquoted
  const effectiveIndex = headerIndex !== -1
    ? headerIndex
    : lines.findIndex(l => l.trimStart().startsWith('txid'));

  if (effectiveIndex === -1) {
    throw new Error(
      'Kraken CSV header not found. Expected a line starting with: txid',
    );
  }

  const csvBody = lines.slice(effectiveIndex).join('\n');
  const records = parseCsv(csvBody, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  return records
    .map(rec => ({
      txid: rec['txid'] ?? '',
      refid: rec['refid'] ?? '',
      time: rec['time'] ?? '',
      type: rec['type'] ?? '',
      subtype: rec['subtype'] ?? '',
      aclass: rec['aclass'] ?? '',
      asset: rec['asset'] ?? '',
      amount: rec['amount'] ?? '0',
      fee: rec['fee'] ?? '0',
      balance: rec['balance'] ?? '0',
    }))
    .filter(r => r.txid !== '');
}
