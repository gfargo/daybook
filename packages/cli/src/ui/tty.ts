/**
 * TTY detection and graceful degradation utilities.
 *
 * Provides helpers for detecting terminal capabilities and failing
 * gracefully when interactive features aren't available.
 *
 * See `docs/cli-design-system.md` § "Edge cases & graceful degradation".
 */

// ─── TTY detection ───────────────────────────────────────────────────────

/** Whether stdout is a TTY (interactive terminal). */
export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

/** Current terminal width in columns, defaulting to 80 if unknown. */
export function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Whether the terminal is narrower than the design baseline (80 cells). */
export function isNarrowTerminal(): boolean {
  return terminalWidth() < 80;
}

// ─── Interactive guard ───────────────────────────────────────────────────

/**
 * Throw a clear error if an interactive prompt is required but stdout
 * is not a TTY (e.g., piped to a file or `less`).
 *
 * @param fallbackHint - Suggestion for the non-interactive alternative.
 *   Example: `"pass --method=FIFO to skip"`
 */
export function requireInteractive(fallbackHint: string): void {
  if (!isTTY()) {
    throw new Error(
      `Interactive prompt required; ${fallbackHint}.`,
    );
  }
}
