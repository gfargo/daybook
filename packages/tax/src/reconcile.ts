/**
 * 1099-DA reconciliation.
 *
 * Starting with tax year 2025, crypto exchanges are required by the IRS
 * to issue Form 1099-DA reporting digital asset transactions. The
 * numbers on those forms — proceeds, cost basis, term, wash sale — may
 * differ from daybook's own computation (different lot selection,
 * different cost basis method, missing transfers, etc).
 *
 * This module:
 *   1. Parses 1099-DA data delivered as CSV (per-transaction detail rows)
 *   2. Matches each daybook DisposalResult against a 1099-DA transaction
 *   3. Flags discrepancies (missing on either side, value mismatches)
 *   4. Recommends a Form 8949 checkbox (A / B / C) based on the result
 *
 * Box A = reported to IRS and basis reported; daybook matches.
 * Box B = reported to IRS but basis not reported, or daybook has corrections.
 * Box C = not reported to IRS (no 1099-DA covers these disposals).
 *
 * @see https://www.irs.gov/forms-pubs/about-form-1099-da
 */

import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { DisposalResult } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * A single transaction line read from a 1099-DA CSV.
 *
 * Field names mirror the IRS Form 1099-DA box layout. Decimal amounts
 * are stored as strings so they can be compared exactly against
 * daybook's own decimal-string accounting.
 */
export interface Form1099DaTransaction {
  /** (1a) Date the asset was acquired. */
  dateAcquired: Date;
  /** (1b) Date the asset was sold or disposed. */
  dateSold: Date;
  /** (1c) Description, typically "<amount> <ticker>" (e.g., "1.5 ETH"). */
  description: string;
  /** Asset ticker extracted from the description (e.g., "ETH"). */
  asset: string;
  /** Units disposed. Decimal string. */
  amount: string;
  /** (1d) USD proceeds. Decimal string. */
  proceeds: string;
  /** (1e) Cost or other basis, if reported. Decimal string. Empty string if box was blank. */
  costBasis: string;
  /** (1f) Wash sale loss disallowed. Decimal string. Empty string if box was blank. */
  washSaleDisallowed: string;
  /** (1g) Holding period as reported. */
  term: 'short-term' | 'long-term' | 'unknown';
  /** Row number from the source CSV (for error reporting). 1-indexed including header. */
  sourceRow: number;
}

/**
 * Parsed 1099-DA document.
 */
export interface Form1099Da {
  /** Name of the issuer (e.g., "Coinbase"). Empty if not extractable. */
  issuer: string;
  /** Tax year covered by this form. */
  year: number;
  /** All per-transaction rows. */
  transactions: Form1099DaTransaction[];
  /** Warnings collected during parsing. */
  warnings: string[];
}

/**
 * Result of comparing a single daybook disposal against a 1099-DA transaction.
 */
export interface MatchResult {
  /** The daybook disposal. */
  disposal: DisposalResult;
  /** The matched 1099-DA transaction. */
  reported: Form1099DaTransaction;
  /** Differences detected between the two records. */
  discrepancies: FieldDiscrepancy[];
}

/**
 * A single field-level difference between daybook and 1099-DA.
 */
export interface FieldDiscrepancy {
  field: 'proceeds' | 'costBasis' | 'term' | 'amount' | 'dateAcquired';
  daybook: string;
  reported: string;
  /** Absolute difference for numeric fields. Decimal string. Empty for non-numeric fields. */
  delta: string;
}

/**
 * Overall reconciliation result.
 */
export interface ReconciliationReport {
  /** Tax year being reconciled. */
  year: number;
  /** Issuer of the 1099-DA. */
  issuer: string;
  /** Disposals that matched a 1099-DA transaction exactly (no discrepancies). */
  matched: MatchResult[];
  /** Disposals that matched but with one or more field discrepancies. */
  mismatched: MatchResult[];
  /** Daybook disposals with no corresponding 1099-DA transaction. */
  missingIn1099Da: DisposalResult[];
  /** 1099-DA transactions with no corresponding daybook disposal. */
  missingInDaybook: Form1099DaTransaction[];
  /** Recommended Form 8949 checkbox based on the reconciliation outcome. */
  recommendedCheckbox: 'A' | 'B' | 'C';
  /** Plain-text rationale for the recommended checkbox. */
  recommendedCheckboxReason: string;
  /** Warnings collected during parsing or matching. */
  warnings: string[];
}

