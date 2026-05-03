/**
 * Daybook CLI design system — centralized theme module.
 *
 * All color tokens, spacing constants, glyph registry, and format helpers
 * live here. Components import from this module; nothing else defines
 * visual constants.
 *
 * See `docs/cli-design-system.md` for the full specification.
 */

import chalk, { type ChalkInstance } from 'chalk';

// ─── Colors ──────────────────────────────────────────────────────────────

/**
 * Semantic color tokens from the ledger-paper palette.
 *
 * - `ink`     — terminal default foreground. Never override.
 * - `paper`   — secondary text, hints, descriptions (~60% opacity feel).
 * - `rule`    — borders, dividers, separators (~35% opacity feel).
 * - `note`    — signature accent: headings, links, highlighted values.
 * - `gain`    — positive values, success states. Always pair with `+`.
 * - `loss`    — negative values, error states. Always pair with `-`.
 * - `caution` — warnings, unpriced events, partial successes.
 * - `stamp`   — source labels, event type tags, metadata.
 */
export const color = {
  ink: chalk.reset,
  paper: chalk.hex('#94908A'),
  rule: chalk.hex('#5A5754'),
  note: chalk.hex('#5A8DAE'),
  gain: chalk.hex('#5B9D4A'),
  loss: chalk.hex('#B5483D'),
  caution: chalk.hex('#C68E17'),
  stamp: chalk.hex('#8E5A8A'),
} satisfies Record<string, ChalkInstance>;

export type ColorToken = keyof typeof color;

// ─── Spacing ─────────────────────────────────────────────────────────────

/** Spacing scale in terminal cells. */
export const space = {
  0: 0,
  1: 1,
  2: 2,
  4: 4,
} as const;

// ─── Glyphs (Nerd Font with ASCII fallback) ──────────────────────────────

const HAS_NERD_FONT =
  process.env['DAYBOOK_NO_NERDFONT'] !== '1' &&
  process.env['TERM_PROGRAM'] !== 'Apple_Terminal';

const glyphs = {
  check:    { nf: '\u{F0134}', ascii: '[ok]' },
  error:    { nf: '\uF057',    ascii: '[err]' },
  warning:  { nf: '\u{F0DA8}', ascii: '[!]' },
  info:     { nf: '\uF05A',    ascii: '[i]' },
  dot:      { nf: '\uF444',    ascii: '*' },
  arrow:    { nf: '\uF061',    ascii: '->' },
  chevron:  { nf: '\uF054',    ascii: '>' },
  question: { nf: '?',         ascii: '?' },
} as const;

export type GlyphName = keyof typeof glyphs;

/** Return the appropriate glyph string for the current terminal. */
export function glyph(name: GlyphName): string {
  return HAS_NERD_FONT ? glyphs[name].nf : glyphs[name].ascii;
}

// ─── Spinner frames ──────────────────────────────────────────────────────

/** Braille spinner frames (or ASCII fallback). */
export const SPINNER_FRAMES = HAS_NERD_FONT
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['|', '/', '-', '\\'];

/** Spinner frame interval in milliseconds. */
export const SPINNER_INTERVAL_MS = 80;

// ─── Layout constants ────────────────────────────────────────────────────

export const LAYOUT = {
  /** Default label width for Row components. */
  defaultLabelWidth: 14,
  /** Maximum table width before truncation. */
  defaultTableMaxWidth: 120,
  /** Terminal width below which we switch to narrow-mode layouts. */
  narrowTerminalThreshold: 80,
  /** Indent step in cells. */
  indent: 4,
} as const;

// ─── Format helpers ──────────────────────────────────────────────────────

/**
 * Format a number as USD with two decimal places and thousands separators.
 *
 * @param amount - The numeric amount.
 * @param opts.sign - If true, prefix positive values with `+`.
 */
export function formatUsd(amount: number, opts: { sign?: boolean } = {}): string {
  const sign = amount < 0 ? '-' : opts.sign ? '+' : '';
  const abs = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

/**
 * Format a count with the correct singular/plural noun.
 *
 * @param n - The count.
 * @param singular - Singular form of the noun.
 * @param plural - Optional plural form (defaults to singular + 's').
 */
export function formatCount(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? singular + 's');
  return `${n.toLocaleString('en-US')} ${word}`;
}

/**
 * Truncate an EVM address for display.
 *
 * @param addr - Full address string.
 * @param prefix - Characters to keep from the start (default 6).
 * @param suffix - Characters to keep from the end (default 8).
 */
export function truncateAddress(addr: string, prefix = 6, suffix = 8): string {
  if (addr.length <= prefix + suffix + 1) return addr;
  return `${addr.slice(0, prefix)}…${addr.slice(-suffix)}`;
}

/**
 * Return the correct singular or plural form of a word.
 *
 * @param n - The count.
 * @param word - Singular form.
 */
export function pluralize(n: number, word: string): string {
  return n === 1 ? word : word + 's';
}
