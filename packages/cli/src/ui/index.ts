/**
 * @daybook/cli UI component library.
 *
 * All Ink components and the theme module, re-exported from one barrel.
 * Import via `import { Header, Row, color } from '../ui/index.js'`.
 */

// ─── Theme ───────────────────────────────────────────────────────────────
export {
  color,
  space,
  glyph,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  LAYOUT,
  formatUsd,
  formatCount,
  truncateAddress,
  pluralize,
  type ColorToken,
  type GlyphName,
} from './theme.js';

// ─── Components ──────────────────────────────────────────────────────────
export { Header, type HeaderProps } from './Header.js';
export { Row, type RowProps } from './Row.js';
export { Glyph, type GlyphProps } from './Glyph.js';
export { Spinner, type SpinnerProps } from './Spinner.js';
export { Stat, type StatProps } from './Stat.js';
export { Table, type TableColumn, type TableProps } from './Table.js';
export { Section, type SectionProps } from './Section.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';
export { ErrorBlock, type ErrorBlockProps } from './ErrorBlock.js';