/**
 * Options for matching daybook disposals to 1099-DA transactions.
 */
export interface ReconcileOptions {
  /**
   * Maximum days between daybook disposal date and 1099-DA sale date
   * to still be considered a match. Defaults to 1 (handles timezone
   * differences and same-day rounding).
   */
  dateToleranceDays?: number;
  /**
   * Maximum relative difference in amount (units) to still consider a
   * match. e.g., 0.001 = 0.1%. Defaults to 0.001.
   */
  amountTolerance?: number;
  /**
   * USD threshold below which a proceeds or cost basis difference is
   * not flagged as a discrepancy. Defaults to 0.01 (one cent).
   */
  moneyTolerance?: number;
}

// ─── CSV parsing ─────────────────────────────────────────────────────────

const DATE_ACQUIRED_ALIASES = [
  'date acquired',
  'acquired',
  'acquisition date',
  '1a',
  'box 1a',
  'date_acquired',
];

const DATE_SOLD_ALIASES = [
  'date sold',
  'date disposed',
  'sold',
  'disposal date',
  'sale date',
  '1b',
  'box 1b',
  'date_sold',
];

const DESCRIPTION_ALIASES = [
  'description',
  'description of property',
  '1c',
  'box 1c',
  'asset description',
];

const ASSET_ALIASES = ['asset', 'ticker', 'symbol', 'currency'];

const AMOUNT_ALIASES = ['amount', 'units', 'quantity', 'qty', 'number of units'];

const PROCEEDS_ALIASES = ['proceeds', 'gross proceeds', '1d', 'box 1d', 'proceeds usd'];

const COST_BASIS_ALIASES = [
  'cost basis',
  'cost or other basis',
  'basis',
  '1e',
  'box 1e',
  'cost_basis',
];

const WASH_SALE_ALIASES = [
  'wash sale loss disallowed',
  'wash sale',
  'wash sale disallowed',
  '1f',
  'box 1f',
];

const TERM_ALIASES = [
  'term',
  'holding period',
  'short or long term',
  '1g',
  'box 1g',
];

const ISSUER_ALIASES = ['issuer', 'payer', 'broker', 'exchange', 'filer'];

function normalizeHeader(header: string): string {
  return header.toLowerCase().trim().replace(/\s+/g, ' ');
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Accept ISO and MM/DD/YYYY
  const isoMatch = /^\d{4}-\d{2}-\d{2}/.test(trimmed);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (isoMatch) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }
  if (usMatch) {
    const [, mm, dd, yyyy] = usMatch;
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

function parseMoney(value: string): string {
  if (!value) return '';
  // Strip $, commas, parentheses (used for negatives in some exports)
  const trimmed = value.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[$,()]/g, '').replace(/\s+/g, '');
  if (cleaned === '' || cleaned === '-') return '';
  try {
    const dec = new Decimal(cleaned);
    return (negative ? dec.neg() : dec).toString();
  } catch {
    return '';
  }
}

function parseTerm(value: string): Form1099DaTransaction['term'] {
  const v = value.toLowerCase().trim();
  if (v.startsWith('short') || v === 's') return 'short-term';
  if (v.startsWith('long') || v === 'l') return 'long-term';
  return 'unknown';
}

/**
 * Extract a ticker symbol from a 1099-DA description like "1.5 ETH" or
 * "0.001 Bitcoin (BTC)". Falls back to the whole string if no clear
 * ticker is present.
 */
function extractAssetFromDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return '';
  // Parenthesized ticker: "Bitcoin (BTC)" → BTC
  const paren = /\(([A-Za-z0-9]{2,10})\)\s*$/.exec(trimmed);
  if (paren) return paren[1]!.toUpperCase();
  // "<amount> <ticker>" → ticker
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(last)) return last.toUpperCase();
  }
  return trimmed.toUpperCase();
}

/**
 * Extract an amount from a description like "1.5 ETH". Returns empty
 * string if no leading number is present.
 */
function extractAmountFromDescription(description: string): string {
  const match = /^([-+]?\d+(?:\.\d+)?)/.exec(description.trim());
  return match ? match[1]! : '';
}

