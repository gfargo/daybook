/**
 * Unit tests for classifyTerm — calendar-anniversary holding period.
 *
 * The IRS test is "held more than one year" by calendar date, not by a
 * fixed day count. These tests pin the leap-year and exact-anniversary
 * boundaries in both directions.
 */

import { describe, expect, it } from 'vitest';
import { classifyTerm } from './holding-period.js';

describe('classifyTerm', () => {
  it('classifies a leap-year 366-day holding (exact one year) as short-term', () => {
    // 2024 is a leap year: 2024-01-01 → 2025-01-01 is 366 elapsed days
    // but exactly one calendar year.
    const acquired = new Date('2024-01-01T00:00:00Z');
    const disposed = new Date('2025-01-01T00:00:00Z');
    expect(classifyTerm(acquired, disposed)).toBe('short-term');
  });

  it('classifies the day after a leap-year anniversary as long-term', () => {
    const acquired = new Date('2024-01-01T00:00:00Z');
    const disposed = new Date('2025-01-02T00:00:00Z');
    expect(classifyTerm(acquired, disposed)).toBe('long-term');
  });

  it('classifies an exact non-leap 365-day anniversary as short-term', () => {
    // 2023 is not a leap year: 2023-01-01 → 2024-01-01 is 365 elapsed days
    // and exactly one calendar year.
    const acquired = new Date('2023-01-01T00:00:00Z');
    const disposed = new Date('2024-01-01T00:00:00Z');
    expect(classifyTerm(acquired, disposed)).toBe('short-term');
  });

  it('classifies the day after a non-leap anniversary as long-term', () => {
    const acquired = new Date('2023-01-01T00:00:00Z');
    const disposed = new Date('2024-01-02T00:00:00Z');
    expect(classifyTerm(acquired, disposed)).toBe('long-term');
  });

  it('normalizes a Feb-29 acquisition anniversary to Mar-1 in a non-leap year', () => {
    const acquired = new Date('2024-02-29T00:00:00Z');
    // 2025 is not a leap year, so the anniversary rolls to 2025-03-01.
    expect(classifyTerm(acquired, new Date('2025-03-01T00:00:00Z'))).toBe('short-term');
    expect(classifyTerm(acquired, new Date('2025-03-02T00:00:00Z'))).toBe('long-term');
  });

  it('classifies same-day acquisition and disposal as short-term', () => {
    const date = new Date('2024-06-15T00:00:00Z');
    expect(classifyTerm(date, date)).toBe('short-term');
  });
});
