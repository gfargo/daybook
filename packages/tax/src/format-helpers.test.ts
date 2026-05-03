/**
 * Unit tests for shared IRS formatting helpers.
 *
 * Validates:
 *   - formatIrsDate: MM/DD/YYYY output, zero-padding, edge dates, invalid date rejection
 *   - formatMoney: 2-decimal-place output, zero/negative/large/rounding cases
 *   - formatDescription: "<amount> <asset>" output
 *
 * **Validates: Requirements 1.6, 1.7**
 */

import { describe, expect, it } from 'vitest';
import { formatIrsDate, formatMoney, formatDescription } from './format-helpers.js';

// ─── formatIrsDate ───────────────────────────────────────────────────────

describe('formatIrsDate', () => {
  it('formats Jan 1 with zero-padded month and day', () => {
    const date = new Date(Date.UTC(2024, 0, 1));
    expect(formatIrsDate(date)).toBe('01/01/2024');
  });

  it('formats Dec 31', () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    expect(formatIrsDate(date)).toBe('12/31/2024');
  });

  it('formats leap year Feb 29', () => {
    const date = new Date(Date.UTC(2024, 1, 29));
    expect(formatIrsDate(date)).toBe('02/29/2024');
  });

  it('zero-pads single-digit months', () => {
    const date = new Date(Date.UTC(2023, 2, 15)); // March
    expect(formatIrsDate(date)).toBe('03/15/2023');
  });

  it('zero-pads single-digit days', () => {
    const date = new Date(Date.UTC(2023, 9, 5)); // Oct 5
    expect(formatIrsDate(date)).toBe('10/05/2023');
  });

  it('handles double-digit months and days without extra padding', () => {
    const date = new Date(Date.UTC(2025, 10, 22)); // Nov 22
    expect(formatIrsDate(date)).toBe('11/22/2025');
  });

  it('throws on invalid Date', () => {
    expect(() => formatIrsDate(new Date('garbage'))).toThrow('Invalid date');
  });

  it('throws on NaN date with a descriptive message', () => {
    expect(() => formatIrsDate(new Date(NaN))).toThrow(
      'Invalid date: cannot format',
    );
  });
});

// ─── formatMoney ─────────────────────────────────────────────────────────

describe('formatMoney', () => {
  it('formats zero as "0.00"', () => {
    expect(formatMoney('0')).toBe('0.00');
  });

  it('formats negative values', () => {
    expect(formatMoney('-123.4')).toBe('-123.40');
  });

  it('formats large values without commas', () => {
    expect(formatMoney('1234567.89')).toBe('1234567.89');
  });

  it('rounds values with more than 2 decimal places', () => {
    expect(formatMoney('99.999')).toBe('100.00');
  });

  it('pads values with fewer than 2 decimal places', () => {
    expect(formatMoney('42')).toBe('42.00');
    expect(formatMoney('42.1')).toBe('42.10');
  });

  it('preserves exact 2-decimal-place values', () => {
    expect(formatMoney('1234.56')).toBe('1234.56');
  });

  it('handles very small values', () => {
    expect(formatMoney('0.01')).toBe('0.01');
  });

  it('handles negative zero', () => {
    // Decimal('-0').toFixed(2) produces '0.00' in decimal.js
    expect(formatMoney('-0')).toBe('0.00');
  });

  it('rounds 0.005 up to 0.01 (banker rounding)', () => {
    // decimal.js default rounding is ROUND_HALF_UP
    expect(formatMoney('0.005')).toBe('0.01');
  });
});

// ─── formatDescription ───────────────────────────────────────────────────

describe('formatDescription', () => {
  it('produces "<amount> <asset>" for standard case', () => {
    expect(formatDescription('1.5', 'ETH')).toBe('1.5 ETH');
  });

  it('handles decimal amounts', () => {
    expect(formatDescription('0.00123', 'BTC')).toBe('0.00123 BTC');
  });

  it('handles whole number amounts', () => {
    expect(formatDescription('100', 'MATIC')).toBe('100 MATIC');
  });
});

// ─── Property-based tests ────────────────────────────────────────────────

import * as fc from 'fast-check';
import { arbDate } from './test-helpers.js';

describe('property-based tests', () => {
  // Feature: tax-form-generation, Property 12: IRS date format invariant
  it('formatIrsDate output matches MM/DD/YYYY pattern for any valid date', () => {
    fc.assert(
      fc.property(arbDate, (date) => {
        const result = formatIrsDate(date);

        // Must match the overall MM/DD/YYYY pattern
        expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);

        // Parse and validate individual components
        const [mm, dd, yyyy] = result.split('/');
        const month = Number(mm);
        const day = Number(dd);
        const year = Number(yyyy);

        // MM is 01–12
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);

        // DD is 01–31
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(31);

        // YYYY is 4 digits
        expect(yyyy).toHaveLength(4);
        expect(year).toBeGreaterThanOrEqual(1000);
        expect(year).toBeLessThanOrEqual(9999);
      }),
      { numRuns: 100 },
    );
  });

  // **Validates: Requirements 1.6**
});