/**
 * Parse a 1099-DA CSV into structured transactions.
 *
 * Expects one row per disposal. Recognizes the IRS box numbers (1a, 1b,
 * 1c, 1d, 1e, 1f, 1g) and a variety of human-readable column names. The
 * exact 1099-DA CSV format has not been standardized across issuers, so
 * the parser is column-name flexible.
 *
 * @param contents - The raw CSV text.
 * @param options - Optional metadata (e.g., issuer name, tax year) used
 *                  when the CSV doesn't carry it.
 * @returns A parsed `Form1099Da` document.
 */
export function parse1099DaCsv(
  contents: string,
  options: { issuer?: string; year?: number } = {},
): Form1099Da {
  const warnings: string[] = [];

  const records = parseCsv(contents, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Array<Record<string, string>>;

  const transactions: Form1099DaTransaction[] = [];
  let issuer = options.issuer ?? '';

  for (let i = 0; i < records.length; i++) {
    const raw = records[i]!;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      row[normalizeHeader(k)] = String(v ?? '').trim();
    }

    if (!issuer) {
      const candidate = findValue(row, ISSUER_ALIASES);
      if (candidate) issuer = candidate;
    }

    const dateAcquired = parseDate(findValue(row, DATE_ACQUIRED_ALIASES));
    const dateSold = parseDate(findValue(row, DATE_SOLD_ALIASES));
    const description = findValue(row, DESCRIPTION_ALIASES);
    const explicitAsset = findValue(row, ASSET_ALIASES);
    const explicitAmount = findValue(row, AMOUNT_ALIASES);
    const proceedsRaw = findValue(row, PROCEEDS_ALIASES);
    const costBasisRaw = findValue(row, COST_BASIS_ALIASES);
    const washSaleRaw = findValue(row, WASH_SALE_ALIASES);
    const termRaw = findValue(row, TERM_ALIASES);

    const sourceRow = i + 2; // +2 to account for header row and 1-indexing

    if (!dateSold) {
      warnings.push(`Row ${sourceRow}: missing or invalid date sold; skipped`);
      continue;
    }
    if (!description && !explicitAsset) {
      warnings.push(`Row ${sourceRow}: missing description and asset; skipped`);
      continue;
    }

    const asset = (explicitAsset || extractAssetFromDescription(description)).toUpperCase();
    const amount = explicitAmount || extractAmountFromDescription(description) || '';

    if (!amount) {
      warnings.push(`Row ${sourceRow}: could not determine amount; skipped`);
      continue;
    }

    const proceeds = parseMoney(proceedsRaw);
    if (!proceeds) {
      warnings.push(`Row ${sourceRow}: missing or invalid proceeds; skipped`);
      continue;
    }

    transactions.push({
      dateAcquired: dateAcquired ?? new Date(0),
      dateSold,
      description: description || `${amount} ${asset}`,
      asset,
      amount: new Decimal(amount).toString(),
      proceeds,
      costBasis: parseMoney(costBasisRaw),
      washSaleDisallowed: parseMoney(washSaleRaw),
      term: parseTerm(termRaw),
      sourceRow,
    });
  }

  // Infer year from the most common dateSold year if not provided
  let year = options.year ?? 0;
  if (!year && transactions.length > 0) {
    const counts = new Map<number, number>();
    for (const t of transactions) {
      const y = t.dateSold.getUTCFullYear();
      counts.set(y, (counts.get(y) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [y, c] of counts) {
      if (c > bestCount) {
        best = y;
        bestCount = c;
      }
    }
    year = best;
  }

  return { issuer, year, transactions, warnings };
}

// ─── Matching ────────────────────────────────────────────────────────────

const DEFAULT_DATE_TOLERANCE_DAYS = 1;
const DEFAULT_AMOUNT_TOLERANCE = 0.001;
const DEFAULT_MONEY_TOLERANCE = 0.01;

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function relativeDifference(a: string, b: string): number {
  const da = new Decimal(a);
  const db = new Decimal(b);
  if (da.isZero() && db.isZero()) return 0;
  const max = Decimal.max(da.abs(), db.abs());
  if (max.isZero()) return 0;
  return da.minus(db).abs().div(max).toNumber();
}

function pickBestMatch(
  disposal: DisposalResult,
  candidates: Form1099DaTransaction[],
  opts: Required<ReconcileOptions>,
): Form1099DaTransaction | null {
  let best: Form1099DaTransaction | null = null;
  let bestScore = Infinity;

  for (const c of candidates) {
    if (c.asset !== disposal.asset.toUpperCase()) continue;
    const dDays = daysBetween(c.dateSold, disposal.disposedAt);
    if (dDays > opts.dateToleranceDays) continue;
    const aDiff = relativeDifference(c.amount, disposal.amount);
    if (aDiff > opts.amountTolerance) continue;

    // Score: prefer closest date, then closest amount
    const score = dDays * 10 + aDiff;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }

  return best;
}

function detectFieldDiscrepancies(
  disposal: DisposalResult,
  reported: Form1099DaTransaction,
  opts: Required<ReconcileOptions>,
): FieldDiscrepancy[] {
  const out: FieldDiscrepancy[] = [];

  // Proceeds
  const proceedsDelta = new Decimal(disposal.proceeds).minus(new Decimal(reported.proceeds)).abs();
  if (proceedsDelta.gt(opts.moneyTolerance)) {
    out.push({
      field: 'proceeds',
      daybook: disposal.proceeds,
      reported: reported.proceeds,
      delta: proceedsDelta.toString(),
    });
  }

  // Cost basis — only flag if 1099-DA reported a basis at all
  if (reported.costBasis !== '') {
    const basisDelta = new Decimal(disposal.costBasis).minus(new Decimal(reported.costBasis)).abs();
    if (basisDelta.gt(opts.moneyTolerance)) {
      out.push({
        field: 'costBasis',
        daybook: disposal.costBasis,
        reported: reported.costBasis,
        delta: basisDelta.toString(),
      });
    }
  }

  // Term — only flag if 1099-DA reported a term
  if (reported.term !== 'unknown' && reported.term !== disposal.term) {
    out.push({
      field: 'term',
      daybook: disposal.term,
      reported: reported.term,
      delta: '',
    });
  }

  // Date acquired — only flag if 1099-DA reported a valid date (not epoch)
  if (reported.dateAcquired.getTime() > 0) {
    if (daysBetween(reported.dateAcquired, disposal.acquiredAt) > opts.dateToleranceDays) {
      out.push({
        field: 'dateAcquired',
        daybook: disposal.acquiredAt.toISOString().slice(0, 10),
        reported: reported.dateAcquired.toISOString().slice(0, 10),
        delta: '',
      });
    }
  }

  return out;
}

/**
 * Reconcile daybook disposals against a 1099-DA document.
 *
 * For each daybook disposal, finds the best matching 1099-DA
 * transaction (by asset + date proximity + amount proximity) and
 * compares field values. Any disposal or 1099-DA row left unmatched is
 * surfaced separately.
 *
 * @param disposals - Daybook's computed disposals for the tax year.
 * @param form1099Da - The parsed 1099-DA document to reconcile against.
 * @param options - Tolerances for matching and field comparison.
 * @returns A `ReconciliationReport` with matches, discrepancies, and a
 *          recommended Form 8949 checkbox.
 */
export function reconcile(
  disposals: DisposalResult[],
  form1099Da: Form1099Da,
  options: ReconcileOptions = {},
): ReconciliationReport {
  const opts: Required<ReconcileOptions> = {
    dateToleranceDays: options.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS,
    amountTolerance: options.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE,
    moneyTolerance: options.moneyTolerance ?? DEFAULT_MONEY_TOLERANCE,
  };

  const remaining = new Set(form1099Da.transactions);
  const matched: MatchResult[] = [];
  const mismatched: MatchResult[] = [];
  const missingIn1099Da: DisposalResult[] = [];

  for (const disposal of disposals) {
    const match = pickBestMatch(disposal, [...remaining], opts);
    if (!match) {
      missingIn1099Da.push(disposal);
      continue;
    }
    remaining.delete(match);

    const discrepancies = detectFieldDiscrepancies(disposal, match, opts);
    const result: MatchResult = { disposal, reported: match, discrepancies };
    if (discrepancies.length === 0) {
      matched.push(result);
    } else {
      mismatched.push(result);
    }
  }

  const missingInDaybook = [...remaining];

  const { checkbox, reason } = recommendCheckbox({
    matched,
    mismatched,
    missingIn1099Da,
    missingInDaybook,
  });

  return {
    year: form1099Da.year,
    issuer: form1099Da.issuer,
    matched,
    mismatched,
    missingIn1099Da,
    missingInDaybook,
    recommendedCheckbox: checkbox,
    recommendedCheckboxReason: reason,
    warnings: form1099Da.warnings,
  };
}

// ─── Checkbox recommendation ─────────────────────────────────────────────

interface CheckboxInputs {
  matched: MatchResult[];
  mismatched: MatchResult[];
  missingIn1099Da: DisposalResult[];
  missingInDaybook: Form1099DaTransaction[];
}

/**
 * Recommend a Form 8949 checkbox category based on a reconciliation.
 *
 * The IRS definitions:
 *   A — Short-term transactions reported on 1099-B with basis reported to IRS
 *   B — Short-term transactions reported on 1099-B but basis NOT reported
 *   C — Short-term transactions NOT reported on a 1099-B
 *
 * (D/E/F are the long-term analogues; the same A/B/C value is used and
 * Form 8949 maps it to the correct page.)
 *
 * Heuristic:
 *   - All matched cleanly with cost basis reported on 1099-DA → A
 *   - Reported on 1099-DA but with corrections (mismatches), or basis
 *     missing from the 1099-DA → B
 *   - Nothing reported on 1099-DA, or daybook has disposals not on the
 *     1099-DA → C (those particular disposals were not reported)
 *
 * If the situation is mixed (some matched, some not), this returns the
 * most conservative answer for the bulk of the disposals. The caller
 * should still review on a per-disposal basis for filing.
 */
export function recommendCheckbox(inputs: CheckboxInputs): {
  checkbox: 'A' | 'B' | 'C';
  reason: string;
} {
  const matchedCount = inputs.matched.length;
  const mismatchedCount = inputs.mismatched.length;
  const missingIn1099DaCount = inputs.missingIn1099Da.length;
  const missingInDaybookCount = inputs.missingInDaybook.length;
  const total = matchedCount + mismatchedCount + missingIn1099DaCount;

  if (total === 0) {
    return {
      checkbox: 'C',
      reason: 'No disposals to reconcile.',
    };
  }

  // If most disposals don't appear on the 1099-DA, box C applies to them.
  if (missingIn1099DaCount > matchedCount + mismatchedCount) {
    return {
      checkbox: 'C',
      reason: `${missingIn1099DaCount} of ${total} disposals are not reported on the 1099-DA.`,
    };
  }

  // If we have mismatches or 1099-DA didn't report basis, box B applies.
  const matchedWithReportedBasis = inputs.matched.filter(
    (m) => m.reported.costBasis !== '',
  ).length;
  const matchedWithoutBasis = matchedCount - matchedWithReportedBasis;
  const needsCorrection = mismatchedCount > 0 || matchedWithoutBasis > 0;

  if (needsCorrection) {
    const reasons: string[] = [];
    if (mismatchedCount > 0) reasons.push(`${mismatchedCount} mismatches`);
    if (matchedWithoutBasis > 0) reasons.push(`${matchedWithoutBasis} without reported basis`);
    if (missingInDaybookCount > 0) reasons.push(`${missingInDaybookCount} 1099-DA rows not in daybook`);
    return {
      checkbox: 'B',
      reason: `Reported on 1099-DA with corrections needed: ${reasons.join(', ')}.`,
    };
  }

  return {
    checkbox: 'A',
    reason: `All ${matchedCount} disposals match the 1099-DA with basis reported.`,
  };
}

// ─── Form 8949 box assignment ────────────────────────────────────────────

/**
 * Per-disposal Form 8949 box category, derived from a reconciliation.
 *
 * The shape mirrors `Map<sourceEntryId, 'A' | 'B' | 'C'>` so it can be
 * passed directly to `buildForm8949Data` via `Form8949Options.disposalCheckboxes`.
 *
 * Assignment rules:
 *   - Matched cleanly **and** 1099-DA reported a cost basis → **A**
 *     (reported to IRS with basis).
 *   - Matched cleanly but basis was blank on the 1099-DA → **B**
 *     (reported, but basis must be filled in).
 *   - Matched with field-level discrepancies → **B**
 *     (reported, but requires a correction).
 *   - Not on the 1099-DA → **C**
 *     (not reported to the IRS).
 */
export function classifyDisposalsForForm8949(
  report: ReconciliationReport,
): Map<string, 'A' | 'B' | 'C'> {
  const out = new Map<string, 'A' | 'B' | 'C'>();

  for (const m of report.matched) {
    out.set(
      m.disposal.sourceEntryId,
      m.reported.costBasis !== '' ? 'A' : 'B',
    );
  }
  for (const m of report.mismatched) {
    out.set(m.disposal.sourceEntryId, 'B');
  }
  for (const d of report.missingIn1099Da) {
    out.set(d.sourceEntryId, 'C');
  }

  return out;
}

// ─── Text formatting ─────────────────────────────────────────────────────

/**
 * Format a reconciliation report as a human-readable text report.
 *
 * Suitable for printing to a terminal. JSON callers should serialize
 * the `ReconciliationReport` object directly.
 */
export function formatReconciliationReport(report: ReconciliationReport): string {
  const lines: string[] = [];
  const total =
    report.matched.length +
    report.mismatched.length +
    report.missingIn1099Da.length;

  lines.push(`1099-DA reconciliation — ${report.year}`);
  if (report.issuer) lines.push(`  Issuer:              ${report.issuer}`);
  lines.push(`  Daybook disposals:   ${total}`);
  lines.push(`  Matched:             ${report.matched.length}`);
  lines.push(`  Mismatched:          ${report.mismatched.length}`);
  lines.push(`  Missing on 1099-DA:  ${report.missingIn1099Da.length}`);
  lines.push(`  Missing in daybook:  ${report.missingInDaybook.length}`);
  lines.push('');
  lines.push(`  Recommended Form 8949 checkbox: ${report.recommendedCheckbox}`);
  lines.push(`    ${report.recommendedCheckboxReason}`);

  if (report.mismatched.length > 0) {
    lines.push('');
    lines.push('Mismatches:');
    for (const m of report.mismatched.slice(0, 25)) {
      const fields = m.discrepancies.map((d) => d.field).join(', ');
      lines.push(
        `  ${m.disposal.asset} ${m.disposal.amount} on ` +
          `${m.disposal.disposedAt.toISOString().slice(0, 10)} — diff: ${fields}`,
      );
      for (const d of m.discrepancies) {
        lines.push(`    ${d.field}: daybook=${d.daybook} reported=${d.reported}`);
      }
    }
    if (report.mismatched.length > 25) {
      lines.push(`  ... and ${report.mismatched.length - 25} more`);
    }
  }

  if (report.missingIn1099Da.length > 0) {
    lines.push('');
    lines.push('Daybook disposals not on the 1099-DA:');
    for (const d of report.missingIn1099Da.slice(0, 25)) {
      lines.push(
        `  ${d.asset} ${d.amount} on ${d.disposedAt.toISOString().slice(0, 10)} ` +
          `(proceeds ${d.proceeds}, basis ${d.costBasis})`,
      );
    }
    if (report.missingIn1099Da.length > 25) {
      lines.push(`  ... and ${report.missingIn1099Da.length - 25} more`);
    }
  }

  if (report.missingInDaybook.length > 0) {
    lines.push('');
    lines.push('1099-DA rows not in daybook:');
    for (const r of report.missingInDaybook.slice(0, 25)) {
      lines.push(
        `  ${r.asset} ${r.amount} on ${r.dateSold.toISOString().slice(0, 10)} ` +
          `(row ${r.sourceRow}, proceeds ${r.proceeds})`,
      );
    }
    if (report.missingInDaybook.length > 25) {
      lines.push(`  ... and ${report.missingInDaybook.length - 25} more`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const w of report.warnings.slice(0, 10)) {
      lines.push(`  - ${w}`);
    }
    if (report.warnings.length > 10) {
      lines.push(`  ... and ${report.warnings.length - 10} more`);
    }
  }

  return lines.join('\n');
}
