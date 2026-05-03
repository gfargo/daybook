/**
 * TXF (Tax Exchange Format) export and parser.
 *
 * Converts a `TaxResult` into a TXF v042 text file for import into
 * TurboTax and other tax preparation software. Also provides a parser
 * for round-trip testing.
 *
 * TXF v042 is a line-oriented text format with control markers:
 *   V — version, A — software, D — date, T — record type,
 *   N — tax line, C — copy, L — line, P — description,
 *   $ — amount, ^ — record terminator.
 *
 * Output uses CRLF line endings and ASCII encoding per the TXF spec.
 *
 * @see Requirements 3.1–3.7, 7.1–7.4
 */

import type { TaxResult } from './types.js';
import { formatIrsDate, formatMoney, formatDescription } from './format-helpers.js';

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Checkbox category for Form 8949 reporting.
 * A = reported on 1099-B with basis reported to IRS
 * B = reported on 1099-B without basis reported to IRS
 * C = not reported on 1099-B
 */
export type CheckboxCategory = 'A' | 'B' | 'C';

/**
 * A parsed TXF record representing one transaction.
 */
export interface TxfRecord {
  /** Tax line reference number (e.g. 321, 323, 711–714). */
  taxLine: number;
  /** Description: "<amount> <asset>". */
  description: string;
  /** Date acquired: MM/DD/YYYY. */
  dateAcquired: string;
  /** Date sold: MM/DD/YYYY. */
  dateSold: string;
  /** Cost basis as decimal string with 2 places. */
  costBasis: string;
  /** Proceeds as decimal string with 2 places. */
  proceeds: string;
}

/**
 * Result of parsing a TXF file.
 */
export type TxfParseResult =
  | { ok: true; records: TxfRecord[] }
  | { ok: false; error: string; line: number; field: string };

/**
 * Options for TXF formatting.
 */
export interface FormatTxfOptions {
  /** Checkbox category override. Default: 'C'. */
  checkbox?: CheckboxCategory | undefined;
}

// ─── Tax line mapping ────────────────────────────────────────────────────

/**
 * Tax line reference numbers by checkbox category and term.
 *
 * | Checkbox | Short-term | Long-term |
 * |----------|------------|-----------|
 * | A        | 321        | 323       |
 * | B        | 711        | 713       |
 * | C        | 712        | 714       |
 */
const TAX_LINES: Record<CheckboxCategory, { 'short-term': number; 'long-term': number }> = {
  A: { 'short-term': 321, 'long-term': 323 },
  B: { 'short-term': 711, 'long-term': 713 },
  C: { 'short-term': 712, 'long-term': 714 },
};

/** All valid short-term tax line numbers. */
const SHORT_TERM_LINES = new Set([321, 711, 712]);

/** All valid long-term tax line numbers. */
const LONG_TERM_LINES = new Set([323, 713, 714]);

/** All valid tax line numbers for disposal records. */
const ALL_TAX_LINES = new Set([...SHORT_TERM_LINES, ...LONG_TERM_LINES]);

// ─── CRLF helper ─────────────────────────────────────────────────────────

const CRLF = '\r\n';

// ─── Formatter ───────────────────────────────────────────────────────────

/**
 * Format a TaxResult as a TXF v042 string.
 *
 * Produces a header (V042, software identifier, date) followed by
 * one record per disposal. Short-term disposals use the short-term
 * tax line for the given checkbox category, long-term use the
 * long-term line.
 *
 * Output uses CRLF line endings and ASCII encoding per the TXF spec.
 *
 * @param result - The complete tax computation result.
 * @param options - Optional formatting options.
 * @returns TXF-formatted string.
 */
export function formatTxf(result: TaxResult, options?: FormatTxfOptions): string {
  const checkbox: CheckboxCategory = options?.checkbox ?? 'C';
  const lines = TAX_LINES[checkbox];

  // Header
  const parts: string[] = [
    'V042',
    'Adaybook',
    `D${formatIrsDate(new Date())}`,
    '^',
  ];

  // One record block per disposal
  for (const d of result.disposals) {
    const taxLine = lines[d.term];
    const desc = formatDescription(d.amount, d.asset);
    const dateSold = formatIrsDate(d.disposedAt);
    const dateAcquired = formatIrsDate(d.acquiredAt);
    const costBasis = formatMoney(d.costBasis);
    const proceeds = formatMoney(d.proceeds);

    parts.push(
      'TD',
      `N${taxLine}`,
      'C1',
      'L1',
      `P${desc}`,
      `D${dateAcquired}`,
      `D${dateSold}`,
      `$${costBasis}`,
      `$${proceeds}`,
      '^',
    );
  }

  return parts.join(CRLF) + CRLF;
}

// ─── Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a TXF string back into structured records.
 *
 * Validates required fields and date/amount formats.
 * Returns a discriminated union: success with records, or
 * failure with line number and field identification.
 *
 * @param txf - A TXF-formatted string.
 * @returns Parsed records or an error with location info.
 */
