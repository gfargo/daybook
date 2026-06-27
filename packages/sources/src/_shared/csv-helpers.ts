/**
 * Shared CSV-parsing helpers for source adapters.
 *
 * Extracted from the per-exchange adapters that ship in this package
 * (OKX, Bybit, MEXC, Gate.io, Bitget) where ~12 identical helpers had
 * been copy-pasted. Adapters can extend `FIAT_CURRENCIES` for region-
 * specific currencies and provide their own `QUOTE_CANDIDATES` lists.
 *
 * Pre-existing adapters (binance, coinbase, crypto-com, gemini, kraken,
 * robinhood, generic-csv) still inline their helpers — they predate
 * this extraction and have small drifts that aren't worth chasing.
 */

import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import Decimal from 'decimal.js';
import type { AssetLeg, RawEvent } from '@daybook/ledger';

/**
 * Base fiat currency set used by source adapters. Includes the major
 * regional currencies supported across the exchanges daybook covers.
 * Adapters may extend by composing a new Set if they need additional
 * codes; pull requests adding to this set are also welcome.
 */
export const FIAT_CURRENCIES: ReadonlySet<string> = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'CHF',
  'CNY',
  'HKD',
  'SGD',
  'BRL',
]);

/** A CSV row, indexed by raw header name. */
export type CsvRow = Record<string, string>;

/**
 * A CSV row with a normalized lookup table.
 *
 * `values` is keyed by the normalized header (lowercased, alphanumeric-
 * only) so adapters can look up columns via header aliases without
 * worrying about whitespace, casing, BOMs, or trailing CRs.
 */
export interface NormalizedRow {
  /** 1-indexed row number (data rows start at 2 — row 1 is the header). */
  rowNumber: number;
  /** The original row as parsed by csv-parse. */
  original: CsvRow;
  /** Lookup table keyed by `normalizeHeader(header)`. */
  values: Record<string, string>;
}

/**
 * Parse a CSV blob into normalized rows.
 *
 * Uses csv-parse with the standard daybook configuration: BOM-tolerant,
 * header-driven, trim whitespace, allow ragged rows.
 */
export function parseCsvRows(contents: string): NormalizedRow[] {
  const records = parseCsv(contents, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as CsvRow[];

  return records.map((record, index) => {
    const values: Record<string, string> = {};
    for (const [header, rawValue] of Object.entries(record)) {
      values[normalizeHeader(header)] = String(rawValue ?? '').trim();
    }
    return {
      rowNumber: index + 2,
      original: record,
      values,
    };
  });
}

/**
 * Look up a column by any of its alias names.
 *
 * Aliases are normalized the same way as headers, so callers can use
 * the natural form (`"Date Acquired"`, `"date_acquired"`, etc.) without
 * worrying about casing.
 */
export function pick(row: NormalizedRow, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = row.values[normalizeHeader(alias)];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Parse a numeric cell tolerantly: strips currency symbols, commas,
 * spaces, and parenthesized negatives (`(50)` → `-50`).
 *
 * Returns `undefined` for empty / unparsable input. By default returns
 * `Decimal(0)` for the literal string `"0"` so callers can distinguish
 * "missing" from "explicitly zero." Pass `{ zeroAsUndefined: true }`
 * to drop zero-amount rows at the parser level — used by older
 * adapters that treat zero-amount CSV rows as noise to skip.
 */
export function parseAmount(
  value: string | undefined,
  options: { zeroAsUndefined?: boolean } = {},
): Decimal | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return undefined;
  const negativeByParens = trimmed.startsWith('(') && trimmed.endsWith(')');
  const sanitized = trimmed
    .replace(/^\((.*)\)$/, '$1')
    .replace(/[$£€¥,\s]/g, '');
  if (!sanitized) return undefined;
  try {
    const decimal = new Decimal(sanitized);
    if (options.zeroAsUndefined && decimal.isZero()) return undefined;
    return negativeByParens ? decimal.negated() : decimal;
  } catch {
    return undefined;
  }
}

/**
 * Parse a timestamp. Accepts:
 *   - ISO 8601 (`2024-01-15T12:34:56Z`)
 *   - Plain space-separated UTC (`2024-01-15 12:34:56`, assumed UTC)
 *   - 13-digit Unix milliseconds (`1707561600000`)
 *
 * Tolerates a trailing CR (some exchange exports include one).
 */
export function parseTimestamp(value: string): Date | undefined {
  const trimmed = value.trim().replace(/\r$/, '');
  if (!trimmed) return undefined;
  if (/^\d{13}$/.test(trimmed)) {
    const ms = Number(trimmed);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}${hasTimeZone(trimmed) ? '' : 'Z'}`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function hasTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

/**
 * Normalize an asset ticker. Uppercases plain tickers; lowercases
 * 0x-prefixed contract addresses so they round-trip through hex
 * comparisons consistently.
 */
export function normalizeAsset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

/**
 * Normalize a header name for alias lookups: strip BOM and trailing CR,
 * lowercase, and remove non-alphanumeric characters so `"Date & Time
 * (UTC)"` and `"datetimeutc"` match.
 */
export function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Build an `AssetLeg`. Decimal amounts are serialized with `toFixed()`
 * to preserve precision without scientific notation.
 */
export function assetLeg(asset: string, amount: Decimal, feeFlag = false): AssetLeg {
  return {
    asset,
    amount: amount.toFixed(),
    ...(feeFlag ? { feeFlag: true } : {}),
  };
}

/**
 * Suffix duplicate event IDs with a counter so multiple events
 * generated from rows that collide on a native ID stay distinct.
 */
export function suffixDuplicateIds(events: RawEvent[]): RawEvent[] {
  const counts = new Map<string, number>();
  return events.map((event) => {
    const count = counts.get(event.id) ?? 0;
    counts.set(event.id, count + 1);
    return count === 0 ? event : { ...event, id: `${event.id}:${count + 1}` };
  });
}

/**
 * Sanitize a native ID for safe use as part of an event ID:
 * alphanumerics, `.`, `_`, `-` only; max 120 chars. Falls back to a
 * stable hash of the raw value if sanitization produces an empty string.
 */
export function sanitizeNativeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  if (sanitized) return sanitized;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Produce a stable 16-character hash from one or more rows. Used for
 * synthesizing event IDs when a source has no native ID column.
 */
export function hashRows(rows: ReadonlyArray<CsvRow>): string {
  const stable = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => `${key}=${row[key] ?? ''}`)
        .join('\n'),
    )
    .join('\n---\n');
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * Hash an arbitrary string with the same algorithm as `hashRows` so
 * adapters that build their own ID seeds (e.g., MEXC trades hashing
 * only load-bearing fields) produce IDs in the same format.
 */
export function hashString(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}
