/**
 * Shared formatting helpers for IRS tax form generation.
 *
 * Used by Form 8949, Schedule D, and TXF formatters to produce
 * consistently formatted dates, monetary values, and descriptions.
 *
 * All monetary formatting uses decimal.js to avoid floating-point
 * artifacts — amounts are stored as strings and converted to Decimal
 * at the formatting boundary.
 */

import Decimal from 'decimal.js';

// ─── Date formatting ─────────────────────────────────────────────────────

/**
 * Format a Date as MM/DD/YYYY for IRS form fields.
 *
 * Uses UTC components to avoid timezone-related date shifts.
 * Throws if the date is invalid (e.g., `new Date('garbage')`).
 *
 * @param date - The date to format.
 * @returns Date string in MM/DD/YYYY format.
 * @throws {Error} If the date is invalid.
 */
export function formatIrsDate(date: Date): string {
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: cannot format "${String(date)}" as MM/DD/YYYY`);
  }

  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const yyyy = String(date.getUTCFullYear());

  return `${mm}/${dd}/${yyyy}`;
}

// ─── Monetary formatting ─────────────────────────────────────────────────

/**
 * Format a decimal string to exactly two decimal places.
 *
 * Converts the input to a Decimal and calls `toFixed(2)`.
 * No dollar signs, no commas — matches IRS form field conventions.
 *
 * @param value - Decimal string (e.g., "1234.5", "-0.1", "0").
 * @returns Formatted string with exactly 2 decimal places (e.g., "1234.50").
 */
export function formatMoney(value: string): string {
  return new Decimal(value).toFixed(2);
}

// ─── Description formatting ──────────────────────────────────────────────

/**
 * Format a disposal description for IRS form fields.
 *
 * Produces `"<amount> <asset>"` (e.g., "1.5 ETH", "0.00123 BTC").
 *
 * @param amount - The amount disposed (decimal string).
 * @param asset - The asset ticker symbol.
 * @returns Formatted description string.
 */
export function formatDescription(amount: string, asset: string): string {
  return `${amount} ${asset}`;
}