export function parseTxf(txf: string): TxfParseResult {
  // Normalize line endings: split on CRLF or LF
  const rawLines = txf.split(/\r?\n/);

  // Strip trailing empty line (from final CRLF)
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  // ── Validate header ──────────────────────────────────────────────────

  if (rawLines.length < 4) {
    return { ok: false, error: 'TXF file too short: missing header', line: 1, field: 'header' };
  }

  if (rawLines[0] !== 'V042') {
    return { ok: false, error: `Expected version line "V042", got "${rawLines[0]}"`, line: 1, field: 'version' };
  }

  if (!rawLines[1]!.startsWith('A')) {
    return { ok: false, error: `Expected software identifier starting with "A", got "${rawLines[1]}"`, line: 2, field: 'software' };
  }

  if (!rawLines[2]!.startsWith('D')) {
    return { ok: false, error: `Expected date line starting with "D", got "${rawLines[2]}"`, line: 3, field: 'date' };
  }

  if (rawLines[3] !== '^') {
    return { ok: false, error: `Expected header terminator "^", got "${rawLines[3]}"`, line: 4, field: 'terminator' };
  }

  // ── Parse records ────────────────────────────────────────────────────

  const records: TxfRecord[] = [];
  let i = 4; // Start after header

  while (i < rawLines.length) {
    const recordStartLine = i + 1; // 1-indexed for error reporting

    // Each record block: TD, N<taxLine>, C1, L1, P<desc>, D<dateAcquired>, D<dateSold>, $<costBasis>, $<proceeds>, ^
    if (i + 9 > rawLines.length) {
      return { ok: false, error: 'Incomplete record: not enough lines remaining', line: recordStartLine, field: 'record' };
    }

    // TD
    if (rawLines[i] !== 'TD') {
      return { ok: false, error: `Expected record type "TD", got "${rawLines[i]}"`, line: recordStartLine, field: 'recordType' };
    }
    i++;

    // N<taxLine>
    const nLine = rawLines[i]!;
    if (!nLine.startsWith('N')) {
      return { ok: false, error: `Expected tax line starting with "N", got "${nLine}"`, line: i + 1, field: 'taxLine' };
    }
    const taxLine = parseInt(nLine.slice(1), 10);
    if (isNaN(taxLine) || !ALL_TAX_LINES.has(taxLine)) {
      return { ok: false, error: `Invalid tax line number "${nLine.slice(1)}"`, line: i + 1, field: 'taxLine' };
    }
    i++;

    // C1
    if (rawLines[i] !== 'C1') {
      return { ok: false, error: `Expected "C1", got "${rawLines[i]}"`, line: i + 1, field: 'copy' };
    }
    i++;

    // L1
    if (rawLines[i] !== 'L1') {
      return { ok: false, error: `Expected "L1", got "${rawLines[i]}"`, line: i + 1, field: 'line' };
    }
    i++;

    // P<description>
    const pLine = rawLines[i]!;
    if (!pLine.startsWith('P')) {
      return { ok: false, error: `Expected description starting with "P", got "${pLine}"`, line: i + 1, field: 'description' };
    }
    const description = pLine.slice(1);
    if (description.length === 0) {
      return { ok: false, error: 'Empty description', line: i + 1, field: 'description' };
    }
    i++;

    // D<dateAcquired>
    const dAcqLine = rawLines[i]!;
    if (!dAcqLine.startsWith('D')) {
      return { ok: false, error: `Expected date acquired starting with "D", got "${dAcqLine}"`, line: i + 1, field: 'dateAcquired' };
    }
    const dateAcquired = dAcqLine.slice(1);
    if (!isValidIrsDate(dateAcquired)) {
      return { ok: false, error: `Invalid date acquired format "${dateAcquired}", expected MM/DD/YYYY`, line: i + 1, field: 'dateAcquired' };
    }
    i++;

    // D<dateSold>
    const dSoldLine = rawLines[i]!;
    if (!dSoldLine.startsWith('D')) {
      return { ok: false, error: `Expected date sold starting with "D", got "${dSoldLine}"`, line: i + 1, field: 'dateSold' };
    }
    const dateSold = dSoldLine.slice(1);
    if (!isValidIrsDate(dateSold)) {
      return { ok: false, error: `Invalid date sold format "${dateSold}", expected MM/DD/YYYY`, line: i + 1, field: 'dateSold' };
    }
    i++;

    // $<costBasis>
    const cbLine = rawLines[i]!;
    if (!cbLine.startsWith('$')) {
      return { ok: false, error: `Expected cost basis starting with "$", got "${cbLine}"`, line: i + 1, field: 'costBasis' };
    }
    const costBasis = cbLine.slice(1);
    if (!isValidAmount(costBasis)) {
      return { ok: false, error: `Invalid cost basis amount "${costBasis}"`, line: i + 1, field: 'costBasis' };
    }
    i++;

    // $<proceeds>
    const procLine = rawLines[i]!;
    if (!procLine.startsWith('$')) {
      return { ok: false, error: `Expected proceeds starting with "$", got "${procLine}"`, line: i + 1, field: 'proceeds' };
    }
    const proceeds = procLine.slice(1);
    if (!isValidAmount(proceeds)) {
      return { ok: false, error: `Invalid proceeds amount "${proceeds}"`, line: i + 1, field: 'proceeds' };
    }
    i++;

    // ^
    if (rawLines[i] !== '^') {
      return { ok: false, error: `Expected record terminator "^", got "${rawLines[i]}"`, line: i + 1, field: 'terminator' };
    }
    i++;

    records.push({ taxLine, description, dateAcquired, dateSold, costBasis, proceeds });
  }

  return { ok: true, records };
}

// ─── Validation helpers ──────────────────────────────────────────────────

/** Validate an IRS date string matches MM/DD/YYYY. */
function isValidIrsDate(value: string): boolean {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value);
}

/** Validate a monetary amount string (optional negative, digits, optional decimal with digits). */
function isValidAmount(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}
