/**
 * Holding-period classification — short-term vs. long-term.
 *
 * The IRS test is "held more than one year" by calendar date, not by a
 * fixed day count. A fixed 365-day threshold misclassifies holdings that
 * span a leap day: buying 2024-01-01 and selling 2025-01-01 is exactly
 * one year (366 elapsed days, since 2024 is a leap year) and must be
 * short-term, not long-term.
 */

/** Add one calendar year to a UTC date, using UTC components. */
function addOneYear(date: Date): Date {
  const result = new Date(date.getTime());
  result.setUTCFullYear(result.getUTCFullYear() + 1);
  return result;
}

/**
 * Classify a disposal as short-term or long-term by calendar anniversary.
 *
 * A holding is long-term only if `disposedAt` is strictly after the
 * one-year anniversary of `acquiredAt` (the exact anniversary is still
 * short-term).
 *
 * @param acquiredAt - When the asset was acquired.
 * @param disposedAt - When the asset was disposed.
 * @returns 'long-term' if held more than one year, else 'short-term'.
 */
export function classifyTerm(
  acquiredAt: Date,
  disposedAt: Date,
): 'short-term' | 'long-term' {
  return addOneYear(acquiredAt).getTime() < disposedAt.getTime()
    ? 'long-term'
    : 'short-term';
}
